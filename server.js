const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS 中间件（支持前端跨域请求在线人数）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

const io = new Server(server, {
  cors: {
    origin: ['https://dota-maylee.github.io', 'http://localhost:3000'],
    methods: ['GET', 'POST']
  },
  pingTimeout: 20000,
  pingInterval: 10000
});

const rooms = new Map();
const matchmaking = new Map();
const matchmakingTimeouts = new Map();
let onlineCount = 0;

const AI_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Fox'];

function generateRoomCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); } while (rooms.has(code));
  return code;
}

// 名字消毒：去掉HTML特殊字符并限制长度，防XSS
function cleanName(s) {
  const n = String(s || '').replace(/[<>&"'`]/g, '').trim().substring(0, 24);
  return n || '玩家';
}

// 人数校验：仅允许 3-5 人，防止恶意参数导致死循环或内存耗尽
function sanitizeMaxPlayers(n) {
  const v = parseInt(n, 10);
  return (Number.isInteger(v) && v >= 3 && v <= 5) ? v : null;
}

function getRoomPublic(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI })),
    host: room.host,
    maxPlayers: room.maxPlayers,
    mode: room.mode,
    status: room.status,
    playerCount: room.players.length
  };
}

// 用 AI 把房间补满到 maxPlayers（服务器端统一补位，保证所有客户端名单一致）
function fillRoomWithAI(room) {
  while (room.players.length < room.maxPlayers) {
    const idx = room.players.length;
    room.players.push({
      id: 'ai-' + Math.random().toString(36).substring(2, 10),
      name: 'AI-' + AI_NAMES[(idx - 1 + AI_NAMES.length) % AI_NAMES.length],
      isAI: true,
      socketId: null
    });
  }
}

// 服务器端统一开局：补 AI → 洗牌 → 分配 gameId → 逐个下发"你是谁"
function startRoomGame(room) {
  if (!room || room.status === 'playing') return;
  room.status = 'playing';
  room.ended = false; // 新对局开始，清除结束标记
  fillRoomWithAI(room);
  // Fisher-Yates 洗牌（只在服务器做一次，所有客户端使用同一顺序）
  for (let i = room.players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
  }
  room.players.forEach((p, i) => { p.gameId = 'p' + i; });
  room.gameOf = {};
  room.players.forEach(p => { if (p.socketId) room.gameOf[p.socketId] = p.gameId; });
  const publicPlayers = room.players.map(p => ({
    id: p.gameId, name: p.name, isAI: p.isAI, socketId: p.socketId
  }));
  room.players.forEach(p => {
    if (p.isAI || !p.socketId) return;
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('game_started', { players: publicPlayers, roomCode: room.code, yourId: p.gameId });
  });
}

// 把 socket 从其所在房间移除（leave_room / disconnect 共用）
function removeFromRoom(socket) {
  const code = socket.roomCode;
  if (!code) return;
  socket.roomCode = null;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.players.findIndex(p => p.socketId === socket.id);
  if (idx === -1) return;
  const player = room.players[idx];
  room.players.splice(idx, 1);
  socket.leave(code);
  // 对局中离开的玩家由 AI 托管：登记其 gameId，允许房主代发行动（否则托管行动会被反伪造校验拦截）
  if (room.status === 'playing' && player.gameId) {
    if (!room.delegatedAI) room.delegatedAI = {};
    room.delegatedAI[player.gameId] = true;
  }
  socket.to(code).emit('player_left', { playerId: player.id, room: getRoomPublic(room) });
  if (room.players.filter(p => !p.isAI).length === 0) {
    rooms.delete(code);
  } else if (room.host === socket.id) {
    const nextHuman = room.players.find(p => !p.isAI && p.socketId);
    if (nextHuman) {
      room.host = nextHuman.socketId;
      io.to(code).emit('host_changed', { newHost: room.host });
    }
  }
}

// 在线人数 API
app.get('/api/online', (req, res) => {
  res.json({ count: onlineCount });
});

io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', onlineCount);

  socket.on('create_room', (payload) => {
    let { name, maxPlayers, mode } = payload || {};
    const now = Date.now();
    if (socket.lastRoomCreate && now - socket.lastRoomCreate < 3000) { socket.emit('error', { message: '操作太频繁，请稍后再试' }); return; }
    if (rooms.size > 5000) { socket.emit('error', { message: '服务器繁忙，请稍后再试' }); return; }
    const mp = sanitizeMaxPlayers(maxPlayers === undefined ? 4 : maxPlayers);
    if (!mp) { socket.emit('error', { message: '人数参数无效' }); return; }
    socket.lastRoomCreate = now;
    removeFromRoom(socket);
    name = cleanName(name);
    socket.playerName = name;
    const code = generateRoomCode();
    const room = {
      code, host: socket.id, maxPlayers: mp, mode: mode === 'wolf' ? 'wolf' : 'normal',
      players: [{ id: socket.id, name, isAI: false, socketId: socket.id }],
      status: 'waiting', gameState: null, createdAt: Date.now()
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, room: getRoomPublic(room) });
  });

  socket.on('join_room', (payload) => {
    let { code, name } = payload || {};
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: '房间不存在' }); return; }
    // 重复加入（双击/重发）：直接恢复，不产生重复玩家
    if (room.players.some(p => p.socketId === socket.id)) {
      socket.join(code);
      socket.roomCode = code;
      socket.emit('room_joined', { code, room: getRoomPublic(room), you: socket.id });
      return;
    }
    if (room.status !== 'waiting') { socket.emit('error', { message: '游戏已开始' }); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error', { message: '房间已满' }); return; }
    removeFromRoom(socket);
    name = cleanName(name);
    socket.playerName = name;
    room.players.push({ id: socket.id, name, isAI: false, socketId: socket.id });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_joined', { code, room: getRoomPublic(room), you: socket.id });
    socket.to(code).emit('player_joined', { player: { id: socket.id, name, isAI: false }, room: getRoomPublic(room) });
  });

  socket.on('leave_room', () => {
    removeFromRoom(socket);
  });

  // 等待阶段房主切换房间模式（普通/狼刀博弈），同步给房间内其他玩家
  socket.on('set_room_mode', (payload) => {
    const { code, mode } = payload || {};
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.status !== 'waiting') return;
    room.mode = mode === 'wolf' ? 'wolf' : 'normal';
    socket.to(code).emit('room_mode_changed', { mode: room.mode });
  });

  socket.on('start_game', (payload) => {
    const { code } = payload || {};
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.status === 'playing') return;
    startRoomGame(room);
  });

  // 匹配：服务器端统一 5 秒定时器，超时 AI 补位
  socket.on('join_matchmaking', (payload) => {
    let { name, maxPlayers, mode } = payload || {};
    const mp = sanitizeMaxPlayers(maxPlayers);
    if (!mp) { socket.emit('error', { message: '人数参数无效' }); return; }
    maxPlayers = mp;
    mode = mode === 'wolf' ? 'wolf' : 'normal';
    // 匹配前先退出可能所在的房间，避免跨房间消息串扰
    removeFromRoom(socket);
    name = cleanName(name);
    socket.playerName = name;
    const key = `${maxPlayers}-${mode}`;
    // 先从这个 socket 可能在的其他队列里移除
    matchmaking.forEach((q, k) => {
      const i = q.findIndex(s => s.id === socket.id);
      if (i > -1) q.splice(i, 1);
    });
    if (!matchmaking.has(key)) matchmaking.set(key, []);
    const queue = matchmaking.get(key);
    queue.push(socket);
    socket.matchKey = key;

    const createMatchedRoom = (matched) => {
      const code = generateRoomCode();
      const room = {
        code, host: matched[0].id, maxPlayers, mode,
        players: matched.map((s, i) => ({ id: s.id, name: s.playerName || `玩家${i + 1}`, isAI: false, socketId: s.id })),
        status: 'waiting', gameState: null, createdAt: Date.now()
      };
      // 人不够时服务器直接补满 AI，保证各端名单一致
      fillRoomWithAI(room);
      rooms.set(code, room);
      matched.forEach(s => {
        s.matchKey = null;
        s.join(code);
        s.roomCode = code;
        s.emit('match_found', { code, room: getRoomPublic(room), you: s.id });
      });
      // 兜底：若房主客户端未及时开局，服务器3秒后自动开局
      setTimeout(() => {
        const r = rooms.get(code);
        // 兜底开局前确认房间里仍有真人，避免全员退出后空房开局
        if (r && r.status === 'waiting' && r.players.some(p => !p.isAI)) startRoomGame(r);
      }, 3000);
    };

    // 超过房间人数时尽可能多地组成满员房间（如 5 人排 2 人房：2+2 开局，余 1 人等待补位）
    while (queue.length >= maxPlayers) {
      createMatchedRoom(queue.splice(0, maxPlayers));
    }

    if (queue.length === 0) {
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
        matchmakingTimeouts.delete(key);
      }
    } else {
      queue.forEach(s => s.emit('matchmaking_waiting', { current: queue.length, required: maxPlayers }));
      if (!matchmakingTimeouts.has(key)) {
        const timeout = setTimeout(() => {
          const currentQueue = matchmaking.get(key) || [];
          if (currentQueue.length === 0) return;
          createMatchedRoom(currentQueue.splice(0, Math.min(currentQueue.length, maxPlayers)));
          matchmakingTimeouts.delete(key);
        }, 5000);
        matchmakingTimeouts.set(key, timeout);
      }
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (socket.matchKey && matchmaking.has(socket.matchKey)) {
      const queue = matchmaking.get(socket.matchKey);
      const idx = queue.findIndex(s => s.id === socket.id);
      if (idx > -1) {
        queue.splice(idx, 1);
        if (queue.length === 0 && matchmakingTimeouts.has(socket.matchKey)) {
          clearTimeout(matchmakingTimeouts.get(socket.matchKey));
          matchmakingTimeouts.delete(socket.matchKey);
        }
      }
    }
    socket.matchKey = null;
  });

  // 行动转发（除发送者外的房间内成员）：校验房间归属与操作者身份，防伪造
  socket.on('player_action', (payload) => {
    const { roomCode, actionType, playerId, data } = payload || {};
    if (!roomCode || typeof playerId !== 'string') return;
    const room = rooms.get(roomCode);
    if (!room || socket.roomCode !== roomCode || !room.gameOf) return;
    const myGameId = room.gameOf[socket.id];
    if (!myGameId) return;
    const isSelf = playerId === myGameId;
    // 房主可代发：房间内 AI，或对局中掉线/退出后由 AI 托管的玩家
    const isHostForAI = room.host === socket.id &&
      (room.players.some(p => p.gameId === playerId && p.isAI) ||
       !!(room.delegatedAI && room.delegatedAI[playerId]));
    if (!isSelf && !isHostForAI) return;
    socket.to(roomCode).emit('player_action', { from: socket.id, action: actionType, data: { actionType, playerId, data } });
  });

  // 房主请求某玩家重发行动（消息丢失兜底）
  socket.on('request_action', (payload) => {
    const { roomCode, playerId } = payload || {};
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return;
    io.to(roomCode).emit('request_action', { playerId });
  });

  // 白天结果广播（含权威存活状态，直接透传整个负载）
  // 注意：用 socket.to 排除发送者——房主已在本地结算并展示，回声会覆盖其"新死亡"数据导致误报平安夜
  socket.on('broadcast_day_result', (payload) => {
    const { roomCode, ...rest } = payload || {};
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return; // 仅房主可广播白天结果
    socket.to(roomCode).emit('day_result', rest);
  });

  // 一局结束后返回房间：房间重新开放等待，移除AI，全员回到等待界面
  // 房主宣告本局结束（此后任何成员都可把房间带回等待状态）
  socket.on('game_ended', (payload) => {
    const { code } = payload || {};
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return; // 仅房主可宣告，防止伪造结束来拆房
    room.ended = true;
  });

  socket.on('return_to_room', (payload) => {
    const { code } = payload || {};
    const room = rooms.get(code);
    if (!room) return;
    // 房主随时可带回；其他成员仅在本局结束后可带回（防止对局中被恶意重置）
    if (room.host !== socket.id && !room.ended) return;
    room.status = 'waiting';
    room.gameOf = null; // 旧对局的行动通行证作废
    room.delegatedAI = {};
    room.createdAt = Date.now(); // 刷新闲置计时
    room.players = room.players.filter(p => !p.isAI);
    room.players.forEach(p => { delete p.gameId; });
    io.to(code).emit('room_reset', { room: getRoomPublic(room) });
  });

  // 夜晚开始等状态同步（透传）
  socket.on('sync_game_state', (payload) => {
    const { roomCode, state } = payload || {};
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return; // 仅房主可同步状态
    socket.to(roomCode).emit('game_state_update', state);
  });

  socket.on('disconnect', () => {
    onlineCount--;
    io.emit('online_count', onlineCount);

    if (socket.matchKey && matchmaking.has(socket.matchKey)) {
      const queue = matchmaking.get(socket.matchKey);
      const idx = queue.findIndex(s => s.id === socket.id);
      if (idx > -1) {
        queue.splice(idx, 1);
        if (queue.length === 0 && matchmakingTimeouts.has(socket.matchKey)) {
          clearTimeout(matchmakingTimeouts.get(socket.matchKey));
          matchmakingTimeouts.delete(socket.matchKey);
        }
      }
      socket.matchKey = null;
    }
    removeFromRoom(socket);
  });
});

// 定期清理闲置房间：等待中且超过30分钟未活动的房间直接解散
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.status === 'waiting' && now - (room.createdAt || 0) > 30 * 60 * 1000) {
      io.to(code).emit('error', { message: '房间长时间未开始，已解散' });
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

// 兜底：单条消息处理出错不应拖垮整个服务器
process.on('uncaughtException', (err) => {
  console.error('未捕获异常（已拦截，服务器继续运行）:', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🎮 宿舍杀服务器已启动`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`========================================`);
});

module.exports = server;

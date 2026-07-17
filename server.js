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
  pingTimeout: 60000,
  pingInterval: 25000
});

const rooms = new Map();
const matchmaking = new Map();
const matchmakingTimeouts = new Map();
let onlineCount = 0;

const AI_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Fox'];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomPublic(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI })),
    host: room.host,
    maxPlayers: room.maxPlayers,
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
  fillRoomWithAI(room);
  // Fisher-Yates 洗牌（只在服务器做一次，所有客户端使用同一顺序）
  for (let i = room.players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
  }
  room.players.forEach((p, i) => { p.gameId = 'p' + i; });
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

  socket.on('create_room', ({ name, maxPlayers, mode }) => {
    removeFromRoom(socket);
    socket.playerName = name;
    const code = generateRoomCode();
    const room = {
      code, host: socket.id, maxPlayers: maxPlayers || 4, mode: mode || 'normal',
      players: [{ id: socket.id, name, isAI: false, socketId: socket.id }],
      status: 'waiting', gameState: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, room: getRoomPublic(room) });
  });

  socket.on('join_room', ({ code, name }) => {
    code = (code || '').trim().toUpperCase();
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

  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || room.status === 'playing') return;
    startRoomGame(room);
  });

  // 匹配：服务器端统一 5 秒定时器，超时 AI 补位
  socket.on('join_matchmaking', ({ name, maxPlayers, mode }) => {
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

    queue.forEach(s => s.emit('matchmaking_waiting', { current: queue.length, required: maxPlayers }));

    const createMatchedRoom = (matched) => {
      const code = generateRoomCode();
      const room = {
        code, host: matched[0].id, maxPlayers, mode: mode || 'normal',
        players: matched.map((s, i) => ({ id: s.id, name: s.playerName || `玩家${i + 1}`, isAI: false, socketId: s.id })),
        status: 'waiting', gameState: null
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
    };

    if (queue.length >= maxPlayers) {
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
        matchmakingTimeouts.delete(key);
      }
      createMatchedRoom(queue.splice(0, maxPlayers));
    } else if (queue.length === 1) {
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
      }
      const timeout = setTimeout(() => {
        const currentQueue = matchmaking.get(key) || [];
        if (currentQueue.length === 0) return;
        createMatchedRoom(currentQueue.splice(0, Math.min(currentQueue.length, maxPlayers)));
        matchmakingTimeouts.delete(key);
      }, 5000);
      matchmakingTimeouts.set(key, timeout);
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

  // 行动转发（除发送者外的房间内成员）
  socket.on('player_action', ({ roomCode, actionType, playerId, data }) => {
    if (!roomCode) return;
    socket.to(roomCode).emit('player_action', { from: socket.id, action: actionType, data: { actionType, playerId, data } });
  });

  // 白天结果广播（含权威存活状态，直接透传整个负载）
  socket.on('broadcast_day_result', ({ roomCode, ...rest }) => {
    if (!roomCode) return;
    io.to(roomCode).emit('day_result', rest);
  });

  // 夜晚开始等状态同步（透传）
  socket.on('sync_game_state', ({ roomCode, state }) => {
    if (!roomCode) return;
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🎮 宿舍杀服务器已启动`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`========================================`);
});

module.exports = server;

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://dota-maylee.github.io','http://localhost:3000'], methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const rooms = new Map();
const matchmaking = new Map();
const matchmakingTimeouts = new Map();

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

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, maxPlayers, mode }) => {
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
    const room = rooms.get(code);
    if (!room) { socket.emit('error', { message: '房间不存在' }); return; }
    if (room.status !== 'waiting') { socket.emit('error', { message: '游戏已开始' }); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error', { message: '房间已满' }); return; }
    room.players.push({ id: socket.id, name, isAI: false, socketId: socket.id });
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_joined', { code, room: getRoomPublic(room), you: socket.id });
    socket.to(code).emit('player_joined', { player: { id: socket.id, name, isAI: false }, room: getRoomPublic(room) });
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    room.status = 'playing';
    const playerIds = room.players.map((p, i) => ({ ...p, gameId: 'p' + i }));
    room.players = playerIds;
    io.to(code).emit('game_started', { players: playerIds.map(p => ({ id: p.gameId, name: p.name, isAI: p.isAI })), roomCode: code });
  });

  socket.on('join_matchmaking', ({ name, maxPlayers, mode }) => {
    const key = `${maxPlayers}-${mode}`;
    if (!matchmaking.has(key)) matchmaking.set(key, []);
    const queue = matchmaking.get(key);
    const existingIdx = queue.findIndex(s => s.id === socket.id);
    if (existingIdx > -1) queue.splice(existingIdx, 1);
    queue.push(socket);
    socket.matchKey = key;
    
    // 广播当前匹配人数给所有排队玩家
    queue.forEach(s => s.emit('matchmaking_waiting', { current: queue.length, required: maxPlayers }));
    
    if (queue.length >= maxPlayers) {
      // 人数满了，立即开始
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
        matchmakingTimeouts.delete(key);
      }
      const matched = queue.splice(0, maxPlayers);
      const code = generateRoomCode();
      const room = {
        code, host: matched[0].id, maxPlayers, mode: mode || 'normal',
        players: matched.map((s, i) => ({ id: s.id, name: s.name || `玩家${i+1}`, isAI: false, socketId: s.id })),
        status: 'waiting', gameState: null
      };
      rooms.set(code, room);
      matched.forEach((s, i) => {
        s.join(code);
        s.roomCode = code;
        s.emit('match_found', { code, room: getRoomPublic(room), you: s.id });
      });
    } else if (queue.length === 1 && !matchmakingTimeouts.has(key)) {
      // 第一个玩家加入，启动5秒服务器端定时器
      const timeout = setTimeout(() => {
        const currentQueue = matchmaking.get(key) || [];
        if (currentQueue.length === 0) return;
        const matched = currentQueue.splice(0, Math.min(currentQueue.length, maxPlayers));
        const code = generateRoomCode();
        const room = {
          code, host: matched[0].id, maxPlayers, mode: mode || 'normal',
          players: matched.map((s, i) => ({ id: s.id, name: s.name || `玩家${i+1}`, isAI: false, socketId: s.id })),
          status: 'waiting', gameState: null
        };
        rooms.set(code, room);
        matched.forEach((s, i) => {
          s.join(code);
          s.roomCode = code;
          s.emit('match_found', { code, room: getRoomPublic(room), you: s.id });
        });
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
        // 如果队列空了，清除定时器
        if (queue.length === 0 && matchmakingTimeouts.has(socket.matchKey)) {
          clearTimeout(matchmakingTimeouts.get(socket.matchKey));
          matchmakingTimeouts.delete(socket.matchKey);
        }
      }
    }
  });

  socket.on('player_action', ({ roomCode, actionType, playerId, data }) => {
    if (!roomCode) return;
    socket.to(roomCode).emit('player_action', { from: socket.id, action: actionType, data: { actionType, playerId, data } });
  });

  socket.on('broadcast_day_result', ({ roomCode, deaths, round, message }) => {
    if (!roomCode) return;
    io.to(roomCode).emit('day_result', { deaths, round, message });
  });

  socket.on('sync_game_state', ({ roomCode, state }) => {
    if (!roomCode) return;
    socket.to(roomCode).emit('game_state_update', state);
  });

  socket.on('disconnect', () => {
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
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        const idx = room.players.findIndex(p => p.socketId === socket.id);
        if (idx > -1) {
          const player = room.players[idx];
          room.players.splice(idx, 1);
          socket.to(socket.roomCode).emit('player_left', { playerId: player.id, room: getRoomPublic(room) });
          if (room.players.length === 0) {
            rooms.delete(socket.roomCode);
          } else if (room.host === socket.id && room.players.length > 0) {
            room.host = room.players[0].socketId;
            io.to(socket.roomCode).emit('host_changed', { newHost: room.host });
          }
        }
      }
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
// Vercel 环境下不主动 listen，由平台托管
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🎮 宿舍杀服务器已启动`);
    console.log(`📍 端口: ${PORT}`);
    console.log(`========================================`);
  });
}

// 导出给 Vercel Serverless 使用
module.exports = server;

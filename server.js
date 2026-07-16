const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// CORS 中间件（支持前端跨域请求在线人数）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  next();
});

const io = new Server(server, {
  cors: {
    origin: ["https://dota-maylee.github.io", "http://localhost:3000"],
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map();
const matchmaking = new Map();
const matchmakingTimeouts = new Map();
let onlineCount = 0;

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomPublic(room) {
  return {
    code: room.code,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
    })),
    host: room.host,
    maxPlayers: room.maxPlayers,
    status: room.status,
    playerCount: room.players.length,
  };
}

// 在线人数 API
app.get("/api/online", (req, res) => {
  res.json({ count: onlineCount });
});

io.on("connection", (socket) => {
  onlineCount++;
  io.emit("online_count", onlineCount);

  socket.on("create_room", ({ name, maxPlayers, mode }) => {
    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      maxPlayers: maxPlayers || 4,
      mode: mode || "normal",
      players: [{ id: socket.id, name, isAI: false, socketId: socket.id }],
      status: "waiting",
      gameState: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit("room_created", { code, room: getRoomPublic(room) });
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit("error", { message: "房间不存在" });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("error", { message: "游戏已开始" });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit("error", { message: "房间已满" });
      return;
    }

    // 去重：检查该 socket 是否已在房间中
    const existingIdx = room.players.findIndex((p) => p.socketId === socket.id);
    if (existingIdx > -1) {
      room.players[existingIdx].name = name || room.players[existingIdx].name;
      socket.emit("room_joined", {
        code,
        room: getRoomPublic(room),
        you: socket.id,
      });
      return;
    }

    // 通过名字去重：防止同一用户开多个标签页占多个位置
    const nameDupIdx = room.players.findIndex(
      (p) => p.name === name && !p.isAI
    );
    if (nameDupIdx > -1) {
      const oldPlayer = room.players[nameDupIdx];
      room.players.splice(nameDupIdx, 1);
      const oldSocket = io.sockets.sockets.get(oldPlayer.socketId);
      if (oldSocket) {
        oldSocket.emit("error", { message: "你在其他地方加入了该房间" });
        oldSocket.leave(code);
        oldSocket.roomCode = null;
      }
    }

    room.players.push({
      id: socket.id,
      name,
      isAI: false,
      socketId: socket.id,
    });
    socket.join(code);
    socket.roomCode = code;
    socket.emit("room_joined", {
      code,
      room: getRoomPublic(room),
      you: socket.id,
    });
    socket
      .to(code)
      .emit("player_joined", {
        player: { id: socket.id, name, isAI: false },
        room: getRoomPublic(room),
      });
  });

  socket.on("start_game", ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (room.status !== "waiting") return;
    room.status = "playing";

    // 补充 AI
    const aiNames = ["Alpha", "Beta", "Gamma", "Delta", "Echo", "Fox"];
    let aiIndex = 0;
    while (room.players.length < room.maxPlayers) {
      const aiName = "AI-" + aiNames[aiIndex % aiNames.length];
      room.players.push({
        id: "ai_" + aiIndex,
        name: aiName,
        isAI: true,
        socketId: null,
      });
      aiIndex++;
    }

    // 分配 gameId
    room.players = room.players.map((p, i) => ({ ...p, gameId: "p" + i }));

    // 为每个客户端单独发送，包含 theirId
    room.players.forEach((p) => {
      if (!p.isAI && p.socketId) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) {
          s.emit("game_started", {
            players: room.players.map((p) => ({
              id: p.gameId,
              name: p.name,
              isAI: p.isAI,
            })),
            roomCode: code,
            yourId: p.gameId,
          });
        }
      }
    });
  });

  // 重写：服务器端统一 5 秒定时器
  socket.on("join_matchmaking", ({ name, maxPlayers, mode }) => {
    const key = `${maxPlayers}-${mode}`;
    if (!matchmaking.has(key)) matchmaking.set(key, []);
    const queue = matchmaking.get(key);
    const existingIdx = queue.findIndex((s) => s.id === socket.id);
    if (existingIdx > -1) queue.splice(existingIdx, 1);
    queue.push(socket);
    socket.matchKey = key;

    queue.forEach((s) =>
      s.emit("matchmaking_waiting", {
        current: queue.length,
        required: maxPlayers,
      })
    );

    if (queue.length >= maxPlayers) {
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
        matchmakingTimeouts.delete(key);
      }
      const matched = queue.splice(0, maxPlayers);
      const code = generateRoomCode();
      const room = {
        code,
        host: matched[0].id,
        maxPlayers,
        mode: mode || "normal",
        players: matched.map((s, i) => ({
          id: s.id,
          name: s.name || `玩家${i + 1}`,
          isAI: false,
          socketId: s.id,
        })),
        status: "waiting",
        gameState: null,
      };
      rooms.set(code, room);
      matched.forEach((s, i) => {
        s.join(code);
        s.roomCode = code;
        s.emit("match_found", { code, room: getRoomPublic(room), you: s.id });
      });
    } else if (queue.length === 1) {
      if (matchmakingTimeouts.has(key)) {
        clearTimeout(matchmakingTimeouts.get(key));
      }
      const timeout = setTimeout(() => {
        const currentQueue = matchmaking.get(key) || [];
        if (currentQueue.length === 0) return;
        const matched = currentQueue.splice(
          0,
          Math.min(currentQueue.length, maxPlayers)
        );
        const code = generateRoomCode();
        const room = {
          code,
          host: matched[0].id,
          maxPlayers,
          mode: mode || "normal",
          players: matched.map((s, i) => ({
            id: s.id,
            name: s.name || `玩家${i + 1}`,
            isAI: false,
            socketId: s.id,
          })),
          status: "waiting",
          gameState: null,
        };
        rooms.set(code, room);
        matched.forEach((s, i) => {
          s.join(code);
          s.roomCode = code;
          s.emit("match_found", { code, room: getRoomPublic(room), you: s.id });
        });
        matchmakingTimeouts.delete(key);
      }, 5000);
      matchmakingTimeouts.set(key, timeout);
    }
  });

  socket.on("cancel_matchmaking", () => {
    if (socket.matchKey) {
      if (matchmaking.has(socket.matchKey)) {
        const queue = matchmaking.get(socket.matchKey);
        const idx = queue.findIndex((s) => s.id === socket.id);
        if (idx > -1) {
          queue.splice(idx, 1);
          if (queue.length === 0 && matchmakingTimeouts.has(socket.matchKey)) {
            clearTimeout(matchmakingTimeouts.get(socket.matchKey));
            matchmakingTimeouts.delete(socket.matchKey);
          }
        }
      }
    }
  });

  socket.on("player_action", ({ roomCode, actionType, playerId, data }) => {
    if (!roomCode) return;
    socket
      .to(roomCode)
      .emit("player_action", {
        from: socket.id,
        action: actionType,
        data: { actionType, playerId, data },
      });
  });

  socket.on("broadcast_day_result", ({ roomCode, deaths, round, message }) => {
    if (!roomCode) return;
    io.to(roomCode).emit("day_result", { deaths, round, message });
  });

  socket.on("sync_game_state", ({ roomCode, state }) => {
    if (!roomCode) return;
    socket.to(roomCode).emit("game_state_update", state);
  });

  socket.on("disconnect", () => {
    onlineCount--;
    io.emit("online_count", onlineCount);

    if (socket.matchKey) {
      if (matchmaking.has(socket.matchKey)) {
        const queue = matchmaking.get(socket.matchKey);
        const idx = queue.findIndex((s) => s.id === socket.id);
        if (idx > -1) {
          queue.splice(idx, 1);
          if (queue.length === 0 && matchmakingTimeouts.has(socket.matchKey)) {
            clearTimeout(matchmakingTimeouts.get(socket.matchKey));
            matchmakingTimeouts.delete(socket.matchKey);
          }
        }
      }
    }
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        const idx = room.players.findIndex((p) => p.socketId === socket.id);
        if (idx > -1) {
          const player = room.players[idx];
          room.players.splice(idx, 1);
          // 发送 gameId（如果已分配）
          const emitId = player.gameId || player.id;
          socket
            .to(socket.roomCode)
            .emit("player_left", {
              playerId: emitId,
              room: getRoomPublic(room),
            });
          if (room.players.length === 0) {
            rooms.delete(socket.roomCode);
          } else if (room.host === socket.id && room.players.length > 0) {
            room.host = room.players[0].socketId;
            io.to(socket.roomCode).emit("host_changed", { newHost: room.host });
          }
        }
      }
    }
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

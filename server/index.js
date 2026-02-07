/*                                                                                                                                                                                 

Phase 1: Basic room join/leave notifications only

   - User joins a room
   - User leaves a room
   - Notify other users in the room
   - Send existing users list to new user






*/
// const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
// const cors = require('cors');

// const app = express();
// const server = http.createServer(app);

// app.use(cors());

// const io = new Server(server, {
//   cors: {
//     origin: "http://localhost:3000", // React dev server
//     methods: ["GET", "POST"]
//   }
// });

// io.on("connection", (socket) => {
//   console.log("New user connected:", socket.id);

//   socket.on("join-room", (roomId, userName) => {
//     socket.join(roomId);
//     console.log(`${userName} joined room ${roomId}`);

//     // Tell *existing* users that a new one joined
//     socket.to(roomId).emit("user-joined", userName);

//     // Tell the *new* user who else is already in the room
//     const otherUsers = [];
//     const clients = io.sockets.adapter.rooms.get(roomId);
//     if (clients) {
//       clients.forEach((clientId) => {
//         if (clientId !== socket.id) {
//           const clientSocket = io.sockets.sockets.get(clientId);
//           if (clientSocket && clientSocket.userName) {
//             otherUsers.push(clientSocket.userName);
//           }
//         }
//       });
//     }

//     socket.emit("existing-users", otherUsers);

//     // Save the username on the socket object
//     socket.userName = userName;

//     // Handle user disconnect
//     socket.on("disconnect", () => {
//       console.log(`${userName} disconnected`);
//       socket.to(roomId).emit("user-left", userName);
//     });
//   });
// });


// const PORT = 5000;
// server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// server/index.js

/*                                                                                                                                                                                 

Phase 2: Add signaling for WebRTC peer connections



*/
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());

app.get("/", (req, res) => {
  res.send("WebRTC signaling server is running!");
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  socket.on("join-room", (roomId, userName) => {
    socket.join(roomId);
    socket.userName = userName;
    console.log(`${userName} joined room ${roomId} (${socket.id})`);

    socket.to(roomId).emit("user-joined", { socketId: socket.id, userName });

    const clients = io.sockets.adapter.rooms.get(roomId) || new Set();
    const otherUsers = [];
    clients.forEach((clientId) => {
      if (clientId !== socket.id) {
        const s = io.sockets.sockets.get(clientId);
        otherUsers.push({
          socketId: clientId,
          userName: s ? s.userName : "Unknown",
        });
      }
    });

    socket.emit("existing-users", otherUsers);

    socket.on("offer", (payload) => {
      const { targetSocketId, sdp, isScreen } = payload;
      io.to(targetSocketId).emit("offer", {
        from: isScreen ? `${socket.id}-screen` : socket.id,
        sdp,
        userName: isScreen ? `${socket.userName} (Screen)` : socket.userName,
        isScreen
      });
    });

    socket.on("answer", (payload) => {
      const { targetSocketId, sdp, isScreen } = payload;
      io.to(targetSocketId).emit("answer", {
        from: isScreen ? `${socket.id}-screen` : socket.id,
        sdp,
        isScreen
      });
    });

    socket.on("ice-candidate", (payload) => {
      const { targetSocketId, candidate, isScreen } = payload;
      io.to(targetSocketId).emit("ice-candidate", {
        from: isScreen ? `${socket.id}-screen` : socket.id,
        candidate,
        isScreen
      });
    });

    socket.on("disconnect", () => {
      console.log(`${userName} disconnected (${socket.id})`);
      socket.to(roomId).emit("user-left", { socketId: socket.id, userName });
      // Also disconnect screen if exists (though usually client sends specific event)
      socket.to(roomId).emit("user-left", { socketId: `${socket.id}-screen`, userName: `${userName} (Screen)` });
    });

    // Explicit screen share disconnect
    socket.on("disconnect-screen", () => {
      console.log(`Screen disconnect from ${socket.id}`);
      socket.to(roomId).emit("user-left", { socketId: `${socket.id}-screen`, userName: `${socket.userName} (Screen)` });
    });

    // Renegotiation (Legacy/Camera only)
    socket.on("renegotiate-offer", ({ targetSocketId, sdp }) => {
      console.log(`[Signal] Renegotiate Offer from ${socket.id} to ${targetSocketId}`);
      io.to(targetSocketId).emit("renegotiate-offer", { from: socket.id, sdp });
    });

    socket.on("renegotiate-answer", ({ targetSocketId, sdp }) => {
      console.log(`[Signal] Renegotiate Answer from ${socket.id} to ${targetSocketId}`);
      io.to(targetSocketId).emit("renegotiate-answer", { from: socket.id, sdp });
    });

    // Sync
    socket.on("sync-request", () => {
      console.log(`[Signal] Sync Request from ${socket.id}`);
      socket.broadcast.to(roomId).emit("sync-request", { from: socket.id, userName: socket.userName });
    });

  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

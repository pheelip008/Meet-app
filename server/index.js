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

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  socket.on("join-room", (roomId, userName) => {
    socket.join(roomId);
    socket.userName = userName;
    console.log(`${userName} joined room ${roomId} (${socket.id})`);

    // Inform existing clients in room that a new user joined (broadcast)
    socket.to(roomId).emit("user-joined", { socketId: socket.id, userName });

    // Send the new user the existing users in the room (id + name)
    const clients = io.sockets.adapter.rooms.get(roomId) || new Set();
    const otherUsers = [];
    clients.forEach((clientId) => {
      if (clientId !== socket.id) {
        const s = io.sockets.sockets.get(clientId);
        otherUsers.push({ socketId: clientId, userName: s ? s.userName : "Unknown" });
      }
    });

    socket.emit("existing-users", otherUsers);

    // Signaling: forward offer/answer/ice-candidate to target socket
    socket.on("offer", (payload) => {
      const { targetSocketId, sdp } = payload;
      io.to(targetSocketId).emit("offer", { from: socket.id, sdp, userName: socket.userName });
    });

    socket.on("answer", (payload) => {
      const { targetSocketId, sdp } = payload;
      io.to(targetSocketId).emit("answer", { from: socket.id, sdp });
    });

    socket.on("ice-candidate", (payload) => {
      const { targetSocketId, candidate } = payload;
      io.to(targetSocketId).emit("ice-candidate", { from: socket.id, candidate });
    });

    socket.on("disconnect", () => {
      console.log(`${userName} disconnected (${socket.id})`);
      socket.to(roomId).emit("user-left", { socketId: socket.id, userName });
    });
  });
});

const PORT = 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

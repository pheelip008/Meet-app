const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // React dev server
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  socket.on("join-room", (roomId, userName) => {
    socket.join(roomId);
    console.log(`${userName} joined room ${roomId}`);

    // Tell *existing* users that a new one joined
    socket.to(roomId).emit("user-joined", userName);

    // Tell the *new* user who else is already in the room
    const otherUsers = [];
    const clients = io.sockets.adapter.rooms.get(roomId);
    if (clients) {
      clients.forEach((clientId) => {
        if (clientId !== socket.id) {
          const clientSocket = io.sockets.sockets.get(clientId);
          if (clientSocket && clientSocket.userName) {
            otherUsers.push(clientSocket.userName);
          }
        }
      });
    }

    socket.emit("existing-users", otherUsers);

    // Save the username on the socket object
    socket.userName = userName;

    // Handle user disconnect
    socket.on("disconnect", () => {
      console.log(`${userName} disconnected`);
      socket.to(roomId).emit("user-left", userName);
    });
  });
});


const PORT = 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// --- State Management ---
// We keep it simple: Just an array of users for the room.
// In a real app, this would be a Map or Redis.
// Users: { socketId, userName, isScreen }
let users = [];

io.on("connection", (socket) => {
  console.log(`🔌 Socket Connected: ${socket.id}`);

  socket.on("join-room", (roomId, userName) => {
    // 1. Join the socket room
    socket.join(roomId);

    // 2. Store user info
    // We treat every connection as a user.
    // Real users have isScreen: false (implicit).
    // Screen shares will explicitly NOT join via 'join-room' usually, 
    // but if they did, we'd handle it. 
    // Actually, our client logic for screen share is:
    // It creates a *new* connection but DOES NOT emit 'join-room'.
    // Instead it just starts offering. 
    // WAIT! The standard WebRTC pattern is:
    // 1. Join Room (to announce presence).
    // 2. Receive 'existing-users'.
    // 3. Connect.

    // For "Virtual Screen Peer", the client *could* emit join-room with "(Screen)" name.
    // Let's support that for maximum robustness.

    const user = { socketId: socket.id, userName, roomId };
    users.push(user);

    console.log(`👤 ${userName} joined room ${roomId}`);

    // 3. Send existing users to the new joiner
    const others = users.filter((u) => u.socketId !== socket.id && u.roomId === roomId);
    socket.emit("existing-users", others);

    // 4. Notify others
    socket.to(roomId).emit("user-joined", { socketId: socket.id, userName });
  });

  // --- Signaling Primitives ---
  // We strictly route by targetSocketId.
  // We invoke the 'isScreen' flag to help the client, but the server just passes it through.

  socket.on("offer", (payload) => {
    io.to(payload.targetSocketId).emit("offer", {
      ...payload,
      from: socket.id,
    });
  });

  socket.on("answer", (payload) => {
    io.to(payload.targetSocketId).emit("answer", {
      ...payload,
      from: socket.id,
    });
  });

  socket.on("ice-candidate", (payload) => {
    io.to(payload.targetSocketId).emit("ice-candidate", {
      ...payload,
      from: socket.id,
    });
  });

  // --- Disconnect Handling ---
  socket.on("disconnect", () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    const userIndex = users.findIndex((u) => u.socketId === socket.id);

    if (userIndex !== -1) {
      const user = users[userIndex];
      // Notify room
      socket.to(user.roomId).emit("user-left", { socketId: socket.id, userName: user.userName });
      // Remove from state
      users.splice(userIndex, 1);
    }
  });

  // Explicit Screen Disconnect (if client wants to manually close just the screen peer)
  socket.on("disconnect-screen", () => {
    // If the client manages the screen socket separately, 'disconnect' above handles it.
    // If the client re-uses the socket (multiplexing), we need this.
    // BUT: Our new architecture uses a NEW connection for screen share.
    // So 'disconnect' above is sufficient IF the screen share socket actually disconnects.
    // If the client just calls .close() on the PC but keeps the socket? 
    // No, the instruction was "New RTCPeerConnection".
    // Wait, "New RTCPeerConnection" does NOT mean "New Socket".
    // Usually, we multiplex signaling over ONE socket.

    // RE-DESIGN DECISION:
    // To map "Google Meet" reliability, we should Multiplex.
    // One Socket, Multiple PCs.
    // Why? Because managing 2 sockets per user is messy (auth, maintaining 2 WS connections).
    //
    // SO:
    // User has 1 Socket.
    // User has Map<PeerID, PC_Camera>
    // User has Map<PeerID, PC_Screen> (Outgoing)
    // User has Map<PeerID, PC_Incoming_Screen>
    //
    // This means 'disconnect' only happens when the User leaves the app.
    // When User stops screen share, they must emit 'stop-screen-share'.

    // Let's support 'user-left-screen' event.
    // We will broadcast "user-left" but with a suffix or flag?
    // No, 'user-left' usually implies "Remove everything for this ID".
    // Let's emit "screen-share-stopped" { socketId }.

    // Actually, the previous "Virtual Peer" architecture *relied* on the server appending "-screen" to IDs.
    // If we want "GMeet Clone" we should probably stick to the "Virtual Peer" pattern but make it cleaner.
    // 
    // Let's stick to the "Virtual Peer" pattern where the Client *pretends* to have a second socket ID?
    // No, that requires the Server to rewrite IDs (which caused our bugs).
    //
    // BETTER APPROACH for "GMeet Clone":
    // Explicit "Stream Type" Signaling.
    // "offer" { type: "camera" | "screen" }
    // The PeerConnection is created *per stream*? Or bundled?
    // "Per Peer, Bundled Tracks" is standard WebRTC (Unified Plan).
    // BUT "Per Stream" (Plan B style or just separate PCs) is often more robust for novice implementations because it avoids "Renegotiation Hell".
    //
    // Let's go with **Separate PCs Multiplexed over One Socket**.
    // 1. `peersRef` stores Camera PCs. Key: `socketId`
    // 2. `screenPeersRef` stores Screen PCs. Key: `socketId`
    //
    // Signaling:
    // offer { type: 'screen' } -> Receiver looks in `screenPeersRef`.
    // offer { type: 'camera' } -> Receiver looks in `peersRef`.

    io.emit("screen-share-stopped", { socketId: socket.id });
  });

  // Broadcast layout change
  socket.on("screen-share-started", () => {
    const user = users.find(u => u.socketId === socket.id);
    if (user) {
      user.isScreenSharing = true; // Track state
      socket.to(user.roomId).emit("user-started-screen", { socketId: socket.id, userName: user.userName });
    }
  });

  // Specific handler for stopping screen share to notify others
  socket.on("stop-screen-share", () => {
    const user = users.find(u => u.socketId === socket.id);
    if (user) {
      user.isScreenSharing = false; // Track state
      socket.to(user.roomId).emit("user-stopped-screen", { socketId: socket.id });
    }
  });

  // Handle new joins who need to know about active screen shares
  socket.on("check-screen-share", () => {
    // Find anyone in this user's room who is sharing
    const me = users.find(u => u.socketId === socket.id);
    if (!me) return;

    const presenter = users.find(u => u.roomId === me.roomId && u.isScreenSharing);
    if (presenter) {
      socket.emit("user-started-screen", { socketId: presenter.socketId, userName: presenter.userName });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

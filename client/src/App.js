import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./App.css";

const SIGNALING_SERVER =
  process.env.NODE_ENV === "production"
    ? "https://meet-app-d2db.onrender.com"
    : "http://localhost:5000";
const socket = io(SIGNALING_SERVER);

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
};

function App() {
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("");
  const localVideoRef = useRef();
  const localStreamRef = useRef(null);
  const peersRef = useRef({});
  const [remotePeers, setRemotePeers] = useState([]);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const screenVideoRef = useRef(); // for local preview of shared screen
  const screenStreamRef = useRef(null); // keep track of the screen stream
  const cameraPreviewRef = useRef(); // to restore camera preview

  // Track which streams/tracks are screen shares explicitly by ID
  const screenShareIds = useRef(new Set()); // Stores stream IDs AND track IDs

  const [cameraReady, setCameraReady] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);

  const [debugLogs, setDebugLogs] = useState([]);

  // Helper log
  const log = (msg) => {
    console.log(msg);
    setStatus(msg); // Simple overwrite for latest status
    setDebugLogs(prev => [msg, ...prev].slice(0, 20)); // Keep last 20 logs
  };

  // Signaling listeners
  useEffect(() => {
    socket.on("existing-users", async (users) => {
      log("Found existing users: " + users.map((u) => u.userName).join(", "));
      for (const user of users) {
        await createPeerConnectionAndOffer(user.socketId, user.userName, true);
      }
    });

    socket.on("user-joined", async ({ socketId, userName }) => {
      log(`${userName} joined the room`);
      // existing users do NOT initiate offers; new user will create offers
      await createPeerConnectionAndOffer(socketId, userName, false);
    });

    socket.on("offer", async ({ from, sdp, userName }) => {
      log(`Received offer from ${userName || from}`);
      await handleOffer(from, sdp, userName);
    });

    socket.on("answer", async ({ from, sdp }) => {
      log(`Received answer from ${from}`);
      const entry = peersRef.current[from];
      if (entry) {
        if (entry.pc.signalingState === "have-local-offer" || entry.pc.signalingState === "have-remote-pranswer") {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } else {
          console.warn("⚠️ Received Answer but signalingState is:", entry.pc.signalingState);
        }
      }
    });

    socket.on("ice-candidate", async ({ from, candidate }) => {
      const entry = peersRef.current[from];
      if (entry && candidate) {
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("Error adding received ICE candidate:", err);
        }
      }
    });

    socket.on("renegotiate-offer", async ({ from, sdp }) => {
      log(`📩 RENEGOTIATE OFFER from ${from}`);
      const entry = peersRef.current[from];
      if (!entry) return;
      console.log("Renegotiating Offer from", from.substr(0, 4));

      // Verify state before processing
      if (entry.pc.signalingState !== "stable" && entry.pc.signalingState !== "have-remote-offer") {
        console.warn("⚠️ Renegotiation Offer received but state is:", entry.pc.signalingState);
        log(`⚠️ State mismatch: ${entry.pc.signalingState}`);
      }

      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);

        socket.emit("renegotiate-answer", {
          targetSocketId: from,
          sdp: entry.pc.localDescription,
        });
        log(`✅ Sent RENEGOTIATE ANSWER to ${from}`);
      } catch (err) {
        console.error("Renegotiation failed:", err);
        log(`❌ Renegotiation failed: ${err.message}`);
      }
    });

    socket.on("renegotiate-answer", async ({ from, sdp }) => {
      log(`📩 RENEGOTIATE ANSWER from ${from}`);
      const entry = peersRef.current[from];
      if (entry) {
        if (entry.pc.signalingState === "have-local-offer") {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          log(`✅ RENEGOTIATION COMPLETE with ${from}`);
        } else {
          console.warn("⚠️ Renegotiation Answer received but state is:", entry.pc.signalingState);
          log(`⚠️ State mismatch answer: ${entry.pc.signalingState}`);
        }
      }
    });


    socket.on("user-left", ({ socketId, userName }) => {
      log(`${userName || socketId} left`);
      removePeer(socketId);
    });

    // NEW LISTENER: Handle Reconnection (Important for mobile)
    socket.on("connect", () => {
      log("🔌 Socket Connected: " + socket.id);
      // If we were already in a room, re-join
      if (joined && roomId && userName) {
        log("🔄 Re-joining room after reconnect...");
        socket.emit("join-room", roomId, userName);
        // Note: This might duplicate peers if not handled carefully, 
        // but existing-users usually sends the full list which we iterate.
        // A cleaner way is to clear peers on disconnect.
      }
    });

    socket.on("disconnect", () => {
      log("🔌 Socket Disconnected");
    });

    socket.on("sync-request", async ({ from, userName }) => {
      log(`🔄 Received SYNC REQUEST from ${userName || from}`);
      // Force a fresh connection to this user
      // 1. Remove old if exists
      if (peersRef.current[from]) {
        log(`Re-establishing connection to ${from}...`);
        peersRef.current[from].pc.close();
        delete peersRef.current[from];
        // UI update
        setRemotePeers(prev => prev.filter(p => p.socketId !== from));
      }

      // 2. Initiate NEW offer (this works because we are the 'stable' ones in the room)
      await createPeerConnectionAndOffer(from, userName, true);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("existing-users");
      socket.off("user-joined");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("renegotiate-offer");
      socket.off("renegotiate-answer");
      socket.off("user-left");
      socket.off("sync-request");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, roomId, userName]); // Added deps so re-join works





  // reliable local camera acquisition + attach
  useEffect(() => {
    let intervalId = null;
    async function getMedia() {
      try {
        console.log("🎥 Requesting camera...");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true,
        });
        console.log("✅ Got stream:", stream);
        localStreamRef.current = stream;
        setCameraReady(true); // Enable Join button

        // also attach to duplicate preview ref (hidden initially)
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
          cameraPreviewRef.current.muted = true;
          cameraPreviewRef.current.playsInline = true;
          await cameraPreviewRef.current.play().catch(() => { });
          cameraPreviewRef.current.style.display = "none"; // hide initially
        }

        // attempt attach/play immediately and repeatedly for a few seconds
        const attachStream = async () => {
          if (!localVideoRef.current || !localStreamRef.current) return;
          try {
            if (localVideoRef.current.srcObject !== localStreamRef.current) {
              localVideoRef.current.srcObject = localStreamRef.current;
              localVideoRef.current.muted = true; // allow autoplay in many browsers
              localVideoRef.current.playsInline = true;
              await localVideoRef.current.play();
              console.log("✅ Local video playing (auto)");
            } else {
              // already attached
              if (!localVideoRef.current.paused) {
                console.log("✅ Local video already playing");
              }
            }
          } catch (err) {
            // autoplay blocked or other issue
            console.warn("⚠️ attach/play failed (will wait for user gesture):", err);
          }
        };

        // Try immediately and then every 300ms up to ~5s
        await attachStream();
        intervalId = setInterval(attachStream, 300);
        setTimeout(() => {
          if (intervalId) clearInterval(intervalId);
        }, 5000);
      } catch (err) {
        console.error("🚫 Error getting user media:", err);
        alert("Camera/mic access failed: " + err.message);
      }
    }

    getMedia();
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, []);


  // --- SYNC CAMERA TO PEERS ---
  useEffect(() => {
    if (!joined || !cameraReady || !localStreamRef.current) return;

    const stream = localStreamRef.current;
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    Object.keys(peersRef.current).forEach(async (socketId) => {
      const pc = peersRef.current[socketId].pc;
      const senders = pc.getSenders();
      const hasVideo = senders.some(s => s.track && s.track.kind === "video" && s.track.id === videoTrack?.id);

      if (!hasVideo && videoTrack) {
        console.log("📷 Late camera sync: Adding track to", socketId);
        pc.addTrack(videoTrack, stream);
        if (audioTrack && !senders.some(s => s.track && s.track.kind === "audio")) {
          pc.addTrack(audioTrack, stream);
        }

        // Renegotiate
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("renegotiate-offer", { targetSocketId: socketId, sdp: pc.localDescription });
        } catch (err) {
          console.error("Error renegotiating for late camera:", err);
        }
      }
    });
  }, [joined, cameraReady]);


  async function enableCamera() {
    // 1. If no stream, try to get it
    if (!localStreamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        setCameraReady(true);
        // The useEffect above will handle adding tracks to peers!

        // Make sure state reflects correct enabled status
        setIsAudioEnabled(true);
        setIsVideoEnabled(true);

        // Update local preview
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play().catch(() => { });
        }
      } catch (err) {
        console.error("Failed to enable camera:", err);
        alert("Could not start camera: " + err.message);
      }
    } else {
      // Already have stream, ensure element is playing
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(() => { });
      }
    }
  }

  // Toggle Audio
  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        console.log("Audio enabled:", audioTrack.enabled);
      }
    }
  };

  // Toggle Video
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        console.log("Video enabled:", videoTrack.enabled);
      }
    }
  };


  // create peer connection
  async function createPeerConnectionAndOffer(targetSocketId, targetUserName, initiateOffer = false) {
    if (peersRef.current[targetSocketId]) return;
    console.log("Creating PC ->", targetSocketId, "offer?", initiateOffer);

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    // --- ICE STATE DEBUGGING ---
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      log(`🧊 ICE State (${targetSocketId.substr(0, 4)}): ${state}`);
      if (state === "failed" || state === "disconnected") {
        log(`⚠️ Connection issues with ${targetUserName || targetSocketId}`);
      }
    };

    pc.onconnectionstatechange = () => {
      log(`🔗 Connection State (${targetSocketId.substr(0, 4)}): ${pc.connectionState}`);
    };

    // IMMEDIATE UI UPDATE: Show peer even before tracks arrive
    setRemotePeers((prev) => {
      if (prev.find(p => p.socketId === targetSocketId)) return prev;
      return [...prev, {
        socketId: targetSocketId,
        userName: targetUserName,
        streams: []
      }];
    });


    pc.ontrack = (event) => {
      const stream = event.streams[0];
      const track = event.track;

      // Ensure peer entry exists
      if (!peersRef.current[targetSocketId]) {
        peersRef.current[targetSocketId] = { pc, streams: [], userName: targetUserName };
      }

      const currentEntry = peersRef.current[targetSocketId];
      // Check if we already have this stream (by ID)
      const alreadyHas = currentEntry.streams.some((s) => s.mediaStream.id === stream.id);

      if (!alreadyHas) {
        // With Virtual Screen Peers, we don't need complex detection.
        // If the username says "(Screen)", it's a screen share.
        // OR check the socketId suffix.

        let type = "camera";
        if (targetUserName && targetUserName.includes("(Screen)")) {
          type = "screen";
        } else if (targetSocketId.endsWith("-screen")) {
          type = "screen";
        }

        console.log(`NEW TRACK from ${targetSocketId}: Stream ${stream.id}, Type: ${type}`);
        log(`New Track from ${targetUserName || targetSocketId} (${type})`);

        const newStreamObj = {
          id: stream.id,
          mediaStream: stream,
          type: type
        };
        currentEntry.streams.push(newStreamObj);

        // Listen for track removals
        stream.onremovetrack = () => {
          console.log("Track removed from stream:", stream.id);
          if (stream.getTracks().length === 0) {
            setRemotePeers((prev) => {
              return prev.map((p) => {
                if (p.socketId === targetSocketId) {
                  return {
                    ...p,
                    streams: p.streams.filter(s => s.id !== stream.id)
                  };
                }
                return p;
              });
            });
            currentEntry.streams = currentEntry.streams.filter(s => s.id !== stream.id);
          }
        };
      } else {
        console.log(`Duplicate stream ignored: ${stream.id}`);
      }

      // Update UI state
      setRemotePeers((prev) => {
        const existing = prev.find((p) => p.socketId === targetSocketId);
        if (!existing) {
          return [...prev, {
            socketId: targetSocketId,
            userName: targetUserName,
            // IMMUTABLE COPY
            streams: [...currentEntry.streams]
          }];
        } else {
          return prev.map((p) =>
            p.socketId === targetSocketId
              ? { ...p, streams: [...currentEntry.streams] }
              : p
          );
        }
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          targetSocketId,
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (["failed", "disconnected", "closed"].includes(state)) {
        removePeer(targetSocketId);
      }
    };

    peersRef.current[targetSocketId] = { pc, streams: [], userName: targetUserName };

    if (initiateOffer) {
      try {
        const offer = await pc.createOffer({ iceRestart: true }); // FORCE ICE RESTART ON INIT
        await pc.setLocalDescription(offer);
        socket.emit("offer", { targetSocketId, sdp: pc.localDescription });
      } catch (err) {
        console.error("Error creating/sending offer:", err);
      }
    }
  }

  // handle incoming offer
  async function handleOffer(fromSocketId, sdp, fromUserName) {
    // If we don't have a peer connection yet, create one
    if (!peersRef.current[fromSocketId]) {
      // We pass false for initiateOffer because we are answering
      await createPeerConnectionAndOffer(fromSocketId, fromUserName, false);
    }

    const entry = peersRef.current[fromSocketId];

    // For answerer, ensure we add tracks before creating answer
    const localStream = localStreamRef.current;
    if (localStream) {
      // Check if tracks already added?
      const senders = entry.pc.getSenders();
      const hasVideo = senders.some(s => s.track && s.track.kind === "video");
      if (!hasVideo) {
        console.log("Adding local tracks to existing PC (Answerer)");
        localStream.getTracks().forEach((t) => entry.pc.addTrack(t, localStream));
      }
    }

    try {
      // Check state before setting remote description
      if (entry.pc.signalingState !== "stable" && entry.pc.signalingState !== "have-remote-offer") {
        console.warn("Using setRemoteDescription(offer) but state is", entry.pc.signalingState);
        // If we are in 'have-local-offer', it means we also sent an offer (glare).
        // A simple collision resolution strategy is needed.
        // For now, if we are the 'polite' peer (e.g. smaller ID? or just always yield), we roll back.
        // But implementing full glare handling is complex.
        // Let's just log for now.
      }

      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      socket.emit("answer", { targetSocketId: fromSocketId, sdp: entry.pc.localDescription });
    } catch (err) {
      console.error("Error handling offer:", err);
    }
  }

  function removePeer(socketId) {
    const entry = peersRef.current[socketId];
    if (entry) {
      try {
        entry.pc.close();
      } catch (e) { }
      delete peersRef.current[socketId];
    }
    setRemotePeers((prev) => prev.filter((p) => p.socketId !== socketId));
  }

  // Join room — also trigger a user-gesture play attempt on Join
  function joinRoom() {
    if (!roomId || !userName) {
      alert("Enter a name and room ID");
      return;
    }
    socket.emit("join-room", roomId, userName);
    setJoined(true);
    log("Joined room: " + roomId);

    // user gesture: attempt to play the local video now (helps autoplay policies)
    setTimeout(() => {
      try {
        const v = localVideoRef.current;
        if (v) {
          v.muted = true; // ensure muted so autoplay is allowed
          v.play().then(() => {
            console.log("▶️ Play triggered from Join click");
          }).catch((e) => {
            console.warn("▶️ Play from Join click failed:", e);
          });
        }
      } catch (e) {
        console.warn("▶️ Play attempt failed:", e);
      }
    }, 0);
  }

  // Screen Share PC Reference
  const screenPCRef = useRef(null);

  async function startScreenShare() {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const screenTrack = displayStream.getVideoTracks()[0];
      screenStreamRef.current = displayStream;

      // Create a NEW Peer Connection for the screen share
      // We broadcast this to "all" but in this simple signaling model we just need to 
      // create separate offers for each existing peer.
      // actually, to keep it simple with our current "mesh" logic:
      // We will iterate through all existing peers and initiate a NEW connection to them
      // BUT, acting as if we are a new user.

      // WAIT. The robust way is to treating the screen share as a single "user" 
      // but in a mesh network, we need a PC per remote peer.
      // So, we need `screenPeersRef` to hold PCs for the screen share output.

      // Let's refine the plan:
      // We will behave like we just joined the room as "MyName (Screen)".
      // So need to emit "join-room"? No, that conflicts with socket ID.
      // better: We manually initiate offers to all `remotePeers` with `isScreen: true`.

      // Store PCs for screen sharing: keys are remoteSocketIds
      screenPCRef.current = {};

      // 1. Show local preview
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = displayStream;
        await screenVideoRef.current.play().catch(() => { });
        // show debug
        screenVideoRef.current.style.border = "2px solid #0f0";
      }
      setIsScreenSharing(true);
      if (cameraPreviewRef.current) cameraPreviewRef.current.style.display = "block";

      // 2. Iterate through all known participants and connect to them with a NEW PC
      // We can use the existing `peersRef` to know who is in the room.
      const targets = Object.keys(peersRef.current);

      for (const targetId of targets) {
        // Skip if target is already a screen peer (don't share screen to a screen)
        if (targetId.includes("-screen")) continue;

        log(`Initiating Screen Share to ${targetId}...`);
        const pc = new RTCPeerConnection(ICE_CONFIG);

        // Add track
        pc.addTrack(screenTrack, displayStream);

        // ICE Candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit("ice-candidate", {
              targetSocketId: targetId,
              candidate: event.candidate,
              isScreen: true
            });
          }
        };

        // Create Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("offer", {
          targetSocketId: targetId,
          sdp: pc.localDescription,
          isScreen: true // FLAG TO TELL SERVER TO MODIFY ID
        });

        // Store this PC so we can close it later
        screenPCRef.current[targetId] = pc;
      }

      screenTrack.onended = stopScreenShare;
      console.log("✅ Virtual Screen Share started");

    } catch (err) {
      console.error("🚫 Screen sharing failed:", err);
      alert("Screen share failed: " + err.message);
    }
  }

  function stopScreenShare() {
    try {
      // Stop tracks
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
      }
      screenStreamRef.current = null;

      // Close all Screen PCs
      if (screenPCRef.current) {
        Object.values(screenPCRef.current).forEach(pc => pc.close());
      }
      screenPCRef.current = null;

      // Notify Server to tell others "User-Screen" left
      socket.emit("disconnect-screen");

      // UI Reset
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
      if (cameraPreviewRef.current) cameraPreviewRef.current.style.display = "none";
      setIsScreenSharing(false);

      log("⛔ Screen sharing stopped");

    } catch (err) {
      console.error("Error stopping screen share:", err);
    }
  }

  // UPDATED ONTRACK (Removed Heuristic, simpler now)
  // ... (Moving `ontrack` replacement to a separate call since this block is for start/stop functions)


  const requestSync = () => {
    log("🔄 Requesting Connection Sync...");
    socket.emit("sync-request");
  };

  // Determine view mode
  // The layout switching logic depends on `screenShareStream` being found
  const screenShareStream = remotePeers.flatMap(p => p.streams).find(s => s.type === "screen");
  const isTheaterMode = !!screenShareStream || isScreenSharing;

  // Remote video component
  function RemoteVideo({ socketId, userName, streams, inSidebar }) {
    return (
      <div className={inSidebar ? "remote-video-sidebar" : "video-wrapper"}>
        {!inSidebar && <div className="user-label">{userName || socketId}</div>}

        {streams.map((stream, idx) => {
          // In theater mode sidebar, only show cameras
          if (inSidebar && stream.type === "screen") return null;

          return (
            <div key={stream.id} style={{ position: "relative", width: "100%", height: "100%" }}>
              <video
                autoPlay
                playsInline
                ref={(el) => {
                  if (el && el.srcObject !== stream.mediaStream) {
                    el.srcObject = stream.mediaStream;
                    // EXPLICIT PLAY ATTEMPT
                    el.play().catch(e => console.error("Remote video play failed:", e));
                  }
                }}
                style={{
                  width: inSidebar ? "100%" : "320px",
                  height: inSidebar ? "auto" : "240px",
                  border: stream.type === "screen" ? "2px solid #00f" : "none",
                  borderRadius: 8,
                  backgroundColor: "#000" // visually show black box if video missing
                }}
              />
              {inSidebar && <span className="user-label" style={{ fontSize: "0.7rem", bottom: 5, left: 5 }}>{userName}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  // --- RENDER LAYOUTS ---

  const renderTheaterMode = () => {
    // Determine what to show on Main Stage
    let mainStageStream = null;

    // If local user is sharing, show local screen preview
    if (isScreenSharing && screenStreamRef.current) {
      // We might not have a reliable stream object for local, use ref manually in effect or just video element
    } else if (screenShareStream) {
      mainStageStream = screenShareStream.mediaStream;
    }

    return (
      <div className="theater-container">
        {/* MAIN STAGE */}
        <div className="main-stage">
          {isScreenSharing ? (
            <video
              ref={(el) => {
                screenVideoRef.current = el;
                if (el && screenStreamRef.current) {
                  el.srcObject = screenStreamRef.current;
                }
              }}
              autoPlay playsInline muted
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : mainStageStream ? (
            <video
              autoPlay playsInline muted // ADDED MUTED HERE FOR AUTOPLAY
              ref={el => { if (el && el.srcObject !== mainStageStream) el.srcObject = mainStageStream }}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <div style={{ color: "rgba(255,255,255,0.5)", fontSize: "1.2rem" }}>Waiting for screen share...</div>
          )}
          <div className="stage-label">
            {isScreenSharing ? "You are presenting" : "Viewing Screen Share"}
          </div>
        </div>

        {/* SIDEBAR (Cameras) */}
        <div className="reaction-sidebar">
          {/* Local Camera (You) */}
          <div className="video-wrapper" style={{ width: "100%", height: "auto", marginBottom: 15 }}>
            <video
              ref={(el) => {
                cameraPreviewRef.current = el;
                if (el && localStreamRef.current) {
                  el.srcObject = localStreamRef.current;
                }
              }}
              autoPlay playsInline muted style={{ width: "100%", borderRadius: 8, background: "#000", display: "block" }}
            />
            <span className="user-label">You</span>
          </div>

          {/* Controls in Sidebar for Theater Mode */}
          <div style={{ marginBottom: 20, display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center", width: "100%" }}>
            <button className={isAudioEnabled ? "btn-active" : "btn-inactive"} onClick={toggleAudio} style={{ flex: 1, fontSize: "0.8rem", padding: "8px" }}>
              {isAudioEnabled ? "🎤 Mute" : "🔇 Unmute"}
            </button>
            <button className={isVideoEnabled ? "btn-active" : "btn-inactive"} onClick={toggleVideo} style={{ flex: 1, fontSize: "0.8rem", padding: "8px" }}>
              {isVideoEnabled ? "📹 Stop" : "📷 Start"}
            </button>
            {!isScreenSharing ? (
              <button className="primary" onClick={startScreenShare} style={{ width: "100%", fontSize: "0.8rem", padding: "8px" }}>🖥️ Share</button>
            ) : (
              <button className="danger" onClick={stopScreenShare} style={{ width: "100%", fontSize: "0.8rem", padding: "8px" }}>⛔ Stop Share</button>
            )}
            <button className="control-btn" onClick={requestSync} style={{ flex: 1, fontSize: "0.8rem", padding: "8px", background: "#e67e22" }}>
              🔄 Fix/Sync
            </button>
          </div>

          {/* Remote Cameras */}
          {remotePeers.map(p => (
            <RemoteVideo key={p.socketId} {...p} inSidebar={true} />
          ))}
        </div>
      </div>
    );
  };

  const renderGridView = () => (
    <div className="grid-container">
      <h3>Room: {roomId} — You: {userName}</h3>
      <div className="controls-bar">
        <button className={isAudioEnabled ? "btn-active" : "btn-inactive"} onClick={toggleAudio}>
          {isAudioEnabled ? "🎤 Mute" : "🔇 Unmute"}
        </button>
        <button className={isVideoEnabled ? "btn-active" : "btn-inactive"} onClick={toggleVideo}>
          {isVideoEnabled ? "📹 Stop" : "📷 Start"}
        </button>

        <button className="primary" onClick={enableCamera}>
          ▶️ Init Camera
        </button>

        {!isScreenSharing ? (
          <button className="primary" onClick={startScreenShare}>🖥️ Share Screen</button>
        ) : (
          <button className="danger" onClick={stopScreenShare}>⛔ Stop Sharing</button>
        )}
        <button className="control-btn" onClick={requestSync} style={{ background: "#e67e22" }}>
          🔄 Fix/Sync
        </button>
      </div>

      <div className="video-grid">
        {/* Local Controls & Video */}
        <div className="video-wrapper">
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: 320, height: 240, backgroundColor: "#000" }} />
          <span className="user-label">You (Local)</span>
        </div>

        {/* Local Screen Preview if sharing */}
        {isScreenSharing && (
          <div className="video-wrapper">
            <video
              ref={(el) => {
                screenVideoRef.current = el;
                if (el && screenStreamRef.current) {
                  el.srcObject = screenStreamRef.current;
                }
              }}
              autoPlay
              playsInline
              muted
              style={{ width: 320, height: 180 }}
            />
            <span className="user-label">Your Screen</span>
          </div>
        )}

        {/* Remote Peers Grid */}
        {remotePeers.length === 0 && (<div style={{ color: "rgba(255,255,255,0.5)", width: "100%", textAlign: "center", marginTop: 20 }}>No one else in the room</div>)}
        {remotePeers.map((p) => <RemoteVideo key={p.socketId} {...p} inSidebar={false} />)}
      </div>
      <div style={{ marginTop: 12, color: "rgba(255,255,255,0.6)", textAlign: "center" }}>{status}</div>
    </div>
  );

  return (
    <div className="App">
      <div className="stars"></div>
      <div className="stars2"></div>
      <div className="stars3"></div>
      {/* DEBUG OVERLAY */}
      <div style={{
        position: "fixed",
        top: 0,
        right: 0,
        background: "rgba(0,0,0,0.8)",
        color: "#0f0",
        padding: 5,
        fontSize: "10px",
        zIndex: 9999,
        pointerEvents: "none"
      }}>
        <div>Status: {status}</div>
        <div>Room: {roomId || "N/A"}</div>
        <div>Socket: {socket.id}</div>
        <div>Remote Peers: {remotePeers.length}</div>
        <div>Screen Share: {isScreenSharing ? "ON" : "OFF"}</div>
        <div style={{ maxHeight: 150, overflowY: "auto", marginTop: 5, borderTop: "1px solid #333" }}>
          {debugLogs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
        <button onMouseDown={() => {
          console.log("Current Peers Ref:", peersRef.current);
          log("Peers in Ref: " + Object.keys(peersRef.current).join(", "));
        }} style={{ fontSize: "10px", padding: 2, marginTop: 5 }}>DUMP PEERS</button>
      </div>

      {!joined ? (
        <div className="join-container">
          <div className="join-card">
            <h2 style={{ margin: "0 0 20px 0" }}>Join Meeting</h2>
            <input placeholder="Your Display Name" value={userName} onChange={(e) => setUserName(e.target.value)} />
            <input placeholder="Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            <button className="primary" onClick={joinRoom} style={{ width: "100%", justifyContent: "center" }}>Join Room</button>
            <div style={{ marginTop: 15, color: "rgba(255,255,255,0.6)", fontSize: "0.9rem" }}>{status}</div>
          </div>
        </div>
      ) : (
        isTheaterMode ? renderTheaterMode() : renderGridView()
      )}
    </div>
  );
}

export default App;

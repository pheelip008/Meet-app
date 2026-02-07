import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

const SIGNALING_SERVER = "http://localhost:5000";
const socket = io(SIGNALING_SERVER);

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
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



  const [cameraReady, setCameraReady] = useState(false);

  // Signaling listeners (unchanged)
  useEffect(() => {
    socket.on("existing-users", async (users) => {
      setStatus("Found existing users: " + users.map((u) => u.userName).join(", "));
      for (const user of users) {
        await createPeerConnectionAndOffer(user.socketId, user.userName, true);
      }
    });

    socket.on("user-joined", async ({ socketId, userName }) => {
      setStatus(`${userName} joined the room`);
      // existing users do NOT initiate offers; new user will create offers
      await createPeerConnectionAndOffer(socketId, userName, false);
    });

    socket.on("offer", async ({ from, sdp, userName }) => {
      setStatus(`Received offer from ${userName || from}`);
      await handleOffer(from, sdp, userName);
    });

    socket.on("answer", async ({ from, sdp }) => {
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
      const entry = peersRef.current[from];
      if (!entry) return;
      console.log("Renegotiating Offer from", from);

      // Verify state before processing
      if (entry.pc.signalingState !== "stable" && entry.pc.signalingState !== "have-remote-offer") {
        console.warn("⚠️ Renegotiation Offer received but state is:", entry.pc.signalingState);
        // In some cases we might want to process anyway if it resets state, but usually this indicates a race.
        // For now, let's try to process.
      }

      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);

      socket.emit("renegotiate-answer", {
        targetSocketId: from,
        sdp: entry.pc.localDescription,
      });
    });

    socket.on("renegotiate-answer", async ({ from, sdp }) => {
      const entry = peersRef.current[from];
      if (entry) {
        if (entry.pc.signalingState === "have-local-offer") {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } else {
          console.warn("⚠️ Renegotiation Answer received but state is:", entry.pc.signalingState);
        }
      }
    });


    socket.on("user-left", ({ socketId, userName }) => {
      setStatus(`${userName || socketId} left`);
      removePeer(socketId);
    });


    return () => {
      socket.off("existing-users");
      socket.off("user-joined");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
      socket.off("renegotiate-offer"); // cleaned new listeners
      socket.off("renegotiate-answer");
      socket.off("user-left");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reliable local camera acquisition + attach
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
  // If camera becomes ready AFTER we joined (or we join before camera is ready),
  // we need to add the tracks to existing peers.
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


  // create peer connection
  async function createPeerConnectionAndOffer(targetSocketId, targetUserName, initiateOffer = false) {
    if (peersRef.current[targetSocketId]) return;
    console.log("Creating PC ->", targetSocketId, "offer?", initiateOffer);

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      // Ensure peer entry exists
      if (!peersRef.current[targetSocketId]) {
        peersRef.current[targetSocketId] = { pc, streams: [], userName: targetUserName };
      }

      const currentEntry = peersRef.current[targetSocketId];
      // Check if we already have this stream (by ID)
      const alreadyHas = currentEntry.streams.some((s) => s.mediaStream.id === stream.id);

      if (!alreadyHas) {
        // Logic: 1st stream = Camera, 2nd stream = Screen
        // Note: This heuristic assumes camera is always first. 
        // With addTrack, both persist.
        const type = currentEntry.streams.length === 0 ? "camera" : "screen";

        const newStreamObj = {
          id: stream.id,
          mediaStream: stream,
          type: type
        };
        currentEntry.streams.push(newStreamObj);

        // Listen for track removals to clean up state
        stream.onremovetrack = () => {
          console.log("Track removed from stream:", stream.id);
          if (stream.getTracks().length === 0) {
            // Stream is empty, remove it from state
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
            // Also update currentEntry ref
            currentEntry.streams = currentEntry.streams.filter(s => s.id !== stream.id);
          }
        };
      }

      // Update UI state
      setRemotePeers((prev) => {
        const existing = prev.find((p) => p.socketId === targetSocketId);
        if (!existing) {
          return [...prev, {
            socketId: targetSocketId,
            userName: targetUserName,
            // Use currentEntry.streams to ensure we get the latest
            streams: currentEntry.streams
          }];
        } else {
          return prev.map((p) =>
            p.socketId === targetSocketId
              ? { ...p, streams: currentEntry.streams }
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
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { targetSocketId, sdp: pc.localDescription });
      } catch (err) {
        console.error("Error creating/sending offer:", err);
      }
    }
  }

  // handle incoming offer
  async function handleOffer(fromSocketId, sdp, fromUserName) {
    if (!peersRef.current[fromSocketId]) {
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
    setStatus("Joined room: " + roomId);

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
  // 📺 Screen sharing


  // async function startScreenShare() {
  //   try {
  //     const displayStream = await navigator.mediaDevices.getDisplayMedia({
  //       video: true,
  //       audio: false,
  //     });

  //     const screenTrack = displayStream.getVideoTracks()[0];

  //     // Replace outgoing video track for all peers
  //     for (const peerId in peersRef.current) {
  //       const sender = peersRef.current[peerId].pc
  //         .getSenders()
  //         .find((s) => s.track && s.track.kind === "video");
  //       if (sender) sender.replaceTrack(screenTrack);
  //     }

  //     // Update local video preview to show shared screen
  //     if (localVideoRef.current) {
  //       localVideoRef.current.srcObject = displayStream;
  //       await localVideoRef.current.play().catch(() => {});
  //     }

  //     setIsScreenSharing(true);

  //     // If user stops sharing via browser controls
  //     screenTrack.onended = () => {
  //       stopScreenShare();
  //     };

  //     console.log("✅ Screen sharing started");
  //   } catch (err) {
  //     console.error("🚫 Screen sharing failed:", err);
  //     alert("Screen share failed: " + err.message);
  //   }
  // }
  async function startScreenShare() {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      const screenTrack = displayStream.getVideoTracks()[0];
      screenStreamRef.current = displayStream;

      // Add the screen track to all peers and renegotiate
      for (const peerId in peersRef.current) {
        const pc = peersRef.current[peerId].pc;
        // addTrack sends the stream to the other side
        pc.addTrack(screenTrack, displayStream);

        // Negotiate the new track
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("renegotiate-offer", { targetSocketId: peerId, sdp: pc.localDescription });
      }

      // Local screen preview
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = displayStream;
        await screenVideoRef.current.play().catch(() => { });
      }

      // Show the camera preview overlay
      if (cameraPreviewRef.current) {
        cameraPreviewRef.current.style.display = "block";
      }

      setIsScreenSharing(true);

      screenTrack.onended = stopScreenShare;
      console.log("✅ Screen sharing started with camera preview visible");
    } catch (err) {
      console.error("🚫 Screen sharing failed:", err);
      alert("Screen share failed: " + err.message);
    }
  }




  //phase 3: stop screen sharing

  async function stopScreenShare() {
    try {
      // 1. Stop the tracks locally
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      const screenStreamId = screenStreamRef.current?.id;
      screenStreamRef.current = null;

      // 2. Remove tracks from peers and renegotiate
      for (const peerId in peersRef.current) {
        const pc = peersRef.current[peerId].pc;
        const senders = pc.getSenders();

        // Find senders that are NOT the camera (localStreamRef)
        // We assume any video sender that isn't the camera is the screen share
        const cameraTrackId = localStreamRef.current?.getVideoTracks()[0]?.id;

        for (const sender of senders) {
          if (sender.track && sender.track.kind === "video") {
            if (sender.track.id !== cameraTrackId) {
              pc.removeTrack(sender);
            }
          }
        }

        // Negotiate the removal
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("renegotiate-offer", { targetSocketId: peerId, sdp: pc.localDescription });
      }

      // Hide screen preview
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null;
      }

      // Hide the camera preview overlay again
      if (cameraPreviewRef.current) {
        cameraPreviewRef.current.style.display = "none";
      }

      setIsScreenSharing(false);
      console.log("⛔ Screen sharing stopped, camera restored");
    } catch (err) {
      console.error("⚠️ Error stopping screen share:", err);
    }
  }




  // function stopScreenShare() {
  //   try {
  //     const camStream = localStreamRef.current;
  //     if (!camStream) return;

  //     const camTrack = camStream.getVideoTracks()[0];

  //     // Replace outgoing video track back to camera
  //     for (const peerId in peersRef.current) {
  //       const sender = peersRef.current[peerId].pc
  //         .getSenders()
  //         .find((s) => s.track && s.track.kind === "video");
  //       if (sender) sender.replaceTrack(camTrack);
  //     }

  //     // Update local preview
  //     if (localVideoRef.current) {
  //       localVideoRef.current.srcObject = camStream;
  //     }

  //     setIsScreenSharing(false);
  //     console.log("⛔ Screen sharing stopped, camera restored");
  //   } catch (err) {
  //     console.error("⚠️ Error stopping screen share:", err);
  //   }
  // }

  // Determine view mode
  const screenShareStream = remotePeers.flatMap(p => p.streams).find(s => s.type === "screen");
  const isTheaterMode = !!screenShareStream || isScreenSharing;

  // Remote video component
  function RemoteVideo({ socketId, userName, streams, inSidebar }) {
    return (
      <div style={{
        display: "flex",
        flexDirection: inSidebar ? "column" : "row",
        margin: 8,
        alignItems: "center"
      }}>
        {!inSidebar && <div style={{ marginBottom: 4 }}>{userName || socketId}</div>}

        {streams.map((stream, idx) => {
          // In theater mode sidebar, only show cameras
          if (inSidebar && stream.type === "screen") return null;

          return (
            <div key={stream.id} style={{ position: "relative" }}>
              <video
                autoPlay
                playsInline
                ref={(el) => {
                  if (el && el.srcObject !== stream.mediaStream) {
                    el.srcObject = stream.mediaStream;
                  }
                }}
                style={{
                  width: inSidebar ? 160 : 240,
                  height: inSidebar ? 120 : 180,
                  backgroundColor: "#000",
                  border: stream.type === "screen" ? "2px solid #00f" : "none",
                  borderRadius: 8
                }}
              />
              {inSidebar && <span style={{ position: "absolute", bottom: 5, left: 5, color: "white", fontSize: 10, background: "rgba(0,0,0,0.5)", padding: "2px 4px" }}>{userName}</span>}
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
      <div className="theater-container" style={{ display: "flex", height: "90vh", width: "100%" }}>
        {/* MAIN STAGE */}
        <div className="main-stage" style={{ flex: 4, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
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
              autoPlay playsInline
              ref={el => { if (el && el.srcObject !== mainStageStream) el.srcObject = mainStageStream }}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <div style={{ color: "white" }}>Waiting for screen share...</div>
          )}
          <div style={{ position: "absolute", top: 20, left: 20, color: "white", background: "rgba(0,0,0,0.6)", padding: 10, borderRadius: 8 }}>
            {isScreenSharing ? "You are presenting" : "Viewing Screen Share"}
          </div>
        </div>

        {/* SIDEBAR (Cameras) */}
        <div className="reaction-sidebar" style={{ flex: 1, background: "#222", overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", alignItems: "center" }}>
          {/* Local Camera (You) */}
          <div style={{ marginBottom: 10, position: "relative" }}>
            <video
              ref={(el) => {
                cameraPreviewRef.current = el;
                if (el && localStreamRef.current) {
                  el.srcObject = localStreamRef.current;
                }
              }}
              autoPlay playsInline muted style={{ width: 160, height: 120, borderRadius: 8, background: "#000" }}
            />
            <span style={{ position: "absolute", bottom: 5, left: 5, color: "white", fontSize: 10, background: "rgba(0,0,0,0.5)", padding: "2px 4px" }}>You</span>
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
    <div>
      <h3>Room: {roomId} — You: {userName}</h3>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Local Controls & Video */}
        <div>
          <div>Local</div>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: 320, height: 240, backgroundColor: "#000" }} />
          <div style={{ marginTop: 6 }}>
            <button
              style={{ padding: "6px 12px", cursor: "pointer" }}
              onClick={() => {
                const v = localVideoRef.current;
                if (v && localStreamRef.current) {
                  v.srcObject = localStreamRef.current;
                  v.muted = true;
                  v.playsInline = true;
                  v.play().catch(console.error);
                }
              }}
            >
              ▶️ Start Camera
            </button>
            <div style={{ marginTop: 6 }}>
              {!isScreenSharing ? (
                <button onClick={startScreenShare}>🖥️ Share Screen</button>
              ) : (
                <button onClick={stopScreenShare}>⛔ Stop Sharing</button>
              )}
            </div>
            {isScreenSharing && (
              <div style={{ marginTop: 10 }}>
                <div>Screen Preview</div>
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
                  style={{ width: 320, height: 180, border: "2px solid #ccc" }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Remote Peers Grid */}
        <div>
          <div>Remote peers</div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {remotePeers.length === 0 && (<div style={{ color: "gray" }}>No one else in the room</div>)}
            {remotePeers.map((p) => <RemoteVideo key={p.socketId} {...p} inSidebar={false} />)}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 12, color: "gray" }}>{status}</div>
    </div>
  );

  return (
    <div style={{ padding: joined ? 0 : 20, height: "100vh" }}>
      {!joined ? (
        <div style={{ textAlign: "center", marginTop: 50 }}>
          <h2>Join a Room (WebRTC)</h2>
          <input placeholder="Your name" value={userName} onChange={(e) => setUserName(e.target.value)} style={{ marginRight: 8 }} />
          <input placeholder="Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ marginRight: 8 }} />
          <button onClick={joinRoom}>Join</button>
          <div style={{ marginTop: 12, color: "gray" }}>{status}</div>
        </div>
      ) : (
        isTheaterMode ? renderTheaterMode() : renderGridView()
      )}
    </div>
  );
}

export default App;




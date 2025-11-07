/*                                                                                                                                                                                 

Phase 1: Basic room join/leave notifications only

   - User joins a room
   - User leaves a room
   - Notify other users in the room
   - Send existing users list to new user






*/
// import React, { useState, useEffect } from "react";
// import io from "socket.io-client";

// const socket = io("http://localhost:5000");

// function App() {
//   const [roomId, setRoomId] = useState("");
//   const [userName, setUserName] = useState("");
//   const [joined, setJoined] = useState(false);
//   const [messages, setMessages] = useState([]);

//   useEffect(() => {
//     socket.on("user-joined", (name) => {
//       setMessages((prev) => [...prev, `${name} joined the room`]);
//     });

//     socket.on("user-left", (name) => {
//       setMessages((prev) => [...prev, `${name} left the room`]);
//     });

//     // 👇 New listener
//     socket.on("existing-users", (users) => {
//       if (users.length > 0) {
//         setMessages((prev) => [
//           ...prev,
//           `People already in room: ${users.join(", ")}`
//        ]);
//       }
//     });

//     return () => {
//       socket.off("user-joined");
//       socket.off("user-left");
//       socket.off("existing-users");
//       };
//   }, []);

// /*************  ✨ Windsurf Command ⭐  *************/
//   /**
//    * Joins a room by emitting a "join-room" event to the server.
//    * If the user has entered a room ID and a username, sets the joined state to true,
//    * and adds a message to the messages list indicating that the user has joined the room.
//    */
// /*******  34f89eb9-fcef-4abe-b3c2-abc19cd2f898  *******/
//   const joinRoom = () => {
//     if (roomId && userName) {
//       socket.emit("join-room", roomId, userName);
//       setJoined(true);
//       setMessages((prev) => [...prev, `You joined room ${roomId}`]);
//     }
//   };

//   return (
//     <div style={{ textAlign: "center", marginTop: "50px" }}>
//       {!joined ? (
//         <div>
//           <h2>Join a Room</h2>
//           <input
//             placeholder="Your Name"
//             value={userName}
//             onChange={(e) => setUserName(e.target.value)}
//           />
//           <br />
//           <input
//             placeholder="Room ID"
//             value={roomId}
//             onChange={(e) => setRoomId(e.target.value)}
//           />
//           <br />
//           <button onClick={joinRoom}>Join</button>
//         </div>
//       ) : (
//         <div>
//           <h2>Room: {roomId}</h2>
//           <div style={{ marginTop: "20px" }}>
//             {messages.map((msg, i) => (
//               <p key={i}>{msg}</p>
//             ))}
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// export default App;

/*                                                                                                                                                                                 

Phase 2: Add signaling for WebRTC peer connections



*/

import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";

const SIGNALING_SERVER = "http://10.0.194.186:5000";
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
        await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
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
      event.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
      peersRef.current[targetSocketId].stream = remoteStream;
      setRemotePeers((prev) => {
        if (prev.find((p) => p.socketId === targetSocketId)) return prev;
        return [...prev, { socketId: targetSocketId, userName: targetUserName }];
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

    peersRef.current[targetSocketId] = { pc, stream: remoteStream, userName: targetUserName };

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
    try {
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
      } catch (e) {}
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

  // Remote video component
  function RemoteVideo({ socketId, userName }) {
    const videoRef = useRef();
    useEffect(() => {
      const id = setInterval(() => {
        const entry = peersRef.current[socketId];
        if (entry?.stream && videoRef.current && videoRef.current.srcObject !== entry.stream) {
          videoRef.current.srcObject = entry.stream;
          videoRef.current.play().catch(() => {});
        }
      }, 200);
      return () => clearInterval(id);
    }, [socketId]);
    return (
      <div style={{ display: "inline-block", margin: 8 }}>
        <video ref={videoRef} autoPlay playsInline style={{ width: 240, height: 180, backgroundColor: "#000" }} />
        <div style={{ textAlign: "center" }}>{userName || socketId}</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      {!joined ? (
        <div>
          <h2>Join a Room (WebRTC)</h2>
          <input placeholder="Your name" value={userName} onChange={(e) => setUserName(e.target.value)} style={{ marginRight: 8 }} />
          <input placeholder="Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ marginRight: 8 }} />
          <button onClick={joinRoom}>Join</button>
          <div style={{ marginTop: 12, color: "gray" }}>{status}</div>
        </div>
      ) : (
        <div>
          <h3>Room: {roomId} — You: {userName}</h3>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
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
                      v.play()
                        .then(() => console.log("▶️ Manual play success"))
                        .catch((e) => {
                          console.error("⚠️ Manual play failed:", e);
                          alert("Play failed: " + e.message);
                        });
                    } else {
                        console.warn("No video element or stream available yet.");
            }
          }}
                >
  ▶️ Start Camera
                </button>

              </div>
            </div>

            <div>
              <div>Remote peers</div>
              <div>
                {remotePeers.length === 0 && (<div style={{ color: "gray" }}>No one else in the room</div>)}
                {remotePeers.map((p) => <RemoteVideo key={p.socketId} socketId={p.socketId} userName={p.userName} />)}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, color: "gray" }}>{status}</div>
        </div>
      )}
    </div>
  );
}

export default App;

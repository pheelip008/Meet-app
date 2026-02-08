import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import useWebRTC from "./hooks/useWebRTC";

function App() {
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");

  // Refs for video elements
  const localVideoRef = useRef();
  const screenVideoRef = useRef(); 
  const cameraPreviewRef = useRef(); 

  // Use Custom Hook
  const {
      joined,
      localStream,
      peers: remotePeers, // Map 'peers' to 'remotePeers' for UI compatibility
      isScreenSharing,
      isAudioEnabled,
      isVideoEnabled,
      status,
      joinRoom: hookJoinRoom,
      toggleMic,
      toggleCam,
      startScreenShare,
      stopScreenShare,
      screenStreamRef // Access ref specifically for local preview
  } = useWebRTC(roomId, userName);


  // --- UI Helpers ---

  const handleJoin = () => {
      if (!roomId || !userName) return alert("Enter Room ID and Name");
      hookJoinRoom();
  };

  // Attach Local Video
  useEffect(() => {
    if (localStream && localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(e => console.error("Local play error", e));
    }
  }, [localStream]);

  // Attach Screen Share Preview
  useEffect(() => {
     if (isScreenSharing && screenStreamRef.current && screenVideoRef.current) {
         screenVideoRef.current.srcObject = screenStreamRef.current;
         screenVideoRef.current.play().catch(e => console.error("Screen preview error", e));
     } else if (!isScreenSharing && screenVideoRef.current) {
         screenVideoRef.current.srcObject = null;
     }

     // Hide/Show camera preview when sharing
     if (cameraPreviewRef.current) {
         if (isScreenSharing && localStream) {
             cameraPreviewRef.current.style.display = "block";
             cameraPreviewRef.current.srcObject = localStream;
             cameraPreviewRef.current.muted = true;
             cameraPreviewRef.current.play().catch(()=>{});
         } else {
             cameraPreviewRef.current.style.display = "none";
         }
     }
  }, [isScreenSharing, localStream, screenStreamRef]);


  // Determine view mode
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

  if (!joined) {
    return (
      <div className="App join-container">
        <div className="stars"></div>
        <div className="stars2"></div>
        <div className="stars3"></div>
        <div className="join-card">
          <h2>Join Meeting</h2>
          <input
            placeholder="Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <input
            placeholder="Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <button className="primary" onClick={handleJoin}>
            Join Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
       <div className="stars"></div>
       <div className="stars2"></div>
       <div className="stars3"></div>

      {/* THEATER MODE LAYOUT */}
      {isTheaterMode ? (
        <div className="theater-container">
          {/* Main Stage (Screen Share) */}
          <div className="main-stage">
            <span className="stage-label">
              {isScreenSharing ? "You are presenting" : "Creating Magic..."}
            </span>
            
            {/* If I am sharing, show my preview */}
            <video
              ref={screenVideoRef}
              style={{
                display: isScreenSharing ? "block" : "none",
                maxWidth: "100%",
                maxHeight: "90%",
                borderRadius: 8,
                boxShadow: "0 0 20px rgba(0,0,0,0.5)"
              }}
              muted
              playsInline
            />

            {/* If someone else is sharing, show them */}
            {screenShareStream && !isScreenSharing && remotePeers.map(peer => {
                const s = peer.streams.find(st => st.type === "screen");
                if (!s) return null;
                return (
                    <video
                        key={s.id}
                        ref={el => {
                            if (el && el.srcObject !== s.mediaStream) {
                                el.srcObject = s.mediaStream;
                                el.play().catch(console.error);
                            }
                        }}
                        style={{ maxWidth: "100%", maxHeight: "90%", borderRadius: 8 }}
                        playsInline
                        autoPlay
                    />
                );
            })}
          </div>

          {/* Sidebar (Participants) */}
          <div className="reaction-sidebar">
             {/* My Camera Preview */}
             <div className="video-wrapper" style={{ height: "auto", minHeight: 120 }}>
                <video
                  ref={cameraPreviewRef}
                  style={{ width: "100%", borderRadius: 8, transform: "scaleX(-1)" }}
                  muted
                  playsInline
                />
                <span className="user-label">You</span>
             </div>

             {/* Remote Participants */}
             {remotePeers.map((peer) => (
                <RemoteVideo 
                    key={peer.socketId} 
                    {...peer} 
                    inSidebar={true} 
                />
             ))}

            {/* Controls in Sidebar */}
            <div className="controls-bar" style={{ flexDirection: "column", marginTop: "auto" }}>
               <button onClick={toggleMic} className={isAudioEnabled ? "btn-active" : "btn-inactive"}>
                 {isAudioEnabled ? "🎤 Mute" : "🎤 Unmute"}
               </button>
               <button onClick={toggleCam} className={isVideoEnabled ? "btn-active" : "btn-inactive"}>
                 {isVideoEnabled ? "📷 Stop Video" : "📷 Start Video"}
               </button>
               {isScreenSharing ? (
                 <button className="danger" onClick={stopScreenShare}>Stop Sharing</button>
               ) : (
                 <button className="primary" onClick={startScreenShare}>Share Screen</button>
               )}
            </div>
          </div>
        </div>
      ) : (
        /* GRID MODE LAYOUT */
        <div className="grid-container">
          <h3>Room: {roomId} | Status: {status}</h3>
          
          <div className="video-grid">
            {/* Local User */}
            <div className="video-wrapper">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={{ width: "320px", height: "240px", transform: "scaleX(-1)" }}
              />
              <div className="user-label">You</div>
            </div>

            {/* Remote Users */}
            {remotePeers.map((peer) => (
              <RemoteVideo key={peer.socketId} {...peer} inSidebar={false} />
            ))}
          </div>

          <div className="controls-bar">
            <button onClick={toggleMic} className={isAudioEnabled ? "btn-active" : "btn-inactive"}>
                 {isAudioEnabled ? "🎤 Mute" : "🎤 Unmute"}
            </button>
            <button onClick={toggleCam} className={isVideoEnabled ? "btn-active" : "btn-inactive"}>
                 {isVideoEnabled ? "📷 Stop Video" : "📷 Start Video"}
            </button>
            <button className="primary" onClick={startScreenShare}>
              Share Screen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

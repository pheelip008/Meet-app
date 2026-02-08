import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import useWebRTC from "./hooks/useWebRTC";


// Helper Component for robust video rendering
const VideoPlayer = ({ stream, isLocal = false, isScreen = false, style = {}, ...props }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) {
      el.srcObject = stream;
      if (isLocal && !isScreen) {
        el.muted = true; // Always mute local camera
      }
      // Force play
      el.play().catch(e => console.error("Video play error:", e));
    } else if (el) {
      el.srcObject = null;
    }
  }, [stream, isLocal, isScreen]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      style={style}
      {...props}
    />
  );
};

function App() {
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");






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
    screenStreamRef, // Access ref specifically for local preview
    socketRef, // Need socket for immediate checks
    remoteScreenShareUser // New state for layout sync
  } = useWebRTC(roomId, userName);


  // --- UI Helpers ---

  const handleJoin = () => {
    if (!roomId || !userName) return alert("Enter Room ID and Name");
    hookJoinRoom();
  };

  // Attached via VideoPlayer component now


  // Check for existing screen shares upon joining
  useEffect(() => {
    if (joined && socketRef.current) {
      socketRef.current.emit("check-screen-share");
    }
  }, [joined, socketRef]);


  // Screen Share Preview (Local)
  // Logic moved to rendering section using VideoPlayer

  // Camera Preview in Theater Mode (Side effect for existing ref still needed or refactor?)
  // We can refactor cameraPreview to use VideoPlayer too?
  // But cameraPreview is in the sidebar. We'll use VideoPlayer there.



  // Determine view mode
  const screenShareStream = remotePeers.flatMap(p => p.streams).find(s => s.type === "screen");

  // Theater Mode: Active IF I am sharing OR someone else is signaling they are sharing OR we possess a screen stream
  const isTheaterMode = isScreenSharing || !!remoteScreenShareUser || !!screenShareStream;


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
              <VideoPlayer
                stream={stream.mediaStream}
                isLocal={false}
                isScreen={stream.type === "screen"}
                style={{
                  width: inSidebar ? "100%" : "320px",
                  height: inSidebar ? "auto" : "240px",
                  border: stream.type === "screen" ? "2px solid #00f" : "none",
                  borderRadius: 8,
                  backgroundColor: "#000"
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
              {isScreenSharing
                ? "You are presenting"
                : (screenShareStream ? "Viewing Screen" : "Waiting for Screen Share...")}
            </span>

            {/* If I am sharing, show my preview */}
            {/* If I am sharing, show my preview */}
            {isScreenSharing && (
              <VideoPlayer
                stream={screenStreamRef.current}
                isLocal={true}
                isScreen={true}
                style={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: "90%",
                  borderRadius: 8,
                  boxShadow: "0 0 20px rgba(0,0,0,0.5)"
                }}
              />
            )}


            {/* If someone else is sharing, show them */}
            {remoteScreenShareUser && !isScreenSharing && (
              screenShareStream ? (
                <VideoPlayer
                  key={screenShareStream.id}
                  stream={screenShareStream.mediaStream}
                  isLocal={false}
                  isScreen={true}
                  style={{ maxWidth: "100%", maxHeight: "90%", borderRadius: 8 }}
                />

              ) : (
                /* LOADER / PLACEHOLDER WHEN SIGNAL RECEIVED BUT STREAM NOT YET ARRIVED */
                <div className="loading-screen">
                  <div className="spinner"></div>
                  <p>Syncing Screen Share...</p>
                </div>
              )
            )}

          </div>

          {/* Sidebar (Participants) */}
          <div className="reaction-sidebar">
            {/* My Camera Preview */}
            <div className="video-wrapper" style={{ height: "auto", minHeight: 120 }}>
              <VideoPlayer
                stream={localStream}
                isLocal={true}
                style={{ width: "100%", borderRadius: 8, transform: "scaleX(-1)" }}
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
              <VideoPlayer
                stream={localStream}
                isLocal={true}
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

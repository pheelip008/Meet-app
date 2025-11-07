import React, { useRef, useState } from "react";

export default function CameraTest() {
  const videoRef = useRef();
  const [error, setError] = useState(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false
      });
      console.log("✅ Stream:", stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch((e) => {
          console.warn("Autoplay blocked:", e);
        });
      }
    } catch (err) {
      console.error("🚫 Camera error:", err);
      setError(err.message);
    }
  };

  return (
    <div style={{ textAlign: "center", marginTop: 40 }}>
      <h2>Direct Camera Test (React)</h2>
      <video
        ref={videoRef}
        width="640"
        height="480"
        autoPlay
        playsInline
        style={{ background: "#000" }}
      />
      <br />
      <button onClick={startCamera}>Start Camera</button>
      {error && <p style={{ color: "red" }}>Error: {error}</p>}
    </div>
  );
}

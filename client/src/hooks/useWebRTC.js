import { useState, useEffect, useRef, useCallback } from "react";
import io from "socket.io-client";

const ICE_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
    ],
};

const SIGNALING_SERVER =
    process.env.NODE_ENV === "production"
        ? "https://meet-app-d2db.onrender.com"
        : "http://localhost:5000";

export default function useWebRTC(roomId, userName) {
    const [joined, setJoined] = useState(false);
    const [localStream, setLocalStream] = useState(null);
    const [peers, setPeers] = useState([]); // UI state: [{ socketId, userName, streams: [] }]
    const [msg, setMsg] = useState(""); // Status messages

    // Refs for logic (avoid re-renders)
    const socketRef = useRef(null);
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);

    // Peer Connections
    // standardPeers: socketId -> { pc, userName } (Camera/Mic)
    const standardPeers = useRef({});
    // screenPeers: socketId -> { pc } (Outgoing Screen Share)
    const screenPeers = useRef({});
    // incomingScreenPeers: socketId -> { pc } (Incoming Screen Share)
    const incomingScreenPeers = useRef({});

    // Feature Flags
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);

    // --- Helpers ---
    const log = (message) => {
        console.log(`[WebRTC] ${message}`);
        setMsg(message);
    };

    // --- Socket Initialization ---
    useEffect(() => {
        socketRef.current = io(SIGNALING_SERVER);

        const socket = socketRef.current;

        socket.on("connect", () => {
            log("Connected to Message Server");
        });

        socket.on("existing-users", (users) => {
            // Connect to all existing users
            users.forEach((user) => {
                createPeerConnection(user.socketId, user.userName, true, "camera");
            });
        });

        socket.on("user-joined", ({ socketId, userName }) => {
            log(`${userName} joined`);
            createPeerConnection(socketId, userName, false, "camera");

            // If WE are sharing screen, we must also initiate a screen connection to them
            if (screenStreamRef.current) {
                log(`Sharing screen to new user ${userName}`);
                createPeerConnection(socketId, userName, true, "screen");
            }
        });

        socket.on("offer", async ({ from, sdp, isScreen, userName }) => {
            const type = isScreen ? "screen" : "camera";
            log(`Received ${type} Offer from ${userName || from}`);

            // If it's a screen offer, it's INCOMING. 
            // We treat it as a new "connection" but linked to the same user.
            // We use a separate PC for it.

            await handleOffer(from, sdp, type, userName);
        });

        socket.on("answer", async ({ from, sdp, isScreen }) => {
            const type = isScreen ? "screen" : "camera";
            log(`Received ${type} Answer from ${from}`);
            await handleAnswer(from, sdp, type);
        });

        socket.on("ice-candidate", async ({ from, candidate, isScreen }) => {
            const type = isScreen ? "screen" : "camera";
            await handleIceCandidate(from, candidate, type);
        });

        socket.on("user-left", ({ socketId }) => {
            removePeer(socketId);
        });

        socket.on("user-stopped-screen", ({ socketId }) => {
            log(`User ${socketId} stopped screen share`);
            removeScreenPeer(socketId, "incoming");
        });

        return () => {
            socket.disconnect();
        };
    }, []); // Run once

    // --- Room Logic ---
    const joinRoom = () => {
        if (!roomId || !userName) return alert("Enter Room ID and Name");
        socketRef.current.emit("join-room", roomId, userName);
        getMedia(); // Start camera
        setJoined(true);
    };

    // --- Media Logic ---
    const getMedia = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localStreamRef.current = stream;
            setLocalStream(stream); // Trigger UI render
        } catch (err) {
            console.error("Failed to get media", err);
        }
    };

    const toggleMic = () => {
        if (localStreamRef.current) {
            const track = localStreamRef.current.getAudioTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                setIsAudioEnabled(track.enabled);
            }
        }
    };

    const toggleCam = () => {
        if (localStreamRef.current) {
            const track = localStreamRef.current.getVideoTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                setIsVideoEnabled(track.enabled);
            }
        }
    };

    const startScreenShare = async () => {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            screenStreamRef.current = stream;
            setIsScreenSharing(true);

            // Listen for "Stop Sharing" via browser UI
            stream.getVideoTracks()[0].onended = stopScreenShare;

            // Iterate over all known standard peers and initiate a screen connection
            Object.keys(standardPeers.current).forEach(targetId => {
                const userName = standardPeers.current[targetId].userName;
                createPeerConnection(targetId, userName, true, "screen");
            });

        } catch (err) {
            console.error("Screen Share failed", err);
        }
    };

    const stopScreenShare = () => {
        if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;
        }

        // Close all Outgoing Screen PCs
        Object.keys(screenPeers.current).forEach(key => {
            screenPeers.current[key].pc.close();
        });
        screenPeers.current = {};

        setIsScreenSharing(false);
        socketRef.current.emit("stop-screen-share");
    };


    // --- WebRTC Core ---

    // type = 'camera' | 'screen' (Outgoing) | 'incoming_screen' (Incoming)
    // Actually, for createPeerConnection, we only initiate 'camera' or 'screen' (Outgoing).
    // Incoming 'screen' is created via handleOffer.
    const createPeerConnection = async (targetId, targetUserName, initiateOffer, type) => {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        const isScreen = type === "screen";

        // Add Tracks (Local Stream)
        const stream = isScreen ? screenStreamRef.current : localStreamRef.current;
        if (stream) {
            stream.getTracks().forEach(track => pc.addTrack(track, stream));
        }

        // Handlers
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socketRef.current.emit("ice-candidate", {
                    targetSocketId: targetId,
                    candidate: e.candidate,
                    isScreen // Flag tells receiver which PC to use
                });
            }
        };

        pc.ontrack = (e) => {
            handleTrackEvent(e, targetId, targetUserName, type);
        };

        pc.onconnectionstatechange = () => {
            console.log(`PC State ${targetId} (${type}): ${pc.connectionState}`);
            if (pc.connectionState === 'failed') restartIce(pc);
        };

        // Store PC
        if (type === "camera") {
            standardPeers.current[targetId] = { pc, userName: targetUserName };
            // Initialize UI entry if needed
            addPeerToUI(targetId, targetUserName);
        } else if (type === "screen") {
            screenPeers.current[targetId] = { pc };
        }

        // Offer?
        if (initiateOffer) {
            try {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                socketRef.current.emit("offer", {
                    targetSocketId: targetId,
                    sdp: pc.localDescription,
                    isScreen,
                    userName // Send my name so they know who offered
                });
            } catch (err) {
                console.error("Offer Error", err);
            }
        }

        return pc;
    };

    const handleOffer = async (fromId, sdp, type, fromUserName) => {
        const isScreen = type === "screen";

        // If it's a screen offer, we store it in incomingScreenPeers
        let pc;

        if (isScreen) {
            // Check if we already have one (renegotiation?)
            const entry = incomingScreenPeers.current[fromId];
            if (entry) {
                pc = entry.pc;
            } else {
                // Create new PC for incoming screen
                pc = new RTCPeerConnection(ICE_CONFIG);
                pc.onicecandidate = (e) => {
                    if (e.candidate) {
                        socketRef.current.emit("ice-candidate", {
                            targetSocketId: fromId,
                            candidate: e.candidate,
                            isScreen: true // Echo back flag
                        });
                    }
                };
                pc.ontrack = (e) => handleTrackEvent(e, fromId, fromUserName, "incoming_screen");

                incomingScreenPeers.current[fromId] = { pc };
            }
        } else {
            // Camera
            if (!standardPeers.current[fromId]) {
                // Creating passive receiver for camera
                await createPeerConnection(fromId, fromUserName, false, "camera");
            }
            pc = standardPeers.current[fromId].pc;
        }

        if (pc.signalingState !== "stable" && pc.signalingState !== "have-remote-offer") {
            // Rollback or ignore? implicit rollback usually works by setting new remote
            // But avoid glare. simplified: assume strictly polite or just proceed.
        }

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socketRef.current.emit("answer", {
            targetSocketId: fromId,
            sdp: pc.localDescription,
            isScreen // Echo flag
        });
    };

    const handleAnswer = async (fromId, sdp, type) => {
        let pc;
        if (type === "screen") {
            pc = screenPeers.current[fromId]?.pc;
        } else {
            pc = standardPeers.current[fromId]?.pc;
        }

        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
    };

    const handleIceCandidate = async (fromId, candidate, type) => {
        let pc;
        if (type === "screen") {
            // Could be outgoing or incoming? 
            // If I am sharing, I receive candidate from viewer -> 'screenPeers'
            // If I am viewing, I receive candidate from sharer -> 'incomingScreenPeers'
            // Try both? No, use existence check.

            if (screenPeers.current[fromId]) {
                pc = screenPeers.current[fromId].pc;
            } else if (incomingScreenPeers.current[fromId]) {
                pc = incomingScreenPeers.current[fromId].pc;
            }
        } else {
            pc = standardPeers.current[fromId]?.pc;
        }

        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    };

    const handleTrackEvent = (e, peerId, peerName, type) => {
        const stream = e.streams[0];
        const streamType = (type === "screen" || type === "incoming_screen") ? "screen" : "camera";

        log(`Track received from ${peerId} (${streamType})`);

        setPeers(prev => {
            const existing = prev.find(p => p.socketId === peerId);
            const newStreamEntry = { id: stream.id, mediaStream: stream, type: streamType };

            if (existing) {
                // Avoid duplicate streams
                if (existing.streams.some(s => s.id === stream.id)) return prev;

                return prev.map(p => p.socketId === peerId ? { ...p, streams: [...p.streams, newStreamEntry] } : p);
            } else {
                // Should not happen for camera (created in createPeerConnection), but might for screen
                return [...prev, { socketId: peerId, userName: peerName, streams: [newStreamEntry] }];
            }
        });
    };

    const removePeer = (socketId) => {
        // Cleanup Camera
        if (standardPeers.current[socketId]) {
            standardPeers.current[socketId].pc.close();
            delete standardPeers.current[socketId];
        }
        removeScreenPeer(socketId);

        // UI Update
        setPeers(prev => prev.filter(p => p.socketId !== socketId));
    };

    const removeScreenPeer = (socketId, direction = "both") => {
        // Cleanup Incoming Screen
        if (incomingScreenPeers.current[socketId]) {
            incomingScreenPeers.current[socketId].pc.close();
            delete incomingScreenPeers.current[socketId];
        }

        // Cleanup Outgoing (if they left)
        if (screenPeers.current[socketId]) {
            screenPeers.current[socketId].pc.close();
            delete screenPeers.current[socketId];
        }

        // UI: Remove only screen streams for this user
        setPeers(prev => prev.map(p => {
            if (p.socketId === socketId) {
                return { ...p, streams: p.streams.filter(s => s.type !== "screen") };
            }
            return p;
        }));
    };

    const addPeerToUI = (socketId, userName) => {
        setPeers(prev => {
            if (prev.find(p => p.socketId === socketId)) return prev;
            return [...prev, { socketId, userName, streams: [] }];
        });
    };

    const restartIce = (pc) => {
        if (pc.restartIce) pc.restartIce();
    }

    return {
        // State
        localStream,
        peers,
        joined,
        isScreenSharing,
        isAudioEnabled,
        isVideoEnabled,
        status: msg,

        // Actions
        joinRoom,
        toggleMic,
        toggleCam,
        startScreenShare,
        stopScreenShare,

        // Refs (if needed for UI attachment, though streams are better)
        localStreamRef,
        screenStreamRef
    };
}

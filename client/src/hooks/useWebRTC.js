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
    const standardPeers = useRef({});
    const screenPeers = useRef({});
    const incomingScreenPeers = useRef({});

    const [remoteScreenShareUser, setRemoteScreenShareUser] = useState(null); // socketId of presenter

    // Feature Flags
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [isAudioEnabled, setIsAudioEnabled] = useState(true);
    const [isVideoEnabled, setIsVideoEnabled] = useState(true);

    // --- Helpers (useCallback for dependencies) ---

    const log = useCallback((message) => {
        console.log(`[WebRTC] ${message}`);
        setMsg(message);
    }, []);

    const restartIce = useCallback((pc) => {
        if (pc.restartIce) pc.restartIce();
    }, []);

    const addPeerToUI = useCallback((socketId, userName) => {
        setPeers(prev => {
            if (prev.find(p => p.socketId === socketId)) return prev;
            return [...prev, { socketId, userName, streams: [] }];
        });
    }, []);

    const removeScreenPeer = useCallback((socketId, direction = "both") => {
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

        // If this user was the active presenter, clear state
        setRemoteScreenShareUser(prev => prev === socketId ? null : prev);

    }, []);

    const removePeer = useCallback((socketId) => {
        // Cleanup Camera
        if (standardPeers.current[socketId]) {
            standardPeers.current[socketId].pc.close();
            delete standardPeers.current[socketId];
        }
        removeScreenPeer(socketId);

        // UI Update
        setPeers(prev => prev.filter(p => p.socketId !== socketId));
    }, [removeScreenPeer]);

    const handleTrackEvent = useCallback((e, peerId, peerName, type) => {
        const stream = e.streams[0];
        const streamType = (type === "screen" || type === "incoming_screen") ? "screen" : "camera";

        console.log(`🎵 Track received from ${peerId} (${streamType})`);
        console.log(`   Stream ID: ${stream.id}, tracks: ${stream.getTracks().length}`);
        stream.getTracks().forEach(track => {
            console.log(`     - ${track.kind}: ${track.id}, enabled: ${track.enabled}`);
        });

        setPeers(prev => {
            const existing = prev.find(p => p.socketId === peerId);
            const newStreamEntry = { id: stream.id, mediaStream: stream, type: streamType };

            if (existing) {
                // Avoid duplicate streams
                if (existing.streams.some(s => s.id === stream.id)) {
                    console.log(`   ⚠️ Stream ${stream.id} already exists for peer ${peerId}, skipping`);
                    return prev;
                }

                console.log(`   ✅ Adding stream to existing peer ${peerId}, total streams will be: ${existing.streams.length + 1}`);
                return prev.map(p => p.socketId === peerId ? { ...p, streams: [...p.streams, newStreamEntry] } : p);
            } else {
                console.log(`   ✅ Creating new peer entry for ${peerId} with this stream`);
                return [...prev, { socketId: peerId, userName: peerName, streams: [newStreamEntry] }];
            }
        });
    }, [log]);

    // ICE Candidate Queue (Fix for Race Condition)
    // Structure: { [peerId_type]: [candidates] }
    const iceCandidateQueue = useRef({});

    const createPeerConnection = useCallback(async (targetId, targetUserName, initiateOffer, type) => {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        const isScreen = type === "screen";


        // Add Tracks (Local Stream)
        const stream = isScreen ? screenStreamRef.current : localStreamRef.current;
        if (stream) {
            console.log(`Adding ${stream.getTracks().length} tracks to PC for ${targetId} (${type})`);
            stream.getTracks().forEach(track => {
                console.log(`  - Adding ${track.kind} track: ${track.id}, enabled: ${track.enabled}`);
                pc.addTrack(track, stream);
            });
        } else {
            console.warn(`No ${type} stream available when creating PC for ${targetId}`);
        }

        // Handlers - Set up AFTER adding tracks
        pc.onicecandidate = (e) => {
            if (e.candidate && socketRef.current) {
                console.log(`🧊 ICE candidate for ${targetId} (${type}): ${e.candidate.candidate.substring(0, 50)}...`);
                socketRef.current.emit("ice-candidate", {
                    targetSocketId: targetId,
                    candidate: e.candidate,
                    isScreen // Flag tells receiver which PC to use
                });
            } else if (!e.candidate) {
                console.log(`🧊 ICE gathering complete for ${targetId} (${type})`);
            }
        };

        pc.ontrack = (e) => {
            console.log(`🎵 ontrack fired for ${targetId} (${type})`);
            handleTrackEvent(e, targetId, targetUserName, type);
        };

        pc.onconnectionstatechange = () => {
            console.log(`🔌 PC Connection State ${targetId} (${type}): ${pc.connectionState}`);
            if (pc.connectionState === 'failed') {
                console.error(`❌ Connection failed for ${targetId} (${type})`);
                restartIce(pc);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE Connection State ${targetId} (${type}): ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed') {
                console.error(`❌ ICE connection failed for ${targetId} (${type})`);
            }
        };

        // Store PC
        if (type === "camera") {
            standardPeers.current[targetId] = { pc, userName: targetUserName };
            addPeerToUI(targetId, targetUserName);
        } else if (type === "screen") {
            screenPeers.current[targetId] = { pc };
        }

        // Drain ICE Queue if any exist
        // MODIFICATION: Moved to handleOffer/handleAnswer to avoid race condition
        // where we add candidates before remote description is set.


        // Offer?
        if (initiateOffer && socketRef.current) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                console.log(`Sending ${type} offer to ${targetId}`);
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
    }, [handleTrackEvent, restartIce, addPeerToUI, userName]);

    const handleOffer = useCallback(async (fromId, sdp, type, fromUserName) => {
        const isScreen = type === "screen";

        console.log(`📥 handleOffer: type=${type}, from=${fromUserName || fromId}`);

        let pc;

        if (isScreen) {
            const entry = incomingScreenPeers.current[fromId];
            if (entry) {
                pc = entry.pc;
            } else {
                pc = new RTCPeerConnection(ICE_CONFIG);
                pc.onicecandidate = (e) => {
                    if (e.candidate && socketRef.current) {
                        socketRef.current.emit("ice-candidate", {
                            targetSocketId: fromId,
                            candidate: e.candidate,
                            isScreen: true
                        });
                    }
                };
                pc.ontrack = (e) => handleTrackEvent(e, fromId, fromUserName, "incoming_screen");

                incomingScreenPeers.current[fromId] = { pc };

                // Drain Queue MOVED to after setRemoteDescription

            }
        } else {
            // Camera offer
            console.log(`📹 Camera offer from ${fromUserName}, checking if peer exists...`);
            if (!standardPeers.current[fromId]) {
                console.log(`Creating new camera peer for ${fromId}`);
                await createPeerConnection(fromId, fromUserName, false, "camera");
            } else {
                console.log(`Camera peer already exists for ${fromId}`);
            }
            pc = standardPeers.current[fromId]?.pc;

            if (pc) {
                const senders = pc.getSenders();
                console.log(`Camera PC for ${fromId}:`);
                console.log(`  - Senders: ${senders.length}`);
                console.log(`  - Signaling state: ${pc.signalingState}`);
                console.log(`  - Connection state: ${pc.connectionState}`);
                console.log(`  - ICE connection state: ${pc.iceConnectionState}`);
                console.log(`  - ontrack handler: ${pc.ontrack ? 'SET' : 'NOT SET'}`);
            }
        }

        if (!pc) {
            console.error(`❌ No peer connection found for ${fromId} (${type})`);
            return; // Safety
        }

        // Handle glare condition (both sides sending offers simultaneously)
        const isStable = pc.signalingState === "stable";
        const isSettingRemoteOffer = sdp.type === "offer";

        if (!isStable && isSettingRemoteOffer) {
            console.warn(`⚠️ Glare condition detected for ${fromId} (${type})`);
            console.warn(`   Current signaling state: ${pc.signalingState}`);
            console.warn(`   Rolling back to handle incoming offer...`);

            // Rollback the pending local offer
            await pc.setLocalDescription({ type: "rollback" });
            console.log(`   ✅ Rolled back to stable state`);
        }

        console.log(`Setting remote description for ${fromId} (${type})`);
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log(`   Remote description set, new signaling state: ${pc.signalingState}`);

        // DRAIN ICE QUEUE NOW
        const queueKey = `${fromId}_${type === "screen" ? "screen" : "camera"}`; // or just use type since we know it
        // actually for incoming screen it might be under 'screen' or 'incoming_screen'?
        // The queue key was generated in handleIceCandidate as `${fromId}_${type}`.
        // In handleOffer, type is passed as 'screen' or 'camera'. 
        // Note: For incoming screen offer, we stored it as `${fromId}_screen` in handleIceCandidate?
        // Let's check handleIceCandidate... it uses `${fromId}_${type}`.
        // And handleOffer call passes `type` as 'screen' or 'camera'.
        // So `${fromId}_${type}` is correct.

        if (iceCandidateQueue.current[queueKey]) {
            console.log(`Draining ICE queue for ${queueKey}`);
            iceCandidateQueue.current[queueKey].forEach(async c => {
                try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn("ICE Drain Error", e); }
            });
            delete iceCandidateQueue.current[queueKey];
        }

        console.log(`Creating answer for ${fromId} (${type})`);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (socketRef.current) {
            console.log(`📤 Sending answer to ${fromId} (${type})`);
            socketRef.current.emit("answer", {
                targetSocketId: fromId,
                sdp: pc.localDescription,
                isScreen
            });
        }
    }, [createPeerConnection, handleTrackEvent]);

    const handleAnswer = useCallback(async (fromId, sdp, type) => {
        let pc;
        if (type === "screen") {
            pc = screenPeers.current[fromId]?.pc;
        } else {
            pc = standardPeers.current[fromId]?.pc;
        }

        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));

            // DRAIN ICE QUEUE NOW
            const queueKey = `${fromId}_${type}`;
            if (iceCandidateQueue.current[queueKey]) {
                console.log(`Draining ICE queue for ${queueKey}`);
                iceCandidateQueue.current[queueKey].forEach(async c => {
                    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn("ICE Drain Error", e); }
                });
                delete iceCandidateQueue.current[queueKey];
            }

        }
    }, []);

    const handleIceCandidate = useCallback(async (fromId, candidate, type) => {
        let pc;
        let queueKey = `${fromId}_${type}`; // "screen" or "camera"

        if (type === "screen") {
            // Check outgoing first? No, incoming candidates are for our outgoing PC?
            // Wait. We receive candidate FROM remote.
            // If I am sharer: I receive candidate for my `screenPeers` PC.
            // If I am viewer: I receive candidate for my `incomingScreenPeers` PC.

            // How do we know which one?
            // Logic: Do we have an outgoing screen peer for this ID?
            if (screenPeers.current[fromId]) {
                pc = screenPeers.current[fromId].pc;
            } else if (incomingScreenPeers.current[fromId]) {
                pc = incomingScreenPeers.current[fromId].pc;
            }
        } else {
            pc = standardPeers.current[fromId]?.pc;
        }

        if (pc && pc.remoteDescription) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn("ICE Add Failed", err);
            }
        } else {
            console.log(`Queueing ICE candidate for ${queueKey} (PC Not Ready)`);
            if (!iceCandidateQueue.current[queueKey]) iceCandidateQueue.current[queueKey] = [];
            iceCandidateQueue.current[queueKey].push(candidate);
        }
    }, []);

    // --- Socket Initialization ---
    useEffect(() => {
        socketRef.current = io(SIGNALING_SERVER);

        const socket = socketRef.current;

        socket.on("connect", () => {
            log("Connected to Message Server");
        });

        socket.on("existing-users", (users) => {
            console.log(`📋 Received existing-users: ${users.length} users`);
            users.forEach((user) => {
                console.log(`  - Creating camera connection to: ${user.userName} (${user.socketId})`);
                createPeerConnection(user.socketId, user.userName, true, "camera");
            });
        });

        socket.on("user-joined", ({ socketId, userName }) => {
            console.log(`👤 User joined: ${userName} (${socketId})`);
            log(`${userName} joined`);
            console.log(`  - Creating camera connection (we are answerer)`);
            createPeerConnection(socketId, userName, false, "camera");

            if (screenStreamRef.current) {
                log(`Sharing screen to new user ${userName}`);
                console.log(`  - Also creating screen connection (we are offerer)`);
                createPeerConnection(socketId, userName, true, "screen");
            }
        });

        socket.on("offer", async ({ from, sdp, isScreen, userName }) => {
            const type = isScreen ? "screen" : "camera";
            log(`Received ${type} Offer from ${userName || from}`);
            await handleOffer(from, sdp, type, userName);
        });

        socket.on("answer", async ({ from, sdp, isScreen }) => {
            const type = isScreen ? "screen" : "camera";
            log(`Received ${type} Answer from ${from}`);
            await handleAnswer(from, sdp, type);
        });

        socket.on("ice-candidate", async ({ from, candidate, isScreen }) => {
            const type = isScreen ? "screen" : "camera";
            console.log(`📨 Received ICE candidate from ${from} (${type})`);
            await handleIceCandidate(from, candidate, type);
        });

        socket.on("user-left", ({ socketId }) => {
            removePeer(socketId);
        });

        socket.on("user-stopped-screen", ({ socketId }) => {
            log(`User ${socketId} stopped screen share`);
            removeScreenPeer(socketId, "incoming");
        });

        // --- Explicit Layout Signals ---
        socket.on("user-started-screen", ({ socketId, userName }) => {
            log(`User ${userName || socketId} started screen share`);
            setRemoteScreenShareUser(socketId);
        });

        return () => {
            socket.disconnect();
        };
    }, [
        log,
        createPeerConnection,
        handleOffer,
        handleAnswer,
        handleIceCandidate,
        removePeer,
        removeScreenPeer
    ]);

    // --- Renegotiate existing peers when local stream becomes available ---
    // This fixes the race condition where peer connections were created before media was ready
    useEffect(() => {
        if (!localStream || !joined) return;

        console.log("Local stream ready, checking existing peers...");
        console.log(`Current peer count: ${Object.keys(standardPeers.current).length}`);

        // For each existing peer connection without tracks, add them now
        Object.entries(standardPeers.current).forEach(([peerId, peerData]) => {
            const pc = peerData.pc;
            const senders = pc.getSenders();

            console.log(`Peer ${peerId}: ${senders.length} senders, signaling state: ${pc.signalingState}`);

            // Check if we have any senders (tracks)
            // Only renegotiate if we have NO senders AND the connection is stable
            if (senders.length === 0 && localStreamRef.current && pc.signalingState === 'stable') {
                console.log(`⚠️ Adding tracks to existing peer ${peerId} (renegotiation)`);
                localStreamRef.current.getTracks().forEach(track => {
                    console.log(`  - Adding ${track.kind} track via renegotiation`);
                    pc.addTrack(track, localStreamRef.current);
                });

                // Create new offer with the tracks
                pc.createOffer().then(offer => {
                    return pc.setLocalDescription(offer);
                }).then(() => {
                    if (socketRef.current) {
                        console.log(`Sending renegotiation offer to ${peerId}`);
                        socketRef.current.emit("offer", {
                            targetSocketId: peerId,
                            sdp: pc.localDescription,
                            isScreen: false,
                            userName
                        });
                    }
                }).catch(err => console.error("Renegotiation error:", err));
            } else if (senders.length > 0) {
                console.log(`✅ Peer ${peerId} already has tracks, skipping renegotiation`);
            }
        });
    }, [localStream, joined, userName]);

    // --- Actions ---

    const getMedia = useCallback(async () => {
        try {
            console.log("🎥 Requesting user media (camera + microphone)...");
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            console.log(`✅ Media acquired! Stream ID: ${stream.id}`);
            console.log(`   Tracks: ${stream.getTracks().length}`);
            stream.getTracks().forEach(track => {
                console.log(`   - ${track.kind}: ${track.id}, enabled: ${track.enabled}, readyState: ${track.readyState}`);
            });

            localStreamRef.current = stream;
            setLocalStream(stream);
            console.log("📹 Local stream set in state and ref");
        } catch (err) {
            console.error("❌ Failed to get media:", err);

            let errorMessage = "Failed to access camera/microphone: " + err.message;

            if (err.name === "NotReadableError") {
                errorMessage = "⚠️ Camera/Microphone is already in use!\n\n" +
                    "Please:\n" +
                    "1. Close other apps using the camera (Zoom, Teams, Skype, etc.)\n" +
                    "2. Close other browser tabs using the camera\n" +
                    "3. Refresh this page and try again";
            } else if (err.name === "NotAllowedError") {
                errorMessage = "⚠️ Camera/Microphone permission denied!\n\n" +
                    "Please allow camera and microphone access in your browser settings.";
            } else if (err.name === "NotFoundError") {
                errorMessage = "⚠️ No camera or microphone found!\n\n" +
                    "Please connect a camera and microphone to your device.";
            }

            alert(errorMessage);
        }
    }, []);

    const joinRoom = useCallback(async () => {
        if (!roomId || !userName) return alert("Enter Room ID and Name");
        await getMedia(); // Wait for media first
        socketRef.current.emit("join-room", roomId, userName);
        setJoined(true);
    }, [roomId, userName, getMedia]);

    const toggleMic = useCallback(() => {
        if (localStreamRef.current) {
            const track = localStreamRef.current.getAudioTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                setIsAudioEnabled(track.enabled);
            }
        }
    }, []);

    const toggleCam = useCallback(() => {
        if (localStreamRef.current) {
            const track = localStreamRef.current.getVideoTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                setIsVideoEnabled(track.enabled);
            }
        }
    }, []);

    const stopScreenShare = useCallback(() => {
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
        if (socketRef.current) {
            socketRef.current.emit("stop-screen-share");
            // Also emit event for server to broadcast cleanup
            socketRef.current.emit("disconnect-screen");
        }
    }, []);

    const startScreenShare = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always",
                    displaySurface: "monitor"
                }
            });

            console.log(`Screen stream obtained: ${stream.id}, tracks: ${stream.getTracks().length}`);
            stream.getTracks().forEach(track => {
                console.log(`  - ${track.kind} track: ${track.id}, enabled: ${track.enabled}`);
            });

            screenStreamRef.current = stream;
            setIsScreenSharing(true);

            // Explicit Signal to server
            if (socketRef.current) socketRef.current.emit("screen-share-started");

            stream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };

            // Create screen peer connections for all existing peers
            const peerIds = Object.keys(standardPeers.current);
            console.log(`Creating screen share connections for ${peerIds.length} peers`);

            for (const targetId of peerIds) {
                const userName = standardPeers.current[targetId].userName;
                await createPeerConnection(targetId, userName, true, "screen");
            }

        } catch (err) {
            console.error("Screen Share failed", err);
            alert("Screen sharing failed: " + err.message);
        }
    }, [createPeerConnection, stopScreenShare]);

    return {
        localStream,
        peers,
        joined,
        isScreenSharing,
        remoteScreenShareUser, // Expose this
        isAudioEnabled,
        isVideoEnabled,
        status: msg,
        joinRoom,
        toggleMic,
        toggleCam,
        startScreenShare,
        stopScreenShare,
        localStreamRef,
        screenStreamRef,
        socketRef // Exposed for App.js to use
    };
}

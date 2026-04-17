"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpellId } from "@/utils/spellRegistry";
import {
  createThrottle,
  decodePeerMessage,
  encodePeerMessage,
  type MotionDataEvent,
  type PeerEvent,
  type Role,
} from "@/utils/networkManager";
import {
  deriveConnectionState,
  type ConnectionState,
} from "@/utils/connectionState";
import { LatencyTracker, getLatencyQuality } from "@/utils/latencyTracker";


type SignalEvent = {
  id: number;
  type: string;
  from: Role;
  to: Role | "all";
  payload: unknown;
  at: number;
};

type PollResponse = {
  hostPresent: boolean;
  guestPresent: boolean;
  nextCursor: number;
  events: SignalEvent[];
};

type UseDuelWebRTCOptions = {
  roomId: string;
  role: Role;
  enabled: boolean;
  localStream?: MediaStream | null;
  onPeerCast: (spellId: SpellId, confidence?: number) => void;
  onPeerRestart?: () => void;
  onPeerStateSync?: (state: unknown) => void;
  onPeerMotion?: (motion: MotionDataEvent) => void;
};

type PeerStatus = "idle" | "waiting" | "connecting" | "connected" | "failed";

type SignalPollingError = Error & {
  code?: "ROOM_NOT_FOUND" | "HTTP_ERROR";
};

const HOGWARTS_DUEL_NAMES = [
  "Harry Potter",
  "Hermione Granger",
  "Ron Weasley",
  "Ginny Weasley",
  "Luna Lovegood",
  "Neville Longbottom",
  "Draco Malfoy",
  "Cedric Diggory",
  "Sirius Black",
  "Remus Lupin",
  "Minerva McGonagall",
  "Severus Snape",
  "Nymphadora Tonks",
  "Kingsley Shacklebolt",
  "Fleur Delacour",
  "Viktor Krum",
];

const hashRoomId = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const getDuelAliases = (roomId: string, role: Role) => {
  const safeRoom = roomId || "wizards";
  const hash = hashRoomId(safeRoom);
  const firstIndex = hash % HOGWARTS_DUEL_NAMES.length;
  const secondIndex = (firstIndex + 1 + (hash % (HOGWARTS_DUEL_NAMES.length - 1))) % HOGWARTS_DUEL_NAMES.length;

  const hostAlias = HOGWARTS_DUEL_NAMES[firstIndex];
  const guestAlias = HOGWARTS_DUEL_NAMES[secondIndex];

  return role === "host"
    ? { localAlias: hostAlias, remoteAlias: guestAlias }
    : { localAlias: guestAlias, remoteAlias: hostAlias };
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const SIGNAL_POLL_MS = 350;
const PING_INTERVAL_MS = 2500;
const MOTION_SEND_INTERVAL_MS = 66; // ~15 updates/s
const STATE_SYNC_INTERVAL_MS = 75;

export const useDuelWebRTC = ({
  roomId,
  role,
  enabled,
  onPeerCast,
  onPeerRestart,
  onPeerStateSync,
  onPeerMotion,
}: UseDuelWebRTCOptions) => {
  const [status, setStatus] = useState<PeerStatus>(enabled ? "waiting" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [hostPresent, setHostPresent] = useState(false);
  const [guestPresent, setGuestPresent] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [inGame, setInGame] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    enabled ? "CONNECTING" : "DISCONNECTED",
  );

  const cursorRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const processingOfferRef = useRef(false);
  const processingAnswerRef = useRef(false);
  const offerSentRef = useRef(false);
  const signalingFailureCountRef = useRef(0);
  const roomUnavailableRef = useRef(false);
  const statusRef = useRef<PeerStatus>(enabled ? "waiting" : "idle");
  const onPeerCastRef = useRef(onPeerCast);
  const onPeerRestartRef = useRef(onPeerRestart);
  const onPeerStateSyncRef = useRef(onPeerStateSync);
  const onPeerMotionRef = useRef(onPeerMotion);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const hasPeerTransportRef = useRef(false);
  const localReadyRef = useRef(false);
  const remoteReadyRef = useRef(false);
  const inGameRef = useRef(false);
  const latencyTrackerRef = useRef(new LatencyTracker());
  const throttleMotionRef = useRef(createThrottle(MOTION_SEND_INTERVAL_MS));
  const throttleStateSyncRef = useRef(createThrottle(STATE_SYNC_INTERVAL_MS));

  const { localAlias, remoteAlias } = useMemo(
    () => getDuelAliases(roomId, role),
    [roomId, role],
  );

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    const origin = window.location.origin;
    return `${origin}/duel/${roomId}?role=guest`;
  }, [roomId]);

  const updateConnectionState = useCallback(() => {
    setConnectionState(
      deriveConnectionState({
        enabled,
        hasPeerTransport: hasPeerTransportRef.current,
        localReady: localReadyRef.current,
        remoteReady: remoteReadyRef.current,
        inGame: inGameRef.current,
      }),
    );
  }, [enabled]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    onPeerCastRef.current = onPeerCast;
  }, [onPeerCast]);

  useEffect(() => {
    onPeerRestartRef.current = onPeerRestart;
  }, [onPeerRestart]);

  useEffect(() => {
    onPeerStateSyncRef.current = onPeerStateSync;
  }, [onPeerStateSync]);

  useEffect(() => {
    onPeerMotionRef.current = onPeerMotion;
  }, [onPeerMotion]);

  const postSignal = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch("/api/webrtc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `Signaling request failed (${response.status}).`);
      }
      return response.json();
    },
    [],
  );

  const markPresence = useCallback(
    async (present: boolean) => {
      if (!enabled) return;
      await postSignal({
        action: "presence",
        roomId,
        role,
        present,
      });
    },
    [enabled, postSignal, role, roomId],
  );

  const closePeer = useCallback(() => {
    if (channelRef.current) {
      channelRef.current.close();
      channelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    hasPeerTransportRef.current = false;
    pendingIceCandidatesRef.current = [];
  }, []);

  const flushPendingIceCandidates = useCallback(async (pc: RTCPeerConnection): Promise<void> => {
    if (!pc.remoteDescription || pendingIceCandidatesRef.current.length === 0) {
      return;
    }

    const queued = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore stale/bad candidates.
      }
    }
  }, []);

  const sendPeerEvent = useCallback((event: PeerEvent): boolean => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") {
      return false;
    }

    channel.send(encodePeerMessage(role, event));
    return true;
  }, [role]);

  const applyTransportReady = useCallback(() => {
    hasPeerTransportRef.current = true;
    setStatus("connected");
    setError(null);
    signalingFailureCountRef.current = 0;
    updateConnectionState();
  }, [updateConnectionState]);

  const handlePeerMessage = useCallback((raw: string) => {
    const parsed = decodePeerMessage(raw);
    if (!parsed) {
      return;
    }

    const { payload } = parsed;

    if (payload.type === "SPELL_CAST") {
      onPeerCastRef.current(payload.spellId, payload.confidence);
      return;
    }

    if (payload.type === "RESTART") {
      inGameRef.current = false;
      setInGame(false);
      onPeerRestartRef.current?.();
      updateConnectionState();
      return;
    }

    if (payload.type === "STATE_SYNC") {
      onPeerStateSyncRef.current?.(payload.state);
      return;
    }

    if (payload.type === "READY") {
      remoteReadyRef.current = true;
      setRemoteReady(true);
      updateConnectionState();
      return;
    }

    if (payload.type === "PING") {
      void sendPeerEvent({ type: "PONG", timestamp: payload.timestamp });
      return;
    }

    if (payload.type === "PONG") {
      const nextLatency = latencyTrackerRef.current.consumePong(payload.timestamp);
      if (nextLatency !== null) {
        setLatencyMs(nextLatency);
      }
      return;
    }

    if (payload.type === "MOTION_DATA") {
      onPeerMotionRef.current?.(payload);
    }
  }, [sendPeerEvent, updateConnectionState]);

  const setupPeerConnection = useCallback(() => {
    if (pcRef.current) {
      return pcRef.current;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus("connected");
      }
      if (pc.connectionState === "disconnected") {
        offerSentRef.current = false;
        setStatus("connecting");
      }
      if (pc.connectionState === "failed") {
        offerSentRef.current = false;
        setStatus("failed");
        setError("Peer connection dropped. Retrying...");
      }
    };

    if (role === "guest") {
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channelRef.current = channel;

        channel.onopen = () => {
          applyTransportReady();
        };
        channel.onclose = () => {
          hasPeerTransportRef.current = false;
          setStatus("failed");
          updateConnectionState();
        };
        channel.onerror = () => {
          setStatus("failed");
        };
        channel.onmessage = (messageEvent) => {
          if (typeof messageEvent.data === "string") {
            handlePeerMessage(messageEvent.data);
          }
        };
      };
    }

    pcRef.current = pc;
    return pc;
  }, [applyTransportReady, handlePeerMessage, role, updateConnectionState]);

  const ensureHostDataChannel = useCallback(() => {
    const pc = setupPeerConnection();
    if (channelRef.current) {
      return channelRef.current;
    }

    const channel = pc.createDataChannel("duel-events", { ordered: true });
    channelRef.current = channel;

    channel.onopen = () => {
      applyTransportReady();
    };
    channel.onclose = () => {
      hasPeerTransportRef.current = false;
      setStatus("failed");
      updateConnectionState();
    };
    channel.onerror = () => {
      setStatus("failed");
    };
    channel.onmessage = (messageEvent) => {
      if (typeof messageEvent.data === "string") {
        handlePeerMessage(messageEvent.data);
      }
    };

    return channel;
  }, [applyTransportReady, handlePeerMessage, setupPeerConnection, updateConnectionState]);

  const sendIceCandidate = useCallback(
    async (candidate: RTCIceCandidateInit) => {
      if (!enabled) {
        return;
      }

      await postSignal({
        action: "send",
        roomId,
        from: role,
        to: role === "host" ? "guest" : "host",
        type: "ice-candidate",
        payload: candidate,
      });
    },
    [enabled, postSignal, role, roomId],
  );

  const sendOffer = useCallback(async () => {
    if (!enabled || role !== "host") {
      return;
    }
    if (offerSentRef.current) {
      return;
    }

    offerSentRef.current = true;
    setStatus("connecting");

    try {
      ensureHostDataChannel();
      const pc = setupPeerConnection();
      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }
        void sendIceCandidate(event.candidate.toJSON());
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await postSignal({
        action: "send",
        roomId,
        from: "host",
        to: "guest",
        type: "offer",
        payload: pc.localDescription,
      });
    } catch {
      offerSentRef.current = false;
      setStatus("failed");
      setError("Unable to create host WebRTC offer.");
    }
  }, [enabled, ensureHostDataChannel, postSignal, role, roomId, sendIceCandidate, setupPeerConnection]);

  const handleOffer = useCallback(
    async (eventPayload: unknown) => {
      if (!enabled || role !== "guest") {
        return;
      }
      if (processingOfferRef.current) {
        return;
      }
      processingOfferRef.current = true;
      setStatus("connecting");

      try {
        const offer = eventPayload as RTCSessionDescriptionInit;
        const pc = setupPeerConnection();
        pc.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }
          void sendIceCandidate(event.candidate.toJSON());
        };
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIceCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await postSignal({
          action: "send",
          roomId,
          from: "guest",
          to: "host",
          type: "answer",
          payload: pc.localDescription,
        });
      } catch {
        setStatus("failed");
        setError("Unable to create guest WebRTC answer.");
      } finally {
        processingOfferRef.current = false;
      }
    },
    [enabled, flushPendingIceCandidates, postSignal, role, roomId, sendIceCandidate, setupPeerConnection],
  );

  const handleAnswer = useCallback(
    async (eventPayload: unknown) => {
      if (!enabled || role !== "host") {
        return;
      }
      if (processingAnswerRef.current) {
        return;
      }

      processingAnswerRef.current = true;
      try {
        const answer = eventPayload as RTCSessionDescriptionInit;
        const pc = setupPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIceCandidates(pc);
      } catch {
        setStatus("failed");
        setError("Unable to apply guest answer.");
      } finally {
        processingAnswerRef.current = false;
      }
    },
    [enabled, flushPendingIceCandidates, role, setupPeerConnection],
  );

  const handleIceCandidate = useCallback(async (eventPayload: unknown) => {
    if (!enabled) {
      return;
    }

    try {
      const candidate = eventPayload as RTCIceCandidateInit;
      if (!candidate || !candidate.candidate) {
        return;
      }

      const pc = setupPeerConnection();
      if (!pc.remoteDescription) {
        pendingIceCandidatesRef.current.push(candidate);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Ignore malformed or stale candidates.
    }
  }, [enabled, setupPeerConnection]);

  const pollSignalEvents = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (roomUnavailableRef.current) {
      return;
    }

    try {
      const response = await fetch(
        `/api/webrtc?roomId=${encodeURIComponent(roomId)}&role=${encodeURIComponent(role)}&cursor=${cursorRef.current}`,
        { method: "GET", cache: "no-store" },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        const nextError = new Error(
          payload?.error || `Polling failed (${response.status}).`,
        ) as SignalPollingError;
        if (response.status === 404) {
          nextError.code = "ROOM_NOT_FOUND";
        } else {
          nextError.code = "HTTP_ERROR";
        }
        throw nextError;
      }

      const data = (await response.json()) as PollResponse;
      setHostPresent(data.hostPresent);
      setGuestPresent(data.guestPresent);
      signalingFailureCountRef.current = 0;
      setError(null);

      const currentStatus = statusRef.current;
      if (!hasPeerTransportRef.current) {
        if ((role === "host" && !data.guestPresent) || (role === "guest" && !data.hostPresent)) {
          setStatus("waiting");
        } else {
          setStatus("connecting");
        }
      } else if (currentStatus !== "connected") {
        setStatus("connected");
      }

      cursorRef.current = data.nextCursor;

      for (const event of data.events) {
        if (event.type === "offer") {
          void handleOffer(event.payload);
        }
        if (event.type === "answer") {
          void handleAnswer(event.payload);
        }
        if (event.type === "ice-candidate") {
          void handleIceCandidate(event.payload);
        }
      }

      if (role === "host" && data.guestPresent && !hasPeerTransportRef.current) {
        void sendOffer();
      }
    } catch (err) {
      const signalErr = err as SignalPollingError;
      if (signalErr.code === "ROOM_NOT_FOUND") {
        roomUnavailableRef.current = true;
        setStatus("failed");
        setError("This room is no longer available. Please create a new lobby.");
        return;
      }

      signalingFailureCountRef.current += 1;
      if (signalingFailureCountRef.current >= 3) {
        setError(signalErr.message || "Temporary signaling issue. Reconnecting...");
        if (statusRef.current !== "connected") {
          setStatus("connecting");
        }
      }
    }
  }, [enabled, handleAnswer, handleIceCandidate, handleOffer, role, roomId, sendOffer]);

  const sendCast = useCallback(
    (spellId: SpellId, confidence = 1): boolean => sendPeerEvent({
      type: "SPELL_CAST",
      spellId,
      confidence,
      timestamp: Date.now(),
    }),
    [sendPeerEvent],
  );

  const sendRestart = useCallback((): boolean => {
    inGameRef.current = false;
    setInGame(false);
    updateConnectionState();
    return sendPeerEvent({ type: "RESTART" });
  }, [sendPeerEvent, updateConnectionState]);

  const sendStateSync = useCallback(
    (state: unknown): boolean =>
      throttleStateSyncRef.current((payload) => {
        void sendPeerEvent({
          type: "STATE_SYNC",
          state: payload,
          timestamp: Date.now(),
        });
      }, state),
    [sendPeerEvent],
  );

  const sendMotionData = useCallback(
    (event: Omit<MotionDataEvent, "type" | "timestamp">): boolean =>
      throttleMotionRef.current((payload) => {
        void sendPeerEvent({
          type: "MOTION_DATA",
          segments: payload.segments,
          velocity: payload.velocity,
          spellId: payload.spellId,
          timestamp: Date.now(),
        });
      }, event),
    [sendPeerEvent],
  );

  const sendReady = useCallback((): boolean => {
    localReadyRef.current = true;
    setLocalReady(true);
    updateConnectionState();
    return sendPeerEvent({ type: "READY", timestamp: Date.now() });
  }, [sendPeerEvent, updateConnectionState]);

  const startGame = useCallback(() => {
    inGameRef.current = true;
    setInGame(true);
    updateConnectionState();
  }, [updateConnectionState]);

  const resetReadyState = useCallback(() => {
    localReadyRef.current = false;
    remoteReadyRef.current = false;
    inGameRef.current = false;
    setLocalReady(false);
    setRemoteReady(false);
    setInGame(false);
    setLatencyMs(null);
    latencyTrackerRef.current.reset();
    updateConnectionState();
  }, [updateConnectionState]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      setConnectionState("DISCONNECTED");
      return;
    }

    setStatus("waiting");
    setError(null);
    cursorRef.current = 0;
    offerSentRef.current = false;
    signalingFailureCountRef.current = 0;
    roomUnavailableRef.current = false;
    hasPeerTransportRef.current = false;

    resetReadyState();

    void markPresence(true);
    void pollSignalEvents();

    pollTimerRef.current = window.setInterval(() => {
      void pollSignalEvents();
    }, SIGNAL_POLL_MS);

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      closePeer();
      void markPresence(false);
    };
  }, [closePeer, enabled, markPresence, pollSignalEvents, resetReadyState]);

  useEffect(() => {
    if (!enabled || !hasPeerTransportRef.current) {
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      return;
    }

    const sendPing = () => {
      const timestamp = Date.now();
      latencyTrackerRef.current.markPing(timestamp);
      void sendPeerEvent({ type: "PING", timestamp });
    };

    sendPing();
    pingTimerRef.current = window.setInterval(sendPing, PING_INTERVAL_MS);

    return () => {
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
    };
  }, [enabled, sendPeerEvent, status]);

  useEffect(() => {
    updateConnectionState();
  }, [enabled, hostPresent, guestPresent, status, updateConnectionState]);

  const isConnected = hasPeerTransportRef.current;
  const bothReady = localReady && remoteReady;

  return {
    status,
    error,
    hostPresent,
    guestPresent,
    inviteUrl,
    sendCast,
    sendRestart,
    sendStateSync,
    sendMotionData,
    sendReady,
    startGame,
    resetReadyState,
    localAlias,
    remoteAlias,
    isConnected,
    localReady,
    remoteReady,
    bothReady,
    inGame,
    connectionState,
    latencyMs,
    latencyQuality: getLatencyQuality(latencyMs),
  };
};

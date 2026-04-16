"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpellId } from "@/utils/spellRegistry";

type Role = "host" | "guest";

type PeerMessage =
  | { type: "cast"; spellId: SpellId }
  | { type: "restart" }
  | { type: "state_sync"; state: unknown };

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
  onPeerCast: (spellId: SpellId) => void;
  onPeerRestart?: () => void;
  onPeerStateSync?: (state: unknown) => void;
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
const OUTBOUND_VIDEO_MAX_BITRATE_BPS = 170_000;
const OUTBOUND_VIDEO_MAX_FPS = 15;
const OUTBOUND_VIDEO_SCALE_DOWN_BY = 2;

const tuneOutboundVideoSender = async (sender: RTCRtpSender): Promise<void> => {
  if (!sender.track || sender.track.kind !== "video") {
    return;
  }

  const params = sender.getParameters();
  const encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];
  encodings[0] = {
    ...encodings[0],
    maxBitrate: OUTBOUND_VIDEO_MAX_BITRATE_BPS,
    maxFramerate: OUTBOUND_VIDEO_MAX_FPS,
    scaleResolutionDownBy: OUTBOUND_VIDEO_SCALE_DOWN_BY,
  };

  params.encodings = encodings;
  await sender.setParameters(params);
};

const safeParseMessage = (raw: string): PeerMessage | null => {
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const type = (payload as { type?: string }).type;
    if (type === "cast") {
      const spellId = (payload as { spellId?: string }).spellId;
      if (typeof spellId === "string") {
        return { type: "cast", spellId: spellId as SpellId };
      }
      return null;
    }

    if (type === "restart") {
      return { type: "restart" };
    }

    if (type === "state_sync") {
      return {
        type: "state_sync",
        state: (payload as { state?: unknown }).state,
      };
    }

    return null;
  } catch {
    return null;
  }
};

export const useDuelWebRTC = ({
  roomId,
  role,
  enabled,
  localStream,
  onPeerCast,
  onPeerRestart,
  onPeerStateSync,
}: UseDuelWebRTCOptions) => {
  const [status, setStatus] = useState<PeerStatus>(enabled ? "waiting" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [hostPresent, setHostPresent] = useState(false);
  const [guestPresent, setGuestPresent] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const cursorRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
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
  const localStreamRef = useRef<MediaStream | null>(localStream ?? null);
  const addedLocalTrackIdsRef = useRef<Set<string>>(new Set());
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const { localAlias, remoteAlias } = useMemo(
    () => getDuelAliases(roomId, role),
    [roomId, role],
  );

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
    localStreamRef.current = localStream ?? null;
  }, [localStream]);

  const inviteUrl = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    const origin = window.location.origin;
    return `${origin}/duel/${roomId}?role=guest`;
  }, [roomId]);

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
    addedLocalTrackIdsRef.current.clear();
    pendingIceCandidatesRef.current = [];
    remoteStreamRef.current = null;
    setRemoteStream(null);
  }, []);

  const waitForLocalStream = useCallback(async (timeoutMs = 1200): Promise<void> => {
    const startedAt = Date.now();
    while (!localStreamRef.current && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 60);
      });
    }
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

  const attachLocalTracks = useCallback((pc: RTCPeerConnection) => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    for (const track of stream.getTracks()) {
      if (addedLocalTrackIdsRef.current.has(track.id)) {
        continue;
      }
      const sender = pc.addTrack(track, stream);
      addedLocalTrackIdsRef.current.add(track.id);
      if (track.kind === "video") {
        void tuneOutboundVideoSender(sender).catch(() => {
          // Some browsers may reject sender params; ignore to keep call healthy.
        });
      }
    }
  }, []);

  const setupPeerConnection = useCallback(() => {
    if (pcRef.current) {
      return pcRef.current;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    attachLocalTracks(pc);

    pc.ontrack = (event) => {
      let stream = remoteStreamRef.current;
      if (!stream) {
        stream = new MediaStream();
        remoteStreamRef.current = stream;
        setRemoteStream(stream);
      }

      for (const track of event.streams[0]?.getTracks?.() ?? [event.track]) {
        if (!stream.getTracks().some((existing) => existing.id === track.id)) {
          stream.addTrack(track);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus("connected");
        setError(null);
        signalingFailureCountRef.current = 0;
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

        channel.onopen = () => setStatus("connected");
        channel.onclose = () => setStatus("failed");
        channel.onerror = () => setStatus("failed");
        channel.onmessage = (messageEvent) => {
          const message = safeParseMessage(messageEvent.data);
          if (!message) return;
          if (message.type === "cast") {
            onPeerCastRef.current(message.spellId);
          }
          if (message.type === "restart") {
            onPeerRestartRef.current?.();
          }
          if (message.type === "state_sync") {
            onPeerStateSyncRef.current?.(message.state);
          }
        };
      };
    }

    pcRef.current = pc;
    return pc;
  }, [attachLocalTracks, role]);

  const ensureHostDataChannel = useCallback(() => {
    const pc = setupPeerConnection();
    if (channelRef.current) {
      return channelRef.current;
    }

    const channel = pc.createDataChannel("duel-events", { ordered: true });
    channelRef.current = channel;

    channel.onopen = () => setStatus("connected");
    channel.onclose = () => setStatus("failed");
    channel.onerror = () => setStatus("failed");
    channel.onmessage = (messageEvent) => {
      const message = safeParseMessage(messageEvent.data);
      if (!message) return;
      if (message.type === "cast") {
        onPeerCastRef.current(message.spellId);
      }
      if (message.type === "restart") {
        onPeerRestartRef.current?.();
      }
      if (message.type === "state_sync") {
        onPeerStateSyncRef.current?.(message.state);
      }
    };

    return channel;
  }, [setupPeerConnection]);

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
      await waitForLocalStream();
      attachLocalTracks(pc);
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
  }, [attachLocalTracks, enabled, ensureHostDataChannel, postSignal, role, roomId, sendIceCandidate, setupPeerConnection, waitForLocalStream]);

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
        await waitForLocalStream();
        attachLocalTracks(pc);
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
    [attachLocalTracks, enabled, flushPendingIceCandidates, postSignal, role, roomId, sendIceCandidate, setupPeerConnection, waitForLocalStream],
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
        const error = new Error(
          payload?.error || `Polling failed (${response.status}).`,
        ) as SignalPollingError;
        if (response.status === 404) {
          error.code = "ROOM_NOT_FOUND";
        } else {
          error.code = "HTTP_ERROR";
        }
        throw error;
      }

      const data = (await response.json()) as PollResponse;
      setHostPresent(data.hostPresent);
      setGuestPresent(data.guestPresent);
      signalingFailureCountRef.current = 0;
      setError(null);

      const currentStatus = statusRef.current;
      if (currentStatus !== "connected") {
        if ((role === "host" && !data.guestPresent) || (role === "guest" && !data.hostPresent)) {
          setStatus("waiting");
        } else {
          setStatus("connecting");
        }
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

      if (role === "host" && data.guestPresent && currentStatus !== "connected") {
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

  const sendPeerMessage = useCallback((message: PeerMessage): boolean => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") {
      return false;
    }
    channel.send(JSON.stringify(message));
    return true;
  }, []);

  const sendCast = useCallback(
    (spellId: SpellId): boolean => sendPeerMessage({ type: "cast", spellId }),
    [sendPeerMessage],
  );

  const sendRestart = useCallback((): boolean => sendPeerMessage({ type: "restart" }), [sendPeerMessage]);
  const sendStateSync = useCallback(
    (state: unknown): boolean => sendPeerMessage({ type: "state_sync", state }),
    [sendPeerMessage],
  );

  useEffect(() => {
    if (!enabled || !pcRef.current) {
      return;
    }

    const pc = pcRef.current;
    attachLocalTracks(pc);
  }, [attachLocalTracks, enabled, localStream]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    setStatus("waiting");
    setError(null);
    cursorRef.current = 0;
    offerSentRef.current = false;
    signalingFailureCountRef.current = 0;
    roomUnavailableRef.current = false;

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
      closePeer();
      void markPresence(false);
    };
  }, [closePeer, enabled, markPresence, pollSignalEvents]);

  return {
    status,
    error,
    hostPresent,
    guestPresent,
    inviteUrl,
    sendCast,
    sendRestart,
    sendStateSync,
    localAlias,
    remoteAlias,
    remoteStream,
    isConnected: status === "connected",
  };
};

import type { SpellId } from "@/utils/spellRegistry";
import type { MotionSegment } from "@/utils/motionGesture";

export type Role = "host" | "guest";

export type SpellCastEvent = {
  type: "SPELL_CAST";
  spellId: SpellId;
  confidence: number;
  timestamp: number;
};

export type MotionDataEvent = {
  type: "MOTION_DATA";
  segments: MotionSegment[];
  velocity: number;
  timestamp: number;
  spellId?: string;
};

export type ReadyEvent = {
  type: "READY";
  timestamp: number;
};

export type RestartEvent = {
  type: "RESTART";
};

export type StateSyncEvent = {
  type: "STATE_SYNC";
  state: unknown;
  timestamp: number;
};

export type PingEvent = {
  type: "PING";
  timestamp: number;
};

export type PongEvent = {
  type: "PONG";
  timestamp: number;
};

export type PeerEvent =
  | SpellCastEvent
  | MotionDataEvent
  | ReadyEvent
  | RestartEvent
  | StateSyncEvent
  | PingEvent
  | PongEvent;

export type PeerMessage = {
  from: Role;
  payload: PeerEvent;
};

export const encodePeerMessage = (from: Role, payload: PeerEvent): string =>
  JSON.stringify({ from, payload } satisfies PeerMessage);

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

const hasType = (value: unknown, type: PeerEvent["type"]): value is { type: typeof type } =>
  isObject(value) && value.type === type;

export const decodePeerMessage = (raw: string): PeerMessage | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return null;
    }

    const from = parsed.from;
    if (from !== "host" && from !== "guest") {
      return null;
    }

    const payload = parsed.payload;
    if (!isObject(payload) || typeof payload.type !== "string") {
      return null;
    }

    if (hasType(payload, "SPELL_CAST") && typeof payload.spellId === "string") {
      return {
        from,
        payload: {
          type: "SPELL_CAST",
          spellId: payload.spellId as SpellId,
          confidence: Number(payload.confidence ?? 1),
          timestamp: Number(payload.timestamp ?? Date.now()),
        },
      };
    }

    if (hasType(payload, "MOTION_DATA") && Array.isArray(payload.segments)) {
      return {
        from,
        payload: {
          type: "MOTION_DATA",
          segments: payload.segments as MotionSegment[],
          velocity: Number(payload.velocity ?? 0),
          timestamp: Number(payload.timestamp ?? Date.now()),
          spellId: typeof payload.spellId === "string" ? payload.spellId : undefined,
        },
      };
    }

    if (hasType(payload, "STATE_SYNC")) {
      return {
        from,
        payload: {
          type: "STATE_SYNC",
          state: payload.state,
          timestamp: Number(payload.timestamp ?? Date.now()),
        },
      };
    }

    if (hasType(payload, "READY")) {
      return {
        from,
        payload: {
          type: "READY",
          timestamp: Number(payload.timestamp ?? Date.now()),
        },
      };
    }

    if (hasType(payload, "PING")) {
      return {
        from,
        payload: {
          type: "PING",
          timestamp: Number(payload.timestamp ?? Date.now()),
        },
      };
    }

    if (hasType(payload, "PONG")) {
      return {
        from,
        payload: {
          type: "PONG",
          timestamp: Number(payload.timestamp ?? Date.now()),
        },
      };
    }

    if (hasType(payload, "RESTART")) {
      return {
        from,
        payload: { type: "RESTART" },
      };
    }

    return null;
  } catch {
    return null;
  }
};

export const createThrottle = (minIntervalMs: number) => {
  let lastSentAt = 0;
  return <T>(callback: (payload: T) => void, payload: T): boolean => {
    const now = Date.now();
    if (now - lastSentAt < minIntervalMs) {
      return false;
    }
    lastSentAt = now;
    callback(payload);
    return true;
  };
};

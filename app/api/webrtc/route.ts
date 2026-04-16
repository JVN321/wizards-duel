import { NextRequest, NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOM_TTL_MS = 1000 * 60 * 30;
const MAX_EVENTS_PER_ROOM = 300;
const ROOM_TTL_SECONDS = Math.ceil(ROOM_TTL_MS / 1000);

type Role = "host" | "guest";
type EventTarget = Role | "all";

type SignalEvent = {
  id: number;
  type: string;
  from: Role;
  to: EventTarget;
  payload: unknown;
  at: number;
};

type Room = {
  id: string;
  createdAt: number;
  expiresAt: number;
  hostPresent: boolean;
  guestPresent: boolean;
};

type RoomWithEvents = Room & {
  events: SignalEvent[];
  nextEventId: number;
};

declare global {
  var __wizardsDuelRooms: Map<string, RoomWithEvents> | undefined;
}

const isVercelRuntime = Boolean(process.env.VERCEL);
const hasKvConfig = Boolean(
  process.env.KV_REST_API_URL ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.UPSTASH_REDIS_REST_TOKEN,
);

const shouldUseKv = hasKvConfig;

const roomMetaKey = (roomId: string) => `duel:room:${roomId}`;
const roomEventsKey = (roomId: string) => `duel:room:${roomId}:events`;
const roomCounterKey = (roomId: string) => `duel:room:${roomId}:counter`;

const nowMs = () => Date.now();

const makeRoomId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

const createRoomMeta = (): Room => {
  const now = nowMs();
  return {
    id: makeRoomId(),
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    hostPresent: false,
    guestPresent: false,
  };
};

const ensurePersistentStore = (): NextResponse | null => {
  if (isVercelRuntime && !shouldUseKv) {
    return NextResponse.json(
      {
        error:
          "Persistent signaling store is not configured on Vercel. Add an Upstash Redis/Vercel KV integration and redeploy.",
      },
      { status: 503 },
    );
  }
  return null;
};

const getMemoryStore = (): Map<string, RoomWithEvents> => {
  if (!globalThis.__wizardsDuelRooms) {
    globalThis.__wizardsDuelRooms = new Map<string, RoomWithEvents>();
  }
  return globalThis.__wizardsDuelRooms;
};

const cleanupExpiredRoomsInMemory = (rooms: Map<string, RoomWithEvents>): void => {
  const now = nowMs();
  for (const [id, room] of rooms) {
    if (room.expiresAt <= now) {
      rooms.delete(id);
    }
  }
};

const parseStoredEvent = (entry: unknown): SignalEvent | null => {
  try {
    if (typeof entry === "string") {
      const parsed = JSON.parse(entry) as SignalEvent;
      return parsed;
    }
    if (entry && typeof entry === "object") {
      return entry as SignalEvent;
    }
    return null;
  } catch {
    return null;
  }
};

const createRoom = async (): Promise<Room> => {
  if (!shouldUseKv) {
    const rooms = getMemoryStore();
    cleanupExpiredRoomsInMemory(rooms);

    let room = createRoomMeta();
    while (rooms.has(room.id)) {
      room = createRoomMeta();
    }

    rooms.set(room.id, {
      ...room,
      events: [],
      nextEventId: 1,
    });

    return room;
  }

  let room = createRoomMeta();
  let exists = await kv.get(roomMetaKey(room.id));
  while (exists) {
    room = createRoomMeta();
    exists = await kv.get(roomMetaKey(room.id));
  }

  await kv.set(roomMetaKey(room.id), room, { ex: ROOM_TTL_SECONDS });
  await kv.set(roomCounterKey(room.id), 0, { ex: ROOM_TTL_SECONDS });
  await kv.del(roomEventsKey(room.id));

  return room;
};

const getRoomMeta = async (roomId: string): Promise<Room | null> => {
  if (!shouldUseKv) {
    const rooms = getMemoryStore();
    cleanupExpiredRoomsInMemory(rooms);
    const room = rooms.get(roomId);
    if (!room) return null;

    room.expiresAt = nowMs() + ROOM_TTL_MS;
    return {
      id: room.id,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      hostPresent: room.hostPresent,
      guestPresent: room.guestPresent,
    };
  }

  const room = await kv.get<Room>(roomMetaKey(roomId));
  if (!room) {
    return null;
  }

  const refreshed: Room = {
    ...room,
    expiresAt: nowMs() + ROOM_TTL_MS,
  };

  await kv.set(roomMetaKey(roomId), refreshed, { ex: ROOM_TTL_SECONDS });
  await kv.expire(roomCounterKey(roomId), ROOM_TTL_SECONDS);
  await kv.expire(roomEventsKey(roomId), ROOM_TTL_SECONDS);

  return refreshed;
};

const saveRoomMeta = async (room: Room): Promise<void> => {
  if (!shouldUseKv) {
    const rooms = getMemoryStore();
    const current = rooms.get(room.id);
    if (!current) return;

    current.hostPresent = room.hostPresent;
    current.guestPresent = room.guestPresent;
    current.expiresAt = room.expiresAt;
    return;
  }

  await kv.set(roomMetaKey(room.id), room, { ex: ROOM_TTL_SECONDS });
  await kv.expire(roomCounterKey(room.id), ROOM_TTL_SECONDS);
  await kv.expire(roomEventsKey(room.id), ROOM_TTL_SECONDS);
};

const appendEvent = async (
  roomId: string,
  event: Omit<SignalEvent, "id" | "at">,
): Promise<SignalEvent> => {
  if (!shouldUseKv) {
    const rooms = getMemoryStore();
    const room = rooms.get(roomId);
    if (!room) {
      throw new Error("ROOM_NOT_FOUND");
    }

    const next: SignalEvent = {
      ...event,
      id: room.nextEventId,
      at: nowMs(),
    };

    room.nextEventId += 1;
    room.events.push(next);
    if (room.events.length > MAX_EVENTS_PER_ROOM) {
      room.events.splice(0, room.events.length - MAX_EVENTS_PER_ROOM);
    }

    return next;
  }

  const id = await kv.incr(roomCounterKey(roomId));
  const next: SignalEvent = {
    ...event,
    id,
    at: nowMs(),
  };

  await kv.rpush(roomEventsKey(roomId), JSON.stringify(next));
  await kv.ltrim(roomEventsKey(roomId), -MAX_EVENTS_PER_ROOM, -1);
  await kv.expire(roomEventsKey(roomId), ROOM_TTL_SECONDS);
  await kv.expire(roomCounterKey(roomId), ROOM_TTL_SECONDS);

  return next;
};

const getEventsAfterCursor = async (roomId: string, cursor: number, role: Role): Promise<SignalEvent[]> => {
  if (!shouldUseKv) {
    const rooms = getMemoryStore();
    const room = rooms.get(roomId);
    if (!room) return [];

    return room.events.filter(
      (event) => event.id > cursor && (event.to === "all" || event.to === role),
    );
  }

  const rawEvents = await kv.lrange(roomEventsKey(roomId), 0, -1);
  const parsed = rawEvents
    .map(parseStoredEvent)
    .filter((entry): entry is SignalEvent => Boolean(entry));

  return parsed.filter(
    (event) => event.id > cursor && (event.to === "all" || event.to === role),
  );
};

export async function POST(req: NextRequest) {
  const persistenceError = ensurePersistentStore();
  if (persistenceError) {
    return persistenceError;
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "Missing request payload." }, { status: 400 });
  }

  const action = (payload as { action?: string }).action;

  if (action === "create-room") {
    const room = await createRoom();
    return NextResponse.json({
      roomId: room.id,
      expiresAt: room.expiresAt,
      invitePath: `/duel/${room.id}?role=guest`,
    });
  }

  if (action === "presence") {
    const roomId = (payload as { roomId?: string }).roomId;
    const role = (payload as { role?: Role }).role;
    const present = (payload as { present?: boolean }).present ?? true;

    if (!roomId || (role !== "host" && role !== "guest")) {
      return NextResponse.json({ error: "roomId and role are required." }, { status: 400 });
    }

    const room = await getRoomMeta(roomId);
    if (!room) {
      return NextResponse.json({ error: "Room not found." }, { status: 404 });
    }

    if (role === "host") {
      room.hostPresent = present;
      await appendEvent(room.id, {
        type: "presence",
        from: "host",
        to: "guest",
        payload: { hostPresent: present, guestPresent: room.guestPresent },
      });
    } else {
      room.guestPresent = present;
      await appendEvent(room.id, {
        type: "presence",
        from: "guest",
        to: "host",
        payload: { hostPresent: room.hostPresent, guestPresent: present },
      });
    }

    await saveRoomMeta(room);

    return NextResponse.json({
      ok: true,
      roomId,
      hostPresent: room.hostPresent,
      guestPresent: room.guestPresent,
    });
  }

  if (action === "send") {
    const roomId = (payload as { roomId?: string }).roomId;
    const from = (payload as { from?: Role }).from;
    const to = (payload as { to?: EventTarget }).to;
    const type = (payload as { type?: string }).type;
    const eventPayload = (payload as { payload?: unknown }).payload;

    if (!roomId || (from !== "host" && from !== "guest") || !type) {
      return NextResponse.json(
        { error: "roomId, from, and type are required." },
        { status: 400 },
      );
    }

    const room = await getRoomMeta(roomId);
    if (!room) {
      return NextResponse.json({ error: "Room not found." }, { status: 404 });
    }

    const target: EventTarget = to ?? (from === "host" ? "guest" : "host");
    const event = await appendEvent(room.id, {
      type,
      from,
      to: target,
      payload: eventPayload ?? null,
    });

    return NextResponse.json({ ok: true, eventId: event.id });
  }

  return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const persistenceError = ensurePersistentStore();
  if (persistenceError) {
    return persistenceError;
  }

  const search = req.nextUrl.searchParams;
  const roomId = search.get("roomId") ?? "";
  const role = search.get("role") as Role | null;
  const cursorRaw = search.get("cursor") ?? "0";

  if (!roomId || (role !== "host" && role !== "guest")) {
    return NextResponse.json(
      { error: "roomId and role query params are required." },
      { status: 400 },
    );
  }

  const room = await getRoomMeta(roomId);
  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  const cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0;
  const events = await getEventsAfterCursor(room.id, cursor, role);
  const nextCursor = events.length ? events[events.length - 1].id : cursor;

  return NextResponse.json({
    roomId,
    hostPresent: room.hostPresent,
    guestPresent: room.guestPresent,
    nextCursor,
    events,
  });
}

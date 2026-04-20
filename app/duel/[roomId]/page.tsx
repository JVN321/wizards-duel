"use client";

import { useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { HandTracker } from "@/components/HandTracker";

export default function DuelRoomPage() {
  const router = useRouter();
  const params = useParams<{ roomId: string }>();
  const searchParams = useSearchParams();

  const roomId = (params?.roomId ?? "").toLowerCase();
  const role = searchParams.get("role") === "host" ? "host" : "guest";

  const invalidRoom = !roomId || !/^[a-z0-9]{6,16}$/.test(roomId);

  const title = useMemo(
    () => `${role === "host" ? "Host" : "Guest"} • Room ${roomId.toUpperCase()}`,
    [role, roomId],
  );

  if (invalidRoom) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-center text-slate-100">
        <div>
          <h1 className="font-serif text-3xl text-red-200">Invalid Room Link</h1>
          <p className="mt-3 text-sm text-red-100/85">
            This invite link is malformed. Return to the lobby and create/join a valid room.
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-5 rounded-lg border border-red-300/40 px-4 py-2 text-sm font-semibold uppercase tracking-[0.13em] text-red-100 transition hover:bg-red-400/10"
          >
            Back to Lobby
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-cyan-500/18 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-16 h-80 w-80 rounded-full bg-fuchsia-500/14 blur-3xl" />

      <div className="relative border-b border-cyan-200/15 bg-slate-900/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-345 items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-lg border border-cyan-200/25 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-cyan-100 transition hover:bg-cyan-300/10"
          >
            Back to Lobby
          </button>
          <p className="text-center text-[11px] uppercase tracking-[0.18em] text-cyan-100/85 sm:text-xs">
            {title}
          </p>
          <div className="rounded-lg border border-cyan-300/25 bg-cyan-300/8 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-cyan-200/90 sm:text-[11px]">
            Real-time WebRTC Duel
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <HandTracker
          multiplayer={{
            enabled: true,
            roomId,
            role,
          }}
        />
      </div>
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { HandTracker } from "@/components/HandTracker";

export default function TrainingPage() {
  const router = useRouter();

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-amber-500/18 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 top-16 h-80 w-80 rounded-full bg-cyan-500/16 blur-3xl" />

      <div className="relative border-b border-amber-200/20 bg-slate-900/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-345 items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-lg border border-amber-200/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-amber-100 transition hover:bg-amber-300/10"
          >
            Back to Lobby
          </button>
          <p className="text-center text-[11px] uppercase tracking-[0.18em] text-amber-100/90 sm:text-xs">
            Training Arena
          </p>
          <div className="rounded-lg border border-amber-300/30 bg-amber-300/8 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-amber-200/90 sm:text-[11px]">
            No AI Counterattacks
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <HandTracker mode="training" />
      </div>
    </main>
  );
}

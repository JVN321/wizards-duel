"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import Image from "next/image";

type CreateRoomResponse = {
  roomId: string;
  invitePath: string;
};

const normalizeRoomInput = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const duelIndex = parts.findIndex((part) => part === "duel");
    if (duelIndex >= 0 && parts[duelIndex + 1]) {
      return parts[duelIndex + 1].toLowerCase();
    }
  } catch {
    // Not a URL. Keep as raw room code.
  }

  return trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
};

export default function Home() {
  const router = useRouter();
  const [roomInput, setRoomInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");

  const normalizedJoinRoomId = useMemo(() => normalizeRoomInput(roomInput), [roomInput]);

  const createRoom = async () => {
    setError(null);
    setCreating(true);

    try {
      const response = await fetch("/api/webrtc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-room" }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "Unable to create room right now.");
      }

      const data = (await response.json()) as CreateRoomResponse;
      const fullInviteUrl = `${window.location.origin}${data.invitePath}`;
      const qrUrl = await QRCode.toDataURL(fullInviteUrl, {
        margin: 1,
        width: 280,
      });

      setCreatedRoomId(data.roomId);
      setInviteUrl(fullInviteUrl);
      setQrDataUrl(qrUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create room.";
      setError(message);
    } finally {
      setCreating(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      setError("Could not copy invite link. You can still copy it manually.");
    }
  };

  const joinRoom = () => {
    if (!normalizedJoinRoomId) {
      setError("Enter a valid room code or invite link.");
      return;
    }
    router.push(`/duel/${normalizedJoinRoomId}?role=guest`);
  };

  const enterHostLobby = () => {
    if (!createdRoomId) return;
    router.push(`/duel/${createdRoomId}?role=host`);
  };

  return (
    <main className="lobby-root">
      <div className="lobby-orb lobby-orb-cyan" />
      <div className="lobby-orb lobby-orb-fuchsia" />
      <div className="lobby-orb lobby-orb-emerald" />

      <div className="lobby-content">

        {/* ── Header ── */}
        <header className="lobby-header">
          <p className="lobby-eyebrow">Wizard&apos;s Duel</p>
          <h1 className="lobby-title">Multiplayer Arena Lobby</h1>
          <p className="lobby-subtitle">
            Create a room, copy your invite link, or show the QR code. Your friend joins instantly
            and you duel in real-time using WebRTC.
          </p>
        </header>

        {/* ── Two-column card grid ── */}
        <div className="lobby-grid">

          {/* Create Match */}
          <section className="lobby-card lobby-card-cyan">
            <h2 className="lobby-card-heading lobby-card-heading-cyan">Create Match</h2>
            <p className="lobby-card-desc">Host a room and wait for your opponent to join.</p>

            <button
              type="button"
              disabled={creating}
              onClick={() => void createRoom()}
              className="lobby-btn lobby-btn-cyan"
            >
              {creating ? "Creating Room…" : "Create Multiplayer Room"}
            </button>

            {createdRoomId && inviteUrl && (
              <div className="lobby-room-panel">
                {/* Room code row */}
                <div className="lobby-room-code-row">
                  <div>
                    <p className="lobby-label">Room Code</p>
                    <p className="lobby-room-code">{createdRoomId.toUpperCase()}</p>
                  </div>
                  <button
                    type="button"
                    onClick={enterHostLobby}
                    className="lobby-btn lobby-btn-emerald"
                  >
                    Enter as Host →
                  </button>
                </div>

                {/* Invite link */}
                <div>
                  <p className="lobby-label">Invite Link</p>
                  <div className="lobby-invite-box">{inviteUrl}</div>
                </div>

                {/* Copy button */}
                <button
                  type="button"
                  onClick={() => void copyInvite()}
                  className="lobby-btn lobby-btn-cyan"
                  style={{ marginTop: 0 }}
                >
                  Copy Invite Link
                </button>

                {/* QR Code */}
                {qrDataUrl && (
                  <div className="lobby-qr-wrap">
                    <Image
                      src={qrDataUrl}
                      alt="Invite QR code"
                      width={200}
                      height={200}
                      style={{ width: 200, height: 200, borderRadius: 4 }}
                    />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Join Match */}
          <section className="lobby-card lobby-card-fuchsia">
            <h2 className="lobby-card-heading lobby-card-heading-fuchsia">Join Match</h2>
            <p className="lobby-card-desc">Paste a room code or full invite link to join your friend.</p>

            <label style={{ display: "block", marginTop: 20 }}>
              <span className="lobby-label">Room Code or Invite URL</span>
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.currentTarget.value)}
                placeholder="e.g. 4f3ab12c or https://.../duel/..."
                className="lobby-input"
              />
            </label>

            <button
              type="button"
              onClick={joinRoom}
              className="lobby-btn lobby-btn-fuchsia"
            >
              Join Duel
            </button>

            {normalizedJoinRoomId ? (
              <p className="lobby-parsed-badge">
                Parsed Room: <strong>{normalizedJoinRoomId.toUpperCase()}</strong>
              </p>
            ) : (
              <p className="lobby-tip">
                Tip: you can scan the host&apos;s QR code with your phone and open the link directly.
              </p>
            )}
          </section>
        </div>

        {/* ── Training Mode wide card ── */}
        <div className="lobby-wide-card">
          <div>
            <h2 className="lobby-card-heading lobby-card-heading-amber">Training Mode</h2>
            <p className="lobby-card-desc" style={{ marginTop: 8, maxWidth: 560 }}>
              Practice gestures and measure spell damage output without multiplayer setup.
              Great for tuning casting speed and accuracy.
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push("/training")}
            className="lobby-btn lobby-btn-amber"
          >
            Start Training
          </button>
        </div>

        {/* ── Error ── */}
        {error && <div className="lobby-error">{error}</div>}
      </div>
    </main>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasOverlay } from "@/components/CanvasOverlay";
import { MotionRecognizer } from "@/components/MotionRecognizer";
import {
  type TrackingFrame,
  type TrackingSettings,
  useHandTracking,
} from "@/hooks/useHandTracking";
import {
  distance,
  filterByMinDistance,
  smoothPath,
  type Point,
} from "@/utils/gestureUtils";
import { segmentPath, type MotionSegment } from "@/utils/motionGesture";
import { getGameEngine, type GameState, type EngineEvent } from "@/utils/gameEngine";
import type { SpellDefinition } from "@/utils/spellRegistry";
import { getAllSpells } from "@/utils/spellRegistry";

// ─── Types ────────────────────────────────────────────────────────────────────

type CastFeedback = {
  spell: SpellDefinition;
  confidence: number;
  at: number;
  source: "player" | "opponent";
};

type ToastMessage = {
  id: string;
  text: string;
  color: string;
  at: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TRACKING: TrackingSettings = {
  detectionConfidence: 0.4,
  trackingConfidence: 0.35,
  maxHands: 1,
  modelComplexity: 0,
};

const SPELL_TOAST_TTL = 2800;
const FEEDBACK_TTL = 2600;
const FLASH_DECAY_MS = 800;

// ─── Audio ────────────────────────────────────────────────────────────────────

function playSpellTone(
  frequencies: [number, number],
  waveform: OscillatorType,
  gainPeak = 0.07,
): void {
  if (typeof window === "undefined") return;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;

  const ctx = new AudioContextClass();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);

  const osc = ctx.createOscillator();
  osc.type = waveform;
  osc.frequency.setValueAtTime(frequencies[0], ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(frequencies[1], ctx.currentTime + 0.38);
  osc.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + 0.45);
  osc.onended = () => void ctx.close();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HandTracker() {
  // ── Refs ────────────────────────────────────────────────────────────────────
  const recognizerRef = useRef(new MotionRecognizer());
  const engineRef = useRef(getGameEngine());
  const trailRef = useRef<Point[]>([]);
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastObservedPointRef = useRef<Point | null>(null);
  const lastObservedTimeRef = useRef<number | null>(null);
  const lastMovementAtRef = useRef<number>(0);
  const dropoutStartRef = useRef<number | null>(null);

  // ── State ───────────────────────────────────────────────────────────────────
  const [trail, setTrail] = useState<Point[]>([]);
  const [segments, setSegments] = useState<MotionSegment[]>([]);
  const [feedback, setFeedback] = useState<CastFeedback | null>(null);
  const [flashProgress, setFlashProgress] = useState(0);
  const [gameState, setGameState] = useState<GameState>(engineRef.current.getState());
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [opponentCastFeedback, setOpponentCastFeedback] = useState<SpellDefinition | null>(null);

  // ── Game engine subscription ─────────────────────────────────────────────
  useEffect(() => {
    const engine = engineRef.current;

    const unsub = engine.subscribe((event: EngineEvent) => {
      if (event.type === "state_change") {
        setGameState({ ...event.state });
      }

      if (event.type === "spell_cast") {
        // handled in handleTrackingFrame
      }

      if (event.type === "opponent_cast") {
        const spellDef = getAllSpells().find((s: SpellDefinition) => s.id === event.spellId);
        if (spellDef) {
          setOpponentCastFeedback(spellDef);
          addToast(`⚔️ ${spellDef.displayName}!`, spellDef.color);
          setTimeout(() => setOpponentCastFeedback(null), 2000);
        }
      }

      if (event.type === "combo") {
        addToast(`🔥 ×${event.count} Combo! ×${event.multiplier.toFixed(2)} damage`, "#ffeaa7");
      }

      if (event.type === "game_over") {
        addToast(
          event.winner === "player" ? "🏆 Victory!" : "💀 Defeated!",
          event.winner === "player" ? "#55efc4" : "#ff6b6b",
        );
      }
    });

    return unsub;
  }, []);

  // ── Auto-start duel on mount ─────────────────────────────────────────────
  useEffect(() => {
    const engine = engineRef.current;
    if (engine.getState().phase === "idle") {
      setTimeout(() => engine.startDuel(), 1200);
    }
  }, []);

  // ── Flash animation ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!feedback) return;
    let frame = 0;
    const tick = () => {
      const elapsed = Date.now() - feedback.at;
      const next = Math.max(0, 1 - elapsed / FLASH_DECAY_MS);
      setFlashProgress(next);
      if (elapsed > FEEDBACK_TTL) { setFeedback(null); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [feedback]);

  // ── Toast helper ─────────────────────────────────────────────────────────
  const addToast = useCallback((text: string, color: string) => {
    const id = `${Date.now()}_${Math.random()}`;
    setToasts((prev) => [...prev.slice(-4), { id, text, color, at: Date.now() }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, SPELL_TOAST_TTL);
  }, []);

  // ── Tracking frame handler ───────────────────────────────────────────────
  const handleTrackingFrame = useCallback(
    ({
      gesture: frameGesture,
      landmarks: frameLandmarks,
      timestamp,
      videoSize: frameVideoSize,
    }: TrackingFrame) => {
      const recognizer = recognizerRef.current;
      const engine = engineRef.current;

      // Update landmarks for pose detection (Protego Maxima)
      if (frameLandmarks) {
        recognizer.updateLandmarks(frameLandmarks, timestamp);
      }

      const tip = frameGesture.drawTip;

      if (!tip || !frameLandmarks) {
        // Prediction window during hand dropout
        const lastObs = lastObservedPointRef.current;
        const lastObsAt = lastObservedTimeRef.current;
        const predMs = 120;

        if (lastObs && lastObsAt) {
          const elapsed = timestamp - lastObsAt;
          if (elapsed <= predMs) {
            const dt = elapsed / 1000;
            const damp = Math.max(0.2, 1 - elapsed / (predMs * 1.35));
            const predicted: Point = {
              x: lastObs.x + velocityRef.current.x * dt * damp,
              y: lastObs.y + velocityRef.current.y * dt * damp,
              t: timestamp,
            };
            recognizer.feed(predicted);
            setTrail((prev) => {
              const last = prev[prev.length - 1];
              if (!last || distance(last, predicted) >= 5) {
                const next = [...prev, predicted].slice(-800);
                trailRef.current = next;
                return next;
              }
              return prev;
            });
            return;
          }
        }

        if (dropoutStartRef.current === null) {
          dropoutStartRef.current = timestamp;
        }
        return;
      }

      dropoutStartRef.current = null;

      const point: Point = {
        x: tip.x * frameVideoSize.width,
        y: tip.y * frameVideoSize.height,
        t: timestamp,
      };

      // Update velocity estimate
      const prevObs = lastObservedPointRef.current;
      const prevObsAt = lastObservedTimeRef.current;
      if (prevObs && prevObsAt) {
        const dtSec = Math.max(1e-3, (timestamp - prevObsAt) / 1000);
        const ivx = (point.x - prevObs.x) / dtSec;
        const ivy = (point.y - prevObs.y) / dtSec;
        velocityRef.current = {
          x: velocityRef.current.x * 0.6 + ivx * 0.4,
          y: velocityRef.current.y * 0.6 + ivy * 0.4,
        };
      }
      lastObservedPointRef.current = point;
      lastObservedTimeRef.current = timestamp;
      lastMovementAtRef.current = timestamp;

      // Feed into recognizer and update trail
      recognizer.feed(point);

      setTrail((prev) => {
        const last = prev[prev.length - 1];
        if (!last || distance(last, point) >= 6) {
          const next = [...prev, point].slice(-800);
          trailRef.current = next;
          return next;
        }
        return prev;
      });

      // ── Continuous real-time recognition ─────────────────────────────────
      const match = recognizer.recognize(frameLandmarks ?? []);

      if (match) {
        const spell = match.spell;
        const cast = engine.castSpell(spell.id, match.confidence);

        if (cast) {
          setFeedback({
            spell,
            confidence: match.confidence,
            at: Date.now(),
            source: "player",
          });
          setTrail([]);
          trailRef.current = [];
          recognizer.clearTrail();
          playSpellTone(spell.soundFrequencies, spell.soundWave);
          addToast(`✨ ${spell.displayName}`, spell.color);
        }
      }

      // Update debug segments
      const currentTrail = recognizer.getTrail();
      if (currentTrail.length > 6) {
        const cleaned = filterByMinDistance(currentTrail, 5);
        const smoothed = smoothPath(cleaned, 0.4);
        const segs = segmentPath(smoothed);
        setSegments(segs);
      } else {
        setSegments([]);
      }
    },
    [addToast],
  );

  // ── Tracking hook ────────────────────────────────────────────────────────
  const { videoRef, landmarks, gesture, fps, isReady, error, videoSize } =
    useHandTracking(DEFAULT_TRACKING, handleTrackingFrame);

  // ── Render path ──────────────────────────────────────────────────────────
  const renderPath = useMemo(() => {
    const cleaned = filterByMinDistance(trail, 4);
    return smoothPath(cleaned, 0.4);
  }, [trail]);

  const activeSpellColor = feedback?.spell.color ?? null;

  // ── Clear handler ────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setTrail([]);
    trailRef.current = [];
    recognizerRef.current.clearTrail();
    setSegments([]);
    velocityRef.current = { x: 0, y: 0 };
    lastObservedPointRef.current = null;
    lastObservedTimeRef.current = null;
    dropoutStartRef.current = null;
    setFeedback(null);
    setFlashProgress(0);
  }, []);

  return (
    <div className="duel-root">
      {/* ── Video / Canvas area ── */}
      <div className="video-section">
        <div className="video-inner">
          <div className="video-frame">
            <video
              ref={videoRef}
              className="video-el"
              style={{ transform: "scaleX(-1)" }}
              autoPlay
              muted
              playsInline
            />

            <div style={{ transform: "scaleX(-1)" }} className="canvas-wrap">
              <CanvasOverlay
                sourceWidth={videoSize.width}
                sourceHeight={videoSize.height}
                landmarks={landmarks}
                path={renderPath}
                showSkeleton
                showTrail
                showDebug={showDebug}
                active={Boolean(gesture.drawTip)}
                trailColor={feedback ? feedback.spell.color : "#7de8ff"}
                spellColor={activeSpellColor}
                spellFlashProgress={flashProgress}
                segments={segments}
              />
            </div>

            {!isReady && !error && (
              <div className="overlay-center">
                <p className="init-text">Initializing MediaPipe…</p>
              </div>
            )}
            {error && (
              <div className="overlay-center overlay-error">
                <p className="error-title">Camera Failed</p>
                <p className="error-body">{error}</p>
              </div>
            )}

            {/* Spell cast burst */}
            {feedback && (
              <div
                className="spell-burst"
                style={{ "--spell-color": feedback.spell.color } as React.CSSProperties}
              >
                <span className="spell-burst-name">{feedback.spell.displayName}</span>
                <span className="spell-burst-conf">
                  {(feedback.confidence * 100).toFixed(0)}% confidence
                </span>
              </div>
            )}

            {/* Opponent cast flash */}
            {opponentCastFeedback && (
              <div className="opponent-cast-badge">
                <span>⚔️ {opponentCastFeedback.displayName}</span>
              </div>
            )}

            {/* FPS badge */}
            <div className="fps-badge">{fps} FPS</div>

            {/* Controls bar */}
            <div className="controls-bar">
              <button
                type="button"
                onClick={handleClear}
                className="btn-clear"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setShowDebug((v) => !v)}
                className={`btn-debug ${showDebug ? "btn-debug-on" : ""}`}
              >
                Debug {showDebug ? "ON" : "OFF"}
              </button>
              <button
                type="button"
                onClick={() => {
                  engineRef.current.startDuel();
                  handleClear();
                }}
                className="btn-restart"
              >
                Restart Duel
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────── */}
      <aside className="side-panel">
        <header className="panel-header">
          <h1 className="duel-title">Wizard's Duel</h1>
          <p className="duel-subtitle">Motion Recognition Engine</p>
        </header>

        {/* Health bars */}
        <HealthBars gameState={gameState} />

        {/* Combo meter */}
        <ComboMeter gameState={gameState} />

        {/* Spell Grid */}
        <SpellGrid gameState={gameState} currentFeedback={feedback} />

        {/* Active effects */}
        <EffectList gameState={gameState} />
      </aside>

      {/* ── Toast notifications ── */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast-item"
            style={{ borderColor: t.color, color: t.color }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function HealthBars({ gameState }: { gameState: GameState }) {
  const { player, opponent } = gameState;
  const playerPct = (player.hp / player.maxHp) * 100;
  const opponentPct = (opponent.hp / opponent.maxHp) * 100;

  return (
    <div className="health-section">
      <div className="fighter-row">
        <span className="fighter-name">{player.name}</span>
        <span className="hp-text">{player.hp}/{player.maxHp}</span>
      </div>
      <div className="hp-bar-bg">
        <div
          className="hp-bar-fill hp-player"
          style={{ width: `${playerPct}%` }}
        />
        {player.shieldStrength > 0 && (
          <div
            className="shield-fill"
            style={{ width: `${player.shieldStrength}%` }}
          />
        )}
      </div>

      <div className="fighter-row mt-2">
        <span className="fighter-name">{opponent.name}</span>
        <span className="hp-text">{opponent.hp}/{opponent.maxHp}</span>
      </div>
      <div className="hp-bar-bg">
        <div
          className="hp-bar-fill hp-opponent"
          style={{ width: `${opponentPct}%` }}
        />
        {opponent.shieldStrength > 0 && (
          <div
            className="shield-fill"
            style={{ width: `${opponent.shieldStrength}%` }}
          />
        )}
      </div>

      {gameState.score > 0 && (
        <div className="score-badge">Score: {gameState.score}</div>
      )}

      {gameState.phase === "victory" && (
        <div className="phase-badge phase-win">🏆 Victory!</div>
      )}
      {gameState.phase === "defeat" && (
        <div className="phase-badge phase-loss">💀 Defeated</div>
      )}
    </div>
  );
}

function ComboMeter({ gameState }: { gameState: GameState }) {
  const recent = gameState.combo.filter(
    (c) => Date.now() - c.castedAt < 3500,
  );
  const count = recent.length;
  if (count < 2) return null;

  const multiplier = count < 3 ? 1.25 : count < 5 ? 1.5 : 2.0;

  return (
    <div className="combo-meter">
      <span className="combo-fire">🔥</span>
      <span className="combo-count">×{count} Combo</span>
      <span className="combo-mult">×{multiplier.toFixed(2)}</span>
    </div>
  );
}

function SpellGrid({
  gameState,
  currentFeedback,
}: {
  gameState: GameState;
  currentFeedback: CastFeedback | null;
}) {
  const allSpells = getAllSpells();
  const now = Date.now();

  return (
    <div className="spell-grid-wrap">
      <h3 className="panel-heading">Spells</h3>
      <div className="spell-grid">
        {allSpells.map((spell) => {
          const cooldownAt = gameState.cooldowns[spell.id] ?? 0;
          const onCd = now < cooldownAt;
          const cdPct = onCd
            ? ((cooldownAt - now) / spell.cooldownMs) * 100
            : 0;
          const isActive = currentFeedback?.spell.id === spell.id;

          return (
            <div
              key={spell.id}
              className={`spell-card ${isActive ? "spell-card-active" : ""} ${onCd ? "spell-card-cd" : ""}`}
              style={
                {
                  "--spell-c": spell.color,
                  "--spell-a": spell.accentColor,
                  "--cd-pct": `${cdPct}%`,
                } as React.CSSProperties
              }
              title={`${spell.description}\nGesture: ${spell.gestureHint}`}
            >
              <div className="spell-card-name">{spell.displayName}</div>
              <div className="spell-card-cat">{spell.category}</div>
              <div className="spell-card-hint">{spell.gestureHint}</div>
              {onCd && <div className="spell-cd-bar" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EffectList({ gameState }: { gameState: GameState }) {
  const now = Date.now();
  const allEffects = [
    ...gameState.player.effects.map((e) => ({ ...e, target: "You" })),
    ...gameState.opponent.effects.map((e) => ({ ...e, target: "Opponent" })),
  ].filter((e) => now - e.startedAt < e.durationMs);

  if (allEffects.length === 0) return null;

  return (
    <div className="effect-list">
      <h3 className="panel-heading">Active Effects</h3>
      {allEffects.map((e) => {
        const remaining = Math.max(0, e.durationMs - (now - e.startedAt));
        const pct = (remaining / e.durationMs) * 100;
        return (
          <div key={e.id} className="effect-row">
            <span className="effect-target">{e.target}</span>
            <span className="effect-status">{e.status}</span>
            <div className="effect-bar-bg">
              <div className="effect-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

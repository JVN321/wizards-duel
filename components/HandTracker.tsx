"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasOverlay } from "@/components/CanvasOverlay";
import {
  SettingsPanel,
  type DrawingSettings,
  type SpellUiSettings,
} from "@/components/SettingsPanel";
import {
  SpellRecognizer,
  type RecognitionSettings,
  type SpellName,
} from "@/components/SpellRecognizer";
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

type SpellFeedback = {
  name: SpellName;
  score: number;
  at: number;
};

const DEFAULT_TRACKING: TrackingSettings = {
  detectionConfidence: 0.4,
  trackingConfidence: 0.35,
  maxHands: 1,
  modelComplexity: 0,
};

const DEFAULT_DRAWING: DrawingSettings = {
  smoothingFactor: 0.35,
  minMovement: 8,
  pauseDurationMs: 300,
  predictionMs: 130,
  showSkeleton: true,
  showTrail: true,
  trailColor: "#7de8ff",
};

const DEFAULT_RECOGNITION: RecognitionSettings = {
  shapeMatchingTolerance: 0.55,
  minStrokeLength: 220,
  resamplingResolution: 96,
};

const DEFAULT_UI: SpellUiSettings = {
  alwaysOn: true,
};

const spellColor: Record<SpellName, string> = {
  Protego: "#8cf7ff",
  Stupefy: "#ff7070",
  Expelliarmus: "#ffbe5c",
  "Expecto Patronum": "#9da7ff",
};

const playSpellTone = (spell: SpellName) => {
  if (typeof window === "undefined") {
    return;
  }

  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) {
    return;
  }

  const context = new AudioContextClass();
  const master = context.createGain();
  master.connect(context.destination);
  master.gain.setValueAtTime(0.0001, context.currentTime);
  master.gain.exponentialRampToValueAtTime(0.06, context.currentTime + 0.02);
  master.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);

  const frequencyBySpell: Record<SpellName, [number, number]> = {
    Protego: [420, 640],
    Stupefy: [220, 160],
    Expelliarmus: [520, 390],
    "Expecto Patronum": [660, 880],
  };

  const [startHz, endHz] = frequencyBySpell[spell];

  const oscillator = context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(startHz, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(endHz, context.currentTime + 0.32);
  oscillator.connect(master);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.38);

  oscillator.onended = () => {
    void context.close();
  };
};

export function HandTracker() {
  const [tracking, setTracking] = useState(DEFAULT_TRACKING);
  const [drawing, setDrawing] = useState(DEFAULT_DRAWING);
  const [recognition, setRecognition] = useState(DEFAULT_RECOGNITION);
  const [ui, setUi] = useState(DEFAULT_UI);

  const recognizerRef = useRef(new SpellRecognizer());
  const trailRef = useRef<Point[]>([]);
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastObservedPointRef = useRef<Point | null>(null);
  const lastObservedTimeRef = useRef<number | null>(null);
  const dropoutStartRef = useRef<number | null>(null);
  const lastMovementAtRef = useRef<number>(0);
  const pauseCastCooldownRef = useRef<number>(0);
  const [trail, setTrail] = useState<Point[]>([]);
  const [lastTrail, setLastTrail] = useState<Point[]>([]);
  const [spell, setSpell] = useState<SpellFeedback | null>(null);
  const [flashProgress, setFlashProgress] = useState(0);

  const finalizeStroke = useCallback(
    (rawTrail: Point[]) => {
      if (rawTrail.length < 2) {
        setTrail([]);
        trailRef.current = [];
        return;
      }

      const cleaned = filterByMinDistance(rawTrail, drawing.minMovement * 0.6);
      if (cleaned.length > 3) {
        const smoothed = smoothPath(cleaned, drawing.smoothingFactor);
        const match = recognizerRef.current.recognize(smoothed, recognition);
        setLastTrail(smoothed);

        if (match) {
          const nextSpell = {
            name: match.spell,
            score: match.score,
            at: Date.now(),
          };
          setSpell(nextSpell);
          playSpellTone(match.spell);
        }
      }

      setTrail([]);
      trailRef.current = [];
      velocityRef.current = { x: 0, y: 0 };
      lastObservedPointRef.current = null;
      lastObservedTimeRef.current = null;
      dropoutStartRef.current = null;
    },
    [drawing.minMovement, drawing.smoothingFactor, recognition],
  );

  const handleTrackingFrame = useCallback(
    ({
      gesture: frameGesture,
      landmarks: frameLandmarks,
      timestamp,
      videoSize: frameVideoSize,
    }: TrackingFrame) => {
      const tip = frameGesture.drawTip;
      if (!tip || !frameLandmarks) {
        const lastObserved = lastObservedPointRef.current;
        const lastObservedAt = lastObservedTimeRef.current;

        if (lastObserved && lastObservedAt) {
          const elapsedDropout = timestamp - lastObservedAt;
          const predictionWindow = drawing.predictionMs;

          if (elapsedDropout <= predictionWindow) {
            const dt = elapsedDropout / 1000;
            const damping = Math.max(0.2, 1 - elapsedDropout / (predictionWindow * 1.35));
            const predicted: Point = {
              x: lastObserved.x + velocityRef.current.x * dt * damping,
              y: lastObserved.y + velocityRef.current.y * dt * damping,
              t: timestamp,
            };

            setTrail((prev) => {
              const previous = prev[prev.length - 1];
              if (!previous) {
                trailRef.current = [predicted];
                return [predicted];
              }

              if (distance(previous, predicted) >= drawing.minMovement * 0.45) {
                const next = [...prev, predicted].slice(-900);
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

        const currentTrail = trailRef.current;
        if (
          currentTrail.length > 2 &&
          timestamp - lastMovementAtRef.current >= drawing.pauseDurationMs
        ) {
          finalizeStroke(currentTrail);
        }
        return;
      }

      dropoutStartRef.current = null;

      const point: Point = {
        x: tip.x * frameVideoSize.width,
        y: tip.y * frameVideoSize.height,
        t: timestamp,
      };

      const previousObserved = lastObservedPointRef.current;
      const previousObservedAt = lastObservedTimeRef.current;
      if (previousObserved && previousObservedAt) {
        const dtSeconds = Math.max(1e-3, (timestamp - previousObservedAt) / 1000);
        const instantVx = (point.x - previousObserved.x) / dtSeconds;
        const instantVy = (point.y - previousObserved.y) / dtSeconds;
        velocityRef.current = {
          x: velocityRef.current.x * 0.6 + instantVx * 0.4,
          y: velocityRef.current.y * 0.6 + instantVy * 0.4,
        };
      }
      lastObservedPointRef.current = point;
      lastObservedTimeRef.current = timestamp;

      setTrail((prev) => {
        if (!prev.length) {
          const next = [point];
          trailRef.current = next;
          lastMovementAtRef.current = timestamp;
          return next;
        }

        const previous = prev[prev.length - 1];
        if (distance(previous, point) >= drawing.minMovement) {
          const next = [...prev, point].slice(-900);
          trailRef.current = next;
          lastMovementAtRef.current = timestamp;
          return next;
        }

        if (
          timestamp - lastMovementAtRef.current >= drawing.pauseDurationMs &&
          prev.length >= 4 &&
          timestamp > pauseCastCooldownRef.current
        ) {
          const captured = [...prev];
          pauseCastCooldownRef.current = timestamp + 250;
          finalizeStroke(captured);
          return [];
        }

        return prev;
      });
    },
    [
      drawing.minMovement,
      drawing.pauseDurationMs,
      drawing.predictionMs,
      finalizeStroke,
    ],
  );

  const { videoRef, landmarks, gesture, fps, isReady, error, videoSize } =
    useHandTracking(tracking, handleTrackingFrame);

  useEffect(() => {
    if (!spell) {
      return;
    }

    let frame = 0;
    const tick = () => {
      const elapsed = Date.now() - spell.at;
      const next = Math.max(0, 1 - elapsed / 800);
      setFlashProgress(next);

      if (elapsed > 2600) {
        setSpell(null);
        return;
      }

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [spell]);

  const renderPath = useMemo(() => {
    const source = trail.length ? trail : lastTrail;
    const smoothed = smoothPath(source, drawing.smoothingFactor);
    return smoothed;
  }, [drawing.smoothingFactor, lastTrail, trail]);

  return (
    <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-6 px-4 py-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/85">Wizards Duel Lab</p>
        <h1 className="font-serif text-3xl text-cyan-50 sm:text-4xl">Air Spellcasting Interface</h1>
        <p className="max-w-3xl text-sm text-slate-200/80 sm:text-base">
          Draw in the air using your index fingertip and cast spells from shape recognition.
          Hand tracking is always on, with short dropout prediction to smooth jitter.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <section className="relative overflow-hidden rounded-3xl border border-cyan-100/20 bg-slate-950/60 shadow-[0_0_0_1px_rgba(180,255,255,0.06),0_18px_70px_rgba(0,0,0,0.5)]">
          <div className="relative mx-auto w-full max-w-[1200px]">
            <div className="relative aspect-video w-full bg-slate-900">
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover"
                style={{ transform: "scaleX(-1)" }}
                autoPlay
                muted
                playsInline
              />

              <div style={{ transform: "scaleX(-1)" }} className="absolute inset-0">
                <CanvasOverlay
                  sourceWidth={videoSize.width}
                  sourceHeight={videoSize.height}
                  landmarks={landmarks}
                  path={renderPath}
                  showSkeleton={drawing.showSkeleton}
                  showTrail={drawing.showTrail}
                  active={Boolean(gesture.drawTip)}
                  trailColor={drawing.trailColor}
                  spellName={spell?.name ?? null}
                  spellFlashProgress={flashProgress}
                />
              </div>

              {!isReady && !error ? (
                <div className="absolute inset-0 grid place-items-center bg-slate-950/75 text-cyan-100">
                  <p className="animate-pulse text-sm tracking-wide">Initializing MediaPipe...</p>
                </div>
              ) : null}

              {error ? (
                <div className="absolute inset-0 grid place-items-center bg-red-950/80 p-6 text-center text-red-100">
                  <div>
                    <p className="text-lg font-semibold">Camera Initialization Failed</p>
                    <p className="mt-2 text-sm text-red-200/90">{error}</p>
                    <p className="mt-3 text-xs text-red-100/85">
                      Check browser camera permissions and refresh.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cyan-100/10 bg-slate-950/80 px-4 py-3 text-sm text-cyan-100/90">
            <div className="flex flex-wrap items-center gap-4">
              <span className="rounded-full border border-cyan-100/20 px-3 py-1 text-xs uppercase tracking-[0.14em]">
                {fps} FPS
              </span>
              <span className="text-xs uppercase tracking-[0.14em] text-cyan-200/85">
                Tracking: Hand (1)
              </span>
              <span className="text-xs uppercase tracking-[0.14em] text-cyan-200/85">
                Pause Cast: {drawing.pauseDurationMs}ms | Predict: {drawing.predictionMs}ms
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setTrail([]);
                trailRef.current = [];
                velocityRef.current = { x: 0, y: 0 };
                lastObservedPointRef.current = null;
                lastObservedTimeRef.current = null;
                dropoutStartRef.current = null;
                lastMovementAtRef.current = 0;
                setLastTrail([]);
                setSpell(null);
                setFlashProgress(0);
              }}
              className="rounded-full border border-cyan-200/35 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cyan-100 transition hover:bg-cyan-100/10"
            >
              Clear Path
            </button>
          </div>

          <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-cyan-200/20 bg-slate-900/70 px-3 py-2 text-sm text-cyan-100 shadow-lg backdrop-blur">
            <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-200/80">Detected Spell</p>
            <p
              className="mt-1 font-serif text-xl tracking-wide"
              style={{
                color: spell ? spellColor[spell.name] : "#cdeef9",
                textShadow: spell ? `0 0 14px ${spellColor[spell.name]}` : "none",
              }}
            >
              {spell ? spell.name : "None"}
            </p>
            <p className="text-[11px] text-cyan-100/70">
              {spell ? `Confidence: ${(spell.score * 100).toFixed(0)}%` : "Draw and release to cast"}
            </p>
          </div>
        </section>

        <SettingsPanel
          tracking={tracking}
          drawing={drawing}
          recognition={recognition}
          ui={ui}
          onTrackingChange={setTracking}
          onDrawingChange={setDrawing}
          onRecognitionChange={setRecognition}
          onUiChange={setUi}
        />
      </div>
    </div>
  );
}

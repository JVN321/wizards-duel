"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CanvasOverlay } from "@/components/CanvasOverlay";
import { MotionRecognizer } from "@/components/MotionRecognizer";
import { SettingsPanel } from "@/components/SettingsPanel";
import {
  type TrackingFrame,
  useHandTracking,
} from "@/hooks/useHandTracking";
import {
  distance,
  filterByMinDistance,
  normalizeGestureInput,
  smoothPath,
  type Point,
} from "@/utils/gestureUtils";
import { segmentPath, type MotionSegment } from "@/utils/motionGesture";
import { getGameEngine, type GameState, type EngineEvent, type GameMode } from "@/utils/gameEngine";
import type { SpellDefinition, SpellId } from "@/utils/spellRegistry";
import { getAllSpells } from "@/utils/spellRegistry";
import { useDuelWebRTC } from "@/hooks/useDuelWebRTC";
import { getConnectionBanner } from "@/utils/connectionState";
import type { SpellCastEvent } from "@/utils/networkManager";
import { evaluateSpellTemplateProbabilities } from "@/utils/spellTemplateMatcher";
import {
  DEFAULT_DUEL_SETTINGS,
  deriveRecognizerSettings,
  deriveTrackingSettings,
  loadDuelSettings,
  saveDuelSettings,
  sanitizeDuelSettings,
  type DuelSettings,
} from "@/utils/settingsManager";

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

type HandTrackerProps = {
  mode?: Exclude<GameMode, "multiplayer">;
  multiplayer?: {
    enabled: boolean;
    role: "host" | "guest";
    roomId: string;
  };
};

type TrainingStatus = "ready" | "success" | "failure";
type TrainingModeState = "LEARNING" | "FREE";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPELL_TOAST_TTL = 2800;
const FEEDBACK_TTL = 2600;
const FLASH_DECAY_MS = 800;
const SEGMENT_REFRESH_MS = 120;
const START_DELAY_MS = 650;
const TRAINING_MIN_POINTS = 10;
const TRAINING_MAX_ATTEMPT_MS = 2300;
const DEFAULT_PROBABILITY_REFRESH_MS = 80;
const MOUSE_TEMPLATE_THRESHOLD_SCALE = 0.52;
const CV_TEMPLATE_THRESHOLD_SCALE = 0.68;
const MIN_DETECTION_CONFIDENCE = 0.5;

const mapHostStateToGuestView = (hostState: GameState): GameState => ({
  ...hostState,
  player: { ...hostState.opponent },
  opponent: { ...hostState.player },
});

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

function getTrainingGuidePath(spellId: SpellDefinition["id"]): string {
  switch (spellId) {
    case "protego_maxima":
      return "M50 18 A32 32 0 1 1 49.9 18";
    case "stupefy":
      return "M72 26 L36 50 L72 74";
    case "sectumsempra":
      return "M28 26 Q52 38 72 74";
    case "bombarda":
      return "M32 76 L32 28 L74 28";
    case "petrificus_totalus":
      return "M34 30 Q20 50 34 66 Q42 74 58 66 L76 66";
    case "aguamenti":
      return "M30 58 C30 40 46 30 62 40 C72 48 70 64 58 70 C45 75 30 66 30 52 M58 70 L74 78";
    case "expelliarmus":
      return "M24 28 L70 28 L70 72";
    case "protego":
      return "M50 24 L50 76";
    case "lumos":
      return "M30 70 L50 30 L70 70";
    case "nox":
      return "M30 64 C38 42 58 42 64 54 C68 62 60 68 52 64";
    default:
      return "";
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HandTracker({ mode = "solo", multiplayer }: HandTrackerProps) {
  // ── Refs ────────────────────────────────────────────────────────────────────
  const recognizerRef = useRef(new MotionRecognizer({ maxTrailLengthPx: 1400 }));
  const engineRef = useRef(getGameEngine());
  const trailRef = useRef<Point[]>([]);
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastObservedPointRef = useRef<Point | null>(null);
  const lastObservedTimeRef = useRef<number | null>(null);
  const dropoutStartRef = useRef<number | null>(null);
  const lastSegmentComputeAtRef = useRef<number>(0);
  const sendCastRef = useRef<(spellId: string, confidence: number, timestamp: number) => boolean>(() => false);
  const sendStateUpdateRef = useRef<(gameState: GameState) => boolean>(() => false);
  const processedHostEventsRef = useRef<Set<string>>(new Set());
  const frameRef = useRef<HTMLDivElement | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const startedDuelRef = useRef(false);
  const trainingAttemptStartRef = useRef<number | null>(null);
  const trainingResetTimerRef = useRef<number | null>(null);
  const latestLandmarksRef = useRef<TrackingFrame["landmarks"]>(null);
  const lastProbabilityAtRef = useRef(0);
  const lastShapeRecognizeAtRef = useRef(0);
  const lastMousePointRef = useRef<Point | null>(null);
  const mouseGestureActiveRef = useRef(false);
  const localCooldownsRef = useRef<Partial<Record<SpellId, number>>>({});

  // ── State ───────────────────────────────────────────────────────────────────
  const [trail, setTrail] = useState<Point[]>([]);
  const [segments, setSegments] = useState<MotionSegment[]>([]);
  const [feedback, setFeedback] = useState<CastFeedback | null>(null);
  const [flashProgress, setFlashProgress] = useState(0);
  const [gameState, setGameState] = useState<GameState>(() => getGameEngine().getState());
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [opponentCastFeedback, setOpponentCastFeedback] = useState<SpellDefinition | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [settings, setSettings] = useState<DuelSettings>(DEFAULT_DUEL_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [selectedSpellId, setSelectedSpellId] = useState<string>(() => getAllSpells()[0]?.id ?? "");
  const [isDrawing, setIsDrawing] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>("ready");
  const [currentTrainingMode, setCurrentTrainingMode] = useState<TrainingModeState>("LEARNING");
  const [feedbackMessage, setFeedbackMessage] = useState("Draw the gesture to cast");
  const [attemptCount, setAttemptCount] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [topProbability, setTopProbability] = useState<{ spell: SpellDefinition; confidence: number } | null>(null);

  const multiplayerEnabled = Boolean(multiplayer?.enabled);
  const duelMode: GameMode = multiplayerEnabled ? "multiplayer" : mode;
  const role = multiplayer?.role ?? "guest";
  const roomId = multiplayer?.roomId ?? "";
  const isTrainingMode = !multiplayerEnabled && mode === "training";
  const allSpells = useMemo(() => getAllSpells(), []);

  const selectedSpell = useMemo(
    () => allSpells.find((spell) => spell.id === selectedSpellId) ?? allSpells[0] ?? null,
    [allSpells, selectedSpellId],
  );

  const inputMode = settings.input.mode;
  const isMirrored = settings.input.camera.mirror;

  const trackingSettings = useMemo(() => deriveTrackingSettings(settings), [settings]);
  const recognizerSettings = useMemo(() => deriveRecognizerSettings(settings), [settings]);

  useEffect(() => {
    setSettings(loadDuelSettings());
    setSettingsReady(true);
  }, []);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }
    saveDuelSettings(settings);
  }, [settings, settingsReady]);

  useEffect(() => {
    recognizerRef.current.updateSettings(recognizerSettings);
  }, [recognizerSettings]);

  useEffect(() => {
    engineRef.current.setConfidenceFloor(Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold));
  }, [settings.detection.confidenceThreshold]);

  const clearTrainingResetTimer = useCallback(() => {
    if (trainingResetTimerRef.current !== null) {
      window.clearTimeout(trainingResetTimerRef.current);
      trainingResetTimerRef.current = null;
    }
  }, []);

  const resetTrainingState = useCallback((nextMessage = "Ready for next attempt") => {
    setTrail([]);
    trailRef.current = [];
    recognizerRef.current.clearTrail();
    setSegments([]);
    velocityRef.current = { x: 0, y: 0 };
    lastObservedPointRef.current = null;
    lastObservedTimeRef.current = null;
    dropoutStartRef.current = null;
    trainingAttemptStartRef.current = null;
    setIsDrawing(false);
    setFeedback(null);
    setFlashProgress(0);
    setTrainingStatus("ready");
    setFeedbackMessage(nextMessage);
  }, []);

  const detectSpecificSpell = useCallback((path: Point[], frameLandmarks: TrackingFrame["landmarks"]) => {
    void frameLandmarks;
    if (!selectedSpell || path.length < TRAINING_MIN_POINTS) {
      return null;
    }

    const ranked = evaluateSpellTemplateProbabilities(path);
    const selected = ranked.find((entry) => entry.spell.id === selectedSpell.id);
    if (!selected) {
      return null;
    }

    const thresholdScale = inputMode === "MOUSE" ? MOUSE_TEMPLATE_THRESHOLD_SCALE : CV_TEMPLATE_THRESHOLD_SCALE;
    const threshold = Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold * thresholdScale);
    return selected.confidence >= threshold ? selected.confidence : null;
  }, [
    inputMode,
    selectedSpell,
    settings.detection.confidenceThreshold,
  ]);

  const getShapeSpellProbabilities = useCallback((rawPath: Point[], limit?: number) => {
    return evaluateSpellTemplateProbabilities(rawPath, {
      limit,
      gridSize: 30,
    });
  }, []);

  const success = useCallback((spell: SpellDefinition, confidence: number) => {
    clearTrainingResetTimer();
    setAttemptCount((prev) => prev + 1);
    setSuccessCount((prev) => prev + 1);
    setTrainingStatus("success");
    setFeedbackMessage(
      `Spell Cast Successfully! ${spell.category === "defense" ? `Shield: ${spell.effect.shieldStrength}` : `Damage: ${spell.effect.damage}`} · Confidence: ${(confidence * 100).toFixed(0)}%`,
    );
    setFeedback({
      spell,
      confidence,
      at: Date.now(),
      source: "player",
    });
    setTopProbability(null);
    setTrail([]);
    trailRef.current = [];
    recognizerRef.current.clearTrail();
    setSegments([]);
    trainingAttemptStartRef.current = null;
    setIsDrawing(false);
    playSpellTone(spell.soundFrequencies, spell.soundWave);
    trainingResetTimerRef.current = window.setTimeout(() => {
      trainingResetTimerRef.current = null;
      resetTrainingState("Cast again");
    }, 1000);
  }, [clearTrainingResetTimer, resetTrainingState]);

  const failure = useCallback((message = "Incorrect Gesture. Try Again") => {
    clearTrainingResetTimer();
    setAttemptCount((prev) => prev + 1);
    setTrainingStatus("failure");
    setFeedbackMessage(message);
    setIsDrawing(false);
    setTrail([]);
    trailRef.current = [];
    recognizerRef.current.clearTrail();
    setTopProbability(null);
    setSegments([]);
    trainingAttemptStartRef.current = null;
    lastObservedTimeRef.current = null;
    trainingResetTimerRef.current = window.setTimeout(() => {
      trainingResetTimerRef.current = null;
      resetTrainingState("Ready for next attempt");
    }, 650);
  }, [clearTrainingResetTimer, resetTrainingState]);

  const handleGestureEnd = useCallback((path: Point[], frameLandmarks: TrackingFrame["landmarks"]) => {
    if (!isTrainingMode || !selectedSpell) {
      return;
    }

    if (path.length < TRAINING_MIN_POINTS) {
      failure("Incorrect Gesture. Try Again");
      return;
    }

    const confidence = detectSpecificSpell(path, frameLandmarks);
    if (confidence !== null) {
      success(selectedSpell, confidence);
      return;
    }

    failure("Incorrect Gesture. Try Again");
  }, [detectSpecificSpell, failure, isTrainingMode, selectedSpell, success]);

  const handleSpellSelect = useCallback((spell: SpellDefinition) => {
    setSelectedSpellId(spell.id);
    clearTrainingResetTimer();
    setAttemptCount(0);
    setSuccessCount(0);
    resetTrainingState(`Selected ${spell.displayName}. Draw the gesture to cast`);
  }, [clearTrainingResetTimer, resetTrainingState]);

  const updateProbabilityFeedback = useCallback((path: Point[], frameLandmarks: TrackingFrame["landmarks"]) => {
    const now = performance.now();
    if (now - lastProbabilityAtRef.current < DEFAULT_PROBABILITY_REFRESH_MS) {
      return;
    }
    lastProbabilityAtRef.current = now;

    const ranked = getShapeSpellProbabilities(path, 1);

    const best = ranked[0];
    if (!best) {
      setTopProbability(null);
      return;
    }
    setTopProbability(best);
  }, [
    getShapeSpellProbabilities,
  ]);

  const toggleTrainingMode = useCallback(() => {
    const nextMode: TrainingModeState = currentTrainingMode === "LEARNING" ? "FREE" : "LEARNING";
    setCurrentTrainingMode(nextMode);
    clearTrainingResetTimer();
    setAttemptCount(0);
    setSuccessCount(0);
    if (nextMode === "FREE") {
      resetTrainingState("Free Mode: Cast any spell");
    } else {
      resetTrainingState(selectedSpell ? `Selected ${selectedSpell.displayName}. Draw the gesture to cast` : "Draw the gesture to cast");
    }
  }, [clearTrainingResetTimer, currentTrainingMode, resetTrainingState, selectedSpell]);

  useEffect(() => {
    return () => {
      clearTrainingResetTimer();
    };
  }, [clearTrainingResetTimer]);

  // ── Toast helper ─────────────────────────────────────────────────────────
  const addToast = useCallback((text: string, color: string) => {
    const id = `${Date.now()}_${Math.random()}`;
    setToasts((prev) => [...prev.slice(-4), { id, text, color, at: Date.now() }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, SPELL_TOAST_TTL);
  }, []);

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
    lastMousePointRef.current = null;
    setFeedback(null);
    setFlashProgress(0);
    setTopProbability(null);
    localCooldownsRef.current = {};
  }, []);

  const isSpellCoolingDownLocally = useCallback((spellId: SpellId, now = Date.now()) => {
    const stateReadyAt = gameState.cooldowns[spellId] ?? 0;
    const localReadyAt = localCooldownsRef.current[spellId] ?? 0;
    return now < Math.max(stateReadyAt, localReadyAt);
  }, [gameState.cooldowns]);

  const markSpellCooldownLocal = useCallback((spellId: SpellId, now = Date.now()) => {
    const spell = getAllSpells().find((s) => s.id === spellId);
    if (!spell) {
      return;
    }
    localCooldownsRef.current[spellId] = now + spell.cooldownMs;
  }, []);

  const processHostCastEvent = useCallback((event: SpellCastEvent): boolean => {
    if (!multiplayerEnabled || role !== "host") {
      return false;
    }

    const eventId = `${event.playerId}-${event.timestamp}`;
    if (processedHostEventsRef.current.has(eventId)) {
      return false;
    }
    processedHostEventsRef.current.add(eventId);

    const spellId = event.spellId as SpellId;
    const spellDef = getAllSpells().find((spell) => spell.id === spellId);
    if (!spellDef) {
      return false;
    }

    const isHostAttacker = event.playerId === "host";
    const applied = isHostAttacker
      ? engineRef.current.castSpell(spellId, event.confidence, event.timestamp)
      : engineRef.current.castOpponentSpell(spellId, event.timestamp);

    if (!applied) {
      return false;
    }

    const nextState = { ...engineRef.current.getState() };
    setGameState(nextState);
    void sendStateUpdateRef.current(nextState);
    console.log("SYNC STATE:", nextState);

    if (isHostAttacker) {
      setFeedback({
        spell: spellDef,
        confidence: event.confidence,
        at: Date.now(),
        source: "player",
      });
      playSpellTone(spellDef.soundFrequencies, spellDef.soundWave);
      addToast(`✨ ${spellDef.displayName}`, spellDef.color);
    } else {
      setOpponentCastFeedback(spellDef);
      addToast(`⚔️ ${spellDef.displayName}!`, spellDef.color);
      setTimeout(() => setOpponentCastFeedback(null), 2000);
    }

    return true;
  }, [addToast, multiplayerEnabled, role]);

  const {
    status: peerStatus,
    error: peerError,
    hostPresent,
    guestPresent,
    inviteUrl,
    sendCast,
    sendStateUpdate,
    sendRestart,
    sendReady,
    startGame,
    localAlias,
    remoteAlias,
    isConnected,
    localReady,
    remoteReady,
    bothReady,
    inGame,
    connectionState,
    latencyMs,
    latencyQuality,
  } = useDuelWebRTC({
    enabled: multiplayerEnabled,
    role,
    roomId,
    onPeerCast: (event) => {
      if (role !== "host") {
        return;
      }
      processHostCastEvent({
        ...event,
        confidence: Math.max(0, Math.min(1, event.confidence)),
      });
    },
    onPeerStateUpdate: (event) => {
      const payload = event.gameState as GameState;
      if (!payload || typeof payload !== "object" || !payload.player || !payload.opponent) {
        return;
      }

      const syncedState = role === "guest"
        ? mapHostStateToGuestView(payload)
        : payload;
      setGameState({ ...syncedState });
    },
    onPeerRestart: () => {
      if (multiplayerEnabled) {
        if (role === "host") {
          engineRef.current.startDuel("multiplayer", {
            playerName: localAlias,
            opponentName: remoteAlias,
          });
          const nextState = { ...engineRef.current.getState() };
          setGameState(nextState);
          void sendStateUpdate(nextState);
        }
        startGame();
      } else {
        engineRef.current.startDuel(duelMode);
      }
      handleClear();
      addToast("Duel restarted by opponent.", "#9ad9ff");
    },
  });

  const connectionBanner = useMemo(() => getConnectionBanner(connectionState), [connectionState]);
  const detectionEnabled = !multiplayerEnabled
    ? gameState.phase === "dueling"
    : connectionState === "IN_GAME" && gameState.phase === "dueling";

  const latencyPill = useMemo(() => {
    if (latencyQuality === "good") return { icon: "🟢", label: "Good" };
    if (latencyQuality === "moderate") return { icon: "🟡", label: "Moderate" };
    if (latencyQuality === "poor") return { icon: "🔴", label: "Poor" };
    return { icon: "⚪", label: "Measuring" };
  }, [latencyQuality]);

  // ── Game engine subscription ─────────────────────────────────────────────
  useEffect(() => {
    const engine = engineRef.current;

    const unsub = engine.subscribe((event: EngineEvent) => {
      if (event.type === "state_change") {
        if (!multiplayerEnabled) {
          setGameState({ ...event.state });
          return;
        }

        if (role === "host") {
          const nextState = { ...event.state };
          setGameState(nextState);
          void sendStateUpdateRef.current(nextState);
          console.log("SYNC STATE:", nextState);
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
  }, [addToast, multiplayerEnabled, role]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockMs(Date.now());
    }, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    sendCastRef.current = sendCast as (spellId: string, confidence: number, timestamp: number) => boolean;
  }, [sendCast]);

  useEffect(() => {
    sendStateUpdateRef.current = sendStateUpdate as (gameState: GameState) => boolean;
  }, [sendStateUpdate]);

  useEffect(() => {
    processedHostEventsRef.current.clear();
  }, [multiplayerEnabled, roomId]);

  // ── Flash animation ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!feedback) return;
    let frame = 0;
    const tick = () => {
      const elapsed = Date.now() - feedback.at;
      const next = Math.max(0, 1 - elapsed / FLASH_DECAY_MS);
      setFlashProgress(next);
      if (elapsed > FEEDBACK_TTL) {
        setFeedback(null);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [feedback]);

  // ── Multiplayer gated start ──────────────────────────────────────────────
  useEffect(() => {
    if (!bothReady) {
      startedDuelRef.current = false;
    }
  }, [bothReady]);

  useEffect(() => {
    if (!multiplayerEnabled || !bothReady || inGame || startedDuelRef.current) {
      return;
    }

    startedDuelRef.current = true;
    const timer = window.setTimeout(() => {
      addToast("Both players ready. Starting duel...", "#83ffc9");
      if (role === "host") {
        engineRef.current.startDuel("multiplayer", {
          playerName: localAlias,
          opponentName: remoteAlias,
        });
        const nextState = { ...engineRef.current.getState() };
        setGameState(nextState);
        void sendStateUpdateRef.current(nextState);
        console.log("SYNC STATE:", nextState);
      }
      handleClear();
      startGame();
    }, START_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [addToast, bothReady, handleClear, inGame, localAlias, multiplayerEnabled, remoteAlias, role, startGame]);

  // ── Solo/training auto-start ─────────────────────────────────────────────
  useEffect(() => {
    if (multiplayerEnabled) {
      return;
    }

    const engine = engineRef.current;
    if (engine.getState().phase === "idle") {
      const timer = window.setTimeout(() => {
        engine.startDuel(duelMode);
      }, 350);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [duelMode, multiplayerEnabled]);

  // ── Shared motion processing ─────────────────────────────────────────────
  const processMotionPoint = useCallback((point: Point, frameLandmarks: TrackingFrame["landmarks"]) => {
    if (!detectionEnabled) {
      return;
    }

    const recognizer = recognizerRef.current;
    const engine = engineRef.current;

    const pointTime = point.t ?? performance.now();
    const prevObs = lastObservedPointRef.current;
    const prevObsAt = lastObservedTimeRef.current;
    if (prevObs && prevObsAt) {
      const dtSec = Math.max(1e-3, (pointTime - prevObsAt) / 1000);
      const ivx = (point.x - prevObs.x) / dtSec;
      const ivy = (point.y - prevObs.y) / dtSec;
      velocityRef.current = {
        x: velocityRef.current.x * 0.6 + ivx * 0.4,
        y: velocityRef.current.y * 0.6 + ivy * 0.4,
      };
    }

    lastObservedPointRef.current = point;
    lastObservedTimeRef.current = pointTime;

    if (isTrainingMode) {
      if (currentTrainingMode === "FREE") {
        recognizer.feed(point);

        setTrail((prev) => {
          const last = prev[prev.length - 1];
          if (!last || distance(last, point) >= 6) {
            const next = [...prev, point].slice(-settings.trail.trailLength);
            trailRef.current = next;
            updateProbabilityFeedback(next, frameLandmarks);
            return next;
          }
          return prev;
        });

        if (inputMode === "CV") {
          const recognitionIntervalMs = Math.max(16, Math.round(1000 / settings.detection.recognitionFrequencyHz));
          let match: { spell: SpellDefinition; confidence: number } | null = null;
          if (pointTime - lastShapeRecognizeAtRef.current >= recognitionIntervalMs) {
            lastShapeRecognizeAtRef.current = pointTime;
            const ranked = getShapeSpellProbabilities(trailRef.current, 1);
            const cvThreshold = Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold * CV_TEMPLATE_THRESHOLD_SCALE);
            if (ranked[0] && ranked[0].confidence >= cvThreshold) {
              match = {
                spell: ranked[0].spell,
                confidence: ranked[0].confidence,
              };
            }
          }

          if (match) {
            setFeedback({
              spell: match.spell,
              confidence: match.confidence,
              at: Date.now(),
              source: "player",
            });
            setTrainingStatus("success");
            setFeedbackMessage(`Detected: ${match.spell.displayName}`);
            setTrail([]);
            trailRef.current = [];
            recognizer.clearTrail();
            setTopProbability(null);
            setSegments([]);
            setIsDrawing(false);
            playSpellTone(match.spell.soundFrequencies, match.spell.soundWave);
          }
        }

        if (!showDebug || pointTime - lastSegmentComputeAtRef.current < SEGMENT_REFRESH_MS) {
          return;
        }

        lastSegmentComputeAtRef.current = pointTime;
        const currentTrail = recognizer.getTrail();
        if (currentTrail.length > 6) {
          const cleaned = filterByMinDistance(currentTrail, 5);
          const smoothed = smoothPath(cleaned, settings.detection.smoothingFactor);
          const segs = segmentPath(smoothed).slice(-6);
          setSegments(segs);
        } else {
          setSegments([]);
        }
        return;
      }

      if (!selectedSpell) {
        return;
      }

      if (trainingAttemptStartRef.current === null) {
        trainingAttemptStartRef.current = pointTime;
      }
      if (!isDrawing) {
        setIsDrawing(true);
      }

      let nextTrailRef = trailRef.current;
      const last = trailRef.current[trailRef.current.length - 1];
      if (!last || distance(last, point) >= 6) {
        nextTrailRef = [...trailRef.current, point].slice(-settings.trail.trailLength);
        trailRef.current = nextTrailRef;
        setTrail(nextTrailRef);
        updateProbabilityFeedback(nextTrailRef, frameLandmarks);
      }

      if (inputMode === "CV") {
        const liveConfidence = detectSpecificSpell(nextTrailRef, frameLandmarks);
        if (liveConfidence !== null) {
          success(selectedSpell, liveConfidence);
          return;
        }
      }

      if (!showDebug || pointTime - lastSegmentComputeAtRef.current < SEGMENT_REFRESH_MS) {
        return;
      }

      lastSegmentComputeAtRef.current = pointTime;
      if (nextTrailRef.length > 6) {
        const cleaned = filterByMinDistance(nextTrailRef, 5);
        const smoothed = smoothPath(cleaned, settings.detection.smoothingFactor);
        const segs = segmentPath(smoothed).slice(-6);
        setSegments(segs);
      } else {
        setSegments([]);
      }
      return;
    }

    recognizer.feed(point);

    setTrail((prev) => {
      const last = prev[prev.length - 1];
      if (!last || distance(last, point) >= 6) {
        const next = [...prev, point].slice(-settings.trail.trailLength);
        trailRef.current = next;
        updateProbabilityFeedback(next, frameLandmarks);
        return next;
      }
      return prev;
    });

    const recognitionIntervalMs = Math.max(16, Math.round(1000 / settings.detection.recognitionFrequencyHz));
    let match: { spell: SpellDefinition; confidence: number } | null = null;
    if (inputMode === "CV" && pointTime - lastShapeRecognizeAtRef.current >= recognitionIntervalMs) {
      lastShapeRecognizeAtRef.current = pointTime;
      const ranked = getShapeSpellProbabilities(trailRef.current, 1);
      const cvThreshold = Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold * CV_TEMPLATE_THRESHOLD_SCALE);
      if (ranked[0] && ranked[0].confidence >= cvThreshold) {
        match = {
          spell: ranked[0].spell,
          confidence: ranked[0].confidence,
        };
      }
    }

    if (match) {
      const spell = match.spell;
      if (isSpellCoolingDownLocally(spell.id)) {
        return;
      }
      setTrail([]);
      trailRef.current = [];
      recognizer.clearTrail();
      setTopProbability(null);

      if (multiplayerEnabled) {
        const eventTimestamp = Date.now();
        const normalizedConfidence = Math.max(0, Math.min(1, match.confidence));
        if (role === "host") {
          processHostCastEvent({
            type: "CAST_SPELL",
            spellId: spell.id,
            timestamp: eventTimestamp,
            confidence: normalizedConfidence,
            playerId: "host",
          });
          sendCastRef.current(spell.id, normalizedConfidence, eventTimestamp);
        } else {
          markSpellCooldownLocal(spell.id, eventTimestamp);
          setFeedback({
            spell,
            confidence: normalizedConfidence,
            at: Date.now(),
            source: "player",
          });
          playSpellTone(spell.soundFrequencies, spell.soundWave);
          addToast(`✨ ${spell.displayName}`, spell.color);
          sendCastRef.current(spell.id, normalizedConfidence, eventTimestamp);
        }
      } else {
        const cast = engine.castSpell(spell.id, match.confidence);
        if (cast) {
          markSpellCooldownLocal(spell.id);
          setFeedback({
            spell,
            confidence: match.confidence,
            at: Date.now(),
            source: "player",
          });
          playSpellTone(spell.soundFrequencies, spell.soundWave);
          addToast(`✨ ${spell.displayName}`, spell.color);
        }
      }
    }

    if (!showDebug || pointTime - lastSegmentComputeAtRef.current < SEGMENT_REFRESH_MS) {
      return;
    }

    lastSegmentComputeAtRef.current = pointTime;
    const currentTrail = recognizer.getTrail();
    if (currentTrail.length > 6) {
      const cleaned = filterByMinDistance(currentTrail, 5);
      const smoothed = smoothPath(cleaned, settings.detection.smoothingFactor);
      const segs = segmentPath(smoothed).slice(-6);
      setSegments(segs);
    } else {
      setSegments([]);
    }
  }, [
    addToast,
    currentTrainingMode,
    detectSpecificSpell,
    detectionEnabled,
    getShapeSpellProbabilities,
    isDrawing,
    isTrainingMode,
    inputMode,
    multiplayerEnabled,
    processHostCastEvent,
    role,
    isSpellCoolingDownLocally,
    markSpellCooldownLocal,
    selectedSpell,
    settings.detection.confidenceThreshold,
    settings.detection.recognitionFrequencyHz,
    settings.detection.smoothingFactor,
    settings.trail.trailLength,
    showDebug,
    success,
    updateProbabilityFeedback,
  ]);

  // ── Tracking frame handler (CV mode) ─────────────────────────────────────
  const handleTrackingFrame = useCallback(
    ({
      gesture: frameGesture,
      landmarks: frameLandmarks,
      timestamp,
      videoSize: frameVideoSize,
    }: TrackingFrame) => {
      if (inputMode !== "CV") {
        return;
      }

      const recognizer = recognizerRef.current;

      if (frameLandmarks) {
        latestLandmarksRef.current = frameLandmarks;
        recognizer.updateLandmarks(frameLandmarks, timestamp);
      }

      if (!detectionEnabled) {
        return;
      }

      const tip = frameGesture.drawTip;
      if (!tip || !frameLandmarks) {
        if (
          isTrainingMode
          && currentTrainingMode === "LEARNING"
          && isDrawing
          && dropoutStartRef.current !== null
          && timestamp - dropoutStartRef.current > settings.detection.gestureTimeoutMs
        ) {
          handleGestureEnd(trailRef.current, latestLandmarksRef.current);
          return;
        }

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
            processMotionPoint(predicted, frameLandmarks);
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

      processMotionPoint(point, frameLandmarks);
    },
    [
      currentTrainingMode,
      detectionEnabled,
      handleGestureEnd,
      inputMode,
      isDrawing,
      isTrainingMode,
      processMotionPoint,
      settings.detection.gestureTimeoutMs,
    ],
  );

  useEffect(() => {
    if (!isTrainingMode || currentTrainingMode !== "LEARNING" || !isDrawing || !detectionEnabled) {
      return;
    }

    const timer = window.setInterval(() => {
      const now = performance.now();
      const startedAt = trainingAttemptStartRef.current;
      if (startedAt !== null && now - startedAt > TRAINING_MAX_ATTEMPT_MS) {
        failure("Try again (timeout)");
        return;
      }

      const lastAt = lastObservedTimeRef.current;
      if (lastAt !== null && now - lastAt > settings.detection.gestureTimeoutMs) {
        handleGestureEnd(trailRef.current, latestLandmarksRef.current);
      }
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    currentTrainingMode,
    detectionEnabled,
    failure,
    handleGestureEnd,
    isDrawing,
    isTrainingMode,
    settings.detection.gestureTimeoutMs,
  ]);

  // ── Tracking hook ────────────────────────────────────────────────────────
  const { videoRef, landmarks, cameraStream, gesture, fps, isReady, error, videoSize } =
    useHandTracking(trackingSettings, handleTrackingFrame, inputMode === "CV");

  const localTrackingReady = inputMode === "MOUSE" ? true : isReady;

  // ── Start local readiness handshake ──────────────────────────────────────
  useEffect(() => {
    if (!multiplayerEnabled || !isConnected || localReady) {
      return;
    }

    if (!localTrackingReady) {
      return;
    }

    const timer = window.setTimeout(() => {
      sendReady();
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isConnected, localReady, localTrackingReady, multiplayerEnabled, sendReady]);

  // ── Mouse casting mode ───────────────────────────────────────────────────
  const startMouseGesture = useCallback(() => {
    mouseGestureActiveRef.current = true;
    setTrail([]);
    trailRef.current = [];
    recognizerRef.current.clearTrail();
    setSegments([]);
    setTopProbability(null);
    lastMousePointRef.current = null;
    lastObservedPointRef.current = null;
    lastObservedTimeRef.current = null;
    dropoutStartRef.current = null;

    if (isTrainingMode && currentTrainingMode === "LEARNING") {
      trainingAttemptStartRef.current = performance.now();
      setIsDrawing(true);
    }
  }, [currentTrainingMode, isTrainingMode]);

  const endMouseGesture = useCallback(() => {
    if (!mouseGestureActiveRef.current) {
      return;
    }

    mouseGestureActiveRef.current = false;
    lastMousePointRef.current = null;
    lastObservedPointRef.current = null;
    lastObservedTimeRef.current = null;

    const recognizer = recognizerRef.current;
    const engine = engineRef.current;

    if (isTrainingMode && currentTrainingMode === "LEARNING") {
      if (trailRef.current.length > 0) {
        handleGestureEnd(trailRef.current, null);
      } else {
        setIsDrawing(false);
      }
      return;
    }

    if (isTrainingMode && currentTrainingMode === "FREE") {
      const ranked = getShapeSpellProbabilities(trailRef.current, 1);
      const mouseThreshold = Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold * MOUSE_TEMPLATE_THRESHOLD_SCALE);
      const match = ranked[0] && ranked[0].confidence >= mouseThreshold
        ? {
          spell: ranked[0].spell,
          confidence: ranked[0].confidence,
        }
        : null;
      if (match) {
        setFeedback({
          spell: match.spell,
          confidence: match.confidence,
          at: Date.now(),
          source: "player",
        });
        setTrainingStatus("success");
        setFeedbackMessage(`Detected: ${match.spell.displayName}`);
        playSpellTone(match.spell.soundFrequencies, match.spell.soundWave);
      }

      setTrail([]);
      trailRef.current = [];
      recognizer.clearTrail();
      setSegments([]);
      setTopProbability(null);
      setIsDrawing(false);
      return;
    }

    if (detectionEnabled) {
      const ranked = getShapeSpellProbabilities(trailRef.current, 1);
      const mouseThreshold = Math.max(MIN_DETECTION_CONFIDENCE, settings.detection.confidenceThreshold * MOUSE_TEMPLATE_THRESHOLD_SCALE);
      const match = ranked[0] && ranked[0].confidence >= mouseThreshold
        ? {
          spell: ranked[0].spell,
          confidence: ranked[0].confidence,
        }
        : null;
      if (match) {
        const spell = match.spell;
        if (isSpellCoolingDownLocally(spell.id)) {
          setTrail([]);
          trailRef.current = [];
          recognizer.clearTrail();
          setSegments([]);
          setTopProbability(null);
          setIsDrawing(false);
          return;
        }

        if (multiplayerEnabled) {
          const eventTimestamp = Date.now();
          const normalizedConfidence = Math.max(0, Math.min(1, match.confidence));
          if (role === "host") {
            processHostCastEvent({
              type: "CAST_SPELL",
              spellId: spell.id,
              timestamp: eventTimestamp,
              confidence: normalizedConfidence,
              playerId: "host",
            });
            sendCastRef.current(spell.id, normalizedConfidence, eventTimestamp);
          } else {
            markSpellCooldownLocal(spell.id, eventTimestamp);
            setFeedback({
              spell,
              confidence: normalizedConfidence,
              at: Date.now(),
              source: "player",
            });
            playSpellTone(spell.soundFrequencies, spell.soundWave);
            addToast(`✨ ${spell.displayName}`, spell.color);
            sendCastRef.current(spell.id, normalizedConfidence, eventTimestamp);
          }
        } else {
          const cast = engine.castSpell(spell.id, match.confidence);
          if (cast) {
            markSpellCooldownLocal(spell.id);
            setFeedback({
              spell,
              confidence: match.confidence,
              at: Date.now(),
              source: "player",
            });
            playSpellTone(spell.soundFrequencies, spell.soundWave);
            addToast(`✨ ${spell.displayName}`, spell.color);
          }
        }
      }
    }

    setTrail([]);
    trailRef.current = [];
    recognizer.clearTrail();
    setSegments([]);
    setTopProbability(null);
    setIsDrawing(false);
  }, [
    addToast,
    currentTrainingMode,
    detectionEnabled,
    getShapeSpellProbabilities,
    handleGestureEnd,
    isSpellCoolingDownLocally,
    isTrainingMode,
    markSpellCooldownLocal,
    multiplayerEnabled,
    processHostCastEvent,
    role,
    settings.detection.confidenceThreshold,
  ]);

  const handleMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (inputMode !== "MOUSE" || !detectionEnabled || event.button !== 0) {
      return;
    }

    startMouseGesture();
  }, [detectionEnabled, inputMode, startMouseGesture]);

  const handleMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (inputMode !== "MOUSE" || event.button !== 0) {
      return;
    }

    endMouseGesture();
  }, [endMouseGesture, inputMode]);

  const handleMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (inputMode !== "MOUSE" || !detectionEnabled) {
      return;
    }

    const isLeftButtonDown = (event.buttons & 1) === 1;
    if (!isLeftButtonDown) {
      endMouseGesture();
      return;
    }

    if (!mouseGestureActiveRef.current) {
      startMouseGesture();
    }

    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;

    const boundedX = Math.min(1, Math.max(0, nx));
    const boundedY = Math.min(1, Math.max(0, ny));

    const scale = settings.input.mouse.speedScaling;
    const centeredX = (boundedX - 0.5) * scale + 0.5;
    const centeredY = (boundedY - 0.5) * scale + 0.5;

    const scaledX = Math.min(1, Math.max(0, centeredX));
    const scaledY = Math.min(1, Math.max(0, centeredY));

    const rawX = scaledX * videoSize.width;
    const x = isMirrored ? videoSize.width - rawX : rawX;
    const y = scaledY * videoSize.height;

    const prevMouse = lastMousePointRef.current;
    const alpha = 1 - settings.input.mouse.smoothing;
    const smoothedPoint: Point = prevMouse
      ? {
        x: prevMouse.x + (x - prevMouse.x) * alpha,
        y: prevMouse.y + (y - prevMouse.y) * alpha,
        t: performance.now(),
      }
      : {
        x,
        y,
        t: performance.now(),
      };

    lastMousePointRef.current = smoothedPoint;

    processMotionPoint(
      smoothedPoint,
      null,
    );
  }, [
    detectionEnabled,
    endMouseGesture,
    inputMode,
    isMirrored,
    processMotionPoint,
    settings.input.mouse.smoothing,
    settings.input.mouse.speedScaling,
    startMouseGesture,
    videoSize.height,
    videoSize.width,
  ]);

  const handleMouseLeave = useCallback(() => {
    if (inputMode !== "MOUSE") {
      return;
    }
    endMouseGesture();
  }, [endMouseGesture, inputMode]);

  // ── Keep preview synced for local camera-only monitor ───────────────────
  useEffect(() => {
    const localPreview = localPreviewRef.current;
    if (localPreview && cameraStream) {
      localPreview.srcObject = cameraStream;
      void localPreview.play().catch(() => {
        // no-op
      });
    }
  }, [cameraStream]);

  // ── Reset trails while waiting for IN_GAME ───────────────────────────────
  useEffect(() => {
    if (!detectionEnabled) {
      const timeoutId = window.setTimeout(() => {
        handleClear();
      }, 0);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [detectionEnabled, handleClear]);

  // ── Render path ──────────────────────────────────────────────────────────
  const renderPath = useMemo(() => {
    const cleaned = filterByMinDistance(trail, Math.max(2, recognizerSettings.minMovement * 0.75));
    return smoothPath(cleaned, settings.detection.smoothingFactor);
  }, [recognizerSettings.minMovement, settings.detection.smoothingFactor, trail]);

  const activeSpellColor = feedback?.spell.color ?? null;
  const trainingAccuracy = attemptCount > 0 ? Math.round((successCount / attemptCount) * 100) : 0;
  const alwaysVisibleProbability = topProbability
    ?? (selectedSpell ? { spell: selectedSpell, confidence: 0 } : null);
  const handleSettingsChange = useCallback((next: DuelSettings) => {
    const sanitized = sanitizeDuelSettings(next);
    if (sanitized.input.mode !== settings.input.mode) {
      lastMousePointRef.current = null;
      setTopProbability(null);
    }
    setSettings(sanitized);
  }, [settings.input.mode]);

  const quickSetInputMode = useCallback((mode: "CV" | "MOUSE") => {
    if (settings.input.mode === mode) {
      return;
    }
    handleSettingsChange({
      ...settings,
      input: {
        ...settings.input,
        mode,
      },
    });
  }, [handleSettingsChange, settings]);

  const handleRestartDuel = useCallback(() => {
    if (isTrainingMode) {
      clearTrainingResetTimer();
      resetTrainingState(selectedSpell ? `Selected ${selectedSpell.displayName}. Draw the gesture to cast` : "Draw the gesture to cast");
      return;
    }

    if (multiplayerEnabled) {
      if (!bothReady) {
        addToast("Both players must be ready to restart.", "#ffb670");
        return;
      }
      if (role === "host") {
        engineRef.current.startDuel("multiplayer", {
          playerName: localAlias,
          opponentName: remoteAlias,
        });
        const nextState = { ...engineRef.current.getState() };
        setGameState(nextState);
        void sendStateUpdateRef.current(nextState);
        console.log("SYNC STATE:", nextState);
      }
      void sendRestart();
      startGame();
    } else {
      engineRef.current.startDuel(duelMode);
    }
    handleClear();
  }, [
    addToast,
    bothReady,
    clearTrainingResetTimer,
    duelMode,
    handleClear,
    isTrainingMode,
    localAlias,
    multiplayerEnabled,
    remoteAlias,
    resetTrainingState,
    role,
    selectedSpell,
    sendRestart,
    startGame,
  ]);

  return (
    <div className="duel-root">
      {/* ── Video / Canvas area ── */}
      <div className="video-section">
        <div className="video-inner">
          <div
            className="video-frame"
            ref={frameRef}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            {inputMode === "CV" && (
              <video
                ref={videoRef}
                className="video-el"
                style={{ transform: isMirrored ? "scaleX(-1)" : "none" }}
                autoPlay
                muted
                playsInline
              />
            )}

            {inputMode === "MOUSE" && (
              <div className="mouse-mode-indicator">
                <p className="init-text">Mouse Casting Mode Active</p>
              </div>
            )}

            <div style={{ transform: isMirrored ? "scaleX(-1)" : "none" }} className="canvas-wrap">
              <CanvasOverlay
                sourceWidth={videoSize.width}
                sourceHeight={videoSize.height}
                landmarks={inputMode === "CV" ? landmarks : null}
                path={renderPath}
                showSkeleton={inputMode === "CV"}
                showTrail
                showDebug={showDebug}
                active={inputMode === "CV" ? Boolean(gesture.drawTip) : detectionEnabled}
                trailColor={feedback ? feedback.spell.color : "#7de8ff"}
                trailThickness={settings.trail.strokeThickness}
                trailFadeDurationMs={settings.trail.fadeDurationMs}
                spellColor={activeSpellColor}
                spellFlashProgress={flashProgress}
                segments={segments}
              />
              {isTrainingMode && selectedSpell && (
                <TrainingGuideOverlay spell={selectedSpell} />
              )}
            </div>

            {inputMode === "CV" && !isReady && !error && (
              <div className="overlay-center">
                <p className="init-text">Initializing MediaPipe...</p>
              </div>
            )}
            {inputMode === "CV" && error && (
              <div className="overlay-center overlay-error">
                <p className="error-title">Camera Failed</p>
                <p className="error-body">{error}</p>
              </div>
            )}

            {!detectionEnabled && (
              <div className="overlay-center connection-overlay">
                <p className="init-text">
                  {multiplayerEnabled
                    ? connectionBanner
                    : isTrainingMode
                      ? "Preparing training arena..."
                      : "Preparing duel..."}
                </p>
              </div>
            )}

            {isTrainingMode && (
              <div className={`training-feedback ${trainingStatus}`}>
                <p className="training-feedback-text">{feedbackMessage}</p>
                {currentTrainingMode === "LEARNING" ? (
                  <p className="training-feedback-sub">
                    Attempts {attemptCount} · Success {successCount} · Accuracy {trainingAccuracy}%
                  </p>
                ) : (
                  <p className="training-feedback-sub">Cast any gesture to see detected spell</p>
                )}
              </div>
            )}

            {feedback && (
              <div
                className="spell-burst"
                style={{ "--spell-color": feedback.spell.color } as CSSProperties}
              >
                <span className="spell-burst-name">{feedback.spell.displayName}</span>
                <span className="spell-burst-conf">
                  {(feedback.confidence * 100).toFixed(0)}% confidence
                </span>
              </div>
            )}

            {opponentCastFeedback && (
              <div className="opponent-cast-badge">
                <span>⚔️ {opponentCastFeedback.displayName}</span>
              </div>
            )}

            <div className="fps-badge">{fps} FPS</div>

            {alwaysVisibleProbability && (
              <div className="probability-badge">
                Detection: {alwaysVisibleProbability.spell.displayName} ({(alwaysVisibleProbability.confidence * 100).toFixed(0)}%)
              </div>
            )}

            {showSettingsPanel && (
              <div className="settings-popover" role="dialog" aria-label="Gesture settings">
                <SettingsPanel settings={settings} onChange={handleSettingsChange} />
              </div>
            )}

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
                onClick={handleRestartDuel}
                className="btn-restart"
              >
                {isTrainingMode ? "Reset Training" : "Restart Duel"}
              </button>
              {isTrainingMode && (
                <button
                  type="button"
                  onClick={toggleTrainingMode}
                  className="btn-debug"
                >
                  {currentTrainingMode === "LEARNING" ? "Switch to Free Mode" : "Switch to Learning Mode"}
                </button>
              )}
              <div className="controls-spacer" />
              <button
                type="button"
                onClick={() => quickSetInputMode("CV")}
                className={`btn-debug ${settings.input.mode === "CV" ? "btn-debug-on" : ""}`}
              >
                Camera Mode
              </button>
              <button
                type="button"
                onClick={() => quickSetInputMode("MOUSE")}
                className={`btn-debug ${settings.input.mode === "MOUSE" ? "btn-debug-on" : ""}`}
              >
                Mouse Mode
              </button>
              <button
                type="button"
                onClick={() => setShowSettingsPanel((prev) => !prev)}
                className={`btn-debug ${showSettingsPanel ? "btn-debug-on" : ""}`}
                aria-label="Toggle settings panel"
                aria-expanded={showSettingsPanel}
              >
                {showSettingsPanel ? "Close Settings" : "Open Settings"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────── */}
      <aside className="side-panel">
        <header className="panel-header">
          <h1 className="duel-title">Wizard&apos;s Duel</h1>
          <p className="duel-subtitle">Motion Recognition Engine</p>

          {isTrainingMode && selectedSpell && (
            <div className="training-panel">
              <p className="duel-subtitle">Mode: {currentTrainingMode}</p>
              {currentTrainingMode === "LEARNING" ? (
                <>
                  <p className="duel-subtitle">Selected Spell: {selectedSpell.displayName}</p>
                  <p className="duel-subtitle">Type: {selectedSpell.category.toUpperCase()}</p>
                  <p className="duel-subtitle">
                    {selectedSpell.category === "defense"
                      ? `Shield: ${selectedSpell.effect.shieldStrength}`
                      : `Damage: ${selectedSpell.effect.damage}`}
                  </p>
                  <p className="duel-subtitle">Draw the gesture to cast</p>
                </>
              ) : (
                <>
                  <p className="duel-subtitle">Cast any gesture freely</p>
                  <p className="duel-subtitle">Detected spell appears on overlay</p>
                </>
              )}
            </div>
          )}

          {!isTrainingMode && multiplayerEnabled && (
            <div className="mt-2">
              <p className="duel-subtitle">Room {roomId.toUpperCase()} • {role.toUpperCase()}</p>
              <p className="duel-subtitle">Peer: {peerStatus.toUpperCase()}</p>
              <p className="duel-subtitle">You: {localAlias}</p>
              <p className="duel-subtitle">Opponent: {remoteAlias}</p>
              <p className="duel-subtitle">State: {connectionState}</p>
              <p className="duel-subtitle">{connectionBanner}</p>
              <p className="duel-subtitle">Ready: You {localReady ? "YES" : "NO"} / Opponent {remoteReady ? "YES" : "NO"}</p>
              <p className="duel-subtitle latency-row">
                Latency: {latencyPill.icon} {latencyPill.label}
                {latencyMs !== null ? ` (${latencyMs} ms)` : ""}
              </p>
              {role === "host" && !guestPresent && (
                <p className="duel-subtitle">Waiting for opponent...</p>
              )}
              {role === "guest" && !hostPresent && (
                <p className="duel-subtitle">Waiting for host...</p>
              )}
              {role === "host" && inviteUrl && (
                <p className="duel-subtitle" style={{ textTransform: "none", letterSpacing: "0.04em" }}>
                  Share link: {inviteUrl}
                </p>
              )}
              {peerError && (
                <p className="duel-subtitle" style={{ color: "#ff7d7d" }}>
                  {peerError}
                </p>
              )}
              {isConnected && (
                <p className="duel-subtitle" style={{ color: "#83ffc9" }}>
                  Opponent connected
                </p>
              )}
            </div>
          )}

          {!isTrainingMode && inputMode === "CV" && (
            <div className="camera-duel-grid">
              <div className="camera-duel-card">
                <p className="camera-duel-label">Your wand cam</p>
                <video
                  ref={localPreviewRef}
                  autoPlay
                  muted
                  playsInline
                  className="camera-duel-video"
                  style={{ transform: isMirrored ? "scaleX(-1)" : "none" }}
                />
              </div>
              <div className="camera-duel-card">
                <p className="camera-duel-label">Opponent feed</p>
                <div className="camera-duel-empty">Video streaming disabled for low latency.</div>
              </div>
            </div>
          )}
        </header>

        {isTrainingMode ? (
          <TrainingSpellGrid
            spells={allSpells}
            selectedSpellId={selectedSpell?.id ?? null}
            onSelect={handleSpellSelect}
            disabled={currentTrainingMode === "FREE"}
          />
        ) : (
          <>
            <HealthBars gameState={gameState} onRematch={handleRestartDuel} />
            <ComboMeter gameState={gameState} now={clockMs} />
            <SpellGrid gameState={gameState} currentFeedback={feedback} now={clockMs} />
            <EffectList gameState={gameState} now={clockMs} />
          </>
        )}
      </aside>

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

function HealthBars({
  gameState,
  onRematch,
}: {
  gameState: GameState;
  onRematch?: () => void;
}) {
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
        <>
          <div className="phase-badge phase-win">🏆 Victory!</div>
          {onRematch && (
            <button type="button" className="phase-rematch-btn" onClick={onRematch}>
              Rematch
            </button>
          )}
        </>
      )}
      {gameState.phase === "defeat" && (
        <>
          <div className="phase-badge phase-loss">💀 Defeated</div>
          {onRematch && (
            <button type="button" className="phase-rematch-btn" onClick={onRematch}>
              Rematch
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ComboMeter({ gameState, now }: { gameState: GameState; now: number }) {
  const recent = gameState.combo.filter(
    (c) => now - c.castedAt < 3500,
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
  now,
}: {
  gameState: GameState;
  currentFeedback: CastFeedback | null;
  now: number;
}) {
  const allSpells = getAllSpells();

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
                } as CSSProperties
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

function TrainingSpellGrid({
  spells,
  selectedSpellId,
  onSelect,
  disabled,
}: {
  spells: SpellDefinition[];
  selectedSpellId: string | null;
  onSelect: (spell: SpellDefinition) => void;
  disabled: boolean;
}) {
  return (
    <div className="spell-grid-wrap">
      <h3 className="panel-heading">Training Spells</h3>
      <div className="spell-grid">
        {spells.map((spell) => {
          const isSelected = spell.id === selectedSpellId;
          const valueText = spell.category === "defense"
            ? `Shield ${spell.effect.shieldStrength}`
            : `Damage ${spell.effect.damage}`;

          return (
            <div
              key={spell.id}
              className={`spell-card ${isSelected ? "spell-card-active" : ""}`}
              style={
                {
                  "--spell-c": spell.color,
                  "--spell-a": spell.accentColor,
                } as CSSProperties
              }
              title={`${spell.description}\nGesture: ${spell.gestureHint}`}
            >
              <div className="spell-card-name">{spell.displayName}</div>
              <div className="spell-card-cat">{spell.category}</div>
              <div className="spell-card-hint">{valueText}</div>
              <div className="spell-card-hint">{spell.gestureHint}</div>
              <button
                type="button"
                className="btn-debug"
                disabled={disabled}
                onClick={() => onSelect(spell)}
              >
                {disabled ? "Free Mode" : isSelected ? "Selected" : "Select"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrainingGuideOverlay({ spell }: { spell: SpellDefinition }) {
  const guidePath = getTrainingGuidePath(spell.id);
  if (!guidePath) {
    return null;
  }

  return (
    <div className="training-guide-overlay" aria-hidden="true">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        className="training-guide-svg"
      >
        <path
          d={guidePath}
          className="training-guide-path"
          style={{ "--guide-color": spell.color } as CSSProperties}
        />
      </svg>
    </div>
  );
}

function EffectList({ gameState, now }: { gameState: GameState; now: number }) {
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

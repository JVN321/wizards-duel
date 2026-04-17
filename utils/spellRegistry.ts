/**
 * spellRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Complete spell registry for the Wizard Duel engine.
 *
 * Each spell defines:
 *   - id / displayName / description
 *   - category  (attack | defense | utility)
 *   - cooldownMs
 *   - detector  (Point[], LandmarkLike[]) → confidence [0,1] | null
 *   - visual metadata (color, particle style, sound frequencies)
 *
 * Detection is motion-pattern–based (direction sequences, velocity,
 * curvature) — NOT shape-template matching.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  segmentPath,
  matchSequence,
  detectArc,
  avgVelocity,
  totalAngularSweep,
  pathDurationMs,
  DEFAULT_MOTION_CONFIG,
  type MotionSegment,
  type LandmarkLike,
} from "./motionGesture";
import {
  filterByMinDistance,
  smoothPath,
  pathLength,
  type Point,
} from "./gestureUtils";

// ─── Public types ─────────────────────────────────────────────────────────────

export type SpellCategory = "attack" | "defense" | "utility";

export type SpellEffect = {
  /** Damage dealt on hit (0 for non-damaging spells) */
  damage: number;
  /** Duration of the effect in ms (0 = instant) */
  durationMs: number;
  /** Status applied to the target */
  status: "none" | "disarmed" | "stunned" | "frozen" | "bleeding" | "shielded" | "interrupted";
  /** Shield strength (0–100); relevant for defense spells */
  shieldStrength: number;
  /** Pushback magnitude (arbitrary units) */
  pushback: number;
};

export type SpellDefinition = {
  id: SpellId;
  displayName: string;
  description: string;
  category: SpellCategory;
  cooldownMs: number;
  effect: SpellEffect;
  /** Sub-gesture label hints shown in the debug overlay */
  gestureHint: string;
  /** Theme color for UI / particles */
  color: string;
  /** Glow / particle accent color */
  accentColor: string;
  /** AudioContext oscillator frequencies [start, end] Hz */
  soundFrequencies: [number, number];
  /** Oscillator waveform */
  soundWave: OscillatorType;
  /**
   * The detector function.
   * Receives the cleaned/smoothed trail and (optionally) current landmarks.
   * Returns a confidence score [0, 1], or null if the spell was not detected.
   * NOTE: The engine only calls this if cooldown has elapsed AND the trail is
   * long enough for the respective spell.
   */
  detect: (points: Point[], landmarks: LandmarkLike[]) => number | null;
};

export type SpellId =
  | "expelliarmus"
  | "stupefy"
  | "sectumsempra"
  | "bombarda"
  | "aguamenti"
  | "protego"
  | "protego_maxima"
  | "lumos"
  | "nox"
  | "petrificus_totalus";

export type SpellMatch = {
  spell: SpellDefinition;
  confidence: number;
  /** Unix ms timestamp when detected */
  detectedAt: number;
};

// ─── Shared motion config (tweakable per-spell) ───────────────────────────────

const BASE_CFG = { ...DEFAULT_MOTION_CONFIG };

function getBounds(points: Point[]): { width: number; height: number } {
  if (points.length === 0) {
    return { width: 0, height: 0 };
  }

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    width: maxX - minX,
    height: maxY - minY,
  };
}

function orthogonalTurnScore(a: MotionSegment, b: MotionSegment): number {
  const aStart = a.points[0];
  const aEnd = a.points[a.points.length - 1];
  const bStart = b.points[0];
  const bEnd = b.points[b.points.length - 1];

  const avx = aEnd.x - aStart.x;
  const avy = aEnd.y - aStart.y;
  const bvx = bEnd.x - bStart.x;
  const bvy = bEnd.y - bStart.y;

  const amag = Math.hypot(avx, avy);
  const bmag = Math.hypot(bvx, bvy);
  if (amag < 1e-4 || bmag < 1e-4) return 0;

  const dot = (avx * bvx + avy * bvy) / (amag * bmag);
  return Math.max(0, 1 - Math.abs(dot));
}

// ─── Individual spell detectors ───────────────────────────────────────────────

/*
 * ─ Expelliarmus ───────────────────────────────────────────────────────────────
 * Pattern: RIGHT → DOWN (a quick "flick right-down" like a disarming swipe)
 * Fast motion, two clear segments.
 */
function detectExpelliarmus(points: Point[]): number | null {
  if (points.length < 7) return null;
  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 45 });
  if (segs.length < 2) return null;

  const score = Math.max(
    matchSequence(segs, ["RIGHT", "DOWN"], { minVelocity: 0.15, minSegmentLength: 45 }),
    matchSequence(segs, ["LEFT", "DOWN"], { minVelocity: 0.15, minSegmentLength: 45 }),
  );
  if (score < 0.5) return null;

  const cornerIdx = segs.findIndex(
    (seg, i) =>
      i < segs.length - 1
      && (seg.direction === "RIGHT" || seg.direction === "LEFT")
      && segs[i + 1].direction === "DOWN",
  );
  if (cornerIdx < 0) return null;

  const turn = orthogonalTurnScore(segs[cornerIdx], segs[cornerIdx + 1]);
  if (turn < 0.58) return null;

  const { width, height } = getBounds(points);
  if (width < 35 || height < 22) return null;
  if (height > width * 1.2) return null;

  return Math.min(1, score * 0.55 + turn * 0.45);
}

/*
 * ─ Stupefy ────────────────────────────────────────────────────────────────────
 * Pattern: RIGHT → LEFT → RIGHT (lightning-bolt back-and-forth jab)
 * Requires three alternating direction segments with good velocity.
 */
function detectStupefy(points: Point[]): number | null {
  if (points.length < 8) return null;
  const duration = pathDurationMs(points);
  if (duration < 250 || duration > 1400) return null;

  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 40 });
  if (segs.length < 2) return null;

  let chevronScore = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i].direction;
    const b = segs[i + 1].direction;
    const isChevron =
      (a === "DIAG_UL" && b === "DIAG_DR")
      || (a === "DIAG_DR" && b === "DIAG_UL")
      || (a === "DIAG_UR" && b === "DIAG_DL")
      || (a === "DIAG_DL" && b === "DIAG_UR");
    if (!isChevron) continue;

    const lenScore = Math.min(1, (segs[i].length + segs[i + 1].length) / 180);
    const turn = orthogonalTurnScore(segs[i], segs[i + 1]);
    chevronScore = Math.max(chevronScore, 0.55 * lenScore + 0.45 * turn);
  }

  if (chevronScore < 0.52) return null;

  const { width, height } = getBounds(points);
  if (width < 35 || height < 20) return null;
  if (width < height * 1.15) return null;

  return chevronScore;
}

/*
 * ─ Sectumsempra ───────────────────────────────────────────────────────────────
 * Pattern: A fast diagonal slash (DIAG_UL, DIAG_UR, DIAG_DL, or DIAG_DR)
 * Key: HIGH velocity — it must be a fast slash, not a slow draw.
 */
function detectSectumsempra(points: Point[]): number | null {
  if (points.length < 5) return null;
  const duration = pathDurationMs(points);
  if (duration < 120 || duration > 900) return null;

  const vel = avgVelocity(points);
  if (vel < 0.35) return null; // Must be fast

  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 60 });
  if (segs.length === 0) return null;

  const diags: (typeof segs[0]["direction"])[] = [
    "DIAG_DL", "DIAG_DR", "DIAG_UL", "DIAG_UR",
  ];

  // Accept any single-segment diagonal or two consecutive diagonals
  const diagSegs = segs.filter((s) => diags.includes(s.direction));
  if (diagSegs.length === 0) return null;

  const longestDiag = diagSegs.reduce(
    (best, s) => (s.length > best.length ? s : best),
    diagSegs[0],
  );

  const totalLen = pathLength(points);
  if (longestDiag.length / Math.max(1, totalLen) < 0.65) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  if (sweep > 85) return null;

  // Confidence = blend of velocity and diagonal length
  const velScore = Math.min(1, vel / 0.6);
  const lenScore = Math.min(1, longestDiag.length / 180);
  const score = 0.5 * velScore + 0.5 * lenScore;
  return score > 0.45 ? score : null;
}

/*
 * ─ Bombarda ───────────────────────────────────────────────────────────────────
 * Pattern: HORIZONTAL (LEFT or RIGHT) → VERTICAL (UP or DOWN)
 * Like drawing an "L" or inverted-L.
 */
function detectBombarda(points: Point[]): number | null {
  if (points.length < 8) return null;
  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 45 });
  if (segs.length < 2) return null;

  const score = Math.max(
    matchSequence(segs, ["DOWN", "RIGHT"], { minVelocity: 0.12, minSegmentLength: 45 }),
    matchSequence(segs, ["DOWN", "LEFT"], { minVelocity: 0.12, minSegmentLength: 45 }),
    matchSequence(segs, ["UP", "RIGHT"], { minVelocity: 0.12, minSegmentLength: 45 }),
    matchSequence(segs, ["UP", "LEFT"], { minVelocity: 0.12, minSegmentLength: 45 }),
  );
  if (score < 0.5) return null;

  const cornerIdx = segs.findIndex(
    (seg, i) =>
      i < segs.length - 1
      && (seg.direction === "UP" || seg.direction === "DOWN")
      && (segs[i + 1].direction === "LEFT" || segs[i + 1].direction === "RIGHT"),
  );
  if (cornerIdx < 0) return null;

  const turn = orthogonalTurnScore(segs[cornerIdx], segs[cornerIdx + 1]);
  if (turn < 0.58) return null;

  const { width, height } = getBounds(points);
  if (width < 30 || height < 30) return null;

  return Math.min(1, score * 0.5 + turn * 0.5);
}

/*
 * ─ Aguamenti ──────────────────────────────────────────────────────────────────
 * Pattern: Smooth arc motion (ARC_CW or ARC_CCW), > 80° sweep.
 * Low velocity allowed (fluid, wave-like).
 */
function detectAguamenti(points: Point[]): number | null {
  if (points.length < 10) return null;
  const duration = pathDurationMs(points);
  if (duration < 380 || duration > 2200) return null;

  const hasArc = detectArc(points, 120, BASE_CFG);
  if (!hasArc) return null;

  const segs = segmentPath(points, BASE_CFG);
  const curvedLen = segs.filter((s) => s.isCurved).reduce((acc, s) => acc + s.length, 0);
  const linearTail = segs.find((s) => !s.isCurved && s.length >= 35);
  if (!linearTail) return null;

  const totalLen = pathLength(points);
  if (curvedLen / Math.max(1, totalLen) < 0.5) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  if (sweep < 180 || sweep > 540) return null;

  const arcScore = Math.min(1, sweep / 300);
  const vel = avgVelocity(points);
  if (vel < 0.08 || vel > 0.5) return null;

  const velScore = vel < 0.3 ? 1 : Math.max(0, 1 - (vel - 0.3) / 0.25);
  const tailScore = Math.min(1, linearTail.length / 90);

  const score = 0.45 * arcScore + 0.3 * velScore + 0.25 * tailScore;
  return score > 0.5 ? score : null;
}

/*
 * ─ Protego ────────────────────────────────────────────────────────────────────
 * Pattern: Single long UPWARD stroke (> 120px).
 * Speed moderate — deliberate shield raise.
 */
function detectProtego(points: Point[]): number | null {
  if (points.length < 6) return null;
  const duration = pathDurationMs(points);
  if (duration < 220 || duration > 1400) return null;

  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 90 });
  if (segs.length === 0) return null;

  const upSegs = segs.filter((s) => s.direction === "UP");
  if (upSegs.length === 0) return null;

  const longestUp = upSegs.reduce(
    (best, s) => (s.length > best.length ? s : best),
    upSegs[0],
  );

  const { width, height } = getBounds(points);
  if (height < 70) return null;
  if (width > height * 0.45) return null;

  // Penalise if there are too many other segments (noisy motion)
  const noiseRatio = (segs.length - upSegs.length) / Math.max(1, segs.length);
  const lenScore = Math.min(1, longestUp.length / 200);
  const score = lenScore * (1 - noiseRatio * 0.5);
  return score > 0.4 ? score : null;
}

/*
 * ─ Protego Maxima ─────────────────────────────────────────────────────────────
 * Pattern: Open-palm pose held steady (landmark-based).
 * Detected via pose analysis; no trail required.
 * Returns a score based on palm openness quality.
 */
function detectProtegoMaxima(
  points: Point[],
  _landmarks: LandmarkLike[],
): number | null {
  if (points.length < 15) return null;

  const duration = pathDurationMs(points);
  if (duration < 500 || duration > 2000) return null;

  const cleaned = filterByMinDistance(points, 4);
  if (cleaned.length < 15) return null;

  const smoothed = smoothPath(cleaned, 0.4);
  if (smoothed.length < 15) return null;

  const totalLength = pathLength(smoothed);
  if (totalLength < 120) return null;

  const first = smoothed[0];
  const last = smoothed[smoothed.length - 1];
  const closure = Math.hypot(last.x - first.x, last.y - first.y);

  let centerX = 0;
  let centerY = 0;
  for (const point of smoothed) {
    centerX += point.x;
    centerY += point.y;
  }
  centerX /= smoothed.length;
  centerY /= smoothed.length;

  const radii = smoothed.map((point) => Math.hypot(point.x - centerX, point.y - centerY));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  if (meanRadius < 30) return null;

  const radiusVariance = radii.reduce(
    (sum, radius) => sum + (radius - meanRadius) ** 2,
    0,
  ) / radii.length;
  const radiusStdDev = Math.sqrt(radiusVariance);
  if (radiusStdDev / meanRadius > 0.28) return null;

  const maxClosureDistance = Math.max(15, meanRadius * 0.35);
  if (closure > maxClosureDistance) return null;

  const maxStep = Math.max(28, meanRadius * 0.9);
  let positiveTurns = 0;
  let negativeTurns = 0;
  let dominantDirection: 1 | -1 | 0 = 0;
  let flipCount = 0;
  let totalSweep = 0;
  let prevAngle = Math.atan2(smoothed[0].y - centerY, smoothed[0].x - centerX);

  for (let i = 1; i < smoothed.length; i++) {
    const step = Math.hypot(
      smoothed[i].x - smoothed[i - 1].x,
      smoothed[i].y - smoothed[i - 1].y,
    );
    if (step > maxStep) return null;

    const angle = Math.atan2(smoothed[i].y - centerY, smoothed[i].x - centerX);
    let delta = angle - prevAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;

    totalSweep += delta;

    const sign = delta > 0.03 ? 1 : delta < -0.03 ? -1 : 0;
    if (sign === 1) positiveTurns += 1;
    if (sign === -1) negativeTurns += 1;
    if (sign !== 0) {
      if (dominantDirection !== 0 && sign !== dominantDirection) {
        flipCount += 1;
      }
      dominantDirection = sign as 1 | -1;
    }

    prevAngle = angle;
  }

  const turnSamples = positiveTurns + negativeTurns;
  if (turnSamples < 10) return null;

  const dominantTurns = Math.max(positiveTurns, negativeTurns);
  if (dominantTurns / turnSamples < 0.8) return null;
  if (flipCount > 2) return null;

  const sweepDeg = Math.abs((totalSweep * 180) / Math.PI);
  if (sweepDeg < 300) return null;

  const speed = totalLength / Math.max(1, duration);
  if (speed < 0.08 || speed > 0.7) return null;

  const completion = Math.min(1, sweepDeg / 360);
  const shapeScore = Math.min(1, meanRadius / 90);
  const loopScore = Math.min(1, completion);
  const smoothScore = Math.min(1, 1 - radiusStdDev / Math.max(1, meanRadius));

  return 0.4 * shapeScore + 0.3 * loopScore + 0.3 * smoothScore;
}

/*
 * ─ Lumos ──────────────────────────────────────────────────────────────────────
 * Pattern: Short quick upward flick (< 200ms, length 40–120px).
 * Distinguishable from Protego by being SHORT and FAST.
 */
function detectLumos(points: Point[]): number | null {
  if (points.length < 6) return null;
  const dur = pathDurationMs(points);
  if (dur < 180 || dur > 1000) return null;

  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 32 });
  if (segs.length < 2) return null;

  let vScore = 0;
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i].direction;
    const b = segs[i + 1].direction;
    const isCaret =
      (a === "DIAG_UL" || a === "DIAG_UR")
      && (b === "DIAG_DL" || b === "DIAG_DR");
    if (!isCaret) continue;

    const lenScore = Math.min(1, (segs[i].length + segs[i + 1].length) / 160);
    const turn = orthogonalTurnScore(segs[i], segs[i + 1]);
    vScore = Math.max(vScore, 0.6 * lenScore + 0.4 * turn);
  }

  if (vScore < 0.5) return null;

  const { width, height } = getBounds(points);
  if (height < 30 || width < 18) return null;
  if (height < width * 0.8) return null;

  const vel = avgVelocity(points);
  if (vel < 0.1 || vel > 0.65) return null;

  return vScore;
}

/*
 * ─ Nox ────────────────────────────────────────────────────────────────────────
 * Pattern: Short downward curve (ARC_CW down, or ARC_CCW down).
 * A snappy, dismissive curved flick downward.
 */
function detectNox(points: Point[]): number | null {
  if (points.length < 6) return null;
  const dur = pathDurationMs(points);
  if (dur < 200 || dur > 1200) return null;

  const hasArc = detectArc(points, 95, BASE_CFG);
  if (!hasArc) return null;

  const segs = segmentPath(points, BASE_CFG);
  const hasTail = segs.some(
    (s) =>
      s.direction === "RIGHT"
      || s.direction === "LEFT"
      || s.direction === "DIAG_DR"
      || s.direction === "DIAG_UR",
  );
  if (!hasTail) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  if (sweep < 95 || sweep > 330) return null;

  const length = pathLength(points);
  if (length > 280) return null;

  const score = Math.min(1, sweep / 220);
  return score > 0.45 ? score : null;
}

/*
 * ─ Petrificus Totalus ─────────────────────────────────────────────────────────
 * Pattern: ARC (curve) followed by a straight line.
 * Specifically: curved portion → then one of UP/DOWN/LEFT/RIGHT.
 */
function detectPetrificusTotalus(points: Point[]): number | null {
  if (points.length < 9) return null;
  const duration = pathDurationMs(points);
  if (duration < 260 || duration > 1800) return null;

  const segs = segmentPath(points, BASE_CFG);
  if (segs.length < 2) return null;

  // Find first arc segment
  const firstArcIdx = segs.findIndex((s) => s.isCurved);
  if (firstArcIdx < 0) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  if (sweep < 140 || sweep > 430) return null;

  // After the hook-curve, require a pronounced straight tail.
  const afterArc = segs.slice(firstArcIdx + 1);
  const linearAfter = afterArc.find(
    (s) => !s.isCurved && (s.direction === "RIGHT" || s.direction === "LEFT") && s.length >= 65,
  );
  if (!linearAfter) return null;

  const arcSeg = segs[firstArcIdx];
  const arcScore = Math.min(1, Math.abs(arcSeg.totalAngleChange) / 1.6);
  const linScore = Math.min(1, linearAfter.length / 120);
  const score = 0.45 * arcScore + 0.55 * linScore;
  return score > 0.5 ? score : null;
}

// ─── Spell registry ───────────────────────────────────────────────────────────

export const SPELL_REGISTRY: Record<SpellId, SpellDefinition> = {
  // ── Attack ──────────────────────────────────────────────────────────────────

  expelliarmus: {
    id: "expelliarmus",
    displayName: "Expelliarmus",
    description: "Disarms your opponent, stripping their weapon.",
    category: "attack",
    cooldownMs: 1800,
    gestureHint: "Top bar then drop (┐)",
    color: "#ffbe5c",
    accentColor: "#ff9f43",
    soundFrequencies: [520, 260],
    soundWave: "sawtooth",
    effect: {
      damage: 10,
      durationMs: 3000,
      status: "disarmed",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectExpelliarmus(pts),
  },

  stupefy: {
    id: "stupefy",
    displayName: "Stupefy",
    description: "Stuns your opponent in a flash of red light.",
    category: "attack",
    cooldownMs: 2200,
    gestureHint: "Angled chevron (<)",
    color: "#ff4757",
    accentColor: "#ff6b81",
    soundFrequencies: [380, 140],
    soundWave: "square",
    effect: {
      damage: 15,
      durationMs: 4000,
      status: "stunned",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectStupefy(pts),
  },

  sectumsempra: {
    id: "sectumsempra",
    displayName: "Sectumsempra",
    description: "A dark slashing curse causing damage over time.",
    category: "attack",
    cooldownMs: 3000,
    gestureHint: "Fast diagonal slash",
    color: "#c0392b",
    accentColor: "#e74c3c",
    soundFrequencies: [200, 80],
    soundWave: "sawtooth",
    effect: {
      damage: 25,
      durationMs: 6000,
      status: "bleeding",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectSectumsempra(pts),
  },

  bombarda: {
    id: "bombarda",
    displayName: "Bombarda",
    description: "An explosive burst that deals heavy burst damage.",
    category: "attack",
    cooldownMs: 2800,
    gestureHint: "Vertical then horizontal (┌)",
    color: "#e67e22",
    accentColor: "#f39c12",
    soundFrequencies: [160, 60],
    soundWave: "square",
    effect: {
      damage: 30,
      durationMs: 0,
      status: "none",
      shieldStrength: 0,
      pushback: 40,
    },
    detect: (pts) => detectBombarda(pts),
  },

  aguamenti: {
    id: "aguamenti",
    displayName: "Aguamenti",
    description: "A wave of water that pushes and interrupts the opponent.",
    category: "attack",
    cooldownMs: 2400,
    gestureHint: "Loop with trailing stroke",
    color: "#74b9ff",
    accentColor: "#0984e3",
    soundFrequencies: [440, 660],
    soundWave: "sine",
    effect: {
      damage: 12,
      durationMs: 2000,
      status: "interrupted",
      shieldStrength: 0,
      pushback: 60,
    },
    detect: (pts) => detectAguamenti(pts),
  },

  // ── Defense ─────────────────────────────────────────────────────────────────

  protego: {
    id: "protego",
    displayName: "Protego",
    description: "Raises a magical shield that blocks one attack.",
    category: "defense",
    cooldownMs: 2500,
    gestureHint: "Single vertical stroke",
    color: "#8cf7ff",
    accentColor: "#00cec9",
    soundFrequencies: [420, 640],
    soundWave: "triangle",
    effect: {
      damage: 0,
      durationMs: 5000,
      status: "shielded",
      shieldStrength: 60,
      pushback: 0,
    },
    detect: (pts) => detectProtego(pts),
  },

  protego_maxima: {
    id: "protego_maxima",
    displayName: "Protego Maxima",
    description: "Draw a deliberate circular loop with your index fingertip to summon a powerful impenetrable shield.",
    category: "defense",
    cooldownMs: 2000,
    gestureHint: "Circle loop with index fingertip",
    color: "#a29bfe",
    accentColor: "#6c5ce7",
    soundFrequencies: [380, 760],
    soundWave: "triangle",
    effect: {
      damage: 0,
      durationMs: 8000,
      status: "shielded",
      shieldStrength: 100,
      pushback: 0,
    },
    detect: (pts, lm) => detectProtegoMaxima(pts, lm),
  },

  // ── Utility ─────────────────────────────────────────────────────────────────

  lumos: {
    id: "lumos",
    displayName: "Lumos",
    description: "A quick light flash — activates energy or reveals.",
    category: "utility",
    cooldownMs: 1000,
    gestureHint: "Inverted V stroke",
    color: "#ffeaa7",
    accentColor: "#fdcb6e",
    soundFrequencies: [660, 880],
    soundWave: "sine",
    effect: {
      damage: 0,
      durationMs: 2000,
      status: "none",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectLumos(pts),
  },

  nox: {
    id: "nox",
    displayName: "Nox",
    description: "Cancels ongoing effects and extinguishes light.",
    category: "utility",
    cooldownMs: 1200,
    gestureHint: "Short hooked curve",
    color: "#636e72",
    accentColor: "#2d3436",
    soundFrequencies: [300, 120],
    soundWave: "triangle",
    effect: {
      damage: 0,
      durationMs: 0,
      status: "none",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectNox(pts),
  },

  petrificus_totalus: {
    id: "petrificus_totalus",
    displayName: "Petrificus Totalus",
    description: "Immobilises the opponent completely.",
    category: "attack",
    cooldownMs: 3500,
    gestureHint: "Hook then horizontal line",
    color: "#55efc4",
    accentColor: "#00b894",
    soundFrequencies: [280, 560],
    soundWave: "triangle",
    effect: {
      damage: 8,
      durationMs: 7000,
      status: "frozen",
      shieldStrength: 0,
      pushback: 0,
    },
    detect: (pts) => detectPetrificusTotalus(pts),
  },
};

/** Ordered priority list — higher priority spells are checked first */
export const SPELL_PRIORITY: SpellId[] = [
  "protego_maxima",
  "stupefy",
  "sectumsempra",
  "bombarda",
  "petrificus_totalus",
  "aguamenti",
  "expelliarmus",
  "protego",
  "lumos",
  "nox",
];

export function getSpell(id: SpellId): SpellDefinition {
  return SPELL_REGISTRY[id];
}

export function getAllSpells(): SpellDefinition[] {
  return SPELL_PRIORITY.map((id) => SPELL_REGISTRY[id]);
}

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
  detectOpenPalm,
  avgVelocity,
  totalAngularSweep,
  pathDurationMs,
  DEFAULT_MOTION_CONFIG,
  type MotionSegment,
  type LandmarkLike,
} from "./motionGesture";
import type { Point } from "./gestureUtils";

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

// ─── Individual spell detectors ───────────────────────────────────────────────

/*
 * ─ Expelliarmus ───────────────────────────────────────────────────────────────
 * Pattern: RIGHT → DOWN (a quick "flick right-down" like a disarming swipe)
 * Fast motion, two clear segments.
 */
function detectExpelliarmus(points: Point[]): number | null {
  if (points.length < 6) return null;
  const segs = segmentPath(points, BASE_CFG);
  const score = matchSequence(segs, ["RIGHT", "DOWN"], {
    minVelocity: 0.15,
    minSegmentLength: 50,
  });
  return score > 0.35 ? score : null;
}

/*
 * ─ Stupefy ────────────────────────────────────────────────────────────────────
 * Pattern: RIGHT → LEFT → RIGHT (lightning-bolt back-and-forth jab)
 * Requires three alternating direction segments with good velocity.
 */
function detectStupefy(points: Point[]): number | null {
  if (points.length < 8) return null;
  const segs = segmentPath(points, BASE_CFG);
  const score = matchSequence(segs, ["RIGHT", "LEFT", "RIGHT"], {
    minVelocity: 0.18,
    minSegmentLength: 45,
  });
  return score > 0.4 ? score : null;
}

/*
 * ─ Sectumsempra ───────────────────────────────────────────────────────────────
 * Pattern: A fast diagonal slash (DIAG_UL, DIAG_UR, DIAG_DL, or DIAG_DR)
 * Key: HIGH velocity — it must be a fast slash, not a slow draw.
 */
function detectSectumsempra(points: Point[]): number | null {
  if (points.length < 5) return null;
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
  const segs = segmentPath(points, BASE_CFG);

  // Try all H→V combinations
  const horizontals = ["LEFT", "RIGHT"] as const;
  const verticals = ["UP", "DOWN"] as const;

  for (const h of horizontals) {
    for (const v of verticals) {
      const score = matchSequence(segs, [h, v], {
        minVelocity: 0.12,
        minSegmentLength: 55,
      });
      if (score > 0.38) return score;
    }
  }
  return null;
}

/*
 * ─ Aguamenti ──────────────────────────────────────────────────────────────────
 * Pattern: Smooth arc motion (ARC_CW or ARC_CCW), > 80° sweep.
 * Low velocity allowed (fluid, wave-like).
 */
function detectAguamenti(points: Point[]): number | null {
  if (points.length < 8) return null;
  const hasArc = detectArc(points, 80, BASE_CFG);
  if (!hasArc) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  const arcScore = Math.min(1, sweep / 140); // 140° = full confidence
  const vel = avgVelocity(points);
  const velScore = vel < 0.3 ? 1 : Math.max(0, 1 - (vel - 0.3) / 0.3); // lower vel = more fluid

  const score = 0.6 * arcScore + 0.4 * velScore;
  return score > 0.42 ? score : null;
}

/*
 * ─ Protego ────────────────────────────────────────────────────────────────────
 * Pattern: Single long UPWARD stroke (> 120px).
 * Speed moderate — deliberate shield raise.
 */
function detectProtego(points: Point[]): number | null {
  if (points.length < 6) return null;
  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 90 });
  if (segs.length === 0) return null;

  const upSegs = segs.filter((s) => s.direction === "UP");
  if (upSegs.length === 0) return null;

  const longestUp = upSegs.reduce(
    (best, s) => (s.length > best.length ? s : best),
    upSegs[0],
  );

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
  _points: Point[],
  landmarks: LandmarkLike[],
): number | null {
  const isOpen = detectOpenPalm(landmarks);
  if (!isOpen) return null;
  // Score based on how extended fingers are (simple proxy: tip-to-pip gap)
  return 0.88; // Pose-based — fixed high confidence when palm is detected
}

/*
 * ─ Lumos ──────────────────────────────────────────────────────────────────────
 * Pattern: Short quick upward flick (< 200ms, length 40–120px).
 * Distinguishable from Protego by being SHORT and FAST.
 */
function detectLumos(points: Point[]): number | null {
  if (points.length < 4) return null;
  const dur = pathDurationMs(points);
  const vel = avgVelocity(points);
  if (dur > 250 || vel < 0.25) return null; // Must be quick

  const segs = segmentPath(points, { ...BASE_CFG, minSegmentLength: 30 });
  const score = matchSequence(segs, ["UP"], {
    minVelocity: 0.25,
    minSegmentLength: 35,
  });
  // Extra score bonus for very fast flick
  const velBonus = Math.min(0.3, (vel - 0.25) * 0.6);
  return score + velBonus > 0.45 ? Math.min(1, score + velBonus) : null;
}

/*
 * ─ Nox ────────────────────────────────────────────────────────────────────────
 * Pattern: Short downward curve (ARC_CW down, or ARC_CCW down).
 * A snappy, dismissive curved flick downward.
 */
function detectNox(points: Point[]): number | null {
  if (points.length < 5) return null;
  const dur = pathDurationMs(points);
  if (dur > 350) return null;

  const hasArc = detectArc(points, 30, BASE_CFG);
  if (!hasArc) return null;

  const segs = segmentPath(points, BASE_CFG);
  const hasDown = segs.some(
    (s) =>
      s.direction === "DOWN" ||
      s.direction === "DIAG_DL" ||
      s.direction === "DIAG_DR",
  );
  if (!hasDown) return null;

  const sweep = Math.abs(totalAngularSweep(points));
  const score = Math.min(1, sweep / 80) * 0.85;
  return score > 0.38 ? score : null;
}

/*
 * ─ Petrificus Totalus ─────────────────────────────────────────────────────────
 * Pattern: ARC (curve) followed by a straight line.
 * Specifically: curved portion → then one of UP/DOWN/LEFT/RIGHT.
 */
function detectPetrificusTotalus(points: Point[]): number | null {
  if (points.length < 10) return null;
  const segs = segmentPath(points, BASE_CFG);
  if (segs.length < 2) return null;

  // Find first arc segment
  const firstArcIdx = segs.findIndex((s) => s.isCurved);
  if (firstArcIdx < 0) return null;

  // After the arc, is there a linear segment?
  const afterArc = segs.slice(firstArcIdx + 1);
  const linearAfter = afterArc.find((s) => !s.isCurved && s.length >= 60);
  if (!linearAfter) return null;

  const arcScore = Math.min(1, Math.abs(segs[firstArcIdx].totalAngleChange) / 1.2);
  const linScore = Math.min(1, linearAfter.length / 120);
  const score = 0.5 * arcScore + 0.5 * linScore;
  return score > 0.4 ? score : null;
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
    gestureHint: "RIGHT → DOWN",
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
    gestureHint: "RIGHT → LEFT → RIGHT",
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
    gestureHint: "HORIZONTAL → VERTICAL",
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
    gestureHint: "Smooth arc sweep",
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
    gestureHint: "Long upward stroke",
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
    description: "Hold your palm open to summon a powerful impenetrable shield.",
    category: "defense",
    cooldownMs: 4000,
    gestureHint: "Open palm (all fingers extended)",
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
    gestureHint: "Short fast upward flick",
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
    gestureHint: "Short curved downward flick",
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
    gestureHint: "Curve then straight line",
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

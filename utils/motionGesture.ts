/**
 * motionGesture.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Core motion-pattern recognition engine.
 *
 * Design:
 *   - Segments a raw fingertip path into directional "strokes"
 *   - Each stroke has a Direction, velocity, length, and curvature
 *   - Higher-level matchers combine strokes into spell patterns
 *
 * All coordinates are in raw canvas-pixel space (x right, y down).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Point } from "./gestureUtils";
export type { Point };

// ─── Direction primitives ─────────────────────────────────────────────────────

export type Direction =
  | "UP"
  | "DOWN"
  | "LEFT"
  | "RIGHT"
  | "DIAG_UL"
  | "DIAG_UR"
  | "DIAG_DL"
  | "DIAG_DR"
  | "ARC_CW"   // clockwise arc
  | "ARC_CCW"; // counter-clockwise arc

// ─── Motion segment ───────────────────────────────────────────────────────────

export type MotionSegment = {
  /** Dominant direction of this segment */
  direction: Direction;
  /** Total pixel length of the segment */
  length: number;
  /** Average pixel speed (px / ms) */
  velocity: number;
  /** Total signed angular change (radians; positive = CW turn) */
  totalAngleChange: number;
  /** Peak angular rate (rad / px) — high values = sharp turn */
  peakAngularRate: number;
  /** Whether this segment is primarily curved (arc-like) */
  isCurved: boolean;
  /** Raw sub-points */
  points: Point[];
};

// ─── Configuration ────────────────────────────────────────────────────────────

export type MotionConfig = {
  /** Minimum pixel length to consider a segment meaningful */
  minSegmentLength: number;
  /** Minimum pixel/ms speed to register movement */
  minVelocity: number;
  /** Angle-step (rad) that triggers a new segment boundary */
  sharpTurnThreshold: number;
  /** Curvature (rad/px) above which a segment is classified as an arc */
  curvatureThreshold: number;
  /** Pixel gap between sampled path points for angle computation */
  sampleStep: number;
};

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  minSegmentLength: 40,
  minVelocity: 0.08,           // px/ms
  sharpTurnThreshold: 0.85,    // radians
  curvatureThreshold: 0.018,   // radians per pixel
  sampleStep: 6,
};

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Signed angle between two vectors, in [-π, π] */
function signedAngleBetween(
  ax: number, ay: number,
  bx: number, by: number,
): number {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/** Bearing angle of a direction vector, 0 = right, CW positive */
function bearing(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

// ─── Direction classification ─────────────────────────────────────────────────

/** Map a (dx, dy) vector to one of the 8 discrete compass directions */
export function classifyDirection(dx: number, dy: number): Exclude<Direction, "ARC_CW" | "ARC_CCW"> {
  const angle = Math.atan2(dy, dx); // right=0, down=PI/2
  const deg = ((angle * 180) / Math.PI + 360) % 360;

  // 8-way with 45° bands
  if (deg < 22.5 || deg >= 337.5) return "RIGHT";
  if (deg < 67.5)  return "DIAG_DR";
  if (deg < 112.5) return "DOWN";
  if (deg < 157.5) return "DIAG_DL";
  if (deg < 202.5) return "LEFT";
  if (deg < 247.5) return "DIAG_UL";
  if (deg < 292.5) return "UP";
  return "DIAG_UR";
}

// ─── Path segmentation ────────────────────────────────────────────────────────

/**
 * Segment a raw path into motion segments.
 * Algorithm:
 *   1. Walk points; compute incremental angle change between consecutive step vectors.
 *   2. Accumulate into the current segment.
 *   3. When angle discontinuity > sharpTurnThreshold → start a new segment.
 *   4. Classify each segment as arc or linear based on integrated curvature.
 */
export function segmentPath(
  points: Point[],
  config: MotionConfig = DEFAULT_MOTION_CONFIG,
): MotionSegment[] {
  if (points.length < 4) return [];

  const step = Math.max(1, config.sampleStep);
  const segments: MotionSegment[] = [];
  let segStart = 0;
  let prevDx = 0;
  let prevDy = 0;
  let initialized = false;

  for (let i = step; i < points.length; i += step) {
    const p0 = points[i - step];
    const p1 = points[i];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;

    if (!initialized) {
      prevDx = dx;
      prevDy = dy;
      initialized = true;
      continue;
    }

    const turn = signedAngleBetween(prevDx, prevDy, dx, dy);

    if (Math.abs(turn) >= config.sharpTurnThreshold) {
      // Sharp turn → close current segment [segStart..i-step]
      const subPoints = points.slice(segStart, i - step + 1);
      const seg = buildSegment(subPoints, config);
      if (seg) segments.push(seg);
      segStart = i - step;
    }

    prevDx = dx;
    prevDy = dy;
  }

  // Tail segment
  const tailPoints = points.slice(segStart);
  const tailSeg = buildSegment(tailPoints, config);
  if (tailSeg) segments.push(tailSeg);

  return segments;
}

function buildSegment(
  pts: Point[],
  config: MotionConfig,
): MotionSegment | null {
  if (pts.length < 2) return null;

  // Compute length
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    len += Math.hypot(dx, dy);
  }

  if (len < config.minSegmentLength) return null;

  // Compute velocity (using timestamps if present)
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dt = (last.t ?? 0) - (first.t ?? 0);
  const velocity = dt > 0 ? len / dt : 0;

  // Compute average direction
  const totalDx = last.x - first.x;
  const totalDy = last.y - first.y;

  // Compute angular changes along the segment
  let totalAngle = 0;
  let peakAngularRate = 0;
  let prevDx = pts[1].x - pts[0].x;
  let prevDy = pts[1].y - pts[0].y;

  for (let i = 2; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const stepLen = Math.hypot(dx, dy);
    if (stepLen < 1e-6) continue;

    const turn = signedAngleBetween(prevDx, prevDy, dx, dy);
    totalAngle += turn;

    const angularRate = Math.abs(turn) / Math.max(1, stepLen);
    if (angularRate > peakAngularRate) peakAngularRate = angularRate;

    prevDx = dx;
    prevDy = dy;
  }

  const avgCurvature = len > 0 ? Math.abs(totalAngle) / len : 0;
  const isCurved = avgCurvature > config.curvatureThreshold;

  let direction: Direction;
  if (isCurved) {
    // Positive total angle = CW turn in screen-space (y-down)
    direction = totalAngle > 0 ? "ARC_CW" : "ARC_CCW";
  } else {
    direction = classifyDirection(totalDx, totalDy);
  }

  return {
    direction,
    length: len,
    velocity,
    totalAngleChange: totalAngle,
    peakAngularRate,
    isCurved,
    points: pts,
  };
}

// ─── Sequence matching ────────────────────────────────────────────────────────

/**
 * Check if `segments` contain `pattern` as a subsequence
 * (allowing gaps for noise segments that don't match).
 * Returns a confidence score [0, 1].
 */
export function matchSequence(
  segments: MotionSegment[],
  pattern: Direction[],
  options: {
    minVelocity?: number;
    minSegmentLength?: number;
  } = {},
): number {
  const minVel = options.minVelocity ?? 0;
  const minLen = options.minSegmentLength ?? 0;

  // Filter meaningful segments
  const valid = segments.filter(
    (s) => s.velocity >= minVel && s.length >= minLen,
  );

  if (valid.length < pattern.length) return 0;

  // Subsequence match
  let pi = 0;
  let matchedCount = 0;
  let totalConfidence = 0;

  for (const seg of valid) {
    if (pi >= pattern.length) break;
    if (directionsMatch(seg.direction, pattern[pi])) {
      pi++;
      matchedCount++;
      // Velocity bonus: faster = more intentional
      totalConfidence += Math.min(1, seg.velocity / 0.4);
    }
  }

  if (pi < pattern.length) return 0;

  return matchedCount > 0 ? totalConfidence / matchedCount : 0;
}

/** Loose direction match — handle arc → linear and exact */
function directionsMatch(actual: Direction, expected: Direction): boolean {
  if (actual === expected) return true;
  // Allow arc-cw / arc-ccw to satisfy a more generic ARC match
  if (expected === "ARC_CW" && actual === "ARC_CW") return true;
  if (expected === "ARC_CCW" && actual === "ARC_CCW") return true;
  return false;
}

// ─── Curvature / arc detection helpers ───────────────────────────────────────

/** Returns true when the path contains a single smooth arc >= minAngleDeg */
export function detectArc(
  points: Point[],
  minAngleDeg = 60,
  config: MotionConfig = DEFAULT_MOTION_CONFIG,
): boolean {
  const segs = segmentPath(points, config);
  if (segs.length === 0) return false;
  const arcSegs = segs.filter((s) => s.isCurved);
  if (arcSegs.length === 0) return false;

  const totalAngle = arcSegs.reduce(
    (acc, s) => acc + Math.abs(s.totalAngleChange),
    0,
  );
  return (totalAngle * 180) / Math.PI >= minAngleDeg;
}

/** Returns signed total angular sweep of the path in degrees */
export function totalAngularSweep(points: Point[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  let prevDx = points[1].x - points[0].x;
  let prevDy = points[1].y - points[0].y;
  for (let i = 2; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += signedAngleBetween(prevDx, prevDy, dx, dy);
    prevDx = dx;
    prevDy = dy;
  }
  return (total * 180) / Math.PI;
}

// ─── Palm / pose detection (landmark-based) ──────────────────────────────────

export type LandmarkLike = { x: number; y: number; z?: number };

/**
 * Detect an open-palm pose from MediaPipe hand landmarks.
 *
 * Criteria:
 *  - All 4 fingers (index→pinky) extended (tip above PIP joint in image coords)
 *  - Thumb extended
 *  - Hand is relatively stable (low landmark motion — checked externally)
 */
export function detectOpenPalm(landmarks: LandmarkLike[]): boolean {
  if (landmarks.length < 21) return false;

  // Tips: 4 (thumb), 8 (index), 12 (middle), 16 (ring), 20 (pinky)
  // MCPs: 2, 5, 9, 13, 17
  // PIPs: 3, 6, 10, 14, 18

  const fingerTips = [8, 12, 16, 20];
  const fingerPips = [6, 10, 14, 18];

  // Each finger is "extended" when the tip is above (smaller y) the PIP in image space
  for (let i = 0; i < fingerTips.length; i++) {
    const tip = landmarks[fingerTips[i]];
    const pip = landmarks[fingerPips[i]];
    if (!tip || !pip) return false;
    // In browser video (y increases down), extended = tip.y < pip.y
    if (tip.y >= pip.y - 0.02) return false;
  }

  // Thumb: tip (4) farther from palm center than IP (3)
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];
  const wrist = landmarks[0];
  if (!thumbTip || !thumbIp || !wrist) return false;

  const tipDist = Math.hypot(thumbTip.x - wrist.x, thumbTip.y - wrist.y);
  const ipDist = Math.hypot(thumbIp.x - wrist.x, thumbIp.y - wrist.y);

  return tipDist > ipDist * 0.85;
}

/**
 * Estimate hand stability by computing the average normalized velocity
 * across the last N landmark snapshots.
 */
export function computeLandmarkVelocity(
  prev: LandmarkLike[] | null,
  current: LandmarkLike[],
  dtMs: number,
): number {
  if (!prev || prev.length !== current.length || dtMs <= 0) return 999;

  let totalDist = 0;
  for (let i = 0; i < current.length; i++) {
    totalDist += Math.hypot(
      current[i].x - prev[i].x,
      current[i].y - prev[i].y,
    );
  }

  return (totalDist / current.length) / (dtMs / 1000);
}

// ─── Path normalisation for speed-invariance ─────────────────────────────────

/** Returns path duration in ms (requires t-stamped points) */
export function pathDurationMs(points: Point[]): number {
  if (points.length < 2) return 0;
  const t0 = points[0].t ?? 0;
  const t1 = points[points.length - 1].t ?? 0;
  return t1 - t0;
}

/** Average velocity in px/ms */
export function avgVelocity(points: Point[]): number {
  if (points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const dt = pathDurationMs(points);
  return dt > 0 ? len / dt : 0;
}

// ─── Debug helpers ────────────────────────────────────────────────────────────

/** Direction vector label for UI */
export const DIRECTION_LABELS: Record<Direction, string> = {
  UP: "↑",
  DOWN: "↓",
  LEFT: "←",
  RIGHT: "→",
  DIAG_UL: "↖",
  DIAG_UR: "↗",
  DIAG_DL: "↙",
  DIAG_DR: "↘",
  ARC_CW: "⟳",
  ARC_CCW: "⟲",
};

export const DIRECTION_COLORS: Record<Direction, string> = {
  UP: "#4cf2ff",
  DOWN: "#ff6b6b",
  LEFT: "#ffd700",
  RIGHT: "#a8ff78",
  DIAG_UL: "#c77dff",
  DIAG_UR: "#ff9f43",
  DIAG_DL: "#f9ca24",
  DIAG_DR: "#6ab04c",
  ARC_CW: "#fd79a8",
  ARC_CCW: "#74b9ff",
};

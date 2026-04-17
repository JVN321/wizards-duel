/**
 * MotionRecognizer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time spell recognition engine.
 *
 * Replaces the old $1 Unistroke shape-matcher.
 *
 * Key design decisions:
 *   - Continuously receives trail points via `feed()`
 *   - No pause-to-cast: runs recognition on a sliding window
 *   - Debounce cooldown prevents the same spell firing multiple times
 *   - Protego Maxima is a circle-trace gesture and runs separately
 *   - Returns a SpellMatch | null on each `recognize()` call
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  SPELL_REGISTRY,
  SPELL_PRIORITY,
  type SpellId,
  type SpellMatch,
} from "@/utils/spellRegistry";
import type { Point } from "@/utils/gestureUtils";
import {
  filterByMinDistance,
  smoothPath,
  pathLength,
} from "@/utils/gestureUtils";
import type { LandmarkLike } from "@/utils/motionGesture";

// ─── Settings ─────────────────────────────────────────────────────────────────

export type MotionRecognizerSettings = {
  /** Minimum trail pixel length before recognition is attempted */
  minTrailLength: number;
  /** Maximum trail length kept in the rolling buffer (px for path length) */
  maxTrailLengthPx: number;
  /** Debounce: after a spell fires, this many ms must pass before another fires */
  castDebounceMs: number;
  /** How much temporal smoothing to apply before recognition */
  smoothingFactor: number;
  /** Minimum point-to-point pixel distance for trail points */
  minMovement: number;
  /** Ms of hand stability required to trigger Protego Maxima */
  palmHoldMs: number;
  /** Landmark velocity (normalized units/s) below which the hand is "still" */
  palmStillThreshold: number;
};

export const DEFAULT_RECOGNIZER_SETTINGS: MotionRecognizerSettings = {
  minTrailLength: 60,
  maxTrailLengthPx: 1800,
  castDebounceMs: 700,
  smoothingFactor: 0.4,
  minMovement: 6,
  palmHoldMs: 1000,
  palmStillThreshold: 0.08,
};

// ─── Per-spell debounce map ───────────────────────────────────────────────────

type DebounceMap = Partial<Record<SpellId, number>>;

// ─── Main class ───────────────────────────────────────────────────────────────

export class MotionRecognizer {
  private settings: MotionRecognizerSettings;
  private trail: Point[] = [];
  private lastCastAt: DebounceMap = {};
  private prevLandmarks: LandmarkLike[] | null = null;
  private prevLandmarkTime: number | null = null;
  private palmHoldStart: number | null = null;

  constructor(settings: Partial<MotionRecognizerSettings> = {}) {
    this.settings = { ...DEFAULT_RECOGNIZER_SETTINGS, ...settings };
  }

  updateSettings(settings: Partial<MotionRecognizerSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  /** Feed a new raw point into the trail buffer */
  feed(point: Point): void {
    const s = this.settings;

    if (this.trail.length > 0) {
      const last = this.trail[this.trail.length - 1];
      const dist = Math.hypot(point.x - last.x, point.y - last.y);
      if (dist < s.minMovement) return;
    }

    this.trail.push(point);

    // Trim trail by path length to prevent unbounded growth
    while (this.trail.length > 5 && pathLength(this.trail) > s.maxTrailLengthPx) {
      this.trail.shift();
    }
  }

  /** Clear the current trail */
  clearTrail(): void {
    this.trail = [];
  }

  /** Return a copy of the current trail */
  getTrail(): Point[] {
    return [...this.trail];
  }

  /**
   * Run recognition on the current trail + landmarks.
   * Called every frame; returns the best spell match or null.
   *
   * Detectors run in priority order. First spell above threshold wins.
   */
  recognize(landmarks: LandmarkLike[]): SpellMatch | null {
    const s = this.settings;
    const now = Date.now();

    // ── Protego Maxima (circle-trace gesture) ──────────────────────────────
    const protegoMaximaResult = this.tryProtegoMaxima(this.trail, now);
    if (protegoMaximaResult) return protegoMaximaResult;

    // ── Trail-based detectors ──────────────────────────────────────────────
    if (pathLength(this.trail) < s.minTrailLength) return null;

    // Pre-process trail
    const cleaned = filterByMinDistance(this.trail, s.minMovement * 0.5);
    if (cleaned.length < 5) return null;
    const smoothed = smoothPath(cleaned, s.smoothingFactor);

    // Try spells in priority order (skip Protego Maxima — handled above)
    for (const spellId of SPELL_PRIORITY) {
      if (spellId === "protego_maxima") continue;

      // Check per-spell debounce
      const lastCast = this.lastCastAt[spellId] ?? 0;
      if (now - lastCast < s.castDebounceMs) continue;

      const spell = SPELL_REGISTRY[spellId];
      const confidence = spell.detect(smoothed, landmarks);

      if (confidence !== null && confidence > 0) {
        this.lastCastAt[spellId] = now;
        this.trail = []; // consume trail after successful detection
        return {
          spell,
          confidence: Math.min(1, confidence),
          detectedAt: now,
        };
      }
    }

    return null;
  }

  /** Update landmarks for future landmark-based detectors */
  updateLandmarks(landmarks: LandmarkLike[], timestamp: number): void {
    this.prevLandmarks = landmarks;
    this.prevLandmarkTime = timestamp;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private tryProtegoMaxima(points: Point[], now: number): SpellMatch | null {
    const s = this.settings;

    const spell = SPELL_REGISTRY["protego_maxima"];
    if (points.length < 15) return null;

    // Check debounce
    const lastCast = this.lastCastAt["protego_maxima"] ?? 0;
    if (now - lastCast < s.castDebounceMs * 3) return null;

    const confidence = spell.detect(points, []);
    if (confidence === null || confidence <= 0) {
      return null;
    }

    this.lastCastAt["protego_maxima"] = now;
    this.trail = [];

    return {
      spell,
      confidence,
      detectedAt: now,
    };
  }
}

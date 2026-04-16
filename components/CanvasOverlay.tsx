"use client";

import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@mediapipe/hands";
import type { Point } from "@/utils/gestureUtils";
import type { MotionSegment } from "@/utils/motionGesture";
import {
  DIRECTION_LABELS,
  DIRECTION_COLORS,
} from "@/utils/motionGesture";

// ─── Hand skeleton ────────────────────────────────────────────────────────────

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1],[1, 2],[2, 3],[3, 4],
  [0, 5],[5, 6],[6, 7],[7, 8],
  [5, 9],[9, 10],[10, 11],[11, 12],
  [9, 13],[13, 14],[14, 15],[15, 16],
  [13, 17],[0, 17],[17, 18],[18, 19],[19, 20],
];

// ─── Props ────────────────────────────────────────────────────────────────────

type CanvasOverlayProps = {
  sourceWidth: number;
  sourceHeight: number;
  landmarks: NormalizedLandmark[] | null;
  path: Point[];
  showSkeleton: boolean;
  showTrail: boolean;
  showDebug: boolean;
  active: boolean;
  trailColor: string;
  spellColor: string | null;
  spellFlashProgress: number;
  segments: MotionSegment[];
};

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawTrail(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  active: boolean,
  trailColor: string,
  sx: number,
  sy: number,
): void {
  if (path.length < 2) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Draw trail with gradient opacity (older = more transparent)
  for (let i = 1; i < path.length; i++) {
    const progress = i / path.length;
    const alpha = active ? 0.3 + progress * 0.7 : 0.15 + progress * 0.5;
    const width = active ? 3 + progress * 5 : 2 + progress * 3;

    ctx.beginPath();
    ctx.moveTo(path[i - 1].x * sx, path[i - 1].y * sy);
    ctx.lineTo(path[i].x * sx, path[i].y * sy);
    ctx.strokeStyle = trailColor;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.shadowColor = trailColor;
    ctx.shadowBlur = active ? 18 : 8;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawSpellFlash(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
  color: string,
): void {
  if (progress <= 0) return;

  const alpha = progress * 0.3;
  const gradient = ctx.createRadialGradient(
    width / 2, height / 2, 0,
    width / 2, height / 2, Math.max(width, height) * 0.75,
  );
  gradient.addColorStop(0, `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`);
  gradient.addColorStop(0.5, `${color}${Math.round(alpha * 0.5 * 255).toString(16).padStart(2, "0")}`);
  gradient.addColorStop(1, "transparent");

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(161, 242, 255, 0.7)";
  ctx.shadowColor = "rgba(161, 242, 255, 0.5)";
  ctx.shadowBlur = 8;

  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height);
    ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height);
    ctx.stroke();
  }

  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    const isIndexTip = i === 8;
    const r = isIndexTip ? 7 : 3;

    ctx.beginPath();
    ctx.arc(pt.x * width, pt.y * height, r, 0, Math.PI * 2);
    ctx.fillStyle = isIndexTip ? "#4cf2ff" : "#b0f5ff";
    ctx.shadowColor = isIndexTip ? "#4cf2ff" : "transparent";
    ctx.shadowBlur = isIndexTip ? 16 : 0;
    ctx.fill();
  }

  ctx.restore();
}

function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  segments: MotionSegment[],
  path: Point[],
  sx: number,
  sy: number,
): void {
  if (segments.length === 0 || path.length < 2) return;

  ctx.save();

  // Draw segment direction vectors at segment midpoints
  let pointIdx = 0;
  for (const seg of segments) {
    const pts = seg.points;
    if (pts.length < 2) continue;

    const mid = pts[Math.floor(pts.length / 2)];
    const color = DIRECTION_COLORS[seg.direction];
    const label = DIRECTION_LABELS[seg.direction];

    // Segment highlight line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Direction arrow label
    ctx.font = "bold 20px monospace";
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillText(label, mid.x * sx - 10, mid.y * sy - 14);

    // Velocity badge
    const velText = `${(seg.velocity * 1000).toFixed(0)}px/s`;
    ctx.font = "10px monospace";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.shadowBlur = 0;
    ctx.fillText(velText, mid.x * sx - 15, mid.y * sy + 16);

    pointIdx += seg.points.length;
  }

  ctx.restore();

  // HUD — segment list in top-right
  const padX = 10;
  const padY = 10;
  const lineH = 18;
  const boxW = 130;
  const boxH = segments.length * lineH + 16;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(padX, padY, boxW, boxH, 8);
  } else {
    ctx.rect(padX, padY, boxW, boxH);
  }
  ctx.fill();

  segments.forEach((seg, i) => {
    const color = DIRECTION_COLORS[seg.direction];
    const label = DIRECTION_LABELS[seg.direction];
    ctx.fillStyle = color;
    ctx.font = "bold 11px monospace";
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.fillText(
      `${label} ${seg.direction.padEnd(8)} ${seg.length.toFixed(0)}px`,
      padX + 8,
      padY + 12 + i * lineH,
    );
  });

  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CanvasOverlay({
  sourceWidth,
  sourceHeight,
  landmarks,
  path,
  showSkeleton,
  showTrail,
  showDebug,
  active,
  trailColor,
  spellColor,
  spellFlashProgress,
  segments,
}: CanvasOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sx = w / Math.max(1, sourceWidth);
    const sy = h / Math.max(1, sourceHeight);

    if (showTrail) {
      drawTrail(ctx, path, active, trailColor, sx, sy);
    }

    if (showSkeleton && landmarks) {
      drawSkeleton(ctx, landmarks, w, h);
    }

    if (showDebug) {
      drawDebugOverlay(ctx, segments, path, sx, sy);
    }

    if (spellColor && spellFlashProgress > 0) {
      drawSpellFlash(ctx, w, h, spellFlashProgress, spellColor);
    }
  }, [
    active, landmarks, path, segments,
    showDebug, showSkeleton, showTrail,
    sourceHeight, sourceWidth,
    spellColor, spellFlashProgress, trailColor,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    />
  );
}

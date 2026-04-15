"use client";

import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@mediapipe/hands";
import type { Point } from "@/utils/gestureUtils";

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

type CanvasOverlayProps = {
  sourceWidth: number;
  sourceHeight: number;
  landmarks: NormalizedLandmark[] | null;
  path: Point[];
  showSkeleton: boolean;
  showTrail: boolean;
  active: boolean;
  trailColor: string;
  spellName: string | null;
  spellFlashProgress: number;
};

const drawTrail = (
  ctx: CanvasRenderingContext2D,
  path: Point[],
  active: boolean,
  trailColor: string,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) => {
  if (path.length < 2) {
    return;
  }

  ctx.save();
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = trailColor;
  ctx.shadowColor = active ? trailColor : "#7bd1ff";
  ctx.shadowBlur = active ? 18 : 12;

  const scaleX = width / Math.max(1, sourceWidth);
  const scaleY = height / Math.max(1, sourceHeight);

  ctx.beginPath();
  ctx.moveTo(path[0].x * scaleX, path[0].y * scaleY);
  for (let i = 1; i < path.length; i += 1) {
    ctx.lineTo(path[i].x * scaleX, path[i].y * scaleY);
  }
  ctx.stroke();
  ctx.restore();
};

const drawSpellFlash = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
) => {
  if (progress <= 0) {
    return;
  }

  const alpha = progress * 0.24;
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    10,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, `rgba(192, 247, 255, ${alpha})`);
  gradient.addColorStop(1, "rgba(0,0,0,0)");

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
};

export function CanvasOverlay({
  sourceWidth,
  sourceHeight,
  landmarks,
  path,
  showSkeleton,
  showTrail,
  active,
  trailColor,
  spellName,
  spellFlashProgress,
}: CanvasOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (showTrail) {
      drawTrail(
        ctx,
        path,
        active,
        trailColor,
        sourceWidth,
        sourceHeight,
        width,
        height,
      );
    }

    if (showSkeleton && landmarks) {
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(161, 242, 255, 0.85)";
      ctx.shadowColor = "rgba(161, 242, 255, 0.6)";
      ctx.shadowBlur = 10;

      for (const [a, b] of HAND_CONNECTIONS) {
        const start = landmarks[a];
        const end = landmarks[b];

        ctx.beginPath();
        ctx.moveTo(start.x * width, start.y * height);
        ctx.lineTo(end.x * width, end.y * height);
        ctx.stroke();
      }

      for (let i = 0; i < landmarks.length; i += 1) {
        const point = landmarks[i];
        const isIndexTip = i === 8;
        const radius = isIndexTip ? 8 : 3.3;

        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
        ctx.fillStyle = isIndexTip ? "#4cf2ff" : "#d5fcff";
        ctx.shadowColor = isIndexTip ? "#4cf2ff" : "transparent";
        ctx.shadowBlur = isIndexTip ? 18 : 0;
        ctx.fill();
      }

      ctx.restore();
    }

    if (spellName) {
      drawSpellFlash(ctx, width, height, spellFlashProgress);
    }
  }, [
    active,
    landmarks,
    path,
    showSkeleton,
    showTrail,
    spellFlashProgress,
    spellName,
    sourceHeight,
    sourceWidth,
    trailColor,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    />
  );
}

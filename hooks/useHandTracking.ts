"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Results } from "@mediapipe/hands";

export type TrackingSettings = {
  detectionConfidence: number;
  trackingConfidence: number;
  maxHands: number;
  modelComplexity: 0 | 1;
};

export type GestureState = {
  isActive: boolean;
  drawTip: { x: number; y: number } | null;
};

type HandsLike = {
  close: () => Promise<void>;
  onResults: (listener: (results: Results) => void) => void;
  send: (inputs: { image: HTMLVideoElement }) => Promise<void>;
  setOptions: (options: {
    modelComplexity: 0 | 1;
    maxNumHands: number;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
  }) => void | Promise<void>;
};

type HandsConstructor = new (config?: {
  locateFile?: (path: string, prefix?: string) => string;
}) => HandsLike;

export type TrackingFrame = {
  landmarks: NormalizedLandmark[] | null;
  gesture: GestureState;
  videoSize: { width: number; height: number };
  timestamp: number;
};

declare global {
  interface Window {
    Hands?: HandsConstructor;
  }
}

const MEDIAPIPE_HANDS_SCRIPT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";

let handsScriptPromise: Promise<void> | null = null;

const ensureHandsScript = async (): Promise<void> => {
  if (typeof window === "undefined") {
    return;
  }

  if (window.Hands) {
    return;
  }

  if (!handsScriptPromise) {
    handsScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[data-mediapipe-hands="true"]',
      );

      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Failed to load MediaPipe Hands script.")),
          { once: true },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = MEDIAPIPE_HANDS_SCRIPT;
      script.async = true;
      script.dataset.mediapipeHands = "true";
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load MediaPipe Hands script."));
      document.head.appendChild(script);
    });
  }

  await handsScriptPromise;
};

export const useHandTracking = (
  settings: TrackingSettings,
  onFrame?: (frame: TrackingFrame) => void,
) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<HandsLike | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const sendingRef = useRef(false);
  const lastFrameTimeRef = useRef(0);
  const lastUiEmitTimeRef = useRef(0);
  const lastFpsUiTimeRef = useRef(0);
  const fpsRef = useRef(0);
  const onFrameRef = useRef(onFrame);

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 960, height: 540 });
  const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null);
  const [gesture, setGesture] = useState<GestureState>({
    isActive: false,
    drawTip: null,
  });

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  const stop = useCallback(() => {
    runningRef.current = false;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) {
      return;
    }

    setError(null);
    setIsReady(false);

    try {
      await ensureHandsScript();

      if (!window.Hands) {
        throw new Error("MediaPipe Hands failed to load.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 60, min: 30 },
          facingMode: "user",
        },
        audio: false,
      });

      const video = videoRef.current;
      if (!video) {
        throw new Error("Video element is not mounted.");
      }

      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();

      setVideoSize({
        width: video.videoWidth || 960,
        height: video.videoHeight || 540,
      });

      if (!handsRef.current) {
        const hands = new window.Hands({
          locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });

        hands.onResults((results: Results) => {
          const hand = results.multiHandLandmarks?.[0] ?? null;
          const tip = hand?.[8] ?? null;

          const currentVideoSize = {
            width: video.videoWidth || 960,
            height: video.videoHeight || 540,
          };

          setVideoSize((prev) => {
            if (
              prev.width === currentVideoSize.width &&
              prev.height === currentVideoSize.height
            ) {
              return prev;
            }
            return currentVideoSize;
          });

          const nextGesture: GestureState = {
            isActive: Boolean(tip),
            drawTip: tip ? { x: tip.x, y: tip.y } : null,
          };

          const now = performance.now();
          if (now - lastUiEmitTimeRef.current >= 33) {
            setLandmarks(hand);
            setGesture(nextGesture);
            lastUiEmitTimeRef.current = now;
          }

          onFrameRef.current?.({
            landmarks: hand,
            gesture: nextGesture,
            videoSize: currentVideoSize,
            timestamp: now,
          });

          const elapsed = now - lastFrameTimeRef.current;
          if (elapsed > 0) {
            const current = 1000 / elapsed;
            fpsRef.current = fpsRef.current * 0.8 + current * 0.2;
            if (now - lastFpsUiTimeRef.current >= 220) {
              setFps(Math.round(fpsRef.current));
              lastFpsUiTimeRef.current = now;
            }
          }
          lastFrameTimeRef.current = now;
        });

        handsRef.current = hands;
      }

      await handsRef.current.setOptions({
        modelComplexity: settings.modelComplexity,
        maxNumHands: settings.maxHands,
        minDetectionConfidence: settings.detectionConfidence,
        minTrackingConfidence: settings.trackingConfidence,
      });

      runningRef.current = true;

      const processFrame = (): void => {
        if (!runningRef.current) {
          return;
        }

        const player = videoRef.current;
        const tracker = handsRef.current;

        if (
          player &&
          tracker &&
          player.readyState >= 2 &&
          !sendingRef.current
        ) {
          sendingRef.current = true;
          void tracker.send({ image: player }).finally(() => {
            sendingRef.current = false;
          });
        }

        rafRef.current = requestAnimationFrame(processFrame);
      };

      setIsReady(true);
      processFrame();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unable to access camera or initialize MediaPipe Hands.";
      setError(message);
      stop();
    }
  }, [settings, stop]);

  useEffect(() => {
    if (handsRef.current) {
      void handsRef.current.setOptions({
        modelComplexity: settings.modelComplexity,
        maxNumHands: settings.maxHands,
        minDetectionConfidence: settings.detectionConfidence,
        minTrackingConfidence: settings.trackingConfidence,
      });
    }
  }, [settings]);

  useEffect(() => {
    void start();
    return () => {
      stop();
      if (handsRef.current) {
        void handsRef.current.close();
        handsRef.current = null;
      }
    };
  }, [start, stop]);

  return {
    videoRef,
    landmarks,
    gesture,
    fps,
    isReady,
    error,
    videoSize,
    start,
    stop,
  };
};

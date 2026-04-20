"use client";

import { useState } from "react";
import type { DuelSettings, InputMode } from "@/utils/settingsManager";

type SettingsPanelProps = {
  settings: DuelSettings;
  onChange: (next: DuelSettings) => void;
};

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatter?: (value: number) => string;
};

function Slider({ label, value, min, max, step, onChange, formatter }: SliderProps) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-slate-100 ">
      <span className="flex items-center justify-between uppercase tracking-[0.13em] text-slate-300">
        <span>{label}</span>
        <span>{formatter ? formatter(value) : value.toFixed(step < 1 ? 2 : 0)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="accent-cyan-300"
      />
    </label>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition ${
        active
          ? "border-cyan-300/40 bg-cyan-400/12 text-cyan-100"
          : "border-slate-300/15 bg-slate-950/45 text-slate-300 hover:border-slate-200/30"
      }`}
    >
      {label}
    </button>
  );
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const [view, setView] = useState<"basic" | "advanced">("basic");

  const setMode = (mode: InputMode) => {
    onChange({
      ...settings,
      input: {
        ...settings.input,
        mode,
      },
    });
  };

  const detectionSection = (
    <section className="space-y-2.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
        Detection
      </h3>
      <Slider
        label="Sensitivity"
        value={settings.detection.sensitivity}
        min={0.1}
        max={1}
        step={0.01}
        onChange={(value) =>
          onChange({
            ...settings,
            detection: { ...settings.detection, sensitivity: value },
          })
        }
        formatter={(v) => `${Math.round(v * 100)}%`}
      />
      <Slider
        label="Confidence Threshold"
        value={settings.detection.confidenceThreshold}
        min={0.05}
        max={0.98}
        step={0.01}
        onChange={(value) =>
          onChange({
            ...settings,
            detection: { ...settings.detection, confidenceThreshold: value },
          })
        }
      />
      <Slider
        label="Gesture Timeout (ms)"
        value={settings.detection.gestureTimeoutMs}
        min={120}
        max={1800}
        step={10}
        onChange={(value) =>
          onChange({
            ...settings,
            detection: { ...settings.detection, gestureTimeoutMs: value },
          })
        }
      />
      {view === "advanced" && (
        <>
          <Slider
            label="Smoothing Factor"
            value={settings.detection.smoothingFactor}
            min={0.05}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              onChange({
                ...settings,
                detection: { ...settings.detection, smoothingFactor: value },
              })
            }
          />
          <Slider
            label="Minimum Gesture Length"
            value={settings.detection.minimumGestureLength}
            min={20}
            max={1200}
            step={5}
            onChange={(value) =>
              onChange({
                ...settings,
                detection: { ...settings.detection, minimumGestureLength: value },
              })
            }
          />
          <Slider
            label="Recognition Debounce (ms)"
            value={settings.detection.recognitionDebounceMs}
            min={120}
            max={2400}
            step={10}
            onChange={(value) =>
              onChange({
                ...settings,
                detection: { ...settings.detection, recognitionDebounceMs: value },
              })
            }
          />
          <Slider
            label="Recognition Frequency"
            value={settings.detection.recognitionFrequencyHz}
            min={4}
            max={60}
            step={1}
            onChange={(value) =>
              onChange({
                ...settings,
                detection: { ...settings.detection, recognitionFrequencyHz: value },
              })
            }
            formatter={(v) => `${Math.round(v)} Hz`}
          />
        </>
      )}
    </section>
  );

  const trailSection = (
    <section className="space-y-2.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
        Trail
      </h3>
      <Slider
        label="Stroke Thickness"
        value={settings.trail.strokeThickness}
        min={1}
        max={14}
        step={0.5}
        onChange={(value) =>
          onChange({
            ...settings,
            trail: { ...settings.trail, strokeThickness: value },
          })
        }
      />
      <Slider
        label="Fade Duration"
        value={settings.trail.fadeDurationMs}
        min={80}
        max={2400}
        step={20}
        onChange={(value) =>
          onChange({
            ...settings,
            trail: { ...settings.trail, fadeDurationMs: value },
          })
        }
        formatter={(v) => `${Math.round(v)} ms`}
      />
      {view === "advanced" && (
        <Slider
          label="Trail Length"
          value={settings.trail.trailLength}
          min={60}
          max={1200}
          step={10}
          onChange={(value) =>
            onChange({
              ...settings,
              trail: { ...settings.trail, trailLength: value },
            })
          }
        />
      )}
    </section>
  );

  const modeSpecificInputSection = (
    <section className="space-y-2.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
        {settings.input.mode === "MOUSE" ? "Mouse Controls" : "Camera Controls"}
      </h3>
      {settings.input.mode === "MOUSE" && (
        <>
          <Slider
            label="Mouse Smoothing"
            value={settings.input.mouse.smoothing}
            min={0}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              onChange({
                ...settings,
                input: {
                  ...settings.input,
                  mouse: { ...settings.input.mouse, smoothing: value },
                },
              })
            }
          />
          <Slider
            label="Mouse Speed Scaling"
            value={settings.input.mouse.speedScaling}
            min={0.35}
            max={2.8}
            step={0.01}
            onChange={(value) =>
              onChange({
                ...settings,
                input: {
                  ...settings.input,
                  mouse: { ...settings.input.mouse, speedScaling: value },
                },
              })
            }
          />
        </>
      )}

      {settings.input.mode === "CV" && (
        <>
          <label className="flex items-center justify-between rounded-md border border-cyan-100/10 px-2 py-1.5 text-xs text-slate-200">
            Mirror Camera
            <input
              type="checkbox"
              checked={settings.input.camera.mirror}
              onChange={(event) =>
                onChange({
                  ...settings,
                  input: {
                    ...settings.input,
                    camera: {
                      ...settings.input.camera,
                      mirror: event.currentTarget.checked,
                    },
                  },
                })
              }
              className="h-4 w-4 accent-cyan-300"
            />
          </label>
          <Slider
            label="Detection Confidence"
            value={settings.input.camera.detectionConfidence}
            min={0.2}
            max={0.98}
            step={0.01}
            onChange={(value) =>
              onChange({
                ...settings,
                input: {
                  ...settings.input,
                  camera: {
                    ...settings.input.camera,
                    detectionConfidence: value,
                  },
                },
              })
            }
          />
          <Slider
            label="FPS Cap"
            value={settings.input.camera.fpsCap}
            min={8}
            max={60}
            step={1}
            onChange={(value) =>
              onChange({
                ...settings,
                input: {
                  ...settings.input,
                  camera: {
                    ...settings.input.camera,
                    fpsCap: Math.round(value),
                  },
                },
              })
            }
            formatter={(v) => `${Math.round(v)} fps`}
          />
        </>
      )}
    </section>
  );

  const inputModeSection = (
    <section className="space-y-2.5 border-t border-cyan-100/10 pt-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
        Input Mode
      </h3>

      <div className="flex items-center gap-2">
        <ModeButton
          active={settings.input.mode === "CV"}
          label="Camera Mode"
          onClick={() => setMode("CV")}
        />
        <ModeButton
          active={settings.input.mode === "MOUSE"}
          label="Mouse Mode"
          onClick={() => setMode("MOUSE")}
        />
      </div>
    </section>
  );

  return (
    <aside className="w-85 max-w-[92vw] max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-300/15 bg-slate-950/92 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-serif text-base tracking-wide text-cyan-100">Settings</h2>
        <div className="flex items-center gap-1">
          <ModeButton active={view === "basic"} label="Basic" onClick={() => setView("basic")} />
          <ModeButton active={view === "advanced"} label="Advanced" onClick={() => setView("advanced")} />
        </div>
      </div>

      <div className="mt-3 space-y-4">
        {detectionSection}
        {trailSection}
        {modeSpecificInputSection}
        {inputModeSection}
      </div>
    </aside>
  );
}

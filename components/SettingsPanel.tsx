"use client";

import type { TrackingSettings } from "@/hooks/useHandTracking";
import type { RecognitionSettings } from "@/components/SpellRecognizer";

export type DrawingSettings = {
  smoothingFactor: number;
  minMovement: number;
  pauseDurationMs: number;
  predictionMs: number;
  showSkeleton: boolean;
  showTrail: boolean;
  trailColor: string;
};

export type SpellUiSettings = {
  alwaysOn: true;
};

type SettingsPanelProps = {
  tracking: TrackingSettings;
  drawing: DrawingSettings;
  recognition: RecognitionSettings;
  ui: SpellUiSettings;
  onTrackingChange: (next: TrackingSettings) => void;
  onDrawingChange: (next: DrawingSettings) => void;
  onRecognitionChange: (next: RecognitionSettings) => void;
  onUiChange: (next: SpellUiSettings) => void;
};

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  return (
    <label className="flex flex-col gap-2 text-sm text-slate-200">
      <span className="flex items-center justify-between text-xs uppercase tracking-[0.13em] text-slate-300">
        <span>{label}</span>
        <span>{value.toFixed(step < 1 ? 2 : 0)}</span>
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

export function SettingsPanel({
  tracking,
  drawing,
  recognition,
  ui,
  onTrackingChange,
  onDrawingChange,
  onRecognitionChange,
  onUiChange,
}: SettingsPanelProps) {
  return (
    <aside className="w-full rounded-2xl border border-slate-300/15 bg-slate-950/65 p-4 backdrop-blur lg:w-[320px]">
      <h2 className="font-serif text-lg tracking-wide text-cyan-100">Spell Controls</h2>

      <div className="mt-4 space-y-5">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200/80">
            Tracking
          </h3>
          <Slider
            label="Detection Confidence"
            value={tracking.detectionConfidence}
            min={0.2}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              onTrackingChange({ ...tracking, detectionConfidence: value })
            }
          />
          <Slider
            label="Tracking Confidence"
            value={tracking.trackingConfidence}
            min={0.2}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              onTrackingChange({ ...tracking, trackingConfidence: value })
            }
          />
          <Slider
            label="Max Hands"
            value={tracking.maxHands}
            min={1}
            max={1}
            step={1}
            onChange={(value) =>
              onTrackingChange({ ...tracking, maxHands: value })
            }
          />
          <Slider
            label="Model Complexity"
            value={tracking.modelComplexity}
            min={0}
            max={1}
            step={1}
            onChange={(value) =>
              onTrackingChange({ ...tracking, modelComplexity: value as 0 | 1 })
            }
          />
          <label className="flex flex-col gap-2 text-sm text-slate-200">
            <span className="text-xs uppercase tracking-[0.13em] text-slate-300">
              Tracking Mode
            </span>
            <select
              value={ui.alwaysOn ? "always" : "always"}
              onChange={() => onUiChange({ ...ui, alwaysOn: true })}
              className="rounded-md border border-cyan-200/20 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              <option value="always">Always Track Index Tip</option>
            </select>
          </label>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200/80">
            Drawing
          </h3>
          <Slider
            label="Smoothing"
            value={drawing.smoothingFactor}
            min={0.05}
            max={0.9}
            step={0.01}
            onChange={(value) => onDrawingChange({ ...drawing, smoothingFactor: value })}
          />
          <Slider
            label="Min Movement"
            value={drawing.minMovement}
            min={2}
            max={28}
            step={1}
            onChange={(value) => onDrawingChange({ ...drawing, minMovement: value })}
          />
          <Slider
            label="Pause To Cast (ms)"
            value={drawing.pauseDurationMs}
            min={140}
            max={900}
            step={10}
            onChange={(value) => onDrawingChange({ ...drawing, pauseDurationMs: value })}
          />
          <Slider
            label="Prediction Window (ms)"
            value={drawing.predictionMs}
            min={40}
            max={260}
            step={10}
            onChange={(value) => onDrawingChange({ ...drawing, predictionMs: value })}
          />
          <label className="flex items-center justify-between rounded-md border border-cyan-100/10 px-3 py-2 text-sm text-slate-200">
            Skeleton Visible
            <input
              type="checkbox"
              checked={drawing.showSkeleton}
              onChange={(event) =>
                onDrawingChange({ ...drawing, showSkeleton: event.currentTarget.checked })
              }
              className="h-4 w-4 accent-cyan-300"
            />
          </label>
          <label className="flex items-center justify-between rounded-md border border-cyan-100/10 px-3 py-2 text-sm text-slate-200">
            Drawing Trail
            <input
              type="checkbox"
              checked={drawing.showTrail}
              onChange={(event) =>
                onDrawingChange({ ...drawing, showTrail: event.currentTarget.checked })
              }
              className="h-4 w-4 accent-cyan-300"
            />
          </label>
          <label className="flex items-center justify-between rounded-md border border-cyan-100/10 px-3 py-2 text-sm text-slate-200">
            Trail Color
            <input
              type="color"
              value={drawing.trailColor}
              onChange={(event) =>
                onDrawingChange({ ...drawing, trailColor: event.currentTarget.value })
              }
              className="h-7 w-10 cursor-pointer border-0 bg-transparent"
            />
          </label>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200/80">
            Recognition
          </h3>
          <Slider
            label="Matching Tolerance"
            value={recognition.shapeMatchingTolerance}
            min={0.2}
            max={0.95}
            step={0.01}
            onChange={(value) =>
              onRecognitionChange({ ...recognition, shapeMatchingTolerance: value })
            }
          />
          <Slider
            label="Min Stroke Length"
            value={recognition.minStrokeLength}
            min={80}
            max={900}
            step={10}
            onChange={(value) =>
              onRecognitionChange({ ...recognition, minStrokeLength: value })
            }
          />
          <Slider
            label="Resample Resolution"
            value={recognition.resamplingResolution}
            min={32}
            max={160}
            step={1}
            onChange={(value) =>
              onRecognitionChange({ ...recognition, resamplingResolution: value })
            }
          />
        </section>
      </div>
    </aside>
  );
}

import {
  makeCircle,
  makeSpiral,
  makeTriangle,
  makeZigZag,
  normalizePath,
  normalizedScore,
  pathDistance,
  pathLength,
  Point,
} from "@/utils/gestureUtils";

export type SpellName =
  | "Protego"
  | "Stupefy"
  | "Expelliarmus"
  | "Expecto Patronum";

export type RecognitionSettings = {
  shapeMatchingTolerance: number;
  minStrokeLength: number;
  resamplingResolution: number;
};

export type SpellMatch = {
  spell: SpellName;
  score: number;
};

type Template = {
  name: string;
  spell: SpellName;
  points: Point[];
};

const buildTemplates = (resolution: number): Template[] => {
  const templates: Omit<Template, "points">[] = [
    { name: "circle", spell: "Protego" },
    { name: "triangle", spell: "Expelliarmus" },
    { name: "zigzag", spell: "Stupefy" },
    { name: "zigzag-mirror", spell: "Stupefy" },
    { name: "spiral-cw", spell: "Expecto Patronum" },
    { name: "spiral-ccw", spell: "Expecto Patronum" },
  ];

  const pointsByName: Record<string, Point[]> = {
    circle: makeCircle(),
    triangle: makeTriangle(),
    zigzag: makeZigZag(),
    "zigzag-mirror": makeZigZag().map((p) => ({ x: -p.x, y: p.y })),
    "spiral-cw": makeSpiral(3, true),
    "spiral-ccw": makeSpiral(3, false),
  };

  return templates.map((template) => ({
    ...template,
    points: normalizePath(pointsByName[template.name], resolution),
  }));
};

export class SpellRecognizer {
  private templateResolution = 96;

  private templates: Template[] = buildTemplates(this.templateResolution);

  private ensureResolution(resolution: number): void {
    if (this.templateResolution !== resolution) {
      this.templateResolution = resolution;
      this.templates = buildTemplates(resolution);
    }
  }

  recognize(rawPath: Point[], settings: RecognitionSettings): SpellMatch | null {
    if (pathLength(rawPath) < settings.minStrokeLength) {
      return null;
    }

    this.ensureResolution(settings.resamplingResolution);
    const normalized = normalizePath(rawPath, settings.resamplingResolution);

    let best: Template | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const template of this.templates) {
      const scoreDistance = pathDistance(normalized, template.points);
      if (scoreDistance < bestDistance) {
        bestDistance = scoreDistance;
        best = template;
      }
    }

    if (!best) {
      return null;
    }

    const score = normalizedScore(bestDistance);
    if (score < settings.shapeMatchingTolerance) {
      return null;
    }

    return {
      spell: best.spell,
      score,
    };
  }
}

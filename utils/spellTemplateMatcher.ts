import type { Point } from "@/utils/gestureUtils";
import type { SpellDefinition, SpellId } from "@/utils/spellRegistry";
import { getAllSpells } from "@/utils/spellRegistry";

export type TemplateMatch = {
  spell: SpellDefinition;
  confidence: number;
};

type TemplateOptions = {
  limit?: number;
  gridSize?: number;
};

const DEFAULT_GRID_SIZE = 28;

const TEMPLATES: Record<SpellId, Point[]> = {
  expelliarmus: [
    { x: 0.15, y: 0.3 },
    { x: 0.78, y: 0.3 },
    { x: 0.78, y: 0.78 },
  ],
  stupefy: [
    { x: 0.8, y: 0.24 },
    { x: 0.35, y: 0.5 },
    { x: 0.8, y: 0.76 },
  ],
  sectumsempra: [
    { x: 0.22, y: 0.24 },
    { x: 0.78, y: 0.78 },
  ],
  bombarda: [
    { x: 0.3, y: 0.78 },
    { x: 0.3, y: 0.26 },
    { x: 0.78, y: 0.26 },
  ],
  aguamenti: [
    { x: 0.26, y: 0.58 },
    { x: 0.3, y: 0.38 },
    { x: 0.5, y: 0.3 },
    { x: 0.67, y: 0.4 },
    { x: 0.64, y: 0.64 },
    { x: 0.46, y: 0.72 },
    { x: 0.28, y: 0.62 },
    { x: 0.26, y: 0.5 },
    { x: 0.74, y: 0.82 },
  ],
  protego: [
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.82 },
  ],
  protego_maxima: Array.from({ length: 60 }, (_, i) => {
    const angle = (i / 59) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(angle) * 0.32,
      y: 0.5 + Math.sin(angle) * 0.32,
    };
  }),
  lumos: [
    { x: 0.24, y: 0.74 },
    { x: 0.5, y: 0.26 },
    { x: 0.76, y: 0.74 },
  ],
  nox: [
    { x: 0.28, y: 0.66 },
    { x: 0.38, y: 0.44 },
    { x: 0.58, y: 0.44 },
    { x: 0.66, y: 0.56 },
    { x: 0.58, y: 0.66 },
    { x: 0.48, y: 0.62 },
  ],
  petrificus_totalus: [
    { x: 0.34, y: 0.32 },
    { x: 0.24, y: 0.52 },
    { x: 0.36, y: 0.68 },
    { x: 0.58, y: 0.68 },
    { x: 0.78, y: 0.68 },
  ],
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const normalizeToUnitSquare = (points: Point[]): Point[] => {
  if (points.length === 0) {
    return [];
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const extent = Math.max(1e-6, width, height);
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;

  return points.map((p) => ({
    x: (p.x - centerX) / extent + 0.5,
    y: (p.y - centerY) / extent + 0.5,
  }));
};

const toGridIndex = (x: number, y: number, size: number): number => y * size + x;

const paint = (grid: Uint8Array, x: number, y: number, size: number, radius = 1): void => {
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const gx = x + ox;
      const gy = y + oy;
      if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
      grid[toGridIndex(gx, gy, size)] = 1;
    }
  }
};

const rasterizePath = (path: Point[], size: number): Uint8Array => {
  const normalized = normalizeToUnitSquare(path);
  const grid = new Uint8Array(size * size);
  if (normalized.length === 0) {
    return grid;
  }

  const toCell = (value: number): number => {
    const cell = Math.round(clamp01(value) * (size - 1));
    return Math.max(0, Math.min(size - 1, cell));
  };

  for (let i = 1; i < normalized.length; i += 1) {
    const a = normalized[i - 1];
    const b = normalized[i];
    const ax = toCell(a.x);
    const ay = toCell(a.y);
    const bx = toCell(b.x);
    const by = toCell(b.y);

    const steps = Math.max(2, Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = Math.round(ax + (bx - ax) * t);
      const y = Math.round(ay + (by - ay) * t);
      paint(grid, x, y, size, 1);
    }
  }

  return grid;
};

const diceScore = (a: Uint8Array, b: Uint8Array): number => {
  let aCount = 0;
  let bCount = 0;
  let intersection = 0;

  for (let i = 0; i < a.length; i += 1) {
    if (a[i]) aCount += 1;
    if (b[i]) bCount += 1;
    if (a[i] && b[i]) intersection += 1;
  }

  if (aCount === 0 || bCount === 0) {
    return 0;
  }

  return (2 * intersection) / (aCount + bCount);
};

const pathVariants = (points: Point[]): Point[][] => {
  if (points.length === 0) {
    return [];
  }

  const base = normalizeToUnitSquare(points);
  const mirrorX = (pts: Point[]): Point[] => pts.map((p) => ({ x: 1 - p.x, y: p.y }));
  const mirrorY = (pts: Point[]): Point[] => pts.map((p) => ({ x: p.x, y: 1 - p.y }));

  return [
    base,
    [...base].reverse(),
    mirrorX(base),
    [...mirrorX(base)].reverse(),
    mirrorY(base),
    [...mirrorY(base)].reverse(),
    mirrorX(mirrorY(base)),
    [...mirrorX(mirrorY(base))].reverse(),
  ];
};

const SPELL_BOOST: Partial<Record<SpellId, number>> = {
  lumos: 1.18,
  nox: 1.1,
  petrificus_totalus: 1.08,
};

export const evaluateSpellTemplateProbabilities = (
  points: Point[],
  options: TemplateOptions = {},
): TemplateMatch[] => {
  if (points.length < 4) {
    return [];
  }

  const variants = pathVariants(points);
  if (variants.length === 0) {
    return [];
  }

  const gridSize = Math.max(18, Math.floor(options.gridSize ?? DEFAULT_GRID_SIZE));
  const variantGrids = variants.map((variant) => rasterizePath(variant, gridSize));

  const result = getAllSpells()
    .map((spell) => {
      const templatePath = TEMPLATES[spell.id];
      const templateGrid = rasterizePath(templatePath, gridSize);

      let best = 0;
      for (const variantGrid of variantGrids) {
        best = Math.max(best, diceScore(variantGrid, templateGrid));
      }

      const boost = SPELL_BOOST[spell.id] ?? 1;
      return {
        spell,
        confidence: clamp01(best * boost),
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .filter((entry) => entry.confidence > 0);

  if (typeof options.limit === "number" && options.limit > 0) {
    return result.slice(0, options.limit);
  }

  return result;
};

export type Point = {
  x: number;
  y: number;
  t?: number;
};

export const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const pathLength = (points: Point[]): number => {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distance(points[i - 1], points[i]);
  }

  return total;
};

export const filterByMinDistance = (
  points: Point[],
  minDistance: number,
): Point[] => {
  if (!points.length) {
    return [];
  }

  const filtered: Point[] = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    if (distance(points[i], filtered[filtered.length - 1]) >= minDistance) {
      filtered.push(points[i]);
    }
  }

  return filtered;
};

export const smoothPath = (points: Point[], factor: number): Point[] => {
  if (points.length < 3 || factor <= 0) {
    return points;
  }

  const alpha = Math.max(0.05, Math.min(0.95, factor));
  const smoothed: Point[] = [points[0]];

  for (let i = 1; i < points.length; i += 1) {
    const prev = smoothed[i - 1];
    const current = points[i];
    smoothed.push({
      x: prev.x + alpha * (current.x - prev.x),
      y: prev.y + alpha * (current.y - prev.y),
      t: current.t,
    });
  }

  return smoothed;
};

export const centroid = (points: Point[]): Point => {
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
    { x: 0, y: 0 },
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
};

export const resample = (points: Point[], n: number): Point[] => {
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1 || n <= 2) {
    return [points[0], points[points.length - 1]];
  }

  const total = pathLength(points);
  if (total === 0) {
    return Array.from({ length: n }, () => ({ ...points[0] }));
  }

  const interval = total / (n - 1);
  const sampled: Point[] = [points[0]];
  let distanceAccumulator = 0;
  const source = points.map((p) => ({ ...p }));

  for (let i = 1; i < source.length; i += 1) {
    let prev = source[i - 1];
    const current = source[i];
    let segment = distance(prev, current);

    while (distanceAccumulator + segment >= interval) {
      const ratio = (interval - distanceAccumulator) / segment;
      const interpolated: Point = {
        x: prev.x + ratio * (current.x - prev.x),
        y: prev.y + ratio * (current.y - prev.y),
      };

      sampled.push(interpolated);
      prev = interpolated;
      segment = distance(prev, current);
      distanceAccumulator = 0;

      if (sampled.length === n - 1) {
        break;
      }
    }

    distanceAccumulator += segment;

    if (sampled.length === n - 1) {
      break;
    }
  }

  while (sampled.length < n - 1) {
    sampled.push({ ...points[points.length - 1] });
  }

  sampled.push(points[points.length - 1]);
  return sampled.slice(0, n);
};

const rotateBy = (points: Point[], angleRad: number): Point[] => {
  const c = centroid(points);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  return points.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;

    return {
      x: dx * cos - dy * sin + c.x,
      y: dx * sin + dy * cos + c.y,
    };
  });
};

const indicativeAngle = (points: Point[]): number => {
  const c = centroid(points);
  return Math.atan2(c.y - points[0].y, c.x - points[0].x);
};

const scaleToUnitSquare = (points: Point[]): Point[] => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const width = Math.max(1e-6, maxX - minX);
  const height = Math.max(1e-6, maxY - minY);

  return points.map((p) => ({
    x: (p.x - minX) / width,
    y: (p.y - minY) / height,
  }));
};

const translateToOrigin = (points: Point[]): Point[] => {
  const c = centroid(points);
  return points.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
};

export const normalizePath = (points: Point[], resolution: number): Point[] => {
  const sampled = resample(points, resolution);
  const angle = indicativeAngle(sampled);
  const rotated = rotateBy(sampled, -angle);
  const scaled = scaleToUnitSquare(rotated);
  return translateToOrigin(scaled);
};

export const pathDistance = (a: Point[], b: Point[]): number => {
  const count = Math.min(a.length, b.length);
  let total = 0;

  for (let i = 0; i < count; i += 1) {
    total += distance(a[i], b[i]);
  }

  return total / Math.max(1, count);
};

export const normalizedScore = (dist: number): number => {
  // In normalized space, values under ~0.55 are typically strong matches.
  return Math.max(0, 1 - dist / 0.55);
};

export const makeCircle = (count = 64): Point[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = (i / (count - 1)) * Math.PI * 2;
    return {
      x: Math.cos(angle),
      y: Math.sin(angle),
    };
  });

export const makeTriangle = (): Point[] => [
  { x: 0, y: -1 },
  { x: -0.9, y: 0.8 },
  { x: 0.9, y: 0.8 },
  { x: 0, y: -1 },
];

export const makeZigZag = (segments = 6): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i <= segments; i += 1) {
    points.push({
      x: -1 + (2 * i) / segments,
      y: i % 2 === 0 ? -0.9 : 0.9,
    });
  }

  return points;
};

export const makeSpiral = (turns = 3, clockwise = true, count = 90): Point[] =>
  Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const radius = 0.1 + 0.9 * t;
    const theta = t * Math.PI * 2 * turns * (clockwise ? 1 : -1);
    return {
      x: radius * Math.cos(theta),
      y: radius * Math.sin(theta),
    };
  });

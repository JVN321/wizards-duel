export type LatencyQuality = "good" | "moderate" | "poor" | "unknown";

export const getLatencyQuality = (latencyMs: number | null): LatencyQuality => {
  if (latencyMs === null || Number.isNaN(latencyMs)) {
    return "unknown";
  }
  if (latencyMs < 50) {
    return "good";
  }
  if (latencyMs <= 120) {
    return "moderate";
  }
  return "poor";
};

export class LatencyTracker {
  private pending = new Map<number, number>();
  private readonly keepSamples: number;
  private samples: number[] = [];

  constructor(keepSamples = 5) {
    this.keepSamples = keepSamples;
  }

  markPing(timestamp: number): void {
    this.pending.set(timestamp, performance.now());
  }

  consumePong(timestamp: number): number | null {
    if (!this.pending.has(timestamp)) {
      return null;
    }

    this.pending.delete(timestamp);
    const rtt = Math.max(0, Date.now() - timestamp);
    this.samples.push(rtt);

    if (this.samples.length > this.keepSamples) {
      this.samples = this.samples.slice(-this.keepSamples);
    }

    const total = this.samples.reduce((acc, value) => acc + value, 0);
    return Math.round(total / this.samples.length);
  }

  reset(): void {
    this.pending.clear();
    this.samples = [];
  }
}

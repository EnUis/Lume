export class HealthCapacityError extends Error {
  constructor() { super('Stream verification is temporarily busy'); this.name = 'HealthCapacityError'; }
}

type Release = () => void;
type Gate = { active: number; waiting: Array<(release: Release) => void> };
export function healthOriginConcurrency(configured = process.env.HEALTH_ORIGIN_CONCURRENCY) {
  const parsed = Number(configured || 4);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(16, Math.floor(parsed))) : 4;
}

/** Limits are per worker process; waiting for local resources is not a source failure. */
export function createHealthCapacity(originLimit = healthOriginConcurrency()) {
  const origins = new Map<string, Gate>();
  const probes: Gate = { active: 0, waiting: [] };
  const limit = Number.isFinite(originLimit) ? Math.max(1, Math.min(16, Math.floor(originLimit))) : 4;
  let waiting = 0;
  function acquire(gate: Gate, maximum: number, idle?: () => void): Promise<Release> {
    const release = (): Release => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = gate.waiting.shift();
        if (next) { waiting--; next(release()); }
        else { gate.active--; if (!gate.active) idle?.(); }
      };
    };
    if (gate.active < maximum) { gate.active++; return Promise.resolve(release()); }
    if (waiting >= 128) return Promise.reject(new HealthCapacityError());
    waiting++;
    return new Promise(resolve => gate.waiting.push(resolve));
  }
  return {
    acquireOrigin(url: string) {
      const origin = new URL(url).origin;
      let gate = origins.get(origin);
      if (!gate) { gate = { active: 0, waiting: [] }; origins.set(origin, gate); }
      return acquire(gate, limit, () => origins.delete(origin));
    },
    acquireProbe() { return acquire(probes, 4); },
  };
}
export type HealthCapacity = ReturnType<typeof createHealthCapacity>;
export const healthCapacity = createHealthCapacity();

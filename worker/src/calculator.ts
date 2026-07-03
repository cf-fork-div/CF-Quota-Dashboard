import type { QuotaMetric, FreeTierLimitDef } from './types';

export function calcPct(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

export function buildMetric(
  key: string,
  used: number,
  def: FreeTierLimitDef,
  available = true,
  note?: string,
): QuotaMetric {
  let normalizedUsed = used;
  let normalizedLimit = def.limit;

  if (def.unit === 'GB') {
    normalizedUsed = bytesToGb(used);
    normalizedLimit = def.limit;
  }

  return {
    used: roundDisplay(normalizedUsed, def.unit),
    limit: normalizedLimit,
    pct: available ? calcPct(normalizedUsed, normalizedLimit) : 0,
    unit: def.unit,
    period: def.period,
    label: def.label,
    available,
    note,
  };
}

export function bytesToGb(bytes: number): number {
  return bytes / (1024 * 1024 * 1024);
}

export function roundDisplay(value: number, unit: string): number {
  if (unit === 'GB') return Math.round(value * 1000) / 1000;
  if (unit === 'minutes') return Math.round(value * 100) / 100;
  return Math.round(value);
}

export function metricsAtOrAboveThreshold(
  quotas: Record<string, QuotaMetric>,
  threshold: number,
): QuotaMetric[] {
  return Object.values(quotas).filter(
    (q) => q.available && q.pct >= threshold,
  );
}

export function progressBarColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 80) return 'red';
  if (pct >= 60) return 'yellow';
  return 'green';
}

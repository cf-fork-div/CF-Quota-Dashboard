import type { FreeTierLimitDef, FreeTierLimitsConfig } from './types';

/** Cloudflare Workers Free plan defaults (UTC reset for daily limits). */
export const DEFAULT_FREE_TIER_LIMITS: FreeTierLimitsConfig = {
  workers_requests: {
    limit: 100_000,
    period: 'daily',
    unit: 'requests',
    label: 'Workers Requests',
  },
  d1_reads: {
    limit: 5_000_000,
    period: 'daily',
    unit: 'rows',
    label: 'D1 Rows Read',
  },
  d1_writes: {
    limit: 100_000,
    period: 'daily',
    unit: 'rows',
    label: 'D1 Rows Written',
  },
  d1_storage_gb: {
    limit: 5,
    period: 'total',
    unit: 'GB',
    label: 'D1 Storage',
  },
  kv_reads: {
    limit: 100_000,
    period: 'daily',
    unit: 'ops',
    label: 'KV Reads',
  },
  kv_writes: {
    limit: 1_000,
    period: 'daily',
    unit: 'ops',
    label: 'KV Writes',
  },
  kv_deletes: {
    limit: 1_000,
    period: 'daily',
    unit: 'ops',
    label: 'KV Deletes',
  },
  kv_lists: {
    limit: 1_000,
    period: 'daily',
    unit: 'ops',
    label: 'KV Lists',
  },
  kv_storage_gb: {
    limit: 1,
    period: 'total',
    unit: 'GB',
    label: 'KV Storage',
  },
  r2_storage_gb: {
    limit: 10,
    period: 'monthly',
    unit: 'GB',
    label: 'R2 Storage',
  },
  r2_class_a: {
    limit: 1_000_000,
    period: 'monthly',
    unit: 'ops',
    label: 'R2 Class A Ops',
  },
  r2_class_b: {
    limit: 10_000_000,
    period: 'monthly',
    unit: 'ops',
    label: 'R2 Class B Ops',
  },
  pages_builds: {
    limit: 500,
    period: 'monthly',
    unit: 'builds',
    label: 'Pages Builds',
  },
  pages_requests: {
    limit: 100_000,
    period: 'daily',
    unit: 'requests',
    label: 'Pages Functions Requests',
  },
  ai_neurons: {
    limit: 10_000,
    period: 'daily',
    unit: 'neurons',
    label: 'Workers AI Neurons',
  },
  queues_ops: {
    limit: 10_000,
    period: 'daily',
    unit: 'ops',
    label: 'Queues Operations',
  },
  vectorize_queried_dims: {
    limit: 30_000_000,
    period: 'monthly',
    unit: 'dimensions',
    label: 'Vectorize Queried Dims',
  },
  vectorize_stored_dims: {
    limit: 5_000_000,
    period: 'total',
    unit: 'dimensions',
    label: 'Vectorize Stored Dims',
  },
  hyperdrive_queries: {
    limit: 100_000,
    period: 'daily',
    unit: 'queries',
    label: 'Hyperdrive Queries',
  },
  workflows_invocations: {
    limit: 100_000,
    period: 'daily',
    unit: 'invocations',
    label: 'Workflows Invocations',
  },
  durable_objects_requests: {
    limit: 100_000,
    period: 'daily',
    unit: 'requests',
    label: 'DO Requests',
  },
  durable_objects_duration: {
    limit: 13_000,
    period: 'daily',
    unit: 'GB-s',
    label: 'DO Duration',
  },
  durable_objects_rows_read: {
    limit: 5_000_000,
    period: 'daily',
    unit: 'rows',
    label: 'DO Rows Read',
  },
  durable_objects_rows_written: {
    limit: 100_000,
    period: 'daily',
    unit: 'rows',
    label: 'DO Rows Written',
  },
  durable_objects_sql_storage_gb: {
    limit: 5,
    period: 'total',
    unit: 'GB',
    label: 'DO SQL Storage',
  },
  browser_minutes: {
    limit: 10,
    period: 'daily',
    unit: 'minutes',
    label: 'Browser Rendering',
  },
  analytics_engine_writes: {
    limit: 100_000,
    period: 'daily',
    unit: 'points',
    label: 'Analytics Engine Writes',
  },
  workers_logs_bytes: {
    limit: 0,
    period: 'daily',
    unit: 'bytes',
    label: 'Workers Logs Ingestion',
  },
};

export function resolveFreeTierLimits(envJson?: string): FreeTierLimitsConfig {
  if (!envJson?.trim()) return DEFAULT_FREE_TIER_LIMITS;
  try {
    const parsed = JSON.parse(envJson) as Partial<FreeTierLimitsConfig>;
    const merged = { ...DEFAULT_FREE_TIER_LIMITS };
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && 'limit' in value) {
        merged[key] = { ...merged[key], ...(value as FreeTierLimitDef) };
      }
    }
    return merged;
  } catch {
    return DEFAULT_FREE_TIER_LIMITS;
  }
}

export function getAlertThreshold(envValue?: string): number {
  const n = Number(envValue ?? '70');
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 70;
}

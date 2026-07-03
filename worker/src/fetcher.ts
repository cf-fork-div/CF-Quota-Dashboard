import type { AccountSnapshot, FetchResult, FreeTierLimitsConfig, QuotasMap } from './types';
import { buildMetric } from './calculator';
import { resolveFreeTierLimits } from './free-tier-limits';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';

/** Estimated external subrequests per account (GraphQL batches + REST). */
export const SUBREQUESTS_PER_ACCOUNT = 5;

function getUtcDayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return { start: start.toISOString(), end: end.toISOString() };
}

function getUtcMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  const end = new Date(nextMonth.getTime() - 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function graphqlRequest<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await resp.json()) as {
    data?: T;
    errors?: unknown[];
  };
  if (!json.data || json.errors?.length) {
    throw new Error(json.errors ? JSON.stringify(json.errors) : 'GraphQL error');
  }
  return json.data;
}

async function safeQuery<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${label}: ${message}` };
  }
}

interface CfApiResponse<T> {
  success?: boolean;
  result?: T;
  result_info?: { total_pages?: number; page?: number };
  errors?: unknown[];
}

async function restRequestRaw<T>(token: string, path: string): Promise<CfApiResponse<T>> {
  const resp = await fetch(`${REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await resp.json()) as CfApiResponse<T>;
  if (!resp.ok || json.success === false) {
    throw new Error(json.errors ? JSON.stringify(json.errors) : `REST ${resp.status}`);
  }
  return json;
}

interface ViewerAccount {
  workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
  kvOperationsAdaptiveGroups?: Array<{
    dimensions?: { actionType?: string };
    sum?: { requests?: number };
  }>;
  kvStorageAdaptiveGroups?: Array<{ max?: { byteCount?: number } }>;
  d1AnalyticsAdaptiveGroups?: Array<{ sum?: { rowsRead?: number; rowsWritten?: number } }>;
  d1StorageAdaptiveGroups?: Array<{ max?: { databaseSizeBytes?: number } }>;
  r2StorageAdaptiveGroups?: Array<{ max?: { payloadSize?: number; metadataSize?: number } }>;
  r2OperationsAdaptiveGroups?: Array<{
    dimensions?: { actionType?: string };
    sum?: { requests?: number };
  }>;
  queueMessageOperationsAdaptiveGroups?: Array<{ sum?: { billableOperations?: number } }>;
  aiInferenceAdaptiveGroups?: Array<{ sum?: { totalNeurons?: number } }>;
  hyperdriveQueriesAdaptiveGroups?: Array<{ count?: number }>;
  workflowsAdaptiveGroups?: Array<{ count?: number }>;
  browserRenderingBrowserTimeUsageAdaptiveGroups?: Array<{
    sum?: { totalSessionDurationMs?: number };
  }>;
  workersAnalyticsEngineAdaptiveGroups?: Array<{ count?: number }>;
  logExplorerIngestionAdaptiveGroups?: Array<{ sum?: { totalBytes?: number } }>;
  durableObjectsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }>;
  durableObjectsPeriodicGroups?: Array<{
    sum?: { duration?: number; rowsRead?: number; rowsWritten?: number };
  }>;
  durableObjectsSqlStorageGroups?: Array<{ max?: { storedBytes?: number } }>;
  vectorizeQueriesAdaptiveGroups?: Array<{ sum?: { queriedDimensions?: number } }>;
  vectorizeStorageAdaptiveGroups?: Array<{ max?: { storedDimensions?: number } }>;
  pagesFunctionsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }>;
}

function getAccount(data: { viewer?: { accounts?: ViewerAccount[] } }): ViewerAccount {
  return data.viewer?.accounts?.[0] ?? {};
}

function sumGroups<T>(
  groups: T[] | undefined,
  read: (g: T) => number | undefined,
): number {
  return (groups ?? []).reduce((total, g) => {
    const v = Number(read(g));
    return total + (Number.isFinite(v) ? v : 0);
  }, 0);
}

const R2_CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition',
  'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);

const R2_CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary',
  'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration', 'GetBucketSippyConfiguration',
]);

const UNAVAILABLE_NOTE = 'API query failed for this metric group';

async function fetchCoreMetrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
  month: { start: string; end: string },
): Promise<{ acc: ViewerAccount; errors: string[] }> {
  const coreQuery = `query CoreQuotaMetrics(
    $accountTag: String!,
    $dayStart: DateTime!, $dayEnd: DateTime!,
    $monthStart: DateTime!, $monthEnd: DateTime!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { requests }
        }
        queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { billableOperations }
        }
        aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { totalNeurons }
        }
        hyperdriveQueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          count
        }
        workflowsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          count
        }
        browserRenderingBrowserTimeUsageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { totalSessionDurationMs }
        }
        workersAnalyticsEngineAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          count
        }
        logExplorerIngestionAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { totalBytes }
        }
        durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { requests }
        }
        durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { duration rowsRead rowsWritten }
        }
        durableObjectsSqlStorageGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          max { storedBytes }
        }
        pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { requests }
        }
      }
    }
  }`;

  const result = await safeQuery('core', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, coreQuery, {
      accountTag: accountId,
      dayStart: day.start,
      dayEnd: day.end,
      monthStart: month.start,
      monthEnd: month.end,
    }),
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return { acc: getAccount(result.data), errors: [] };
}

async function fetchD1Metrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
  month: { start: string; end: string },
): Promise<
  | { ok: true; d1Reads: number; d1Writes: number; d1StorageBytes: number }
  | { ok: false; error: string }
> {
  const d1Query = `query D1Metrics(
    $accountTag: String!,
    $dayStart: DateTime!, $dayEnd: DateTime!,
    $monthStart: DateTime!, $monthEnd: DateTime!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { rowsRead rowsWritten }
        }
        d1StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          max { databaseSizeBytes }
        }
      }
    }
  }`;

  const result = await safeQuery('d1', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, d1Query, {
      accountTag: accountId,
      dayStart: day.start,
      dayEnd: day.end,
      monthStart: month.start,
      monthEnd: month.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  return {
    ok: true,
    d1Reads: sumGroups(acc.d1AnalyticsAdaptiveGroups, (g) => g.sum?.rowsRead),
    d1Writes: sumGroups(acc.d1AnalyticsAdaptiveGroups, (g) => g.sum?.rowsWritten),
    d1StorageBytes: sumGroups(acc.d1StorageAdaptiveGroups, (g) => g.max?.databaseSizeBytes),
  };
}

async function fetchKvMetrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
): Promise<
  | { ok: true; kvReads: number; kvWrites: number; kvDeletes: number; kvLists: number; kvStorageBytes: number }
  | { ok: false; error: string }
> {
  const kvQuery = `query KvMetrics($accountTag: String!, $dayStart: DateTime!, $dayEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          dimensions { actionType }
          sum { requests }
        }
        kvStorageAdaptiveGroups(limit: 10000, filter: { date_geq: $dayStart, date_leq: $dayEnd }) {
          max { byteCount }
        }
      }
    }
  }`;

  const result = await safeQuery('kv', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, kvQuery, {
      accountTag: accountId,
      dayStart: day.start,
      dayEnd: day.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  let kvReads = 0;
  let kvWrites = 0;
  let kvDeletes = 0;
  let kvLists = 0;
  for (const g of acc.kvOperationsAdaptiveGroups ?? []) {
    const n = g.sum?.requests ?? 0;
    const action = g.dimensions?.actionType ?? '';
    if (action === 'read') kvReads += n;
    else if (action === 'write') kvWrites += n;
    else if (action === 'delete') kvDeletes += n;
    else if (action === 'list') kvLists += n;
  }

  return {
    ok: true,
    kvReads,
    kvWrites,
    kvDeletes,
    kvLists,
    kvStorageBytes: sumGroups(acc.kvStorageAdaptiveGroups, (g) => g.max?.byteCount),
  };
}

async function fetchR2Metrics(
  token: string,
  accountId: string,
  month: { start: string; end: string },
): Promise<
  | { ok: true; r2Storage: number; r2ClassA: number; r2ClassB: number }
  | { ok: false; error: string }
> {
  const r2Query = `query R2Metrics($accountTag: String!, $monthStart: DateTime!, $monthEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          max { payloadSize metadataSize }
        }
        r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          dimensions { actionType }
          sum { requests }
        }
      }
    }
  }`;

  const result = await safeQuery('r2', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, r2Query, {
      accountTag: accountId,
      monthStart: month.start,
      monthEnd: month.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  let r2Storage = 0;
  let r2ClassA = 0;
  let r2ClassB = 0;
  for (const g of acc.r2StorageAdaptiveGroups ?? []) {
    r2Storage += (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0);
  }
  for (const g of acc.r2OperationsAdaptiveGroups ?? []) {
    const requests = g.sum?.requests ?? 0;
    const action = g.dimensions?.actionType ?? '';
    if (R2_CLASS_B.has(action)) r2ClassB += requests;
    else if (R2_CLASS_A.has(action)) r2ClassA += requests;
  }

  return { ok: true, r2Storage, r2ClassA, r2ClassB };
}

async function fetchVectorizeMetrics(
  token: string,
  accountId: string,
  month: { start: string; end: string },
): Promise<
  | { ok: true; vectorizeQueried: number; vectorizeStored: number }
  | { ok: false; error: string }
> {
  const vectorizeQuery = `query Vectorize($accountTag: String!, $monthStart: DateTime!, $monthEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        vectorizeQueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          sum { queriedDimensions }
        }
        vectorizeStorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          max { storedDimensions }
        }
      }
    }
  }`;

  const result = await safeQuery('vectorize', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, vectorizeQuery, {
      accountTag: accountId,
      monthStart: month.start,
      monthEnd: month.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  return {
    ok: true,
    vectorizeQueried: sumGroups(acc.vectorizeQueriesAdaptiveGroups, (g) => g.sum?.queriedDimensions),
    vectorizeStored: sumGroups(acc.vectorizeStorageAdaptiveGroups, (g) => g.max?.storedDimensions),
  };
}

interface PagesProject {
  name: string;
}

interface PagesDeployment {
  created_on: string;
}

async function fetchPagesBuilds(
  token: string,
  accountId: string,
  monthStart: string,
  monthEnd: string,
): Promise<number> {
  const startTime = new Date(monthStart).getTime();
  const endTime = new Date(monthEnd).getTime();
  const projects: PagesProject[] = [];

  for (let page = 1; page <= 100; page++) {
    const body = await restRequestRaw<PagesProject[]>(
      token,
      `/accounts/${accountId}/pages/projects?page=${page}&per_page=25`,
    );
    projects.push(...(body.result ?? []));
    if (!body.result_info || page >= (body.result_info.total_pages ?? 1)) break;
  }

  let totalBuilds = 0;
  for (const project of projects) {
    for (let page = 1; page <= 200; page++) {
      const body = await restRequestRaw<PagesDeployment[]>(
        token,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(project.name)}/deployments?page=${page}&per_page=25`,
      );
      const list = body.result ?? [];
      totalBuilds += list.filter((d) => {
        const created = new Date(d.created_on).getTime();
        return created >= startTime && created <= endTime;
      }).length;

      const oldest = list.length ? new Date(list[list.length - 1].created_on).getTime() : null;
      if (!list.length || list.length < 25 || (oldest && oldest < startTime)) break;
    }
  }
  return totalBuilds;
}

async function fetchAllMetrics(
  token: string,
  accountId: string,
  limits: FreeTierLimitsConfig,
): Promise<{ quotas: QuotasMap; partialErrors: string[] }> {
  const day = getUtcDayRange();
  const month = getUtcMonthRange();
  const partialErrors: string[] = [];

  const { acc } = await fetchCoreMetrics(token, accountId, day, month);

  const d1Result = await fetchD1Metrics(token, accountId, day, month);
  const kvResult = await fetchKvMetrics(token, accountId, day);
  const r2Result = await fetchR2Metrics(token, accountId, month);
  const vectorizeResult = await fetchVectorizeMetrics(token, accountId, month);

  const pagesResult = await safeQuery('pages', () =>
    fetchPagesBuilds(token, accountId, month.start, month.end),
  );

  if (!d1Result.ok) partialErrors.push(d1Result.error);
  if (!kvResult.ok) partialErrors.push(kvResult.error);
  if (!r2Result.ok) partialErrors.push(r2Result.error);
  if (!vectorizeResult.ok) partialErrors.push(vectorizeResult.error);
  if (!pagesResult.ok) partialErrors.push(pagesResult.error);

  const workersRequests = acc.workersInvocationsAdaptive?.[0]?.sum?.requests ?? 0;
  const pagesRequests = sumGroups(
    acc.pagesFunctionsInvocationsAdaptiveGroups,
    (g) => g.sum?.requests,
  );

  const queuesOps = sumGroups(
    acc.queueMessageOperationsAdaptiveGroups,
    (g) => g.sum?.billableOperations,
  );
  const aiNeurons = sumGroups(acc.aiInferenceAdaptiveGroups, (g) => g.sum?.totalNeurons);
  const hyperdriveQueries = sumGroups(acc.hyperdriveQueriesAdaptiveGroups, (g) => g.count);
  const workflowsInvocations = sumGroups(acc.workflowsAdaptiveGroups, (g) => g.count);
  const browserMs = sumGroups(
    acc.browserRenderingBrowserTimeUsageAdaptiveGroups,
    (g) => g.sum?.totalSessionDurationMs,
  );
  const analyticsWrites = sumGroups(acc.workersAnalyticsEngineAdaptiveGroups, (g) => g.count);
  const logsBytes = sumGroups(acc.logExplorerIngestionAdaptiveGroups, (g) => g.sum?.totalBytes);

  const doRequests = sumGroups(
    acc.durableObjectsInvocationsAdaptiveGroups,
    (g) => g.sum?.requests,
  );
  const doDuration = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.duration);
  const doRowsRead = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.rowsRead);
  const doRowsWritten = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.rowsWritten);
  const doSqlStorage = sumGroups(acc.durableObjectsSqlStorageGroups, (g) => g.max?.storedBytes);

  const quotas: QuotasMap = {
    workers_requests: buildMetric('workers_requests', workersRequests, limits.workers_requests),
    d1_reads: buildMetric(
      'd1_reads',
      d1Result.ok ? d1Result.d1Reads : 0,
      limits.d1_reads,
      d1Result.ok,
      d1Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    d1_writes: buildMetric(
      'd1_writes',
      d1Result.ok ? d1Result.d1Writes : 0,
      limits.d1_writes,
      d1Result.ok,
      d1Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    d1_storage_gb: buildMetric(
      'd1_storage_gb',
      d1Result.ok ? d1Result.d1StorageBytes : 0,
      limits.d1_storage_gb,
      d1Result.ok,
      d1Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    kv_reads: buildMetric(
      'kv_reads',
      kvResult.ok ? kvResult.kvReads : 0,
      limits.kv_reads,
      kvResult.ok,
      kvResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    kv_writes: buildMetric(
      'kv_writes',
      kvResult.ok ? kvResult.kvWrites : 0,
      limits.kv_writes,
      kvResult.ok,
      kvResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    kv_deletes: buildMetric(
      'kv_deletes',
      kvResult.ok ? kvResult.kvDeletes : 0,
      limits.kv_deletes,
      kvResult.ok,
      kvResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    kv_lists: buildMetric(
      'kv_lists',
      kvResult.ok ? kvResult.kvLists : 0,
      limits.kv_lists,
      kvResult.ok,
      kvResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    kv_storage_gb: buildMetric(
      'kv_storage_gb',
      kvResult.ok ? kvResult.kvStorageBytes : 0,
      limits.kv_storage_gb,
      kvResult.ok,
      kvResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    r2_storage_gb: buildMetric(
      'r2_storage_gb',
      r2Result.ok ? r2Result.r2Storage : 0,
      limits.r2_storage_gb,
      r2Result.ok,
      r2Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    r2_class_a: buildMetric(
      'r2_class_a',
      r2Result.ok ? r2Result.r2ClassA : 0,
      limits.r2_class_a,
      r2Result.ok,
      r2Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    r2_class_b: buildMetric(
      'r2_class_b',
      r2Result.ok ? r2Result.r2ClassB : 0,
      limits.r2_class_b,
      r2Result.ok,
      r2Result.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    pages_builds: buildMetric(
      'pages_builds',
      pagesResult.ok ? pagesResult.data : 0,
      limits.pages_builds,
      pagesResult.ok,
      pagesResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    pages_requests: buildMetric('pages_requests', pagesRequests, limits.pages_requests),
    ai_neurons: buildMetric('ai_neurons', aiNeurons, limits.ai_neurons),
    queues_ops: buildMetric('queues_ops', queuesOps, limits.queues_ops),
    vectorize_queried_dims: buildMetric(
      'vectorize_queried_dims',
      vectorizeResult.ok ? vectorizeResult.vectorizeQueried : 0,
      limits.vectorize_queried_dims,
      vectorizeResult.ok,
      vectorizeResult.ok ? undefined : UNAVAILABLE_NOTE,
    ),
    vectorize_stored_dims: buildMetric(
      'vectorize_stored_dims',
      vectorizeResult.ok ? vectorizeResult.vectorizeStored : 0,
      limits.vectorize_stored_dims,
      vectorizeResult.ok,
    ),
    hyperdrive_queries: buildMetric('hyperdrive_queries', hyperdriveQueries, limits.hyperdrive_queries),
    workflows_invocations: buildMetric('workflows_invocations', workflowsInvocations, limits.workflows_invocations),
    durable_objects_requests: buildMetric('durable_objects_requests', doRequests, limits.durable_objects_requests),
    durable_objects_duration: buildMetric('durable_objects_duration', doDuration, limits.durable_objects_duration),
    durable_objects_rows_read: buildMetric('durable_objects_rows_read', doRowsRead, limits.durable_objects_rows_read),
    durable_objects_rows_written: buildMetric('durable_objects_rows_written', doRowsWritten, limits.durable_objects_rows_written),
    durable_objects_sql_storage_gb: buildMetric('durable_objects_sql_storage_gb', doSqlStorage, limits.durable_objects_sql_storage_gb),
    browser_minutes: buildMetric('browser_minutes', browserMs / 60000, limits.browser_minutes),
    analytics_engine_writes: buildMetric('analytics_engine_writes', analyticsWrites, limits.analytics_engine_writes),
    workers_logs_bytes: buildMetric(
      'workers_logs_bytes',
      logsBytes,
      limits.workers_logs_bytes,
      false,
      'Event count not exposed via API; bytes shown for reference only',
    ),
  };

  return { quotas, partialErrors };
}

export async function fetchAccountQuotas(
  token: string,
  accountId: string,
  accountName: string,
  limitsJson?: string,
): Promise<AccountSnapshot> {
  const limits = resolveFreeTierLimits(limitsJson);
  try {
    const { quotas, partialErrors } = await fetchAllMetrics(token, accountId, limits);
    const hasAvailable = Object.values(quotas).some((q) => q.available);
    return {
      accountId,
      accountName,
      status: hasAvailable ? 'ok' : 'error',
      error: partialErrors.length ? partialErrors.join('; ') : undefined,
      quotas,
      lastCheckTime: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      accountId,
      accountName,
      status: 'error',
      error: message,
      quotas: {},
    };
  }
}

interface CfAccountInfo {
  id: string;
  name?: string;
}

export async function verifyAccountCredentials(
  token: string,
  accountId: string,
): Promise<{ ok: true; accountName?: string } | { ok: false; error: string }> {
  try {
    const body = await restRequestRaw<CfAccountInfo>(
      token,
      `/accounts/${accountId}`,
    );
    if (!body.result?.id) {
      return { ok: false, error: 'Account not found or token lacks access' };
    }
    return { ok: true, accountName: body.result.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function fetchAccountQuotasSafe(
  token: string,
  accountId: string,
  accountName: string,
  limitsJson?: string,
): Promise<FetchResult> {
  const snapshot = await fetchAccountQuotas(token, accountId, accountName, limitsJson);
  return {
    quotas: snapshot.quotas,
    status: snapshot.status,
    error: snapshot.error,
  };
}

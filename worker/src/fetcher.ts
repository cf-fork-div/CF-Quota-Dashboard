import type {
  AccountSnapshot,
  FetchResult,
  FreeTierLimitsConfig,
  QuotasMap,
  ResourceBreakdown,
  ResourceUsageItem,
  ServiceActivationStatus,
  ServiceStatusMap,
} from './types';
import { buildMetric } from './calculator';
import { resolveFreeTierLimits } from './free-tier-limits';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';

/** Estimated external subrequests per account (GraphQL batches + REST). */
export const SUBREQUESTS_PER_ACCOUNT = 14;

function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getUtcRanges() {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  const monthEnd = new Date(nextMonth.getTime() - 1000);
  const today = formatUtcDate(now);

  return {
    day: { start: dayStart.toISOString(), end: dayEnd.toISOString() },
    month: { start: monthStart.toISOString(), end: monthEnd.toISOString() },
    dayDate: { start: formatUtcDate(dayStart), end: today },
    monthDate: { start: formatUtcDate(monthStart), end: today },
  };
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

interface CfApiError {
  code?: number;
  message?: string;
}

interface CfApiResponse<T> {
  success?: boolean;
  result?: T;
  result_info?: {
    total_pages?: number;
    page?: number;
    total_count?: number;
    count?: number;
    cursor?: string;
    per_page?: number;
  };
  errors?: CfApiError[];
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

async function restRequestSafe<T>(
  token: string,
  path: string,
): Promise<
  | { ok: true; data: CfApiResponse<T> }
  | { ok: false; status: number; errors: CfApiError[] }
> {
  const resp = await fetch(`${REST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await resp.json()) as CfApiResponse<T>;
  if (!resp.ok || json.success === false) {
    return { ok: false, status: resp.status, errors: json.errors ?? [] };
  }
  return { ok: true, data: json };
}

function isNotEntitledError(errors: CfApiError[]): boolean {
  return errors.some((e) => {
    if (e.code === 10042 || e.code === 1005) return true;
    const msg = (e.message ?? '').toLowerCase();
    return (
      msg.includes('not entitled')
      || msg.includes('not_entitled')
      || msg.includes('enable through the cloudflare dashboard')
      || msg.includes('please enable r2')
    );
  });
}

interface R2BucketListResult {
  buckets?: Array<{ name?: string }>;
}

interface D1DatabaseInfo {
  uuid?: string;
  name?: string;
}

interface KvNamespaceInfo {
  id?: string;
  title?: string;
}

interface PagesProject {
  name: string;
}

async function fetchR2Buckets(
  token: string,
  accountId: string,
): Promise<
  | { ok: true; count: number; buckets: Array<{ name: string }>; activation: ServiceActivationStatus }
  | { ok: false; error: string; activation: ServiceActivationStatus }
> {
  const buckets: Array<{ name: string }> = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < 100) {
    const qs = new URLSearchParams({ per_page: '100' });
    if (cursor) qs.set('cursor', cursor);
    const result = await restRequestSafe<R2BucketListResult>(
      token,
      `/accounts/${accountId}/r2/buckets?${qs}`,
    );

    if (!result.ok) {
      const activation: ServiceActivationStatus = isNotEntitledError(result.errors)
        ? 'not_activated'
        : 'unknown';
      const errorBody = result.errors.length
        ? JSON.stringify(result.errors)
        : `REST ${result.status}`;
      return { ok: false, error: `r2-buckets: ${errorBody}`, activation };
    }

    const batch = result.data.result?.buckets ?? [];
    for (const bucket of batch) {
      if (bucket.name) buckets.push({ name: bucket.name });
    }
    cursor = result.data.result_info?.cursor;
    if (!cursor || batch.length === 0) break;
    page += 1;
  }

  return { ok: true, count: buckets.length, buckets, activation: 'activated' };
}

interface ViewerAccount {
  workersInvocationsAdaptive?: Array<{
    sum?: { requests?: number; cpuTimeUs?: number };
    dimensions?: { scriptName?: string };
  }>;
  kvOperationsAdaptiveGroups?: Array<{
    dimensions?: { actionType?: string; namespaceId?: string };
    sum?: { requests?: number };
  }>;
  kvStorageAdaptiveGroups?: Array<{
    max?: { byteCount?: number };
    dimensions?: { namespaceId?: string; date?: string };
  }>;
  d1AnalyticsAdaptiveGroups?: Array<{
    sum?: { rowsRead?: number; rowsWritten?: number };
    dimensions?: { databaseId?: string };
  }>;
  d1StorageAdaptiveGroups?: Array<{
    max?: { databaseSizeBytes?: number };
    dimensions?: { databaseId?: string; datetime?: string };
  }>;
  r2StorageAdaptiveGroups?: Array<{
    max?: { payloadSize?: number; metadataSize?: number };
    dimensions?: { bucketName?: string; datetime?: string };
  }>;
  r2OperationsAdaptiveGroups?: Array<{
    dimensions?: { actionType?: string; bucketName?: string };
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
  logExplorerIngestionAdaptiveGroups?: Array<{ count?: number; sum?: { totalBytes?: number } }>;
  durableObjectsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }>;
  durableObjectsPeriodicGroups?: Array<{
    sum?: { duration?: number; rowsRead?: number; rowsWritten?: number };
  }>;
  durableObjectsSqlStorageGroups?: Array<{ max?: { storedBytes?: number } }>;
  vectorizeV2QueriesAdaptiveGroups?: Array<{
    count?: number;
    sum?: { queriedVectorDimensions?: number };
  }>;
  vectorizeQueriesAdaptiveGroups?: Array<{
    count?: number;
    sum?: { queriedVectorDimensions?: number };
  }>;
  vectorizeV2StorageAdaptiveGroups?: Array<{
    max?: { storedVectorDimensions?: number };
    dimensions?: { indexName?: string; datetime?: string };
  }>;
  vectorizeStorageAdaptiveGroups?: Array<{
    max?: { storedVectorDimensions?: number };
    dimensions?: { indexName?: string; datetime?: string };
  }>;
  workersBuildsBuildMinutesAdaptiveGroups?: Array<{
    sum?: { buildMinutes?: number };
    dimensions?: { date?: string };
  }>;
  pagesFunctionsInvocationsAdaptiveGroups?: Array<{
    sum?: { requests?: number };
    dimensions?: { scriptName?: string };
  }>;
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

function parseApiErrorMessage(error: string): string {
  const jsonStart = error.indexOf('[');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(error.slice(jsonStart)) as Array<{ message?: string }>;
      if (parsed[0]?.message) return parsed[0].message;
    } catch {
      /* fall through */
    }
  }
  const colon = error.indexOf(': ');
  const body = colon >= 0 ? error.slice(colon + 2) : error;
  return body.length > 160 ? `${body.slice(0, 157)}...` : body;
}

function metricNote(prefix: string, partialErrors: string[]): string | undefined {
  const match = partialErrors.find((e) => e.startsWith(`${prefix}:`));
  return match ? parseApiErrorMessage(match) : undefined;
}

function isAuthErrorMessage(message: string): boolean {
  return /authentication error|authenticate|authorization|10000/i.test(message);
}

function vectorizeMetricNote(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const message = parseApiErrorMessage(error);
  if (isAuthErrorMessage(message)) {
    return '需要 Account Analytics: Read 权限（GraphQL）；REST 索引查询另需 Account → Vectorize → Read';
  }
  return message;
}

function d1DatabaseMetricNote(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const message = parseApiErrorMessage(error);
  if (isAuthErrorMessage(message)) {
    return '需要 API Token 权限：Account → D1 → Read';
  }
  return message;
}

function kvNamespaceMetricNote(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const message = parseApiErrorMessage(error);
  if (isAuthErrorMessage(message)) {
    return '需要 API Token 权限：Account → Workers KV Storage → Read';
  }
  return message;
}

function r2BucketMetricNote(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const message = parseApiErrorMessage(error);
  if (isAuthErrorMessage(message)) {
    return '需要 API Token 权限：Account → Workers R2 Storage → Read';
  }
  return message;
}

function isUnknownGraphqlFieldError(error: string): boolean {
  return /unknown field/i.test(parseApiErrorMessage(error));
}

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
        durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { requests }
        }
        durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { duration rowsRead rowsWritten }
        }
        durableObjectsSqlStorageGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          max { storedBytes }
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
    return { acc: {}, errors: [result.error] };
  }

  return { acc: getAccount(result.data), errors: [] };
}

async function fetchWorkersBuildMinutes(
  token: string,
  accountId: string,
  monthStart: string,
  nowIso: string,
): Promise<{ ok: true; minutes: number } | { ok: false; error: string }> {
  const dailyQuery = `query WorkersBuildMinutesDaily($accountTag: String!, $monthStart: DateTime!, $now: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersBuildsBuildMinutesAdaptiveGroups(
          limit: 100,
          filter: { datetime_geq: $monthStart, datetime_leq: $now },
          orderBy: [date_ASC]
        ) {
          sum { buildMinutes }
          dimensions { date }
        }
      }
    }
  }`;

  const dailyResult = await safeQuery('workers-builds', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, dailyQuery, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (dailyResult.ok) {
    const groups = getAccount(dailyResult.data).workersBuildsBuildMinutesAdaptiveGroups;
    if (Array.isArray(groups)) {
      return { ok: true, minutes: sumGroups(groups, (g) => g.sum?.buildMinutes) };
    }
  }

  const aggregateQuery = `query WorkersBuildMinutesTotal($accountTag: String!, $monthStart: DateTime!, $now: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersBuildsBuildMinutesAdaptiveGroups(
          limit: 1,
          filter: { datetime_geq: $monthStart, datetime_leq: $now }
        ) {
          sum { buildMinutes }
        }
      }
    }
  }`;

  const aggregateResult = await safeQuery('workers-builds', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, aggregateQuery, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (!aggregateResult.ok) {
    return dailyResult.ok ? { ok: false, error: 'workers-builds: no build minute data' } : aggregateResult;
  }

  const groups = getAccount(aggregateResult.data).workersBuildsBuildMinutesAdaptiveGroups;
  return {
    ok: true,
    minutes: sumGroups(groups, (g) => g.sum?.buildMinutes),
  };
}

function dedupeResourcesById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

async function fetchWorkerScripts(
  token: string,
  accountId: string,
): Promise<{ ok: true; scripts: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const result = await safeQuery('worker-scripts', async () => {
    const scripts: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    const appendUnique = (batch: Array<{ id?: string }>) => {
      for (const script of batch) {
        if (!script.id || seen.has(script.id)) continue;
        seen.add(script.id);
        scripts.push({ id: script.id, name: script.id });
      }
    };

    const first = await restRequestRaw<Array<{ id?: string }>>(
      token,
      `/accounts/${accountId}/workers/scripts`,
    );
    appendUnique(first.result ?? []);

    const totalPages = first.result_info?.total_pages ?? 1;
    for (let page = 2; page <= totalPages && page <= 100; page++) {
      const body = await restRequestRaw<Array<{ id?: string }>>(
        token,
        `/accounts/${accountId}/workers/scripts?page=${page}`,
      );
      appendUnique(body.result ?? []);
    }
    return scripts;
  });

  if (!result.ok) return result;
  return { ok: true, scripts: result.data };
}

async function fetchPagesProjects(
  token: string,
  accountId: string,
): Promise<{ ok: true; projects: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const result = await safeQuery('pages-projects', async () => {
    const projects: Array<{ id: string; name: string }> = [];
    const first = await restRequestRaw<PagesProject[]>(
      token,
      `/accounts/${accountId}/pages/projects`,
    );
    const appendBatch = (batch: PagesProject[]) => {
      for (const project of batch) {
        if (project.name) {
          projects.push({ id: project.name, name: project.name });
        }
      }
    };
    appendBatch(first.result ?? []);

    const totalPages = first.result_info?.total_pages ?? 1;
    for (let page = 2; page <= totalPages && page <= 100; page++) {
      const body = await restRequestRaw<PagesProject[]>(
        token,
        `/accounts/${accountId}/pages/projects?page=${page}`,
      );
      appendBatch(body.result ?? []);
    }
    return projects;
  });

  if (!result.ok) return result;
  return { ok: true, projects: result.data };
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

async function fetchWorkersRequestMetrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
): Promise<
  | { ok: true; workersRequests: number; byScript: Map<string, number> }
  | { ok: false; error: string }
> {
  const workersQuery = `query WorkersRequestMetrics($accountTag: String!, $dayStart: DateTime!, $dayEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          dimensions { scriptName }
          sum { requests }
        }
      }
    }
  }`;

  const result = await safeQuery('workers-requests', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, workersQuery, {
      accountTag: accountId,
      dayStart: day.start,
      dayEnd: day.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  const byScript = new Map<string, number>();
  let workersRequests = 0;
  for (const g of acc.workersInvocationsAdaptive ?? []) {
    const requests = g.sum?.requests ?? 0;
    workersRequests += requests;
    const scriptName = g.dimensions?.scriptName ?? '';
    if (scriptName) {
      byScript.set(scriptName, (byScript.get(scriptName) ?? 0) + requests);
    }
  }

  return { ok: true, workersRequests, byScript };
}

function sumPagesScriptRequests(
  projectName: string,
  byScript: Map<string, number>,
): number {
  const normalized = projectName.toLowerCase();
  let total = 0;
  for (const [script, requests] of byScript) {
    const scriptLower = script.toLowerCase();
    if (
      scriptLower === normalized
      || scriptLower.endsWith(`-${normalized}`)
      || scriptLower.startsWith(`${normalized}-`)
    ) {
      total += requests;
    }
  }
  return total;
}

async function fetchPagesRequestMetrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
  projects: Array<{ id: string; name: string }>,
): Promise<
  | { ok: true; pagesRequests: number; byProject: Map<string, number> }
  | { ok: false; error: string }
> {
  const pagesTotalQuery = `query PagesRequestMetrics($accountTag: String!, $dayStart: DateTime!, $dayEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
          sum { requests }
        }
      }
    }
  }`;

  const totalResult = await safeQuery('pages-requests', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, pagesTotalQuery, {
      accountTag: accountId,
      dayStart: day.start,
      dayEnd: day.end,
    }),
  );

  if (!totalResult.ok) return totalResult;

  const acc = getAccount(totalResult.data);
  const pagesRequests = sumGroups(
    acc.pagesFunctionsInvocationsAdaptiveGroups,
    (g) => g.sum?.requests,
  );

  const byProject = new Map<string, number>();
  if (projects.length > 0) {
    const pagesBreakdownQuery = `query PagesRequestBreakdown($accountTag: String!, $dayStart: DateTime!, $dayEnd: DateTime!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayStart, datetime_leq: $dayEnd }) {
            dimensions { scriptName }
            sum { requests }
          }
        }
      }
    }`;

    const breakdownResult = await safeQuery('pages-requests-breakdown', () =>
      graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, pagesBreakdownQuery, {
        accountTag: accountId,
        dayStart: day.start,
        dayEnd: day.end,
      }),
    );

    const byScript = new Map<string, number>();
    if (breakdownResult.ok) {
      const breakdownAcc = getAccount(breakdownResult.data);
      for (const g of breakdownAcc.pagesFunctionsInvocationsAdaptiveGroups ?? []) {
        const scriptName = g.dimensions?.scriptName ?? '';
        if (!scriptName || isUuidLike(scriptName)) continue;
        const requests = g.sum?.requests ?? 0;
        byScript.set(scriptName, (byScript.get(scriptName) ?? 0) + requests);
      }
    }

    for (const project of projects) {
      byProject.set(project.name, sumPagesScriptRequests(project.name, byScript));
    }
  }

  return { ok: true, pagesRequests, byProject };
}

async function fetchD1Databases(
  token: string,
  accountId: string,
): Promise<{ ok: true; databases: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const result = await safeQuery('d1-databases', async () => {
    const databases: Array<{ id: string; name: string }> = [];
    const first = await restRequestRaw<D1DatabaseInfo[]>(
      token,
      `/accounts/${accountId}/d1/database?per_page=100`,
    );
    const appendBatch = (batch: D1DatabaseInfo[]) => {
      for (const db of batch) {
        if (db.uuid) {
          databases.push({ id: db.uuid, name: db.name?.trim() || db.uuid });
        }
      }
    };
    appendBatch(first.result ?? []);

    let page = 2;
    while (page <= 100) {
      const body = await restRequestRaw<D1DatabaseInfo[]>(
        token,
        `/accounts/${accountId}/d1/database?per_page=100&page=${page}`,
      );
      const batch = body.result ?? [];
      appendBatch(batch);
      if (batch.length < 100) break;
      page += 1;
    }
    return databases;
  });

  if (!result.ok) return result;
  return { ok: true, databases: result.data };
}

async function fetchKvNamespaces(
  token: string,
  accountId: string,
): Promise<{ ok: true; namespaces: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const result = await safeQuery('kv-namespaces', async () => {
    const namespaces: Array<{ id: string; name: string }> = [];
    const first = await restRequestRaw<KvNamespaceInfo[]>(
      token,
      `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
    );
    const appendBatch = (batch: KvNamespaceInfo[]) => {
      for (const ns of batch) {
        if (ns.id) {
          namespaces.push({ id: ns.id, name: ns.title?.trim() || ns.id });
        }
      }
    };
    appendBatch(first.result ?? []);

    let page = 2;
    while (page <= 100) {
      const body = await restRequestRaw<KvNamespaceInfo[]>(
        token,
        `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
      );
      const batch = body.result ?? [];
      appendBatch(batch);
      if (batch.length < 100) break;
      page += 1;
    }
    return namespaces;
  });

  if (!result.ok) return result;
  return { ok: true, namespaces: result.data };
}

async function fetchD1Metrics(
  token: string,
  accountId: string,
  day: { start: string; end: string },
  month: { start: string; end: string },
): Promise<
  | {
    ok: true;
    d1Reads: number;
    d1Writes: number;
    d1StorageBytes: number;
    byDatabase: Map<string, { reads: number; writes: number; storageBytes: number }>;
  }
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
          dimensions { databaseId }
          sum { rowsRead rowsWritten }
        }
        d1StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          dimensions { databaseId datetime }
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
  const byDatabase = new Map<string, { reads: number; writes: number; storageBytes: number }>();
  const ensureDb = (id: string) => {
    if (!byDatabase.has(id)) {
      byDatabase.set(id, { reads: 0, writes: 0, storageBytes: 0 });
    }
    return byDatabase.get(id)!;
  };

  for (const g of acc.d1AnalyticsAdaptiveGroups ?? []) {
    const id = g.dimensions?.databaseId ?? '';
    if (!id) continue;
    const entry = ensureDb(id);
    entry.reads += g.sum?.rowsRead ?? 0;
    entry.writes += g.sum?.rowsWritten ?? 0;
  }

  const latestStorage = new Map<string, { bytes: number; datetime: string }>();
  for (const g of acc.d1StorageAdaptiveGroups ?? []) {
    const id = g.dimensions?.databaseId ?? '';
    if (!id) continue;
    const datetime = g.dimensions?.datetime ?? '';
    const bytes = g.max?.databaseSizeBytes ?? 0;
    const prev = latestStorage.get(id);
    if (!prev || datetime > prev.datetime) {
      latestStorage.set(id, { bytes, datetime });
    }
  }
  for (const [id, { bytes }] of latestStorage) {
    ensureDb(id).storageBytes = bytes;
  }

  return {
    ok: true,
    d1Reads: sumGroups(acc.d1AnalyticsAdaptiveGroups, (g) => g.sum?.rowsRead),
    d1Writes: sumGroups(acc.d1AnalyticsAdaptiveGroups, (g) => g.sum?.rowsWritten),
    d1StorageBytes: [...latestStorage.values()].reduce((t, v) => t + v.bytes, 0),
    byDatabase,
  };
}

async function fetchKvOperations(
  token: string,
  accountId: string,
  dayDate: { start: string; end: string },
): Promise<
  | {
    ok: true;
    kvReads: number;
    kvWrites: number;
    kvDeletes: number;
    kvLists: number;
    byNamespace: Map<string, { reads: number; writes: number; deletes: number; lists: number }>;
  }
  | { ok: false; error: string }
> {
  const kvOpsQuery = `query KvOps($accountTag: String!, $dayStart: Date!, $dateEnd: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $dayStart, date_leq: $dateEnd }) {
          dimensions { namespaceId actionType }
          sum { requests }
        }
      }
    }
  }`;

  const result = await safeQuery('kv-ops', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, kvOpsQuery, {
      accountTag: accountId,
      dayStart: dayDate.start,
      dateEnd: dayDate.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  let kvReads = 0;
  let kvWrites = 0;
  let kvDeletes = 0;
  let kvLists = 0;
  const byNamespace = new Map<string, { reads: number; writes: number; deletes: number; lists: number }>();
  const ensureNs = (id: string) => {
    if (!byNamespace.has(id)) {
      byNamespace.set(id, { reads: 0, writes: 0, deletes: 0, lists: 0 });
    }
    return byNamespace.get(id)!;
  };

  for (const g of acc.kvOperationsAdaptiveGroups ?? []) {
    const n = g.sum?.requests ?? 0;
    const action = (g.dimensions?.actionType ?? '').toLowerCase();
    const nsId = g.dimensions?.namespaceId ?? '';
    if (action.includes('read')) kvReads += n;
    else if (action.includes('write')) kvWrites += n;
    else if (action.includes('delete')) kvDeletes += n;
    else if (action.includes('list')) kvLists += n;

    if (!nsId) continue;
    const entry = ensureNs(nsId);
    if (action.includes('read')) entry.reads += n;
    else if (action.includes('write')) entry.writes += n;
    else if (action.includes('delete')) entry.deletes += n;
    else if (action.includes('list')) entry.lists += n;
  }

  return { ok: true, kvReads, kvWrites, kvDeletes, kvLists, byNamespace };
}

async function fetchKvStorage(
  token: string,
  accountId: string,
  monthDate: { start: string; end: string },
): Promise<
  | { ok: true; kvStorageBytes: number; byNamespace: Map<string, number> }
  | { ok: false; error: string }
> {
  const kvStorageQuery = `query KvStorage($accountTag: String!, $storageStart: Date!, $dateEnd: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        kvStorageAdaptiveGroups(
          limit: 10000,
          filter: { date_geq: $storageStart, date_leq: $dateEnd },
          orderBy: [date_DESC]
        ) {
          max { byteCount }
          dimensions { date namespaceId }
        }
      }
    }
  }`;

  const result = await safeQuery('kv-storage', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, kvStorageQuery, {
      accountTag: accountId,
      storageStart: monthDate.start,
      dateEnd: monthDate.end,
    }),
  );

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  const latestByNamespace = new Map<string, { bytes: number; date: string }>();
  for (const g of acc.kvStorageAdaptiveGroups ?? []) {
    const ns = (g as { dimensions?: { namespaceId?: string; date?: string } }).dimensions?.namespaceId ?? '';
    const date = (g as { dimensions?: { namespaceId?: string; date?: string } }).dimensions?.date ?? '';
    const bytes = g.max?.byteCount ?? 0;
    const prev = latestByNamespace.get(ns);
    if (!prev || date > prev.date) {
      latestByNamespace.set(ns, { bytes, date });
    }
  }

  const kvStorageBytes = [...latestByNamespace.values()].reduce((t, v) => t + v.bytes, 0);
  const byNamespace = new Map<string, number>();
  for (const [ns, { bytes }] of latestByNamespace) {
    byNamespace.set(ns, bytes);
  }
  return { ok: true, kvStorageBytes, byNamespace };
}

async function fetchKvMetrics(
  token: string,
  accountId: string,
  dayDate: { start: string; end: string },
  monthDate: { start: string; end: string },
): Promise<
  | {
    ok: true;
    kvReads: number;
    kvWrites: number;
    kvDeletes: number;
    kvLists: number;
    kvStorageBytes: number;
    byNamespace: Map<string, {
      reads: number;
      writes: number;
      deletes: number;
      lists: number;
      storageBytes: number;
    }>;
    errors: string[];
  }
  | { ok: false; error: string }
> {
  const opsResult = await fetchKvOperations(token, accountId, dayDate);
  const storageResult = await fetchKvStorage(token, accountId, monthDate);
  const errors: string[] = [];

  if (!opsResult.ok) errors.push(opsResult.error);
  if (!storageResult.ok) errors.push(storageResult.error);

  if (!opsResult.ok && !storageResult.ok) {
    return { ok: false, error: errors.join('; ') };
  }

  const byNamespace = new Map<string, {
    reads: number;
    writes: number;
    deletes: number;
    lists: number;
    storageBytes: number;
  }>();
  const ensureNs = (id: string) => {
    if (!byNamespace.has(id)) {
      byNamespace.set(id, { reads: 0, writes: 0, deletes: 0, lists: 0, storageBytes: 0 });
    }
    return byNamespace.get(id)!;
  };

  if (opsResult.ok) {
    for (const [id, usage] of opsResult.byNamespace) {
      const entry = ensureNs(id);
      entry.reads = usage.reads;
      entry.writes = usage.writes;
      entry.deletes = usage.deletes;
      entry.lists = usage.lists;
    }
  }
  if (storageResult.ok) {
    for (const [id, bytes] of storageResult.byNamespace) {
      ensureNs(id).storageBytes = bytes;
    }
  }

  return {
    ok: true,
    kvReads: opsResult.ok ? opsResult.kvReads : 0,
    kvWrites: opsResult.ok ? opsResult.kvWrites : 0,
    kvDeletes: opsResult.ok ? opsResult.kvDeletes : 0,
    kvLists: opsResult.ok ? opsResult.kvLists : 0,
    kvStorageBytes: storageResult.ok ? storageResult.kvStorageBytes : 0,
    byNamespace,
    errors,
  };
}

async function fetchR2Metrics(
  token: string,
  accountId: string,
  month: { start: string; end: string },
): Promise<
  | {
    ok: true;
    r2Storage: number;
    r2ClassA: number;
    r2ClassB: number;
    byBucket: Map<string, { storageBytes: number; classA: number; classB: number }>;
  }
  | { ok: false; error: string }
> {
  const r2QueryDetailed = `query R2Metrics($accountTag: String!, $monthStart: DateTime!, $monthEnd: DateTime!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          dimensions { bucketName datetime }
          max { payloadSize metadataSize }
        }
        r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $monthEnd }) {
          dimensions { bucketName actionType }
          sum { requests }
        }
      }
    }
  }`;

  const r2QueryLegacy = `query R2Metrics($accountTag: String!, $monthStart: DateTime!, $monthEnd: DateTime!) {
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

  const variables = {
    accountTag: accountId,
    monthStart: month.start,
    monthEnd: month.end,
  };

  let result = await safeQuery('r2', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, r2QueryDetailed, variables),
  );
  let detailed = true;
  if (!result.ok) {
    result = await safeQuery('r2', () =>
      graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, r2QueryLegacy, variables),
    );
    detailed = false;
  }

  if (!result.ok) return result;

  const acc = getAccount(result.data);
  const byBucket = new Map<string, { storageBytes: number; classA: number; classB: number }>();
  const ensureBucket = (name: string) => {
    if (!byBucket.has(name)) {
      byBucket.set(name, { storageBytes: 0, classA: 0, classB: 0 });
    }
    return byBucket.get(name)!;
  };

  let r2Storage = 0;
  let r2ClassA = 0;
  let r2ClassB = 0;

  const latestStorage = new Map<string, { bytes: number; datetime: string }>();
  for (const g of acc.r2StorageAdaptiveGroups ?? []) {
    const bytes = (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0);
    const bucketName = detailed ? (g.dimensions?.bucketName ?? '') : '';
    if (bucketName) {
      const datetime = g.dimensions?.datetime ?? '';
      const prev = latestStorage.get(bucketName);
      if (!prev || datetime > prev.datetime) {
        latestStorage.set(bucketName, { bytes, datetime });
      }
    } else {
      r2Storage += bytes;
    }
  }
  for (const [name, { bytes }] of latestStorage) {
    ensureBucket(name).storageBytes = bytes;
    r2Storage += bytes;
  }

  for (const g of acc.r2OperationsAdaptiveGroups ?? []) {
    const requests = g.sum?.requests ?? 0;
    const action = g.dimensions?.actionType ?? '';
    const bucketName = detailed ? (g.dimensions?.bucketName ?? '') : '';
    if (R2_CLASS_B.has(action)) r2ClassB += requests;
    else if (R2_CLASS_A.has(action)) r2ClassA += requests;

    if (!bucketName) continue;
    const entry = ensureBucket(bucketName);
    if (R2_CLASS_B.has(action)) entry.classB += requests;
    else if (R2_CLASS_A.has(action)) entry.classA += requests;
  }

  return { ok: true, r2Storage, r2ClassA, r2ClassB, byBucket };
}

async function fetchVectorizeQueried(
  token: string,
  accountId: string,
  monthStart: string,
  nowIso: string,
): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  const v2Query = `query VectorizeQueriedV2($accountTag: String!, $monthStart: Time!, $now: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        vectorizeV2QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
          sum { queriedVectorDimensions }
        }
      }
    }
  }`;

  const v2Result = await safeQuery('vectorize-queried', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, v2Query, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (v2Result.ok) {
    const acc = getAccount(v2Result.data);
    return {
      ok: true,
      value: sumGroups(acc.vectorizeV2QueriesAdaptiveGroups, (g) => g.sum?.queriedVectorDimensions),
    };
  }

  const v1Query = `query VectorizeQueriedV1($accountTag: String!, $monthStart: Time!, $now: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        vectorizeQueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
          sum { queriedVectorDimensions }
        }
      }
    }
  }`;

  const v1Result = await safeQuery('vectorize-queried', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, v1Query, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (!v1Result.ok) {
    if (!isUnknownGraphqlFieldError(v1Result.error)) return v1Result;
    const countQuery = `query VectorizeQueriedCount($accountTag: String!, $monthStart: Time!, $now: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          vectorizeV2QueriesAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
            count
          }
        }
      }
    }`;
    const countResult = await safeQuery('vectorize-queried', () =>
      graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, countQuery, {
        accountTag: accountId,
        monthStart,
        now: nowIso,
      }),
    );
    if (!countResult.ok) return countResult;
    const accCount = getAccount(countResult.data);
    return {
      ok: true,
      value: sumGroups(accCount.vectorizeV2QueriesAdaptiveGroups, (g) => g.count),
    };
  }

  const acc = getAccount(v1Result.data);
  return {
    ok: true,
    value: sumGroups(acc.vectorizeQueriesAdaptiveGroups, (g) => g.sum?.queriedVectorDimensions),
  };
}

function sumVectorizeStored(
  groups: Array<{
    max?: { storedVectorDimensions?: number };
    dimensions?: { indexName?: string; datetime?: string };
  }> | undefined,
): number {
  const latestByIndex = new Map<string, { dims: number; date: string }>();
  for (const g of groups ?? []) {
    const indexName = g.dimensions?.indexName ?? '';
    const date = g.dimensions?.datetime ?? '';
    const dims = g.max?.storedVectorDimensions ?? 0;
    const prev = latestByIndex.get(indexName);
    if (!prev || date > prev.date) {
      latestByIndex.set(indexName, { dims, date });
    }
  }
  return [...latestByIndex.values()].reduce((t, v) => t + v.dims, 0);
}

interface VectorizeIndexSummary {
  name: string;
}

interface VectorizeIndexInfo {
  vectorCount?: number;
  config?: { dimensions?: number };
}

async function fetchVectorizeStoredRest(token: string, accountId: string): Promise<number> {
  const list = await restRequestRaw<VectorizeIndexSummary[]>(
    token,
    `/accounts/${accountId}/vectorize/v2/indexes`,
  );
  let total = 0;
  for (const index of list.result ?? []) {
    const info = await restRequestRaw<VectorizeIndexInfo>(
      token,
      `/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(index.name)}`,
    );
    const count = info.result?.vectorCount ?? 0;
    const dims = info.result?.config?.dimensions ?? 0;
    total += count * dims;
  }
  return total;
}

async function fetchVectorizeStored(
  token: string,
  accountId: string,
  monthStart: string,
  nowIso: string,
): Promise<{ ok: true; value: number } | { ok: false; error: string }> {
  const v2Query = `query VectorizeStoredV2($accountTag: String!, $monthStart: Time!, $now: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        vectorizeV2StorageAdaptiveGroups(
          limit: 10000,
          filter: { datetime_geq: $monthStart, datetime_leq: $now },
          orderBy: [datetime_DESC]
        ) {
          max { storedVectorDimensions }
          dimensions { indexName datetime }
        }
      }
    }
  }`;

  const v2Result = await safeQuery('vectorize-stored', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, v2Query, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (v2Result.ok) {
    const acc = getAccount(v2Result.data);
    return { ok: true, value: sumVectorizeStored(acc.vectorizeV2StorageAdaptiveGroups) };
  }

  const restResult = await safeQuery('vectorize-stored', () =>
    fetchVectorizeStoredRest(token, accountId),
  );
  if (restResult.ok) {
    return { ok: true, value: restResult.data };
  }

  const v1Query = `query VectorizeStoredV1($accountTag: String!, $monthStart: Time!, $now: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        vectorizeStorageAdaptiveGroups(
          limit: 10000,
          filter: { datetime_geq: $monthStart, datetime_leq: $now },
          orderBy: [datetime_DESC]
        ) {
          max { storedVectorDimensions }
          dimensions { indexName datetime }
        }
      }
    }
  }`;

  const v1Result = await safeQuery('vectorize-stored', () =>
    graphqlRequest<{ viewer?: { accounts?: ViewerAccount[] } }>(token, v1Query, {
      accountTag: accountId,
      monthStart,
      now: nowIso,
    }),
  );

  if (!v1Result.ok) return v1Result;

  const acc = getAccount(v1Result.data);
  const latestByIndex = new Map<string, number>();
  for (const g of acc.vectorizeStorageAdaptiveGroups ?? []) {
    const indexName = g.dimensions?.indexName ?? '';
    const dims = g.max?.storedVectorDimensions ?? 0;
    latestByIndex.set(indexName, dims);
  }
  return {
    ok: true,
    value: [...latestByIndex.values()].reduce((t, v) => t + v, 0),
  };
}

async function fetchVectorizeMetrics(
  token: string,
  accountId: string,
  monthStart: string,
  nowIso: string,
): Promise<{
  vectorizeQueried: number;
  vectorizeStored: number;
  queriedOk: boolean;
  storedOk: boolean;
  errors: string[];
}> {
  const queriedResult = await fetchVectorizeQueried(token, accountId, monthStart, nowIso);
  const storedResult = await fetchVectorizeStored(token, accountId, monthStart, nowIso);
  const errors: string[] = [];
  if (!queriedResult.ok) errors.push(queriedResult.error);
  if (!storedResult.ok) errors.push(storedResult.error);

  return {
    vectorizeQueried: queriedResult.ok ? queriedResult.value : 0,
    vectorizeStored: storedResult.ok ? storedResult.value : 0,
    queriedOk: queriedResult.ok,
    storedOk: storedResult.ok,
    errors,
  };
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

  const firstPage = await restRequestRaw<PagesProject[]>(
    token,
    `/accounts/${accountId}/pages/projects`,
  );
  projects.push(...(firstPage.result ?? []));

  const totalPages = firstPage.result_info?.total_pages ?? 1;
  for (let page = 2; page <= totalPages && page <= 100; page++) {
    const body = await restRequestRaw<PagesProject[]>(
      token,
      `/accounts/${accountId}/pages/projects?page=${page}`,
    );
    projects.push(...(body.result ?? []));
  }

  let totalBuilds = 0;
  for (const project of projects) {
    try {
      let page = 1;
      while (page <= 200) {
        const path =
          page === 1
            ? `/accounts/${accountId}/pages/projects/${encodeURIComponent(project.name)}/deployments`
            : `/accounts/${accountId}/pages/projects/${encodeURIComponent(project.name)}/deployments?page=${page}`;
        const body = await restRequestRaw<PagesDeployment[]>(token, path);
        const list = body.result ?? [];
        totalBuilds += list.filter((d) => {
          const created = new Date(d.created_on).getTime();
          return created >= startTime && created <= endTime;
        }).length;

        const oldest = list.length ? new Date(list[list.length - 1].created_on).getTime() : null;
        const totalDeploymentPages = body.result_info?.total_pages ?? 1;
        if (!list.length || page >= totalDeploymentPages || (oldest && oldest < startTime)) break;
        page += 1;
      }
    } catch {
      /* skip project on REST failure; other projects may still succeed */
    }
  }
  return totalBuilds;
}

function sortResourceItems(items: ResourceUsageItem[], score: (item: ResourceUsageItem) => number): ResourceUsageItem[] {
  return [...items].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

function buildWorkersBreakdown(
  scripts: Array<{ id: string; name: string }>,
  byScript: Map<string, number>,
): ResourceUsageItem[] {
  return sortResourceItems(
    dedupeResourcesById(scripts).map((script) => ({
      id: script.id,
      name: script.name,
      requests: byScript.get(script.id) ?? 0,
    })),
    (item) => item.requests ?? 0,
  );
}

function buildPagesBreakdown(
  projects: Array<{ id: string; name: string }>,
  byProject: Map<string, number>,
): ResourceUsageItem[] {
  return sortResourceItems(
    projects.map((project) => ({
      id: project.id,
      name: project.name,
      requests: byProject.get(project.id) ?? 0,
    })),
    (item) => item.requests ?? 0,
  );
}

function buildD1Breakdown(
  databases: Array<{ id: string; name: string }>,
  byDatabase: Map<string, { reads: number; writes: number; storageBytes: number }>,
): ResourceUsageItem[] {
  return sortResourceItems(
    databases.map((db) => {
      const usage = byDatabase.get(db.id);
      return {
        id: db.id,
        name: db.name,
        reads: usage?.reads ?? 0,
        writes: usage?.writes ?? 0,
        storageBytes: usage?.storageBytes ?? 0,
      };
    }),
    (item) => (item.reads ?? 0) + (item.writes ?? 0) + (item.storageBytes ?? 0),
  );
}

function buildKvBreakdown(
  namespaces: Array<{ id: string; name: string }>,
  byNamespace: Map<string, {
    reads: number;
    writes: number;
    deletes: number;
    lists: number;
    storageBytes: number;
  }>,
): ResourceUsageItem[] {
  return sortResourceItems(
    namespaces
      .filter((ns) => !isUuidLike(ns.name))
      .map((ns) => {
        const usage = byNamespace.get(ns.id);
        return {
          id: ns.id,
          name: ns.name,
          reads: usage?.reads ?? 0,
          writes: usage?.writes ?? 0,
          deletes: usage?.deletes ?? 0,
          lists: usage?.lists ?? 0,
          storageBytes: usage?.storageBytes ?? 0,
        };
      }),
    (item) => (item.reads ?? 0) + (item.writes ?? 0) + (item.storageBytes ?? 0),
  );
}

function normalizeR2BucketKey(name: string): string {
  return name.replace(/^(eu|fedramp)_(.+)$/i, '$2');
}

function buildR2Breakdown(
  buckets: Array<{ name: string }>,
  byBucket: Map<string, { storageBytes: number; classA: number; classB: number }>,
): ResourceUsageItem[] {
  const usageByKey = new Map<string, { storageBytes: number; classA: number; classB: number }>();
  for (const [name, usage] of byBucket) {
    const key = normalizeR2BucketKey(name);
    const prev = usageByKey.get(key) ?? { storageBytes: 0, classA: 0, classB: 0 };
    usageByKey.set(key, {
      storageBytes: prev.storageBytes + usage.storageBytes,
      classA: prev.classA + usage.classA,
      classB: prev.classB + usage.classB,
    });
  }

  return sortResourceItems(
    buckets.map((bucket) => {
      const key = normalizeR2BucketKey(bucket.name);
      const usage = usageByKey.get(key);
      return {
        id: bucket.name,
        name: bucket.name,
        storageBytes: usage?.storageBytes ?? 0,
        classA: usage?.classA ?? 0,
        classB: usage?.classB ?? 0,
      };
    }),
    (item) => (item.storageBytes ?? 0) + (item.classA ?? 0) + (item.classB ?? 0),
  );
}

async function fetchAllMetrics(
  token: string,
  accountId: string,
  limits: FreeTierLimitsConfig,
): Promise<{ quotas: QuotasMap; partialErrors: string[]; serviceStatus: ServiceStatusMap; resourceBreakdown: ResourceBreakdown }> {
  const ranges = getUtcRanges();
  const partialErrors: string[] = [];

  const nowIso = new Date().toISOString();
  const coreResult = await fetchCoreMetrics(token, accountId, ranges.day, ranges.month);
  const acc = coreResult.acc;
  if (coreResult.errors.length) partialErrors.push(...coreResult.errors);

  const workersBuildsResult = await fetchWorkersBuildMinutes(
    token,
    accountId,
    ranges.month.start,
    nowIso,
  );

  const workersMetricsResult = await fetchWorkersRequestMetrics(token, accountId, ranges.day);
  const workerScriptsResult = await fetchWorkerScripts(token, accountId);
  const pagesProjectsResult = await fetchPagesProjects(token, accountId);
  const pagesMetricsResult = await fetchPagesRequestMetrics(
    token,
    accountId,
    ranges.day,
    pagesProjectsResult.ok ? pagesProjectsResult.projects : [],
  );

  const d1Result = await fetchD1Metrics(token, accountId, ranges.day, ranges.month);
  const d1DatabasesResult = await fetchD1Databases(token, accountId);
  const kvNamespacesResult = await fetchKvNamespaces(token, accountId);
  const kvResult = await fetchKvMetrics(token, accountId, ranges.dayDate, ranges.monthDate);
  const r2BucketsResult = await fetchR2Buckets(token, accountId);
  const r2Result = await fetchR2Metrics(token, accountId, ranges.month);
  const vectorizeResult = await fetchVectorizeMetrics(token, accountId, ranges.month.start, nowIso);

  const pagesResult = await safeQuery('pages', () =>
    fetchPagesBuilds(token, accountId, ranges.month.start, nowIso),
  );

  if (!workersMetricsResult.ok) partialErrors.push(workersMetricsResult.error);
  if (!pagesMetricsResult.ok) partialErrors.push(pagesMetricsResult.error);
  if (!d1Result.ok) partialErrors.push(d1Result.error);
  if (!kvResult.ok) partialErrors.push(kvResult.error);
  else if (kvResult.errors.length) partialErrors.push(...kvResult.errors);
  if (!r2Result.ok) partialErrors.push(r2Result.error);
  if (!pagesResult.ok) partialErrors.push(pagesResult.error);
  if (!workersBuildsResult.ok) partialErrors.push(workersBuildsResult.error);

  const kvOpsOk = kvResult.ok && !kvResult.errors.some((e) => e.startsWith('kv-ops'));
  const kvStorageOk = kvResult.ok && !kvResult.errors.some((e) => e.startsWith('kv-storage'));

  const workersRequests = workersMetricsResult.ok ? workersMetricsResult.workersRequests : 0;
  const pagesRequests = pagesMetricsResult.ok ? pagesMetricsResult.pagesRequests : 0;

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
  const workersBuildMinutes = workersBuildsResult.ok ? workersBuildsResult.minutes : 0;
  const workersBuildsOk = workersBuildsResult.ok;

  const doRequests = sumGroups(
    acc.durableObjectsInvocationsAdaptiveGroups,
    (g) => g.sum?.requests,
  );
  const doDuration = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.duration);
  const doRowsRead = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.rowsRead);
  const doRowsWritten = sumGroups(acc.durableObjectsPeriodicGroups, (g) => g.sum?.rowsWritten);
  const doSqlStorage = sumGroups(acc.durableObjectsSqlStorageGroups, (g) => g.max?.storedBytes);

  const quotas: QuotasMap = {
    workers_requests: buildMetric(
      'workers_requests',
      workersRequests,
      limits.workers_requests,
      workersMetricsResult.ok,
      workersMetricsResult.ok ? undefined : metricNote('workers-requests', partialErrors),
    ),
    d1_reads: buildMetric(
      'd1_reads',
      d1Result.ok ? d1Result.d1Reads : 0,
      limits.d1_reads,
      d1Result.ok,
      d1Result.ok ? undefined : metricNote('d1', partialErrors),
    ),
    d1_writes: buildMetric(
      'd1_writes',
      d1Result.ok ? d1Result.d1Writes : 0,
      limits.d1_writes,
      d1Result.ok,
      d1Result.ok ? undefined : metricNote('d1', partialErrors),
    ),
    d1_storage_gb: buildMetric(
      'd1_storage_gb',
      d1Result.ok ? d1Result.d1StorageBytes : 0,
      limits.d1_storage_gb,
      d1Result.ok,
      d1Result.ok ? undefined : metricNote('d1', partialErrors),
    ),
    d1_databases: buildMetric(
      'd1_databases',
      d1DatabasesResult.ok ? d1DatabasesResult.databases.length : 0,
      limits.d1_databases,
      d1DatabasesResult.ok,
      d1DatabasesResult.ok
        ? undefined
        : d1DatabaseMetricNote(d1DatabasesResult.error),
    ),
    kv_reads: buildMetric(
      'kv_reads',
      kvResult.ok ? kvResult.kvReads : 0,
      limits.kv_reads,
      kvOpsOk,
      kvOpsOk ? undefined : metricNote('kv-ops', partialErrors),
    ),
    kv_writes: buildMetric(
      'kv_writes',
      kvResult.ok ? kvResult.kvWrites : 0,
      limits.kv_writes,
      kvOpsOk,
      kvOpsOk ? undefined : metricNote('kv-ops', partialErrors),
    ),
    kv_deletes: buildMetric(
      'kv_deletes',
      kvResult.ok ? kvResult.kvDeletes : 0,
      limits.kv_deletes,
      kvOpsOk,
      kvOpsOk ? undefined : metricNote('kv-ops', partialErrors),
    ),
    kv_lists: buildMetric(
      'kv_lists',
      kvResult.ok ? kvResult.kvLists : 0,
      limits.kv_lists,
      kvOpsOk,
      kvOpsOk ? undefined : metricNote('kv-ops', partialErrors),
    ),
    kv_storage_gb: buildMetric(
      'kv_storage_gb',
      kvResult.ok ? kvResult.kvStorageBytes : 0,
      limits.kv_storage_gb,
      kvStorageOk,
      kvStorageOk ? undefined : metricNote('kv-storage', partialErrors),
    ),
    kv_namespaces: buildMetric(
      'kv_namespaces',
      kvNamespacesResult.ok ? kvNamespacesResult.namespaces.length : 0,
      limits.kv_namespaces,
      kvNamespacesResult.ok,
      kvNamespacesResult.ok
        ? undefined
        : kvNamespaceMetricNote(kvNamespacesResult.error),
    ),
    r2_storage_gb: buildMetric(
      'r2_storage_gb',
      r2Result.ok ? r2Result.r2Storage : 0,
      limits.r2_storage_gb,
      r2Result.ok,
      r2Result.ok ? undefined : metricNote('r2', partialErrors),
    ),
    r2_class_a: buildMetric(
      'r2_class_a',
      r2Result.ok ? r2Result.r2ClassA : 0,
      limits.r2_class_a,
      r2Result.ok,
      r2Result.ok ? undefined : metricNote('r2', partialErrors),
    ),
    r2_class_b: buildMetric(
      'r2_class_b',
      r2Result.ok ? r2Result.r2ClassB : 0,
      limits.r2_class_b,
      r2Result.ok,
      r2Result.ok ? undefined : metricNote('r2', partialErrors),
    ),
    r2_buckets: buildMetric(
      'r2_buckets',
      r2BucketsResult.ok ? r2BucketsResult.count : 0,
      limits.r2_buckets,
      r2BucketsResult.ok,
      r2BucketsResult.ok
        ? undefined
        : r2BucketMetricNote(r2BucketsResult.error),
    ),
    pages_builds: buildMetric(
      'pages_builds',
      pagesResult.ok ? pagesResult.data : 0,
      limits.pages_builds,
      pagesResult.ok,
      pagesResult.ok ? undefined : metricNote('pages', partialErrors),
    ),
    workers_build_minutes: buildMetric(
      'workers_build_minutes',
      workersBuildMinutes,
      limits.workers_build_minutes,
      workersBuildsOk,
      workersBuildsOk
        ? undefined
        : 'Workers Builds minutes unavailable via GraphQL for this account',
    ),
    pages_requests: buildMetric(
      'pages_requests',
      pagesRequests,
      limits.pages_requests,
      pagesMetricsResult.ok,
      pagesMetricsResult.ok ? undefined : metricNote('pages-requests', partialErrors),
    ),
    ai_neurons: buildMetric('ai_neurons', aiNeurons, limits.ai_neurons),
    queues_ops: buildMetric('queues_ops', queuesOps, limits.queues_ops),
    vectorize_queried_dims: buildMetric(
      'vectorize_queried_dims',
      vectorizeResult.vectorizeQueried,
      limits.vectorize_queried_dims,
      vectorizeResult.queriedOk,
      vectorizeResult.queriedOk
        ? undefined
        : vectorizeMetricNote(vectorizeResult.errors.find((e) => e.startsWith('vectorize-queried:'))),
    ),
    vectorize_stored_dims: buildMetric(
      'vectorize_stored_dims',
      vectorizeResult.vectorizeStored,
      limits.vectorize_stored_dims,
      vectorizeResult.storedOk,
      vectorizeResult.storedOk
        ? undefined
        : vectorizeMetricNote(vectorizeResult.errors.find((e) => e.startsWith('vectorize-stored:'))),
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
  };

  const resourceBreakdown: ResourceBreakdown = {};
  if (workersMetricsResult.ok && workerScriptsResult.ok && workerScriptsResult.scripts.length > 0) {
    resourceBreakdown.workers = buildWorkersBreakdown(
      workerScriptsResult.scripts,
      workersMetricsResult.byScript,
    );
  }

  if (pagesProjectsResult.ok && pagesMetricsResult.ok && pagesProjectsResult.projects.length > 0) {
    resourceBreakdown.pages = buildPagesBreakdown(
      pagesProjectsResult.projects,
      pagesMetricsResult.byProject,
    );
  }
  if (d1DatabasesResult.ok && d1Result.ok && d1DatabasesResult.databases.length > 0) {
    resourceBreakdown.d1 = buildD1Breakdown(d1DatabasesResult.databases, d1Result.byDatabase);
  }
  if (kvNamespacesResult.ok && kvResult.ok && kvNamespacesResult.namespaces.length > 0) {
    resourceBreakdown.kv = buildKvBreakdown(kvNamespacesResult.namespaces, kvResult.byNamespace);
  }
  if (r2BucketsResult.ok && r2Result.ok && r2BucketsResult.buckets.length > 0) {
    resourceBreakdown.r2 = buildR2Breakdown(r2BucketsResult.buckets, r2Result.byBucket);
  }

  return {
    quotas,
    partialErrors,
    serviceStatus: { r2: r2BucketsResult.activation },
    resourceBreakdown,
  };
}

export async function fetchAccountQuotas(
  token: string,
  accountId: string,
  accountName: string,
  limitsJson?: string,
): Promise<AccountSnapshot> {
  const limits = resolveFreeTierLimits(limitsJson);
  try {
    const { quotas, partialErrors, serviceStatus, resourceBreakdown } = await fetchAllMetrics(token, accountId, limits);
    const hasAvailable = Object.values(quotas).some((q) => q.available);
    return {
      accountId,
      accountName,
      status: hasAvailable ? 'ok' : 'error',
      error: partialErrors.length ? partialErrors.join('; ') : undefined,
      quotas,
      resourceBreakdown,
      serviceStatus,
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

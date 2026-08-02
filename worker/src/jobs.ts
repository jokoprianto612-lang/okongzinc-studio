/**
 * Job state in KV.
 *
 * The Express server keeps jobs in a Map and artifacts on disk. Neither exists in
 * a Worker: instances are ephemeral and this account has R2 disabled, so job
 * records go to KV and artifacts are referenced by the provider's own CDN URL.
 *
 * Records carry fal's `status_url`/`response_url` alongside the public job view,
 * because the Worker advances a job one step per client poll rather than looping
 * in-request. The ticket is stripped before the job is returned to a client — it
 * is an internal handle, and it embeds nothing the browser needs.
 */

import type { FalTicket } from './falClient.js';
import type { Env, Job } from './types.js';

/** What actually gets written to KV: the public job plus the fal handle. */
interface StoredJob extends Job {
  ticket?: FalTicket;
}

const KEY_PREFIX = 'job:';
/** Newest-first index of job ids, so /api/jobs can list history. */
const INDEX_KEY = 'jobs:index';
const INDEX_LIMIT = 200;

function ttl(env: Env): number {
  const n = Number.parseInt(env.JOB_TTL_SECONDS ?? '604800', 10);
  // KV rejects a TTL under 60s.
  return Number.isFinite(n) && n >= 60 ? n : 604800;
}

export async function putJob(job: StoredJob, env: Env): Promise<void> {
  await env.STUDIO_JOBS.put(KEY_PREFIX + job.id, JSON.stringify(job), {
    expirationTtl: ttl(env),
  });
}

export async function getStoredJob(id: string, env: Env): Promise<StoredJob | null> {
  const raw = await env.STUDIO_JOBS.get(KEY_PREFIX + id);
  return raw ? (JSON.parse(raw) as StoredJob) : null;
}

/** Strip the internal fal handle before a job crosses the wire. */
export function toJobView(job: StoredJob): Job {
  const { ticket: _ticket, ...view } = job;
  return view;
}

/**
 * Prepend a job id to the history index.
 *
 * KV has no list-by-time, and `list()` sorts lexicographically by key, which
 * would order jobs by random UUID. An explicit index is the only way to get
 * newest-first history.
 */
export async function indexJob(id: string, env: Env): Promise<void> {
  const raw = await env.STUDIO_JOBS.get(INDEX_KEY);
  const ids = raw ? (JSON.parse(raw) as string[]) : [];
  const next = [id, ...ids.filter((x) => x !== id)].slice(0, INDEX_LIMIT);
  await env.STUDIO_JOBS.put(INDEX_KEY, JSON.stringify(next));
}

/**
 * Recent jobs, newest first.
 *
 * Reads are issued in parallel; a missing record (expired by TTL) is skipped
 * rather than treated as an error, because the index outlives individual jobs.
 */
export async function listJobs(limit: number, env: Env): Promise<Job[]> {
  const raw = await env.STUDIO_JOBS.get(INDEX_KEY);
  const ids = raw ? (JSON.parse(raw) as string[]) : [];
  const slice = ids.slice(0, limit);
  const found = await Promise.all(slice.map((id) => getStoredJob(id, env)));
  return found.filter((j): j is StoredJob => j !== null).map(toJobView);
}

export type { StoredJob };

/**
 * In-memory job queue.
 *
 * Generation is slow (seconds to minutes) and providers rate-limit, so requests
 * are queued rather than run inline. Jobs live in memory only — restarting the
 * server clears history while the produced files stay on disk. That tradeoff is
 * deliberate for a single-user studio; swap this module for a SQLite-backed
 * store if history needs to survive restarts.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getProvider, ProviderError } from './providers/index.js';
import type { GenerateRequest, Job, JobStatus } from './types.js';

const MAX_HISTORY = 200;

/** Insertion-ordered: newest last. */
const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let running = 0;

function trimHistory(): void {
  while (jobs.size > MAX_HISTORY) {
    const oldest = jobs.keys().next();
    if (oldest.done) break;
    // Never evict a job that is still active.
    const job = jobs.get(oldest.value);
    if (job && (job.status === 'running' || job.status === 'queued')) break;
    jobs.delete(oldest.value);
  }
}

export function createJob(req: GenerateRequest): Job {
  const job: Job = {
    id: randomUUID(),
    status: 'queued',
    modality: req.modality,
    provider: req.provider,
    request: req,
    artifacts: [],
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  waiting.push(job.id);
  trimHistory();
  pump();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Newest first — what the gallery renders. */
export function listJobs(limit = 50): Job[] {
  return [...jobs.values()].reverse().slice(0, limit);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;

  if (job.status === 'queued') {
    const idx = waiting.indexOf(id);
    if (idx >= 0) waiting.splice(idx, 1);
    setStatus(job, 'cancelled');
    return true;
  }
  if (job.status === 'running') {
    controllers.get(id)?.abort();
    return true;
  }
  return false;
}

function setStatus(job: Job, status: JobStatus, error?: string): void {
  job.status = status;
  if (status === 'running') job.startedAt = new Date().toISOString();
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    job.finishedAt = new Date().toISOString();
  }
  if (error) job.error = error;
}

/** Starts queued jobs up to the concurrency limit. */
function pump(): void {
  while (running < config.maxConcurrentJobs && waiting.length > 0) {
    const id = waiting.shift();
    if (!id) break;
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    void run(job);
  }
}

async function run(job: Job): Promise<void> {
  const provider = getProvider(job.provider);
  if (!provider) {
    setStatus(job, 'failed', `unknown provider '${job.provider}'`);
    return;
  }

  const { available, reason } = provider.availability();
  if (!available) {
    setStatus(job, 'failed', reason ?? `provider '${job.provider}' is unavailable`);
    return;
  }

  running += 1;
  const controller = new AbortController();
  controllers.set(job.id, controller);
  setStatus(job, 'running');
  job.progressNote = 'starting';

  try {
    const artifacts = await provider.generate(job.request, {
      signal: controller.signal,
      onProgress: (note) => {
        job.progressNote = note;
      },
    });

    if (controller.signal.aborted) {
      setStatus(job, 'cancelled', 'cancelled by user');
    } else if (artifacts.length === 0) {
      setStatus(job, 'failed', 'provider returned no artifacts');
    } else {
      job.artifacts = artifacts;
      job.progressNote = undefined;
      setStatus(job, 'succeeded');
    }
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    setStatus(job, controller.signal.aborted ? 'cancelled' : 'failed', message);
  } finally {
    controllers.delete(job.id);
    running -= 1;
    pump();
  }
}

export function queueStats(): { running: number; queued: number; total: number } {
  return { running, queued: waiting.length, total: jobs.size };
}

/** Abort everything — called on SIGINT/SIGTERM so shutdown is not blocked. */
export function abortAll(): void {
  for (const controller of controllers.values()) controller.abort();
  waiting.length = 0;
}

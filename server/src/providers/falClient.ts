/**
 * Shared fal.ai transport.
 *
 * Extracted so every fal provider (LongCat video, Seedance, LongCat image,
 * TRELLIS-2, Ideogram character) uses one queue implementation, one error
 * translator, and one upload path instead of five copies.
 *
 * Everything goes through the QUEUE API (`queue.fal.run`), never the synchronous
 * endpoint: video generation runs for minutes and a sync call would time out
 * somewhere in the chain, losing work that was already billed.
 */

import { config } from '../config.js';
import { readSourceImage } from '../storage.js';
import { fetchWithTimeout, ProviderError, type GenerationContext } from './types.js';

const QUEUE_BASE = 'https://queue.fal.run';
const UPLOAD_INITIATE_URL = 'https://rest.alpha.fal.ai/storage/upload/initiate';

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

/** A file entry in a fal response. */
export interface FalFile {
  url?: string;
  content_type?: string;
  file_size?: number;
  file_name?: string;
}

export function falKey(): string {
  if (!config.fal.apiKey) {
    throw new ProviderError('FAL_KEY is not set', 503);
  }
  return config.fal.apiKey;
}

export function falAvailability(): { available: boolean; reason?: string } {
  return config.fal.apiKey
    ? { available: true }
    : { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
}

export function falHeaders(): Record<string, string> {
  return {
    Authorization: `Key ${falKey()}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Translate fal's error envelope into something a human can act on.
 *
 * fal returns `{detail: string}` for plain errors and `{detail: [{loc, msg}]}`
 * for validation failures — the latter is what a wrong field name produces, so
 * surfacing `loc` is what makes a schema mistake diagnosable.
 */
export async function falError(res: Response, label: string): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === 'string') {
      detail = d;
    } else if (Array.isArray(d)) {
      detail = d
        .map((item) => {
          const it = item as { msg?: string; loc?: unknown[] };
          const where = Array.isArray(it.loc) ? it.loc.join('.') : '';
          return where ? `${where}: ${it.msg}` : String(it.msg);
        })
        .join('; ');
    }
  } catch {
    // keep raw text
  }

  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`${label}: fal rejected the key (HTTP ${res.status})`, 401);
  }
  if (res.status === 402) {
    return new ProviderError(`${label}: fal account is out of credit (HTTP 402)`, 402);
  }
  if (res.status === 422) {
    return new ProviderError(`${label}: fal rejected the input — ${detail}`, 400);
  }
  return new ProviderError(`${label}: HTTP ${res.status} — ${detail}`, 502);
}

/**
 * Ensure an image is reachable by a public URL, uploading it if it is local.
 *
 * Every fal image input is `image_url` — there is no bytes upload on the
 * generation endpoints — so a `/media/...` artifact has to be pushed to fal
 * storage first. Remote URLs pass straight through.
 */
export async function falUploadImage(
  source: string,
  ctx: GenerationContext,
): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return source;
  }

  ctx.onProgress('uploading image to fal storage');
  const { data, mimeType } = await readSourceImage(source);

  const initRes = await fetchWithTimeout(
    UPLOAD_INITIATE_URL,
    {
      method: 'POST',
      headers: falHeaders(),
      body: JSON.stringify({ content_type: mimeType, file_name: 'source' }),
      timeoutMs: 60_000,
    },
    ctx.signal,
  );
  if (!initRes.ok) throw await falError(initRes, 'fal upload initiate');

  const init = (await initRes.json()) as { upload_url?: string; file_url?: string };
  if (!init.upload_url || !init.file_url) {
    throw new ProviderError('fal upload initiate returned no upload_url/file_url', 502);
  }

  const putRes = await fetchWithTimeout(
    init.upload_url,
    {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: data,
      timeoutMs: 180_000,
    },
    ctx.signal,
  );
  if (!putRes.ok) {
    throw new ProviderError(`fal upload PUT failed (HTTP ${putRes.status})`, 502);
  }

  return init.file_url;
}

/**
 * Submit to the queue, poll until completion, return the parsed result payload.
 *
 * Queue position is reported through `ctx.onProgress` so the UI can say
 * "in queue (position 3)" instead of spinning with no explanation.
 */
export async function runFalQueued(
  endpointId: string,
  input: Record<string, unknown>,
  ctx: GenerationContext,
): Promise<Record<string, unknown>> {
  const submitRes = await fetchWithTimeout(
    `${QUEUE_BASE}/${endpointId}`,
    {
      method: 'POST',
      headers: falHeaders(),
      body: JSON.stringify(input),
      timeoutMs: 120_000,
    },
    ctx.signal,
  );
  if (!submitRes.ok) throw await falError(submitRes, `fal submit ${endpointId}`);

  const queued = (await submitRes.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  if (!queued.status_url || !queued.response_url) {
    throw new ProviderError('fal queue response had no status_url/response_url', 502);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStatus = 'IN_QUEUE';

  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new ProviderError('job cancelled', 499);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetchWithTimeout(
      queued.status_url,
      { method: 'GET', headers: falHeaders(), timeoutMs: 60_000 },
      ctx.signal,
    );
    if (!statusRes.ok) throw await falError(statusRes, 'fal status');

    const status = (await statusRes.json()) as {
      status?: string;
      queue_position?: number;
      error?: unknown;
    };
    if (status.status) lastStatus = status.status;

    const elapsed = Math.round((MAX_WAIT_MS - (deadline - Date.now())) / 1000);
    const position =
      typeof status.queue_position === 'number' && status.queue_position > 0
        ? ` (queue position ${status.queue_position})`
        : '';
    ctx.onProgress(
      `${lastStatus.toLowerCase().replace('_', ' ')}${position} — ${elapsed}s elapsed`,
    );

    if (status.status === 'COMPLETED') {
      const resultRes = await fetchWithTimeout(
        queued.response_url,
        { method: 'GET', headers: falHeaders(), timeoutMs: 120_000 },
        ctx.signal,
      );
      if (!resultRes.ok) throw await falError(resultRes, 'fal result');
      return (await resultRes.json()) as Record<string, unknown>;
    }

    if (status.error) {
      throw new ProviderError(
        `fal job failed: ${JSON.stringify(status.error).slice(0, 240)}`,
        502,
      );
    }
  }

  throw new ProviderError('fal job did not complete within 15 minutes', 504);
}

/** Download a produced file so it can be persisted as an artifact. */
export async function downloadFalFile(
  file: FalFile,
  ctx: GenerationContext,
  fallbackMime: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (!file.url) throw new ProviderError('fal result file had no url', 502);

  ctx.onProgress('downloading result from fal');
  const res = await fetchWithTimeout(
    file.url,
    { method: 'GET', timeoutMs: 600_000 },
    ctx.signal,
  );
  if (!res.ok) {
    throw new ProviderError(`failed to download fal output (HTTP ${res.status})`, 502);
  }

  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType =
    file.content_type || res.headers.get('content-type')?.split(';')[0] || fallbackMime;

  ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return { data, mimeType };
}

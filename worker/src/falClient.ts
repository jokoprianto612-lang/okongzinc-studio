/**
 * fal.ai transport for the Worker.
 *
 * Same queue protocol as `server/src/providers/falClient.ts`, with one structural
 * difference forced by the runtime: a Worker request cannot block for the two to
 * eight minutes a video render takes. Instead of polling inside the request, the
 * Worker submits the job, stores fal's `status_url`/`response_url` in KV, and the
 * client's existing `GET /api/jobs/:id` poll advances the state machine one step
 * per call.
 *
 * That is why there is no `runFalQueued()` here. Splitting submit from poll is
 * not a style choice — a 15-minute in-request loop would hit the Worker CPU and
 * duration limits and lose work that fal had already billed for.
 */

import type { Env } from './types.js';
import { ProviderError } from './types.js';

const QUEUE_BASE = 'https://queue.fal.run';
const UPLOAD_INITIATE_URL = 'https://rest.alpha.fal.ai/storage/upload/initiate';

export interface FalFile {
  url?: string;
  content_type?: string;
  file_size?: number;
  file_name?: string;
}

/** What a submitted fal job needs for later polling. */
export interface FalTicket {
  requestId?: string;
  statusUrl: string;
  responseUrl: string;
}

export function falKey(env: Env): string {
  if (!env.FAL_KEY) throw new ProviderError('FAL_KEY secret is not set on this Worker', 503);
  return env.FAL_KEY;
}

export function falHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Key ${falKey(env)}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Translate fal's error envelope into something actionable.
 *
 * `detail` is a string for plain errors and an array of `{loc, msg}` for schema
 * validation failures — surfacing `loc` is what makes a wrong field name
 * diagnosable instead of mysterious.
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
    // keep the raw text
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
 * Ensure an image is reachable by a public URL.
 *
 * Every fal image input is `image_url` — there is no bytes upload on the
 * generation endpoints. On the Express server a local `/media/...` artifact gets
 * uploaded to fal storage first. Here there are no local artifacts at all (no
 * R2), so a source image is either already an https URL, or it is a data URL the
 * browser just produced, which gets pushed to fal storage.
 */
export async function falResolveImage(source: string, env: Env): Promise<string> {
  if (source.startsWith('https://') || source.startsWith('http://')) return source;

  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(source);
  if (!match) {
    throw new ProviderError(
      'sourceImage must be an https URL or a data: URL. This deployment has no ' +
        'local media store (R2 is disabled on the account), so there are no ' +
        '/media/... paths to reference.',
      400,
    );
  }
  const mimeType = match[1] ?? 'image/png';
  const base64 = match[2] ?? '';

  const initRes = await fetch(UPLOAD_INITIATE_URL, {
    method: 'POST',
    headers: falHeaders(env),
    body: JSON.stringify({ content_type: mimeType, file_name: 'source' }),
  });
  if (!initRes.ok) throw await falError(initRes, 'fal upload initiate');

  const init = (await initRes.json()) as { upload_url?: string; file_url?: string };
  if (!init.upload_url || !init.file_url) {
    throw new ProviderError('fal upload initiate returned no upload_url/file_url', 502);
  }

  const bytes = base64ToBytes(base64);
  const putRes = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new ProviderError(`fal upload PUT failed (HTTP ${putRes.status})`, 502);
  }

  return init.file_url;
}

/** atob is available in Workers; this turns its output into real bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Submit to fal's queue and return the ticket to poll later.
 *
 * Always the queue API (`queue.fal.run`), never the synchronous endpoint: a sync
 * call for a video render would exceed the Worker's limits and lose billed work.
 */
export async function falSubmit(
  endpointId: string,
  input: Record<string, unknown>,
  env: Env,
): Promise<FalTicket> {
  const res = await fetch(`${QUEUE_BASE}/${endpointId}`, {
    method: 'POST',
    headers: falHeaders(env),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await falError(res, `fal submit ${endpointId}`);

  const queued = (await res.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  if (!queued.status_url || !queued.response_url) {
    throw new ProviderError('fal queue response had no status_url/response_url', 502);
  }
  return {
    requestId: queued.request_id,
    statusUrl: queued.status_url,
    responseUrl: queued.response_url,
  };
}

export interface FalStatus {
  status: string;
  queuePosition?: number;
}

/** One poll of a submitted job. Cheap enough to run inside a client GET. */
export async function falStatus(ticket: FalTicket, env: Env): Promise<FalStatus> {
  const res = await fetch(ticket.statusUrl, { method: 'GET', headers: falHeaders(env) });
  if (!res.ok) throw await falError(res, 'fal status');
  const body = (await res.json()) as {
    status?: string;
    queue_position?: number;
    error?: unknown;
  };
  if (body.error) {
    throw new ProviderError(`fal job failed: ${JSON.stringify(body.error).slice(0, 240)}`, 502);
  }
  return {
    status: body.status ?? 'IN_QUEUE',
    queuePosition: typeof body.queue_position === 'number' ? body.queue_position : undefined,
  };
}

/** Fetch the finished result payload. */
export async function falResult(
  ticket: FalTicket,
  env: Env,
): Promise<Record<string, unknown>> {
  const res = await fetch(ticket.responseUrl, { method: 'GET', headers: falHeaders(env) });
  if (!res.ok) throw await falError(res, 'fal result');
  return (await res.json()) as Record<string, unknown>;
}

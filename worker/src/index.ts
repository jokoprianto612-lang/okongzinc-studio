/**
 * OkongzINC Studio — Cloudflare Worker.
 *
 * Serves the built SPA and the generation API from one origin, so the client's
 * existing relative `fetch('/api/...')` works unchanged.
 *
 * Routes (same shapes the Express server serves, so `web/` needs no changes):
 *   GET  /api/health
 *   GET  /api/providers        capability descriptors + per-modality defaults
 *   GET  /api/shots            cinematography vocabulary
 *   GET  /api/guidance         per-model prompting tips
 *   POST /api/upload           data URL → a hosted image URL (fal storage)
 *   POST /api/reach            reference URL → clean markdown
 *   POST /api/generate         submit to fal, store the ticket, return the job
 *   GET  /api/jobs             recent jobs, newest first
 *   GET  /api/jobs/:id         POLL THIS — it also advances the job's state
 *   POST /api/jobs/:id/cancel  mark a job cancelled locally
 *
 * The one architectural difference from the Express server: there is no
 * in-process queue, and `GET /api/jobs/:id` is what drives a job forward. A
 * Worker cannot hold a request open for the minutes a video render takes, so the
 * poll the client was already doing every 2s becomes the state machine's clock.
 *
 * The vocabulary and guidance modules are imported straight from `server/src`
 * because they are pure data with no imports of their own. Duplicating 900 lines
 * of shot vocabulary into this package would guarantee the two copies drift.
 */

import { SHOT_OPTION_COUNT, SHOT_VOCABULARY, composePrompt } from '../../server/src/shotVocabulary.js';
import { PROMPT_GUIDANCE } from '../../server/src/promptGuidance.js';
import { falResult, falStatus, falSubmit, falUploadDataUrl } from './falClient.js';
import { getStoredJob, indexJob, listJobs, putJob, toJobView, type StoredJob } from './jobs.js';
import { reachUrl } from './reach.js';
import {
  ALL_PROVIDERS,
  assertWithinBudget,
  availabilityOf,
  defaultProviderFor,
  describe,
  getProvider,
  premiumEnabled,
} from './providers.js';
import type { Env, GenerateRequest, Modality } from './types.js';
import { ProviderError } from './types.js';

const MODALITIES: Modality[] = ['image', 'video', 'model3d'];

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Gate every mutating/spending route behind the API_KEY secret.
 *
 * On localhost the Express server treats API_KEY as optional and prints a
 * warning. That is not acceptable here: a Worker is on the public internet from
 * the moment it deploys, so an unset key would mean any stranger who finds the
 * URL can spend the fal balance. Generation is refused outright with an
 * explanation rather than served openly.
 *
 * Read-only metadata routes (health, providers, shots, guidance) stay public —
 * they cost nothing and the SPA needs them to render.
 */
function requireAuth(req: Request, env: Env): Response | null {
  if (!env.API_KEY) {
    return error(
      'This deployment has no API_KEY secret set, so generation is disabled to ' +
        'stop strangers spending the fal balance. Run: wrangler secret put API_KEY',
      503,
    );
  }
  const provided = req.headers.get('x-api-key');
  if (!provided || provided !== env.API_KEY) {
    return error('invalid or missing X-Api-Key header', 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
//
// Hand-written rather than zod: pulling a validation library into a Worker for
// nine fields is not worth the bundle, and the rules are the same ones
// server/src/validation.ts enforces.
// ---------------------------------------------------------------------------

const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const RESOLUTIONS = new Set(['480p', '720p', '1080p', '2K', '4K']);

function validate(raw: unknown): GenerateRequest {
  if (typeof raw !== 'object' || raw === null) throw new ProviderError('body must be JSON', 400);
  const b = raw as Record<string, unknown>;

  const modality = b.modality;
  if (typeof modality !== 'string' || !MODALITIES.includes(modality as Modality)) {
    throw new ProviderError('modality must be image, video, or model3d', 400);
  }
  const provider = b.provider;
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new ProviderError('provider is required', 400);
  }
  const prompt = b.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ProviderError('prompt is required', 400);
  }
  if (prompt.length > 4000) throw new ProviderError('prompt is too long (max 4000)', 400);

  const out: GenerateRequest = {
    modality: modality as Modality,
    provider: provider.trim(),
    prompt: prompt.trim(),
  };

  if (typeof b.negativePrompt === 'string' && b.negativePrompt.trim()) {
    out.negativePrompt = b.negativePrompt.trim().slice(0, 2000);
  }
  if (typeof b.aspectRatio === 'string' && ASPECTS.has(b.aspectRatio)) {
    out.aspectRatio = b.aspectRatio as GenerateRequest['aspectRatio'];
  }
  if (typeof b.resolution === 'string' && RESOLUTIONS.has(b.resolution)) {
    out.resolution = b.resolution as GenerateRequest['resolution'];
  }
  if (typeof b.seed === 'number' && Number.isInteger(b.seed) && b.seed >= 0) {
    out.seed = b.seed;
  }
  if (typeof b.model === 'string' && b.model.trim()) out.model = b.model.trim().slice(0, 128);
  if (typeof b.generateAudio === 'boolean') out.generateAudio = b.generateAudio;
  if (
    typeof b.durationSeconds === 'number' &&
    Number.isInteger(b.durationSeconds) &&
    b.durationSeconds > 0 &&
    b.durationSeconds <= 60
  ) {
    out.durationSeconds = b.durationSeconds;
  }

  // A source image must be an https URL or a data: URL. No `/media/...` paths
  // here — this deployment has no local media store to resolve them against.
  if (typeof b.sourceImage === 'string' && b.sourceImage.trim()) {
    const src = b.sourceImage.trim();
    const ok = /^https?:\/\//i.test(src) || /^data:image\//i.test(src);
    if (!ok) {
      throw new ProviderError(
        'sourceImage must be an https URL or a data:image/... URL',
        400,
      );
    }
    out.sourceImage = src;
  }

  if (Array.isArray(b.shotOptionIds)) {
    out.shotOptionIds = b.shotOptionIds
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 24);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Job progression
// ---------------------------------------------------------------------------

/**
 * Advance a running job by one fal poll.
 *
 * Called from `GET /api/jobs/:id`, which the client already polls every 2s. On
 * COMPLETED it fetches the result and records the provider's CDN URL as the
 * artifact — there is no byte copy, because there is no R2 bucket to copy into.
 */
async function advance(job: StoredJob, env: Env): Promise<StoredJob> {
  if (job.status !== 'queued' && job.status !== 'running') return job;
  if (!job.ticket) {
    job.status = 'failed';
    job.error = 'job has no fal ticket — it was never submitted';
    job.finishedAt = new Date().toISOString();
    await putJob(job, env);
    return job;
  }

  const provider = getProvider(job.provider);
  if (!provider) {
    job.status = 'failed';
    job.error = `provider '${job.provider}' is no longer registered`;
    job.finishedAt = new Date().toISOString();
    await putJob(job, env);
    return job;
  }

  try {
    const status = await falStatus(job.ticket, env);

    if (status.status === 'COMPLETED') {
      const result = await falResult(job.ticket, env);
      job.artifacts = [provider.extract(result)];
      job.status = 'succeeded';
      job.progressNote = 'completed';
      job.finishedAt = new Date().toISOString();
    } else {
      job.status = 'running';
      const elapsed = Math.round((Date.now() - Date.parse(job.createdAt)) / 1000);
      const position =
        status.queuePosition && status.queuePosition > 0
          ? ` (queue position ${status.queuePosition})`
          : '';
      job.progressNote = `${status.status.toLowerCase().replace('_', ' ')}${position} — ${elapsed}s elapsed`;
    }
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : 'fal poll failed';
    job.finishedAt = new Date().toISOString();
  }

  await putJob(job, env);
  return job;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  // --- health (public) ---
  if (path === '/api/health' && req.method === 'GET') {
    return json({
      ok: true,
      version: '0.1.0-worker',
      runtime: 'cloudflare-workers',
      authenticated: Boolean(env.API_KEY),
      premiumEnabled: premiumEnabled(env),
      falConfigured: Boolean(env.FAL_KEY),
      // No in-process queue on Workers: jobs advance on client poll.
      queue: { running: 0, queued: 0, total: 0 },
      /**
       * The client renders the Reach panel only when this says enabled, so it has
       * to be reported. `backend` is always jina-reader here — a Worker has no
       * child processes, so the agent-reach CLI cannot exist. Claiming otherwise
       * would advertise platform coverage this runtime does not have.
       */
      reach: { enabled: true, backend: 'jina-reader' },
      /**
       * Honest about what this deployment cannot do. R2 is disabled on the
       * account, so artifacts are referenced on the provider's CDN rather than
       * stored here, and they last only as long as fal keeps them.
       */
      storage: 'provider-cdn (R2 not enabled on this account)',
    });
  }

  // --- providers (public) ---
  if (path === '/api/providers' && req.method === 'GET') {
    const raw = url.searchParams.get('modality');
    const modality = raw && MODALITIES.includes(raw as Modality) ? (raw as Modality) : undefined;
    const list = modality ? ALL_PROVIDERS.filter((p) => p.modality === modality) : ALL_PROVIDERS;
    return json({
      providers: list.map((p) => describe(p, env)),
      defaults: {
        image: defaultProviderFor('image', env),
        video: defaultProviderFor('video', env),
        model3d: defaultProviderFor('model3d', env),
      },
    });
  }

  // --- static authoring data (public, cacheable) ---
  if (path === '/api/shots' && req.method === 'GET') {
    return json(
      {
        categories: SHOT_VOCABULARY,
        optionCount: SHOT_OPTION_COUNT,
        source: 'https://github.com/ilkerzg/awesome-video-prompts',
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' },
    );
  }

  if (path === '/api/guidance' && req.method === 'GET') {
    return json({ guidance: PROMPT_GUIDANCE }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  // --- everything below spends money or reads private history ---

  /**
   * Upload: data URL in, hosted image URL out.
   *
   * The Express server writes bytes to disk and returns `/media/...`. There is no
   * disk here, so the file goes straight to fal storage — which is where every
   * fal endpoint needs it anyway. The returned `url` is an absolute https URL, so
   * the client's existing "paste into Source image" flow works unchanged.
   *
   * Behind auth because it consumes fal storage quota.
   */
  if (path === '/api/upload' && req.method === 'POST') {
    const denied = requireAuth(req, env);
    if (denied) return denied;

    const body = (await req.json().catch(() => null)) as {
      dataUrl?: unknown;
      filename?: unknown;
    } | null;
    if (!body || typeof body.dataUrl !== 'string' || body.dataUrl.length < 16) {
      return error('invalid upload payload: expected { dataUrl }', 400);
    }
    // Workers cap request bodies well below this, but reject early with a clear
    // message rather than letting the platform truncate mysteriously.
    if (body.dataUrl.length > 30_000_000) {
      return error('upload is too large', 413);
    }

    const filename = typeof body.filename === 'string' ? body.filename.slice(0, 200) : 'source';
    const uploaded = await falUploadDataUrl(body.dataUrl, env, filename);
    return json(uploaded, 201);
  }

  /**
   * Reach: fetch a reference URL as markdown to ground a prompt.
   *
   * The response is untrusted page content shown to a human for editing. It is
   * never executed and never auto-injected into a prompt. `assertPublicHttpUrl`
   * inside reach.ts blocks private, loopback, and link-local hosts.
   */
  if (path === '/api/reach' && req.method === 'POST') {
    const denied = requireAuth(req, env);
    if (denied) return denied;

    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    if (!body || typeof body.url !== 'string' || body.url.trim().length < 8) {
      return error('invalid request: expected { url }', 400);
    }
    const result = await reachUrl(body.url.trim(), env);
    return json({ result });
  }

  if (path === '/api/generate' && req.method === 'POST') {
    const denied = requireAuth(req, env);
    if (denied) return denied;

    const body = await req.json().catch(() => null);
    const request = validate(body);

    const provider = getProvider(request.provider);
    if (!provider) return error(`unknown provider '${request.provider}'`, 400);
    if (provider.modality !== request.modality) {
      return error(
        `provider '${provider.id}' produces ${provider.modality}, not ${request.modality}`,
        400,
      );
    }
    const { available, reason } = availabilityOf(provider, env);
    if (!available) return error(reason ?? `provider '${provider.id}' is unavailable`, 503);
    if (provider.requiresSourceImage && !request.sourceImage) {
      return error(`provider '${provider.id}' requires a source image`, 400);
    }

    // Compose shot terms server-side so the stored job records exactly what was
    // sent — same reasoning as the Express handler.
    const composed = request.shotOptionIds?.length
      ? { ...request, prompt: composePrompt(request.prompt, request.shotOptionIds) }
      : request;

    // Budget check BEFORE submitting. After submission the money is gone.
    const quoted = provider.quote(composed);
    if (provider.tier === 'premium' && quoted > 0) {
      assertWithinBudget(quoted, provider.label, env);
    }

    const input = await provider.buildInput(composed, env);
    const endpoint = provider.endpointFor(composed);
    const ticket = await falSubmit(endpoint, input, env);

    const now = new Date().toISOString();
    const job: StoredJob = {
      id: crypto.randomUUID(),
      status: 'running',
      modality: composed.modality,
      provider: provider.id,
      request: composed,
      artifacts: [],
      progressNote:
        quoted > 0
          ? `submitted to ${endpoint} — vendor-quoted cost ≈ $${quoted.toFixed(3)}`
          : `submitted to ${endpoint}`,
      createdAt: now,
      startedAt: now,
      ticket,
    };

    await putJob(job, env);
    await indexJob(job.id, env);
    return json({ job: toJobView(job) }, 202);
  }

  if (path === '/api/jobs' && req.method === 'GET') {
    const denied = requireAuth(req, env);
    if (denied) return denied;
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
    return json({ jobs: await listJobs(limit, env) });
  }

  const jobMatch = /^\/api\/jobs\/([\w-]+)$/.exec(path);
  if (jobMatch && req.method === 'GET') {
    const denied = requireAuth(req, env);
    if (denied) return denied;
    const id = jobMatch[1] as string;
    const stored = await getStoredJob(id, env);
    if (!stored) return error('job not found', 404);
    // This poll IS the state machine's clock.
    const advanced = await advance(stored, env);
    return json({ job: toJobView(advanced) });
  }

  const cancelMatch = /^\/api\/jobs\/([\w-]+)\/cancel$/.exec(path);
  if (cancelMatch && req.method === 'POST') {
    const denied = requireAuth(req, env);
    if (denied) return denied;
    const id = cancelMatch[1] as string;
    const stored = await getStoredJob(id, env);
    if (!stored) return error('job not found', 404);
    if (stored.status !== 'queued' && stored.status !== 'running') {
      return error(`job is already ${stored.status}`, 409);
    }
    /**
     * Cancels locally only. fal's queue API has no cancel on the submitted
     * request, so the render continues and will still be billed — the job is
     * simply no longer tracked. Saying otherwise would be a lie in the UI.
     */
    stored.status = 'cancelled';
    stored.error = 'cancelled locally — fal continues the render and still bills it';
    stored.finishedAt = new Date().toISOString();
    await putJob(stored, env);
    return json({ job: toJobView(stored) });
  }

  return error(`no route for ${req.method} ${path}`, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (!url.pathname.startsWith('/api/')) {
      // run_worker_first in wrangler.toml only routes /api/* here; anything else
      // means the assets binding did not claim it.
      return error('not found', 404);
    }

    try {
      return await handleApi(req, env, url);
    } catch (err) {
      if (err instanceof ProviderError) return error(err.message, err.statusCode);
      console.error('[worker] unhandled', err);
      return error(err instanceof Error ? err.message : 'internal error', 500);
    }
  },
};

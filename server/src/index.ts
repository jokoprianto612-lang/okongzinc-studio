/**
 * HTTP API + static hosting.
 *
 * Routes
 *   GET  /api/health              — liveness + queue stats
 *   GET  /api/providers           — capability descriptors (optionally ?modality=)
 *   POST /api/generate            — enqueue a job, returns the job view
 *   GET  /api/jobs                — recent jobs, newest first
 *   GET  /api/jobs/:id            — one job (poll this for progress)
 *   POST /api/jobs/:id/cancel     — abort a queued/running job
 *   POST /api/upload              — store a data URL, returns a /media path
 *   GET  /media/*                 — generated files (read-only)
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, warnIfInsecure } from './config.js';
import { listProviders, defaultProviderFor, getProvider, ProviderError } from './providers/index.js';
import { createJob, getJob, listJobs, cancelJob, queueStats, abortAll } from './jobQueue.js';
import { generateRequestSchema, reachSchema, uploadSchema } from './validation.js';
import { saveArtifact } from './storage.js';
import { isAgentReachAvailable, reachUrl } from './reach.js';
import { SHOT_OPTION_COUNT, SHOT_VOCABULARY, composePrompt } from './shotVocabulary.js';
import { PROMPT_GUIDANCE } from './promptGuidance.js';
import { toJobView, type GenerateRequest, type Modality } from './types.js';

const app = express();

app.use(express.json({ limit: '32mb' }));

/**
 * CORS.
 *
 * Uses the request-aware delegate form so a SAME-ORIGIN request is always
 * allowed. This matters because Vite emits `<script type="module" crossorigin>`
 * — that makes the app's own bundle a CORS request whose Origin is the server
 * itself. An allowlist that only contains the dev-server origin would reject
 * the production bundle and the SPA would silently render a blank page.
 */
app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;

    // No Origin header: same-origin navigation, curl, or a server-side call.
    if (!origin) return callback(null, { origin: true });

    if (config.corsOrigins.includes(origin)) return callback(null, { origin: true });

    // Same host as the request itself (the app serving its own assets).
    const host = req.headers.host;
    if (host) {
      try {
        if (new URL(origin).host === host) return callback(null, { origin: true });
      } catch {
        // malformed Origin — fall through to the rejection below
      }
    }

    callback(null, { origin: false });
  }),
);

/**
 * Optional shared-secret gate. When API_KEY is unset every request passes —
 * intended for localhost development only (see warnIfInsecure at boot).
 */
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!config.apiKey) return next();
  if (req.path === '/health') return next();
  const provided = req.header('x-api-key');
  if (provided && provided === config.apiKey) return next();
  res.status(401).json({ error: 'invalid or missing X-Api-Key header' });
});

// --- media (read-only) -----------------------------------------------------
app.use(
  '/media',
  express.static(config.storageDir, {
    index: false,
    dotfiles: 'deny',
    maxAge: '1y',
    immutable: true,
  }),
);

// --- API -------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    version: '0.1.0',
    queue: queueStats(),
    authenticated: Boolean(config.apiKey),
    reach: {
      enabled: config.reach.enabled,
      // Which backend a Reach call would use right now.
      backend: (await isAgentReachAvailable()) ? 'agent-reach' : 'jina-reader',
    },
  });
});

app.get('/api/providers', (req, res) => {
  const raw = typeof req.query.modality === 'string' ? req.query.modality : undefined;
  const valid: Modality[] = ['image', 'video', 'model3d', 'audio'];
  const modality = raw && valid.includes(raw as Modality) ? (raw as Modality) : undefined;

  res.json({
    providers: listProviders(modality),
    defaults: {
      image: defaultProviderFor('image'),
      video: defaultProviderFor('video'),
      model3d: defaultProviderFor('model3d'),
      audio: defaultProviderFor('audio'),
    },
  });
});

/**
 * Shot vocabulary — cinematography terms the UI offers as prompt building
 * blocks, each with a reference clip. Static data, so it is safe to cache.
 */
app.get('/api/shots', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    categories: SHOT_VOCABULARY,
    optionCount: SHOT_OPTION_COUNT,
    source: 'https://github.com/ilkerzg/awesome-video-prompts',
  });
});

/** Per-model prompting guidance, keyed by provider id. */
app.get('/api/guidance', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ guidance: PROMPT_GUIDANCE });
});

app.post('/api/generate', (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  const { shotOptionIds, ...rest } = parsed.data;
  // Shot options are composed server-side so the stored job records the exact
  // prompt that was sent — otherwise history would show the bare idea and the
  // rendered result would be unexplainable.
  //
  // `prompt` is normalised to a string here rather than staying optional: the
  // providers that ignore it get an empty string, and every other one is checked
  // below. That keeps `GenerateRequest.prompt` a plain string for all 30-odd
  // providers instead of forcing each to handle undefined.
  const request: GenerateRequest = {
    ...rest,
    prompt: shotOptionIds?.length
      ? composePrompt(rest.prompt ?? '', shotOptionIds)
      : (rest.prompt ?? ''),
  };

  const provider = getProvider(request.provider);
  if (!provider) {
    res.status(400).json({ error: `unknown provider '${request.provider}'` });
    return;
  }
  if (provider.modality !== request.modality) {
    res.status(400).json({
      error: `provider '${provider.id}' produces ${provider.modality}, not ${request.modality}`,
    });
    return;
  }
  const { available, reason } = provider.availability();
  if (!available) {
    res.status(503).json({ error: reason ?? `provider '${provider.id}' is unavailable` });
    return;
  }

  /**
   * Prompt is required unless the provider says otherwise.
   *
   * The zod schema cannot enforce this: whether a prompt is meaningful is a
   * property of the provider (an upscaler has nothing to prompt), and the schema
   * runs before the provider is resolved. Checking here keeps one rule in one
   * place instead of a per-provider throw.
   */
  if (!provider.ignoresPrompt && !request.prompt) {
    res.status(400).json({ error: `provider '${provider.id}' requires a prompt` });
    return;
  }
  if (provider.requiresSourceImage && !request.sourceImage) {
    res.status(400).json({ error: `provider '${provider.id}' requires a source image` });
    return;
  }
  /**
   * Audio and video sources are interchangeable for two providers: Scribe v2 and
   * Audio Isolation both accept either, because pulling the track out of a video
   * is the same job. Accepting either here rather than demanding the exact field
   * avoids rejecting a request the provider would have handled.
   */
  if (provider.requiresSourceAudio && !request.sourceAudio && !request.sourceVideo) {
    res.status(400).json({
      error: `provider '${provider.id}' requires a source audio or video file`,
    });
    return;
  }
  if (provider.requiresSourceVideo && !request.sourceVideo) {
    res.status(400).json({ error: `provider '${provider.id}' requires a source video` });
    return;
  }

  const job = createJob(request);
  res.status(202).json({ job: toJobView(job) });
});

app.get('/api/jobs', (req, res) => {
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  res.json({ jobs: listJobs(limit).map(toJobView) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json({ job: toJobView(job) });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const id = String(req.params.id);
  const job = getJob(id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  const cancelled = cancelJob(id);
  if (!cancelled) {
    res.status(409).json({ error: `job is already ${job.status}` });
    return;
  }
  res.json({ job: toJobView(job) });
});

/**
 * Reach: fetch a reference URL as clean markdown to ground a prompt.
 *
 * The response is untrusted page content shown to a human for editing. It is
 * never executed and never auto-injected into a prompt.
 */
app.post('/api/reach', async (req, res, next) => {
  try {
    const parsed = reachSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    // Abort the upstream fetch if the client disconnects mid-request.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const result = await reachUrl(parsed.data.url, controller.signal);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

/** Accepts a data URL so the UI can feed a local file into any provider. */
app.post('/api/upload', async (req, res, next) => {
  try {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid upload payload' });
      return;
    }

    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(parsed.data.dataUrl);
    const mimeType = match?.[1] ?? 'image/png';
    const base64 = match?.[2] ?? parsed.data.dataUrl;

    /**
     * Images, audio, and video — audio and video joined when the ElevenLabS,
     * Scribe, and upscaler providers landed, because those take a local file the
     * same way image→video always has. Anything else is still refused: the
     * artifact store is for media, not arbitrary uploads.
     */
    const isMedia =
      mimeType.startsWith('image/') ||
      mimeType.startsWith('audio/') ||
      mimeType.startsWith('video/');
    if (!isMedia) {
      res.status(400).json({ error: 'only image, audio, and video uploads are supported' });
      return;
    }

    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.byteLength === 0) {
      res.status(400).json({ error: 'decoded upload was empty' });
      return;
    }

    const artifact = await saveArtifact(bytes, mimeType);
    res.status(201).json({ url: artifact.url, mimeType: artifact.mimeType, bytes: artifact.bytes });
  } catch (err) {
    next(err);
  }
});

// --- static web build (production) ----------------------------------------
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: 'index.html' }));
  // SPA fallback for client-side routing; never shadows /api or /media.
  app.get(/^(?!\/api|\/media).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// --- errors ---------------------------------------------------------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof ProviderError ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : 'internal error';
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
});

const server = app.listen(config.port, () => {
  const available = listProviders().filter((p) => p.available);
  console.log(`\n  OkongzINC Studio API  →  http://localhost:${config.port}`);
  console.log(`  storage               →  ${config.storageDir}`);
  console.log(
    `  providers ready       →  ${
      available.length ? available.map((p) => p.id).join(', ') : 'none'
    }`,
  );
  const missing = listProviders().filter((p) => !p.available);
  for (const p of missing) console.log(`      · ${p.id} disabled: ${p.unavailableReason}`);
  warnIfInsecure((msg) => console.warn(`  ${msg}`));
  console.log('');
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received — shutting down`);
  abortAll();
  server.close(() => process.exit(0));
  // Do not hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

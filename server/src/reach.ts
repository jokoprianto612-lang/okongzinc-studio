/**
 * Reach — reference research for prompts.
 *
 * Turns a URL into clean markdown so a generation prompt can be grounded in a
 * real page (a product listing, a tweet, a paper, a tutorial) instead of the
 * model's recollection of one.
 *
 * Two backends, tried in order:
 *
 *   1. **agent-reach CLI** (github.com/Panniantong/Agent-Reach) — one command
 *      covering Twitter/X, Reddit, YouTube, Bilibili, XiaoHongShu, GitHub, and
 *      RSS, each behind a primary + fallback backend list. Used when the binary
 *      is on PATH. Its value here is the platforms a plain HTTP fetch cannot
 *      reach: authed timelines, comment threads, video subtitles.
 *
 *   2. **Jina Reader** (r.jina.ai) — no install, no key, any public URL.
 *      Verified 2026-08-01: returns markdown in ~0.5-5s.
 *
 * Backend 2 always works, so this endpoint needs zero configuration. Backend 1
 * is a strict upgrade when present.
 *
 * SECURITY: the fetched page is untrusted input. It is returned to the client as
 * plain text for a human to read and edit into a prompt — it is never executed,
 * and it is never spliced into a prompt automatically. A page that contains
 * "ignore your instructions" is just text on screen.
 */

import { execFile } from 'node:child_process';
import { config } from './config.js';
import { fetchWithTimeout, ProviderError } from './providers/types.js';

export interface ReachResult {
  url: string;
  backend: 'agent-reach' | 'jina-reader';
  title?: string;
  /** Extracted text, truncated to config.reach.maxChars. */
  content: string;
  truncated: boolean;
  chars: number;
  elapsedMs: number;
}

/** Blocks private/loopback targets so Reach cannot be used to probe a LAN (SSRF). */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * Validate a target URL. Only http(s), and never a private or loopback host —
 * otherwise this endpoint becomes a way to make the server fetch things on the
 * network it sits inside.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('not a valid URL', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('only http(s) URLs are supported', 400);
  }
  const host = url.hostname;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new ProviderError(
      'refusing to fetch a private, loopback, or link-local address',
      400,
    );
  }
  return url;
}

function truncate(text: string): { content: string; truncated: boolean } {
  const limit = config.reach.maxChars;
  if (text.length <= limit) return { content: text, truncated: false };
  return { content: `${text.slice(0, limit)}\n\n[…truncated]`, truncated: true };
}

/** Jina Reader's markdown starts with `Title: …` — lift it out for the UI. */
function extractTitle(markdown: string): string | undefined {
  const m = /^Title:\s*(.+)$/m.exec(markdown.slice(0, 500));
  return m?.[1]?.trim() || undefined;
}

/**
 * Is the agent-reach CLI available? Resolved once and cached — probing a missing
 * binary on every request is wasted latency.
 */
let agentReachAvailable: boolean | null = null;

function probeAgentReach(): Promise<boolean> {
  const bin = config.reach.agentReachBin || 'agent-reach';
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export async function isAgentReachAvailable(): Promise<boolean> {
  if (agentReachAvailable === null) {
    agentReachAvailable = await probeAgentReach();
  }
  return agentReachAvailable;
}

/**
 * Run `agent-reach read <url>`.
 *
 * `execFile` with an argument array — never a shell string — so a URL cannot
 * inject shell metacharacters.
 */
function runAgentReach(url: string): Promise<string> {
  const bin = config.reach.agentReachBin || 'agent-reach';
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['read', url],
      {
        timeout: config.reach.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.slice(0, 200) || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function viaJina(url: string, signal: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': 'OkongzINC-Studio/0.1',
    Accept: 'text/plain',
  };
  if (config.reach.jinaApiKey) {
    headers.Authorization = `Bearer ${config.reach.jinaApiKey}`;
  }

  const res = await fetchWithTimeout(
    `${config.reach.jinaBaseUrl}/${url}`,
    { method: 'GET', headers, timeoutMs: config.reach.timeoutMs },
    signal,
  );

  if (!res.ok) {
    throw new ProviderError(`Jina Reader returned HTTP ${res.status}`, 502);
  }
  return res.text();
}

/**
 * Fetch a URL as markdown, preferring agent-reach and falling back to Jina.
 *
 * A failing agent-reach does not fail the request — it falls through to Jina,
 * because the CLI's platform coverage is a bonus, not a dependency.
 */
export async function reachUrl(rawUrl: string, signal: AbortSignal): Promise<ReachResult> {
  if (!config.reach.enabled) {
    throw new ProviderError('Reach is disabled (REACH_ENABLED=false)', 503);
  }

  const url = assertPublicHttpUrl(rawUrl);
  const started = Date.now();

  if (await isAgentReachAvailable()) {
    try {
      const raw = await runAgentReach(url.toString());
      if (raw.trim().length > 0) {
        const { content, truncated } = truncate(raw.trim());
        return {
          url: url.toString(),
          backend: 'agent-reach',
          title: extractTitle(raw),
          content,
          truncated,
          chars: raw.length,
          elapsedMs: Date.now() - started,
        };
      }
      // Empty stdout: treat as a miss and fall through to Jina.
    } catch {
      // agent-reach failed (unsupported platform, missing cookie, dead
      // backend). Jina still handles any public URL.
    }
  }

  const raw = await viaJina(url.toString(), signal);
  const { content, truncated } = truncate(raw.trim());
  return {
    url: url.toString(),
    backend: 'jina-reader',
    title: extractTitle(raw),
    content,
    truncated,
    chars: raw.length,
    elapsedMs: Date.now() - started,
  };
}

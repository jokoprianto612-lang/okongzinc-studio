/**
 * Reach on the Worker — URL to clean markdown.
 *
 * Same endpoint contract as `server/src/reach.ts`, with one backend instead of
 * two: the agent-reach CLI cannot exist here because a Worker has no child
 * processes. Jina Reader was always the fallback that "always works", so it is
 * the whole implementation now, and `/api/health` reports the backend honestly
 * rather than claiming CLI coverage this runtime does not have.
 *
 * SECURITY, unchanged and non-negotiable:
 *
 *   - The fetched page is UNTRUSTED input. It goes back to the client as plain
 *     text for a human to read and edit into a prompt. It is never executed and
 *     never spliced into a prompt automatically. A page saying "ignore your
 *     instructions" is just text on screen.
 *   - `assertPublicHttpUrl` blocks private, loopback, and link-local hosts. On a
 *     Worker the SSRF target is not a LAN but Cloudflare's own internal surface
 *     and the metadata-style addresses (169.254.x), so the guard matters at least
 *     as much here as it does on a laptop. Do not relax it for convenience.
 */

import type { Env } from './types.js';
import { ProviderError } from './types.js';

export interface ReachResult {
  url: string;
  backend: 'agent-reach' | 'jina-reader';
  title?: string;
  content: string;
  truncated: boolean;
  chars: number;
  elapsedMs: number;
}

const JINA_BASE = 'https://r.jina.ai';
const MAX_CHARS = 12000;
const TIMEOUT_MS = 45_000;

/** Hosts Reach must never fetch. Mirrors the Express guard exactly. */
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
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(url.hostname))) {
    throw new ProviderError('refusing to fetch a private, loopback, or link-local address', 400);
  }
  return url;
}

function truncate(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { content: text, truncated: false };
  return { content: `${text.slice(0, MAX_CHARS)}\n\n[…truncated]`, truncated: true };
}

/** Jina's markdown opens with `Title: …` — lift it out for the UI. */
function extractTitle(markdown: string): string | undefined {
  const m = /^Title:\s*(.+)$/m.exec(markdown.slice(0, 500));
  return m?.[1]?.trim() || undefined;
}

export async function reachUrl(rawUrl: string, env: Env): Promise<ReachResult> {
  const url = assertPublicHttpUrl(rawUrl);
  const started = Date.now();

  const headers: Record<string, string> = {
    'User-Agent': 'OkongzINC-Studio/0.1 (Cloudflare Worker)',
    Accept: 'text/plain',
  };
  // An optional Jina key only raises rate limits; anonymous access works.
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;

  const res = await fetch(`${JINA_BASE}/${url.toString()}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ProviderError(`Jina Reader returned HTTP ${res.status}`, 502);
  }

  const raw = (await res.text()).trim();
  const { content, truncated } = truncate(raw);
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

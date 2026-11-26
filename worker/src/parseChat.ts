/** Chat message parameter extraction — no LLM, pure regex.
 *
 * Mirrors server/src/parseChat.ts because the Worker imports its own types
 * (GenerateRequest here differs from the server's). Extracts duration and
 * aspect ratio from free-form text; everything else stays in `prompt`.
 */

import type { AspectRatio, GenerateRequest, Job } from './types.js';

const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4'];

/**
 * Extract a duration in seconds from the message.
 * Matches "5s", "5 seconds", "5 detik", "durasi 10", etc.
 * Returns undefined when nothing matches — the provider's own default applies.
 */
function extractDurationSeconds(message: string): number | undefined {
  const match = message.match(/(\d+)\s*(?:seconds|second|secs|sec|s|detik)\b/i);
  const raw = match?.[1];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Extract an aspect ratio token ("16:9", "9:16", ...) if present.
 */
function extractAspectRatio(message: string): AspectRatio | undefined {
  for (const ratio of ASPECT_RATIOS) {
    if (message.includes(ratio)) return ratio;
  }
  return undefined;
}

/**
 * Strip recognised parameter tokens from the message so what remains is the
 * prompt sent to the provider. Longer unit words first so "seconds" isn't
 * partially matched as "s" leaving "econds" behind.
 */
function stripParameters(message: string): string {
  let cleaned = message;
  cleaned = cleaned.replace(
    /(\d+)\s*(?:seconds|second|secs|sec|s|detik)\b/gi,
    '',
  );
  for (const ratio of ASPECT_RATIOS) {
    cleaned = cleaned.replace(new RegExp(ratio, 'g'), '');
  }
  return cleaned.replace(/\s+/g, ' ').replace(/[,.]+$/, '').trim();
}

/** What /api/chat returns — the job plus what was parsed from the message. */
export interface ChatResponse {
  job: Job;
  parsed: {
    prompt: string;
    durationSeconds?: number;
    aspectRatio?: string;
  };
}

/**
 * Parse a free-form chat message into a GenerateRequest. Throws nothing —
 * unknown content just stays in `prompt`.
 */
export function parseChatMessage(message: string): GenerateRequest {
  const duration = extractDurationSeconds(message);
  const aspectRatio = extractAspectRatio(message);
  const prompt = stripParameters(message);

  const request: GenerateRequest = {
    modality: 'video',
    provider: '', // filled in by the caller once the default provider is known
    prompt: prompt.length > 0 ? prompt : message,
  };
  if (duration) request.durationSeconds = duration;
  if (aspectRatio) request.aspectRatio = aspectRatio;
  return request;
}

/**
 * Prompt studio — LLM-assisted prompt authoring.
 *
 * Two operations, both running on fal's `fal-ai/any-llm` so they need no
 * credential beyond the `FAL_KEY` the studio already has:
 *
 *   enhance  a rough idea → a prompt written the way THIS model wants it
 *   breakdown an idea → a JSON structure of cinematography categories
 *
 * The idea comes from ilkerzg/awesome-video-prompts (prompt.dengeai.com), which
 * pairs a JSON category breakdown with a per-model "Enhance Prompt" rewrite. Two
 * things are done differently here, both deliberate:
 *
 *   1. **The system prompt is DERIVED from `PROMPT_GUIDANCE`, not duplicated.**
 *      Upstream hand-writes a ~15-line `systemPrompt` per model alongside the
 *      same model's `tips` array, so the two drift: a tip gets updated and the
 *      system prompt keeps the old advice. Here the tips ARE the instruction, so
 *      the text a user reads in the UI and the text the LLM receives cannot
 *      disagree. Adding a provider to `promptGuidance.ts` gives it a tuned
 *      enhancer for free.
 *
 *   2. **This is not a Provider.** It returns text for a human to edit, not an
 *      artifact for the gallery — the same reason Reach is an endpoint rather
 *      than a provider. Forcing it through the `Provider` interface would mean
 *      inventing a fake modality.
 *
 * SECURITY: the LLM output is untrusted text. It is returned to the client to be
 * shown in a textarea for a human to read and edit. It is never executed, and it
 * is never auto-submitted as a generation — the user has to press Generate.
 */

import { config } from './config.js';
import { falAvailability, runFalQueued } from './providers/falClient.js';
import { guidanceFor } from './promptGuidance.js';
import { ProviderError, type GenerationContext } from './providers/types.js';

/** fal's hosted LLM router. Schema verified 2026-08-02 from the live OpenAPI. */
const ANY_LLM = 'fal-ai/any-llm';

/**
 * Models the endpoint's enum actually accepts, narrowed to the ones worth
 * offering for this job.
 *
 * The full enum has 30 entries; a dropdown of 30 is worse than four good
 * defaults. Verified present in the enum on 2026-08-02 — passing a model outside
 * it is a 422.
 */
export const PROMPT_LLMS = [
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash — fast, cheap (default)' },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5 — best prose' },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
  { id: 'deepseek/deepseek-v3.1-terminus', label: 'DeepSeek v3.1 — cheapest' },
] as const;

const DEFAULT_LLM = 'google/gemini-2.5-flash';

function resolveModel(requested?: string): string {
  return PROMPT_LLMS.some((m) => m.id === requested) ? (requested as string) : DEFAULT_LLM;
}

export function promptStudioAvailability(): { available: boolean; reason?: string } {
  if (!config.promptStudio.enabled) {
    return { available: false, reason: 'prompt studio is disabled (PROMPT_STUDIO_ENABLED=false)' };
  }
  return falAvailability();
}

/**
 * Call the LLM and return its text.
 *
 * Goes through the same queue transport every provider uses, so it inherits the
 * error translation and cancellation handling rather than reimplementing them.
 */
async function runLlm(
  prompt: string,
  systemPrompt: string,
  model: string,
  ctx: GenerationContext,
): Promise<string> {
  const result = await runFalQueued(
    ANY_LLM,
    {
      prompt,
      system_prompt: systemPrompt,
      model,
      // Deterministic enough to be useful, loose enough to not be robotic.
      temperature: 0.7,
      max_tokens: 2048,
      reasoning: false,
    },
    ctx,
  );

  // The endpoint reports its own failures in an `error` field rather than an
  // HTTP status, so a 200 with `error` set is still a failure.
  if (typeof result.error === 'string' && result.error) {
    throw new ProviderError(`LLM failed: ${result.error.slice(0, 200)}`, 502);
  }
  const output = typeof result.output === 'string' ? result.output : '';
  if (!output.trim()) {
    throw new ProviderError('the LLM returned an empty response', 502);
  }
  return output.trim();
}

// ---------------------------------------------------------------------------
// Enhance
// ---------------------------------------------------------------------------

export interface EnhanceResult {
  original: string;
  enhanced: string;
  /** Which provider's guidance shaped the rewrite, when one was found. */
  guidanceUsed?: string;
  model: string;
  /** Recommended ceiling for the target provider, so the UI can flag overruns. */
  maxLength?: number;
  elapsedMs: number;
}

/**
 * Build the system prompt from the target provider's curated guidance.
 *
 * This is the piece that keeps one source of truth: the summary and tips shown
 * in the UI are the same text the LLM is instructed with. A provider with no
 * curated guidance still gets a sensible generic rewrite rather than an error.
 */
function buildSystemPrompt(providerId: string | undefined): {
  system: string;
  guidanceUsed?: string;
  maxLength?: number;
} {
  const guidance = providerId ? guidanceFor(providerId) : undefined;

  if (!guidance) {
    return {
      system:
        'You are a prompt engineer for AI generative media. Rewrite the user\'s ' +
        'idea into a single vivid, concrete prompt. Be specific about subject, ' +
        'lighting, composition, and motion where relevant. ' +
        'Output ONLY the rewritten prompt as plain text — no markdown, no quotes, ' +
        'no preamble, no explanation.',
    };
  }

  return {
    guidanceUsed: guidance.providerId,
    maxLength: guidance.maxLength,
    system: [
      `You are a prompt engineer for this specific model: ${guidance.summary}`,
      '',
      'Follow these model-specific rules, which come from the model\'s own documented behaviour:',
      ...guidance.tips.map((tip) => `- ${tip}`),
      '',
      `Keep the result under ${guidance.maxLength} characters.`,
      'Preserve the user\'s subject and intent — enrich it, do not replace it.',
      'Output ONLY the rewritten prompt as plain text — no markdown, no quotes,',
      'no preamble, no explanation, no bullet points.',
    ].join('\n'),
  };
}

/** Strip the wrapper an LLM adds even when told not to. */
function cleanPromptText(raw: string): string {
  let text = raw.trim();

  // Fenced code block, with or without a language tag.
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  // A single pair of wrapping quotes, which models add habitually.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  // A leading label like "Enhanced prompt:" or "Here is the prompt:".
  text = text.replace(/^(?:enhanced\s+)?prompt\s*:\s*/i, '').trim();
  text = text.replace(/^here(?:'s| is)\s+the\s+(?:enhanced\s+)?prompt\s*:?\s*/i, '').trim();

  return text;
}

export async function enhancePrompt(
  input: { prompt: string; providerId?: string; model?: string },
  ctx: GenerationContext,
): Promise<EnhanceResult> {
  const started = Date.now();
  const model = resolveModel(input.model);
  const { system, guidanceUsed, maxLength } = buildSystemPrompt(input.providerId);

  ctx.onProgress(`enhancing with ${model}`);
  const raw = await runLlm(input.prompt, system, model, ctx);
  const enhanced = cleanPromptText(raw);

  return {
    original: input.prompt,
    enhanced,
    guidanceUsed,
    model,
    maxLength,
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// JSON breakdown
// ---------------------------------------------------------------------------

/**
 * Cinematography categories the breakdown may use.
 *
 * Fixed rather than freeform so the output is predictable enough to render as a
 * form and to fold back into a prompt in a sensible order. The list mirrors the
 * vocabulary in `shotVocabulary.ts`, so a breakdown and a hand-composed shot end
 * up speaking the same language.
 */
export const BREAKDOWN_CATEGORIES = [
  'subject',
  'action',
  'environment',
  'lighting',
  'camera_shot',
  'camera_movement',
  'lens',
  'focus',
  'composition',
  'mood',
  'style',
  'color_grade',
  'time_of_day',
  'weather',
  'motion',
  'sound',
  'vfx',
] as const;

export interface BreakdownResult {
  original: string;
  /** Category → short cinematic phrase. Only categories the LLM filled in. */
  categories: Record<string, string>;
  /** The categories joined into a ready-to-render prompt. */
  composed: string;
  model: string;
  elapsedMs: number;
}

const BREAKDOWN_SYSTEM = [
  'You are an expert cinematographer breaking an idea into its component parts.',
  '',
  'Return a JSON object whose keys are chosen ONLY from this list:',
  BREAKDOWN_CATEGORIES.join(', '),
  '',
  'Rules:',
  '- Fill in 8 to 14 categories. Omit any that do not apply rather than inventing filler.',
  '- Each value is a short concrete phrase, 3 to 12 words. No sentences.',
  '- Be specific and physical: "low-angle, 24mm, subject fills frame" beats "dramatic".',
  '- Preserve the user\'s subject exactly. You are describing HOW to shoot their idea.',
  '- Output ONLY the JSON object. No markdown fence, no commentary.',
].join('\n');

/**
 * Extract the JSON object from an LLM response.
 *
 * Models wrap JSON in prose or a code fence often enough that parsing the raw
 * response fails regularly. Finding the outermost braces is what makes this
 * reliable rather than flaky.
 */
function extractJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ProviderError('the LLM did not return a JSON object', 502);
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError('the LLM returned malformed JSON', 502);
  }
}

/**
 * Keep only known categories with usable string values.
 *
 * An unknown key is dropped rather than passed through: the point of a fixed
 * vocabulary is that the client can render it, and a surprise key breaks that.
 * Ordering follows `BREAKDOWN_CATEGORIES` so the composed prompt reads in a
 * sensible sequence regardless of what order the LLM emitted.
 */
function normaliseCategories(parsed: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BREAKDOWN_CATEGORIES) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, 200);
    }
  }
  return out;
}

export async function breakdownPrompt(
  input: { prompt: string; model?: string },
  ctx: GenerationContext,
): Promise<BreakdownResult> {
  const started = Date.now();
  const model = resolveModel(input.model);

  ctx.onProgress(`breaking down with ${model}`);
  const raw = await runLlm(input.prompt, BREAKDOWN_SYSTEM, model, ctx);
  const categories = normaliseCategories(extractJsonObject(raw));

  if (Object.keys(categories).length === 0) {
    throw new ProviderError(
      'the LLM returned no usable categories — try a more descriptive idea',
      502,
    );
  }

  return {
    original: input.prompt,
    categories,
    composed: composeFromCategories(categories),
    model,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Join categories into a prompt.
 *
 * `subject` and `action` lead as a clause; everything else follows as comma-
 * separated modifiers, which is the shape every model here responds to. Exported
 * because the client re-composes after the user edits a field, and both sides
 * must produce the same string — otherwise the preview lies about what will be
 * sent.
 */
export function composeFromCategories(categories: Record<string, string>): string {
  const subject = categories.subject?.trim();
  const action = categories.action?.trim();

  const lead = [subject, action].filter(Boolean).join(', ');
  const rest = BREAKDOWN_CATEGORIES.filter((k) => k !== 'subject' && k !== 'action')
    .map((k) => categories[k]?.trim())
    .filter((v): v is string => Boolean(v));

  if (!lead) return rest.join(', ');
  if (rest.length === 0) return lead;
  return `${lead}. ${rest.join(', ')}`;
}

/**
 * Thin API client.
 *
 * All paths are relative so the same build works behind the Vite dev proxy and
 * when served by the Express server in production. An optional API key is read
 * from localStorage so a deployed instance can be gated without a rebuild.
 */

import type {
  BreakdownResult,
  EnhanceResult,
  GenerateRequest,
  HealthResponse,
  Job,
  PromptGuidance,
  PromptStudioInfo,
  ProvidersResponse,
  ReachResult,
  ShotCategory,
} from './types';

const API_KEY_STORAGE = 'okongzinc.apiKey';

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(key: string): void {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

/** Error carrying the HTTP status so callers can special-case 401/429. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const key = getApiKey();
  if (key) headers.set('X-Api-Key', key);

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

export function fetchProviders(): Promise<ProvidersResponse> {
  return request<ProvidersResponse>('/api/providers');
}

export function fetchJobs(limit = 50): Promise<{ jobs: Job[] }> {
  return request<{ jobs: Job[] }>(`/api/jobs?limit=${limit}`);
}

export function fetchJob(id: string): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/api/jobs/${id}`);
}

export function submitGeneration(payload: GenerateRequest): Promise<{ job: Job }> {
  return request<{ job: Job }>('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function cancelJob(id: string): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export function uploadImage(dataUrl: string, filename?: string): Promise<{ url: string }> {
  return request<{ url: string }>('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ dataUrl, filename }),
  });
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

/** Fetch a reference URL as markdown (agent-reach CLI, else Jina Reader). */
export function reachFetch(url: string): Promise<{ result: ReachResult }> {
  return request<{ result: ReachResult }>('/api/reach', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

/** Cinematography vocabulary for the shot composer (static, cached upstream). */
export function fetchShots(): Promise<{
  categories: ShotCategory[];
  optionCount: number;
  source: string;
}> {
  return request('/api/shots');
}

/** Per-model prompting guidance, plus prompt-studio availability. */
export function fetchGuidance(): Promise<{
  guidance: PromptGuidance[];
  promptStudio?: PromptStudioInfo;
}> {
  return request('/api/guidance');
}

/**
 * Rewrite a rough idea into a prompt shaped for the target provider.
 *
 * The returned text is untrusted LLM output: it is shown in the prompt textarea
 * for the user to read and edit, never auto-submitted as a generation.
 */
export function enhancePrompt(body: {
  prompt: string;
  providerId?: string;
  model?: string;
}): Promise<{ result: EnhanceResult }> {
  return request('/api/prompt/enhance', { method: 'POST', body: JSON.stringify(body) });
}

/** Break an idea into cinematography categories. */
export function breakdownPrompt(body: {
  prompt: string;
  model?: string;
}): Promise<{ result: BreakdownResult }> {
  return request('/api/prompt/breakdown', { method: 'POST', body: JSON.stringify(body) });
}

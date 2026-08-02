/**
 * Provider registry for the Worker.
 *
 * Same capability-descriptor idea as the Express server, but a provider here is
 * split into two pure functions instead of one `generate()`:
 *
 *   buildInput(req, env)  → the fal request body   (runs during POST /api/generate)
 *   extract(result)       → the artifact           (runs during a later GET poll)
 *
 * That split exists because the Worker cannot hold a request open for the minutes
 * a render takes. A single `generate()` would have to poll in-request and would be
 * killed by the platform's CPU/duration limits, losing work fal had already
 * billed for.
 *
 * Providers that cannot work without R2 are deliberately absent: Pollinations
 * returns raw bytes with no durable URL to reference, and the Modal workers need
 * a deploy plus a place to put their output. Only backends that hand back a
 * hosted URL can be served from a storage-less Worker.
 *
 * Every schema and price below was read from fal's own metadata on 2026-08-02,
 * the same sources the Express providers cite:
 *   schema  GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *   price   GET https://fal.ai/api/models?...  → items[].pricingInfoOverride
 */

import { falResolveImage, falResolveMedia, type FalFile } from './falClient.js';
import type {
  Artifact,
  AspectRatio,
  Env,
  GenerateRequest,
  Modality,
  ModelOption,
  ProviderInfo,
  ProviderTier,
  Resolution,
} from './types.js';
import { ProviderError } from './types.js';

export interface WorkerProvider {
  id: string;
  label: string;
  modality: Modality;
  requiresSourceImage: boolean;
  supportsSeed: boolean;
  supportsNegativePrompt: boolean;
  supportedAspectRatios: AspectRatio[];
  supportedResolutions?: Resolution[];
  models: ModelOption[];
  typicalLatency?: string;
  notes?: string;
  tier: ProviderTier;
  priceRange?: string;
  producesAudio?: boolean;
  /** Input requirements beyond an image, so the form asks for the right file. */
  requiresSourceAudio?: boolean;
  requiresSourceVideo?: boolean;
  /** Accepts LoRA weight references. */
  supportsLoras?: boolean;
  /** Accepts style/character reference images. */
  supportsReferenceImages?: boolean;
  /** Curated named voices. */
  voices?: string[];
  /** True when a prompt is meaningless here (upscalers, transcription). */
  ignoresPrompt?: boolean;

  /** Which fal endpoint this request maps to. */
  endpointFor(req: GenerateRequest): string;
  /** Build the fal request body. May upload a data-URL source image. */
  buildInput(req: GenerateRequest, env: Env): Promise<Record<string, unknown>>;
  /** Pull the artifact out of fal's finished result. */
  extract(result: Record<string, unknown>): Artifact;
  /** Vendor-quoted cost of this specific request, in USD. */
  quote(req: GenerateRequest): number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** fal's named-size vocabulary, used by FLUX.2, Seedream, Ideogram, LongCat. */
const IMAGE_SIZE: Record<AspectRatio, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

function imageFrom(result: Record<string, unknown>, label: string): Artifact {
  const images = result.images as FalFile[] | undefined;
  const first = images?.[0];
  if (!first?.url) {
    throw new ProviderError(
      `${label} returned no image — the prompt may have been refused by the safety filter`,
      502,
    );
  }
  return {
    url: first.url,
    mimeType: first.content_type ?? 'image/png',
    bytes: first.file_size ?? 0,
  };
}

function videoFrom(result: Record<string, unknown>, label: string): Artifact {
  const v = result.video as FalFile | undefined;
  if (!v?.url) throw new ProviderError(`${label} returned no video`, 502);
  return { url: v.url, mimeType: v.content_type ?? 'video/mp4', bytes: v.file_size ?? 0 };
}

function meshFrom(result: Record<string, unknown>, label: string, prefer?: string): Artifact {
  const candidates = [prefer, 'model_glb', 'pbr_model', 'model_mesh', 'base_model'].filter(
    (k): k is string => Boolean(k),
  );
  for (const key of candidates) {
    const f = result[key] as FalFile | undefined;
    if (f?.url) {
      return {
        url: f.url,
        mimeType: f.content_type ?? 'model/gltf-binary',
        bytes: f.file_size ?? 0,
      };
    }
  }
  throw new ProviderError(`${label} returned no mesh`, 502);
}

// ---------------------------------------------------------------------------
// Standard tier — cents per render
// ---------------------------------------------------------------------------

const LONGCAT_IMAGE = 'fal-ai/longcat-image';

const longcatImage: WorkerProvider = {
  id: 'fal-longcat-image',
  label: 'LongCat Image (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: LONGCAT_IMAGE, label: 'LongCat Image — text→image', price: 'cents per image' },
    { id: 'fal-ai/longcat-image/edit', label: 'LongCat Image Edit — needs a source' },
  ],
  typicalLatency: '5-20s',
  tier: 'standard',
  priceRange: 'per image, cents',
  notes: 'The cheapest hosted image model here. The edit variant transforms a source image.',

  endpointFor: (req) => req.model || LONGCAT_IMAGE,
  quote: () => 0.01,

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);
    if (endpoint.endsWith('/edit') && !req.sourceImage) {
      throw new ProviderError('LongCat Image Edit needs a source image', 400);
    }
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      output_format: 'png',
      num_images: 1,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.sourceImage) input.image_url = await falResolveImage(req.sourceImage, env);
    return input;
  },
  extract: (r) => imageFrom(r, 'LongCat Image'),
};

/** LongCat video endpoints encode task and resolution in the path. */
const LONGCAT_VIDEO_DEFAULT = 'fal-ai/longcat-video/distilled/text-to-video/480p';

const longcatVideo: WorkerProvider = {
  id: 'fal-longcat-video',
  label: 'LongCat-Video (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9', '9:16'],
  models: [
    { id: LONGCAT_VIDEO_DEFAULT, label: 'Text→Video 480p distilled', price: '$0.005/s (cheapest)' },
    {
      id: 'fal-ai/longcat-video/distilled/text-to-video/720p',
      label: 'Text→Video 720p distilled',
      price: '$0.01/s',
    },
    { id: 'fal-ai/longcat-video/text-to-video/480p', label: 'Text→Video 480p full', price: '$0.025/s' },
    { id: 'fal-ai/longcat-video/text-to-video/720p', label: 'Text→Video 720p full', price: '$0.04/s' },
    {
      id: 'fal-ai/longcat-video/distilled/image-to-video/480p',
      label: 'Image→Video 480p distilled',
      price: '$0.005/s',
    },
    {
      id: 'fal-ai/longcat-video/distilled/image-to-video/720p',
      label: 'Image→Video 720p distilled',
      price: '$0.01/s',
    },
    { id: 'fal-ai/longcat-video/image-to-video/480p', label: 'Image→Video 480p full', price: '$0.025/s' },
    { id: 'fal-ai/longcat-video/image-to-video/720p', label: 'Image→Video 720p full', price: '$0.04/s' },
  ],
  typicalLatency: '1-6 min',
  tier: 'standard',
  priceRange: '$0.005-$0.04 per generated second',
  notes:
    'By far the cheapest video here — a 6s clip at 480p distilled is about 3 cents. ' +
    'Frames are counted at 15fps (480p) or 30fps (720p), so duration sets num_frames.',

  endpointFor: (req) => req.model || LONGCAT_VIDEO_DEFAULT,
  quote(req) {
    const ep = this.endpointFor(req);
    const perSecond = ep.includes('/distilled/')
      ? ep.endsWith('/720p')
        ? 0.01
        : 0.005
      : ep.endsWith('/720p')
        ? 0.04
        : 0.025;
    return perSecond * (req.durationSeconds ?? 6);
  },

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);
    const isI2V = endpoint.includes('/image-to-video/');
    if (isI2V && !req.sourceImage) {
      throw new ProviderError('this LongCat endpoint is image→video and needs a source image', 400);
    }
    const fps = endpoint.endsWith('/720p') ? 30 : 15;
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      fps,
      video_output_type: 'X264 (.mp4)',
      video_quality: 'high',
    };
    // num_frames range verified from the spec: 17..961.
    if (req.durationSeconds) {
      input.num_frames = Math.min(Math.max(req.durationSeconds * fps, 17), 961);
    }
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.aspectRatio && !isI2V) input.aspect_ratio = req.aspectRatio;
    if (req.sourceImage) input.image_url = await falResolveImage(req.sourceImage, env);
    return input;
  },
  extract: (r) => videoFrom(r, 'LongCat-Video'),
};

const trellis: WorkerProvider = {
  id: 'fal-trellis',
  label: 'TRELLIS-2 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: 'fal-ai/trellis-2', label: 'TRELLIS-2', price: '$0.25 @512p, $0.30 @1024p' },
    { id: 'fal-ai/trellis', label: 'TRELLIS (v1)' },
  ],
  typicalLatency: '30s-2min',
  tier: 'standard',
  priceRange: '$0.25-$0.30 per mesh',
  notes: 'Image→3D without needing a 24GB GPU. Outputs a .glb mesh.',

  endpointFor: (req) => req.model || 'fal-ai/trellis-2',
  quote: () => 0.3,

  async buildInput(req, env) {
    if (!req.sourceImage) throw new ProviderError('TRELLIS-2 needs a source image', 400);
    const input: Record<string, unknown> = {
      image_url: await falResolveImage(req.sourceImage, env),
    };
    if (this.endpointFor(req) === 'fal-ai/trellis-2') {
      input.resolution = 512;
      input.texture_size = 1024;
    }
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  },
  // fal's TRELLIS-2 returns model_glb, v1 returns model_mesh.
  extract: (r) => meshFrom(r, 'TRELLIS-2', 'model_glb'),
};

// ---------------------------------------------------------------------------
// Premium tier — dollars per render
// ---------------------------------------------------------------------------

const FLUX2 = 'fal-ai/flux-2-pro';
const FLUX2_EDIT = 'fal-ai/flux-2-pro/edit';

const flux2Pro: WorkerProvider = {
  id: 'fal-flux2-pro',
  label: 'FLUX.2 Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: FLUX2, label: 'FLUX.2 Pro — text→image', price: '$0.03/MP' },
    { id: FLUX2_EDIT, label: 'FLUX.2 Pro Edit — needs a source', price: '$0.03/MP + input' },
  ],
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.03-$0.06 per image',
  notes: 'Strongest prompt adherence of the image models. $0.03 first megapixel, $0.015 after.',

  endpointFor: (req) => (req.model === FLUX2_EDIT ? FLUX2_EDIT : FLUX2),
  quote: (req) => (req.model === FLUX2_EDIT ? 0.06 : 0.045),

  async buildInput(req, env) {
    const isEdit = this.endpointFor(req) === FLUX2_EDIT;
    if (isEdit && !req.sourceImage) {
      throw new ProviderError('FLUX.2 Pro Edit needs a source image', 400);
    }
    const input: Record<string, unknown> = { prompt: req.prompt, output_format: 'png' };
    if (req.seed !== undefined) input.seed = req.seed;
    if (isEdit) {
      // image_urls is an ARRAY on this endpoint; a scalar image_url is a 422.
      input.image_urls = [await falResolveImage(req.sourceImage as string, env)];
      input.image_size = 'auto';
    } else {
      input.image_size = IMAGE_SIZE[req.aspectRatio ?? '1:1'];
    }
    return input;
  },
  extract: (r) => imageFrom(r, 'FLUX.2 Pro'),
};

const NANO_PRO = 'fal-ai/nano-banana-pro';
const NANO_PRO_EDIT = 'fal-ai/nano-banana-pro/edit';
const NANO_2 = 'fal-ai/nano-banana-2';

const nanoBananaPro: WorkerProvider = {
  id: 'fal-nano-banana-pro',
  label: 'Nano Banana Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportedResolutions: ['1080p', '2K', '4K'],
  models: [
    { id: NANO_PRO, label: 'Nano Banana Pro — text→image', price: '$0.15/image' },
    { id: NANO_PRO_EDIT, label: 'Nano Banana Pro Edit — needs a source', price: '$0.15/image' },
    { id: NANO_2, label: 'Nano Banana 2 — cheaper', price: '$0.08/image' },
  ],
  typicalLatency: '10-30s',
  tier: 'premium',
  priceRange: '$0.08-$0.30 per image',
  notes:
    'The only image model here that reliably renders readable text inside the ' +
    'image. 4K output is billed at double rate.',

  endpointFor: (req) =>
    req.model === NANO_PRO_EDIT || req.model === NANO_2 ? req.model : NANO_PRO,
  quote(req) {
    const base = this.endpointFor(req) === NANO_2 ? 0.08 : 0.15;
    return req.resolution === '4K' ? base * 2 : base;
  },

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);
    const isEdit = endpoint === NANO_PRO_EDIT;
    if (isEdit && !req.sourceImage) {
      throw new ProviderError('Nano Banana Pro Edit needs a source image', 400);
    }
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      num_images: 1,
      output_format: 'png',
      // Cheapest unless asked otherwise — 4K doubles the bill.
      resolution: req.resolution === '4K' ? '4K' : req.resolution === '2K' ? '2K' : '1K',
    };
    if (req.seed !== undefined) input.seed = req.seed;
    // Nano Banana uses literal ratio strings, NOT fal's image_size names.
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (isEdit) {
      input.image_urls = [await falResolveImage(req.sourceImage as string, env)];
      if (!req.aspectRatio) input.aspect_ratio = 'auto';
    }
    return input;
  },
  extract: (r) => imageFrom(r, 'Nano Banana Pro'),
};

const IDEOGRAM_V3 = 'fal-ai/ideogram/v3';
const IDEOGRAM_PRICE: Record<string, number> = { TURBO: 0.03, BALANCED: 0.06, QUALITY: 0.09 };

const ideogramV3: WorkerProvider = {
  id: 'fal-ideogram-v3',
  label: 'Ideogram V3 (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: 'TURBO', label: 'Ideogram V3 — Turbo', price: '$0.03/image' },
    { id: 'BALANCED', label: 'Ideogram V3 — Balanced', price: '$0.06/image' },
    { id: 'QUALITY', label: 'Ideogram V3 — Quality', price: '$0.09/image' },
  ],
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.03-$0.09 per image',
  notes:
    'Posters, logos, typography. The model choice IS the price dial — same model, ' +
    'three step counts. One of the few here that takes a negative prompt.',

  endpointFor: () => IDEOGRAM_V3,
  quote: (req) => IDEOGRAM_PRICE[req.model ?? 'BALANCED'] ?? 0.06,

  async buildInput(req) {
    const speed =
      req.model === 'TURBO' || req.model === 'QUALITY' ? req.model : 'BALANCED';
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      rendering_speed: speed,
      num_images: 1,
      image_size: IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      style: 'AUTO',
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    return input;
  },
  extract: (r) => imageFrom(r, 'Ideogram V3'),
};

const SEEDREAM = 'bytedance/seedream/v5/pro/text-to-image';
const SEEDREAM_EDIT = 'bytedance/seedream/v5/pro/edit';

const seedream5: WorkerProvider = {
  id: 'fal-seedream5-pro',
  label: 'Seedream 5.0 Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportedResolutions: ['1080p', '2K'],
  models: [
    { id: SEEDREAM, label: 'Seedream 5.0 Pro — text→image', price: '$0.0675/image' },
    { id: SEEDREAM_EDIT, label: 'Seedream 5.0 Pro Edit — needs a source', price: '$0.0675+/image' },
  ],
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.0675-$0.135 per image',
  notes: 'Cheapest premium image model, strong on photographic realism. 2K costs double.',

  endpointFor: (req) => (req.model === SEEDREAM_EDIT ? SEEDREAM_EDIT : SEEDREAM),
  quote: (req) => {
    const wants2k = req.resolution === '2K' || req.resolution === '4K';
    return (wants2k ? 0.135 : 0.0675) + (req.model === SEEDREAM_EDIT ? 0.0045 : 0);
  },

  async buildInput(req, env) {
    const isEdit = this.endpointFor(req) === SEEDREAM_EDIT;
    if (isEdit && !req.sourceImage) {
      throw new ProviderError('Seedream 5.0 Pro Edit needs a source image', 400);
    }
    const wants2k = req.resolution === '2K' || req.resolution === '4K';
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      num_images: 1,
      output_format: 'png',
      image_size: wants2k ? 'auto_2K' : IMAGE_SIZE[req.aspectRatio ?? '1:1'],
    };
    if (isEdit) {
      input.image_urls = [await falResolveImage(req.sourceImage as string, env)];
    }
    return input;
  },
  extract: (r) => imageFrom(r, 'Seedream 5.0 Pro'),
};

const TOPAZ = 'fal-ai/topaz/upscale/image';

const topaz: WorkerProvider = {
  id: 'fal-topaz-upscale',
  label: 'Topaz Upscale (fal)',
  modality: 'image',
  requiresSourceImage: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: 'Standard V2', label: 'Standard V2 — general purpose', price: '$0.08 up to 24MP' },
    { id: 'High Fidelity V2', label: 'High Fidelity V2 — preserve detail', price: '$0.08 up to 24MP' },
    { id: 'Low Resolution V2', label: 'Low Resolution V2 — small input', price: '$0.08 up to 24MP' },
    { id: 'CGI', label: 'CGI — renders and game art', price: '$0.08 up to 24MP' },
    { id: 'Text Refine', label: 'Text Refine — screenshots', price: '$0.08 up to 24MP' },
    { id: 'Recovery V2', label: 'Recovery V2 — heavy damage', price: '$0.08 up to 24MP' },
  ],
  typicalLatency: '15-60s',
  tier: 'premium',
  priceRange: '$0.08-$1.36 per image',
  notes:
    'Finishing pass, not a generator. Generate first, then paste the result URL ' +
    'as the source. The prompt is ignored.',

  endpointFor: () => TOPAZ,
  quote: () => 0.08,

  async buildInput(req, env) {
    if (!req.sourceImage) throw new ProviderError('Topaz upscale needs a source image', 400);
    return {
      image_url: await falResolveImage(req.sourceImage, env),
      model: req.model || 'Standard V2',
      upscale_factor: 2,
      output_format: 'png',
    };
  },
  // NOTE: singular `image`, unlike every generation endpoint.
  extract: (r) => {
    const image = r.image as FalFile | undefined;
    if (!image?.url) throw new ProviderError('Topaz returned no image', 502);
    return { url: image.url, mimeType: image.content_type ?? 'image/png', bytes: image.file_size ?? 0 };
  },
};

/** Veo rate table, per generated second. Verified from fal metadata 2026-08-02. */
const VEO_RATES: Record<string, { hd: [number, number]; uhd: [number, number] }> = {
  'fal-ai/veo3.1': { hd: [0.2, 0.4], uhd: [0.4, 0.6] },
  'fal-ai/veo3.1/image-to-video': { hd: [0.2, 0.4], uhd: [0.4, 0.6] },
  'fal-ai/veo3.1/fast': { hd: [0.1, 0.15], uhd: [0.3, 0.35] },
  'fal-ai/veo3.1/fast/image-to-video': { hd: [0.1, 0.15], uhd: [0.3, 0.35] },
  // The lite tier has no 4k option, so uhd mirrors its 1080p rate.
  'fal-ai/veo3.1/lite': { hd: [0.03, 0.05], uhd: [0.05, 0.08] },
  'fal-ai/veo3.1/lite/image-to-video': { hd: [0.03, 0.05], uhd: [0.05, 0.08] },
};

/** Veo accepts only 4s, 6s, or 8s — snap DOWN so nobody overpays by accident. */
function veoDuration(seconds: number | undefined): { value: string; n: number } {
  if (!seconds || seconds <= 4) return { value: '4s', n: 4 };
  if (seconds <= 6) return { value: '6s', n: 6 };
  return { value: '8s', n: 8 };
}

const veo31: WorkerProvider = {
  id: 'fal-veo31',
  label: 'Veo 3.1 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['720p', '1080p', '4K'],
  models: [
    { id: 'fal-ai/veo3.1/lite', label: 'Veo 3.1 Lite — text→video', price: '$0.03/s · $0.05/s audio' },
    {
      id: 'fal-ai/veo3.1/lite/image-to-video',
      label: 'Veo 3.1 Lite — image→video',
      price: '$0.03/s · $0.05/s audio',
    },
    { id: 'fal-ai/veo3.1/fast', label: 'Veo 3.1 Fast — text→video', price: '$0.10/s · $0.15/s audio' },
    {
      id: 'fal-ai/veo3.1/fast/image-to-video',
      label: 'Veo 3.1 Fast — image→video',
      price: '$0.10/s · $0.15/s audio',
    },
    { id: 'fal-ai/veo3.1', label: 'Veo 3.1 — text→video (best)', price: '$0.20/s · $0.40/s audio' },
    {
      id: 'fal-ai/veo3.1/image-to-video',
      label: 'Veo 3.1 — image→video (best)',
      price: '$0.20/s · $0.40/s audio',
    },
  ],
  typicalLatency: '1-4 min',
  tier: 'premium',
  priceRange: '$0.12-$4.80 per clip',
  producesAudio: true,
  notes:
    'Best video quality here and the most expensive. Duration snaps to 4s, 6s, ' +
    'or 8s. Audio is OFF unless you ask — it roughly doubles the price.',

  endpointFor: (req) => (req.model && req.model in VEO_RATES ? req.model : 'fal-ai/veo3.1/lite'),
  quote(req) {
    const ep = this.endpointFor(req);
    const rates = VEO_RATES[ep];
    if (!rates) return 0;
    const band = req.resolution === '4K' ? rates.uhd : rates.hd;
    const perSecond = req.generateAudio ? band[1] : band[0];
    return perSecond * veoDuration(req.durationSeconds).n;
  },

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);
    const isI2V = endpoint.includes('/image-to-video');
    if (isI2V && !req.sourceImage) {
      throw new ProviderError('this Veo endpoint is image→video and needs a source image', 400);
    }
    const isLite = endpoint.includes('/lite');
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // '4s' | '6s' | '8s' — WITH the unit. Kling uses bare integers instead.
      duration: veoDuration(req.durationSeconds).value,
      // The lite tier has no 4k; clamp rather than let fal silently reinterpret.
      resolution:
        req.resolution === '4K' && !isLite
          ? '4k'
          : req.resolution === '1080p' || req.resolution === '4K'
            ? '1080p'
            : '720p',
      generate_audio: req.generateAudio === true,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (isI2V) {
      input.image_url = await falResolveImage(req.sourceImage as string, env);
      if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    } else {
      input.aspect_ratio = req.aspectRatio === '9:16' ? '9:16' : '16:9';
    }
    return input;
  },
  extract: (r) => videoFrom(r, 'Veo 3.1'),
};

const KLING_RATES: Record<string, [number, number]> = {
  'fal-ai/kling-video/v3/standard/text-to-video': [0.084, 0.126],
  'fal-ai/kling-video/v3/standard/image-to-video': [0.084, 0.126],
  'fal-ai/kling-video/v3/pro/text-to-video': [0.112, 0.168],
  'fal-ai/kling-video/v3/pro/image-to-video': [0.112, 0.168],
};

const klingV3: WorkerProvider = {
  id: 'fal-kling-v3',
  label: 'Kling v3 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  models: [
    {
      id: 'fal-ai/kling-video/v3/standard/text-to-video',
      label: 'Kling v3 Standard — text→video',
      price: '$0.084/s · $0.126/s audio',
    },
    {
      id: 'fal-ai/kling-video/v3/standard/image-to-video',
      label: 'Kling v3 Standard — image→video',
      price: '$0.084/s · $0.126/s audio',
    },
    {
      id: 'fal-ai/kling-video/v3/pro/text-to-video',
      label: 'Kling v3 Pro — text→video',
      price: '$0.112/s · $0.168/s audio',
    },
    {
      id: 'fal-ai/kling-video/v3/pro/image-to-video',
      label: 'Kling v3 Pro — image→video',
      price: '$0.112/s · $0.168/s audio',
    },
  ],
  typicalLatency: '2-6 min',
  tier: 'premium',
  priceRange: '$0.25-$2.52 per clip',
  producesAudio: true,
  notes:
    'Cinematic motion with native audio, and the only model here that renders up ' +
    'to 15 seconds in one call. Audio is off by default (it adds 50%).',

  endpointFor: (req) =>
    req.model && req.model in KLING_RATES
      ? req.model
      : 'fal-ai/kling-video/v3/standard/text-to-video',
  quote(req) {
    const band = KLING_RATES[this.endpointFor(req)];
    if (!band) return 0;
    const seconds = Math.min(Math.max(req.durationSeconds ?? 5, 3), 15);
    return (req.generateAudio ? band[1] : band[0]) * seconds;
  },

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);
    const isI2V = endpoint.includes('/image-to-video');
    if (isI2V && !req.sourceImage) {
      throw new ProviderError('this Kling endpoint is image→video and needs a source image', 400);
    }
    const seconds = Math.min(Math.max(req.durationSeconds ?? 5, 3), 15);
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // Bare stringified integer '3'..'15' — no unit, unlike Veo.
      duration: String(seconds),
      generate_audio: req.generateAudio === true,
    };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (isI2V) {
      // start_image_url, NOT image_url.
      input.start_image_url = await falResolveImage(req.sourceImage as string, env);
    } else {
      input.aspect_ratio =
        req.aspectRatio === '9:16' ? '9:16' : req.aspectRatio === '1:1' ? '1:1' : '16:9';
    }
    return input;
  },
  extract: (r) => videoFrom(r, 'Kling v3'),
};

const TRIPO = 'tripo3d/tripo/v2.5/image-to-3d';
const TRIPO_PRICE: Record<string, number> = { no: 0.2, standard: 0.3, HD: 0.4, pbr: 0.4, quad: 0.45 };

const tripo: WorkerProvider = {
  id: 'fal-tripo',
  label: 'Tripo3D v2.5 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: 'no', label: 'Tripo v2.5 — geometry only', price: '$0.20' },
    { id: 'standard', label: 'Tripo v2.5 — standard textures', price: '$0.30' },
    { id: 'HD', label: 'Tripo v2.5 — HD textures', price: '$0.40' },
    { id: 'pbr', label: 'Tripo v2.5 — HD + PBR materials', price: '$0.40' },
    { id: 'quad', label: 'Tripo v2.5 — HD + quad topology (game-ready)', price: '$0.45' },
  ],
  typicalLatency: '1-3 min',
  tier: 'premium',
  priceRange: '$0.20-$0.45 per mesh',
  notes:
    'The only image→3D option here that outputs quad topology and PBR materials, ' +
    'which is what a game engine actually wants. Iterate on "geometry only" first.',

  endpointFor: () => TRIPO,
  quote: (req) => TRIPO_PRICE[req.model ?? 'standard'] ?? 0.3,

  async buildInput(req, env) {
    if (!req.sourceImage) throw new ProviderError('Tripo3D needs a source image', 400);
    const choice = req.model || 'standard';
    const texture = choice === 'no' ? 'no' : choice === 'standard' ? 'standard' : 'HD';
    const input: Record<string, unknown> = {
      image_url: await falResolveImage(req.sourceImage, env),
      texture,
      texture_alignment: 'original_image',
    };
    if (choice === 'pbr') input.pbr = true;
    if (choice === 'quad') input.quad = true;
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  },
  extract: (r) => meshFrom(r, 'Tripo3D', 'pbr_model'),
};

const HUNYUAN_TURBO = 'fal-ai/hunyuan3d/v2/turbo';

const hunyuan3d: WorkerProvider = {
  id: 'fal-hunyuan3d',
  label: 'Hunyuan3D v2 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: HUNYUAN_TURBO, label: 'Hunyuan3D v2 Turbo — fastest' },
    { id: 'fal-ai/hunyuan3d/v2', label: 'Hunyuan3D v2 — full quality' },
  ],
  typicalLatency: '30s-2min',
  tier: 'premium',
  notes:
    'The quickest image→mesh path here, so the cheap way to check a silhouette ' +
    'before paying for a finished asset. fal bills per compute second, so no ' +
    'fixed price is quoted.',

  endpointFor: (req) => (req.model === 'fal-ai/hunyuan3d/v2' ? req.model : HUNYUAN_TURBO),
  // Billed per compute second with no published per-render figure. Quoting 0
  // means the budget ceiling cannot gate it; that is stated in the notes rather
  // than hidden behind an invented number.
  quote: () => 0,

  async buildInput(req, env) {
    if (!req.sourceImage) throw new ProviderError('Hunyuan3D needs a source image', 400);
    const input: Record<string, unknown> = {
      // input_image_url — Tripo and TRELLIS both use image_url instead.
      input_image_url: await falResolveImage(req.sourceImage, env),
      textured_mesh: true,
      octree_resolution: 256,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  },
  extract: (r) => meshFrom(r, 'Hunyuan3D', 'model_mesh'),
};

// ---------------------------------------------------------------------------
// Krea 2 — the one image family that takes custom weights
// ---------------------------------------------------------------------------

const KREA2_TURBO = 'fal-ai/krea-2/turbo';
const KREA2_LORA = 'fal-ai/krea-2/turbo/lora';
const KREA2_STYLE = 'fal-ai/krea-2/turbo/style';
const KREA2_LARGE = 'krea/v2/large/text-to-image';

/** Krea 2 Large takes literal ratio strings, not fal's named image sizes. */
const LARGE_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1:1',
  '16:9': '16:9',
  '9:16': '9:16',
  '4:3': '4:3',
  '3:4': '2:3',
};

/**
 * Parse `url_or_repo` / `url_or_repo:scale` into fal's `{path, scale}` objects.
 *
 * Splits on the LAST colon, because `https://host/x.safetensors` already contains
 * one and splitting on the first would break every URL. A tail that is not a
 * number is treated as part of the path rather than a bad scale.
 */
export function parseLoras(specs: string[]): { path: string; scale: number }[] {
  const out: { path: string; scale: number }[] = [];
  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;
    const lastColon = spec.lastIndexOf(':');
    if (lastColon > 0) {
      const tail = spec.slice(lastColon + 1);
      const scale = Number.parseFloat(tail);
      if (tail.length > 0 && Number.isFinite(scale) && /^-?[\d.]+$/.test(tail)) {
        out.push({ path: spec.slice(0, lastColon), scale: Math.min(Math.max(scale, 0), 4) });
        continue;
      }
    }
    out.push({ path: spec, scale: 1 });
  }
  return out;
}

const krea2: WorkerProvider = {
  id: 'fal-krea-2',
  label: 'Krea 2 (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportsLoras: true,
  supportsReferenceImages: true,
  models: [
    { id: KREA2_TURBO, label: 'Krea 2 Turbo — plain text→image' },
    { id: KREA2_LORA, label: 'Krea 2 Turbo + LoRA — custom weights' },
    { id: KREA2_STYLE, label: 'Krea 2 Turbo Style — needs reference images' },
    { id: KREA2_LARGE, label: 'Krea 2 Large — best quality', price: '$0.060-$0.065/image' },
  ],
  typicalLatency: '5-25s',
  tier: 'premium',
  priceRange: '$0.060-$0.065 per image (Large); turbo unpriced',
  notes:
    'The only image model here that takes custom LoRA weights — paste a ' +
    'HuggingFace repo id or a .safetensors URL, optionally with :scale (0-4). ' +
    'Use the Style endpoint when you have reference images instead of weights.',

  endpointFor: (req) =>
    req.model && [KREA2_TURBO, KREA2_LORA, KREA2_STYLE, KREA2_LARGE].includes(req.model)
      ? req.model
      : KREA2_TURBO,
  quote(req) {
    // Only Krea 2 Large publishes a price; quoting the turbo tiers would invent one.
    if (this.endpointFor(req) !== KREA2_LARGE) return 0;
    return (req.referenceImages?.length ?? 0) > 0 ? 0.065 : 0.06;
  },

  async buildInput(req, env) {
    const endpoint = this.endpointFor(req);

    if (endpoint === KREA2_LARGE) {
      const input: Record<string, unknown> = {
        prompt: req.prompt,
        aspect_ratio: LARGE_ASPECT[req.aspectRatio ?? '1:1'],
        creativity: 'medium',
      };
      if (req.seed !== undefined) input.seed = req.seed;
      if (req.referenceImages?.length) {
        input.image_style_references = await Promise.all(
          req.referenceImages.map((r) => falResolveImage(r, env)),
        );
      }
      return input;
    }

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      num_images: 1,
      output_format: 'png',
      acceleration: 'regular',
    };
    if (req.seed !== undefined) input.seed = req.seed;

    if (endpoint === KREA2_LORA) {
      const loras = parseLoras(req.loras ?? []);
      if (loras.length === 0) {
        throw new ProviderError(
          'Krea 2 LoRA needs at least one LoRA reference (a HuggingFace repo id or ' +
            'a .safetensors URL, optionally as path:scale), or pick plain Krea 2 Turbo.',
          400,
        );
      }
      // Array of {path, scale} objects — not strings.
      input.loras = loras;
    } else if (endpoint === KREA2_STYLE) {
      const refs = req.referenceImages?.length
        ? req.referenceImages
        : req.sourceImage
          ? [req.sourceImage]
          : [];
      if (refs.length === 0) {
        throw new ProviderError(
          'Krea 2 Style needs at least one reference image — that is what defines the style.',
          400,
        );
      }
      input.reference_image_urls = await Promise.all(refs.map((r) => falResolveImage(r, env)));
      input.style_scale = 1;
    }
    return input;
  },
  extract: (r) => imageFrom(r, 'Krea 2'),
};

// ---------------------------------------------------------------------------
// Audio — ElevenLabs and Seed Audio
// ---------------------------------------------------------------------------

/** Pull the `audio` field out of a fal response. */
function audioFrom(result: Record<string, unknown>, label: string): Artifact {
  const audio = result.audio as FalFile | undefined;
  if (!audio?.url) throw new ProviderError(`${label} returned no audio`, 502);
  return {
    url: audio.url,
    mimeType: audio.content_type ?? 'audio/mpeg',
    bytes: audio.file_size ?? 0,
  };
}

const TTS_V3 = 'fal-ai/elevenlabs/tts/eleven-v3';
const TTS_MULTILINGUAL = 'fal-ai/elevenlabs/tts/multilingual-v2';
const TTS_TURBO = 'fal-ai/elevenlabs/tts/turbo-v2.5';

const ELEVEN_VOICES = ['Rachel', 'Adam', 'Antoni', 'Arnold', 'Bella', 'Domi', 'Elli', 'Josh', 'Sam'];

const elevenTts: WorkerProvider = {
  id: 'fal-elevenlabs-tts',
  label: 'ElevenLabs TTS (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  voices: ELEVEN_VOICES,
  models: [
    { id: TTS_V3, label: 'Eleven v3 — most expressive' },
    { id: TTS_MULTILINGUAL, label: 'Multilingual v2 — 29 languages' },
    { id: TTS_TURBO, label: 'Turbo v2.5 — fastest' },
  ],
  typicalLatency: '3-20s',
  tier: 'premium',
  priceRange: 'per character, billed by ElevenLabs',
  notes:
    'Puts the text in a voice. v3 reads inline tags like [whispers] or [laughs]; ' +
    'Turbo is for latency. Billed per character, so no per-render price is quoted.',

  endpointFor: (req) =>
    req.model === TTS_MULTILINGUAL || req.model === TTS_TURBO ? req.model : TTS_V3,
  quote: () => 0,

  async buildInput(req) {
    const endpoint = this.endpointFor(req);
    // NOTE: `text`, not `prompt` — the only provider family here that differs.
    const input: Record<string, unknown> = {
      text: req.prompt,
      voice: req.voice || 'Rachel',
      stability: 0.5,
    };
    if (endpoint !== TTS_V3) {
      input.similarity_boost = 0.75;
      input.speed = 1;
    }
    return input;
  },
  extract: (r) => audioFrom(r, 'ElevenLabs TTS'),
};

const MUSIC = 'fal-ai/elevenlabs/music';

const elevenMusic: WorkerProvider = {
  id: 'fal-elevenlabs-music',
  label: 'ElevenLabs Music (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: MUSIC, label: 'ElevenLabs Music', price: '$0.80 per output minute' }],
  typicalLatency: '20s-2min',
  tier: 'premium',
  priceRange: '$0.80 per output minute',
  notes:
    'Full tracks from a description. Billing rounds UP to the whole minute, so a ' +
    '30-second clip costs the same $0.80 as 60 seconds — ask for the full minute.',

  endpointFor: () => MUSIC,
  // Rounded up, matching how fal actually bills.
  quote: (req) => Math.ceil(Math.min(Math.max(req.durationSeconds ?? 30, 3), 600) / 60) * 0.8,

  async buildInput(req) {
    const seconds = Math.min(Math.max(req.durationSeconds ?? 30, 3), 600);
    return {
      prompt: req.prompt,
      // NOTE: milliseconds, range 3000..600000.
      music_length_ms: seconds * 1000,
      output_format: 'mp3_44100_128',
    };
  },
  extract: (r) => audioFrom(r, 'ElevenLabs Music'),
};

const SFX = 'fal-ai/elevenlabs/sound-effects/v2';

const elevenSfx: WorkerProvider = {
  id: 'fal-elevenlabs-sfx',
  label: 'ElevenLabs Sound Effects (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: SFX, label: 'Sound Effects v2' }],
  typicalLatency: '3-15s',
  tier: 'premium',
  priceRange: 'per generation, billed by ElevenLabs',
  notes:
    'One-shot effects up to 22 seconds — footsteps, doors, UI clicks, ambience. ' +
    'Describe the material and the action, not the emotion.',

  endpointFor: () => SFX,
  quote: () => 0,

  async buildInput(req) {
    const input: Record<string, unknown> = {
      text: req.prompt,
      prompt_influence: 0.3,
      output_format: 'mp3_44100_128',
    };
    // Float 0.5..22 here — a different field and unit from Music above.
    if (req.durationSeconds) {
      input.duration_seconds = Math.min(Math.max(req.durationSeconds, 0.5), 22);
    }
    return input;
  },
  extract: (r) => audioFrom(r, 'ElevenLabs Sound Effects'),
};

const SEED_AUDIO = 'bytedance/seed-audio-1.0';

const seedAudio: WorkerProvider = {
  id: 'fal-seed-audio',
  label: 'Seed Audio 1.0 (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: SEED_AUDIO, label: 'Seed Audio 1.0' }],
  typicalLatency: '5-30s',
  tier: 'premium',
  priceRange: 'billed per request by fal',
  notes:
    'ByteDance speech with voice cloning: give it reference audio and it speaks ' +
    'the prompt in that voice. fal publishes no fixed price for this one.',

  endpointFor: () => SEED_AUDIO,
  quote: () => 0,

  async buildInput(req, env) {
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      output_format: 'mp3',
      sample_rate: 44100,
      speed: 1,
      volume: 1,
      pitch: 0,
      multilingual: true,
    };
    if (req.voice) input.voice = req.voice;
    // audio_urls is an ARRAY of reference clips for cloning.
    if (req.sourceAudio) input.audio_urls = [await falResolveMedia(req.sourceAudio, env)];
    return input;
  },
  extract: (r) => audioFrom(r, 'Seed Audio 1.0'),
};

const SCRIBE_V2 = 'fal-ai/elevenlabs/speech-to-text/scribe-v2';

interface ScribeWord {
  text?: string;
  speaker_id?: string;
  type?: string;
}

/**
 * Format diarised words into a speaker-labelled transcript.
 *
 * Scribe returns words, not sentences. Joining them raw throws the speaker
 * information away, which is the main thing diarisation was for.
 */
function formatTranscript(text: string, words: ScribeWord[]): string {
  const spoken = words.filter((w) => w.type !== 'spacing' && w.text);
  const speakers = new Set(spoken.map((w) => w.speaker_id).filter(Boolean));
  if (speakers.size <= 1) return text;

  const lines: string[] = [];
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      lines.push(`${current ?? 'speaker'}: ${buffer.join(' ')}`);
      buffer = [];
    }
  };
  for (const word of spoken) {
    if (word.speaker_id !== current) {
      flush();
      current = word.speaker_id;
    }
    if (word.text) buffer.push(word.text.trim());
  }
  flush();
  return lines.join('\n');
}

const scribe: WorkerProvider = {
  id: 'fal-scribe-v2',
  label: 'Scribe v2 — transcribe (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  requiresSourceAudio: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: SCRIBE_V2, label: 'ElevenLabs Scribe v2', price: '$0.008 per input audio minute' }],
  typicalLatency: '5-60s',
  tier: 'premium',
  priceRange: '$0.008 per input audio minute',
  notes:
    'Transcribes speech with speaker diarisation and audio-event tagging. Takes ' +
    'audio OR video. Billed on INPUT length, so a long file costs more regardless ' +
    'of how little was said.',

  endpointFor: () => SCRIBE_V2,
  // Cost depends on input length, unknown before upload. Quote one minute.
  quote: () => 0.008,

  async buildInput(req, env) {
    const source = req.sourceAudio ?? req.sourceVideo;
    if (!source) {
      throw new ProviderError('Scribe v2 needs a source audio or video file', 400);
    }
    return {
      audio_url: await falResolveMedia(source, env),
      diarize: true,
      tag_audio_events: true,
    };
  },
  /**
   * Returns text, not a file.
   *
   * With no R2 there is nowhere to write a .txt artifact, so the transcript is
   * carried on `artifact.text` and `url` is a data: URL — that keeps the Download
   * link working without a bucket, and the UI renders `text` inline anyway.
   */
  extract: (r) => {
    const text = typeof r.text === 'string' ? r.text : '';
    if (!text) throw new ProviderError('Scribe returned no transcript', 502);
    const words = Array.isArray(r.words) ? (r.words as ScribeWord[]) : [];
    const language = typeof r.language_code === 'string' ? r.language_code : 'unknown';
    const transcript = formatTranscript(text, words);
    const body = `# Transcript\nlanguage: ${language}\n\n${transcript}\n`;
    return {
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(body)}`,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(body).byteLength,
      text: transcript,
    };
  },
};

const AUDIO_ISOLATION = 'fal-ai/elevenlabs/audio-isolation';

const audioIsolation: WorkerProvider = {
  id: 'fal-elevenlabs-isolate',
  label: 'Audio Isolation (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  requiresSourceAudio: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: AUDIO_ISOLATION, label: 'ElevenLabs Audio Isolation' }],
  typicalLatency: '5-40s',
  tier: 'premium',
  priceRange: 'billed per request by ElevenLabs',
  notes:
    'Strips background noise and music, leaving clean speech. Takes audio OR ' +
    'video — it pulls the track out of a video for you.',

  endpointFor: () => AUDIO_ISOLATION,
  quote: () => 0,

  async buildInput(req, env) {
    // audio_url OR video_url; one must be present or there is nothing to isolate.
    if (req.sourceAudio) {
      return { audio_url: await falResolveMedia(req.sourceAudio, env) };
    }
    if (req.sourceVideo) {
      return { video_url: await falResolveMedia(req.sourceVideo, env) };
    }
    throw new ProviderError('Audio Isolation needs a source audio or video file', 400);
  },
  extract: (r) => audioFrom(r, 'Audio Isolation'),
};

// ---------------------------------------------------------------------------
// Video utilities — upscalers, not generators
// ---------------------------------------------------------------------------

/** Assumed clip length for a cost quote when the caller does not say. */
const ASSUMED_SECONDS = 10;

/** width x height x frames / 1e6 at 30fps, the vendors' own formula. */
function estimateMegapixels(resolution: Resolution | undefined, seconds: number): number {
  const dims: Record<string, [number, number]> = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '2K': [2560, 1440],
    '4K': [3840, 2160],
  };
  const [w, h] = dims[resolution ?? '1080p'] ?? [1920, 1080];
  return (w * h * seconds * 30) / 1_000_000;
}

function requireVideo(req: GenerateRequest, label: string): string {
  if (!req.sourceVideo) {
    throw new ProviderError(`${label} is an upscaler — it needs a source video`, 400);
  }
  return req.sourceVideo;
}

const BYTEDANCE_VIDEO = 'fal-ai/bytedance-upscaler/upscale/video';
const BYTEDANCE_RATE: Record<string, number> = { '1080p': 0.0072, '2k': 0.0144, '4k': 0.0288 };
const BYTEDANCE_TARGET: Record<string, string> = {
  '720p': '1080p',
  '1080p': '1080p',
  '2K': '2k',
  '4K': '4k',
};

const bytedanceVideo: WorkerProvider = {
  id: 'fal-bytedance-video',
  label: 'ByteDance Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  supportedResolutions: ['1080p', '2K', '4K'],
  models: [
    { id: 'fast', label: 'Fast — cheapest', price: '$0.0072/s @1080p' },
    { id: 'standard', label: 'Standard — balanced', price: '$0.0072/s @1080p' },
    { id: 'pro', label: 'Pro — 10x the price', price: '$0.072/s @1080p' },
  ],
  typicalLatency: '1-5 min',
  tier: 'premium',
  priceRange: '$0.0072-$0.288 per second',
  notes:
    'By far the cheapest upscaler here — about a seventh of Topaz. NOTE: the pro ' +
    'tier is TEN TIMES the price, so it is not the default.',

  endpointFor: () => BYTEDANCE_VIDEO,
  quote(req) {
    const target = BYTEDANCE_TARGET[req.resolution ?? '1080p'] ?? '1080p';
    const base = BYTEDANCE_RATE[target] ?? 0.0072;
    return base * (req.model === 'pro' ? 10 : 1) * (req.durationSeconds ?? ASSUMED_SECONDS);
  },

  async buildInput(req, env) {
    const source = requireVideo(req, 'ByteDance Video Upscale');
    const tier = req.model === 'pro' || req.model === 'fast' ? req.model : 'standard';
    return {
      video_url: await falResolveMedia(source, env),
      target_resolution: BYTEDANCE_TARGET[req.resolution ?? '1080p'] ?? '1080p',
      enhancement_tier: tier,
      target_fps: '30fps',
      enhancement_preset: 'general',
      fidelity: 'high',
    };
  },
  extract: (r) => videoFrom(r, 'ByteDance Video Upscale'),
};

const FLASHVSR_VIDEO = 'fal-ai/flashvsr/upscale/video';

const flashvsrVideo: WorkerProvider = {
  id: 'fal-flashvsr-video',
  label: 'FlashVSR Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [
    { id: 'regular', label: 'Regular — best quality' },
    { id: 'high', label: 'High acceleration — faster' },
    { id: 'full', label: 'Full acceleration — fastest' },
  ],
  typicalLatency: '30s-4min',
  tier: 'premium',
  priceRange: '$0.0005 per megapixel',
  notes:
    'Half the price of SeedVR2 on the same per-megapixel model, and the only ' +
    'upscaler here that keeps the original audio track.',

  endpointFor: () => FLASHVSR_VIDEO,
  quote: (req) => estimateMegapixels(req.resolution, req.durationSeconds ?? ASSUMED_SECONDS) * 0.0005,

  async buildInput(req, env) {
    const source = requireVideo(req, 'FlashVSR');
    const input: Record<string, unknown> = {
      video_url: await falResolveMedia(source, env),
      upscale_factor: 2,
      acceleration: req.model === 'high' || req.model === 'full' ? req.model : 'regular',
      output_format: 'X264 (.mp4)',
      output_quality: 'high',
      preserve_audio: true,
      color_fix: true,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  },
  extract: (r) => videoFrom(r, 'FlashVSR'),
};

const SEEDVR_VIDEO = 'fal-ai/seedvr/upscale/video';
const SEEDVR_TARGET: Record<string, string> = {
  '720p': '720p',
  '1080p': '1080p',
  '2K': '1440p',
  '4K': '2160p',
};

const seedvrVideo: WorkerProvider = {
  id: 'fal-seedvr-video',
  label: 'SeedVR2 Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  supportedResolutions: ['720p', '1080p', '2K', '4K'],
  models: [{ id: SEEDVR_VIDEO, label: 'SeedVR2', price: '$0.001 per megapixel' }],
  typicalLatency: '1-6 min',
  tier: 'premium',
  priceRange: '$0.001 per megapixel',
  notes:
    'Priced per megapixel (width x height x frames), so cost tracks total pixels ' +
    'rather than clip length: a 1920x1080 121-frame clip is about $0.25.',

  endpointFor: () => SEEDVR_VIDEO,
  quote: (req) => estimateMegapixels(req.resolution, req.durationSeconds ?? ASSUMED_SECONDS) * 0.001,

  async buildInput(req, env) {
    const source = requireVideo(req, 'SeedVR2');
    const input: Record<string, unknown> = {
      video_url: await falResolveMedia(source, env),
      output_format: 'X264 (.mp4)',
      output_quality: 'high',
      output_write_mode: 'balanced',
    };
    // 'target' honours target_resolution; 'factor' ignores it and doubles.
    if (req.resolution) {
      input.upscale_mode = 'target';
      input.target_resolution = SEEDVR_TARGET[req.resolution] ?? '1080p';
    } else {
      input.upscale_mode = 'factor';
      input.upscale_factor = 2;
    }
    if (req.seed !== undefined) input.seed = req.seed;
    return input;
  },
  extract: (r) => videoFrom(r, 'SeedVR2'),
};

const TOPAZ_VIDEO = 'fal-ai/topaz/upscale/video';

const topazVideo: WorkerProvider = {
  id: 'fal-topaz-video',
  label: 'Topaz Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  supportedResolutions: ['720p', '1080p', '4K'],
  models: [
    { id: 'Starlight Mini', label: 'Starlight Mini — best all-round detail' },
    { id: 'Proteus', label: 'Proteus — general purpose' },
    { id: 'Artemis HQ', label: 'Artemis HQ — clean sources' },
    { id: 'Artemis LQ', label: 'Artemis LQ — compressed sources' },
    { id: 'Gaia CG', label: 'Gaia CG — animation and 3D renders' },
    { id: 'Gaia 2', label: 'Gaia 2 — half price' },
    { id: 'Nyx Fast', label: 'Nyx Fast — noisy footage' },
  ],
  typicalLatency: '1-8 min',
  tier: 'premium',
  priceRange: '$0.01-$0.08 per video second',
  notes:
    'The quality leader for real footage, priced per SECOND: 10s at 4K is $0.80. ' +
    'Gaia 2 is billed at half rate. Gaia CG for renders, Artemis LQ for anything ' +
    'that has been through YouTube.',

  endpointFor: () => TOPAZ_VIDEO,
  quote(req) {
    const rate =
      req.resolution === '4K' || req.resolution === '2K'
        ? 0.08
        : req.resolution === '1080p'
          ? 0.02
          : 0.01;
    // Gaia 2 is billed at half rate, per fal's own pricing note.
    return rate * (req.model === 'Gaia 2' ? 0.5 : 1) * (req.durationSeconds ?? ASSUMED_SECONDS);
  },

  async buildInput(req, env) {
    const source = requireVideo(req, 'Topaz Video Upscale');
    const known = this.models.some((m) => m.id === req.model);
    return {
      video_url: await falResolveMedia(source, env),
      model: known ? req.model : 'Starlight Mini',
      // Topaz has no target_resolution field — only a factor.
      upscale_factor: req.resolution === '4K' ? 4 : 2,
      H264_output: true,
    };
  },
  extract: (r) => videoFrom(r, 'Topaz Video Upscale'),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Cheap first within each modality; premium last. Same rule as the server. */
export const ALL_PROVIDERS: WorkerProvider[] = [
  // image
  longcatImage,
  flux2Pro,
  nanoBananaPro,
  seedream5,
  krea2,
  ideogramV3,
  topaz,
  // video
  longcatVideo,
  veo31,
  klingV3,
  // video utilities, cheapest upscaler first
  bytedanceVideo,
  flashvsrVideo,
  seedvrVideo,
  topazVideo,
  // 3d
  trellis,
  tripo,
  hunyuan3d,
  // audio
  elevenTts,
  elevenMusic,
  elevenSfx,
  seedAudio,
  scribe,
  audioIsolation,
];

const BY_ID = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): WorkerProvider | undefined {
  return BY_ID.get(id);
}

export function premiumEnabled(env: Env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.PREMIUM_ENABLED ?? '').toLowerCase());
}

/** Availability, mirroring the server's rules: key first, then the premium gate. */
export function availabilityOf(
  provider: WorkerProvider,
  env: Env,
): { available: boolean; reason?: string } {
  if (!env.FAL_KEY) {
    return {
      available: false,
      reason: 'FAL_KEY secret is not set on this Worker (wrangler secret put FAL_KEY)',
    };
  }
  if (provider.tier === 'premium' && !premiumEnabled(env)) {
    return {
      available: false,
      reason:
        'premium models are off — redeploy with PREMIUM_ENABLED=true to allow ' +
        'renders that cost dollars rather than cents',
    };
  }
  return { available: true };
}

export function describe(provider: WorkerProvider, env: Env): ProviderInfo {
  const { available, reason } = availabilityOf(provider, env);
  return {
    id: provider.id,
    label: provider.label,
    modality: provider.modality,
    available,
    unavailableReason: reason,
    requiresSourceImage: provider.requiresSourceImage,
    supportsSeed: provider.supportsSeed,
    supportsNegativePrompt: provider.supportsNegativePrompt,
    supportedAspectRatios: provider.supportedAspectRatios,
    supportedResolutions: provider.supportedResolutions,
    models: provider.models,
    typicalLatency: provider.typicalLatency,
    notes: provider.notes,
    tier: provider.tier,
    priceRange: provider.priceRange,
    producesAudio: provider.producesAudio,
    requiresSourceAudio: provider.requiresSourceAudio,
    requiresSourceVideo: provider.requiresSourceVideo,
    supportsLoras: provider.supportsLoras,
    supportsReferenceImages: provider.supportsReferenceImages,
    voices: provider.voices,
    ignoresPrompt: provider.ignoresPrompt,
  };
}

const TIER_PREFERENCE: ProviderTier[] = ['free', 'standard', 'premium'];

/** Cheapest available tier wins, so enabling premium never moves a default. */
export function defaultProviderFor(modality: Modality, env: Env): string | undefined {
  const candidates = ALL_PROVIDERS.filter(
    (p) => p.modality === modality && availabilityOf(p, env).available,
  );
  for (const tier of TIER_PREFERENCE) {
    const match = candidates.find((p) => p.tier === tier);
    if (match) return match.id;
  }
  return undefined;
}

/**
 * Enforce the per-job spend ceiling before anything is submitted.
 *
 * A quote of 0 means "no published per-render price" (Hunyuan3D), and is not
 * treated as free — it simply cannot be gated, which the provider notes say.
 */
export function assertWithinBudget(usd: number, label: string, env: Env): void {
  const ceiling = Number.parseFloat(env.PREMIUM_MAX_COST_PER_JOB_USD ?? '5');
  if (!Number.isFinite(ceiling) || ceiling <= 0) return;
  if (usd > ceiling) {
    throw new ProviderError(
      `${label} would cost about $${usd.toFixed(2)}, over the ` +
        `PREMIUM_MAX_COST_PER_JOB_USD ceiling of $${ceiling.toFixed(2)}. ` +
        `Shorten the clip, drop the resolution, or raise the ceiling and redeploy.`,
      400,
    );
  }
}

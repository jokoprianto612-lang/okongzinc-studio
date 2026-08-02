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

import { falResolveImage, type FalFile } from './falClient.js';
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
// Registry
// ---------------------------------------------------------------------------

/** Cheap first within each modality; premium last. Same rule as the server. */
export const ALL_PROVIDERS: WorkerProvider[] = [
  longcatImage,
  flux2Pro,
  nanoBananaPro,
  seedream5,
  ideogramV3,
  topaz,
  longcatVideo,
  veo31,
  klingV3,
  trellis,
  tripo,
  hunyuan3d,
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

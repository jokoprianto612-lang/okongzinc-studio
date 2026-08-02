/**
 * Generation form.
 *
 * Fields render conditionally from the selected provider's capability
 * descriptor, so a provider that does not support seeds simply has no seed
 * input instead of silently ignoring it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadImage } from '../lib/api';
import type {
  AspectRatio,
  GenerateRequest,
  Modality,
  PromptGuidance,
  ProviderInfo,
  ProviderTier,
  Resolution,
} from '../lib/types';
import { ErrorNote, TierBadge } from './Primitives';

interface Props {
  modality: Modality;
  providers: ProviderInfo[];
  busy: boolean;
  /** Controlled by App so the gallery's "Use as source" can populate it. */
  sourceImage: string;
  onSourceImageChange: (url: string) => void;
  /** Controlled by App so Reach can append reference text. */
  prompt: string;
  onPromptChange: (text: string) => void;
  /** Shot-vocabulary ids; sent to the server, composed there. */
  shotOptionIds: string[];
  /** Prompting guidance for the selected provider, when curated. */
  guidance?: PromptGuidance;
  /** Reports the effective provider id so App can look up guidance. */
  onProviderChange: (providerId: string) => void;
  onSubmit: (payload: GenerateRequest) => void;
}

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** Cheapest first, so the expensive group is never what the eye lands on. */
const TIER_ORDER: ProviderTier[] = ['free', 'standard', 'premium'];

const TIER_GROUP_LABELS: Record<ProviderTier, string> = {
  free: 'Free — no credentials, no bill',
  standard: 'Paid — cents per render',
  premium: 'Premium — dollars per render',
};

export function GenerateForm({
  modality,
  providers,
  busy,
  sourceImage,
  onSourceImageChange,
  prompt,
  onPromptChange,
  shotOptionIds,
  guidance,
  onProviderChange,
  onSubmit,
}: Props) {
  const forModality = useMemo(
    () => providers.filter((p) => p.modality === modality),
    [providers, modality],
  );

  const firstAvailable = forModality.find((p) => p.available) ?? forModality[0];
  const [providerId, setProviderId] = useState(firstAvailable?.id ?? '');

  // Reset the selection when the tab changes to a modality this provider
  // does not serve.
  const provider =
    forModality.find((p) => p.id === providerId) ?? firstAvailable ?? undefined;

  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [seed, setSeed] = useState('');
  const [model, setModel] = useState('');
  const [duration, setDuration] = useState('');
  const [resolution, setResolution] = useState<Resolution | ''>('');
  // Audio defaults OFF: on Veo 3.1 it doubles the bill, so it must be opted into.
  const [generateAudio, setGenerateAudio] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setUploadError('');
    if (!file.type.startsWith('image/')) {
      setUploadError('Only image files can be used as a source.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`Image is too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 12 MB).`);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('could not read the file'));
        reader.readAsDataURL(file);
      });
      const { url } = await uploadImage(dataUrl, file.name);
      onSourceImageChange(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }, [onSourceImageChange]);

  // Report the effective provider upward. This has to be an effect, not just an
  // onChange handler: switching modality tabs changes the provider without any
  // interaction with the select.
  useEffect(() => {
    if (provider?.id) onProviderChange(provider.id);
  }, [provider?.id, onProviderChange]);

  const canSubmit =
    !busy &&
    !uploading &&
    Boolean(provider?.available) &&
    prompt.trim().length > 0 &&
    (!provider?.requiresSourceImage || sourceImage.length > 0);

  const submit = () => {
    if (!provider || !canSubmit) return;
    const payload: GenerateRequest = {
      modality,
      provider: provider.id,
      prompt: prompt.trim(),
    };
    if (provider.supportsNegativePrompt && negativePrompt.trim()) {
      payload.negativePrompt = negativePrompt.trim();
    }
    if (provider.supportedAspectRatios.includes(aspectRatio) && modality !== 'model3d') {
      payload.aspectRatio = aspectRatio;
    }
    if (provider.supportsSeed && seed.trim()) {
      const n = Number.parseInt(seed, 10);
      if (Number.isFinite(n) && n >= 0) payload.seed = n;
    }
    if (model) payload.model = model;
    if (sourceImage) payload.sourceImage = sourceImage;
    if (modality === 'video' && duration.trim()) {
      const d = Number.parseInt(duration, 10);
      if (Number.isFinite(d) && d > 0) payload.durationSeconds = d;
    }
    if (resolution) payload.resolution = resolution;
    if (provider.producesAudio && generateAudio) payload.generateAudio = true;
    if (shotOptionIds.length > 0) payload.shotOptionIds = shotOptionIds;
    onSubmit(payload);
  };

  if (!provider) {
    return (
      <div className="panel p-4">
        <p className="text-sm text-slate-400">No provider is registered for this modality.</p>
      </div>
    );
  }

  return (
    <form
      className="panel space-y-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* provider */}
      <div>
        <label className="field-label" htmlFor="provider">
          Provider
        </label>
        <select
          id="provider"
          className="input"
          value={provider.id}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModel('');
            setResolution('');
            setGenerateAudio(false);
          }}
        >
          {/*
            Grouped by cost tier rather than listed flat. A flat list puts a
            $0.40/second model next to a free one with nothing to distinguish
            them, which is how a user spends $3 by accident.
          */}
          {TIER_ORDER.map((tier) => {
            const group = forModality.filter((p) => p.tier === tier);
            if (group.length === 0) return null;
            return (
              <optgroup key={tier} label={TIER_GROUP_LABELS[tier]}>
                {group.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                    {p.priceRange ? ` — ${p.priceRange}` : ''}
                    {p.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <TierBadge tier={provider.tier} />
          {provider.priceRange ? (
            <span className="text-xs text-slate-400">{provider.priceRange}</span>
          ) : null}
        </div>

        {!provider.available && provider.unavailableReason ? (
          <p className="mt-1.5 text-xs text-amber-400">{provider.unavailableReason}</p>
        ) : null}
        {provider.notes ? (
          <p className="mt-1.5 text-xs text-slate-500">{provider.notes}</p>
        ) : null}
      </div>

      {/* model */}
      {provider.models.length > 1 ? (
        <div>
          <label className="field-label" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Default</option>
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.price ? ` — ${m.price}` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* prompt */}
      <div>
        <label className="field-label" htmlFor="prompt">
          Prompt
        </label>
        <textarea
          id="prompt"
          className="input min-h-[104px] resize-y"
          value={prompt}
          placeholder="Describe what to generate…"
          onChange={(e) => onPromptChange(e.target.value)}
          aria-describedby={guidance ? 'prompt-guidance' : undefined}
        />

        <div className="mt-1.5 flex items-start justify-between gap-3">
          {shotOptionIds.length > 0 ? (
            <p className="text-[11px] text-brand-cyan">
              +{shotOptionIds.length} shot term{shotOptionIds.length === 1 ? '' : 's'} appended
              at render time
            </p>
          ) : (
            <span />
          )}
          {guidance ? (
            <p
              className={`shrink-0 text-[11px] ${
                prompt.length > guidance.maxLength ? 'text-amber-400' : 'text-slate-600'
              }`}
            >
              {prompt.length}/{guidance.maxLength}
            </p>
          ) : null}
        </div>

        {guidance ? (
          <details id="prompt-guidance" className="mt-2">
            <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300">
              Prompting tips for this model
            </summary>
            <p className="mt-1.5 text-[11px] leading-snug text-slate-500">{guidance.summary}</p>
            <ul className="mt-1.5 space-y-1">
              {guidance.tips.map((tip) => (
                <li key={tip} className="text-[11px] leading-snug text-slate-500">
                  · {tip}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {provider.supportsNegativePrompt ? (
        <div>
          <label className="field-label" htmlFor="negative">
            Negative prompt
          </label>
          <input
            id="negative"
            className="input"
            value={negativePrompt}
            placeholder="What to avoid"
            onChange={(e) => setNegativePrompt(e.target.value)}
          />
        </div>
      ) : null}

      {/* source image */}
      {provider.requiresSourceImage || modality !== 'image' ? (
        <div>
          <label className="field-label" htmlFor="source">
            Source image {provider.requiresSourceImage ? '(required)' : '(optional)'}
          </label>
          <div className="flex gap-2">
            <input
              id="source"
              className="input"
              value={sourceImage}
              placeholder="/media/… or https://…"
              onChange={(e) => onSourceImageChange(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
          {sourceImage ? (
            <img
              src={sourceImage}
              alt="Selected source"
              className="mt-2 h-24 w-24 rounded border border-ink-700 object-cover"
            />
          ) : null}
          {uploadError ? (
            <div className="mt-2">
              <ErrorNote message={uploadError} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* aspect + seed + duration */}
      <div className="grid grid-cols-2 gap-3">
        {modality !== 'model3d' ? (
          <div>
            <label className="field-label" htmlFor="aspect">
              Aspect
            </label>
            <select
              id="aspect"
              className="input"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            >
              {provider.supportedAspectRatios.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {provider.supportsSeed ? (
          <div>
            <label className="field-label" htmlFor="seed">
              Seed
            </label>
            <input
              id="seed"
              className="input"
              inputMode="numeric"
              value={seed}
              placeholder="random"
              onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ) : null}

        {modality === 'video' ? (
          <div>
            <label className="field-label" htmlFor="duration">
              Duration (s)
            </label>
            <input
              id="duration"
              className="input"
              inputMode="numeric"
              value={duration}
              placeholder="provider default"
              onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        ) : null}

        {/*
          Resolution is capability-driven like every other field: only providers
          that advertise supportedResolutions get the control. On Veo the step
          from 1080p to 4K is 2x the bill, so it cannot be an invisible default.
        */}
        {provider.supportedResolutions && provider.supportedResolutions.length > 0 ? (
          <div>
            <label className="field-label" htmlFor="resolution">
              Resolution
            </label>
            <select
              id="resolution"
              className="input"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as Resolution | '')}
            >
              <option value="">Provider default (cheapest)</option>
              {provider.supportedResolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {/*
        Audio is opt-in, never a default. Veo 3.1 charges $0.20/s silent and
        $0.40/s with audio for the same clip, so a checked-by-default box would
        silently double every bill.
      */}
      {provider.producesAudio ? (
        <div className="flex items-start gap-2">
          <input
            id="audio"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-ink-600 bg-ink-850 accent-brand-cyan"
            checked={generateAudio}
            onChange={(e) => setGenerateAudio(e.target.checked)}
          />
          <label htmlFor="audio" className="text-xs leading-snug text-slate-300">
            Generate audio
            <span className="block text-[11px] text-slate-500">
              Off by default. Audio raises the per-second price — see the model
              price above.
            </span>
          </label>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-xs text-slate-500">
          {provider.typicalLatency ? `typical: ${provider.typicalLatency}` : ''}
        </p>
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </form>
  );
}

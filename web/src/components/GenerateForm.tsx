/**
 * Generation form.
 *
 * Fields render conditionally from the selected provider's capability
 * descriptor, so a provider that does not support seeds simply has no seed
 * input instead of silently ignoring it. That rule is what keeps this file from
 * turning into a switch on provider id as the registry grows: an upscaler hides
 * the prompt because it says `ignoresPrompt`, not because the form knows what an
 * upscaler is.
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
  /** Controlled by App so the gallery can hand a clip to an upscaler. */
  sourceVideo: string;
  onSourceVideoChange: (url: string) => void;
  /** Controlled by App so the gallery can hand a track to Scribe. */
  sourceAudio: string;
  onSourceAudioChange: (url: string) => void;
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

/** Images stay small; audio and video are allowed to be much larger. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** Cheapest first, so the expensive group is never what the eye lands on. */
const TIER_ORDER: ProviderTier[] = ['free', 'standard', 'premium'];

const TIER_GROUP_LABELS: Record<ProviderTier, string> = {
  free: 'Free — no credentials, no bill',
  standard: 'Paid — cents per render',
  premium: 'Premium — dollars per render',
};

type MediaKind = 'image' | 'audio' | 'video';

export function GenerateForm({
  modality,
  providers,
  busy,
  sourceImage,
  onSourceImageChange,
  sourceVideo,
  onSourceVideoChange,
  sourceAudio,
  onSourceAudioChange,
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
  const [voice, setVoice] = useState('');
  // One LoRA reference per line, so pasting a HuggingFace id is trivial.
  const [loraText, setLoraText] = useState('');
  const [referenceText, setReferenceText] = useState('');
  // Audio defaults OFF: on Veo 3.1 it doubles the bill, so it must be opted into.
  const [generateAudio, setGenerateAudio] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadingKind, setUploadingKind] = useState<MediaKind | ''>('');

  const imageInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  /**
   * Upload a local file and route the resulting URL to the right field.
   *
   * One handler for all three kinds rather than three near-copies: the only
   * differences are the accepted mime prefix, the size cap, and where the URL
   * lands, so they are parameters.
   */
  const handleFile = useCallback(
    async (file: File, kind: MediaKind) => {
      setUploadError('');
      if (!file.type.startsWith(`${kind}/`)) {
        setUploadError(`Expected ${kind === 'image' ? 'an' : 'a'} ${kind} file, got ${file.type || 'an unknown type'}.`);
        return;
      }
      const cap = kind === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
      if (file.size > cap) {
        setUploadError(
          `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${cap / 1024 / 1024} MB).`,
        );
        return;
      }

      setUploadingKind(kind);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('could not read the file'));
          reader.readAsDataURL(file);
        });
        const { url } = await uploadImage(dataUrl, file.name);
        if (kind === 'image') onSourceImageChange(url);
        else if (kind === 'audio') onSourceAudioChange(url);
        else onSourceVideoChange(url);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'upload failed');
      } finally {
        setUploadingKind('');
      }
    },
    [onSourceImageChange, onSourceAudioChange, onSourceVideoChange],
  );

  // Report the effective provider upward. This has to be an effect, not just an
  // onChange handler: switching modality tabs changes the provider without any
  // interaction with the select.
  useEffect(() => {
    if (provider?.id) onProviderChange(provider.id);
  }, [provider?.id, onProviderChange]);

  const uploading = uploadingKind !== '';

  /**
   * A prompt is required unless the provider ignores it, and each declared source
   * requirement must be satisfied. Scribe and Audio Isolation accept audio OR
   * video, which is why `requiresSourceAudio` checks both.
   */
  const promptSatisfied = Boolean(provider?.ignoresPrompt) || prompt.trim().length > 0;
  const sourcesSatisfied =
    (!provider?.requiresSourceImage || sourceImage.length > 0) &&
    (!provider?.requiresSourceAudio || sourceAudio.length > 0 || sourceVideo.length > 0) &&
    (!provider?.requiresSourceVideo || sourceVideo.length > 0);

  const canSubmit =
    !busy && !uploading && Boolean(provider?.available) && promptSatisfied && sourcesSatisfied;

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
    // Audio has no geometry, and 3D output is not framed — skip both.
    if (
      provider.supportedAspectRatios.includes(aspectRatio) &&
      modality !== 'model3d' &&
      modality !== 'audio'
    ) {
      payload.aspectRatio = aspectRatio;
    }
    if (provider.supportsSeed && seed.trim()) {
      const n = Number.parseInt(seed, 10);
      if (Number.isFinite(n) && n >= 0) payload.seed = n;
    }
    if (model) payload.model = model;
    if (sourceImage) payload.sourceImage = sourceImage;
    if (sourceAudio) payload.sourceAudio = sourceAudio;
    if (sourceVideo) payload.sourceVideo = sourceVideo;
    // Duration means something for audio too (music length, effect length).
    if ((modality === 'video' || modality === 'audio') && duration.trim()) {
      const d = Number.parseInt(duration, 10);
      if (Number.isFinite(d) && d > 0) payload.durationSeconds = d;
    }
    if (resolution) payload.resolution = resolution;
    if (provider.voices && voice) payload.voice = voice;
    if (provider.supportsLoras) {
      const loras = loraText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (loras.length > 0) payload.loras = loras;
    }
    if (provider.supportsReferenceImages) {
      const refs = referenceText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (refs.length > 0) payload.referenceImages = refs;
    }
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

  /** Shared markup for the three source-file rows. */
  const sourceRow = (
    kind: MediaKind,
    value: string,
    onChange: (v: string) => void,
    ref: React.RefObject<HTMLInputElement>,
    required: boolean,
    hint: string,
  ) => (
    <div>
      <label className="field-label" htmlFor={`source-${kind}`}>
        Source {kind} {required ? '(required)' : '(optional)'}
      </label>
      <div className="flex gap-2">
        <input
          id={`source-${kind}`}
          className="input"
          value={value}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn-ghost whitespace-nowrap"
          disabled={uploading}
          onClick={() => ref.current?.click()}
        >
          {uploadingKind === kind ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      <input
        ref={ref}
        type="file"
        accept={`${kind}/*`}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file, kind);
          e.target.value = '';
        }}
      />
      {value && kind === 'image' ? (
        <img
          src={value}
          alt="Selected source"
          className="mt-2 h-24 w-24 rounded border border-ink-700 object-cover"
        />
      ) : null}
      {value && kind === 'audio' ? (
        <audio src={value} controls className="mt-2 w-full" aria-label="Selected source audio" />
      ) : null}
      {value && kind === 'video' ? (
        <video
          src={value}
          controls
          playsInline
          className="mt-2 max-h-40 w-full rounded border border-ink-700"
          aria-label="Selected source video"
        />
      ) : null}
    </div>
  );

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
            setVoice('');
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

      {/*
        prompt — hidden entirely when the provider ignores it. An upscaler with a
        prompt box invites the user to type something that will be silently
        discarded, which is worse than no box.
      */}
      {provider.ignoresPrompt ? (
        <p className="rounded border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-slate-400">
          This provider takes no prompt — it processes the source file you give it.
        </p>
      ) : (
        <div>
          <label className="field-label" htmlFor="prompt">
            {modality === 'audio' ? 'Text / description' : 'Prompt'}
          </label>
          <textarea
            id="prompt"
            className="input min-h-[104px] resize-y"
            value={prompt}
            placeholder={
              modality === 'audio'
                ? 'What to say, or the music/effect to generate…'
                : 'Describe what to generate…'
            }
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
      )}

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

      {/* voice picker — only when the provider advertises voices */}
      {provider.voices && provider.voices.length > 0 ? (
        <div>
          <label className="field-label" htmlFor="voice">
            Voice
          </label>
          <select
            id="voice"
            className="input"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          >
            <option value="">Provider default</option>
            {provider.voices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/*
        source files — each rendered only when the provider can use it.

        The image row also appears for ordinary video and 3D providers, because
        image→video and image→3D are the common paths there. It is suppressed for
        the upscalers: a provider that requires a video has no use for a still,
        and offering the field invites the user to fill in something ignored.
      */}
      {provider.requiresSourceImage ||
      provider.supportsReferenceImages ||
      ((modality === 'video' || modality === 'model3d') &&
        !provider.requiresSourceVideo &&
        !provider.requiresSourceAudio)
        ? sourceRow(
            'image',
            sourceImage,
            onSourceImageChange,
            imageInput,
            provider.requiresSourceImage,
            '/media/… or https://…',
          )
        : null}

      {provider.requiresSourceAudio
        ? sourceRow(
            'audio',
            sourceAudio,
            onSourceAudioChange,
            audioInput,
            // Scribe and Isolation accept either, so audio alone is not mandatory
            // when a video has been supplied.
            !sourceVideo,
            '/media/….mp3 or https://…',
          )
        : null}

      {provider.requiresSourceVideo || provider.requiresSourceAudio
        ? sourceRow(
            'video',
            sourceVideo,
            onSourceVideoChange,
            videoInput,
            Boolean(provider.requiresSourceVideo),
            '/media/….mp4 or https://…',
          )
        : null}

      {uploadError ? <ErrorNote message={uploadError} /> : null}

      {/* LoRA weights — Krea 2 only */}
      {provider.supportsLoras ? (
        <div>
          <label className="field-label" htmlFor="loras">
            LoRA weights (one per line)
          </label>
          <textarea
            id="loras"
            className="input min-h-[64px] resize-y font-mono text-xs"
            value={loraText}
            placeholder={'owner/repo\nhttps://host/style.safetensors:0.8'}
            onChange={(e) => setLoraText(e.target.value)}
            aria-describedby="loras-hint"
          />
          <p id="loras-hint" className="mt-1 text-[11px] text-slate-500">
            A HuggingFace repo id or a .safetensors URL. Append <code>:scale</code> (0–4) to
            weaken or strengthen it; the default is 1.
          </p>
        </div>
      ) : null}

      {/* style references — Krea 2 Style and Krea 2 Large */}
      {provider.supportsReferenceImages ? (
        <div>
          <label className="field-label" htmlFor="references">
            Style reference images (one URL per line)
          </label>
          <textarea
            id="references"
            className="input min-h-[52px] resize-y font-mono text-xs"
            value={referenceText}
            placeholder={'/media/2026-08-02/abc.png\nhttps://…'}
            onChange={(e) => setReferenceText(e.target.value)}
            aria-describedby="references-hint"
          />
          <p id="references-hint" className="mt-1 text-[11px] text-slate-500">
            These steer the look rather than being edited. Leave blank to use the source image
            above, if any.
          </p>
        </div>
      ) : null}

      {/* aspect + seed + duration + resolution */}
      <div className="grid grid-cols-2 gap-3">
        {modality !== 'model3d' &&
        modality !== 'audio' &&
        provider.supportedAspectRatios.length > 0 ? (
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

        {/* Duration applies to video AND audio (music length, effect length). */}
        {(modality === 'video' || modality === 'audio') && !provider.ignoresPrompt ? (
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
          Duration on an upscaler is not a request — it is what the cost quote is
          computed from, since the clip's real length is unknown until upload.
        */}
        {provider.ignoresPrompt && provider.requiresSourceVideo ? (
          <div>
            <label className="field-label" htmlFor="duration">
              Clip length (s)
            </label>
            <input
              id="duration"
              className="input"
              inputMode="numeric"
              value={duration}
              placeholder="for the cost estimate"
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

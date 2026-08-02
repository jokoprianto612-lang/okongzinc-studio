/**
 * Root layout: modality tabs on the left with the form, active job and gallery
 * on the right. Dark flat surfaces, no glassmorphism.
 */

import { useCallback, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { GenerateForm } from './components/GenerateForm';
import { Gallery } from './components/Gallery';
import { ReachPanel } from './components/ReachPanel';
import { ShotComposer } from './components/ShotComposer';
import { PromptStudio } from './components/PromptStudio';
import { ArtifactViewer } from './components/ArtifactViewer';
import { EmptyState, ErrorNote, ProgressBar, StatusBadge } from './components/Primitives';
import { useJobPolling } from './hooks/useJobPolling';
import {
  cancelJob,
  fetchGuidance,
  fetchHealth,
  fetchJobs,
  fetchProviders,
  submitGeneration,
} from './lib/api';
import {
  MODALITY_LABELS,
  isTerminal,
  type GenerateRequest,
  type Job,
  type Modality,
  type PromptGuidance,
  type PromptStudioInfo,
  type ProviderInfo,
} from './lib/types';

const MODALITIES: Modality[] = ['image', 'video', 'model3d', 'audio'];

export function App() {
  const [modality, setModality] = useState<Modality>('image');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sourceImage, setSourceImage] = useState('');
  const [sourceVideo, setSourceVideo] = useState('');
  const [sourceAudio, setSourceAudio] = useState('');
  const [endImage, setEndImage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [reachBackend, setReachBackend] = useState<string | undefined>(undefined);
  const [shotOptionIds, setShotOptionIds] = useState<string[]>([]);
  const [guidance, setGuidance] = useState<PromptGuidance[]>([]);
  const [promptStudio, setPromptStudio] = useState<PromptStudioInfo | null>(null);
  // Which provider the form has selected, so guidance can follow it.
  const [activeProviderId, setActiveProviderId] = useState<string>('');

  const refreshHistory = useCallback(async () => {
    try {
      const { jobs } = await fetchJobs(60);
      setHistory(jobs);
    } catch {
      // Non-fatal: the gallery just stays stale.
    }
  }, []);

  const { job: activeJob, setJob: setActiveJob } = useJobPolling(null, () => {
    void refreshHistory();
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [{ providers: list }, health, guide] = await Promise.all([
          fetchProviders(),
          fetchHealth().catch(() => null),
          fetchGuidance().catch(() => null),
          refreshHistory(),
        ]);
        if (!alive) return;
        setProviders(list);
        if (health?.reach?.enabled) setReachBackend(health.reach.backend);
        if (guide?.guidance) setGuidance(guide.guidance);
        if (guide?.promptStudio) setPromptStudio(guide.promptStudio);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'could not reach the API');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshHistory]);

  const handleSubmit = async (payload: GenerateRequest) => {
    setError('');
    try {
      const { job } = await submitGeneration(payload);
      setActiveJob(job);
      void refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'generation failed to start');
    }
  };

  const handleCancel = async () => {
    if (!activeJob) return;
    try {
      const { job } = await cancelJob(activeJob.id);
      setActiveJob(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'cancel failed');
    }
  };

  /**
   * "Use as source" from the gallery: load the artifact into the matching field
   * and switch to a modality that consumes it, so the click has a visible effect
   * instead of silently setting a field on a hidden tab.
   *
   * Each reuse target picks the tab where an available provider can actually take
   * that input — sending the user to a tab whose providers are all disabled would
   * be a dead end.
   */
  const hasAvailable = useCallback(
    (predicate: (p: ProviderInfo) => boolean) => providers.some((p) => p.available && predicate(p)),
    [providers],
  );

  const handleReuseImage = useCallback(
    (mediaUrl: string) => {
      setSourceImage(mediaUrl);
      const has3d = hasAvailable((p) => p.modality === 'model3d');
      const hasVideo = hasAvailable((p) => p.modality === 'video');
      setModality(has3d ? 'model3d' : hasVideo ? 'video' : 'image');
    },
    [hasAvailable],
  );

  const handleReuseVideo = useCallback(
    (mediaUrl: string) => {
      setSourceVideo(mediaUrl);
      // An upscaler lives in video; transcription lives in audio. Prefer the
      // upscaler, since that is the usual next step after generating a clip.
      const hasUpscaler = hasAvailable((p) => p.modality === 'video' && Boolean(p.requiresSourceVideo));
      setModality(hasUpscaler ? 'video' : 'audio');
    },
    [hasAvailable],
  );

  const handleReuseAudio = useCallback(
    (mediaUrl: string) => {
      setSourceAudio(mediaUrl);
      setModality('audio');
    },
    [],
  );

  const busy = Boolean(activeJob && !isTerminal(activeJob.status));

  /**
   * Whether the selected provider takes a prompt at all. Drives hiding the prompt
   * studio for upscalers and transcription — same capability flag the form uses to
   * hide the prompt box itself.
   */
  const activeProviderIgnoresPrompt = Boolean(
    providers.find((p) => p.id === activeProviderId)?.ignoresPrompt,
  );

  return (
    <div className="min-h-screen">
      <Header />

      <nav className="border-b border-ink-700 bg-ink-900" aria-label="Modality">
        <div className="mx-auto flex max-w-7xl gap-1 px-4">
          {MODALITIES.map((m) => {
            const count = providers.filter((p) => p.modality === m && p.available).length;
            return (
              <button
                key={m}
                type="button"
                aria-current={modality === m ? 'page' : undefined}
                className={modality === m ? 'tab-active' : 'tab-idle'}
                onClick={() => setModality(m)}
              >
                {MODALITY_LABELS[m]}
                <span className="ml-1.5 text-[11px] text-slate-500">{count}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[380px_1fr]">
        <section aria-label="Generation settings" className="space-y-3">
          {error ? <ErrorNote message={error} /> : null}
          {loading ? (
            <div className="panel">
              <EmptyState title="Loading providers…" />
            </div>
          ) : (
            <GenerateForm
              modality={modality}
              providers={providers}
              busy={busy}
              sourceImage={sourceImage}
              onSourceImageChange={setSourceImage}
              sourceVideo={sourceVideo}
              onSourceVideoChange={setSourceVideo}
              sourceAudio={sourceAudio}
              onSourceAudioChange={setSourceAudio}
              endImage={endImage}
              onEndImageChange={setEndImage}
              prompt={prompt}
              onPromptChange={setPrompt}
              shotOptionIds={shotOptionIds}
              guidance={guidance.find((g) => g.providerId === activeProviderId)}
              onProviderChange={setActiveProviderId}
              onSubmit={(p) => void handleSubmit(p)}
            />
          )}

          {/*
            The prompt studio applies wherever there IS a prompt. It is hidden for
            the upscalers and transcription, which take none — enhancing a prompt
            that gets discarded would be theatre.
          */}
          {promptStudio && !activeProviderIgnoresPrompt ? (
            <PromptStudio
              studio={promptStudio}
              prompt={prompt}
              onPromptChange={setPrompt}
              providerId={activeProviderId}
            />
          ) : null}

          {/*
            The shot composer is cinematography vocabulary, so it only makes sense
            for image and video. Showing it under a transcription form would be
            noise.
          */}
          {modality === 'image' || modality === 'video' ? (
            <ShotComposer selected={shotOptionIds} onChange={setShotOptionIds} />
          ) : null}

          {reachBackend ? (
            <ReachPanel
              backend={reachBackend}
              onAppendToPrompt={(text) =>
                setPrompt((current) => (current ? `${current}\n\n${text}` : text))
              }
            />
          ) : null}
        </section>

        <section aria-label="Results" className="space-y-4">
          {activeJob ? (
            <div className="panel space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <StatusBadge status={activeJob.status} />
                  <span className="font-mono text-xs text-slate-500">{activeJob.provider}</span>
                </div>
                {!isTerminal(activeJob.status) ? (
                  <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" onClick={() => void handleCancel()}>
                    Cancel
                  </button>
                ) : null}
              </div>

              {!isTerminal(activeJob.status) ? <ProgressBar note={activeJob.progressNote} /> : null}
              {activeJob.error ? <ErrorNote message={activeJob.error} /> : null}

              {activeJob.artifacts.map((artifact) => (
                <ArtifactViewer key={artifact.url} artifact={artifact} modality={activeJob.modality} />
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">History</h2>
            <Gallery
              jobs={history}
              onReuseImage={handleReuseImage}
              onReuseVideo={handleReuseVideo}
              onReuseAudio={handleReuseAudio}
            />
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-700 px-4 py-4 text-center text-[11px] text-slate-600">
        OkongzINC Studio · self-hosted · MIT
      </footer>
    </div>
  );
}

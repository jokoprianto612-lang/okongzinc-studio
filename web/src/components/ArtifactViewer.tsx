/**
 * Renders a finished artifact by media type: <img> for images, <video> for
 * video, and a download card for .glb meshes (a full 3D viewer would drag in
 * three.js for a feature the studio does not otherwise need).
 */

import type { Artifact, Modality } from '../lib/types';
import { formatBytes } from './Primitives';

export function ArtifactViewer({
  artifact,
  modality,
}: {
  artifact: Artifact;
  modality: Modality;
}) {
  const isVideo = artifact.mimeType.startsWith('video/');
  const isImage = artifact.mimeType.startsWith('image/');

  return (
    <figure className="space-y-2">
      <div className="overflow-hidden rounded-md border border-ink-700 bg-ink-850">
        {isImage ? (
          <img
            src={artifact.url}
            alt="Generated result"
            className="block h-auto w-full"
            loading="lazy"
          />
        ) : isVideo ? (
          <video
            src={artifact.url}
            controls
            playsInline
            className="block h-auto w-full"
            aria-label="Generated video"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-sm font-medium text-slate-300">
              {modality === 'model3d' ? '3D mesh (.glb)' : 'Binary artifact'}
            </p>
            <p className="text-xs text-slate-500">
              Open in Blender, Windows 3D Viewer, or any glTF viewer.
            </p>
          </div>
        )}
      </div>

      <figcaption className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="font-mono">
          {artifact.width && artifact.height ? `${artifact.width}×${artifact.height} · ` : ''}
          {formatBytes(artifact.bytes)}
        </span>
        <a href={artifact.url} download className="btn-ghost !px-2.5 !py-1 !text-xs">
          Download
        </a>
      </figcaption>
    </figure>
  );
}

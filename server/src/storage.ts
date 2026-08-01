/**
 * Filesystem storage for generated artifacts.
 *
 * Files land in `storage/<YYYY-MM-DD>/<id>.<ext>` and are served read-only at
 * `/media/<YYYY-MM-DD>/<id>.<ext>`. Date bucketing keeps directories small
 * enough to list on Windows without pain.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { Artifact } from './types.js';

/** Maps a mime type to a file extension. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'model/gltf-binary': 'glb',
  'application/octet-stream': 'bin',
};

function extensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? 'bin';
}

function dateBucket(): string {
  // ISO date in UTC — stable regardless of the host timezone.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Persist a binary payload and return the artifact descriptor.
 *
 * @param data      Raw file bytes.
 * @param mimeType  Content type used to pick the extension.
 */
export async function saveArtifact(
  data: Uint8Array,
  mimeType: string,
  meta: { width?: number; height?: number } = {},
): Promise<Artifact> {
  const bucket = dateBucket();
  const dir = path.join(config.storageDir, bucket);
  await fs.mkdir(dir, { recursive: true });

  const filename = `${randomUUID()}.${extensionFor(mimeType)}`;
  const absolutePath = path.join(dir, filename);
  await fs.writeFile(absolutePath, data);

  return {
    url: `/media/${bucket}/${filename}`,
    absolutePath,
    mimeType,
    bytes: data.byteLength,
    ...meta,
  };
}

/**
 * Resolve a public `/media/...` URL back to an absolute path, refusing any
 * path that escapes the storage root (path traversal guard).
 */
export function resolveMediaPath(mediaUrl: string): string | null {
  const prefix = '/media/';
  if (!mediaUrl.startsWith(prefix)) return null;

  const relative = mediaUrl.slice(prefix.length);
  const absolute = path.resolve(config.storageDir, relative);
  const root = path.resolve(config.storageDir);

  // Must stay inside storageDir. Compare with a trailing separator so
  // `/storage-evil` cannot pass as a child of `/storage`.
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

/** Read a source image that may be a remote URL or a local /media path. */
export async function readSourceImage(
  source: string,
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`failed to fetch source image (HTTP ${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return { data: buf, mimeType: res.headers.get('content-type') ?? 'image/jpeg' };
  }

  const absolute = resolveMediaPath(source);
  if (!absolute) {
    throw new Error(`sourceImage must be an http(s) URL or a /media/... path`);
  }
  const data = new Uint8Array(await fs.readFile(absolute));
  const ext = path.extname(absolute).slice(1).toLowerCase();
  const mimeType =
    ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { data, mimeType };
}

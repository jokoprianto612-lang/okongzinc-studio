# Architecture

## Shape

```
┌─────────────────────────────────────────────────────────────┐
│  web/  Vite + React + TS + Tailwind                         │
│                                                             │
│  App.tsx ── tabs (Image | Video | 3D)                       │
│    ├── GenerateForm    renders from provider capabilities    │
│    ├── ArtifactViewer  img / video / glb download            │
│    ├── Gallery         history, "Use as source"              │
│    └── useJobPolling   polls /api/jobs/:id every 2s           │
└──────────────────────────┬──────────────────────────────────┘
                           │ fetch (relative paths)
┌──────────────────────────▼──────────────────────────────────┐
│  server/  Express + TS                                      │
│                                                             │
│  index.ts      routes · CORS · static SPA · shutdown        │
│  validation.ts zod — nothing invalid reaches a provider      │
│  jobQueue.ts   in-memory queue, concurrency cap, cancel      │
│  storage.ts    artifacts on disk + traversal guard           │
│  config.ts     env read exactly once                         │
│                                                             │
│  providers/                                                  │
│    pollinations   free image, no key      (default)          │
│    google         Gemini image + Veo video                   │
│    openaiImage    any /v1/images/generations endpoint        │
│    modalTrellis   image → 3D, calls Modal                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS
              ┌────────────▼─────────────┐
              │ Modal: A100 GPU          │
              │ microsoft/TRELLIS.2      │
              │ (≥24 GB VRAM required)   │
              └──────────────────────────┘
```

## Decisions and why

### A provider interface instead of per-backend routes

Each backend has a different API shape: Pollinations returns image bytes from a
GET, Gemini returns inline base64 from a POST, Veo needs an operation polled to
completion, TRELLIS.2 is a custom worker. Without a common interface, that
variety leaks into the routes and the UI, and every new backend touches five
files.

`Provider` collapses it to one method plus a capability descriptor. The route
handler does not know which backend it is calling, and the UI renders its form
from the descriptor. Adding a backend is one new file and one array entry.

### Capability descriptors, not feature flags

The UI could hardcode "show a seed field for Pollinations". Instead the provider
declares `supportsSeed: true` and the form reacts. This keeps the two sides from
drifting: a provider that stops supporting seeds flips one boolean and the input
disappears.

It also makes unavailability honest. `availability()` returns
`{ available: false, reason: 'GOOGLE_API_KEY is not set' }`, and that exact
string appears in the UI. Nothing is silently hidden and nothing silently falls
back to a different backend.

### A queue, not inline execution

Generation takes 3 seconds (Pollinations) to 5 minutes (Veo) to longer
(TRELLIS.2 cold start). Running that inside the request would tie up a
connection, break on any client timeout, and let a user trivially exceed a
provider's rate limit.

`POST /api/generate` returns `202` with a job id. `MAX_CONCURRENT_JOBS` bounds
parallelism. Each running job gets an `AbortController`, so cancel and shutdown
both interrupt real in-flight HTTP requests rather than orphaning them.

### Polling, not websockets

Clients poll `/api/jobs/:id` every 2 seconds. A socket would push updates a
second sooner and cost a stateful connection, a reconnect strategy, and a
heartbeat. Polling survives a page reload, a dev-server restart, and a laptop
that slept mid-generation — all of which happen constantly in practice. The
server stays stateless per request.

### In-memory job history

Jobs live in a `Map` capped at 200 entries; artifacts live on disk. Restarting
the server clears the list but loses no files.

This is a real tradeoff, taken deliberately: a single-user studio does not need
a database, and adding SQLite would mean migrations, a schema, and a second
source of truth for something the filesystem already holds. If history must
survive restarts, `jobQueue.ts` is the only file that changes.

### Files on disk, date-bucketed

`storage/<YYYY-MM-DD>/<uuid>.<ext>`, served read-only at `/media/...`. Date
buckets keep directories small enough to list without pain on Windows. UUID
names avoid collisions and stop a prompt from becoming a filename.

`resolveMediaPath()` refuses any path that escapes the storage root, and the
comparison appends a separator so `/storage-evil` cannot masquerade as a child
of `/storage`.

### TRELLIS.2 runs on Modal, not locally

Upstream states TRELLIS.2 needs an NVIDIA GPU with ≥24 GB VRAM, verified on
A100/H100 with CUDA 12.4, and compiles CUDA extensions at install time. That is
not a laptop workload.

The Modal worker keeps the heavy dependency out of the studio entirely: the
Node server speaks plain JSON to an HTTP endpoint and never imports torch. The
provider is simply unavailable until `MODAL_TRELLIS_URL` is set, which is the
same mechanism every other optional provider uses.

`scaledown_window=300` keeps the container warm briefly so consecutive
generations skip the cold start, then it shuts down and stops billing.

### Security posture

- **`API_KEY` is optional but loudly absent.** Blank means unauthenticated,
  which is right for localhost and wrong anywhere else. The server prints a
  warning on every boot while it is blank rather than failing closed and
  blocking local development.
- **CORS allows same-host origins.** Vite's `crossorigin` module script makes
  the app's own bundle a CORS request whose `Origin` is the server itself. The
  middleware uses the request-aware delegate form so the SPA can load its own
  assets; a plain allowlist silently produced a blank page.
- **Uploads are validated.** Data URLs only, `image/*` only, decoded size
  checked before writing.
- **Source images are constrained by schema.** `sourceImage` must be an
  `http(s)` URL or a `/media/...` path with no `..`, enforced in zod before any
  provider sees it. A provider cannot be tricked into reading an arbitrary file.

## Request lifecycle

```
POST /api/generate
  ├─ zod validates the body                         → 400 with field issues
  ├─ provider exists?                               → 400
  ├─ provider.modality matches request.modality?     → 400
  ├─ provider.availability().available?              → 503 with the reason
  ├─ requiresSourceImage satisfied?                  → 400
  └─ createJob() → queued → 202 { job }

queue pump (≤ MAX_CONCURRENT_JOBS)
  ├─ status → running, AbortController attached
  ├─ provider.generate(req, { onProgress, signal })
  │    └─ ctx.onProgress(note) → visible via GET /api/jobs/:id
  ├─ artifacts → saveArtifact() → storage/
  └─ status → succeeded | failed | cancelled

GET /api/jobs/:id  (client polls every 2s until terminal)
```

## Adding a provider

```ts
// server/src/providers/example.ts
import { saveArtifact } from '../storage.js';
import { fetchWithTimeout, ProviderError, type Provider } from './types.js';

export const exampleProvider: Provider = {
  id: 'example',
  label: 'Example',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9'],
  models: [{ id: 'default', label: 'Default' }],
  typicalLatency: '5-15s',

  availability() {
    return config.example.apiKey
      ? { available: true }
      : { available: false, reason: 'EXAMPLE_API_KEY is not set' };
  },

  async generate(req, ctx) {
    ctx.onProgress('calling example');
    const res = await fetchWithTimeout(url, { method: 'POST', timeoutMs: 120_000 }, ctx.signal);
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, 502);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return [await saveArtifact(bytes, 'image/png')];
  },
};
```

Then: add the config block to `config.ts`, add the key to `.env.example`, and
append the provider to `ALL_PROVIDERS` in `providers/index.ts`. The UI needs no
changes.

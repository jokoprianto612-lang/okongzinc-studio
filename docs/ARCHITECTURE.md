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
│  reach.ts      URL → markdown (NOT a provider — see below)   │
│  shotVocabulary.ts  118 terms + composePrompt()              │
│  promptGuidance.ts  per-model prompting tips                 │
│                                                             │
│  providers/                    11 providers, 7 files         │
│    pollinations   image, no key            (image default)   │
│    falClient      shared queue/upload/error transport        │
│    fal            image + video + 3D, ONE key, 4 providers   │
│    falIdeogram    character consistency + masked edit        │
│    google         Gemini image + Veo video                   │
│    openaiImage    any /v1/images/generations endpoint        │
│    modalLongcat   video,  self-hosted        (optional)      │
│    modalTrellis   image → 3D, self-hosted    (optional)      │
└────────┬───────────────────┬──────────────────┬─────────────┘
         │ HTTPS             │ HTTPS            │ HTTPS
 ┌───────▼────────┐  ┌───────▼────────┐  ┌──────▼──────────┐
 │ fal.ai (queue) │  │ Modal: A100    │  │ Modal: H100     │
 │ LongCat video  │  │ TRELLIS.2      │  │ LongCat-Video   │
 │ Seedance 2.0   │  │ image → .glb   │  │ 13.6B, ~83 GB   │
 │ LongCat image  │  │ ≥24 GB VRAM    │  │ t2v/i2v/continue│
 │ TRELLIS-2      │  └────────────────┘  └─────────────────┘
 └────────────────┘     optional self-hosting, ~10× the cost

 Reach backends (text, not artifacts):
   agent-reach CLI (optional) → Twitter/Reddit/YouTube/Bilibili/XHS
   Jina Reader r.jina.ai      → any public URL, no key
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

### Two video providers, deliberately

Veo and LongCat-Video are not redundant — they occupy opposite ends of a real
tradeoff, and the studio exposes both rather than picking for you:

|  | Google Veo 3.1 | LongCat-Video 13.6B |
|---|---|---|
| Kind | hosted API | self-hosted open weights |
| Setup | paste a key | deploy a worker + 83 GB download |
| Cost | per-request quota | GPU-seconds, no ceiling |
| Speed | fast | minutes per clip |
| Content policy | the vendor's | yours |
| Continuation | not native | **pretrained on it** |

The last row is the interesting one. LongCat was pretrained on the
video-continuation task, so extending a clip does not accumulate the colour
drift that frame-chaining a t2v model produces. That is a capability the hosted
API does not offer at any price.

The provider interface makes carrying both nearly free: they are two files
implementing the same contract, and the UI renders whichever the user picks.

### Reach is an endpoint, not a provider

Every generation backend implements `Provider` and yields an `Artifact`. Reach
yields *text for a human to read*, so squeezing it into that interface would mean
inventing a fake modality and a fake artifact. It lives at `POST /api/reach`
instead.

Backend order is a deliberate fallback chain:

1. **agent-reach CLI** — when the binary is on PATH. Its value is the platforms a
   plain HTTP fetch cannot reach: authed Twitter timelines, Reddit comment
   threads, YouTube subtitles, Bilibili, XiaoHongShu. Each platform sits behind a
   primary + fallback backend list upstream, so a dead access path is their
   problem to re-route, not ours.
2. **Jina Reader** — no install, no key, any public URL. Verified returning
   markdown in 0.5–5s.

The probe result is cached: checking for a missing binary on every request is
pure latency. A failing agent-reach falls through rather than failing the
request, because its coverage is a bonus and Jina is the floor.

**Security.** This endpoint makes the server fetch a URL a client supplies, which
is textbook SSRF territory. Three constraints contain it:

- `assertPublicHttpUrl` rejects non-http(s) schemes and any private, loopback, or
  link-local host — including `169.254.169.254`, the cloud metadata address.
- The CLI is invoked through `execFile` with an argument **array**, never a shell
  string, so a URL cannot smuggle shell metacharacters.
- The response is treated as untrusted content end to end: displayed read-only,
  never executed, never auto-injected into a prompt. Appending to a prompt is an
  explicit click that takes the first 1,500 characters.

That last point is the one worth restating, because it is a policy and not a
mechanism: a fetched page containing "ignore your previous instructions" reaches
a human's eyes as text and nothing else. The studio never hands page content to a
model on its own initiative.

### Hosted and self-hosted, side by side

LongCat-Video and TRELLIS each ship twice: once through fal, once as a Modal
worker. That looks like duplication until you price it out.

|  | fal | Modal (self-hosted) |
|---|---|---|
| 6s 480p LongCat clip | ~$0.03 | ~$0.35 |
| Idle cost | none | ~$12/month volume storage |
| Cold start | none | minutes, billed |
| Setup | paste a key | deploy + 83 GB download |
| Weights | fal's | yours |
| Content gate | fal's | none |

fal wins on every axis except the last two, and those two are the entire reason
the Modal path stays. Someone who needs the weights under their own control, or
who cannot accept a third party's content policy, has a working option that costs
more. Everyone else pastes `FAL_KEY` and moves on.

The provider interface is what makes carrying both nearly free: they are separate
files implementing the same contract. `defaultProviderFor()` returns the first
*available* provider per modality, and the registry orders fal ahead of Modal, so
the cheap path is the default without any conditional logic.

### Schemas are read, not remembered

`fal.ts` covers four providers across three modalities, and every field in it was
taken from fal's live OpenAPI spec:

```
GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
```

This is a deliberate practice, not diligence theatre. Several fields are not what
a reasonable person would guess:

- LongCat video takes `num_frames` (17..961) plus `fps`, **not** a duration in
  seconds. 480p runs at 15fps, 720p at 30fps, so "6 seconds" is a different frame
  count per endpoint.
- Seedance takes `duration` as an **enum of stringified integers** — `'6'`, not
  `6` — and rejects a number outright.
- Every fal image input is `image_url`. There is no bytes upload on the generation
  endpoints, so a local `/media/...` artifact has to be pushed to fal storage
  first (two-step initiate → signed PUT). `resolveImageUrl` handles that and
  passes remote URLs straight through.
- TRELLIS-2 returns `model_glb`, and its `resolution` enum is `512|1024|1536`
  while `texture_size` is `1024|2048|4096` — two different scales, easy to swap.

A guessed field name produces a 422 that looks exactly like a bug in our own
code, which is the expensive kind of wrong.

### Everything goes through fal's queue

`queue.fal.run`, never the synchronous endpoint. Video generation runs for
minutes; a sync call would hit a timeout somewhere in the chain and lose work
that was already paid for. Submit returns `status_url` and `response_url` — poll
the first until `COMPLETED`, then read the second. Queue position is surfaced
through `ctx.onProgress()` so the UI can say "in queue (position 3)" instead of
spinning silently.

### Authoring aids are not providers

Three modules produce something other than an artifact, so none of them
implements `Provider`:

| Module | Produces | Endpoint |
|---|---|---|
| `reach.ts` | page text for a human to read | `POST /api/reach` |
| `shotVocabulary.ts` | cinematography terms + `composePrompt()` | `GET /api/shots` |
| `promptGuidance.ts` | per-model tips and length ceilings | `GET /api/guidance` |

Forcing any of them through the provider interface would mean inventing a fake
modality and a fake artifact. They get plain endpoints instead.

The two static ones are compiled into the server rather than fetched or stored in
a database. 118 shot terms is roughly 38 KB of TypeScript — small enough that a
build-time constant beats a table, and it cannot drift out of sync with the
`composePrompt()` that consumes it.

### Why composition happens on the server

The client sends `shotOptionIds`, not a pre-assembled prompt. `composePrompt()`
runs inside the `/api/generate` handler, before the job record is created.

This placement is the whole point. If the client concatenated the terms, the
stored job would hold whatever the client happened to build, and the two could
diverge — a UI change, a stale tab, a direct API call with different ids. What
gets stored has to be exactly what the provider received, or history shows a bare
idea ("a street at night") next to an elaborate render and there is no way to
explain the result.

Unknown ids are skipped rather than rejected. The vocabulary can change between a
client build and a server build, and a stale id in a bookmarked URL should
degrade gracefully instead of failing a paid generation.

Composition is concatenation, not rewriting: the base idea, then each selected
term's technical phrasing, joined with periods. An LLM rewrite would read better
but costs a call, adds latency, and makes output non-deterministic for a fixed
seed. Predictable and free wins here.

### The vocabulary needed cleaning, not just copying

The 118 terms come from `ilkerzg/awesome-video-prompts`, where descriptions were
truncated to 100 characters. That cut frequently landed mid-word
(`"mixed CCT s"`) and sometimes on a dangling preposition
(`"...controlled ambient, light haze for"`).

Appending either into a prompt produces broken English, so both cases are trimmed
at import: drop a trailing partial word, then drop any trailing function word.
57 of 118 needed it. Anyone re-importing from upstream has to redo this — it is
recorded in `CLAUDE.md` for that reason.

### One transport for five fal providers

`falClient.ts` holds the queue loop, the upload path, and the error translator.
The alternative — each provider carrying its own copy — was the original shape and
it was already duplicated four ways before Ideogram made it five.

The error translator earns its place by surfacing fal's `detail[].loc` on a 422.
A wrong field name is the most likely failure when integrating a new endpoint, and
`"loc: body.image_size → msg: extra fields not permitted"` is diagnosable where
`"HTTP 422"` is not.

The upload path exists because no fal generation endpoint accepts raw bytes —
every image input is `image_url`. A local `/media/...` artifact has to be pushed
to fal storage first (initiate → signed PUT), which is what makes "generate an
image, then use it as a video source" work at all.

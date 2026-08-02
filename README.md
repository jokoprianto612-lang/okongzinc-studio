<div align="center">

<img src="web/public/brand/logo.svg" alt="OkongzINC" width="440">

**Self-hosted generative media studio — image, video, and 3D behind one pluggable provider layer.**

[![build](https://img.shields.io/badge/build-passing-22d3ee?style=flat-square)](#verification)
[![license](https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-1f2430?style=flat-square)](https://nodejs.org)

</div>

---

## What this is

A studio you run yourself. One UI, one API, and a provider layer that turns
different generation backends into interchangeable options. Works out of the box
with **zero API keys** because the default image provider (Pollinations) needs
none — then scales up as you add credentials.

| Modality | Provider | Credential | Tier | Notes |
|---|---|---|---|---|
| Image | Pollinations (Flux / Turbo / Kontext) | none | free | works immediately |
| Image | LongCat-Image on fal | `FAL_KEY` | paid | cents per image |
| Image | Ideogram V3 Character on fal | `FAL_KEY` | paid | consistent faces across scenes |
| Image | Google Gemini Image | `GOOGLE_API_KEY` | paid | also image→image |
| Image | Any OpenAI-compatible endpoint | `OPENAI_API_KEY` | paid | bring your own gateway |
| Image | **FLUX.2 Pro** on fal | `FAL_KEY` + premium | premium | $0.03/MP — best prompt adherence |
| Image | **Nano Banana Pro** on fal | `FAL_KEY` + premium | premium | $0.15 — the only one that spells |
| Image | **Seedream 5.0 Pro** on fal | `FAL_KEY` + premium | premium | $0.0675 — cheapest premium |
| Image | **Ideogram V3** on fal | `FAL_KEY` + premium | premium | $0.03-$0.09 — posters, logos |
| Image | **Topaz Upscale** on fal | `FAL_KEY` + premium | premium | $0.08 — finishing pass, 2× |
| Video | [LongCat-Video](https://github.com/meituan-longcat/LongCat-Video) on fal | `FAL_KEY` | paid | **cheapest video, $0.005/s** |
| Video | Seedance 2.0 on fal | `FAL_KEY` | paid | up to 4K, optional audio |
| Video | LongCat-Video self-hosted on Modal | `MODAL_LONGCAT_URL` | paid | needs a deploy |
| Video | **Veo 3.1** on fal | `FAL_KEY` + premium | premium | $0.03-$0.60/s — best quality |
| Video | **Kling v3** on fal | `FAL_KEY` + premium | premium | $0.084-$0.168/s — up to 15s |
| Video | Google Veo 3.1 direct | `GOOGLE_API_KEY` | premium | billed to your Google key |
| 3D | TRELLIS-2 on fal | `FAL_KEY` | paid | $0.25 per mesh |
| 3D | [microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) on Modal | `MODAL_TRELLIS_URL` | paid | needs a deploy |
| 3D | **Tripo3D v2.5** on fal | `FAL_KEY` + premium | premium | $0.20-$0.45 — quads + PBR |
| 3D | **Hunyuan3D v2** on fal | `FAL_KEY` + premium | premium | fastest image→mesh |
| Research | Reach — URL → markdown ([Agent Reach](https://github.com/Panniantong/Agent-Reach) / Jina Reader) | none | free | works immediately |
| Authoring | Shot composer — 118 cinematography terms with reference clips | none | free | works immediately |

Twenty providers across three modalities, and **`FAL_KEY` alone lights up
fifteen of them.** Two authoring aids — the shot composer and Reach — need no
credentials at all.

### Three cost tiers, and why that is a feature

The picker groups providers by what a click costs, because a flat list puts a
$0.40-per-second model next to a free one with nothing to tell them apart:

- **Free** — Pollinations. No key, no bill, no ceiling.
- **Paid** — cents per render. LongCat at $0.005 per generated second, TRELLIS-2
  at $0.25 a mesh.
- **Premium** — dollars per render, and **off by default**. Veo 3.1 at 4K with
  audio is $0.60 per generated second: an 8-second clip is $4.80. These share
  `FAL_KEY` with the cheap providers, so a separate switch is the only thing
  standing between a curious dropdown click and a real bill.

Two guards, both server-side:

```bash
PREMIUM_ENABLED=true              # admin opt-in; false by default
PREMIUM_MAX_COST_PER_JOB_USD=5    # hard ceiling, checked BEFORE submitting
```

Every premium provider computes its cost from a rate table of **vendor-quoted
prices** (read from fal's own model metadata, never estimated) and refuses the
job before spending anything if it exceeds the ceiling:

```
Veo 3.1 (8s 4k with audio) would cost about $4.80, over the
PREMIUM_MAX_COST_PER_JOB_USD ceiling of $0.50. Shorten the clip, drop the
resolution, or raise the ceiling in .env.
```

Audio and high resolution are opt-in for the same reason — on Veo, ticking the
audio box doubles the per-second price, so it can never be a silent default.
`defaultProviderFor()` also walks free → paid → premium, so enabling the premium
tier never quietly moves a default onto an expensive backend.

A provider whose credential is missing is not hidden — it appears in the UI
disabled, with the exact reason ("`GOOGLE_API_KEY` is not set"). No silent
fallbacks, no guessing why an option does nothing.

## Quick start

```bash
git clone https://github.com/jokoprianto612-lang/okongzinc-studio.git
cd okongzinc-studio

npm run setup          # installs server/ and web/ separately
cp .env.example .env   # optional: every provider is opt-in

npm run dev            # server :8787 + web :5173
```

Open <http://localhost:5173>, type a prompt, press **Generate**. That path needs
no keys at all — and so does **Reach**, the reference-research panel below the
form.

For a single-process deployment:

```bash
npm run build          # builds server/dist and web/dist
npm start              # Express serves the API and the built SPA on :8787
```

> **Security note.** `API_KEY` in `.env` is empty by default, which leaves the
> API **unauthenticated** — correct for localhost, wrong for anything reachable
> by others. The server prints a warning on every boot while it is blank. Set it
> before binding to a public interface; the UI has a field to store the matching
> key.

## How generation flows

```
browser ──POST /api/generate──▶ validation (zod) ──▶ job queue (in-memory)
                                                          │
                                              provider.generate()
                                                          │
                                            artifact written to storage/
                                                          │
browser ◀──GET /api/jobs/:id (poll every 2s)◀─────────────┘
```

Jobs are queued rather than run inline because generation takes seconds to
minutes and providers rate-limit. The client polls instead of holding a socket,
so a reload or a sleeping laptop never loses a running job.

## Enabling the other providers

### Google (image + video)

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and
put it in `.env`:

```env
GOOGLE_API_KEY=your-key
```

Restart the server. Both **Google Gemini Image** and **Google Veo** become
selectable.

Free-tier media quota is small. Once spent the API returns `429
RESOURCE_EXHAUSTED`, and the studio surfaces that verbatim: *"Google API quota
exhausted for this key."* That is a billing state, not a bug in the app.

### Premium models (Veo 3.1, Kling v3, FLUX.2 Pro, Nano Banana Pro, Tripo3D)

These are the flagship models — what you turn on when output quality matters
more than the bill. They need no new credential; they run on the `FAL_KEY` you
already have. What they need is permission:

```env
FAL_KEY=your-key-from-fal.ai/dashboard/keys
PREMIUM_ENABLED=true
PREMIUM_MAX_COST_PER_JOB_USD=5
```

Prices below are **fal's own published numbers**, read from its model metadata on
2026-08-02, not estimates:

| Provider | Price | What it is for |
|---|---|---|
| Veo 3.1 Lite | $0.03/s silent · $0.05/s with audio | iterating on a Veo prompt cheaply |
| Veo 3.1 Fast | $0.10/s · $0.15/s with audio | the usual choice |
| Veo 3.1 | $0.20/s · $0.40/s with audio (4K: $0.40/$0.60) | final renders |
| Kling v3 Standard | $0.084/s · $0.126/s with audio | motion, up to 15s |
| Kling v3 Pro | $0.112/s · $0.168/s with audio | best motion |
| FLUX.2 Pro | $0.03 first MP + $0.015/MP | strongest prompt adherence |
| Nano Banana Pro | $0.15/image ($0.30 at 4K) | readable text inside the image |
| Seedream 5.0 Pro | $0.0675/image ($0.135 at 2K) | photographic realism, cheapest premium |
| Ideogram V3 | $0.03 / $0.06 / $0.09 | posters, logos, typography |
| Topaz Upscale | $0.08 up to 24MP | finishing pass on any render |
| Tripo3D v2.5 | $0.20-$0.45/mesh | quad topology + PBR, game-ready |
| Hunyuan3D v2 | per compute second | fastest image→mesh |

Two things are deliberately awkward, and should stay that way:

- **Audio is off by default.** On Veo it doubles the per-second price. The
  checkbox says so.
- **Resolution defaults to the cheapest the provider offers.** 4K on Nano Banana
  Pro is double; 4K on Veo is triple. Nothing steps up without being asked.

The ceiling is enforced *before* the HTTP call, so a rejected job costs nothing:

```bash
curl -s -X POST http://localhost:8787/api/generate -H 'Content-Type: application/json' \
  -d '{"modality":"video","provider":"fal-veo31","model":"fal-ai/veo3.1",
       "prompt":"a cat walks","durationSeconds":8,"resolution":"4K","generateAudio":true}'
# job fails with:
# Veo 3.1 (8s 4k with audio) would cost about $4.80, over the
# PREMIUM_MAX_COST_PER_JOB_USD ceiling of $0.50.
```

When `PREMIUM_ENABLED` is false every premium provider shows up in the UI
**disabled, with the switch named as the reason** — the same treatment a missing
key gets. Nothing silently vanishes.

### Video: hosted (fal) or self-hosted (Modal)

The same LongCat-Video 13.6B model is available two ways, and the studio ships
both because the tradeoff is real:

|  | LongCat on **fal** | LongCat on **Modal** |
|---|---|---|
| Setup | paste `FAL_KEY` | deploy a worker, download ~83 GB |
| 6s 480p clip | **~$0.03** | ~$0.35 |
| Idle cost | none | ~$12/month volume storage |
| Cold start | none | minutes, billed |
| Weights | fal's | yours |
| Content gate | fal's | none |

**Use fal unless you specifically need control over the weights.** It is roughly
10× cheaper per clip, has no idle bill, and works the moment you paste a key.

```env
FAL_KEY=your-key-from-fal.ai/dashboard/keys
```

That single line enables eight LongCat video endpoints (480p/720p × distilled/full
× text/image), six Seedance 2.0 endpoints, LongCat-Image, and TRELLIS-2 for 3D.

Prices are per **generated second**, verified from fal's model metadata
(2026-08-01):

| Endpoint | Price |
|---|---|
| LongCat 480p distilled | $0.005/s |
| LongCat 720p distilled | $0.01/s |
| LongCat 480p full | $0.025/s |
| LongCat 720p full | $0.04/s |
| Seedance 2.0 mini | ~$0.072/s @480p |
| Seedance 2.0 | ~$0.303/s @720p, ~$0.682/s @1080p |
| TRELLIS-2 | $0.25 per generation @512p |

LongCat's distinguishing trait is worth knowing: it was **pretrained on video
continuation**, so extending a clip does not accumulate the colour drift that
frame-chaining a text-to-video model produces.

#### Self-hosting on Modal (optional)

Only worth it if you need the weights under your own control:

```bash
pip install modal
modal setup

modal run modal/gpu_probe.py                       # confirm GPU access first
modal run modal/longcat_app.py::download_weights   # ~83 GB, once
modal deploy modal/longcat_app.py
```

Paste the printed endpoint into `MODAL_LONGCAT_URL`. `modal/trellis_app.py` is
the equivalent for 3D on an A100.

### Reach — grounding a prompt in a real page

Generative models describe things from memory. When you want a prompt anchored to
something real — an actual product listing, a specific tweet, a paper's abstract
— **Reach** pulls the page down as clean markdown so you can build the prompt
from source text.

Two backends, tried in order:

1. **[agent-reach](https://github.com/Panniantong/Agent-Reach) CLI** when on
   PATH — covers Twitter/X, Reddit, YouTube subtitles, Bilibili, XiaoHongShu,
   GitHub, and RSS, each behind a primary + fallback backend list.
2. **Jina Reader** (`r.jina.ai`) — no install, no key, any public URL.

Backend 2 always works, so Reach needs zero configuration. To unlock the
platforms a plain fetch cannot reach:

```bash
pip install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto
```

`/api/health` reports which backend is live, and the panel shows it in the UI.

> **Fetched pages are untrusted text.** Reach shows the content read-only for you
> to read and edit; it is never executed and never auto-injected into a prompt.
> "Append to prompt" is an explicit click. The endpoint also refuses private,
> loopback, and link-local addresses, so it cannot be used to probe your LAN.

### Shot composer — cinematography terms with reference clips

Knowing that a video model responds to "rack focus" or "neon city lighting" is
one thing; knowing what those look like before spending a render is another. The
shot composer carries **22 categories and 118 terms**, each paired with a
reference clip you can play inline.

Pick terms, and their technical phrasing is folded into the prompt at render
time:

```
"a lone figure crossing an empty intersection at night"
  + neon city lighting
  + dramatic backlight
        ↓
"a lone figure crossing an empty intersection at night. saturated cyan-magenta
 signage spill, localized colored pools, subtle atmospheric bloom, mixed CCT.
 dominant rear key creating strong rim, silhouette-capable ratio, controlled
 ambient, light haze"
```

Composition happens **server-side**, so the stored job records the exact prompt
that was sent. History showing a bare idea next to an elaborate render would make
results impossible to reason about.

The vocabulary is adapted from
[ilkerzg/awesome-video-prompts](https://github.com/ilkerzg/awesome-video-prompts)
(the project behind [videopromptkit.com](https://videopromptkit.com/)). Upstream
truncated its descriptions at 100 characters — often mid-word, sometimes on a
dangling preposition — so 57 of 118 were trimmed here to read as real English in
a composed prompt.

`GET /api/shots` returns the whole vocabulary; no key required.

### Per-model prompting guidance

Video models want different prompt shapes. Veo rewards technical cinematography
vocabulary and explicit audio cues; Seedance handles multi-shot narrative with
timing markers; LongCat wants one continuous scene. The form shows the relevant
tips and a length ceiling for whichever provider is selected, because discovering
this by wasting renders is expensive.

`GET /api/guidance` returns the curated set. Only models the studio can actually
run are included — tips for a backend we do not serve would be dead weight.

### Ideogram V3 Character — consistent faces

Plain text-to-image cannot keep the same character across scenes. Ideogram V3
Character takes a reference portrait and generates new images of that same
person:

- **Character** — reference image → new scene, same face
- **Character Edit** — masked repaint (white = repaint, black = keep), for fixing
  a region while preserving the background

The masked-edit flow follows the pattern demonstrated by
[ilkerzg/ideogram-v3-fal-playground](https://github.com/ilkerzg/ideogram-v3-fal-playground).
Field names were taken from fal's OpenAPI spec rather than the playground, because
the two disagree — the playground sends `negative_prompt` and `style` to
`/character/edit`, which that endpoint does not accept.

### 3D via TRELLIS.2

TRELLIS.2 needs an **NVIDIA GPU with ≥24 GB VRAM** (upstream verified it on
A100/H100 with CUDA 12.4). It cannot run on a normal laptop, so the studio calls
a Modal endpoint:

```bash
pip install modal
modal setup
modal deploy modal/trellis_app.py
```

Copy the printed URL into `.env`:

```env
MODAL_TRELLIS_URL=https://<workspace>--okongzinc-trellis-generate.modal.run
```

The **3D** tab then accepts an image and returns a `.glb`. Generate an image
first, click **Use as source**, and it flows straight in.

## Deploying to Cloudflare Workers

`worker/` runs the SPA and the API from one Cloudflare origin. Live now:

**<https://okongzinc-studio.claudeh1761.workers.dev>**

```bash
npm run build                          # web/dist is what the Worker serves
cd worker && npm install

npx wrangler secret put API_KEY        # REQUIRED — see below
npx wrangler secret put FAL_KEY        # required for anything to generate
npx wrangler deploy
```

### Authentication is not optional here

On localhost a blank `API_KEY` only earns a warning. On a Worker it is a refusal:
the URL is on the public internet from the moment it deploys, and an open
`/api/generate` lets any stranger spend your fal balance. With no `API_KEY`
secret the Worker returns 503 and says so:

```
This deployment has no API_KEY secret set, so generation is disabled to stop
strangers spending the fal balance. Run: wrangler secret put API_KEY
```

Health, providers, shots, and guidance stay public — they cost nothing and the
SPA needs them to render. Everything that spends money or reads history requires
the `X-Api-Key` header, which the UI's **Set API key** button stores.

### Two honest limitations

**No R2, so artifacts live on fal's CDN.** This account has R2 disabled at the
dashboard level — the API answers `code: 10042 — Please enable R2 through the
Cloudflare Dashboard` — so there is nowhere to put bytes. The Worker records the
provider's own HTTPS URL for each artifact instead of copying the file. fal
serves those with `access-control-allow-origin: *` and an immutable cache header,
so the gallery renders them directly, but **they last only as long as fal keeps
them.** Enable R2 and add a bucket binding to fix it properly;
`worker/src/providers.ts` is where the URL is captured and where a copy step
would go.

That is also why Pollinations, the Modal workers, and the OpenAI provider are
absent from the Worker build: they return raw bytes with no durable URL to
reference. Only backends that hand back a hosted URL can be served without a
bucket.

**Jobs advance on poll, not in a queue.** A Worker cannot hold a request open for
the two to eight minutes a video render takes, so a provider is split into
`buildInput()` (runs during `POST /api/generate`) and `extract()` (runs during a
later `GET`). `GET /api/jobs/:id` — the poll the client was already doing every
2s — is what advances the state machine one fal poll per tick. Job records live
in KV with a 7-day TTL.

Premium works the same way as it does locally, except the switch is a deploy-time
var rather than a `.env` line:

```bash
npx wrangler deploy --var PREMIUM_ENABLED:true
```

## Adding your own provider

One file, one array entry. Implement the `Provider` interface:

```ts
// server/src/providers/myProvider.ts
export const myProvider: Provider = {
  id: 'my-provider',
  label: 'My Provider',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9'],
  models: [{ id: 'default', label: 'Default' }],

  availability() {
    return process.env.MY_KEY
      ? { available: true }
      : { available: false, reason: 'MY_KEY is not set' };
  },

  async generate(req, ctx) {
    ctx.onProgress('calling my provider');
    const bytes = await callMyApi(req.prompt);
    return [await saveArtifact(bytes, 'image/png')];
  },
};
```

Append it to `ALL_PROVIDERS` in `server/src/providers/index.ts`. The UI picks up
its capabilities automatically — the form renders a seed input only if
`supportsSeed` is true, and so on. Nothing else changes.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | liveness, queue depth, whether auth is on |
| `GET` | `/api/providers` | capability descriptors + per-modality defaults |
| `POST` | `/api/generate` | enqueue a job → `202` with the job |
| `GET` | `/api/jobs` | recent jobs, newest first |
| `GET` | `/api/jobs/:id` | one job — poll this for progress |
| `POST` | `/api/jobs/:id/cancel` | abort a queued or running job |
| `POST` | `/api/reach` | fetch a reference URL as markdown |
| `GET` | `/api/shots` | 22 categories / 118 cinematography terms + clips |
| `GET` | `/api/guidance` | per-model prompting tips and length ceilings |
| `POST` | `/api/upload` | store a data URL → `/media/...` path |
| `GET` | `/media/*` | generated files, read-only |

```bash
# generate an image (no key needed)
curl -X POST http://localhost:8787/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"modality":"image","provider":"pollinations","prompt":"a neon aperture logo","aspectRatio":"16:9"}'

# generate a 6-second video for about 3 cents (needs FAL_KEY)
curl -X POST http://localhost:8787/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"modality":"video","provider":"fal-longcat-video",
       "model":"fal-ai/longcat-video/distilled/text-to-video/480p",
       "prompt":"neon rain on a city street","durationSeconds":6}'

# pull a reference page down to markdown (no key needed)
curl -X POST http://localhost:8787/api/reach \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/meituan-longcat/LongCat-Video"}'
```

## Layout

```
okongzinc-studio/
├── server/                  Express + TypeScript API
│   └── src/
│       ├── index.ts         routes, CORS, static hosting, shutdown
│       ├── config.ts        validated env, per-provider blocks
│       ├── jobQueue.ts      in-memory queue with concurrency + cancel
│       ├── storage.ts       artifact persistence, path-traversal guard
│       ├── validation.ts    zod schemas
│       ├── reach.ts         URL → markdown, agent-reach → Jina fallback
│       ├── shotVocabulary.ts 118 shot terms + composePrompt()
│       ├── promptGuidance.ts per-model prompting tips
│       └── providers/       falClient.ts is the shared fal transport
├── web/                     Vite + React + TypeScript + Tailwind
│   └── src/
│       ├── App.tsx          tabs, active job, gallery
│       ├── components/      form, gallery, viewer, primitives
│       ├── hooks/           job polling
│       └── lib/             API client, wire types
├── modal/                   optional self-hosting
│   ├── gpu_probe.py         cheap T4 check: does this account get a GPU?
│   ├── trellis_app.py       TRELLIS.2 image→3D worker (A100)
│   └── longcat_app.py       LongCat-Video worker (H100, ~83 GB weights)
└── docs/ARCHITECTURE.md     design decisions and tradeoffs
```

## Verification

Both packages typecheck and build clean, and the image path was exercised
end-to-end rather than assumed:

```
server  tsc -p tsconfig.json                      ✓
web     tsc -b && vite build                      ✓  167 kB js / 18 kB css
POST /api/generate → 202, succeeded               ✓  artifact on disk, real bytes
GET  /media/<file>                                ✓  200 image/jpeg
POST /api/reach (LongCat repo)                    ✓  24,213 chars in 0.6s
GET  /api/shots                                   ✓  22 categories, 118 options,
                                                     118/118 with a reference clip
GET  /api/guidance                                ✓  3 entries, tips + maxLength
/api/providers                                    ✓  11 providers, grouped, defaults ok
modal run modal/gpu_probe.py                      ✓  Tesla T4, 14.6 GB, torch 2.6.0+cu124
fal + ideogram schemas read from live OpenAPI      ✓  not guessed — see file headers

browser, full authoring flow:
  open shot composer → 22 categories load          ✓
  tick 2 terms → header + form both report "+2"    ✓
  Preview → fal reference clip plays (readyState 4) ✓
  type idea → Generate → SUCCEEDED + image         ✓
  stored prompt contains BOTH shot descriptions    ✓  composed server-side
  Reach → Fetch → Append to prompt                 ✓  1,500 chars into the form
```

Rejected as expected:

```
/media/../../.env                    404
localhost / 127.0.0.1 / 192.168.x    400  private address refused
169.254.169.254 (cloud metadata)     400  link-local refused
file:// and ftp://                   400  only http(s) supported
unknown provider                     400
empty prompt                         400  with the offending field
25+ shot option ids                  400  "at most 24 element(s)"
unknown shot option ids              202  ignored, valid ones still applied
maskImage as a bare Windows path     400  same guard as sourceImage
video provider asked for an image    400  "produces video, not image"
LongCat with no MODAL_LONGCAT_URL    503  with the deploy instruction
```

## Known limits

- **Job history is in memory.** Restarting the server clears the list; the files
  themselves stay in `storage/`. Swap `jobQueue.ts` for a SQLite store if
  history needs to survive restarts.
- **3D output has no in-app viewer.** A `.glb` is offered as a download rather
  than pulling three.js in for one feature. Open it in Blender or Windows 3D
  Viewer.
- **No npm workspaces.** npm symlinks workspace packages, which fails with
  `EPERM` on Windows without Developer Mode. Each package installs on its own
  and `npm run setup` drives both.
- **Provider latency is uneven.** Pollinations queue depth swings between ~3s
  and ~45s for the same prompt. The progress bar is indeterminate on purpose:
  no provider reports a real percentage, and inventing one would be a lie.
- **The fal providers have not been run against a live key.** Their request and
  response shapes were read from fal's published OpenAPI spec per endpoint, not
  invented, and every provider is exercised up to the credential check. But no
  actual generation has been billed, so the first real call may still surface a
  field mismatch. This covers all five fal providers including Ideogram.
- **Shot terms are appended, not woven in.** The composer concatenates technical
  phrasing after your idea rather than rewriting the sentence. That is
  deliberate — it is predictable and needs no LLM call — but a hand-written
  prompt will still beat a composed one for a specific shot.
- **The Modal workers are written but not deployed.** GPU access itself is
  confirmed (`modal run modal/gpu_probe.py` returned a Tesla T4), but neither
  TRELLIS.2 nor LongCat has been run end-to-end — that needs GPU quota at the
  A100/H100 tier and, for LongCat, an ~83 GB download. Expect to debug the first
  deploy. Given fal hosts the same models for ~10× less, self-hosting is a
  control decision, not an economy.
- **Video is slow everywhere.** Minutes per clip on any backend, hosted or not.
  The queue and the indeterminate progress bar exist because of this, not in
  spite of it.

## License

MIT — see [LICENSE](LICENSE).

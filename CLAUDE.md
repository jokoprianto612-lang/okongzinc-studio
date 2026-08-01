# CLAUDE.md — working on OkongzINC Studio

Guidance for AI coding assistants (and humans) working in this repository.

## What this project is

A self-hosted generative media studio. Two packages plus one GPU worker:

- `server/` — Express + TypeScript API. Validates requests, queues jobs, calls
  providers, persists artifacts. Also hosts three things that are NOT providers
  because they produce text or data rather than artifacts: Reach (`reach.ts`),
  the shot vocabulary (`shotVocabulary.ts`), and prompting guidance
  (`promptGuidance.ts`).
- `web/` — Vite + React + TypeScript + Tailwind SPA. Dark flat UI with tabs.
- `modal/` — OPTIONAL self-hosting workers: `gpu_probe.py` (cheap T4 access
  check), `trellis_app.py` (image→3D, A100), `longcat_app.py` (video, H100,
  ~83 GB of weights). fal hosts the same models for ~10× less, so these exist
  for control over weights, not economy.

The organising idea is the **provider layer**: every generation backend
implements one interface, and the UI renders itself from the capabilities each
provider advertises. Adding a backend must not require touching the UI.

## Commands

```bash
npm run setup        # install server/ and web/ (NOT npm workspaces — see below)
npm run dev          # server :8787 + web :5173 concurrently
npm run build        # tsc for server, tsc -b && vite build for web
npm start            # serve API + built SPA from :8787
npm run typecheck    # both packages, no emit
```

Always run `npm run build` before claiming a change works. Both packages are
strict TypeScript; a type error is a build failure, not a warning.

## Architecture rules

**The provider interface is the extension point.** To add a backend, create
`server/src/providers/<name>.ts` implementing `Provider`, then append it to
`ALL_PROVIDERS` in `providers/index.ts`. Do not add provider-specific branches
to the UI, the queue, or the routes. If a provider needs a capability the
interface cannot express, extend the interface for everyone rather than
special-casing one backend.

**Capability descriptors drive the UI.** `supportsSeed`, `supportsNegativePrompt`,
`requiresSourceImage`, and `supportedAspectRatios` are not documentation — the
form renders from them. A provider that ignores a field it claims to support is
a bug.

**Unavailable is a first-class state, not an error.** `availability()` returns a
reason string when credentials are missing, and that reason is shown in the UI.
Never throw at import time for a missing key, and never silently fall back to a
different provider — the user must be able to see which backend ran.

**Provider schemas come from the vendor's spec, never from memory.** `fal.ts`
carries four providers whose request and response shapes were read from fal's
live OpenAPI per endpoint:

```
GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
```

Do that before adding or editing a fal endpoint. Guessing a field name produces a
422 that looks like a bug in our code. Things that were actually surprising and
are easy to get wrong from intuition:

- LongCat video endpoints take **`num_frames`** (17..961, default 162) and
  **`fps`**, not a duration. 480p is 15fps, 720p is 30fps.
- Seedance takes **`duration` as an enum of stringified integers** (`'4'`..`'15'`
  or `'auto'`), not a number, and `resolution` as `'480p'|'720p'|'1080p'|'4k'`.
- All fal image inputs are **`image_url`**, never raw bytes. A local
  `/media/...` artifact must be uploaded to fal storage first — that is what
  `resolveImageUrl` does.
- fal's TRELLIS-2 returns **`model_glb`**, and `resolution` is `512|1024|1536`
  while `texture_size` is `1024|2048|4096`.

**All fal transport lives in `falClient.ts`.** Five providers share one queue
implementation, one error translator, and one upload path. When adding a fal
endpoint, import from there — do not copy the polling loop into a new file. The
error translator deliberately surfaces fal's `detail[].loc` on a 422, because
that is what makes a wrong field name diagnosable instead of mysterious.

**Prompt composition happens server-side.** The client sends `shotOptionIds`, and
`composePrompt()` folds the vocabulary into the prompt inside the
`/api/generate` handler before the job is created. This is not an arbitrary
placement: the stored job must record the exact prompt that was sent, or history
shows a bare idea beside an elaborate render and results become impossible to
reason about. Unknown ids are ignored rather than throwing — a stale id in a
bookmarked URL should not fail the request.

**Use the queue API (`queue.fal.run`), not the sync endpoint.** Video generation
exceeds any reasonable HTTP timeout. Submit returns `status_url` and
`response_url`; poll the former, then read the latter.

**Progress notes must be honest.** `ctx.onProgress()` reports real stages
("polling operation (24s elapsed)"). No provider returns a completion
percentage, so the progress bar is deliberately indeterminate. Do not fabricate
a percentage.

**Reach is not a provider, and that is deliberate.** It returns text for a human
to read, not an artifact for the gallery, so forcing it through the `Provider`
interface would mean inventing a fake modality. It lives at `POST /api/reach`
with its own module. Two rules that must not be relaxed:

- **Fetched pages are untrusted input.** Reach output is displayed read-only and
  is never executed, never fed to a model automatically, and never spliced into
  a prompt without an explicit user click. A page saying "ignore your
  instructions" is just text on screen.
- **`assertPublicHttpUrl` blocks private, loopback, and link-local hosts.** That
  guard is what stops this endpoint from becoming an SSRF probe into the LAN or
  a cloud metadata service (`169.254.169.254`). Do not remove it for
  convenience, and keep `execFile` argument arrays — never a shell string — when
  invoking the agent-reach CLI.

## Conventions

- **TypeScript strict everywhere**, including `noUncheckedIndexedAccess`. Index
  access yields `T | undefined` — handle it, do not cast it away.
- **ESM only.** `server/` is `"type": "module"`; relative imports need the `.js`
  extension in source (`./config.js`), matching what `tsc` emits.
- **Secrets live in `.env`, behaviour lives in code.** Every setting is read once
  in `config.ts`. Do not call `process.env` anywhere else.
- **Errors reach the user.** Wrap expected provider failures in `ProviderError`
  with a status code and a message a human can act on. A raw 500 with "internal
  error" is a failure of the error path.
- **Tailwind, dark flat.** No glassmorphism, no `backdrop-blur`, no translucent
  panels. Flat surfaces with 1px borders. Reusable classes live in the
  `@layer components` block in `web/src/index.css`; prefer `.panel`, `.input`,
  `.btn-primary` over re-deriving them inline.
- **Accessibility is not optional.** Every input has a label, buttons have real
  text, `:focus-visible` shows a ring, and images have meaningful `alt`. No emoji
  inside form controls.

## Windows notes

This repo is developed on Windows, and two things bite:

1. **npm workspaces are deliberately not used.** npm symlinks workspace packages
   into the root `node_modules`, which fails with `EPERM: symlink` unless
   Developer Mode is on. The root `package.json` drives both packages with
   `npm --prefix` instead. Do not "fix" this by reintroducing `workspaces`.
2. **Use forward slashes in code and config.** They work everywhere and avoid
   escaping pain in shell commands.

## Things that were already tried

Save yourself the loop:

- **Same-origin CORS rejection.** Vite emits
  `<script type="module" crossorigin>`, which makes the app's own bundle a CORS
  request whose `Origin` is the server itself. An allowlist containing only the
  dev-server origin rejected the production bundle and the SPA rendered blank
  with no console error. The CORS middleware now uses the request-aware delegate
  form and always allows same-host origins. Do not narrow it back to a plain
  array.
- **`process` in `vite.config.ts`.** Reading `process.env` there needs
  `@types/node` plus `"node"` in the `types` array of `web/tsconfig.json`;
  without both, `tsc -b` fails with TS2591.
- **AI-generated logos cannot spell.** The brand marks were originally generated
  as JPEGs; a vision check confirmed the wordmark never rendered as readable
  text. `web/public/brand/*.svg` are hand-authored vectors — crisp at any size
  and correctly spelled. Do not replace them with generated raster images.
- **TRELLIS.2 cannot run locally.** It needs ≥24 GB VRAM. Running it on a
  laptop is not a configuration problem to solve; the Modal worker is the
  answer.
- **LongCat-Video cannot run locally either, by a wider margin.** 13.6B
  parameters, ~83 GB of weights (verified against the HF repo), torch 2.6.0 +
  CUDA 12.4 + flash-attn 2.7.4, and an 80 GB-class GPU. The weights download is
  a separate one-off Modal function (`download_weights`) so a cold start does
  not try to pull 83 GB inside a request timeout.
- **LongCat's negative prompt matters.** `modalLongcat.ts` ships upstream's own
  default negative prompt from `run_demo_text_to_video.py`. The model was tuned
  with it; dropping it visibly degrades output. Do not "simplify" it away.
- **Modal's `.remote()` return value must be plain builtins.** The GPU probe
  first returned `torch.__version__`, which is a `TorchVersion` (a str subclass).
  Unpickling that on the caller requires torch *locally*, so the run died with
  `DeserializationError: the 'torch' module is not available in the local
  environment` — after the GPU work had already succeeded. Wrap values in
  `str()`/`int()`/`float()` before returning them from a Modal function.
- **GPU access on this account is confirmed.** `modal run modal/gpu_probe.py`
  returned Tesla T4 / 14.6 GB / torch 2.6.0+cu124 / matmul OK. That does not
  imply A100 or H100 entitlement — probe the specific tier before assuming a
  deploy will schedule.
- **The playground and the spec disagreed, and the spec won.**
  `ilkerzg/ideogram-v3-fal-playground` sends `negative_prompt` and `style` to
  `fal-ai/ideogram/character/edit`. The live OpenAPI shows that endpoint accepts
  neither — they exist only on `fal-ai/ideogram/character`. Reference
  implementations drift; the spec is the authority.
- **Upstream shot descriptions were truncated at 100 chars.** Often mid-word,
  sometimes on a dangling preposition ("light haze for"). 57 of 118 needed
  trimming. If you re-import from
  `ilkerzg/awesome-video-prompts`, re-run that cleanup or composed prompts will
  contain broken English.
- **agent-reach is optional, not a dependency.** The Reach endpoint probes for
  the CLI once, caches the answer, and falls through to Jina Reader on any
  failure — unsupported platform, missing cookie, dead backend. A failing
  agent-reach must never fail the request.

## Verifying a change

1. `npm run build` — both packages must compile.
2. Start the server and hit the real path, not just the types:
   ```bash
   curl -X POST http://localhost:8787/api/generate \
     -H 'Content-Type: application/json' \
     -d '{"modality":"image","provider":"pollinations","prompt":"test"}'
   ```
   Then poll `/api/jobs/:id` until it reaches `succeeded` and confirm the
   artifact URL returns bytes.
3. Check the error paths too: unknown provider, empty prompt, modality mismatch,
   and `/media/../../.env` (must 404). For the shot composer, confirm that a
   composed prompt is what gets STORED, not just what gets sent:
   ```bash
   curl -s -X POST http://localhost:8787/api/generate \
     -H 'Content-Type: application/json' \
     -d '{"modality":"image","provider":"pollinations","prompt":"a street",
          "shotOptionIds":["neon-city-lighting","low-angle"]}' \
     | python -c "import sys,json; print(json.load(sys.stdin)['job']['request']['prompt'])"
   ```
   For Reach, confirm the SSRF guards still reject all of these with 400:
   ```bash
   for u in http://localhost:8787/ http://192.168.1.1/ \
            http://169.254.169.254/latest/meta-data/ file:///etc/passwd; do
     curl -s -X POST http://localhost:8787/api/reach \
       -H 'Content-Type: application/json' -d "{\"url\":\"$u\"}"
   done
   ```
4. For UI work, load the page and confirm the accessibility tree actually
   contains the controls. A blank `#root` with no console error is the classic
   symptom of a broken asset or CORS path.

## Deliberate limitations

Do not "fix" these without being asked — they are choices:

- Job history is in memory. Artifacts persist, the list does not.
- No in-app 3D viewer; `.glb` is a download.
- No websockets. Polling survives reloads and sleeping laptops.
- No database. The studio is single-user by design.
- Both a hosted and a self-hosted path exist for LongCat-Video and TRELLIS. That
  duplication is intentional: fal is ~10× cheaper with no idle cost, Modal gives
  full control over weights and no third-party content gate. Do not delete
  either to "simplify".
- Reach truncates at `REACH_MAX_CHARS` (12k default) and "Append to prompt"
  takes only the first 1,500 characters. Both caps are intentional: a prompt
  stuffed with 24k characters of page markup generates worse, not better.
- The shot composer appends phrasing rather than rewriting the sentence. An LLM
  rewrite would read better but costs a call, adds latency, and makes the output
  non-deterministic. Concatenation is predictable and free.
- Guidance only covers models the studio can run. Do not add tips for wan,
  kling, pixverse, ltx, or grok until a provider actually serves them.

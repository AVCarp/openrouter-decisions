# Developing OpenRouter Decisions

Architecture, catalog-sync internals, and CI/release engineering for
[`@AVCarp/openrouter-decisions`](https://github.com/AVCarp/openrouter-decisions).
For installation, configuration, and the user-facing model list, see [README.md](README.md).

## How it works

- **Decision provider contract v1.** Registers `registerDecisionProvider` from the OpenClaw Plugin
  SDK (`contractVersion: 1`). The host calls `evaluate(batch, context)`; the provider maps the host
  batch to the OpenRouter wire payload and maps the response back.
- **Full model ids on the wire.** `decisionModels[].id` in the manifest is exactly the id sent to
  OpenRouter — no hidden mapping. If the host passes the full plugin ref
  (`openrouter-decisions/<model-id>`), the prefix is stripped before the request.
- **Tolerant response validation.** Extra fields OpenRouter adds to the response
  (`id`, `provider`, `usage.cost`, `legend`) are ignored instead of failing validation.
- **boolean → noul mapping.** Host boolean questions are sent as `noul` questions; the numeric
  `noul` answer (0..1) is returned to the host as `{ type: "boolean", probabilityTrue }`.
  `choice` and `score` questions pass through.
- **`respan/` models are noul-only.** Questions to any `respan/*` model must be boolean;
  otherwise the provider reports `unsupported-input` (verified live 2026-10-01).
- **Failure classification by structure, not text.** Errors are classified by HTTP status / error
  type (`authentication`, `rate-limited`, `transport`, `unsupported-input`, `invalid-response`) —
  never by substring scanning of response bodies.
- **Timeout & cancellation.** Requests carry an `AbortSignal.timeout(timeoutMs)` composed with the
  caller's signal (`AbortSignal.any`, with a manual fallback for Node < 20.3).

### Source layout

| Path | Contents |
|---|---|
| `src/index.ts` | Entire provider: wire types, `toWireQuestions`, `parseEvaluation`, `postJson`, `createDecisionProvider`, plugin entry. |
| `dist/index.js` | Build output (git-ignored); the runtime entry point. |
| `openclaw.plugin.json` | Manifest: contract declaration, config schema, UI hints, generated `decisionModels[]`. |
| `models/decision-models.json` | Generated catalog snapshot (`id`, `name`, `context_length`, `pricing.prompt`). |
| `scripts/sync-models.mjs` | Catalog sync + release automation (see below). |
| `.github/workflows/` | `build.yml`, `package-publish.yml`, `sync-models.yml`. |

## Build

```
npm install
npm run build   # tsc -> dist/
```

TypeScript strict mode, `target: es2024`, `module: nodenext`. The plugin entry point is
`dist/index.js` (see `openclaw.extensions` in `package.json`).

## Catalog generation and refresh

The decision model catalog lives in two checked-in files:

- `models/decision-models.json` — snapshot of the OpenRouter decisions catalog
  (per model: `id`, `name`, `context_length`, `pricing.prompt`), fetched from
  `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`;
- `openclaw.plugin.json` — the generated `decisionModels[]` used by the plugin at runtime.

`~`-prefixed alias ids (e.g. `~typesafe/jev-latest`) are excluded from both generated files as
non-stable wire ids, even though the provider itself accepts them when passed explicitly.

A scheduled GitHub Actions workflow (`.github/workflows/sync-models.yml`, daily at 06:17 UTC)
runs `scripts/sync-models.mjs`, which:

1. fetches the live catalog and compares it against the snapshot and the manifest entries; before
   any of the outcomes below, it also checks for a prepared-but-unpushed release — a local tag
   `v<package.json version>` at HEAD that is absent on origin — and, if found, re-pushes branch + tag
   in one push, exports the tag as a step output (`release-tag`) after the successful push, and exits;
   the sync workflow's next step (`Dispatch package publish for pushed release`) then dispatches the
   publish workflow for that tag explicitly: `gh workflow run package-publish.yml --ref "<tag>"` with
   a 3-attempt retry and `workflow_dispatch`, which is allowed with the default `GITHUB_TOKEN`
   (ordinary pushes made with it do not trigger workflows). In manual local runs the script just
   prints `pushed release: <tag>`.
   That recovery relies on local tags: in the scheduled CI run a failed push leaves nothing to
   recover (the runner is ephemeral and `actions/checkout` fetches without tags), so it effectively
   serves manual/local runs. If the prepared tag points at a pre-rebase commit (a rewritten release
   after the advised `git pull --rebase`), recovery force-moves it to HEAD only when the tag's tree
   is identical to HEAD's tree — proof the rebase preserved the release content verbatim; any other
   divergence aborts with a manual-reconcile hint instead of force-publishing;
2. no changes — exits quietly (`no changes`);
3. pricing/context only (the model id/name set is unchanged and the manifest's `decisionModels[]`
   entries match the catalog; only `context_length`/`pricing.prompt` moved) — rewrites the snapshot
   and pushes a plain commit
   (`chore: refresh decision models catalog (pricing/context only, no release)`): no manifest
   regeneration, no version bump, no tag, no release;
4. identity changes (the model id/name set changed — models added, removed, or renamed) or a
   manifest whose `decisionModels[]` entries no longer match the catalog (e.g. a hand-edited or
   stale manifest, even with no catalog change) — full release: rewrites the snapshot, regenerates
   `decisionModels[]` in the manifest, bumps the patch version, commits
   (`chore: refresh decision models catalog`), tags `v<version>`, and pushes branch + tag in a
   single push. After a successful push the script exports the tag as a step output (`release-tag`);
   the workflow's next step dispatches the publish workflow for it
   (`gh workflow run package-publish.yml --ref "v<version>"`) with a 3-attempt retry; in manual local
   runs it just prints `pushed release: <tag>`. `package-publish.yml` also keeps its
   `on: push: tags: 'v*'` trigger, so tags pushed manually by the maintainer from their own
   credentials publish as before — the sync script never publishes manually.

The first automated release must be cut after this change set is merged: `gh workflow run` resolves
`package-publish.yml` on the pushed tag, so a tag cut from a commit whose tree lacks the
`workflow_dispatch` trigger would fail to dispatch.

The script guards against races and half-published releases before writing anything: it aborts
cleanly if the remote branch has moved ahead (fetch + divergence check), refuses to proceed when the
prospective `v<version>` tag already exists locally or on origin, and applies per-command timeouts.
It also self-heals stranded releases: if the pushed `v<version>` tag has no successful
`package-publish` run on origin (its dispatch failed on a previous run while the tag push succeeded),
the next sync detects this via `gh run list` and re-dispatches the publish workflow (3 attempts) in
CI, or aborts with the exact manual command (`gh workflow run package-publish.yml --ref <tag>`) in
local runs.

You can also run it manually: `node scripts/sync-models.mjs`.

## CI and release

| Workflow | Trigger | Steps |
|---|---|---|
| `build.yml` | push, pull_request | `npm ci`, `npm run build`, `clawhub package validate .` |
| `package-publish.yml` | tag `v*`, or `workflow_dispatch` | verify a `vX.Y.Z` tag ref, `npm ci`, `npm run build`, install `clawhub@0.23.3`, authenticate, `clawhub package publish . --family code-plugin --owner AVCarp --source-repo AVCarp/openrouter-decisions --version <ver>` |
| `sync-models.yml` | daily schedule (06:17 UTC), `workflow_dispatch` | run `scripts/sync-models.mjs`, then dispatch `package-publish.yml` for the pushed release tag |

Publishing requires the `CLAWHUB_TOKEN` repository secret.

## Manual publish notes

- Publish from a tagged commit so ClawHub records the source repo + commit used by its security
  scan and release checksums.
- `clawhub package validate .` is the pre-publish gate; run it locally before tagging.

## License

MIT

# OpenRouter Decisions for OpenClaw

A [decision provider](https://docs.openclaw.ai/plugins) plugin for [OpenClaw](https://openclaw.ai) that
connects OpenClaw's decision engine to the native
[OpenRouter Decisions API](https://openrouter.ai) (`POST {baseUrl}/api/alpha/decisions`).

## What it does

- Registers a typed decision provider (`registerDecisionProvider`, contract v1) via the OpenClaw Plugin SDK.
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

## Installation

From ClawHub:

```
openclaw plugins install clawhub:@AVCarp/openrouter-decisions
```

From the git repository:

```
openclaw plugins install git:https://github.com/AVCarp/openrouter-decisions
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | SecretRef | — | OpenRouter API credential. Sent as `Authorization: Bearer`. Optional when the configured endpoint does not check auth (e.g. a local proxy that injects auth). |
| `baseUrl` | string | `https://openrouter.ai` | Any http(s) origin, optionally with a path prefix — e.g. a loopback proxy `http://127.0.0.1:8290`. The provider POSTs `{baseUrl}/api/alpha/decisions`. |
| `timeoutMs` | integer | `45000` | Request timeout (1000–120000 ms), enforced via `AbortSignal`. |

`apiKey` is declared as a secret input (`configContracts.secretInputs`), so set it through
**Settings → Secrets** rather than plain config. Requests without a key still go out unauthenticated.

Example — pick a decision model for agents:

```json
{
  "agents": { "defaults": { "decisionModel": "openrouter-decisions/openai/gpt-6-luna-decisions" } }
}
```

## Supported models

The full OpenRouter decisions catalog is fetched from
`GET https://openrouter.ai/api/v1/models?output_modalities=decisions` into two generated files —
treat those as authoritative instead of a hand-maintained list:

- `openclaw.plugin.json` — the generated `decisionModels[]` discovery list used by the plugin;
- `models/decision-models.json` — the full catalog snapshot (`id`, `name`, `context_length`,
  `pricing.prompt`).

Both are refreshed automatically by the scheduled workflow (see
[How the model catalog is updated](#how-the-model-catalog-is-updated)); for example, the catalog
contains `openai/gpt-6-luna-decisions` and `nace-ai/drex-v2.0`.

Any full OpenRouter model id still works — there are no hard restrictions in the provider code; the
catalog in the manifest is for discovery only. All `respan/*` entries are noul-only, and upstream
`~`-prefixed alias ids are excluded from both generated files as non-stable wire ids.

## How the model catalog is updated

The decision model catalog lives in two checked-in files:

- `models/decision-models.json` — snapshot of the OpenRouter decisions catalog
  (per model: `id`, `name`, `context_length`, `pricing.prompt`), fetched from
  `GET https://openrouter.ai/api/v1/models?output_modalities=decisions`;
- `openclaw.plugin.json` — the generated `decisionModels[]` used by the plugin at runtime.

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

## Build

```
npm install
npm run build   # tsc -> dist/
```

TypeScript strict mode, `target: es2024`, `module: nodenext`. The plugin entry point is
`dist/index.js` (see `openclaw.extensions` in `package.json`).

## License

MIT
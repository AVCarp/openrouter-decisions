# OpenRouter Decisions for OpenClaw

A [decision provider](https://docs.openclaw.ai/plugins) plugin for [OpenClaw](https://openclaw.ai) that
connects OpenClaw's decision engine to the native
[OpenRouter Decisions API](https://openrouter.ai) (`POST {baseUrl}/api/alpha/decisions`).

Use it when you want OpenClaw to ask a question — "should I proceed?", "which of these options is
better?" — and get a **probability, a choice, or a score back from a model** instead of free-form
text.

> Looking for install-from-source, architecture, catalog-sync internals, or CI/release details?
> See **[DEVELOPING.md](DEVELOPING.md)**. This README is the end-user guide.

## Requirements

- OpenClaw with plugin support (plugin API `>=2026.3.24-beta.2`).
- An OpenRouter account. An API key is optional in two cases: you run a local proxy that injects
  auth, or the configured endpoint does not check auth.

## Installation

From ClawHub (recommended):

```
openclaw plugins install clawhub:@AVCarp/openrouter-decisions
```

From the git repository (development builds):

```
openclaw plugins install git:https://github.com/AVCarp/openrouter-decisions
```

The plugin ships disabled by default (`enabledByDefault: false`) — enable it in your OpenClaw
config after installing.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | SecretRef | — | OpenRouter API credential. Sent as `Authorization: Bearer`. Omit when the configured endpoint does not check auth (e.g. a local proxy that injects auth). |
| `baseUrl` | string | `https://openrouter.ai` | Any http(s) origin, optionally with a path prefix — e.g. a loopback proxy `http://127.0.0.1:8290`. The provider POSTs `{baseUrl}/api/alpha/decisions`. |
| `timeoutMs` | integer | `45000` | Request timeout (1000–120000 ms), enforced via `AbortSignal`. |

`apiKey` is declared as a secret input (`configContracts.secretInputs`), so set it through
**Settings → Secrets** and reference it from config — do not paste the raw value into plain config.
Requests without a key still go out unauthenticated.

### Example: enable the plugin with an API key

For the hosted OpenRouter endpoint, create a protected credential in Settings → Secrets, then
reference it from the plugin configuration. Merge this example into your existing configuration;
keep any other entries in `plugins.allow`.

```json
{
  "plugins": {
    "allow": ["openrouter-decisions"],
    "entries": {
      "openrouter-decisions": {
        "enabled": true,
        "config": {
          "apiKey": { "source": "store", "provider": "openrouter", "id": "default" }
        }
      }
    }
  },
  "agents": {
    "defaults": { "decisionModel": "openrouter-decisions/~typesafe/jev-latest" }
  }
}
```

The host reads its prepared SecretRef value for each request; it does not independently read
environment credentials or cache a previous credential. A missing or unavailable credential makes
decisions unavailable.

### Example: select a decision model

Once the provider is enabled, select the model OpenClaw uses for decisions. The value is
`<provider>/<full-model-id>`; an unset global role leaves decisions off.

```json
{
  "agents": {
    "defaults": { "decisionModel": "openrouter-decisions/openai/gpt-6-luna-decisions" },
    "entries": {
      "research": { "decisionModel": "openrouter-decisions/typesafe/jev-1.13" }
    }
  }
}
```

## Supported models

All decision models come from OpenRouter's decisions catalog
(`GET https://openrouter.ai/api/v1/models?output_modalities=decisions`). A short selection:

| Model id | Notes |
|---|---|
| `openai/gpt-6-luna-decisions` | Large context, general-purpose decisions |
| `nace-ai/drex-v2.0` | High-quality decisions |
| `nace-ai/drex-v1.5` | Previous Drex generation |
| `upstage/solar-decide` | Long context (512K) |
| `upstage/solar-decide-flash` | Faster, cheaper variant |
| `cloudflare/clef` | Low cost |
| `cloudflare/clef-flash` | Fastest / cheapest Clef |
| `liquid/d1` | Compact decisions model |
| `microsoft/microsoft-decision-1` | Microsoft decisions model |
| `inception/mercury-decide` | Also available as `inception/mercury-decide:free` |
| `perplexity/decider-v1.1-27b` | Perplexity decisions model |
| `respan/span-01` | Noul-only — boolean questions only (see below) |
| `respan/span-01-lite` | Noul-only; also `:free` |

The catalog is much larger than this table, and it changes. The authoritative, always-current list
lives in the generated manifest (`decisionModels[]` in `openclaw.plugin.json`) and in
`models/decision-models.json`. Any full OpenRouter model id also works — the provider has no hard
model allow-list; the catalog is used for discovery only.

### Tilde (`-latest`) alias models are supported

OpenRouter publishes floating alias ids that begin with `~`, e.g. `~typesafe/jev-latest`. These
track the newest release of a model line and are **valid decision models** — you can pass them
directly as the model id:

```json
{
  "agents": { "defaults": { "decisionModel": "openrouter-decisions/~typesafe/jev-latest" } }
}
```

Because they follow upstream, a `~`-alias may change behavior without a plugin update. Only the
`~`-prefixed aliases are excluded from the *generated catalog files* (they are not stable wire ids);
they are not excluded from the provider, so using one explicitly is fully supported.

### Noul-only models

The `respan/*` family accepts boolean questions only. Sending a `choice` or `score` question to a
`respan/*` model fails with `unsupported-input` (verified live 2026-10-01). For all other models,
`boolean`, `choice`, and `score` questions are supported.

## The catalog is refreshed once a day

The decision-model catalog is re-fetched from OpenRouter **once every 24 hours**. When upstream
adds, removes, or renames models, the manifest's `decisionModels[]` and `models/decision-models.json`
are regenerated automatically, and pricing/context changes are noted without a release. You do not
need to update the plugin to see new models.

## Question types

| Question type | Behavior |
|---|---|
| `boolean` | Sent to OpenRouter as `noul`; the numeric answer (0..1) is returned as `{ "type": "boolean", "probabilityTrue": <0..1> }`. |
| `choice` | Passed through; returns the chosen alternative plus per-alternative probabilities. |
| `score` | Passed through; returns the score plus per-level probabilities. |

## License

MIT

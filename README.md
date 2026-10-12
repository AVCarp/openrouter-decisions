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

The manifest ships the full OpenRouter decisions catalog (19 entries, fetched 2026-10-12 via
`GET https://openrouter.ai/api/v1/models?output_modalities=decisions`):

- `microsoft/microsoft-decision-1`
- `nace-ai/drex-v1.5`
- `cloudflare/clef-omni`
- `upstage/solar-decide-flash`
- `perplexity/decider-v1.1-27b`
- `openai/gpt-6-luna-decisions`
- `liquid/d1`
- `cloudflare/clef-flash`
- `cloudflare/clef`
- `togethercomputer/tev1-4b-experimental`
- `inception/mercury-decide`
- `inception/mercury-decide:free`
- `upstage/solar-decide`
- `respan/span-01` *(noul only)*
- `respan/span-01-lite` *(noul only)*
- `respan/span-01-lite:free` *(noul only)*
- `jaredpalmer/kev-4b`
- `~typesafe/jev-latest`
- `typesafe/jev-1.13`

Any full OpenRouter model id works — there are no hard restrictions in the provider code; the
catalog in the manifest is for discovery only. The catalog is refreshed automatically by a
scheduled workflow in this repository: it fetches the live decisions catalog, diffs it against the
manifest, and publishes a patch release when models are added or removed.

## Build

```
npm install
npm run build   # tsc -> dist/
```

TypeScript strict mode, `target: es2024`, `module: nodenext`. The plugin entry point is
`dist/index.js` (see `openclaw.extensions` in `package.json`).

## License

MIT
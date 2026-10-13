// OpenRouter Decisions — typed decision provider via OpenRouter Decisions API.
// Endpoint: POST {baseUrl}/api/alpha/decisions (baseUrl: any http(s) origin per
// configSchema; default https://openrouter.ai).
// Model ids are FULL OpenRouter ids: manifest decisionModels[].id === wire id.
// No hidden mapping. context.model goes on the wire as-is, after optionally
// stripping the "openrouter-decisions/" prefix if the host passes the full ref.
// Difference from @openclaw/typesafe: tolerant validation of OpenRouter's extra
// response fields (id, provider, usage.cost, legend).

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";

const REF_PREFIX = "openrouter-decisions/";
// Respan family rejects choice/score questions (verified live 2026-10-01).
const NOUL_ONLY_PREFIX = "respan/";

// ---------- Decisions API wire payload types ----------

type WireQuestion = Record<string, unknown>;

interface WireNoulAnswer {
  type: "noul";
  noul: number;
}
interface WireChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
interface WireScoreAnswer {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}
type WireAnswer = WireNoulAnswer | WireChoiceAnswer | WireScoreAnswer;

interface WireRequest {
  model: string;
  state: unknown;
  questions: Record<string, WireQuestion>;
}
interface WireResponse {
  model?: unknown;
  answers?: Record<string, unknown>;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cost?: unknown; // tolerated extra field, ignored
  };
  id?: unknown; // tolerated extra field, ignored
  provider?: unknown; // tolerated extra field, ignored
  legend?: unknown; // tolerated extra field, ignored
}

// Host-facing question shapes (decision provider contract v1).
interface HostQuestion {
  type?: unknown;
  [key: string]: unknown;
}
interface HostBatch {
  state?: unknown;
  questions?: Record<string, HostQuestion>;
}
interface HostContext {
  model?: unknown;
  signal?: AbortSignal;
}

interface DecisionEvaluation {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}
type DecisionAnswer =
  | { type: "boolean"; probabilityTrue: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }  | { type: "score"; score: number; probabilities: number[]; confidence?: number };
type FailureReason = "credentials-unavailable" | "authentication" | "rate-limited" | "transport" | "unsupported-input" | "invalid-response";
type DecisionResult =
  | { status: "ok"; result: DecisionEvaluation }
  | { status: "unavailable"; reason: FailureReason };

interface PluginConfig {
  baseUrl: string;
  timeoutMs: number;
}

interface RuntimeConfigSnapshot {
  plugins?: {
    entries?: Record<string, { config?: Record<string, unknown> }>;
  };
}

// ---------- helpers ----------

function currentConfig(snapshot: RuntimeConfigSnapshot | undefined): PluginConfig {
  const configured = snapshot?.plugins?.entries?.["openrouter-decisions"]?.config ?? {};
  return {
    baseUrl: typeof configured.baseUrl === "string" ? configured.baseUrl : "https://openrouter.ai",
    timeoutMs: typeof configured.timeoutMs === "number" ? configured.timeoutMs : 45000,
  };
}

// HTTP failures carry the numeric status so classification never depends on the
// (untrusted) response text.
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// Protocol-level failures: malformed JSON or evaluations violating the wire contract.
class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

// Structural classification by error type/status only — no substring scanning of
// messages, which embed question ids and response bodies.
function decisionFailure(error: unknown): { status: "unavailable"; reason: FailureReason } {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return { status: "unavailable", reason: "authentication" };
    if (error.status === 429) return { status: "unavailable", reason: "rate-limited" };
    return { status: "unavailable", reason: "transport" };
  }
  if (error instanceof ProtocolError) return { status: "unavailable", reason: "invalid-response" };
  // Abort/timeout errors (DOMException "AbortError"/"TimeoutError") surface here as transport.
  return { status: "unavailable", reason: "transport" };
}

// Host boolean -> TypeSafe noul; choice/score pass through untouched.
function toWireQuestions(questions: Record<string, HostQuestion>): Record<string, WireQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]): [string, WireQuestion] => {
      if (q.type === "boolean") {
        const wire: WireQuestion = { type: "noul" };
        if (q.instructions !== undefined) wire.instructions = q.instructions;
        if (q.criteria !== undefined) wire.criteria = q.criteria;
        return [id, wire];
      }
      return [id, { ...q }];
    }),
  );
}

// Shared choice/score distribution invariant: every value must be finite, and the
// distribution must be non-empty with at least one positive value. Checks run in
// this order so the first failure reports the same error as before.
function assertValidDistribution(values: number[], id: string, kind: "choice" | "score"): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new ProtocolError("invalid evaluation: bad " + kind + " probabilities " + id);
  }
  if (values.length === 0 || !values.some((v) => v > 0)) {
    throw new ProtocolError("invalid evaluation: degenerate " + kind + " distribution " + id);
  }
}

// Tolerant validation: ignore OpenRouter extra fields (id, provider, usage.cost, legend).
function parseEvaluation(raw: WireResponse, wireQuestions: Record<string, WireQuestion>, hostQuestions?: Record<string, unknown>): DecisionEvaluation {
  if (!raw || typeof raw !== "object") throw new ProtocolError("invalid evaluation: not an object");
  const model = typeof raw.model === "string" ? raw.model : "";
  if (!model) throw new ProtocolError("invalid evaluation: missing model");
  const rawAnswers = raw.answers;
  if (!rawAnswers || typeof rawAnswers !== "object") throw new ProtocolError("invalid evaluation: missing answers");

  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, wireQuestion] of Object.entries(wireQuestions)) {
    const a = rawAnswers[id];
    if (!a || typeof a !== "object") throw new ProtocolError("invalid evaluation: missing answer " + id);
    const answer = a as Partial<WireAnswer>;
    if (wireQuestion.type === "noul") {
      const noul = (answer as Partial<WireNoulAnswer>).noul;
      if (
        (answer as Partial<WireNoulAnswer>).type !== "noul" ||
        typeof noul !== "number" ||
        !(noul >= 0 && noul <= 1)
      ) {
        throw new ProtocolError("invalid evaluation: bad noul answer " + id);
      }
      answers[id] = { type: "boolean", probabilityTrue: noul };
    } else if (wireQuestion.type === "choice") {
      const choiceAnswer = answer as Partial<WireChoiceAnswer>;
      if (choiceAnswer.type !== "choice" || typeof choiceAnswer.choice !== "string" || !choiceAnswer.probabilities) {
        throw new ProtocolError("invalid evaluation: bad choice answer " + id);
      }
      const rawProbs = choiceAnswer.probabilities;
      const probs: Record<string, number> = {};
      for (const [k, v] of Object.entries(rawProbs)) {
        probs[k] = Number(v);
      }
      assertValidDistribution(Object.values(probs), id, "choice");
      answers[id] = {
        type: "choice",
        choice: choiceAnswer.choice as string,
        probabilities: probs,
        confidence: choiceAnswer.confidence,
      };
    } else if (wireQuestion.type === "score") {
      const scoreAnswer = answer as Partial<WireScoreAnswer>;
      if (scoreAnswer.type !== "score" || typeof scoreAnswer.score !== "number") {
        throw new ProtocolError("invalid evaluation: bad score answer " + id);
      }
      // Host score.questions carry criteria (array of level descriptions); the wire
      // question passes them through as criteria (see toWireQuestions, score passes
      // through untouched). Validate probabilities against host criteria length.
      const hostQuestion = hostQuestions ? (hostQuestions as Record<string, HostQuestion>)[id] : undefined;
      const levels = Array.isArray(hostQuestion?.criteria)
        ? hostQuestion.criteria
        : Array.isArray(wireQuestion.levels)
          ? wireQuestion.levels
          : (() => {
              throw new ProtocolError("invalid evaluation: no score levels " + id);
            })();
      const rawProbs = scoreAnswer.probabilities ?? {};
      const probabilities = levels.map((_, i) => Number(rawProbs[String(i)] ?? 0));
      assertValidDistribution(probabilities, id, "score");
      answers[id] = {
        type: "score",
        score: scoreAnswer.score,
        confidence: scoreAnswer.confidence,
        probabilities,
      };
    } else {
      throw new ProtocolError("invalid evaluation: unknown question type " + String((wireQuestion as WireQuestion).type));
    }
  }

  const usage = raw.usage ?? {};
  return {
    model,
    answers,
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
    },
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: WireRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WireResponse> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let composite: AbortSignal;
  let cleanup = () => {};
  if (AbortSignal.any) {
    composite = AbortSignal.any(signals);
  } else {
    // Node < 20.3 has no AbortSignal.any: compose manually so caller
    // cancellation still aborts the in-flight request instead of being dropped.
    const controller = new AbortController();
    const listeners = signals.map((source) => {
      const listener = () => controller.abort(source.reason);
      source.addEventListener("abort", listener, { once: true });
      return { source, listener };
    });
    // A source already aborted before its listener was attached never fires.
    for (const { source } of listeners) {
      if (source.aborted) {
        controller.abort(source.reason);
        break;
      }
    }
    composite = controller.signal;
    cleanup = () => {
      for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
    };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: composite,
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, "HTTP " + response.status + ": " + text.slice(0, 300));
    try {
      return JSON.parse(text) as WireResponse;
    } catch {
      throw new ProtocolError("invalid json");
    }
  } finally {
    cleanup();
  }
}

interface DecisionProvider {
  id: string;
  contractVersion: 1;
  isReady(): boolean;
  evaluate(batch: HostBatch, context: HostContext): Promise<DecisionResult>;
}

function createDecisionProvider(getConfig: () => PluginConfig): DecisionProvider {
  return {
    id: "openrouter-decisions",
    contractVersion: 1 as const,
    isReady() {
      return Boolean(getConfig().baseUrl);
    },
    async evaluate(batch: HostBatch, context: HostContext): Promise<DecisionResult> {
      context.signal?.throwIfAborted?.();
      const config = getConfig();
      if (!config.baseUrl) return { status: "unavailable", reason: "credentials-unavailable" };

      // Accept both the bare model id and the full "<provider>/<id>" ref.
      const rawModel = typeof context.model === "string" ? context.model : null;
      if (!rawModel) return { status: "unavailable", reason: "unsupported-input" };
      const wireModel = rawModel.startsWith(REF_PREFIX) ? rawModel.slice(REF_PREFIX.length) : rawModel;
      if (!wireModel) return { status: "unavailable", reason: "unsupported-input" };

      const wireQuestions = toWireQuestions(batch.questions ?? {});
      if (wireModel.startsWith(NOUL_ONLY_PREFIX)) {
        for (const q of Object.values(wireQuestions)) {
          if (q.type !== "noul") return { status: "unavailable", reason: "unsupported-input" };
        }
      }

      const headers: Record<string, string> = {};
      const secret = getPreparedPluginSecretInput("openrouter-decisions", "apiKey");
      if (secret?.value) headers.Authorization = "Bearer " + secret.value;

      const base = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
      try {
        const raw = await postJson(
          base + "/api/alpha/decisions",
          headers,
          {
            model: wireModel,
            state: batch.state == null ? "" : batch.state,
            questions: wireQuestions,
          },
          config.timeoutMs,
          context.signal,
        );
        context.signal?.throwIfAborted?.();
        const evaluation = parseEvaluation(raw, wireQuestions, batch.questions);
        return { status: "ok", result: evaluation };
      } catch (error) {
        context.signal?.throwIfAborted?.();
        return decisionFailure(error);
      }
    },
  };
}

export default definePluginEntry({
  id: "openrouter-decisions",
  name: "OpenRouter Decisions",
  description:
    "Typed decision provider via OpenRouter's Decisions API (full model ids, tolerant response validation).",
  configSchema: { jsonSchema: {} },
  register(api) {
    api.registerDecisionProvider(
      createDecisionProvider(() => currentConfig(api.runtime.config.current() as RuntimeConfigSnapshot)),
    );
  },
});
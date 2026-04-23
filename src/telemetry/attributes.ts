// OpenInference semantic-convention attribute keys.
//
// Lifted from https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
// under Apache-2.0. Importing the spec rather than depending on the Python
// `openinference-instrumentation` package keeps us TS-native and zero-dep.
//
// We prefer OpenInference over OTel GenAI for agent/tool spans — OTel GenAI
// is still "Development" stability as of April 2026 and only covers LLM
// request/response shapes. OpenInference covers chain/tool/agent/eval/graph.
//
// For LLM-call spans we emit OpenInference keys PLUS the handful of stable
// OTel GenAI keys (model id, token counts, cache read) since Langfuse and
// Phoenix both ingest either.

// --- OpenInference span-kind (attribute value, not OTLP span.kind) ---
// OTLP span.kind stays INTERNAL(1) for everything; the semantic kind lives in
// the `openinference.span.kind` attribute.
export const OPENINFERENCE_SPAN_KIND = "openinference.span.kind";

export const SpanKind = {
  CHAIN: "CHAIN",
  TOOL: "TOOL",
  AGENT: "AGENT",
  LLM: "LLM",
  RETRIEVER: "RETRIEVER",
  EMBEDDING: "EMBEDDING",
  GUARDRAIL: "GUARDRAIL",
  EVALUATOR: "EVALUATOR",
  RERANKER: "RERANKER",
} as const;

export type SpanKindName = (typeof SpanKind)[keyof typeof SpanKind];

// --- Session / user / metadata ---
export const SESSION_ID = "session.id";
export const USER_ID = "user.id";
export const METADATA = "metadata";
export const TAG_TAGS = "tag.tags";

// --- Input / output ---
export const INPUT_VALUE = "input.value";
export const INPUT_MIME = "input.mime_type";
export const OUTPUT_VALUE = "output.value";
export const OUTPUT_MIME = "output.mime_type";

// --- Tool ---
export const TOOL_NAME = "tool.name";
export const TOOL_DESCRIPTION = "tool.description";
export const TOOL_PARAMETERS = "tool.parameters";

// --- Graph (work-graph nodes) ---
export const GRAPH_NODE_ID = "graph.node.id";
export const GRAPH_NODE_NAME = "graph.node.name";
export const GRAPH_NODE_PARENT_ID = "graph.node.parent_id";

// --- Eval (verifier) ---
export const EVAL_NAME = "eval.name";
export const EVAL_SCORE = "eval.score";
export const EVAL_LABEL = "eval.label";
export const EVAL_EXPLANATION = "eval.explanation";

// --- Agent ---
export const AGENT_NAME = "agent.name";

// --- OTel GenAI (stable subset, for token/model attribution) ---
export const GEN_AI_MODEL = "gen_ai.request.model";
export const GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_FINISH_REASONS = "gen_ai.response.finish_reasons";

// --- Frontier-specific (prefixed with frontier.) ---
// OpenInference allows custom attrs; prefix avoids collision.
export const FRONTIER_EVENT_KIND = "frontier.event.kind";
export const FRONTIER_APPROVAL_CLASS = "frontier.approval.class";
export const FRONTIER_SIDE_EFFECT_CLASS = "frontier.side_effect.class";
export const FRONTIER_ADAPTER_ID = "frontier.adapter.id";
export const FRONTIER_GRAPH_ID = "frontier.graph.id";

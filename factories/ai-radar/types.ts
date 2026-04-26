// factories/ai-radar/types.ts
//
// Canonical types for the AI Radar Factory (v0).
//
// A `RadarItem` is the smallest reusable unit of external-AI-ecosystem
// intelligence. It is what every collector emits and what every
// downstream consumer (digest, claim-extractor, upgrade-planner) reads.
//
// PR #8 (this PR) emits `RadarItem`s with:
//   - `claims`: always empty (claim extraction is PR #9).
//   - `classification`: topic from source hints, scores all `0`
//     (representing "not yet classified"). PR #9's classifier
//     overwrites with real 1..3 scores.
//   - `recommendedAction`: always `"remember"` for now. PR #9 picks
//     the real action based on classification.
//   - `linkedArtifacts`: always `{}`. Populated only after PR #9 wires
//     the upgrade planner to skills/evals/PRs.
//
// The shape itself is intentionally fixed in v0 so PR #9 can enrich
// without touching collectors or schemas.

export type SourceKind =
  | "official_changelog"
  | "github_release"
  | "github_raw_changelog"
  | "discord"
  | "youtube"
  | "paper"
  | "blog"
  | "repo_activity"
  | "community_post";

export type TrustTier = "official" | "maintainer" | "community" | "rumor";

export type Topic =
  | "model_release"
  | "agent_runtime"
  | "coding_agent"
  | "mcp"
  | "security"
  | "evals"
  | "research"
  | "infra"
  | "local_models"
  | "voice_ui"
  | "workflow";

export type RecommendedAction =
  | "ignore"
  | "remember"
  | "investigate"
  | "create_eval"
  | "update_skill"
  | "update_model_policy"
  | "open_upgrade_pr"
  | "security_review";

export type FetchFormat = "html" | "markdown" | "json" | "rss" | "atom";

export interface SourceFetchSpec {
  type: "http_get";
  format: FetchFormat;
  /** Mark JSON sources that target the GitHub API; affects parser routing. */
  githubApi?: boolean;
}

export interface Source {
  id: string;
  kind: SourceKind;
  trustTier: TrustTier;
  name: string;
  url: string;
  fetch: SourceFetchSpec;
  cadence: "hourly" | "daily" | "weekly";
  topicHints: Topic[];
}

export interface SourceRegistry {
  schema: "frontier_os.radar.source_registry.v1";
  sources: Source[];
}

/**
 * The reference to the originating source on a RadarItem. Mirrors
 * the registry entry but is denormalized so the item is self-contained.
 */
export interface RadarItemSource {
  kind: SourceKind;
  /** registry id (e.g. "claude-code-changelog") */
  id: string;
  /** human-readable source name (e.g. "Anthropic Claude Code CHANGELOG.md") */
  name: string;
  /** canonical URL of the originating page/feed. */
  url: string;
  trustTier: TrustTier;
}

export interface RadarItemClaim {
  text: string;
  supportUrl: string;
  confidence: "high" | "medium" | "low";
}

export type ScoreNotYetClassified = 0;
export type ScoreLow = 1;
export type ScoreMedium = 2;
export type ScoreHigh = 3;
export type Score = ScoreNotYetClassified | ScoreLow | ScoreMedium | ScoreHigh;

export interface RadarClassification {
  topic: Topic;
  novelty: Score;
  impact: Score;
  urgency: Score;
  confidence: Score;
}

export interface RadarLinkedArtifacts {
  skill?: string;
  eval?: string;
  tasteAntiExample?: string;
  factory?: string;
  pr?: string;
}

export interface RadarItem {
  schema: "frontier_os.radar.radar_item.v1";
  id: string;
  source: RadarItemSource;
  observedAt: string;
  publishedAt?: string;
  title: string;
  summary: string;
  rawTextPath?: string;
  claims: RadarItemClaim[];
  classification: RadarClassification;
  recommendedAction: RecommendedAction;
  linkedArtifacts: RadarLinkedArtifacts;
}

export interface RunSummary {
  schema: "frontier_os.radar.run_summary.v1";
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode: "observe" | "shadow" | "active" | "disabled";
  killSwitchActive: boolean;
  perSource: Array<{
    id: string;
    classification: "ok" | "stale" | "failed" | "ambiguous";
    fetchedBytes: number;
    httpStatus: number | null;
    error: string | null;
    newItems: number;
    seenItems: number;
  }>;
  finalClassification: "passed" | "failed" | "ambiguous";
  digestPath: string | null;
  itemsPath: string | null;
}

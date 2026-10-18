
import { z } from "zod";
import "@deepseek-ai/dsh-session";
import z$1 from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/activity.d.ts
interface ActivityState {
  days: Record<string, ActivityDay>;
  /** The route in force (the last `request/header`'s config wins) — prices each settlement. */
  model?: string;
  provider?: string;
  /** The open step's start instant (armed by `step/start`, cleared by `step/end`). */
  stepStart?: number;
  /** Pending `skill`-tool call ids (armed by `tool/call`, consumed by the pairing `tool/result`):
   * the wrapper match alone is not trusted, or a `read` of source text quoting
   * `<skill_content name="…">` would book a load. Bounded at {@link MAX_PENDING_SKILL_CALLS}. */
  skillCalls?: string[];
}
//#endregion
//#region src/host/headers.d.ts
/** One stored tool: v1 rows carried the producer description and raw schema; later folds append metadata-only. */
interface StoredHeaderTool {
  name: string;
  tokens: number;
  description?: string;
  plugin?: string;
  schema?: unknown;
}
/** One stored epoch: v1 rows carried `system`; later folds carry `systemTokens`. */
interface StoredHeaderRecord {
  seq: number;
  time: number;
  system?: string;
  systemTokens?: number;
  tools: StoredHeaderTool[];
}
interface HeadersState {
  headers: StoredHeaderRecord[];
}
//#endregion
//#region src/host/foldState.d.ts
interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[];
  sums: Record<Category, number>;
  systemTokens: number;
  /** The live system-prompt nodes, oldest first. `systemTokens` is the LAST entry with tokens > 0 (the harness's
   * own "last nonempty surviving system" rule), so an empty dormant node keeps its position without clearing the
   * prompt. Bounded by SYSTEM_NODES_MAX. Absent on rows folded before this field existed; the client then falls
   * back to the header epoch's own envelope figure. */
  systems?: SystemPromptNode[];
  toolsTokens: number;
  /** The projection cache requires plain JSON: a property whose value is `undefined` makes the whole checkpoint
   * unserializable, failing EVERY cache write for the session — including the `title` row that powers the session
   * list after a restart. Optional fields therefore stay absent until a value is known, never `undefined`-valued. */
  model?: string;
  provider?: string;
  lastModel?: string;
  contextWindow?: number;
  /** The newest `request/header` envelope's routed output cap (dsh materializes the adapter default
   * into it). Last-wins: a header omitting the cap clears it. */
  maxOutputTokens?: number;
  requests: RequestRecord[];
  /** The number of turn runs in `requests` (a run = consecutive records sharing one `turn`). Maintained
   * incrementally at the single append site and recomputed when a trim replaces the array, so the retention
   * trim's cap check stays O(1) per event. Absent on rows folded before the field existed. */
  turnRuns?: number;
  events: ContextEventRecord[];
  /** Recently removed surface nodes (stamped COPIES carrying `gone`), in removal order. Bounded two ways in
   * trimState: capped to `maxArchiveNodes`, and pruned to removals after the oldest retained request. */
  archived: SurfaceNode[];
  /** Cumulative billed-token totals per (provider, model), split into pricing periods for DeepSeek. Never trimmed, so
   * the estimate covers the COMPLETE session log. */
  cost?: SessionCostUsage;
  /** Whole-session human-input tally (see Snapshot.humanInputs); never trimmed, like `cost`. */
  humanInputs?: number;
  /** Whole-session answers tally (see Snapshot.answers); never trimmed, like `humanInputs`. */
  answers?: number;
  /** The user's newest own message as a bounded one-line preview. Last-wins: a text-less input (images only) keeps the previous line. */
  lastUser?: string;
  archiveFloor?: number;
  /** Bumped by every fold that mutates the request records, context events, live surface, or removed-node
   * archive; the slim wire head carries it so an open tab knows its fetched detail went stale. */
  detailRev?: number;
  /** Whole-session timing totals (see TimingTotals), running sums over the COMPLETE session log like `cost`. */
  timing?: TimingTotals;
  /** The open step's start instant, armed by `step/start` and consumed by the `assistant/message` (TTFT/generation
   * split) and `step/end` (wall time) that follow. One slot, not a map: steps are sequential in the log, so the
   * newest `step/start` is the one those events close — a hostile interleaved log degrades to skipped durations. */
  stepStart?: {
    time: number;
    firstToken?: number;
  };
  /** The open step's CLOSED user-wait intervals (real log instants), pushed replace-style as each wait settles: an
   * approval decision, or an `ask_user_question` call's whole tool window. `step/end` subtracts their clamped
   * union from the step window to price the request's `activeMs`, then deletes the slot. */
  stepWaits?: {
    start: number;
    end: number;
  }[];
  /** The open step's PENDING approval waits (request id → its `approval/asked` instant), disarmed by the matching
   * `approval/decided`. A crash mid-decision leaves the pair dangling, so `step/end` closes the survivors at its
   * own instant. Deleted at `step/start` (a superseded step's leftovers) and `step/end`. */
  stepApprovals?: Record<string, number>;
  /** The seq of the request record committed by the open step's `assistant/message` — the back-pointer `step/end`
   * stamps `activeMs` onto. Nothing pushes between a step's message and its end, so the record is the requests
   * tail and the stamp is an O(1) tail write guarded by this seq. */
  stepRequestSeq?: number;
  /** The timing strip's painted spans: every completed step's time slices in log order, stamped with their REAL
   * instants — the TTFT wait, the decode blocks in stream order, the tool-run windows, and the in-step residue.
   * Idle time BETWEEN steps carries no span. Bounded by TIMING_SPANS_MAX (newest tail kept). */
  spans: TimingSpan[];
  /** The open step's accumulated painted spans; `step/end` clamps them into the step window, de-overlaps
   * first-wins (parallel runs paint their union), fills the holes with the residue kind, and flushes the tiling
   * into `spans`. Deleted at the flush (the plain-JSON precondition). */
  stepSpans?: TimingSpan[];
  /** Tool callId → the call's name, start instant, and raw arguments, armed by `tool/call` and DELETED when its
   * `tool/result` folds in — the map stays at pending-call size instead of growing for the session's lifetime. */
  callNames: Record<string, {
    name: string;
    start: number;
    argsRaw?: string;
  }>;
  /** Seq list of the surface nodes the next replacement will shadow, armed by the metering event
   * (`compaction/summary` | `compaction/prune`) and consumed by the replacement that must follow it
   * synchronously. The producer's shadow price covers exactly these seqs, which can differ from the
   * replacement's declared range (pruned replacement nodes keep their own seqs, beyond the range end). */
  pendingShadowedSeqs?: number[];
  /** The seq of the `compaction/prune` event that armed `pendingShadowedSeqs`. The shadowed path rewrites that
   * event's `tokens` from the gross shadow price to the NET freed amount, so the row matches the drop the trend chart shows. */
  pendingShadowEventSeq?: number;
  /** The fold-derived file-operation log: one record per executed file op, bounded by `maxFileOps`; the trim stamps `fileOpsFloor`. */
  fileOps: FileOpRecord[];
  /** The newest dropped op's seq (the card's coverage floor for the served op log). */
  fileOpsFloor?: number;
  /** Nested Code-Mode ops buffered by their top run_code call id until the parent's result folds (the dispatch
   * events land BEFORE it). Bounded by PENDING_CODE_OPS_MAX, so a hostile log that never settles a run_code cannot grow it. */
  pendingCodeOps?: Record<string, FileOpRecord[]>;
}
//#endregion
//#region src/shared/types.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The plugin's timeline: slim head on the split generation, inline value on channel-less
     * hosts; key absence = the host half is not composed. */
    contextTimeline: ContextTimeline;
    /** Request-header content epochs — a separate unit so the hot timeline value stays lean;
     * key absence = an older host (tokens only). */
    contextHeaders: ContextHeaders;
    /** The per-day activity ledger behind the Context Insights heatmap; key absence = an older host (empty heatmap). */
    contextActivity: ContextActivity;
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState;
    contextHeaders: HeadersState;
    contextActivity: ActivityState;
  }
}
/** The priced surface buckets. `skill` carries the skill-machinery content the harness injects:
 * the `<available_skills>` digest, a `/name` invocation's instructions, and a `skill`-tool load. */
type Category = 'user' | 'inject' | 'skill' | 'assistant' | 'tool';
/** One live system-prompt node; the harness models the prompt as a surface node, so its TEXT is
 * fetched from the `system/message` event at `seq`. The effective figure is the LAST node with `tokens > 0`. */
interface SystemPromptNode {
  seq: number;
  time: number;
  tokens: number;
}
/** Counts precomputed over the RETAINED request/event records; `steps` is the retained request-record count. */
interface TimelineCounts {
  turns: number;
  steps: number;
  injects: number;
  compactions: number;
  prunes: number;
  /** Distinct names among the retained events tagged `sub: 'skill'`; the `<available_skills>`
   * digest has no name and never counts. Absent = 0. */
  skills?: number;
}
/** The newest retained request record's billing summary. */
interface TimelineLast {
  seq: number;
  total: number;
  prompt?: number;
}
interface ActivityDay {
  /** Billed tokens from provider-reported usage that day (input + cache read/write + output); a
   * settlement-less request counts only toward `requests`. */
  tokens: number;
  /** Completed model calls (assistant settlements) that day. */
  requests: number;
  /** The day's billed buckets keyed provider → model → pricing period, scoped to the day the
   * requests INITIATED in. Absent = tokens-only bars. */
  cost?: SessionCostUsage;
  /** Skill name → `{ n: loads, last: last-load instant in epoch ms }`; absent = an empty day. */
  skills?: Record<string, {
    n: number;
    last: number;
  }>;
}
/** The per-session daily ledger: host-local day key (`YYYY-MM-DD`, shared/days.ts) → that day's
 * billed volume; the Context Insights page merges every listed session's ledger. */
interface ContextActivity {
  days: Record<string, ActivityDay>;
}
/** One available skill's catalog metadata, served by `/api/dsh-context/skills` (host/skills.ts); every field but `name` is best-effort. */
interface SkillInfo {
  /** Kebab-case identifier — the join key onto `ActivityDay.skills`. */
  name: string;
  description: string;
  /** Absolute instruction file path, when the provider is filesystem-backed. */
  path?: string;
  /** Discovery source bucket (e.g. 'project-agents', 'user-dsh', 'bundled'). */
  source?: string;
}
/** The display-preference vocabulary of the `dsh-context` entry — the ONE declaration shared by
 * the Host Config schema (host/config.ts) and the Client's settings form (client/settings.ts). */
type DefaultGranularity = 'step' | 'turn';
type DefaultTrendMode = 'total' | 'delta';
/** The browser delta baseline: against the immediately preceding record, or the previous turn's last step. */
type DefaultDeltaBase = 'step' | 'turn';
type DefaultFileSort = 'count' | 'latest' | 'path';
type DefaultToolSort = 'size' | 'count' | 'name';
type DefaultPlacement = 'all' | 'tab' | 'sidebar';
type InsightsEntry = 'show' | 'hide';
type DefaultDurationCurve = 'show' | 'hide';
/** Whether the Fleet conversation tab is served. */
type FleetTab = 'show' | 'hide';
interface PluginSettings {
  defaultPlacement: DefaultPlacement;
  defaultGranularity: DefaultGranularity;
  defaultTrendMode: DefaultTrendMode;
  defaultDeltaBase: DefaultDeltaBase;
  defaultToolSort: DefaultToolSort;
  defaultFileSort: DefaultFileSort;
  insightsEntry: InsightsEntry;
  defaultDurationCurve: DefaultDurationCurve;
  fleetTab: FleetTab;
  /** Free text joined ahead of the harness's assembled system prompt; empty disables. */
  promptPrefix: string;
  /** Free text joined behind the harness's assembled system prompt; empty disables. */
  promptSuffix: string;
}
interface Snapshot {
  ok: boolean;
  /** Present ONLY when the running harness is below the supported baseline: the host folds
   * nothing (all figures zero) and the client shows the upgrade gate. */
  unsupported?: {
    current: string;
    minimum: string;
  };
  model?: string;
  provider?: string;
  contextWindow?: number;
  /** The newest request envelope's routed output cap, which auto-compaction reserves before pricing
   * its pressure trigger. Absent = no cap in the log (or a row folded before the field existed). */
  maxOutputTokens?: number;
  current: {
    system: number;
    tools: number;
    user: number;
    inject: number;
    skill: number;
    assistant: number;
    tool: number;
    total: number;
  };
  /** Image blocks in the CURRENT context (uploads plus nested tool-result images), summed over live surface nodes. Absent = 0. */
  images?: number;
  /** Tool calls whose result is live (a `skill`-tool node keeps counting); in-flight and
   * compacted/pruned-out calls are excluded. Absent = 0. */
  toolCalls?: number;
  /** Whole-session tally of non-injection `user/message` plus answered `ask_user_question` — a
   * running total over the COMPLETE log. Absent = 0. */
  humanInputs?: number;
  /** Whole-session replies: one per assistant message carrying non-blank text (tool-only steps are not replies). Absent = 0. */
  answers?: number;
  /** The newest own message as a one-line preview (first text block, whitespace collapsed, 80 chars max). Absent = hidden. */
  lastUser?: string;
  /** Split-generation head fields — present exactly when the host serves the slim head;
   * `detailRev` bumps whenever the detail collections change. */
  counts?: TimelineCounts;
  last?: TimelineLast;
  detailRev?: number;
  /** The slim head serves these EMPTY (the collections ride the detail channel); the client swaps in the detail payload's collections. */
  requests: RequestRecord[];
  events: ContextEventRecord[];
  /** Cumulative session-cost raw material (SessionCostUsage); absent until a request with a known model reports usage. */
  cost?: SessionCostUsage;
  /** Whole-session timing totals (TimingTotals). Absent until the first step lifecycle completes. */
  timing?: TimingTotals;
  /** The live system-prompt nodes, oldest first. Absent on rows folded before the field existed
   * — the client then reads the header epoch's `systemTokens`. */
  systems?: SystemPromptNode[];
  /** The served live surface: the newest `maxNodes` tail PLUS every live inject/skill node older
   * than the tail (they land first and are pinned). Seq-ordered, oldest first. */
  nodes: SurfaceNode[];
  /** Live nodes not served: the overflow beyond `maxNodes` minus the pinned inject/skill nodes. */
  droppedNodes: number;
  /** Recently REMOVED surface nodes (compaction/prune shadows) stamped with `gone` (the replacing
   * event's seq); a node belongs to request R when `seq < R.seq && (gone undefined || gone > R.seq)`. */
  archive: SurfaceNode[];
  /** Newest seq among the `droppedNodes` nodes not served; present only when droppedNodes > 0. */
  surfaceFloor?: number;
  /** Newest `gone` among retention-dropped archive entries; steps below it may miss removed nodes. */
  archiveFloor?: number;
  /** The fold-derived file-op log and trim floor: the INLINE value and detail payload, never the slim head. */
  fileOps?: FileOpRecord[];
  fileOpsFloor?: number;
  /** The timing strip's painted spans: INLINE value and detail payload only; absent on rows folded before the collection existed. */
  spans?: TimingSpan[];
}
/** The on-demand DETAIL payload of the split generation: the heavy collections the slim head no
 * longer carries (host/detail.ts). `rev` mirrors the head's `detailRev` and is the client's latest-wins cursor. */
interface ContextTimelineDetail {
  rev: number;
  /** The slim head at the SAME fold cut as the collections — a session listed cold has no
   * `contextTimeline` row, so the Agent network ring reads this. Optional. */
  head?: ContextTimeline;
  requests: RequestRecord[];
  events: ContextEventRecord[];
  nodes: SurfaceNode[];
  droppedNodes: number;
  archive: SurfaceNode[];
  surfaceFloor?: number;
  archiveFloor?: number;
  /** The file-op log (shared/fileOps.ts) over the FULL log; Code-Mode nested dispatches book on their parent run_code result (`parent`). */
  fileOps?: FileOpRecord[];
  /** The newest dropped op's seq when the op log trimmed (coverage honesty, same family as archiveFloor). */
  fileOpsFloor?: number;
  /** The completed steps' time slices in log order, positioned by their real instants. Absent = no strip. */
  spans?: TimingSpan[];
}
/** One executed file operation, folded host-side from the durable tool lifecycle (`tool/call` +
 * `tool/result`, or a nested `tool/ptc-dispatch`); line deltas are estimates read off the call
 * ARGUMENTS. `gone` is client-joined, not host-stamped. */
interface FileOpRecord {
  seq: number;
  /** The op's file; for a pathless search the searched PATTERN (`pattern: true`). */
  path: string;
  kind: 'read' | 'write' | 'search';
  tool: string;
  time?: number;
  err: boolean;
  added: number;
  removed: number;
  /** The searched pattern, with the include filter when one narrowed the call. */
  detail?: string;
  /** Meta-attributed search op only: matched lines the result reported for this file. */
  hits?: number;
  /** Read ops only: the exact 1-based window the result meta reported, else the `limit`-argument estimate (`est: true`). */
  read?: {
    start: number;
    count: number;
  } | {
    count: number;
    est: true;
  };
  /** Nested Code-Mode op only: the run_code result node the op ran under (the locate target). */
  parent?: number;
  /** Nested Code-Mode op only: the run_code program's model-authored description. */
  program?: string;
  /** The searched-pattern marker: `path` is a pattern, not a file — display must not relativize it. */
  pattern?: true;
  /** Client-joined archive stamp (see the type note); absent on the wire. */
  gone?: number;
}
/** The `contextTimeline` projection's whole value; `ok` is always `true` here (kept for wire compatibility). */
type ContextTimeline = Snapshot;
/** One painted span of the timing card's session-time strip (a step's TTFT wait, decode block,
 * tool-run window, or residue gap). `start`/`end` are the slice's REAL instants; the strip packs
 * them gapless in log order, and `end` > `start` always. */
interface TimingSpan {
  /** The timing card's own slice vocabulary (same keys, same colors). */
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other';
  start: number;
  end: number;
}
/** One pricing bucket's cumulative billed tokens: a running total over the COMPLETE session log, never trimmed. */
interface CostBucketTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
interface ToolTimingTotals {
  calls: number;
  ms: number;
}
/**
 * Whole-session timing totals, host-folded from the durable step/tool lifecycle plus the call's
 * first token (its embedded `assistant/message.data.stream`); running totals over the COMPLETE log.
 *
 * Milliseconds: `wallMs` sums whole steps; `ttftMs` the step-start → decode-start slice and `genMs`
 * the decode-start → assistant-message slice (only over calls whose stream carried a token delta);
 * `toolsMs` sums per-call tool durations (parallel calls each count). The decode window opens at the
 * first OBSERVABLE instant — the first token, or an earlier `block-start` marker (a redacted
 * reasoning block leaves no chunk): anchoring at the token would double-count the marker-tiled
 * window past 100%.
 *
 * The generation split comes off the stream's `block-start` framing (`blockType`): `reasoningMs` /
 * `textMs` / `toolArgMs` and their block counts, each marker owning the interval to the next.
 * `speedTokens`/`speedMs` are the harness-parity throughput seat (first-token → assistant-message,
 * calls carrying both); `speedMs` KEEPS the first-token anchor. `calls` counts folded assistant
 * messages, `toolCalls` folded call/result pairs.
 */
interface TimingTotals {
  wallMs: number;
  ttftMs: number;
  genMs: number;
  reasoningMs?: number;
  reasoningBlocks?: number;
  textMs?: number;
  textBlocks?: number;
  toolArgMs?: number;
  toolArgBlocks?: number;
  speedTokens?: number;
  speedMs?: number;
  calls: number;
  toolsMs: number;
  toolCalls: number;
  /** Per-tool-name tallies behind the timing card's ranking (bounded). */
  tools: Record<string, ToolTimingTotals>;
}
/** One billed model's totals split by pricing period: providers without period pricing book
 * everything under `peak`; DeepSeek bills `peak` at list price and `off` at half. */
interface CostModelUsage {
  peak?: CostBucketTotals;
  off?: CostBucketTotals;
  /** Whole requests above a verified model's prompt-token pricing threshold. */
  long?: CostBucketTotals;
}
/** The session-cost raw material: cumulative provider-reported billed tokens keyed by the request
 * envelope's DSH provider id ('' when none) then model id — the faces the Client's models.dev price book resolves. */
interface SessionCostUsage {
  [provider: string]: {
    [model: string]: CostModelUsage;
  };
}
/** One model-visible message on the surface, with its heuristic token price. */
interface SurfaceNode {
  seq: number;
  time?: number;
  cat: Category;
  tokens: number;
  /** Image blocks inside this node's message (absent when zero). */
  imgs?: number;
  /** Set only on `archive` entries: the seq of the replacement event that shadowed this node. */
  gone?: number;
  form?: string;
  /** The producer identity the matching inject event names (host pricing.ts
   * `injectionSourceName`); absent when unreadable or predating the stamp. */
  name?: string;
  text?: string;
  tool?: string;
  err?: boolean;
  skill?: string;
  calls?: string[];
}
/** One answered model call (a step); consecutive records of one turn form it. */
interface RequestRecord {
  turn?: number;
  step?: number;
  time: number;
  seq: number;
  system: number;
  tools: number;
  user: number;
  inject: number;
  assistant: number;
  tool: number;
  total: number;
  prompt?: number;
  /** Skill-machinery tokens of this request (the `skill` composition category); absent on rows
   * folded before the category existed (read as 0). */
  skill?: number;
  /** Billed cache-read (served) prompt tokens — the hit-rate numerator against `prompt`; absent
   * on older hosts, and zero is a real value. */
  cacheRead?: number;
  output?: number;
  /** The step's ACTIVE ms (`step/start` → `step/end` minus in-step user waits: approval decisions
   * and `ask_user_question`), stamped at `step/end`; absent while the step is open. */
  activeMs?: number;
  /** Turn-mode aggregate marker, set by the Client's aggregateByTurn (the Host never sets it). */
  stepCount?: number;
  /** Delta-mode signed net change, set by the Client's deltaOf (the Host never sets it). */
  net?: number;
}
interface ContextEventRecord {
  seq: number;
  time: number;
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode';
  form?: string;
  tokens?: number;
  count?: number;
  sub?: string;
  name?: string;
  detail?: string;
  from?: string;
  to?: string;
  /** Turn/step of the request logged right BEFORE the event (host-stamped). */
  fromTurn?: number;
  fromStep?: number;
  /** Turn/step of the request this event contributed to (host-stamped). */
  turn?: number;
  step?: number;
}
/** One tool of a request-header epoch, with its display price. */
interface HeaderTool {
  name: string;
  tokens: number;
  /** The registering plugin's label when known: `mcp:<server>` for MCP tools, or the pinned
   * first-party map; `UNKNOWN_TOOL_SOURCE` marks a boot-time tool, absent = no tag. */
  plugin?: string;
}
/** One request-header epoch's METADATA (epoch boundaries and token prices, in force from this seq
 * until the next). The CONTENT is deliberately not projected — every list row and push frame would
 * carry it — and is fetched on demand as a {@link HeaderEpochContent}. */
interface HeaderRecord {
  seq: number;
  time: number;
  /** The epoch's estimated system-prompt tokens; absent when it logged no system prompt. */
  systemTokens?: number;
  tools: HeaderTool[];
}
/** The `contextHeaders` projection value: the bounded epoch list (newest last). */
interface ContextHeaders {
  headers: HeaderRecord[];
}
/** One currency's DeepSeek open-platform balance figures. */
interface PlatformBalanceEntry {
  /** The ISO code the platform reported (`CNY` / `USD`). */
  currency: string;
  /** `granted` + `toppedUp`, derived rather than read from the platform's `total_balance`, which rounds independently of its parts. */
  total: number;
  /** The not-expired granted (gift) balance. */
  granted: number;
  toppedUp: number;
}
/** The DeepSeek open-platform balance, served by `/api/dsh-context/balance`; `null` on the wire
 * (nothing rendered) when unconfigured or the read fails. */
interface PlatformBalance {
  isAvailable: boolean;
  /** One entry per currency the account holds; at least one. */
  balances: PlatformBalanceEntry[];
}
//#endregion
//#region src/host/config.d.ts
declare const DEFAULT_BOUNDS: {
  maxRequestSteps: number;
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns: number;
  maxEvents: number;
  /** Pathological-session backstop only: each push ships the whole value (~150B/node). */
  maxNodes: number;
  maxArchiveNodes: number;
  maxFileOps: number;
};
/** The resolved fold bounds; derived from {@link DEFAULT_BOUNDS} so the two cannot drift. */
type FoldBounds = typeof DEFAULT_BOUNDS;
export type Config = Partial<FoldBounds> & Partial<PluginSettings>;
export declare const Config: z$1<Schemastery.ObjectS<NoInfer<{
  maxRequestSteps: z$1<number, number, "defined">;
  maxKeptTurns: z$1<number, number, "defined">;
  maxEvents: z$1<number, number, "defined">;
  maxNodes: z$1<number, number, "defined">;
  maxArchiveNodes: z$1<number, number, "defined">;
  maxFileOps: z$1<number, number, "defined">;
  defaultPlacement: z$1<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z$1<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z$1<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z$1<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z$1<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z$1<"hide" | "show", "hide" | "show", "defined">;
  fleetTab: z$1<"hide" | "show", "hide" | "show", "defined">;
  promptPrefix: z$1<string, string, "defined">;
  promptSuffix: z$1<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  maxRequestSteps: z$1<number, number, "defined">;
  maxKeptTurns: z$1<number, number, "defined">;
  maxEvents: z$1<number, number, "defined">;
  maxNodes: z$1<number, number, "defined">;
  maxArchiveNodes: z$1<number, number, "defined">;
  maxFileOps: z$1<number, number, "defined">;
  defaultPlacement: z$1<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z$1<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z$1<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z$1<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z$1<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z$1<"hide" | "show", "hide" | "show", "defined">;
  fleetTab: z$1<"hide" | "show", "hide" | "show", "defined">;
  promptPrefix: z$1<string, string, "defined">;
  promptSuffix: z$1<string, string, "defined">;
}>>, "plain">;
//#endregion
//#region src/host/index.d.ts
export declare const name = "dsh-context";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
//#endregion
export type { ActivityDay, ActivityState, Category, ContextActivity, ContextEventRecord, ContextHeaders, ContextTimeline, ContextTimelineDetail, HeaderRecord, HeaderTool, HeadersState, PlatformBalance, PlatformBalanceEntry, RequestRecord, SkillInfo, Snapshot, SurfaceNode, TimelineCounts, TimelineLast, TimelineState };
//# sourceMappingURL=index.d.ts.map
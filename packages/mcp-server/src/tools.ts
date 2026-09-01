// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ZodError, type ZodIssue } from 'zod';
import { clipName, normalizeRepoPath, isAbsolutePathAnyHost, signalSchema, SIGNALS, SIGNAL_PAYLOADS, parseConfig, RECORD_TYPES, REVIEWER_ROLES, handoffSchema, knownFieldsFor, unknownFieldsIn, schemaFor, digestRecord, headlineRecord, recordSizes, NO_CAPTURE_LANES, type DurableRecord, type FieldShape, type NoCaptureLane, type RunRecord, type SessionEvent, type SterlingConfig } from '@sterling/schemas';
import {
  DEFAULT_QUERY_CAP,
  MAX_RANK_TERMS,
  extractAxisTerms,
  axisHits,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  recordCentralityHits,
  type QueryOptions,
  type RecordedExit,
  type ToolStore,
} from '@sterling/store';
import { react, type BrainAction, type ResolvedExit } from './brain.js';

export interface SkippedCheck {
  check: string;
  reason: string;
}

/**
 * knowledge_create's result. `deduped`/`text_updated` appear only for a SYSTEM
 * maintenance item that hit the atomic dedup path (board 2ded3b4b) — they are
 * DECLARED rather than spread-in-silently, because a caller that cannot see
 * "this returned the existing item" in the type is a caller that will treat a
 * dedup as a fresh insert.
 */
export interface CreateResult {
  record: DurableRecord;
  check_skipped: SkippedCheck[];
  /** The item already existed; `record` is that existing item, not a new row. */
  deduped?: boolean;
  /** The existing item's text was refreshed because this attempt said something different. */
  text_updated?: boolean;
  /**
   * Cited-id resolution warnings (board fc053051): one entry per id-shaped
   * citation in the written text that resolves to NO record in the mounted
   * fan, at any status. Always present — `[]` when every citation resolved
   * or none were found. Never gates the write (AC5): the record still lands.
   */
  warnings: string[];
  /**
   * SAME-SUBJECT SURFACING (decision 7e3c66c5): present only for ruling-type
   * creates (decision / anti_pattern / research_finding) — other types'
   * responses stay byte-identical. Advisory only, never gates the write.
   */
  same_subject?: SameSubjectEntry[];
}

export interface BoardFilter {
  source?: 'user' | 'system';
  system_reason?: string;
  file_keys?: string[];
  /**
   * Narrow to items whose text contains this substring (work order d9960c98) —
   * a genuine WHERE, not a rank: it REMOVES non-matching items from the counted
   * set rather than merely reordering it, the distinction rank_terms already
   * has to honour on the knowledge side (rank_terms order a set, they never
   * narrow it). Case-insensitive plain substring match, applied in JS inside
   * boardFiltered — never routed through records_fts MATCH — so a caller's
   * string can never be interpreted as FTS5 query syntax (no quoting/escaping
   * to get wrong) and always matches literally, metacharacters included. Cheap
   * here specifically because boardFiltered already scans the bounded
   * (BOARD_SCAN_CAP) todo set into JS for the source/system_reason filters —
   * this adds one more JS predicate to that same pass, not a second table scan.
   */
  contains?: string;
  /**
   * Narrow to items owned by ONE feature_article, resolved from its slug
   * (board e725979c — maintenance_query's feature_slug gap). Resolution is
   * CHAIN-AWARE: it matches the live article's id AND every ancestor id in
   * its supersede chain (the same rel:'supersedes' links join knowledgeUpdate's
   * drift-item auto-drain already walks, decision 8ecd435f) — an item raised
   * against an earlier version of the article still matches after a later
   * reconcile superseded it. An unresolvable slug narrows to NOTHING rather
   * than erroring (no article to own anything), and combines with every other
   * filter as a genuine AND, applied in the same JS pass as system_reason/contains.
   */
  feature_slug?: string;
  /**
   * Narrow to the slices of ONE objective — the grouping key board_add requires
   * and decision a8d2ce6c made the axis the TUI groups by and H1 counts by. The
   * data was always stored and the filter was simply missing: a consuming
   * project paged 306 items across two lanes to find one objective's slices.
   *
   * Exact match on the stored value, in the same JS pass as source/system_reason
   * — a genuine WHERE, like every sibling clause here. THE WRITE SIDE'S
   * NORMALIZATION IS MIRRORED: board_add/board_update normalize the declared
   * value 'standalone' to field-absent (ungrouped), so objective:'standalone'
   * here selects the UNGROUPED items rather than matching a literal group of
   * that name — reading the write surface's own vocabulary as a group name
   * would return nothing, silently, for the one value the tool description
   * teaches. An objective no item carries narrows to nothing rather than
   * erroring (feature_slug's boundary), and a system-source item can never
   * match: maintenance items are lane-keyed by system_reason and board_add
   * refuses an objective on them.
   */
  objective?: string;
  cap?: number;
  projection?: BoardProjection;
  /**
   * PAGING (board b786a84f) — a 186-item lane audit died at item 1 because
   * board_query/maintenance_query had no way to see past one capped window.
   * Applied AFTER the same filter+sort boardFiltered already uses and BEFORE
   * the cap slice, over the same DETERMINISTIC ordering (updated_at DESC —
   * query()'s own §3.4 mechanical fallback rank, made explicit and stable in
   * boardFiltered) so paging through offset 0, cap, 2*cap, … visits every
   * matching item exactly once, in the same order, even as the board changes
   * between calls elsewhere. Defaults to 0.
   */
  offset?: number;
}

/**
 * How much of each record crosses the MCP boundary (§3.4 read side).
 *
 * 'full'   — today's behaviour, unchanged: every content field, minus the
 *            supersedes chain and server-owned baselines (see projectForQuery).
 * 'digest' — the shared envelope plus the type's HEADLINE fields only
 *            (digestRecord). Roughly 25x smaller per record, measured against
 *            this store's own articles.
 *
 * Reported by a consuming project across two retrospectives as the single
 * highest-value read-side change: full-body windows routinely blew the token
 * cap and spilled to disk (measured there: 478 KB for one board read, 86 KB and
 * 100 KB for two knowledge reads), and the recovery every time was to shell out
 * and hand-write a JSON parser to recover ids and titles — "that is not using a
 * knowledge base, that is defeating one". 'full' stays the DEFAULT so no
 * existing caller changes behaviour; the cheap read is opt-in, and the capped
 * note advertises it so it is discoverable at the moment it is needed.
 *
 * 'count'  — knowledge_query only (board fa19524d). A capped window can never
 *            establish absence — "does the store hold X?" is unanswerable once
 *            more records match than the cap shows. 'count' answers that
 *            question directly: the TRUE total for the filter (reusing the
 *            store's uncapped, rank-blind count()), no record bodies, and
 *            capped:false always — a count is defined as never-capped, it does
 *            not enumerate. When multiple types are queried, a per-type
 *            breakdown rides alongside the total (see by_type on
 *            KnowledgeQueryResult).
 */
export type Projection = 'full' | 'digest' | 'count';

/**
 * board_query/maintenance_query's own projection axis (board b786a84f):
 * every `Projection` value PLUS 'headline', which is board/maintenance-only
 * (there is no headlineRecord for the other record types knowledge_query
 * reads) — kept as its own type rather than widening `Projection` itself so
 * knowledge_query's tool schema (full/digest/count) cannot silently start
 * accepting a value it has no handling for.
 */
export type BoardProjection = Projection | 'headline';

/**
 * PARALLEL-LANE SEED — one collision group in board_query's `lane_advisory`:
 * the user-source items that declare a write path in common, and the path(s)
 * they share.
 */
export interface LaneCollision {
  /** the shared file_keys entries, sorted — every item below declares ALL of them */
  paths: string[];
  /**
   * the colliding items, newest-updated first. `name` is the item's slug or,
   * for a legacy slugless item, its clipped headline — because a bare id in
   * front of a human is unanswerable (CLAUDE.md, decision
   * `human-readable-ids-for-board-items`). The full id rides alongside it.
   */
  items: { id: string; name: string }[];
}

/**
 * PARALLEL-LANE SEED — the derived, ADVISORY reading of a board page's shared
 * write paths. Present only when two or more USER-source items in the matched
 * set declare a path in common; absent (not empty) otherwise, so its mere
 * presence is the signal.
 *
 * WHAT IT IS FOR: a slice decomposes into lanes — read-only scoping (write-set
 * empty), test authoring (write-set inside the test-path globs, where H5's
 * frozen-tests wall keeps it) and implementation (everything else) — and a
 * shared write path collides the IMPLEMENTATION lane ONLY. Measured 2026-08-29:
 * five slices of one objective all wrote a single hook file, the conductor
 * serialized the SLICES, and every scoping and test-authoring lane sat idle
 * although none of them ever collided. This block states which lane the
 * collision actually constrains, so that reasoning does not have to be
 * re-derived by hand at each dispatch moment.
 *
 * WHAT IT IS NOT: it never denies, filters, reorders or refuses anything —
 * `records` comes back exactly as it would without it — and it never counts
 * agents toward a target. Under-delegation and over-dispatch are the same
 * defect (delegation contract), so a mechanism that pushes toward a NUMBER
 * reintroduces the quota pathology it exists to cure. A parallel-safe lane is
 * not thereby a lane worth dispatching.
 *
 * SYSTEM-SOURCE ITEMS NEVER JOIN A GROUP: the maintenance queue is
 * mechanism-detected debt drained by an artifact-write, not parallel work, so
 * a queue item sharing a path with a board slice is not a lane collision.
 * maintenance_query therefore never carries this key at all.
 */
export interface LaneAdvisory {
  /** the ONE lane a shared write path constrains */
  serialized_lane: 'implementation';
  /** the lanes of a file-colliding slice that stay dispatchable */
  parallel_safe_lanes: ('read_only_scoping' | 'test_authoring')[];
  /** one entry per set of items colliding on the same path(s); never empty when present */
  collisions: LaneCollision[];
}

/** board_query / maintenance_query's disclosed envelope (see boardQueryResult). */
export interface BoardQueryResult {
  /** items matching the filter — EXACT here, unlike knowledge_query's rank-blind count */
  matched_filter: number;
  returned: number;
  cap: number;
  /** exact: more matched than were returned (i.e. offset + returned < matched_filter) */
  capped: boolean;
  /** PAGING (board b786a84f): the offset this page was read at (0 when omitted) — the next page starts at offset + returned. */
  offset: number;
  note?: string;
  /**
   * board-provenance-measured-at-head: whether the one-shot git walk backing
   * the per-item '⚠ file_keys changed…' annotation ran. 'checked' means it ran
   * (items with nothing to warn about are silently fine); 'unavailable:<reason>'
   * — no_repo_root | no_git | detached_head | no_file_keys | walk_cap — states
   * WHY, because an absent warning must never be mistaken for a checked-fresh
   * one (P5).
   */
  provenance: string;
  /**
   * TRUTH AT READ (decision queue-truth-at-read-annotation-design): whether the
   * reconcile_needed DRIFT RE-CHECK ran over this page — a DIFFERENT check from
   * `provenance` above, which describes the measured_at_head git walk, so the two
   * statuses are reported separately rather than one standing in for the other.
   * 'checked' means every returned reconcile_needed row got a verdict (a row with
   * no annotation genuinely still reproduces); 'checked:budget_truncated' means
   * the page's cost allowance ran out and the items past it say so themselves;
   * 'unavailable:<reason>' — no_reconcile_items | no_repo_root | no_git — states
   * why nothing was compared, because an absent annotation must never read as a
   * positive freshness claim (P5).
   */
  reconcile_provenance: string;
  /**
   * PARALLEL-LANE SEED: present ONLY when two or more user-source items in the
   * matched set share a file_keys path — see LaneAdvisory. Absent, never empty.
   */
  lane_advisory?: LaneAdvisory;
  /** full records, headline digests (projection:'digest'), or minimal headlines (projection:'headline') */
  records: DurableRecord[] | Record<string, unknown>[];
}

/**
 * knowledge_query's per-record staleness verdict (see computeBaselineDrift):
 * the DERIVED reading of the server-owned `file_baselines` the query projection
 * strips — which owned paths' bytes have moved since the record was written
 * against them, and which could not be checked at all. Never the hashes
 * themselves: knowledge_get stays the full-fidelity read, deliberately.
 *
 * OMITTED ENTIRELY when a record's owned files are all unmoved — so the
 * envelope's `provenance` is what makes an absence readable (a record owning no
 * files can never be annotated, and that is not a freshness claim).
 */
export interface BaselineDrift {
  /** owned paths whose CURRENT bytes differ from the recorded baseline */
  changed: string[];
  /**
   * owned paths carrying a baseline that could not be re-read at all (absent
   * from the tree, unreadable, or a working_tree name this config does not map).
   * A NON-verdict, reported rather than folded into `changed` or into silence:
   * abstention presented as "unchanged" is the exact P5 inversion board_query's
   * own F3 fix exists to prevent.
   */
  unverifiable?: string[];
  /** what the verdict means, in one sentence per arm */
  note: string;
}

/** knowledge_query's disclosed result envelope (see knowledgeQueryResult). */
export interface KnowledgeQueryResult {
  /** records matching the FILTER (types/stack_tags/file_keys), rank- and cap-blind */
  matched_filter: number;
  returned: number;
  /** the cap actually applied — the caller's, or DEFAULT_QUERY_CAP */
  cap: number;
  /** the cap was reached, so more may exist past it; false GUARANTEES nothing was dropped */
  capped: boolean;
  /** present only when the window is partial — states how to widen it */
  note?: string;
  /**
   * H19/H20 relevance slice 4b: the window's own basis to answer from —
   * 'verify_targets' when capped (more matched than was returned: a window,
   * never an inventory), 'insufficient' when nothing came back at all, else
   * 'ready' (a complete, non-empty window).
   */
  answerability: 'ready' | 'verify_targets' | 'insufficient';
  /**
   * Whether the per-record `baseline_drift` check RAN over this window — the
   * same honesty contract board_query's `provenance` carries, for the same
   * reason: an ABSENT annotation must never be readable as a positive freshness
   * claim (P5). 'checked' means every baselined record in this window was
   * compared against its recorded baseline, so a record with no annotation is
   * genuinely unmoved. 'unavailable:<reason>' — no_repo_root | no_baselines |
   * count_projection — states WHY no comparison happened, which is the case a
   * silent field would misrepresent: a decision, a todo, or any record owning
   * no files can never be annotated at all.
   */
  provenance: string;
  records: Record<string, unknown>[];
  /** projection:'count' only, and only when multiple `types` were queried: the
   *  same uncapped, rank-blind count() split per queried type, alongside the
   *  combined `matched_filter` total (board fa19524d, AC2). */
  by_type?: Record<string, number>;
  /**
   * ABSENCE QUERY (board a577a69d): present only when `min_score` was passed.
   * The count of records scoring >= min_score on the `-bm25(records_fts)`
   * scale (higher is more relevant — see countAboveScore), computed over the
   * FULL rank_terms match set, never the capped `records` window — so
   * above_threshold:0 is a usable "nothing scored that high", the thing a
   * capped/ranked window alone can never establish. matched_filter/returned/
   * cap/capped are untouched by this — it is a THRESHOLDED SURFACE beside the
   * capped-window disclosure, never a replacement for it.
   */
  above_threshold?: number;
}

/** knowledge_preflight's disclosed result (H20/H19 relevance slice 4b; scope
 *  widened + verdict renamed by board 39c3d762): "does the store govern this
 *  subject?", asked BEFORE dispatching. Reuses the same axis-extraction +
 *  stage-2 centrality floors H20 applies at delivery time, over anti_pattern +
 *  decision + feature_article + research_finding records. */
export interface KnowledgePreflightResult {
  /** 'insufficient' — too little extractable vocabulary to judge at all;
   *  'verify_targets' — the store governs this subject, verify the brief
   *  against the named matches before dispatching; 'ungoverned' — nothing in
   *  the store governs this subject. Renamed from 'ready' (board 39c3d762):
   *  the query envelope's 'ready' means a COMPLETE NON-EMPTY window — the same
   *  word carried the OPPOSITE reading here, and a false 'nothing governs'
   *  dressed as 'ready' is exactly the settled-question-presented-as-open
   *  failure the conduct rules name. */
  answerability: 'ungoverned' | 'verify_targets' | 'insufficient';
  reason?: 'too_little_vocabulary';
  terms: string[];
  matches: {
    id: string;
    type: string;
    title: string;
    matched_on: string[];
    central: string[];
    /** board c6e3561f disclosure-carry: records elsewhere holding a
     *  rel:'supersedes' edge onto this match — same shape knowledge_get and
     *  knowledge_query-full surface, OMITTED when there are none. */
    inbound_supersedes?: InboundSupersedesEntry[];
  }[];
}

/** One entry of the additive `inbound_supersedes` disclosure — {id} always,
 *  slug/title when cheaply available, `status` pinned, and `superseded_by`
 *  present only when the holder is itself not active (board c6e3561f). Shared
 *  by knowledge_get, knowledge_query-full and knowledge_preflight so the shape
 *  is declared once (see SterlingTools.inboundSupersedesEntry). */
export interface InboundSupersedesEntry {
  id: string;
  slug?: string;
  title?: string;
  status: string;
  superseded_by?: string;
}

/**
 * SAME-SUBJECT SURFACING ON WRITE (decision 7e3c66c5): one digest entry per
 * OTHER active record the preflight axis engine judges to govern the same
 * subject as a record just written. Mirrors knowledgePreflight's own
 * per-candidate shape (id/type/title/matched_on) plus `slug`, since a ruling
 * record (unlike an arbitrary preflight candidate) always carries one.
 */
export interface SameSubjectEntry {
  id: string;
  slug?: string;
  type: string;
  title: string;
  matched_on: string[];
  /** N25: the served/derived status of the matched record. A same_subject
   *  candidate is drawn from axisCandidateMatches -> store.query over the
   *  six governing types, which never serves a 'superseded' row (AC5,
   *  same-subject-surfacing.test.ts: a just-superseded record must NEVER be
   *  named) — a retired record simply never reaches this entry at all, so
   *  `status` cannot disclose retirement. What it DOES disclose: among the
   *  live candidates that DO surface, 'active' vs 'flagged_stale' (a
   *  research_finding whose currency has lapsed) — a caller can see that a
   *  same-subject match is stale before deciding whether to link to it. */
  status: string;
}

export interface ToolDeps {
  store: ToolStore;
  config?: SterlingConfig;
  now?: () => string;
  newId?: () => string;
  /** project root for §3.2.5 repo-located doc mtime checks; absent → check inert */
  repoRoot?: string;
}

const DAY_MS = 86_400_000;

// Board/queue read defaults, named rather than inlined for the DEFAULT_QUERY_CAP
// reason (decision b47889b7): the tool layer now REPORTS the cap it applied, so
// the value has two readers and a literal would be a second place to drift.
const DEFAULT_BOARD_CAP = 50;
// The bounded todo scan the filter runs over. A full scan means the reported
// count is a floor; boardQueryResult says so rather than under-reporting.
const BOARD_SCAN_CAP = 1000;
// How many local branches the parked-file probe will interrogate for ONE absent
// file (board 1d6a721a). Bounded because the probe shells out per ref: a repo
// with a long tail of stale branches must not turn one missing file into
// hundreds of subprocesses. Overrunning it degrades to today's behaviour — the
// deletion item — which is the safe direction, since that lane demands work and
// the parked lane does not.
const PARKED_REF_PROBE_CAP = 40;
// The three-way verdict parkedOnRef reaches for a file absent from the working
// tree (board e939fd21): 'parked' names the ref still holding it; 'never_tracked'
// means every reachable ref was checked and NONE ever held the blob — the
// deletion_candidate lane; 'confirmed_absent' means some ref held it once but
// only as a fully-merged ancestor of base — real git history, so the classic
// reconcile_needed reading stands; 'probe_failed' means git itself could not be
// consulted (no repo, no git, a corrupt ref) and MUST NOT be read as a
// confirmation of anything — it degrades to the same reconcile_needed reading
// as 'confirmed_absent', never to the new, more assertive deletion_candidate
// lane, because a failed probe proves nothing.
type MissingFileProbe = { status: 'parked'; ref: string } | { status: 'never_tracked' | 'confirmed_absent' | 'probe_failed' };
// board-provenance-measured-at-head: the ONE git log --name-only walk
// board_query runs per call (never per item) is bounded by this many commits
// back from HEAD, so a repo with a long history cannot turn one query into an
// unbounded subprocess. An eligible item whose measured_at_head sha does not
// appear inside this window is left unannotated and the envelope discloses
// 'unavailable:walk_cap' rather than reporting a possibly-wrong count.
// Measured against this repo's own board (~50 items, deep history): see the
// coder report for the ms figure.
const PROVENANCE_WALK_COMMIT_CAP = 2000;
// Per-file drift items one read may mint for ONE article (board 2ded3b4b). One
// item per FILE is the point — an item that names the changed file is actionable
// where an article-level one is not, and the old article-level dedup is what
// suppressed a second file's finding entirely. But an article owning twenty files
// through a whole-area refactor should not become twenty items, so the remainder
// is folded into ONE summary item that NAMES the paths it covers: a cap that
// truncates silently would read as "everything is accounted for" (P5).
const DRIFT_ITEMS_PER_READ = 3;
// Bytes of owned code past which `state: 'planned'` stops being credible (board
// db7cd16c). Deliberately generous: the point is to catch an article sitting at
// 'planned' over a SHIPPED feature (the measured case was 674 lines), not to
// nag about a stub someone scaffolded five minutes ago. A whole file under this
// is plausibly still a placeholder; several hundred lines is not.
const PLANNED_CREDIBLE_BYTES = 2000;

// TRUTH AT READ (decision queue-truth-at-read-annotation-design): the PER-CALL
// budget the reconcile_needed re-check may spend on a board_query/
// maintenance_query page. THREE AXES, not one N-files cap — that cap was
// explicitly REJECTED because "fifty files can be gigabytes and missing paths
// spawn git subprocesses", so a single number cannot bound the cost honestly:
//  - ATTEMPTS bounds the stat() fan-out (one attempt = one owned path looked at);
//  - BYTES bounds the sha256 work, which is what a big file actually costs;
//  - GIT PROBES bounds parkedOnRef, the only arm that shells out per path.
// Every axis is shared by the WHOLE page and, once any is hit, remaining items
// get a per-item `unavailable:budget` and the envelope discloses the truncation
// — never a silent partial evaluation read as "checked" (P5).
//
// MAGNITUDES: a page is capped at DEFAULT_BOARD_CAP (50) items and a minted
// reconcile item names ONE file (DRIFT_ITEMS_PER_READ splits per file), so 120
// attempts covers an ordinary full page more than twice over; the axis only
// binds on the pathological shape this budget exists for — one item naming an
// article's whole (possibly hundreds-strong) files[] set through the overflow
// summary arm.
const RECONCILE_RECHECK_FILE_ATTEMPT_CAP = 120;
const RECONCILE_RECHECK_HASH_BYTE_CAP = 8 * 1024 * 1024;
const RECONCILE_RECHECK_GIT_PROBE_CAP = 8;
// How far liveArticleFor will follow a supersede chain before abstaining
// (review FIX 3, 2026-08-31). Real chains are a handful of hops; the cap is the
// shape-independent backstop beside the cycle guard, so a torn or pathological
// chain costs a bounded number of store reads and then discloses, never a
// verdict built on whatever node the walk happened to stop on.
const LIVE_ARTICLE_CHAIN_HOP_CAP = 32;

/**
 * The verdict of the ONE per-owned-file drift classifier
 * (classifyOwnedFileDrift) that the read-time MINT and the queue's
 * TRUTH-AT-READ annotation both consume — decision
 * queue-truth-at-read-annotation-design, predicate half: "never a second copy,
 * and abstention is never collapsed to false".
 *
 * `unavailable` is a FIRST-CLASS verdict, not a hole. contentChanged() collapses
 * "no baseline" and "cannot read the file" into `false` because its callers
 * RAISE FLAGS and must abstain rather than fabricate one; that collapse is the
 * anti-model here, because the annotation site has to say WHY it could not
 * answer. The mint's abstain-as-no-drift behaviour is preserved by its CALL
 * SITE reading `unavailable` exactly as it reads `clean` — a caller policy,
 * never a property of the shared predicate.
 */
type DriftVerdict =
  | { kind: 'reconcile'; missing: boolean }
  | { kind: 'deletion_candidate' }
  | { kind: 'parked'; ref: string }
  | { kind: 'clean' }
  | { kind: 'unavailable'; reason: string };

/**
 * classifyOwnedFileDrift's result: the verdict, plus the file's size when it
 * EXISTS on disk (the mint's state-honesty check counts owned live bytes, and
 * the stat is already taken — returning it keeps the mint from taking a second).
 */
type OwnedFileDrift = { verdict: DriftVerdict; size?: number };

/**
 * The two questions classifyOwnedFileDrift is asked, which differ in exactly
 * TWO documented places (see the method body). Both modes run the same seven
 * checks in the same order.
 *
 *  - 'mint' (knowledgeQuery's read-time drift wire): "is the article's account
 *    of this file still true?" — the historical behaviour, unchanged.
 *  - 'recheck' (the queue annotation): "does the drift an OPEN item already
 *    recorded still reproduce?" — a different question about the same bytes.
 */
type DriftCheckMode = 'mint' | 'recheck';

interface DriftCheckContext {
  mode: DriftCheckMode;
  /** the working tree the article's paths live in (treeRootFor, already resolved) */
  treeRoot: string;
  /** the live article's server-computed baselines — the bytes it was written against */
  baselines: Record<string, string> | undefined;
  /** the instant those baselines were taken: the article's updated_at */
  baselinedAt: string;
  /**
   * Whether the cheap stat-first mtime prefilter may TERMINATE with `clean`
   * (no hash). TRUE at the mint (its historical behaviour, decision 57d9a52d);
   * ALWAYS FALSE at the recheck (review FIX 1, 2026-08-31) — there a
   * timestamp-only `clean` becomes the affirmative "no longer reproduces"
   * claim, and an mtime-preserved edit after an unrelated re-baseline would make
   * that claim false. See the prefilter arm in classifyOwnedFileDrift.
   */
  honorMtimePrefilter: boolean;
}

/**
 * The per-CALL budget + memo the recheck threads through the classifier.
 * Absent at the mint, which is a per-record wire with its own DRIFT_ITEMS_PER_READ
 * bound and must keep spending exactly what it spends today.
 */
interface DriftBudget {
  attempts: number;
  bytesHashed: number;
  gitProbes: number;
  /** any axis was hit at least once — the envelope's truncation disclosure */
  truncated: boolean;
  /** (resolved tree, article version, path, prefilter policy) -> verdict */
  memo: Map<string, DriftVerdict>;
}

/**
 * Tags resolveRecordId's two genuine MISS throws — too-short-to-resolve and
 * no-prefix-match — where nothing at all matched the caller's identifier.
 * knowledge_get's dead-slug fallthrough gates on this tag so it only ever
 * fires for a true miss; every other resolveRecordId refusal (a slug
 * collision, an ambiguous prefix, or a torn-store inconsistency) names
 * records that DID match and must reach the caller unchanged, never be
 * swallowed in favour of a superseded body (review finding, 2026-08-20).
 */
export class UnresolvedIdentifierError extends Error {}

/**
 * Thrown by the id-resolution ladder when an identifier resolves through
 * record_aliases — a HISTORICAL (pre-migration) id whose record was collapsed
 * into a canonical one ([stable-identity-design-v2] contract 3).
 *
 * It is one throw with two receivers, deliberately: every WRITE tool inherits
 * the refusal (naming the canonical id and its current version — a write must
 * address the live record, never a version-pinned dead id), while knowledge_get
 * CATCHES it and serves the archived snapshot plus a legacy_resolution block.
 * Putting the alias hit on the error keeps the ladder single-exit — the
 * alternative, a second resolution function for reads, is exactly the fork the
 * one-ladder decision (2debab53) exists to prevent.
 */
export class HistoricalIdError extends Error {
  constructor(
    message: string,
    readonly alias: { historical_id: string; canonical_id: string; archived_version: number }
  ) {
    super(message);
  }
}

/**
 * knowledgeSplit's input shape, extracted so knowledgeSplitResult (the
 * MCP-facing wrapper, mirroring knowledgeUpdateResult) can share it without
 * a second hand-copied literal.
 */
export interface KnowledgeSplitInput {
  id: string;
  children: {
    slug: string;
    title: string;
    what_it_does: string;
    intended_behavior: string;
    move_files: string[];
    move_ac_ids: string[];
    dependencies?: { relies_on: string[]; relied_by: string[] };
  }[];
  parent_what_it_does: string;
  parent_intended_behavior?: string;
  reason?: string;
  resolves?: string[];
}

/**
 * The unforgeable envelope: every write REFUSES these by name (board 617e97d4
 * hoisted this out of refuseServerOwnedFields so knowledge_schema's
 * server_owned mask derives from the SAME list this refusal guard consumes).
 * Exported at MODULE scope (invariant 1 — one definition) so server.ts's typed
 * knowledge_create input schema (decision 7c7f6db1) strips exactly this set
 * from every per-type variant instead of re-deriving or copying it.
 */
export const WRITE_REFUSED_FIELDS: readonly string[] = ['id', 'created_at', 'updated_at', 'status', 'superseded_by', 'type', 'lifecycle', 'freshness', 'file_baselines'];

/**
 * knowledge_schema's server-owned mask, widened from WRITE_REFUSED_FIELDS by
 * `version` — the counter this surface owns and always overwrites at create.
 * Exported alongside WRITE_REFUSED_FIELDS for the same reason: server.ts's
 * typed create variants must drop `version` too, not just the refused set.
 */
export const SERVER_OWNED_FIELDS: readonly string[] = [...WRITE_REFUSED_FIELDS, 'version'];

/**
 * Envelope fields knowledge_create DEFAULTS when absent (author 'conductor',
 * links [], scope 'project', stack_tags []) — caller-SUPPLIABLE but never
 * caller-REQUIRED. Exported so the typed create variants mark these
 * `.optional()` exactly like knowledge_schema already reports them, keeping
 * the two surfaces in lockstep (decision 7c7f6db1).
 */
export const CREATE_DEFAULTED_FIELDS: readonly string[] = ['author', 'links', 'scope', 'stack_tags'];

export class SterlingTools {
  private store: ToolStore;
  private config: SterlingConfig;
  private now: () => string;
  private newId: () => string;
  private repoRoot?: string;

  constructor(deps: ToolDeps) {
    this.store = deps.store;
    this.config = deps.config ?? parseConfig({});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? randomUUID;
    this.repoRoot = deps.repoRoot;
  }

  /**
   * §16.1.9: unbuilt checks emit check_skipped where they would have run — never
   * silent success. `persist` (default true) writes the audit row immediately;
   * pass false to DEFER persistence — the caller then gets the SkippedCheck back
   * (via the result's check_skipped) and is responsible for recording the audit
   * row itself. The only deferring caller is knowledge_extract on a domain-scoped
   * source: its txn opens on the DOMAIN mount, but recordCheckSkipped always
   * routes to the PROJECT mount (MountedStores.recordCheckSkipped), so an
   * in-transaction audit write would commit independently of the domain BEGIN and
   * survive a rolled-back extract. Deferring lets extract persist the audit rows
   * only AFTER the mount transaction commits, keeping a rollback trace-free while
   * staying never-silent on success.
   */
  private skip(check: string, runId: string | undefined, persist = true): SkippedCheck {
    const skipped = { check, reason: 'not_built' };
    if (persist) this.store.recordCheckSkipped(check, skipped.reason, runId, this.now());
    return skipped;
  }

  private activeRunId(): string | undefined {
    return this.store.getRun()?.id;
  }

  /**
   * §3.2.3/§3.2.5 drift baseline: sha256 of each owned file currently on disk,
   * keyed by the registry's file-key extractor (feature_article files[].path;
   * reference_material kind:doc location). Computed at create/reconcile so the
   * read-time drift check can distinguish a real content change from a mere
   * mtime reset (a git merge/checkout touches every file's mtime without
   * changing content). No repoRoot, or a file absent at write time, → no entry
   * (the read-time deletion check still covers a vanished owned file).
   */
  private computeBaselines(record: Record<string, unknown>): Record<string, string> | undefined {
    if (!this.repoRoot) return undefined;
    const type = record.type as string;
    if (type !== 'feature_article' && type !== 'reference_material') return undefined;
    // Detached-working-tree resolution (comsoft-juiced 2026-07-17): a record
    // declaring working_tree hashes against ITS tree, never the project root —
    // the root's same-named files previously leaked into copy-article baselines.
    // Unmapped tree name → NO baselines (abstain; the read path flags loud).
    const { root, unresolved } = this.treeRootFor(record);
    if (unresolved || !root) return undefined;
    const baselines: Record<string, string> = {};
    for (const rel of RECORD_TYPES[type].fileKeys(record)) {
      const hash = this.hashFile(rel, root);
      if (hash !== undefined) baselines[rel] = hash;
    }
    return Object.keys(baselines).length ? baselines : undefined;
  }

  /**
   * Resolve the working tree a record's file paths live in: no working_tree →
   * the project root; a name mapped in config.working_trees → that path
   * (absolute, or joined to the project root); an UNMAPPED name → unresolved,
   * and every consumer abstains LOUD rather than resolving against the wrong
   * tree (the comsoft-juiced false-deletion class).
   */
  private treeRootFor(record: Record<string, unknown>): { root?: string; unresolved: boolean } {
    const name = (record as { working_tree?: string }).working_tree;
    if (!name) return { root: this.repoRoot, unresolved: false };
    const mapped = this.config.working_trees?.[name];
    if (!mapped) return { root: undefined, unresolved: true };
    // HOST-INDEPENDENT classification (decision windows-linux-parity):
    // config.working_trees maps a name to an absolute-OR-project-relative path
    // (decision a0fc8743), so this branch decides which. node:path's isAbsolute
    // is host-native, so the SAME config resolved differently depending on which
    // OS ran the server — 'C:\\tree' and '\\tree' read as absolute on Windows and
    // as relative on Linux, where they were then joined onto the project root.
    if (isAbsolutePathAnyHost(mapped)) return { root: mapped, unresolved: false };
    if (!this.repoRoot) return { root: undefined, unresolved: true };
    return { root: join(this.repoRoot, mapped), unresolved: false };
  }

  /**
   * Is `rel` registered as a generated projection (config.generated_projections)?
   * A generated file changes on every regen by design, so the drift check's
   * CONTENT-change arm skips it — its currency is guarded by
   * check-projection-fresh at the merge gate, not by article baselines (the
   * regen↔baseline circularity: draining the false item required an article
   * write, whose regen re-armed the detector, forever). Deletion still flags:
   * a vanished committed deliverable is real drift however it is produced.
   */
  private isGeneratedProjection(rel: string): boolean {
    return this.config.generated_projections.includes(rel);
  }

  /**
   * A file absent from the working tree may still be ALIVE on another git ref —
   * parked on an unmerged branch rather than deleted (board 1d6a721a), OR still
   * present on base because the deletion hasn't reached base yet (board
   * 07baa42b). ANCESTRY-AWARE (board 07baa42b): a missing file is PARKED iff
   * (a) it still exists on the BASE branch, or (b) it exists on a branch that
   * is NOT YET merged into base. A blob surviving ONLY on branches that are
   * fully-merged ancestors of base does NOT park — the deletion reading (base
   * no longer has it, and no unmerged work holds it either) applies instead.
   * Returns the first qualifying ref that holds it, or undefined if none does.
   *
   * ONLY CALLED ON THE ALREADY-RARE MISSING-FILE PATH, never on the hot read
   * path: shelling out per owned file per query would be a real regression, and
   * the whole point is that absence is unusual. Bounded by PARKED_REF_PROBE_CAP
   * so a repo with hundreds of stale branches cannot turn one absent file into
   * hundreds of subprocesses.
   *
   * HEAD is probed FIRST and separately: a file present in HEAD but not on disk
   * is the commonest shape (someone deleted it without committing), and catching
   * it in one call avoids walking the branch list at all. HEAD is case (a)/(b)
   * territory regardless — it is checked for blob presence exactly as before,
   * with no ancestry filtering (it's the branch currently checked out, not a
   * candidate to filter against base).
   *
   * BASE resolution: `git symbolic-ref --short refs/remotes/origin/HEAD`
   * (origin/ prefix stripped), else a local `main`, else `master`. If none of
   * those resolve, ancestry cannot be judged — fall back to today's behaviour
   * (no ancestry filtering) rather than throw or suppress. The base branch
   * itself is checked by blob presence (case (a)); every other local branch is
   * skipped when `git merge-base --is-ancestor <branch> <base>` exits 0 (fully
   * merged — case not satisfied), and checked by blob presence otherwise
   * (case (b), unmerged work).
   *
   * Every git failure degrades to PROBE_FAILED, which reads as today's
   * pre-ancestry behaviour — a reconcile_needed deletion item. That direction is
   * deliberate: a missing git, a non-repo tree root, or a corrupt ref must not
   * SUPPRESS a real deletion finding, and it must not be mistaken for a
   * CONFIRMED verdict either — the deletion_candidate lane (board e939fd21) is
   * for a file whose HISTORY (not just its live ref tips) proves it was NEVER
   * tracked anywhere this repo can reach — `git rev-list --all -- <path>`,
   * exhaustive over every ref and not subject to PARKED_REF_PROBE_CAP; a file
   * deleted from a merged-into-base ancestor DOES have history (confirmed_absent,
   * the classic reconcile_needed reading) even though no live tip holds it. A
   * probe that could not run proved nothing, so it gets the old, safer reading
   * rather than the new, more assertive one.
   */
  private parkedOnRef(rel: string, treeRoot: string): MissingFileProbe {
    const run = (args: string[]) => {
      try {
        return spawnSync('git', ['-C', treeRoot, ...args], { encoding: 'utf8', windowsHide: true });
      } catch {
        return undefined;
      }
    };
    // CONFIRM THIS IS A USABLE GIT REPO before trusting an empty scan as a real
    // verdict (board e939fd21, AC2/AC4 of file-parked-ancestry.test.ts): without
    // this, "no repo at all" and "a repo that genuinely never tracked the file"
    // both scan to nothing and were indistinguishable — the first must stay on
    // the old reconcile_needed reading, the second is what earns the new
    // deletion_candidate lane.
    const repoCheck = run(['rev-parse', '--is-inside-work-tree']);
    if (repoCheck?.status !== 0) return { status: 'probe_failed' };
    const has = (ref: string): boolean => run(['cat-file', '-e', `${ref}:${rel}`])?.status === 0;
    const resolveBase = (): string | undefined => {
      const symbolic = run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (symbolic?.status === 0 && typeof symbolic.stdout === 'string') {
        const name = symbolic.stdout.trim();
        if (name) return name.startsWith('origin/') ? name.slice('origin/'.length) : name;
      }
      const mainCheck = run(['show-ref', '--verify', '--quiet', 'refs/heads/main']);
      if (mainCheck?.status === 0) return 'main';
      const masterCheck = run(['show-ref', '--verify', '--quiet', 'refs/heads/master']);
      if (masterCheck?.status === 0) return 'master';
      return undefined;
    };
    const isMergedIntoBase = (branch: string, base: string): boolean => {
      const r = run(['merge-base', '--is-ancestor', branch, base]);
      return r?.status === 0;
    };
    try {
      if (has('HEAD')) return { status: 'parked', ref: 'HEAD' };
      const refs = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      if (refs?.status !== 0 || typeof refs.stdout !== 'string') return { status: 'probe_failed' };
      const branches = refs.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, PARKED_REF_PROBE_CAP);
      const base = resolveBase();
      if (base === undefined) {
        for (const b of branches) {
          if (has(b)) return { status: 'parked', ref: b };
        }
      } else {
        for (const b of branches) {
          if (!has(b)) continue;
          if (b === base) return { status: 'parked', ref: b }; // case (a): base itself still has it
          if (isMergedIntoBase(b, base)) continue; // fully merged into base — not a park
          return { status: 'parked', ref: b }; // case (b): unmerged branch still holds it
        }
      }
      // NOT parked on any ref TIP scanned. A tip-only scan cannot tell "deleted,
      // but real git history exists" (confirmed_absent — the classic, closeable
      // reconcile_needed case: file-parked-ancestry.test.ts AC2, a blob
      // surviving only as a merged-into-base ancestor) from "never existed at
      // all" (never_tracked — the new deletion_candidate lane, board e939fd21).
      // HISTORY, not tips, answers that: one exhaustive `git rev-list --all --
      // <path>` walks every commit reachable from EVERY ref (branches, tags,
      // remote-tracking — not just refs/heads) and is NOT bounded by
      // PARKED_REF_PROBE_CAP the way the tip scan above is (fixer round 2,
      // findings 1+2 — the two collapse into one fix: never_tracked no longer
      // depends on the capped per-ref tip loop at all, so a truncated tip scan
      // can only ever under-detect a live PARK — an already-accepted, documented
      // degrade (decision 30d18443: a failed or bounded probe must never SUPPRESS
      // a real deletion finding) — never inflate into a false never_tracked).
      // One subprocess per already-rare missing file is the accepted cost here.
      const history = run(['rev-list', '--all', '--', rel]);
      if (history?.status !== 0 || typeof history.stdout !== 'string') return { status: 'probe_failed' };
      return { status: history.stdout.trim().length > 0 ? 'confirmed_absent' : 'never_tracked' };
    } catch {
      return { status: 'probe_failed' };
    }
  }

  /**
   * board-provenance-measured-at-head: one shared, swallowing git runner —
   * the same spawn pattern parkedOnRef already uses (never throws; a failure
   * or absent git surfaces as `undefined`, and every caller here decides for
   * itself what an absent result means for ITS disclosure).
   */
  private runGit(treeRoot: string, args: string[]): { status: number | null; stdout: string } | undefined {
    try {
      const r = spawnSync('git', ['-C', treeRoot, ...args], { encoding: 'utf8', windowsHide: true });
      return { status: r.status, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
    } catch {
      return undefined;
    }
  }

  /** Current HEAD's full 40-hex sha in `treeRoot`, or undefined if git/the tree is unavailable (board-provenance-measured-at-head: what board_add/board_update stamp measured_at_head with). */
  private currentHeadSha(treeRoot: string | undefined): string | undefined {
    if (!treeRoot) return undefined;
    const r = this.runGit(treeRoot, ['rev-parse', 'HEAD']);
    if (!r || r.status !== 0) return undefined;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }

  /**
   * Does `sha` resolve to a real commit in `treeRoot`? Used to refuse a
   * caller-supplied measured_at_head BY NAME rather than silently replacing
   * it with HEAD (P5, decision board-provenance-measured-at-head) — the exact
   * inverse of parkedOnRef's swallow-to-undefined direction, because here an
   * unresolvable value is a caller error that must be reported, not degraded
   * past.
   */
  private shaResolves(sha: string, treeRoot: string | undefined): boolean {
    if (!treeRoot) return false;
    const r = this.runGit(treeRoot, ['cat-file', '-e', `${sha}^{commit}`]);
    return r?.status === 0;
  }

  /**
   * board-provenance-measured-at-head: bounded `git log` walks per board_query
   * call — never per item, which is the decision's whole point. ONE walk for the
   * KEYED lane (`--name-only`, path-touch counts) and, only when the page holds
   * keyless measured items, ONE more names-free walk for their distance
   * annotation; the two are deliberately separate so the keyless lane can never
   * change a keyed verdict or the envelope value (see the FIX 6 note in the body
   * and provenanceWalk).
   *
   * FIX F1 (review 2026-08-24): the walk is RANGE-BOUNDED by the OLDEST
   * eligible item's measured_at_head, not an unconditional HEAD-relative cap
   * — `<oldestBase>^..HEAD` (backstopped by `-n PROVENANCE_WALK_COMMIT_CAP+1`
   * so a query never pays for history no returned item's evidence predates).
   * Finding the oldest base costs exactly ONE extra subprocess regardless of
   * how many eligible items there are: `git rev-list --no-walk --timestamp
   * <every unique sha>` resolves each sha's commit time directly (no
   * traversal), and the minimum timestamp names the oldest — cheaper than N
   * `merge-base --is-ancestor` calls and cheaper than walking full history to
   * derive it. If that resolution fails for any reason (unexpected — every
   * stored sha was validated resolvable at write time) or `<oldestBase>^`
   * itself doesn't exist (oldestBase is the repo's root commit), the walk
   * falls back to the unbounded-range `-n cap HEAD` form — the cap stays the
   * backstop either way (never a silent unbounded walk).
   *
   * For every record carrying both file_keys and a (40-hex) measured_at_head,
   * counts — in JS, over this single walk — how many of the commits STRICTLY
   * NEWER than its measured_at_head touched one of its file_keys.
   *
   * FIX F3: a sha genuinely absent from the walked range (rebased away, or a
   * non-ancestor of HEAD) previously skipped SILENTLY while the envelope
   * still reported 'checked' — a missing warning read as fresh, the exact P5
   * inversion the whole feature exists to avoid. It now ALWAYS gets a visible
   * per-item note rather than being dropped.
   *
   * Never throws: an absent/failing git, a non-repo tree, or nothing eligible
   * all degrade to a disclosed 'unavailable:<reason>'.
   */
  private computeProvenance(
    records: DurableRecord[],
    treeRoot: string | undefined
  ): { status: string; warnings: Map<string, { full: string; short: string }> } {
    const warnings = new Map<string, { full: string; short: string }>();
    const all = records as unknown as Record<string, unknown>[];
    const hasFileKeys = (r: Record<string, unknown>) => {
      const fk = r.file_keys as string[] | undefined;
      return Array.isArray(fk) && fk.length > 0;
    };
    const hasValidHead = (r: Record<string, unknown>) => {
      const head = r.measured_at_head as string | undefined;
      return typeof head === 'string' && /^[0-9a-f]{40}$/.test(head);
    };
    const withFileKeys = all.filter(hasFileKeys);
    // KEYLESS ITEMS ARE ANNOTATED TOO (board ab5ef216, decision
    // queue-truth-at-read-annotation-design §4): a keyless item's evidence still
    // ages, and excluding it meant the one item that can say NOTHING about paths
    // also said nothing about its own age — the absence a reader most easily
    // misreads as freshness (P5).
    //
    // BUT STRICTLY ADDITIVELY (review FIX 6, 2026-08-31). The broadening first
    // shipped by widening THE SHARED eligibility set, which is not additive: a
    // keyless sha joined the oldest-base selection and the single walk, so an
    // older keyless base could widen the range past PROVENANCE_WALK_COMMIT_CAP,
    // flip the shared `walkTruncated` flag, and thereby change a KEYED item's
    // verdict ('not an ancestor of HEAD' → 'walk cap reached', or a real count →
    // no count at all) plus the envelope's own provenance value
    // ('checked' → 'unavailable:walk_cap'). The keyed lane's verdicts and the
    // envelope value are therefore computed from the ORIGINAL keyed-only
    // eligibility, over their own walk, exactly as before the broadening; the
    // keyless distances ride a SEPARATE bounded walk whose truncation is
    // disclosed per item and never touches the keyed lane or the envelope.
    const keyed = all.filter((r) => hasFileKeys(r) && hasValidHead(r));
    const keyless = all.filter((r) => !hasFileKeys(r) && hasValidHead(r));
    if (!treeRoot) return { status: 'unavailable:no_repo_root', warnings };
    const headCheck = this.runGit(treeRoot, ['rev-parse', 'HEAD']);
    if (!headCheck || headCheck.status !== 0) return { status: 'unavailable:no_git', warnings };
    const branchCheck = this.runGit(treeRoot, ['symbolic-ref', '-q', 'HEAD']);
    if (!branchCheck || branchCheck.status !== 0) return { status: 'unavailable:detached_head', warnings };
    // FIX F2: distinguish "nothing here even carries file_keys" from "file_keys
    // exist but none of them have been stamped yet" — different remedies. Both
    // reasons report on the same NOTHING-TO-CHECK case: with no annotatable item
    // at all there is no walk to run, and the reason names which of the two
    // inputs was missing.
    if (keyed.length === 0 && keyless.length === 0) {
      return { status: withFileKeys.length === 0 ? 'unavailable:no_file_keys' : 'unavailable:no_measured_items', warnings };
    }
    // The CURRENT tip, for the keyless distance wording below — the reader needs
    // the sha the distance is measured TO, and it is already in hand.
    const headShaNow = headCheck.stdout.trim();
    const headNow8 = /^[0-9a-f]{40}$/.test(headShaNow) ? headShaNow.slice(0, 8) : headShaNow;

    // ---- THE KEYED LANE: byte-identical to the pre-broadening behaviour ----
    let capHit = false;
    if (keyed.length) {
      const keyedWalk = this.provenanceWalk(
        treeRoot,
        keyed.map((r) => r.measured_at_head as string),
        true
      );
      if (!keyedWalk) return { status: 'unavailable:no_git', warnings };
      const { commits, truncated: walkTruncated } = keyedWalk;
      for (const rec of keyed) {
        const fileKeys = rec.file_keys as string[];
        const head = rec.measured_at_head as string;
        const id = rec.id as string;
        const idx = commits.findIndex((c) => c.sha === head);
        if (idx === -1) {
          // F3: never silently skip — the sha is either older than a truncated
          // window (cap genuinely hit) or not on HEAD's ancestry at all
          // (rebased/orphaned); either way the count cannot be trusted, so say
          // so on the item rather than reporting nothing.
          if (walkTruncated) capHit = true;
          const reason = walkTruncated ? 'walk cap reached' : 'not an ancestor of HEAD';
          warnings.set(id, {
            full: `⚠ measured_at_head ${head.slice(0, 7)} not found in the walked history (${reason}) — re-verify`,
            // OUTSIDE-MODEL FINDING 3 (headline stays compact): no sha/reason detail.
            short: ` ⚠not verifiable — re-verify`,
          });
          continue;
        }
        const count = commits.slice(0, idx).filter((c) => c.files.some((f) => fileKeys.includes(f))).length;
        if (count > 0) {
          warnings.set(id, {
            full: `⚠ file_keys changed in ${count} commits since this item's evidence was measured (${head.slice(0, 7)})`,
            // OUTSIDE-MODEL FINDING 3 (2026-08-24): appending the full sentence
            // after headlineRecord's clip broke headline's compact-line contract
            // (an 80-char line became 170+ chars, multiline). Headline gets a
            // short marker instead; digest/full keep the full sentence.
            short: ` ⚠${count} commits since measured`,
          });
        }
      }
    }

    // ---- THE KEYLESS LANE: its own walk, its own truncation, ADDITIVE ONLY ----
    // KEYLESS DISTANCE (board ab5ef216): with no file_keys there is no
    // path-touch count to compute, so the item gets the one thing a walk CAN say
    // about it — how far behind HEAD its evidence was measured. AN AGE SIGNAL,
    // NEVER CALLED STALENESS: commits that touched nothing this item cares about
    // still move the number, so the annotation asks for re-verification rather
    // than asserting anything about the item's content. Zero distance says so
    // plainly instead of dressing "no drift" up as a measurement.
    //
    // Names are NOT requested here (no path counting to do), and this walk's own
    // truncation is disclosed PER ITEM only — it deliberately never feeds
    // `capHit`, because the envelope's provenance value describes the keyed
    // path-level check (review FIX 6).
    if (keyless.length) {
      const keylessWalk = this.provenanceWalk(
        treeRoot,
        keyless.map((r) => r.measured_at_head as string),
        false
      );
      for (const rec of keyless) {
        const head = rec.measured_at_head as string;
        const id = rec.id as string;
        const idx = keylessWalk ? keylessWalk.commits.findIndex((c) => c.sha === head) : -1;
        if (idx === -1) {
          // Same P5 posture as the keyed lane's F3 arm: never silently skip. A
          // failed walk is its own named reason rather than an absent annotation.
          const reason = !keylessWalk ? 'git walk unavailable' : keylessWalk.truncated ? 'walk cap reached' : 'not an ancestor of HEAD';
          warnings.set(id, {
            full: `⚠ measured_at_head ${head.slice(0, 7)} not found in the walked history (${reason}) — re-verify`,
            short: ` ⚠not verifiable — re-verify`,
          });
          continue;
        }
        warnings.set(id, {
          full:
            idx === 0
              ? `ℹ measured at current HEAD (${headNow8}) — no file_keys, path-level provenance unavailable; re-verify any absence claim before acting`
              : // The decision's verbatim wording. Plural 'commits' at every N,
                // deliberately: the phrase is quoted as-is by the pins and by the
                // decision, and a singular special case would make the one
                // reader who greps for it miss exactly the N=1 case.
                `⚠ measured ${idx} commits before HEAD at ${headNow8} — no file_keys, path-level provenance unavailable; re-verify any absence claim before acting`,
          // Headline keeps its compact line (OUTSIDE-MODEL FINDING 3) while
          // still carrying the phrase a reader greps for.
          short: idx === 0 ? ` ℹmeasured at current HEAD` : ` ⚠measured ${idx} commits before HEAD`,
        });
      }
    }
    // THE ENVELOPE VALUE IS THE KEYED LANE'S (review FIX 6): with no keyed item
    // on the page the path-level check had nothing to run, and its reason is
    // exactly the one it reported before keyless items were annotated at all.
    if (keyed.length === 0) {
      return { status: withFileKeys.length === 0 ? 'unavailable:no_file_keys' : 'unavailable:no_measured_items', warnings };
    }
    return { status: capHit ? 'unavailable:walk_cap' : 'checked', warnings };
  }

  /**
   * ONE bounded `git log` walk over the range that covers every sha in `shas`,
   * newest-first. Extracted (review FIX 6, 2026-08-31) so the keyed and keyless
   * lanes can each have their OWN walk: sharing one walk meant a keyless sha's
   * range could flip the keyed lane's truncation flag and, through it, both a
   * keyed item's verdict and the envelope's provenance value.
   *
   * Every command, flag and ordering below is unchanged from the single-walk
   * version, so the keyed lane — handed exactly the shas it was handed before —
   * gets byte-identical results.
   *
   * F1 / OUTSIDE-MODEL FINDING 1 (2026-08-24, repro d5b84e6→3ef9fbc): resolve
   * the oldest base topologically, never by commit TIMESTAMP — a child and its
   * parent can share a timestamp, which made the CHILD "oldest" and excluded the
   * PARENT's range entirely, falsely reporting the parent's sha as "not in
   * current history". `git merge-base --octopus <shas>` returns a commit
   * reachable from EVERY given base — an ancestor of all of them by construction
   * — so `<that>^..HEAD` is guaranteed to cover every base's range regardless of
   * commit-time skew. Pre-filter to shas that actually resolve (rev-list
   * --ignore-missing) first: merge-base refuses outright if handed one that
   * doesn't, and one rebased-away sha must not poison the whole batch back to
   * the unbounded walk.
   *
   * Returns undefined when git could not be walked at all (the caller's
   * 'unavailable:no_git' / per-item disclosure decision, never a throw).
   */
  private provenanceWalk(
    treeRoot: string,
    shas: string[],
    withNames: boolean
  ): { commits: { sha: string; files: string[] }[]; truncated: boolean } | undefined {
    const uniqueShas = [...new Set(shas)];
    let oldestBase: string | undefined = uniqueShas.length === 1 ? uniqueShas[0] : undefined;
    if (uniqueShas.length > 1) {
      const resolveCheck = this.runGit(treeRoot, ['rev-list', '--no-walk', '--ignore-missing', ...uniqueShas]);
      const resolvableShas =
        resolveCheck && resolveCheck.status === 0
          ? resolveCheck.stdout
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => /^[0-9a-f]{40}$/.test(l))
          : [];
      if (resolvableShas.length === 1) {
        oldestBase = resolvableShas[0];
      } else if (resolvableShas.length > 1) {
        const mb = this.runGit(treeRoot, ['merge-base', '--octopus', ...resolvableShas]);
        const candidate = mb && mb.status === 0 ? mb.stdout.trim() : '';
        if (/^[0-9a-f]{40}$/.test(candidate)) oldestBase = candidate;
      }
      // Any failure above (missing/unrelated histories/no common ancestor)
      // leaves oldestBase undefined — the walk below falls back to the
      // unbounded-range/-n-cap-backstop form (never a throw).
    }

    // The `-n` request asks for one MORE than the disclosed cap so a
    // cap-truncated walk is detectable by comparing the RETURNED count
    // against the cap (F4 — `commits.length < CAP` misreads a repo with
    // EXACTLY `CAP` commits as truncated; requesting CAP+1 and trimming the
    // lookahead entry fixes the off-by-one instead of guessing at it).
    // --no-renames (OUTSIDE-MODEL FINDING 2, repro 644b46e): --name-only's
    // default rename detection reports only the NEW path for a renamed file,
    // so an item keyed to the path it was renamed FROM never saw its own
    // change. --no-renames reports both the old and new paths as plain
    // add/delete entries. A names-free walk (the keyless lane, which counts
    // commits rather than path touches) asks for neither flag and parses the
    // same way — every line is a sha.
    const requestCap = PROVENANCE_WALK_COMMIT_CAP + 1;
    const nameArgs = withNames ? ['--no-renames', '--name-only'] : [];
    const logArgs = ['log', ...nameArgs, '--format=%H', '-n', String(requestCap)];
    const rangedWalk = oldestBase ? this.runGit(treeRoot, [...logArgs, `${oldestBase}^..HEAD`]) : undefined;
    const walk = rangedWalk && rangedWalk.status === 0 ? rangedWalk : this.runGit(treeRoot, [...logArgs, 'HEAD']);
    if (!walk || walk.status !== 0) return undefined;
    const commits: { sha: string; files: string[] }[] = [];
    for (const raw of walk.stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[0-9a-f]{40}$/.test(line)) {
        commits.push({ sha: line, files: [] });
      } else if (commits.length) {
        commits[commits.length - 1].files.push(line);
      }
    }
    const truncated = commits.length > PROVENANCE_WALK_COMMIT_CAP;
    if (truncated) commits.length = PROVENANCE_WALK_COMMIT_CAP; // drop the CAP+1'th lookahead entry
    return { commits, truncated };
  }

  /**
   * TRUTH AT READ for the reconcile_needed lane (decision
   * queue-truth-at-read-annotation-design; boards be0ea20a HIGH + ab5ef216).
   *
   * THE MEASURED PROBLEM: the reconcile lane is minted by the READ path
   * (research_finding f512020b), so READ VOLUME — not drift volume — drives the
   * queue, and 12 of 14 lane items measured stale-open: the drift they name had
   * already been reconciled away, and nothing said so. A drainer had to
   * re-derive each item's premise by hand, which is exactly the cost that makes
   * a queue get skipped.
   *
   * WHAT THIS DOES: for the reconcile_needed rows ON THIS PAGE, re-run the SAME
   * per-file predicate the mint uses (classifyOwnedFileDrift) against the live
   * working tree, and annotate the verdict. Composition, per the decision:
   *   - ANY path still reconciling ⇒ the item reproduces ⇒ NO annotation (a
   *     reproducing item is the normal case and needs no decoration);
   *   - EVERY path clean AND fully evaluated ⇒ the stale annotation;
   *   - ANY required check abstained (or was cut off by the budget) ⇒
   *     `unavailable`, NEVER stale. An overflow item is never declared stale on
   *     a partial check — the whole failure mode this closes is an absence being
   *     read as a positive claim.
   *
   * WORKING-TREE WORDING, deliberately: the predicate reads TREE bytes, not the
   * committed tree, so the annotation says "in the working tree at HEAD <sha8>"
   * rather than implying anything about the commit. A mapped working tree is
   * judged against THAT tree's own HEAD.
   *
   * NEVER CLOSURE AUTHORITY. Decision 68988832's rejection of auto-closure and
   * auto-drain STANDS: this is a best-effort READ annotation that makes a human
   * drain cheap, and it writes nothing (a read is a pure function here — AC2
   * pins two identical reads producing identical records).
   *
   * SCOPE: source:'system' + system_reason:'reconcile_needed' rows only, so a
   * source:'user' board_query pays ZERO drift-recompute cost. Implemented at the
   * ONE shared seam (boardQueryResult) that maintenance_query already delegates
   * to — the rejected alternative, annotating only the drain surface, would have
   * left board_query's system rows disagreeing with maintenance_query's about
   * whether the same row is a closeable no-op.
   */
  private reconcileTruthAtRead(records: DurableRecord[]): {
    status: string;
    annotations: Map<string, { full: string; short: string }>;
  } {
    const annotations = new Map<string, { full: string; short: string }>();
    const lane = (records as unknown as Record<string, unknown>[]).filter(
      (r) => r.source === 'system' && r.system_reason === 'reconcile_needed'
    );
    // An ABSENT annotation is never a freshness claim (P5), so every reason a
    // check could not run is named — including "there was nothing on this page
    // to check", which is the reason a silent field would misrepresent as fine.
    if (lane.length === 0) return { status: 'unavailable:no_reconcile_items', annotations };
    if (!this.repoRoot) return { status: 'unavailable:no_repo_root', annotations };
    const budget: DriftBudget = { attempts: 0, bytesHashed: 0, gitProbes: 0, truncated: false, memo: new Map() };
    // PER-TREE HEAD, resolved once per distinct tree (review FIX 2, 2026-08-31).
    // Classification reads the RESOLVED tree's bytes, so both the git-availability
    // gate and the sha the annotation names must come from THAT tree — the
    // decision says so in as many words ("mapped working trees use THAT tree's
    // HEAD"). Reading them from the project root instead meant a mapped-tree item
    // was judged against one tree and stamped with another tree's HEAD, and a
    // mapped tree that is not a git repo at all passed a gate the project root
    // happened to satisfy.
    const headByTree = new Map<string, string | undefined>();
    const headFor = (root: string): string | undefined => {
      if (!headByTree.has(root)) headByTree.set(root, this.currentHeadSha(root));
      return headByTree.get(root);
    };
    for (const item of lane) {
      const id = item.id as string;
      const abstain = (reason: string) => annotations.set(id, this.reconcileUnavailableAnnotation([reason]));
      // BUDGET AXIS 1, PAGE-WIDE STOP (review FIX 4, 2026-08-31): once the
      // attempt counter has parked at the cap, NOTHING further is spent on this
      // page — no article resolution, no memo-key construction, no memo write, no
      // per-path verdict allocation. file_keys carries no schema cardinality cap,
      // so an adversarial or merely enormous item bounds I/O through the
      // classifier's own axes but would still have paid CPU and allocation per
      // path here. Every remaining item is disclosed as unavailable:budget, which
      // is the same verdict it would have received one layer down (AC6: the item
      // that blew the budget and the small item behind it are BOTH disclosed).
      if (budget.attempts >= RECONCILE_RECHECK_FILE_ATTEMPT_CAP) {
        budget.truncated = true;
        abstain('budget');
        continue;
      }
      const link = item.feature_link as string | undefined;
      if (!link) {
        abstain('no_feature_link');
        continue;
      }
      const article = this.liveArticleFor(link);
      if (!article) {
        abstain('article_unresolved');
        continue;
      }
      const tree = this.treeRootFor(article);
      if (tree.unresolved || !tree.root) {
        abstain('unmapped_working_tree');
        continue;
      }
      // GIT AVAILABILITY IS PER TREE (review FIX 2). No resolvable HEAD in the
      // tree actually being read means the annotation could not even NAME the
      // state it was measured at, which is half of what makes it re-checkable.
      const head = headFor(tree.root);
      if (!head) {
        abstain('no_git');
        continue;
      }
      const paths = (item.file_keys as string[] | undefined) ?? [];
      if (paths.length === 0) {
        // A keyless reconcile item names no path to re-check. The keyless
        // measured_at_head DISTANCE annotation (computeProvenance) still covers
        // it — a different check, disclosed separately.
        abstain('no_file_keys');
        continue;
      }
      const baselines = (article as unknown as { file_baselines?: Record<string, string> }).file_baselines;
      const version = (article as unknown as { version?: number }).version ?? 0;
      const verdicts: DriftVerdict[] = [];
      for (const path of paths) {
        // PAGE-WIDE STOP, again (review FIX 4): the attempt counter parks at the
        // cap, so once it is exhausted this item stops allocating per-path work
        // and rides ONE unavailable:budget verdict into the composition below —
        // the same verdict the classifier would return one layer down, without
        // the per-path memo key and Map write. file_keys has no schema
        // cardinality cap, so CPU and allocation have to be bounded here, not
        // only I/O.
        if (budget.attempts >= RECONCILE_RECHECK_FILE_ATTEMPT_CAP) {
          budget.truncated = true;
          verdicts.push({ kind: 'unavailable', reason: 'budget' });
          break;
        }
        // PER-CALL MEMOIZATION by (resolved tree, article version, path):
        // sibling items under one article — the ordinary shape, since the mint
        // splits one article's drift into one item per file — re-ask about the
        // same paths, and a memo hit costs no budget. NO POLICY DISCRIMINATOR IS
        // NEEDED any more (review FIX 1): the recheck runs exactly ONE policy (it
        // always hashes), and this memo is per CALL and reachable only from this
        // method — the mint passes no budget, so its prefilter-honouring verdicts
        // can neither enter nor read this map.
        //
        // INJECTIVE key by construction (Codex re-review 01a0576f): a separator
        // can never be impossibility-proof here because normalizeRepoPath and
        // working_trees permit ANY byte in a path, \x1F included — so crafted
        // (treeRoot, path) tuples could collide a separator-joined key.
        // JSON.stringify of the tuple is injective for arbitrary strings.
        const key = JSON.stringify([tree.root, article.id, version, path]);
        const cached = budget.memo.get(key);
        if (cached) {
          verdicts.push(cached);
          continue;
        }
        // THE RECHECK ALWAYS HASHES (review FIX 1, 2026-08-31 — REPLACING the
        // 'licensed prefilter' this call site first shipped with). The licence was
        // "the article was re-baselined after this item was minted", and it does
        // not hold: drift lands, an unrelated article write re-baselines every
        // owned file, then a second edit whose mtime is preserved (a copy, a
        // restore, clock skew) sits at or below updated_at and short-circuits to
        // `clean`. At the MINT `clean` raises nothing; HERE it is the affirmative
        // claim "the drift no longer reproduces", which is precisely the P5
        // inversion this feature exists to close. So the prefilter's terminating
        // power stays where its inference is sound — the mint — and the recheck
        // pays the hash, bounded by the attempt and byte axes.
        const { verdict } = this.classifyOwnedFileDrift(
          path,
          { mode: 'recheck', treeRoot: tree.root, baselines, baselinedAt: article.updated_at, honorMtimePrefilter: false },
          budget
        );
        budget.memo.set(key, verdict);
        verdicts.push(verdict);
      }
      // ANY path still reconciling wins outright — never a first-path-wins or
      // all-paths-must-differ rule (a whole-area change reconciles one file at a
      // time, so a single live difference means the item still has work in it).
      if (verdicts.some((v) => v.kind === 'reconcile' || v.kind === 'deletion_candidate')) continue;
      const reasons = [
        ...new Set(verdicts.filter((v) => v.kind === 'unavailable' || v.kind === 'parked').map((v) => (v.kind === 'unavailable' ? v.reason : 'parked_on_branch'))),
      ].sort();
      if (reasons.length) {
        annotations.set(id, this.reconcileUnavailableAnnotation(reasons));
        continue;
      }
      const sha8 = head.slice(0, 8);
      annotations.set(id, {
        full:
          `⚠ TRUTH AT READ: the drift this item names no longer reproduces in the working tree at HEAD ${sha8} — ` +
          `every path it names matches the live article's recorded baseline, so this is very likely a closeable no-op. ` +
          `A BEST-EFFORT READ CHECK, NEVER CLOSURE AUTHORITY: confirm it yourself, then close it by NAMING it in a write's ` +
          `resolves claim (or maintenance_remove) — nothing here closes anything. CONFIRM WHAT "MATCHES" MEANS HERE: a later ` +
          `article write RE-BASELINES every file that article owns, so a re-baseline can absorb a drift whose PROSE was never ` +
          `reconciled — the bytes agreeing with the recorded baseline does not prove the article still describes them.`,
        short: ` ⚠no longer reproduces in the working tree at HEAD ${sha8}`,
      });
    }
    // The budget's truncation rides the STATUS, not only a note: a page that
    // could not finish its own check must not report the same word as one that
    // did (P5), and the per-item `unavailable:budget` reasons above are the
    // detail behind it.
    return { status: budget.truncated ? 'checked:budget_truncated' : 'checked', annotations };
  }

  /** The one wording for a reconcile item whose drift could not be re-checked — named reasons, never a shrug. */
  private reconcileUnavailableAnnotation(reasons: string[]): { full: string; short: string } {
    const joined = reasons.join(', ');
    return {
      full:
        `⚠ TRUTH AT READ: this item's drift could NOT be re-checked (unavailable:${joined}) — treat it as OPEN and re-verify by hand. ` +
        `An absent verdict is never a freshness claim (P5); in particular 'budget' means this page's re-check ran out of its own ` +
        `cost allowance, not that the item is clean.`,
      short: ` ⚠not re-checkable (unavailable:${joined})`,
    };
  }

  /**
   * The LIVE feature_article a queue item's feature_link points at, following the
   * supersede chain to its head (decision queue-truth-at-read-annotation-design:
   * "legacy feature_links resolve through the supersede chain to the LIVE
   * article's baselines").
   *
   * WHY THE WALK MATTERS: an item minted against an article that was later
   * superseded still points at the DEAD id, and a dead predecessor's baselines
   * are stale or (for a raw legacy insert) absent entirely — comparing against
   * them would report a drift that reproduces perfectly well against the live
   * article, or abstain where a real verdict was available.
   *
   * Returns undefined when the link resolves to nothing, or to something that is
   * not a feature_article — an abstention, never a guess. store.get() (not the
   * id-resolution ladder) deliberately: a feature_link is a full uuid written by
   * the mint, and a READ path must not throw on a broken pointer.
   *
   * IT MUST TERMINATE ON A LIVE ARTICLE OR ABSTAIN (review FIX 3, 2026-08-31).
   * The first implementation exited the walk on a BROKEN chain — a superseded
   * record with no superseded_by, a successor missing from the store, a
   * self-loop, a cycle — and then returned that last node merely because its
   * type was feature_article. The whole reason for walking is that a DEAD
   * predecessor's baselines are stale or absent, so handing one back is worse
   * than abstaining: it produces a full verdict (including the affirmative "no
   * longer reproduces" claim) from bytes nothing current was ever compared
   * against. Every abnormal shape now returns undefined, and the caller's
   * `unavailable:article_unresolved` disclosure is what the reader sees.
   */
  private liveArticleFor(link: string): DurableRecord | undefined {
    let record = this.store.get(link);
    // Bounded AND cycle-guarded: a torn store degrades to an abstention rather
    // than spinning a read forever. The hop cap is a second, shape-independent
    // backstop — the `seen` set already catches a cycle, but a pathological
    // (or maliciously long) chain must not be walked at read time either.
    const seen = new Set<string>();
    let hops = 0;
    while (record && record.status === 'superseded') {
      if (hops++ >= LIVE_ARTICLE_CHAIN_HOP_CAP) return undefined;
      if (!record.superseded_by || seen.has(record.id)) return undefined;
      seen.add(record.id);
      const next = this.store.get(record.superseded_by);
      if (!next || next.id === record.id) return undefined;
      record = next;
    }
    // Both conditions, not just the type: only a LIVE article's baselines
    // describe the bytes a current read should be compared against.
    return record && record.type === 'feature_article' && record.status === 'active' ? record : undefined;
  }

  /**
   * Does this files[] entry's own ROLE TEXT disclaim ownership of the path
   * (board b7269100 / feedback §2.10)?
   *
   * The degenerate case a consuming project found: an article owns a 2717-line
   * file and its own role text says the entry is HISTORICAL — a leftover from
   * proving something once — then redirects the reader to three other articles
   * for the file's actual behaviour. So it owns a file it makes no claims about,
   * and every future edit to that file, for any reason, enqueues an already-paid
   * no-op against it. Forever, by construction, and nothing noticed.
   *
   * Detection is a HINT, so it is tuned for precision over recall: only phrases
   * that state the entry is not really this article's business count. A false
   * positive would tell someone to drop a path they actually own, which is the
   * expensive direction, so borderline wording is deliberately left undetected.
   */
  private disclaimsOwnership(role: string | undefined): boolean {
    if (!role) return false;
    return [
      /\bhistorical\b/i,
      /\bleftover\b/i,
      /\bno longer (?:owns?|describes?|governs?|relevant)\b/i,
      /\bnot (?:the )?(?:owner|owned|this article's)\b/i,
      /\bsee .{0,40}\bfor (?:the )?(?:actual|real)\b/i,
      /\bmakes no claims?\b/i,
      /\bvestigial\b/i,
    ].some((re) => re.test(role));
  }

  /** sha256 of a file's bytes under the given tree root, or undefined if it cannot be read. */
  private hashFile(rel: string, root: string | undefined = this.repoRoot): string | undefined {
    if (!root) return undefined;
    try {
      return createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
    } catch {
      return undefined;
    }
  }

  /**
   * Has the file at `rel` actually changed since its recorded baseline? mtime
   * has already said "maybe" (the cheap pre-filter); this is the authoritative
   * content check that suppresses the false positives a git merge/checkout
   * produces by resetting mtimes without changing content. No baseline for the
   * file (a record written before this wire, or a file absent at write time) →
   * returns FALSE: mtime alone is a proven-unreliable signal, so the check
   * ABSTAINS rather than raise a flag it cannot stand behind. The baseline is
   * established on the next create/reconcile; H7 covers every governed edit
   * meanwhile. An unreadable file also abstains (no fabricated flag).
   */
  private contentChanged(rel: string, baselines: Record<string, string> | undefined, root: string | undefined = this.repoRoot): boolean {
    const baseline = baselines?.[rel];
    if (baseline === undefined) return false;
    const current = this.hashFile(rel, root);
    if (current === undefined) return false;
    return current !== baseline;
  }

  /**
   * THE ONE per-owned-file drift classifier (decision
   * queue-truth-at-read-annotation-design, predicate half). The read-time MINT
   * (knowledgeQuery's feature-article wire) and the queue's TRUTH-AT-READ
   * annotation (reconcileTruthAtRead) both call THIS — a second implementation
   * at the annotation site was explicitly rejected: "the mint predicate is seven
   * coupled checks, not a hash compare; a copy drifts from the mint and the
   * annotation then lies about what a fresh read would do".
   *
   * THE SEVEN CHECKS, in this order (the mint's original order, preserved so its
   * decisions are byte-identical before and after the extraction):
   *   1. working-tree resolution — done by the CALLER (treeRootFor), because an
   *      unmapped tree abstains for the whole record, not per file;
   *   2. existence (stat) — absence is not deletion, so it routes to (3);
   *   3. missing-file classification via parkedOnRef: parked / never_tracked
   *      (deletion_candidate) / confirmed_absent+probe_failed (reconcile);
   *   4. the stat-first MTIME PREFILTER — the cheap "could this have changed at
   *      all" gate that keeps a re-baselined file from being hashed;
   *   5. generated-projection exclusion (regen churn is by design);
   *   6. baseline availability;
   *   7. the authoritative content hash against that baseline.
   *
   * MODE DIFFERS IN EXACTLY TWO PLACES, both marked `MODE:` below, because the
   * two callers ask different questions of the same bytes (see DriftCheckMode).
   * Everything else — including which verdict each git probe status earns — is
   * shared, which is the whole point of the extraction.
   *
   * NEVER THROWS and never writes: every failure is a named `unavailable`.
   */
  private classifyOwnedFileDrift(rel: string, ctx: DriftCheckContext, budget?: DriftBudget): OwnedFileDrift {
    // BUDGET AXIS 1 — attempts. Checked BEFORE the stat so the cap bounds the
    // syscall fan-out itself, and NOT incremented on the refusal path, so the
    // counter parks at the cap and every later item reads the same exhausted
    // budget (AC6: the item that blew the budget and the small item behind it
    // are BOTH disclosed, not just the first).
    if (budget && budget.attempts >= RECONCILE_RECHECK_FILE_ATTEMPT_CAP) {
      budget.truncated = true;
      return { verdict: { kind: 'unavailable', reason: 'budget' } };
    }
    if (budget) budget.attempts++;
    const baseline = ctx.baselines?.[rel];
    // THE STAT IS WRAPPED (review FIX 5, 2026-08-31): throwIfNoEntry:false only
    // silences ENOENT. EACCES (an unreadable directory on the path), ELOOP (a
    // symlink cycle), ENOTDIR and ENAMETOOLONG all still THROW — and an
    // exception here does not fail one path, it escapes this method's
    // NEVER-THROWS contract and aborts the whole board/maintenance read for
    // every item on the page. Any stat failure is a named abstention instead;
    // the mint reads `unavailable` exactly as it reads `clean`, so its behaviour
    // is unchanged, and the annotation site discloses the class.
    let stat: { size: number; mtimeMs: number } | undefined;
    try {
      stat = statSync(join(ctx.treeRoot, rel), { throwIfNoEntry: false }) ?? undefined;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      return { verdict: { kind: 'unavailable', reason: `stat_failed_${String(code ?? 'unknown').toLowerCase()}` } };
    }
    if (!stat) {
      // MODE (1/2) — A MISSING FILE WITH NO BASELINE.
      // The mint asks whether the article's OWNERSHIP claim is still true, so an
      // absent owned path is a finding regardless of baselines (that is what
      // mints the deletion_candidate / out-of-band-deletion items, board
      // e939fd21). The recheck asks whether an ALREADY-RECORDED drift still
      // reproduces — and with no recorded bytes for the path there is nothing
      // to reproduce AGAINST, so the honest answer is abstention, not a verdict.
      // Abstaining first also spares the git probe entirely.
      if (ctx.mode === 'recheck' && baseline === undefined) {
        return { verdict: { kind: 'unavailable', reason: 'no_baseline' } };
      }
      // BUDGET AXIS 3 — git probes. parkedOnRef shells out per absent path, so
      // it gets its own axis: a page full of missing files must not turn into
      // hundreds of subprocesses.
      if (budget) {
        if (budget.gitProbes >= RECONCILE_RECHECK_GIT_PROBE_CAP) {
          budget.truncated = true;
          return { verdict: { kind: 'unavailable', reason: 'budget' } };
        }
        budget.gitProbes++;
      }
      // ABSENT FROM THE WORKING TREE IS NOT THE SAME AS DELETED (board
      // 1d6a721a): ask git before concluding anything. 'never_tracked' (every
      // reachable ref checked, none EVER held the blob) is the only verdict that
      // earns deletion_candidate (board e939fd21); 'confirmed_absent' (real git
      // history, merged into base) and 'probe_failed' (git could not be
      // consulted at all) both keep the classic reconcile reading — a failed
      // probe proves nothing and must not be read as the stronger verdict.
      const probe = this.parkedOnRef(rel, ctx.treeRoot);
      if (probe.status === 'parked') return { verdict: { kind: 'parked', ref: probe.ref } };
      if (probe.status === 'never_tracked') return { verdict: { kind: 'deletion_candidate' } };
      return { verdict: { kind: 'reconcile', missing: true } };
    }
    const size = stat.size;
    // MODE (2/2) — THE MTIME PREFILTER'S TERMINATING POWER.
    //
    // At the MINT the prefilter is unconditional and is the cheap half of the
    // two-step check (decision 57d9a52d): mtime no newer than the article's last
    // update means the file cannot have moved since its baseline was taken, so
    // no content read is owed.
    //
    // AT THE RECHECK THE PREFILTER IS OFF — ALWAYS (review FIX 1, 2026-08-31;
    // the caller passes honorMtimePrefilter:false unconditionally, and the flag
    // survives only because the mint still legitimately sets it). An earlier
    // version kept the prefilter under a "licence" (the article was re-baselined
    // after the item was minted), meaning to honour the cost design's
    // "re-baselined items terminate without hashing". That licence does not hold:
    // drift lands, an unrelated article write re-baselines EVERY owned file, and
    // a second edit whose mtime is preserved or skewed to at-or-below updated_at
    // (an mtime-preserving copy, a restore from backup, a clock skew) then
    // short-circuits to `clean`. At the mint `clean` merely raises nothing; at
    // the recheck it is published as the affirmative claim "the drift no longer
    // reproduces", so a timestamp is nowhere near enough evidence. The content
    // hash decides there, bounded by the attempt and byte axes.
    if (ctx.honorMtimePrefilter && !(stat.mtimeMs > Date.parse(ctx.baselinedAt))) {
      return { verdict: { kind: 'clean' }, size };
    }
    // A registered generated projection never CONTENT-flags: every regen changes
    // it by design and check-projection-fresh guards its currency at the merge
    // gate (decision e1275166). Its DELETION still flags, in the arm above.
    if (this.isGeneratedProjection(rel)) return { verdict: { kind: 'clean' }, size };
    if (baseline === undefined) {
      // NOT collapsed to `false`/clean here (the contentChanged() anti-model):
      // the mint's call site reads `unavailable` as no-drift, so its behaviour is
      // unchanged, while the annotation site can say WHY it abstained.
      return { verdict: { kind: 'unavailable', reason: 'no_baseline' }, size };
    }
    // BUDGET AXIS 2 — bytes hashed. The size is already known, so an oversize
    // file is refused BEFORE it is read rather than after.
    //
    // THE PARKING ASYMMETRY IS DELIBERATE (review FIX 8): the ATTEMPT axis parks
    // — its counter stops incrementing at the cap, so every later path and item
    // reads the same exhausted budget and is disclosed (AC6). The BYTE axis does
    // NOT park: one oversize file is refused and the walk CONTINUES, because
    // bytesHashed is only advanced by files actually read, so the next (small)
    // file can still legitimately be checked. A parking byte axis would let a
    // single large file suppress every remaining verdict on the page as
    // unavailable:budget — a worse read for no cost saving, since the refusal
    // happens before the file is opened either way.
    if (budget) {
      if (budget.bytesHashed + size > RECONCILE_RECHECK_HASH_BYTE_CAP) {
        budget.truncated = true;
        return { verdict: { kind: 'unavailable', reason: 'budget' }, size };
      }
      budget.bytesHashed += size;
    }
    const current = this.hashFile(rel, ctx.treeRoot);
    if (current === undefined) return { verdict: { kind: 'unavailable', reason: 'unreadable' }, size };
    return { verdict: current === baseline ? { kind: 'clean' } : { kind: 'reconcile', missing: false }, size };
  }

  /**
   * The staleness verdict knowledge_query never surfaced (reported 2026-08-29:
   * "no equivalent staleness annotation at all" on knowledge_query). Nothing new
   * is COMPUTED here — the baselines exist, H7 and the read-time drift wires
   * already consult them, and projectForQuery strips them from query output so
   * a reader could not see that a record's owned file had moved since the bytes
   * it was written against. This DERIVES that verdict for the window and hands
   * it to the reader, mirroring board_query's annotation + `provenance` pair.
   *
   * WHY NOT contentChanged(): that helper deliberately collapses "no baseline"
   * and "cannot read the file" into `false`, because its callers RAISE FLAGS and
   * must abstain rather than fabricate one. Here abstention is itself something
   * to report, so the same primitive (hashFile vs. the recorded baseline) is
   * read at finer grain — one policy, two readings, not two policies.
   *
   * A FLAG ONLY, never a mint: this path enqueues nothing. Invalidation already
   * exists (H7 / the read-time drift wires, decision 57d9a52d) and a second lane
   * on the same fact would be double-reporting.
   *
   * Baselines exist for feature_article and reference_material only (see
   * computeBaselines), which is exactly why the envelope has to disclose
   * whether the check ran: over a window of decisions there is nothing to
   * compare, and silence there means "unknowable", not "fresh".
   */
  private computeBaselineDrift(records: DurableRecord[]): { status: string; annotations: Map<string, BaselineDrift> } {
    const annotations = new Map<string, BaselineDrift>();
    if (!this.repoRoot) return { status: 'unavailable:no_repo_root', annotations };
    const eligible = (records as unknown as Record<string, unknown>[]).filter((r) => {
      const baselines = r.file_baselines as Record<string, string> | undefined;
      return baselines !== undefined && Object.keys(baselines).length > 0;
    });
    if (eligible.length === 0) return { status: 'unavailable:no_baselines', annotations };
    for (const rec of eligible) {
      const baselines = rec.file_baselines as Record<string, string>;
      const paths = Object.keys(baselines).sort();
      const changed: string[] = [];
      const unverifiable: string[] = [];
      // Detached-working-tree resolution, same as every other baseline consumer:
      // an unmapped working_tree name is never checked against the wrong tree —
      // it abstains, LOUDLY, as the whole record's unverifiable set.
      const tree = this.treeRootFor(rec);
      if (tree.unresolved || !tree.root) {
        unverifiable.push(...paths);
      } else {
        for (const rel of paths) {
          const current = this.hashFile(rel, tree.root);
          if (current === undefined) unverifiable.push(rel);
          else if (current !== baselines[rel]) changed.push(rel);
        }
      }
      if (!changed.length && !unverifiable.length) continue; // unmoved: say nothing (P1)
      const notes: string[] = [];
      if (changed.length) {
        notes.push(
          `⚠ ${changed.length} owned file(s) changed since this record's baseline (${changed.join(', ')}) — it was written against different bytes, so re-read the code before trusting it`
        );
      }
      if (unverifiable.length) {
        notes.push(
          `⚠ ${unverifiable.length} owned file(s) could not be re-read, so their freshness is NOT verified (${unverifiable.join(', ')}) — absent from this tree, unreadable, or in an unmapped working_tree`
        );
      }
      annotations.set(rec.id as string, {
        changed,
        ...(unverifiable.length ? { unverifiable } : {}),
        note: notes.join('; '),
      });
    }
    return { status: 'checked', annotations };
  }

  // -- knowledge CRUD ---------------------------------------------------------

  /**
   * Refuse a write that tries to ASSIGN a server-owned envelope key, instead of
   * stripping it in silence. The stripping itself is correct and stays (finding
   * 14/43 — a caller must not be able to fabricate an id, a clock, or a status);
   * what was wrong is that the caller was told the write succeeded.
   *
   * MEASURED 2026-07-29, and this is the sharpest instance of the whole class: a
   * project trying to retire a duplicate passed {status:'superseded',
   * superseded_by:'<canonical>'} to knowledge_update. The call SUCCEEDED and
   * returned status:'active', superseded_by:null — both fields discarded, no error,
   * no warning. Their words: "that's the dangerous shape — a caller who doesn't
   * re-read the result believes it worked." They then wrote store records asserting
   * a retirement that had never happened.
   *
   * So the message must not merely refuse: for status/superseded_by it has to say
   * where the caller's actual intent belongs, because reaching for these fields
   * means wanting something these fields cannot do, and silence let them believe
   * otherwise.
   *
   * CORRECTED 2026-08-04: this message used to end "There is NO way to retire a
   * record to a non-serving state through this surface". True when written, and
   * outlived five days later by knowledge_retire (decision 9948475b) — which
   * rewrote the same claim in CLAUDE.md and missed this copy. It now NAMES the
   * retirement path and its boundary in one breath: retirement is for a genuine
   * DUPLICATE, never for a record that is merely wrong, because a caller here may
   * want either and pointing at retirement alone would trade a stale denial for an
   * invitation to retire away every error instead of correcting it.
   */
  /**
   * The unforgeable envelope: every write REFUSES these by name (board
   * 617e97d4 hoisted this out of refuseServerOwnedFields so knowledge_schema's
   * server_owned mask derives from the SAME list this refusal guard consumes —
   * the two surfaces used to be two hand-maintained copies of one truth, and
   * the projection's copy was missing four of these names).
   *
   * lifecycle/freshness/file_baselines joined on this slice's review (both
   * reviewers, independently). The genuinely reachable forgeries were
   * freshness:'flagged_stale' (resolveIdentity honors a directly-given value,
   * deriving status 'flagged_stale' — a forged-stale record) and the silent
   * file_baselines overwrite — the misleading-success shape this guard exists
   * to eliminate. lifecycle:'retired' alone was already blocked one layer down
   * (the store's born-dead refusal demands a superseded_by, itself refused
   * here), so its entry is defense-in-depth at the right layer: the tool
   * surface names the caller's mistake instead of leaking a store-internal
   * message. The store's own readEnum refusal for lifecycle/freshness is now
   * tool-unreachable — it survives for internal/MountedStores callers only.
   * Internal writers are unaffected:
   * knowledgeSplit's create passes an explicit field list, knowledgePromote
   * copies through store.create below this guard, and update/supersede spread
   * the OLD record after this refusal has run on the caller's input.
   *
   * The destructure-strips in knowledgeCreate/knowledgeUpdate/knowledgeSupersede
   * still enumerate names literally — dead code for refused names (the refusal
   * throws first), kept as defense-in-depth; the shared list binds the two
   * surfaces that must agree, the guard and the projection.
   */
  private static readonly WRITE_REFUSED_FIELDS = WRITE_REFUSED_FIELDS;

  private refuseServerOwnedFields(
    fields: Record<string, unknown>,
    op: 'knowledge_create' | 'knowledge_update' | 'knowledge_append' | 'knowledge_supersede' | 'knowledge_array_remove'
  ): void {
    const attempted = SterlingTools.WRITE_REFUSED_FIELDS.filter((k) => k in fields);
    if (attempted.length === 0) return;
    const retiring = attempted.includes('status') || attempted.includes('superseded_by');
    throw new Error(
      `${op}: ${attempted.map((k) => `'${k}'`).join(', ')} ${attempted.length === 1 ? 'is' : 'are'} SERVER-OWNED and cannot be assigned by a caller — ` +
        `the value would have been discarded and the write reported success. ` +
        (retiring
          ? `status/superseded_by are set only by supersession: knowledge_update writes a NEW version and retires the prior one automatically. ` +
            `To correct a WRONG record, knowledge_update it in place (the correction supersedes the error); do NOT create a second record under the same slug. ` +
            `The one retirement path is knowledge_retire(id, in_favor_of), and it is NARROW: it is for a genuine DUPLICATE whose reader must be sent to the survivor, ` +
            `never for a record that is merely wrong — /sterling:cleanup never hard-deletes knowledge either.`
          : `id and the clocks are assigned at write; type is fixed at create; lifecycle/freshness are derived by the store; file_baselines is computed server-side at create/reconcile.`)
    );
  }

  /**
   * Refuse a write carrying fields the record type does not define, naming them
   * AND the valid set — the write-side half of fail-loud (P5), symmetric with the
   * strict tool PARAMETERS of decision b47889b7. The valid set is in the message
   * because discoverability is the actual complaint: per-type required fields and
   * the files-vs-file_keys split (feature_article uses files[].path, decision /
   * anti_pattern / research_finding / todo use file_keys, reference_material
   * derives paths from location) cost a round-trip each to learn otherwise.
   * An unregistered type is left to validateRecord's louder rejection.
   */
  private refuseUnknownFields(type: string, candidate: Record<string, unknown>, op: string = 'knowledge write'): void {
    const unknown = unknownFieldsIn(type, candidate);
    if (unknown.length === 0) return;
    const valid = [...(knownFieldsFor(type) ?? [])].sort().join(', ');
    throw new Error(
      `${op}: '${type}' does not define ${unknown.map((k) => `'${k}'`).join(', ')} — ` +
        `the field would have been silently dropped and the write reported success. Valid fields: ${valid}.`
    );
  }

  /**
   * Caller-facing field path for a zod issue: numeric segments render as
   * `[n]` (array indices), string segments join with '.' — 'history[19]',
   * 'dependencies.relies_on[0]'. Never the raw ["history",19] zod form.
   */
  private static renderIssuePath(path: (string | number)[]): string {
    let out = '';
    for (const seg of path) {
      out = typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${seg}` : String(seg);
    }
    return out || '(root)';
  }

  /**
   * Render a zod schema-validation failure in this surface's own idiom
   * (board 03c92e2a; decision d0b88e27 — a refusal names its DISCRIMINATOR,
   * not just its rule) instead of leaking the raw issue array. Per issue:
   * the caller-facing field path (renderIssuePath), what was RECEIVED vs
   * EXPECTED, and — when the failing element itself should have been an
   * object (an array-of-objects entry, e.g. a bad history/files/current_ac
   * element) — that element's expected shape enumerated by name/type/
   * required-ness. The shape and any enum's permitted values are pulled
   * from schemaFor(type) — the SAME schema-walk knowledge_schema projects
   * (decision 9948475b) — never a second hand-written description, so this
   * cannot drift from what knowledge_schema itself reports.
   */
  private renderValidationFailure(err: ZodError, type: string, op: string): Error {
    const described = schemaFor(type);
    const fieldsByName = new Map((described?.fields ?? []).map((f) => [f.name, f]));
    const renderIssue = (issue: ZodIssue): string => {
      const path = SterlingTools.renderIssuePath(issue.path as (string | number)[]);
      if (issue.code === 'invalid_enum_value') {
        const topField = typeof issue.path[0] === 'string' ? fieldsByName.get(issue.path[0] as string) : undefined;
        const options = topField?.enum_values && topField.enum_values.length ? topField.enum_values : (issue.options as unknown[] | undefined)?.map(String) ?? [];
        return `${path}: received '${String(issue.received)}', expected one of: ${options.join(', ')}`;
      }
      if (issue.code === 'invalid_type') {
        let text = `${path}: received ${issue.received}, expected ${issue.expected}`;
        if (issue.expected === 'object' && issue.path.length >= 2) {
          const ownerName = issue.path[issue.path.length - 2];
          const owner = typeof ownerName === 'string' ? fieldsByName.get(ownerName) : undefined;
          if (owner?.element_fields?.length) {
            const shape = owner.element_fields
              .map(
                (ef) =>
                  `${ef.name}: ${ef.type}${ef.enum_values?.length ? ` (one of: ${ef.enum_values.join(', ')})` : ''} (${ef.required ? 'required' : 'optional'})`
              )
              .join(', ');
            text += ` — expected shape: {${shape}}`;
          }
        }
        return text;
      }
      // Board a9280db7 (decision c48380bf): current_ac/live_test_refs are now a
      // union (real content OR the structured not_applicable exemption), so a
      // bad element inside the array branch surfaces as a single top-level
      // 'invalid_union' issue instead of a direct 'invalid_type' — without
      // this, the caller-facing message collapsed to a bare "Invalid input",
      // losing the per-element path/received/expected detail every other
      // array-of-objects field still reports. Drill into whichever union
      // branch produced the DEEPEST (most specific) sub-issue — that is the
      // branch that actually explains the failure, not the sibling branch
      // that never matched the shape at all — and render THAT issue with the
      // same rules, recursively.
      if (issue.code === 'invalid_union') {
        const subIssues = (issue.unionErrors ?? []).flatMap((sub) => sub.issues);
        if (subIssues.length) {
          const deepest = subIssues.reduce((a, b) => (b.path.length > a.path.length ? b : a));
          return renderIssue(deepest);
        }
      }
      return `${path}: ${issue.message}`;
    };
    const parts = err.issues.map(renderIssue);
    return new Error(`${op}: '${type}' failed validation — ${parts.join('; ')}`);
  }

  /**
   * FIELD-EFFECT VISIBILITY (board 8659a573): a small, DATA-DRIVEN map of
   * fields whose consumer is server-side and invisible in-session — a caller
   * has no way to observe these fields' effect within a single tool response.
   * Measured cost of the gap: volatility_hint was judged "unconsumed" (it
   * drives stale_research's staleness clocks) and working_tree judged
   * "unused" (it resolves a record's file paths server-side), both false
   * claims that invited removal of load-bearing fields (research_finding
   * 179d8161). Every entry here MUST be a VERIFIED consumer (grepped, not
   * inferred) — an invented consumed_by is worse than none.
   *
   * Keyed by `${type}:${field}`, NOT by bare field name (review finding):
   * a note is a claim about ONE type's verified consumer, and two types can
   * share a field name with only one of them actually consumed server-side
   * (or consumed differently) — a bare-name key would let any future type
   * reusing the name silently inherit an unverified note.
   */
  private static readonly FIELD_CONSUMERS: Readonly<Record<string, string>> = {
    // Consumed at the staleness threshold lookup (config.staleness.research_days
    // keyed by volatility_hint) that decides when a research_finding reads as
    // flagged_stale — a read-time computation with no caller-visible trace.
    // volatility_hint is declared only on research_finding today.
    'research_finding:volatility_hint': 'drives stale_research staleness clocks (research_days threshold lookup)',
    // Consumed by treeRootFor()'s working-tree resolution (config.working_trees):
    // unset means the project root; a mapped name resolves file paths
    // server-side for the read-time drift/baseline checks and H7/H10
    // ownership — none of which surfaces the lookup itself to the caller.
    // Verified for BOTH types that declare working_tree: computeBaselines
    // (tools.ts) gates on type === 'feature_article' || 'reference_material'
    // before calling treeRootFor, so both consumers are confirmed, not assumed.
    'feature_article:working_tree': 'resolves copy-file paths server-side (config.working_trees lookup for drift/baseline checks)',
    'reference_material:working_tree': 'resolves copy-file paths server-side (config.working_trees lookup for drift/baseline checks)',
  };

  /**
   * knowledge_schema — ask what a type requires instead of guessing (board
   * 7acfbe48). Read-only, derived from the registered zod schema, so it cannot
   * drift from what a write will actually accept. Listing the registered type
   * names on an unknown type is deliberate: the commonest reason to call this is
   * not knowing the vocabulary.
   */
  knowledgeSchema(
    type: string
  ): { type: string; fields: (FieldShape & { server_owned?: boolean; consumed_by?: string })[]; required: string[]; optional: string[] } {
    const described = schemaFor(type);
    if (!described) {
      throw new Error(`knowledge_schema: '${type}' is not a registered record type. Registered: ${Object.keys(RECORD_TYPES).sort().join(', ')}.`);
    }
    // SERVER-OWNED FIELDS ARE REPORTED AS SUCH ([stable-identity-design-v2]
    // contract 1/4; widened to the whole write-refused envelope by board
    // 617e97d4): everything in SERVER_OWNED_FIELDS is refused or stripped by
    // the write path, so reporting any of it as caller-required (as the raw
    // zod shape does, because the envelope still declares them for API
    // compatibility) told callers to supply exactly what they must not: the
    // measured cost of a wrong schema answer is one write attempt each.
    //
    // They stay listed in `fields` — a reader still needs to know they exist
    // and what they hold — but marked with `server_owned: true`, and they appear
    // in neither `required` nor `optional`, because both lists answer "what may I
    // supply". There is deliberately NO top-level server_owned[] array: the
    // per-field flag already answers the question at the place a reader is
    // looking, and a second copy of the same list is one more thing to drift.
    //
    // CREATE-DEFAULTED fields (author/links/scope/stack_tags) are the second
    // mask: zod declares them required, but knowledge_create defaults every
    // one when absent, so to a caller they are optional — required[] is
    // exactly the set a create must supply.
    const serverOwned = new Set(SterlingTools.SERVER_OWNED_FIELDS);
    const defaulted = new Set(SterlingTools.CREATE_DEFAULTED_FIELDS);
    const fields = described.fields.map((f) => {
      const consumedBy = SterlingTools.FIELD_CONSUMERS[`${described.type}:${f.name}`];
      const withConsumer = consumedBy !== undefined ? { consumed_by: consumedBy } : {};
      return serverOwned.has(f.name)
        ? { ...f, ...withConsumer, required: false, server_owned: true }
        : defaulted.has(f.name)
          ? { ...f, ...withConsumer, required: false }
          : { ...f, ...withConsumer };
    });
    // The split lists are redundant with `fields` on purpose — "what must I
    // supply" is the actual question, and making the reader filter the array to
    // answer it is how the guessing starts.
    return {
      type: described.type,
      fields,
      required: fields.filter((f) => f.required && !serverOwned.has(f.name)).map((f) => f.name),
      optional: fields.filter((f) => !f.required && !serverOwned.has(f.name)).map((f) => f.name),
    };
  }

  /**
   * knowledge_stats — size and composition WITHOUT the body (board a382af6b).
   * Per-id: the shared size decomposition (recordSizes — the same numbers the
   * article_oversize lane judges) plus composition counts. No-arg: the
   * store-wide aggregate, so bloat is visible before a knowledge_get chokes on
   * it. Read-only; the digest size column (size_chars) is the cheap scan and
   * this is the drill-down.
   */
  knowledgeStats(id?: string): Record<string, unknown> {
    const threshold = this.config.article_oversize_chars;
    if (id) {
      // A HISTORICAL id READS (review finding): letting the ladder's refusal
      // through here contradicted its own text — it says reads through this id
      // still work — and stats ARE a read. Sized over the ARCHIVED body, which
      // is what that id addresses, with the legacy_resolution block knowledge_get
      // serves, so the caller can see which body was measured. The block is
      // split off before recordSizes so it never inflates the numbers it
      // annotates.
      let rec: Record<string, unknown>;
      let legacy: unknown;
      try {
        rec = this.resolveRecordId(id, 'knowledge_stats') as unknown as Record<string, unknown>;
      } catch (err) {
        if (!(err instanceof HistoricalIdError)) throw err;
        const { legacy_resolution, ...snapshot } = this.serveArchivedAlias(err.alias);
        rec = snapshot;
        legacy = legacy_resolution;
      }
      const sizes = recordSizes(rec);
      const history = Array.isArray(rec.history) ? (rec.history as unknown[]) : [];
      const links = Array.isArray(rec.links) ? (rec.links as { rel: string }[]) : [];
      return {
        id: rec.id,
        type: rec.type,
        ...(rec.slug ? { slug: rec.slug } : {}),
        ...(rec.title ? { title: rec.title } : {}),
        ...(rec.version !== undefined ? { version: rec.version } : {}),
        body_chars: sizes.body_chars,
        history_chars: sizes.history_chars,
        total_chars: sizes.body_chars + sizes.history_chars,
        history_entries: history.length,
        supersedes_count: links.filter((l) => l.rel === 'supersedes').length,
        ...(rec.type === 'feature_article' ? { oversize_threshold: threshold, over_threshold: sizes.body_chars > threshold } : {}),
        ...(legacy !== undefined ? { legacy_resolution: legacy } : {}),
      };
    }
    const by_type: Record<string, { count: number; body_chars: number }> = {};
    const articles: { slug: string; body_chars: number }[] = [];
    for (const type of Object.keys(RECORD_TYPES)) {
      const records = this.store.query({ types: [type], cap: 100000 }) as unknown as Record<string, unknown>[];
      let chars = 0;
      for (const r of records) {
        const s = recordSizes(r);
        chars += s.body_chars;
        if (type === 'feature_article') articles.push({ slug: String(r.slug ?? r.id), body_chars: s.body_chars });
      }
      by_type[type] = { count: records.length, body_chars: chars };
    }
    articles.sort((a, b) => b.body_chars - a.body_chars);
    return {
      by_type,
      total_body_chars: Object.values(by_type).reduce((n, t) => n + t.body_chars, 0),
      oversize_threshold: threshold,
      largest_articles: articles.slice(0, 10).map((a) => ({ ...a, over_threshold: a.body_chars > threshold })),
    };
  }

  knowledgeCreate(type: string, fields: Record<string, unknown>, opts?: { deferCheckSkipped?: boolean }): CreateResult {
    // deferCheckSkipped (default false): when true, the check_skipped audit rows
    // are NOT persisted here — they are still returned on the result so the
    // caller records them itself. Only knowledge_extract sets this, and only so a
    // domain-mount transaction's audit rows land post-commit (see `skip`). Every
    // other caller omits it, so their behaviour is byte-identical.
    const persistSkips = opts?.deferCheckSkipped !== true;
    this.refuseServerOwnedFields(fields, 'knowledge_create');
    const ts = this.now();
    // The envelope is SERVER-OWNED: strip these keys from caller fields before
    // assembling the candidate, so a caller cannot override id/timestamps/status/
    // superseded_by/type via `...fields` (audit finding 14/43 — e.g. status:
    // 'superseded' would create an already-invisible record). knowledgeUpdate
    // strips the identical set for the same reason.
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, type: _t, version: smuggledVersion, ...body } = fields;
    const candidate: Record<string, unknown> = {
      id: this.newId(),
      type,
      created_at: ts,
      updated_at: ts,
      author: (body.author as string) ?? 'conductor',
      status: 'active',
      superseded_by: null,
      links: body.links ?? [],
      scope: (body.scope as string) ?? 'project',
      stack_tags: body.stack_tags ?? [],
      ...body,
      // THE COUNTER IS SERVER-OWNED AT BIRTH TOO ([stable-identity-design-v2]
      // contract 1): every record starts at version 1 and only a write moves
      // it, so a caller-supplied value is stripped above and replaced here
      // rather than seeding the count. It is set explicitly (not left to the
      // store's default) because feature_article DECLARES version as a required
      // field, and this candidate is schema-parsed before it ever reaches the
      // store. The strip is disclosed on the result's warnings, never silent.
      version: 1,
    };
    // links[].target_id THROUGH THE LADDER (board 2e71d464) — set AFTER the
    // `...body` spread above so a caller-supplied `links` array (which lands
    // inside `body`) does not silently reintroduce its own unresolved
    // target_id past this resolution.
    candidate.links = this.resolveLinksTargets(candidate.links, 'knowledge_create') ?? [];
    // dedup_override is a create-time directive, never a stored field
    const dedupOverride = candidate.dedup_override === true;
    delete candidate.dedup_override;
    // record the owned-file content baseline at birth (server-computed, never
    // author-supplied) so the read-time drift check is content-aware (§3.2.3)
    if (type === 'feature_article' || type === 'reference_material') {
      candidate.file_baselines = this.computeBaselines(candidate);
    }
    // validate BEFORE any dedup logic: a schema-invalid candidate gets the
    // schema error, never a dedup refusal (board 3f9591e9 defect 3); unknown
    // types fall through to store.create for its canonical rejection.
    // Keep the parsed result — its repoPath transform fully normalizes file_keys
    // ('./x'→'x'), so the dedup key-overlap compares like-for-like against stored
    // records (audit finding 28/43); the raw candidate skipped the assist tier.
    const registered = RECORD_TYPES[type as keyof typeof RECORD_TYPES];
    // A field this type does not define is REFUSED, never dropped (P5). zod
    // objects strip unknown keys, so before this a misfiled field was accepted,
    // discarded, and the create returned SUCCESS — the caller found out only by
    // querying for what the write was supposed to have stored (sibling report
    // 2026-07-29: reference_material has no files/file_keys, its paths come from
    // location). Checked BEFORE schema.parse so the error names the actual
    // mistake instead of a required field that went missing because of it.
    this.refuseUnknownFields(type, candidate);
    let parsed: Record<string, unknown>;
    try {
      parsed = registered ? (registered.schema.parse(candidate) as Record<string, unknown>) : candidate;
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, type, 'knowledge_create');
      throw err;
    }
    const skipped: SkippedCheck[] = [];

    if (type === 'anti_pattern') {
      // dedup guard (§3.2.2): an overlapping anti_pattern is REFUSED LOUD, never
      // silently merged — a wrong merge costs the whole lesson (2026-07-04: a
      // distinct lesson was swallowed on one shared file_key, board 3f9591e9);
      // a refusal costs one round-trip. The author decides: same finding →
      // knowledge_update the match (append source_evidence); distinct lesson →
      // re-submit with dedup_override: true.
      if (!dedupOverride) {
        const match = this.findAntiPatternOverlap(parsed);
        if (match) {
          const { record, predicate, dice } = match;
          const predicateDesc =
            predicate === 'title_trigger'
              ? `title+trigger Dice similarity ${dice.toFixed(2)} >= ${0.5} on their own`
              : `title+trigger Dice similarity ${dice.toFixed(2)} >= ${0.3}, assisted by a shared file_key (the false-positive-prone branch — a busy multi-concern file can host distinct lessons)`;
          throw new Error(
            `knowledge_create: this anti_pattern overlaps existing '${record.id}' — "${(record as { title?: string }).title ?? ''}" ` +
              `(matched on ${predicateDesc}). ` +
              `Same finding: knowledge_update that record, appending your source_evidence. Distinct lesson: re-submit with dedup_override: true.`
          );
        }
      }
      skipped.push(this.skip('noise-gate', this.activeRunId(), persistSkips));
    } else if (type === 'feature_article') {
      // SLUG COLLISION IS REFUSED LOUD (board 56c8a509). Two records under one
      // slug is worse than one wrong record, because retrieval serves BOTH and
      // they contradict — and it is worse still than that, as a consuming project
      // proved: retiring the loser by RETITLING it made the tombstone the NEWEST
      // record under the slug, so H19 resolved the slug to the tombstone and
      // served "RETIRED DUPLICATE — DO NOT READ THIS ARTICLE" as the
      // authoritative answer for a live concept. A whole article went dark.
      // Resolution is store.articlesBySlug — deterministic, never a ranked
      // capped query, so this refusal cannot be a bm25 artefact (decision
      // 3db7095f). No dedup_override escape hatch, deliberately: unlike two
      // anti_patterns that may carry genuinely distinct lessons on one file, two
      // articles under one slug have no legitimate shape. The remedies are named
      // in the message because "refused" without a next step is where authors
      // invent the tombstone workaround that caused the incident.
      const slug = (parsed as { slug?: string }).slug;
      if (slug) {
        const clash = this.store.articlesBySlug(slug);
        if (clash.length) {
          throw new Error(
            `knowledge_create: a feature_article with slug '${slug}' already exists ('${clash[0].id}'). ` +
              `Two records under one slug is worse than one wrong record — retrieval serves both and they contradict. ` +
              `Revising that article: knowledge_update '${clash[0].id}' (the correction supersedes the error — fix it FORWARD). ` +
              `Genuinely a different concept: choose a distinct slug. Replacing it wholesale: knowledge_create the new article ` +
              `under its own slug, then knowledge_retire the old one in_favor_of the new — never leave both live.`
          );
        }
      }
      skipped.push(this.skip('dedup-merge', this.activeRunId(), persistSkips));
    } else {
      // dedup guarding is defined for anti_patterns and feature_article slugs;
      // other types skip loudly
      skipped.push(this.skip('dedup-merge', this.activeRunId(), persistSkips));
    }

    // STABLE HANDLES (board 1e639f32): decision / anti_pattern / research_finding
    // gain the slug feature_article and brief already had — the id re-mints on
    // every supersession, the slug names the CONCEPT and survives. Auto-minted
    // from the headline when absent (an auto-derived clash takes a -2/-3 suffix,
    // deterministic); an EXPLICIT slug that collides with ANY slug-bearing
    // record is refused loudly — same two-records-one-handle reasoning as the
    // feature_article branch above, across every type knowledge_get resolves.
    // attestation joins the EXPLICIT-collision half only (review finding 1,
    // 2026-08-21): it has no title/question headline, so nothing auto-mints —
    // but an explicit slug colliding with a live record would brick slug
    // addressing of that record for every reader (the 1e639f32 incident shape).
    //
    // `open_question` joins BOTH halves (board 4ffb95be): it declares a `slug`
    // and mintHeadlineOf already falls through to `question`, so it auto-mints
    // exactly the way research_finding does — the two types are the same shape,
    // a question that IS the identity. Omitting it here would have been silent
    // in both directions: no handle minted, AND no collision refusal, so an
    // explicit open_question slug could take a live ruling's handle and brick
    // slug addressing of that record for every reader — the 1e639f32 incident
    // shape this branch exists to prevent.
    //
    // `todo` JOINS THE SAME ONE NAMESPACE (S1, decision
    // human-readable-ids-for-board-items) — deliberately through THIS branch
    // rather than a private check on board_add, because board_add funnels here
    // and recordsBySlug is type-agnostic, so both directions are covered by one
    // rule: a board item cannot take a live ruling's handle, and a ruling
    // cannot take a live board item's. A private per-surface check would give
    // `todo` a namespace of its own, which is exactly the read-time ambiguity
    // de1a7329 rejected. Its headline comes from mintHeadlineOf (a board item
    // has no title field; see todoHeadline).
    if (
      type === 'decision' ||
      type === 'anti_pattern' ||
      type === 'research_finding' ||
      type === 'open_question' ||
      type === 'attestation' ||
      type === 'todo'
    ) {
      const explicit = (parsed as { slug?: string }).slug;
      if (explicit) {
        if (this.store.recordsBySlug(explicit).length) {
          throw new Error(
            `knowledge_create: a record with slug '${explicit}' already exists — one handle resolves to one record. ` +
              `Choose a distinct slug, or omit it to auto-derive a unique one.`
          );
        }
      } else {
        const headline = SterlingTools.mintHeadlineOf(type, parsed as Record<string, unknown>);
        const minted = this.mintSlug(headline);
        if (minted) {
          // store.create persists `candidate` (parsed is the dedup-comparison
          // view), so the minted slug must land on BOTH.
          (parsed as { slug?: string }).slug = minted;
          candidate.slug = minted;
        }
      }
    }

    // A SYSTEM maintenance item takes the ATOMIC dedup path (board 2ded3b4b):
    // check-and-insert in one transaction, keyed (system_reason, feature_link,
    // file_keys). Every producer funnels through here, so the four hand-rolled
    // query-then-insert copies that raced each other are gone, and the key now
    // includes the FILE — which fixes the opposite bug in the same stroke, where
    // a second drifting file was suppressed and then absorbed by the next
    // re-baseline. A duplicate returns the EXISTING item rather than throwing:
    // producers are mechanisms reporting a fact, and a fact reported twice is
    // not an error.
    // Cited-id resolution warnings (board fc053051): scanned from the same
    // text the FTS extractor already derives for this type, so no new
    // per-type field list is invented here. Computed on `parsed` (post-schema,
    // pre-store) so a scan sees exactly what is about to be written.
    const citationWarnings = registered ? this.citedIdWarnings(registered.fts(parsed)) : [];
    // The stripped counter is DISCLOSED, not silently dropped
    // ([stable-identity-design-v2] contract 1) — a caller who thought it was
    // seeding version 42 needs to know the record was born at 1.
    //
    // EXCEPT for the value 1, deliberately (adjudicated, not an oversight):
    // feature_article's schema still REQUIRES `version: 1` on a create, so every
    // legitimate article create passes it. Warning there would fire on the
    // correct call, every time, telling the caller nothing they did not already
    // intend — ceremony, not disclosure (P1). Any OTHER value is a caller who
    // believed it controlled the counter, which is exactly what must be said.
    if (smuggledVersion !== undefined && smuggledVersion !== 1) {
      citationWarnings.push(
        `'version' is SERVER-OWNED and was ignored: you passed ${JSON.stringify(smuggledVersion)}, this record was created at version 1. ` +
          `Every knowledge_update/append/edit bumps it by exactly one, in place, on the same id.`
      );
    }

    const isSystemTodo = type === 'todo' && (candidate as { source?: string }).source === 'system';
    if (isSystemTodo) {
      const res = this.store.enqueueSystemTodo(candidate);
      this.surfacePromotionCandidate(res.record, type);
      return {
        record: res.record,
        check_skipped: skipped,
        ...(res.deduped ? { deduped: true } : {}),
        ...(res.text_updated ? { text_updated: true } : {}),
        warnings: citationWarnings,
      };
    }
    const record = this.store.create(candidate);
    this.surfacePromotionCandidate(record, type);
    // SAME-SUBJECT SURFACING (decision 7e3c66c5): only for the three ruling
    // types — other types' create responses stay byte-identical. Computed
    // AFTER the store write (AC6: disclosure never blocks or gates), on the
    // registered FTS extractor's text (same source citedIdWarnings already
    // used above), excluding only the record just minted.
    const sameSubject = SterlingTools.SAME_SUBJECT_TYPES.includes(type)
      ? this.sameSubjectDigest(registered ? registered.fts(parsed) : '', new Set([record.id]))
      : undefined;
    return { record, check_skipped: skipped, warnings: citationWarnings, ...(sameSubject ? { same_subject: sameSubject } : {}) };
  }

  /**
   * §3.3 project-store-then-promote: reference/research records are
   * domain-candidates by default. One born project-scoped, when the project has
   * a domain mounted to promote into, surfaces a single promotion_review
   * maintenance item — the human decides at the queue drain, never an automatic
   * move. No domain mounted → nowhere to promote → nothing surfaced (so a
   * domain-less project sees no promotion noise). A record the conductor already
   * scoped to a domain at creation is not a candidate.
   */
  private surfacePromotionCandidate(record: DurableRecord, type: string): void {
    if (type !== 'reference_material' && type !== 'research_finding') return;
    if (record.scope !== 'project' || this.config.stack_tags.length === 0) return;
    const label = (record as { title?: string; question?: string }).title ?? (record as { question?: string }).question ?? type;
    this.maintenanceEnqueue({
      reason: 'promotion_review',
      text: `review '${label}' for promotion to a domain store — project-scoped ${type}, a domain-candidate by default (§3.3)`,
      file_keys: (record as { file_keys?: string[] }).file_keys,
      feature_link: record.id,
    });
  }

  private findAntiPatternOverlap(
    candidate: Record<string, unknown>
  ): { record: DurableRecord; predicate: 'title_trigger' | 'key_assisted'; dice: number } | undefined {
    const existing = this.store.query({ types: ['anti_pattern'], cap: 1000 });
    const candKeys = new Set(((candidate.file_keys as string[]) ?? []).map((p) => p.replace(/\\/g, '/')));
    const tokens = (r: Record<string, unknown>) =>
      new Set(
        `${r.title ?? ''} ${r.trigger ?? ''}`
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3)
      );
    const candTokens = tokens(candidate);
    // Dice coefficient over the significant-token sets (2·|A∩B| / (|A|+|B|)):
    // flag only on STRONG overlap — a genuine restatement of the same
    // anti-pattern — not on a couple of shared domain words. The prior
    // `shared >= 2` absolute gate collapsed distinct same-domain gotchas: any
    // two "Genesys Cloud …" titles share genesys+cloud, any two Power Automate
    // gotchas share power+automate. file_key overlap is an ASSIST, not a hard
    // signal — a busy multi-concern file (e.g. agent-distribution.mjs) hosts
    // many distinct lessons (board 3f9591e9, 2026-07-04); a shared key only
    // lowers the token bar for records that already sound alike.
    const DICE_OVERLAP_THRESHOLD = 0.5;
    const DICE_KEY_ASSISTED_THRESHOLD = 0.3;
    for (const e of existing) {
      const rec = e as unknown as Record<string, unknown>;
      const recTokens = tokens(rec);
      const denom = candTokens.size + recTokens.size;
      if (denom === 0) continue;
      let shared = 0;
      for (const t of recTokens) if (candTokens.has(t)) shared++;
      const dice = (2 * shared) / denom;
      const keyOverlap = ((rec.file_keys as string[]) ?? []).some((k) => candKeys.has(k));
      if (dice >= DICE_OVERLAP_THRESHOLD) return { record: e, predicate: 'title_trigger', dice };
      if (keyOverlap && dice >= DICE_KEY_ASSISTED_THRESHOLD) return { record: e, predicate: 'key_assisted', dice };
    }
    return undefined;
  }

  /**
   * Retrieval (§3.4): records pass through with lazy stale-at-read
   * annotations — research findings get both clocks + a staleness flag;
   * platform/external-basis records past threshold get verify_before_use.
   * Annotations are computed at read, never persisted (P4: no sweeps).
   */
  knowledgeQuery(opts: QueryOptions): (DurableRecord & { staleness?: object; verify_before_use?: boolean })[] {
    const nowMs = Date.parse(this.now());
    const ageDays = (iso: string) => Math.floor((nowMs - Date.parse(iso)) / DAY_MS);
    return this.store.query(opts).map((record) => {
      if (record.type === 'research_finding') {
        const r = record as unknown as { source_date: string; capture_date: string; volatility_hint?: 'fast' | 'medium' | 'stable'; status: string };
        const threshold = this.config.staleness.research_days[r.volatility_hint ?? 'medium'];
        const sourceAge = ageDays(r.source_date);
        const stale = r.status === 'flagged_stale' || sourceAge > threshold;
        return {
          ...record,
          staleness: {
            source_age_days: sourceAge,
            capture_age_days: ageDays(r.capture_date),
            threshold_days: threshold,
            stale,
            ...(stale ? { note: 'stale — re-verify before use; re-verification supersedes this finding' } : {}),
          },
        };
      }
      // §3.2.5: repo-located docs — out-of-band edits caught at read time.
      // File mtime newer than source_date → verify_before_use + ONE deduplicated
      // refresh_reference maintenance item (a hundred stale reads, one queue entry).
      if (record.type === 'reference_material' && (record as unknown as { kind: string }).kind === 'doc' && this.repoRoot) {
        const r = record as unknown as { id: string; title: string; location: string; source_date: string; file_baselines?: Record<string, string> };
        // Detached-working-tree resolution (comsoft-juiced 2026-07-17): resolve
        // against the record's declared tree; an unmapped name abstains LOUD —
        // never checked against the wrong tree, never a fabricated queue item.
        const tree = this.treeRootFor(record as unknown as Record<string, unknown>);
        if (tree.unresolved) return { ...record, verify_before_use: true };
        let rel: string | undefined;
        try {
          rel = normalizeRepoPath(r.location);
        } catch {
          rel = undefined; // absolute/escaping location: not repo-located
        }
        if (rel && tree.root) {
          const stat = statSync(join(tree.root, rel), { throwIfNoEntry: false });
          // mtime > source_date is the cheap pre-filter; confirm a real content
          // change against the baseline before flagging (an mtime-only bump from
          // a merge is not an out-of-band edit). No baseline → abstain. A
          // registered generated projection never content-flags (regen churn is
          // by design; this wire has no deletion arm — that is the feature-
          // article check's job for files an article owns).
          if (stat && stat.mtimeMs > Date.parse(r.source_date) && !this.isGeneratedProjection(rel) && this.contentChanged(rel, r.file_baselines, tree.root)) {
            // NO PRE-CHECK (board e939fd21): maintenanceEnqueue's atomic choke
            // point (SterlingStore.enqueueSystemTodo) already keys on
            // (system_reason, feature_link, file_keys) inside its own
            // transaction, so a re-enqueued open item returns rather than
            // duplicates. This pre-check queried on (system_reason, file_keys)
            // alone — WITHOUT feature_link — which is a weaker key than the
            // choke point's: two different reference_material records sharing
            // a path would have the first one's open item silently suppress
            // the second SUBJECT's finding, and duplicating the dedup rule
            // here is exactly how the four hand-rolled copies drifted apart
            // (decision 194f43e4).
            this.maintenanceEnqueue({
              reason: 'refresh_reference',
              text: `refresh reference '${r.title}' — ${rel} changed on disk after source_date (out-of-band edit); refresh summary + source_date`,
              file_keys: [rel],
              feature_link: r.id,
            });
            return { ...record, verify_before_use: true };
          }
        }
      }
      // §3.2.3: feature-article drift caught at read — H7 covers governed
      // touches; this catches out-of-band edits. Any owned file newer than the
      // article's updated_at, or missing from disk (deletion is drift), flags
      // the article and enqueues ONE reconcile_needed item (same feature_link
      // dedup as H7 — one drain surface regardless of trigger).
      if (record.type === 'feature_article' && this.repoRoot) {
        const a = record as unknown as { id: string; slug: string; files?: { path: string; role?: string }[]; file_baselines?: Record<string, string> };
        const roleFor = (p: string) => (a.files ?? []).find((f) => f.path === p)?.role;
        // Detached-working-tree resolution (comsoft-juiced 2026-07-17): a copy-
        // describing article's files are stat'd against ITS tree — resolving
        // against the project root produced false "out-of-band deletion" items
        // for every copy-only file. An unmapped tree name abstains LOUD.
        const tree = this.treeRootFor(record as unknown as Record<string, unknown>);
        if (tree.unresolved) return { ...record, verify_before_use: true };
        const treeRoot = tree.root ?? this.repoRoot;
        // EVERY drifting file, not just the first (board 2ded3b4b). This loop used
        // to `break` on the first drift, and the enqueue dedup keyed on the
        // ARTICLE — so a second drifting file never got an item, and because
        // knowledge_update re-baselines EVERY owned file, reconciling the first
        // absorbed the second's drift into a fresh baseline. The finding neither
        // queued nor survived. One item per FILE is also what makes an item
        // actionable: it names the thing that changed.
        const drifts: { path: string; missing: boolean; neverTracked?: boolean }[] = [];
        const parkedFiles: { path: string; ref: string }[] = [];
        // Owned bytes that actually exist — the evidence for the state check below.
        // Free here: the stat is already being taken for the drift comparison.
        let liveBytes = 0;
        for (const f of a.files ?? []) {
          // ONE SHARED PREDICATE (decision queue-truth-at-read-annotation-design):
          // the seven checks this loop used to inline now live in
          // classifyOwnedFileDrift, which the queue's truth-at-read annotation
          // calls too. Same order, same verdicts, same git-probe readings — the
          // extraction is behaviour-preserving here by construction, and mode
          // 'mint' selects the two policy points that belong to THIS caller.
          const { verdict, size } = this.classifyOwnedFileDrift(f.path, {
            mode: 'mint',
            treeRoot,
            baselines: a.file_baselines,
            baselinedAt: record.updated_at,
            honorMtimePrefilter: true,
          });
          // Owned bytes that actually exist, for the state-honesty check below —
          // free, because the classifier already took the stat.
          if (size !== undefined) liveBytes += size;
          if (verdict.kind === 'parked') {
            // The article is CORRECT — the path returns on merge (board 1d6a721a).
            parkedFiles.push({ path: f.path, ref: verdict.ref });
            continue;
          }
          if (verdict.kind === 'deletion_candidate') {
            drifts.push({ path: f.path, missing: true, neverTracked: true });
            continue;
          }
          if (verdict.kind === 'reconcile') {
            drifts.push({ path: f.path, missing: verdict.missing, neverTracked: false });
            continue;
          }
          // 'clean' AND every 'unavailable:<reason>' raise NOTHING here, exactly
          // as before the extraction: no baseline, an unreadable file and a
          // generated projection all made contentChanged() return false. THE
          // MINT ABSTAINS rather than fabricate a flag it cannot stand behind —
          // that is this CALL SITE's policy, which is why the shared predicate
          // reports the abstention instead of collapsing it (the annotation site
          // has to disclose it).
        }
        if (drifts.length) {
          // NO PRE-CHECK: enqueueSystemTodo is atomic and keyed
          // (reason, feature_link, file), so re-enqueueing an already-open item
          // returns it instead of duplicating it. The old pre-check keyed on the
          // ARTICLE, which is exactly what suppressed a second file's finding —
          // and doing it here as well as in the store would put the dedup rule in
          // two places, which is how the four copies drifted apart to begin with.
          for (const d of drifts.slice(0, DRIFT_ITEMS_PER_READ)) {
            // If the article's OWN role text disclaims the path, say so on the
            // item (board b7269100). Otherwise this exact no-op gets re-audited
            // on every future edit to that file, forever — the item is the only
            // place a reader will ever look, so it is where the observation has
            // to land, and offering the real remedy converts a permanent
            // irritant into one decision taken once.
            const disclaimed = this.disclaimsOwnership(roleFor(d.path))
              ? ` NOTE: this article's own files[] role for ${d.path} disclaims ownership of it, so this item will recur on every future edit to that file and each one will be a no-op. Consider REMOVING ${d.path} from files[] instead of reconciling — check the co-owners first (knowledge_query file_keys:["${d.path}"]) so the path is not left orphaned.`
              : '';
            // A file NEVER TRACKED on any git ref this repo can reach (board
            // e939fd21) is not a RECONCILE — no write can ever close "the file
            // no longer exists", so reconcile_needed for this shape re-mints
            // forever (the config.ts incident). It gets its own gated lane
            // instead — deletion_candidate, whose deed is confirming/undoing
            // the deletion, never editing the article's prose. A file that WAS
            // once tracked (real git history, now a merged-into-base ancestor)
            // or a file the probe could not check at all (no repo, no git) both
            // keep the classic reconcile_needed reading — the former IS a
            // normal, closeable editorial fact, and the latter's probe proved
            // nothing, so it must not be read as the stronger verdict.
            const deletionCandidate = d.missing && d.neverTracked;
            this.maintenanceEnqueue({
              reason: deletionCandidate ? 'deletion_candidate' : 'reconcile_needed',
              text:
                (d.missing
                  ? deletionCandidate
                    ? `owned file ${d.path} of article '${a.slug}' no longer exists (out-of-band deletion) and was never tracked on any git ref this repo can reach — DELETION CANDIDATE, not a reconcile: confirm the deletion (drop ${d.path} from files[]) or restore the file, then close this via the deletion_candidate drain`
                    : `reconcile article '${a.slug}' — owned file ${d.path} no longer exists (out-of-band deletion)`
                  : `reconcile article '${a.slug}' — owned file ${d.path} changed on disk after the article's last update (out-of-band edit)`) + disclaimed,
              file_keys: [d.path],
              feature_link: a.id,
            });
          }
          if (drifts.length > DRIFT_ITEMS_PER_READ) {
            // Never truncate SILENTLY (P5): the remainder is named on the item(s)
            // that land, so a reader knows the queue is a floor here. LANE-HONEST
            // (board e939fd21, fixer round 2, finding 4): a deletion_candidate is
            // a DIFFERENT, gated deed from a reconcile — collapsing the overflow
            // into one hard-coded reconcile_needed summary either misclassifies a
            // genuinely never-tracked file as an editable reconcile (re-minting
            // it forever, the exact defect this change exists to close) or buries
            // a real editorial fact inside a deletion-candidate summary. Split the
            // overflow BY LANE and emit one truthful summary per lane actually
            // represented, rather than one summary naming the wrong deed.
            const overflow = drifts.slice(DRIFT_ITEMS_PER_READ);
            const overflowDeletions = overflow.filter((d) => d.missing && d.neverTracked);
            const overflowReconciles = overflow.filter((d) => !(d.missing && d.neverTracked));
            if (overflowReconciles.length) {
              this.maintenanceEnqueue({
                reason: 'reconcile_needed',
                text:
                  `reconcile article '${a.slug}' — ${overflowReconciles.length} owned files drifted in one read beyond the first ${DRIFT_ITEMS_PER_READ} (which have their own items); the remainder (${overflowReconciles
                    .map((d) => d.path)
                    .join(', ')}) is covered by this one. A drift this wide usually means a whole-area change — reconcile the article as a whole.`,
                file_keys: overflowReconciles.map((d) => d.path),
                feature_link: a.id,
              });
            }
            if (overflowDeletions.length) {
              this.maintenanceEnqueue({
                reason: 'deletion_candidate',
                text:
                  `article '${a.slug}' — ${overflowDeletions.length} owned files beyond the first ${DRIFT_ITEMS_PER_READ} are DELETION CANDIDATES: never tracked on any git ref this repo can reach (${overflowDeletions
                    .map((d) => d.path)
                    .join(', ')}). Confirm the deletions (drop them from files[]) or restore the files, then close via the deletion_candidate drain.`,
                file_keys: overflowDeletions.map((d) => d.path),
                feature_link: a.id,
              });
            }
          }
          return { ...record, verify_before_use: true };
        }
        // A PARKED file is recorded once and does NOT raise verify_before_use:
        // the article's claims are accurate, the path is simply not in this
        // checkout, and telling a reader to verify before use would be false
        // alarm. Deduped on (feature_link, file) so a read loop cannot pile up
        // copies. Not auto-drained by knowledge_update either — that drain is
        // scoped to the two drift lanes — because no article write changes
        // where the file lives.
        for (const p of parkedFiles.slice(0, DRIFT_ITEMS_PER_READ)) {
          this.maintenanceEnqueue({
            reason: 'file_parked',
            text:
              `article '${a.slug}' — owned file ${p.path} is absent from the working tree but ALIVE on '${p.ref}'. ` +
              `INFORMATIONAL: no reconcile is owed and the article is correct as written. ` +
              `DO NOT DROP ${p.path} FROM THIS ARTICLE'S files[] — the path becomes valid again when that branch merges. ` +
              `This item closes when the branch lands (the merge gate sweeps it), not by a write.`,
            file_keys: [p.path],
            feature_link: a.id,
          });
        }

        // STATE HONESTY (board db7cd16c). Nothing watched the state field: the
        // hooks watch content hashes, so an article sat at `planned` over a
        // shipped, wired, probe-verified feature whose ten acceptance criteria all
        // held. The PROSE was right and the METADATA was the lie — and metadata is
        // what a reader trusts first, so anyone querying it would have concluded a
        // working feature did not exist.
        //
        // Two triggers, both cheap here because the stats are already taken:
        //  - `planned` (or `dormant`) over more owned bytes than a placeholder;
        //  - any files[] entry still flagged `unverified`, i.e. a role never
        //    written from the source. That flag exists to make the honest "I don't
        //    know this yet" cheap, and it is only worth having if something acts on
        //    it (board db7cd16c) — otherwise it is the ⚠⚠-in-prose it replaced.
        //
        // NOT a trigger, deliberately: `built`/`active` while the files are ABSENT.
        // The report asks for it, but the deletion arm above already mints an item
        // naming the missing file, and a second lane on the same fact is the
        // double-reporting this batch exists to reduce.
        const state = (record as unknown as { state?: string }).state;
        const unverifiedPaths = (a.files ?? []).filter((f) => (f as { unverified?: boolean }).unverified).map((f) => f.path);
        const overStated = (state === 'planned' || state === 'dormant') && liveBytes > PLANNED_CREDIBLE_BYTES;
        if (overStated || unverifiedPaths.length) {
          const reasons: string[] = [];
          if (overStated) {
            reasons.push(
              `it declares state '${state}' while the files it owns hold ${liveBytes} bytes of code on disk — 'planned' over written code reads as "this does not exist yet" to everyone who queries it`
            );
          }
          if (unverifiedPaths.length) {
            reasons.push(
              `its files[] roles for ${unverifiedPaths.join(', ')} are still flagged unverified — the role was never written from the source, so the article does not yet describe what those files do`
            );
          }
          this.maintenanceEnqueue({
            reason: 'state_review',
            text:
              `review article '${a.slug}' metadata against reality: ${reasons.join('; and ')}. ` +
              `Check the prose against the code before changing anything — in the reported case every acceptance criterion HELD and only the metadata was wrong, so the fix was a state change and a files[] role pass, not a rewrite. ` +
              `Then knowledge_update the state (and clear the unverified flags you have written from the file).`,
            file_keys: unverifiedPaths.length ? unverifiedPaths : (a.files ?? []).map((f) => f.path).slice(0, DRIFT_ITEMS_PER_READ),
            feature_link: a.id,
          });
        }
      }
      const basis = (record as unknown as { basis?: string }).basis;
      if ((basis === 'platform' || basis === 'external') && ageDays(record.updated_at) > this.config.staleness.platform_external_days) {
        return { ...record, verify_before_use: true };
      }
      return record;
    });
  }

  /**
   * The MCP-facing result for knowledge_query: the flagged records, PROJECTED for
   * reading, inside an envelope that DISCLOSES what the retrieval did. Two
   * failures of one class — a retrieval that misrepresents itself (P5) — and both
   * were observed, not theorized (sibling-project retrospective, 2026-07-29):
   *
   * (1) THE CAP WAS SILENT. query() caps at DEFAULT_QUERY_CAP, so a filter
   * matching 200 records returned 20 with no signal the other 180 existed. A
   * sibling conductor read such a window as the whole store and concluded it held
   * ~20 records when it held 21 feature articles alone — then reasoned from that.
   * count() already existed over the SAME base filter (the TUI's badges use it),
   * so disclosure costs one COUNT(*) and no new machinery.
   *
   * (2) VERSION HISTORY DOMINATED THE PAYLOAD. A v42 article serializes a
   * 42-entry supersedes chain plus 25 server-owned sha256 baselines on EVERY hit;
   * a cap:6 query measured 56KB, nearly none of it readable content. The
   * projection drops both — from QUERY results only. knowledge_get stays
   * full-fidelity, so nothing becomes unreachable; it just stops being paid for on
   * every retrieval. Semantic links (cites/informed_by/fulfills) SURVIVE: they
   * point at the decisions and briefs a reader may need to follow, and
   * supersedes_count keeps the version depth visible without the uuids.
   *
   * Scoped to this boundary deliberately: internal consumers read the fields the
   * projection drops (promotion.mjs filters links.rel==='fulfills'; the drift
   * wires above read file_baselines), and they call store.query/knowledgeQuery
   * directly — so trimming in the store would have starved them. knowledgeQuery
   * keeps returning full flagged records for exactly that reason.
   */
  /**
   * APPEND to an array field without retransmitting it (decision 44e45931's
   * successor — the append half of the append/identity problem).
   *
   * knowledgeUpdate REPLACES each field it receives, so adding one history entry
   * to a 25-entry article meant resending all 25 byte-exact. That cost scales with
   * how valuable a record has become, which is exactly backwards, and it produced
   * the pathology two consuming projects independently ranked their #1: a record
   * gets richer, gets bigger, becomes unwriteable, stops being updated, starts
   * lying. Measured here on 2026-07-29: reconciling one session's work took three
   * full-article hand re-transmits, one of a ~5,000-word what_it_does with a
   * 25-entry history, to add one history entry each.
   *
   * It delegates to knowledgeUpdate rather than writing its own supersede, so it
   * CANNOT diverge from the update path's guarantees: version bump, prior version
   * retained, file_baselines re-baseline, and (decision 68988832) an EXPLICIT
   * resolves claim — never an implicit drain — all happen exactly once and
   * exactly as before. Any open reconcile_needed/refresh_reference debt on the
   * chain not named in resolves is warned on the receipt, not silently
   * discharged. Only the caller's transmission cost changes — this is not a
   * second write path (invariant: one write code path).
   *
   * Refuses loudly (P5) rather than guessing: an unknown field for the type (with
   * the valid set named, same helper as the write guards), a field whose current
   * value is not an array, an empty entry list, and `links` — typed edges have
   * their own tool and a second path would let the record_links index drift.
   */
  knowledgeAppend(
    id: string,
    field: string,
    entries: unknown[],
    resolves?: string[]
  ): { record: DurableRecord; warnings: string[] } {
    const old = this.resolveRecordId(id, 'knowledge_append');
    this.refuseStaleAddress(old, id, 'knowledge_append');
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`knowledge_append: 'entries' must be a non-empty array — nothing to append`);
    }
    if (field === 'links') {
      throw new Error(`knowledge_append: 'links' is not appendable here — use knowledge_link, which also maintains the record_links index`);
    }
    this.refuseServerOwnedFields({ [field]: entries }, 'knowledge_append');
    this.refuseUnknownFields(old.type, { [field]: entries }, 'knowledge_append');
    const current = (old as unknown as Record<string, unknown>)[field];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(
        `knowledge_append: '${field}' on ${old.type} is ${typeof current}, not an array — append only extends array fields; use knowledge_update to set a scalar`
      );
    }
    const next = [...((current as unknown[]) ?? []), ...entries];
    // Straight through the ONE update path — every guarantee above rides along,
    // including the oversize check (board 8390f8fa) and the resolves claim
    // (decision 68988832): the write's result carries a warning on the SAME
    // channel knowledge_update uses. same_subject (ruling types only) is
    // split off rather than left inside `record` — see splitSameSubject.
    const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [field]: next }, resolves, undefined, 'knowledge_append'));
    // Cited-id scan (board fc053051 extension): only the newly APPENDED
    // entries — never the array's pre-existing elements, which were already
    // scanned (or not) on whatever write introduced them.
    return {
      record,
      warnings: [
        ...this.historyRotationWarnings(this.attemptedHistoryLen(old, { [field]: next }), record),
        ...this.articleOversizeWarnings(record),
        ...this.citedIdWarnings(JSON.stringify(entries)),
        ...this.openReconcileLaneWarnings(this.supersedeChain(old)),
      ],
    };
  }

  /**
   * knowledge_edit — a SURGICAL replacement inside a long STRING field (board
   * fd6d8da9), the sibling knowledge_append never had.
   *
   * knowledge_append covers arrays; a string field could only be changed by
   * retransmitting all of it. For most records that is merely wasteful, but a
   * registry-style article eventually outgrows its own round-trip: measured
   * 2026-08-03, the hooks-suite article's `what_it_does` is a single 26,364-token
   * string — too large to READ in one piece, let alone re-send byte-perfect. A
   * librarian dispatched to bump the hook count in it correctly REFUSED rather
   * than risk a silent transcription corruption, which left the article
   * un-reconcilable by any caller and blocked reconcile-always outright. Board
   * 8390f8fa had already recorded that ceiling being hit twice; this was the
   * third.
   *
   * FIND MUST MATCH EXACTLY ONCE. Zero matches and several matches are BOTH
   * refused, and the count is reported. This is the same contract as the editor
   * tools every agent already uses, for the same reason: a blind
   * replace-first-occurrence inside a field nobody can read in full is an
   * unreviewable write. Refusing on ambiguity costs a round-trip; guessing costs
   * the article.
   *
   * Everything else rides the ONE update path — version bump, retained prior
   * version, file_baselines re-baseline, the explicit resolves claim (decision
   * 68988832 — never an implicit auto-drain), coherence warnings — so an edit
   * is a normal supersession and not a back door around any of it.
   */
  knowledgeEdit(
    id: string,
    field: string,
    find: string,
    replace: string,
    resolves?: string[]
  ): {
    record: DurableRecord;
    replaced: { field: string; chars_before: number; chars_after: number };
    warnings: string[];
  } {
    const old = this.resolveRecordId(id, 'knowledge_edit');
    this.refuseStaleAddress(old, id, 'knowledge_edit');
    if (typeof find !== 'string' || find.length === 0) {
      throw new Error(`knowledge_edit: 'find' must be a non-empty string — an empty match would insert at every position`);
    }
    // ARRAY-ELEMENT ADDRESSING (board b078167a, 2026-08-09): field may be a
    // selector `arr[key=value].sub` — the one shape neither append (add-only)
    // nor plain edit (string fields only) could reach. Correcting ONE string
    // inside ONE element of a long array (canonically a stale files[].role)
    // previously required a full knowledge_update retransmitting every sibling
    // element under the documented truncation hazard; a consuming project left
    // the drift in place as the lesser evil — a bad outcome delivered by a
    // good rule. Same exactly-once contract at BOTH levels: the selector must
    // match exactly one element, and find must match exactly once inside that
    // element's field — zero and multiple are refused with the count.
    const selector = /^([A-Za-z_]\w*)\[([A-Za-z_]\w*)=(.+)\]\.([A-Za-z_]\w*)$/.exec(field);
    if (selector) {
      const [, base, key, value, sub] = selector;
      this.refuseServerOwnedFields({ [base]: replace }, 'knowledge_update');
      this.refuseUnknownFields(old.type, { [base]: replace });
      const arr = (old as unknown as Record<string, unknown>)[base];
      if (!Array.isArray(arr)) {
        throw new Error(
          `knowledge_edit: '${base}' on ${old.type} is ${arr === undefined ? 'absent' : typeof arr}, not an array — the [${key}=…] selector addresses array elements; a plain field name edits a string field`
        );
      }
      const hits = arr.filter((el) => el && typeof el === 'object' && String((el as Record<string, unknown>)[key]) === value);
      if (hits.length !== 1) {
        throw new Error(
          `knowledge_edit: selector [${key}=${value}] matches ${hits.length} element(s) of ${old.type}.${base} — exactly one is required, nothing was written. ` +
            (hits.length === 0 ? `Confirm the ${key} value against the live array.` : `Select on a key whose value is unique in the array.`)
        );
      }
      const el = hits[0] as Record<string, unknown>;
      const cur = el[sub];
      if (typeof cur !== 'string') {
        throw new Error(
          `knowledge_edit: '${sub}' on the selected ${base} element is ${cur === undefined ? 'absent' : typeof cur}, not a string — edit replaces text inside a string`
        );
      }
      const occ = cur.split(find).length - 1;
      if (occ === 0) {
        throw new Error(
          `knowledge_edit: 'find' does not appear in the selected element's '${sub}' (${cur.length} chars) — nothing was written. Confirm the exact text (including whitespace and punctuation) before retrying.`
        );
      }
      if (occ > 1) {
        throw new Error(
          `knowledge_edit: 'find' appears ${occ} times in the selected element's '${sub}' — refused as ambiguous, nothing was written. Extend 'find' with surrounding text until it identifies exactly one site.`
        );
      }
      const nextEl = { ...el, [sub]: cur.replace(find, replace) };
      const nextArr = arr.map((e) => (e === el ? nextEl : e));
      // same_subject (ruling types only) is split off rather than left
      // inside `record` — see splitSameSubject.
      const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [base]: nextArr }, resolves, undefined, 'knowledge_edit'));
      return {
        record,
        replaced: { field, chars_before: cur.length, chars_after: (nextEl[sub] as string).length },
        // Cited-id scan (board fc053051 extension): the REPLACE text only —
        // never `find`, never the rest of the record, which was already
        // scanned (or not) on whatever write introduced it.
        warnings: [
          ...this.historyRotationWarnings(this.attemptedHistoryLen(old, { [base]: nextArr }), record),
          ...this.articleOversizeWarnings(record),
          ...this.citedIdWarnings(replace),
          ...this.openReconcileLaneWarnings(this.supersedeChain(old)),
        ],
      };
    }
    this.refuseServerOwnedFields({ [field]: replace }, 'knowledge_update');
    this.refuseUnknownFields(old.type, { [field]: replace });
    const current = (old as unknown as Record<string, unknown>)[field];
    if (typeof current !== 'string') {
      throw new Error(
        `knowledge_edit: '${field}' on ${old.type} is ${current === undefined ? 'absent' : typeof current}, not a string — ` +
          `edit replaces text inside a string field. Arrays extend with knowledge_append; anything else sets with knowledge_update.`
      );
    }
    // split().length - 1 counts occurrences without a regex, so `find` needs no
    // escaping — it is treated as the literal text the caller saw.
    const occurrences = current.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `knowledge_edit: 'find' does not appear in ${old.type}.${field} — nothing was written. ` +
          `The field is ${current.length} chars; confirm the exact text (including whitespace and punctuation) before retrying.`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `knowledge_edit: 'find' appears ${occurrences} times in ${old.type}.${field} — refused as ambiguous, nothing was written. ` +
          `Extend 'find' with surrounding text until it identifies exactly one site.`
      );
    }
    const next = current.replace(find, replace);
    // same_subject (ruling types only) is split off rather than left inside
    // `record` — see splitSameSubject.
    const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [field]: next }, resolves, undefined, 'knowledge_edit'));
    return {
      record,
      replaced: { field, chars_before: current.length, chars_after: next.length },
      // Cited-id scan (board fc053051 extension): the REPLACE text only —
      // never `find`, never the rest of the record (scope guarantee: an edit
      // must not warn about a pre-existing citation elsewhere in the record
      // just because that record happens to get written again).
      warnings: [
        ...this.historyRotationWarnings(this.attemptedHistoryLen(old, { [field]: next }), record),
        ...this.articleOversizeWarnings(record),
        ...this.citedIdWarnings(replace),
        ...this.openReconcileLaneWarnings(this.supersedeChain(old)),
      ],
    };
  }

  /**
   * knowledge_array_remove — the DELETE verb the append/edit family never had
   * (board 39673f6a, article `knowledge-array-element-removal`).
   *
   * knowledge_append only ADDS to files[]/history/current_ac; knowledge_edit's
   * `arr[key=value].sub` selector replaces one STRING inside one element but
   * cannot remove the element. So dropping a single stale path meant a
   * knowledge_update retransmitting the whole array — exactly the shape that
   * produced a measured silent-truncation incident (recorded in a consuming
   * project's store): the write succeeds and the article quietly loses
   * entries nobody re-sent. The
   * asymmetry was the smell: append is protected from retransmission, edit is
   * protected from retransmission, and removal — the one operation that
   * DESTROYS content — was the one demanding you re-send everything correctly.
   *
   * SAME SELECTOR GRAMMAR, ONE LEVEL SHORTER: `arr[key=value]` with no trailing
   * `.sub`, because the whole matched element goes, not one of its strings. A
   * destroying operation with its own bespoke addressing form is how a wrong
   * target gets selected, so this reuses knowledge_edit's grammar rather than
   * inventing a second one — and its refuse-on-any-count-but-one contract.
   *
   * EXACT FULL ID ONLY. Every path that DESTROYS demands the exact full id
   * (anti-pattern `no-bounded-trail-guard-for-destructive-addressing`, severity
   * block — the collision-guard design that tried to make a forgiving form safe
   * was retracted the same day it shipped). An unambiguous 8-char prefix
   * resolves fine on knowledge_get/knowledge_update, whose worst case is a
   * recoverable edit; here the worst case is content gone from an array too
   * large to have read in full, so the ladder stops at the door.
   *
   * VERSIONED, and expected_version is REQUIRED rather than optional: the
   * caller of a destroy states which version it read, and a stale token refuses
   * naming BOTH versions instead of silently removing an element from a body
   * the caller never saw.
   */
  knowledgeArrayRemove(
    id: string,
    selector: string,
    expectedVersion: number,
    resolves?: string[]
  ): { record: DurableRecord; removed: { selector: string; element: unknown }; warnings: string[] } {
    // EXACT FULL ID ONLY — checked FIRST, before any lookup, so a prefix is
    // refused on its SHAPE and never gets the chance to resolve to something.
    if (!SterlingTools.FULL_UUID_RE.test(id)) {
      throw new Error(
        `knowledge_array_remove: '${id}' is not a full uuid — this call DESTROYS an array element, so it addresses records by their EXACT ` +
          `full id only (no slug, no 8-char citation prefix), even though knowledge_get, knowledge_update and knowledge_edit resolve all three. ` +
          `An abbreviation whose worst case is a recoverable edit is not the same abbreviation on a call that removes content you may not be able ` +
          `to re-read; that is why the full id is required here (anti-pattern no-bounded-trail-guard-for-destructive-addressing). ` +
          `Re-read the record with knowledge_get and re-issue with its full uuid; nothing was written.`
      );
    }
    const old = this.store.get(id);
    if (!old) {
      throw new Error(
        `knowledge_array_remove: no record '${id}' — this tool matches the EXACT full uuid only (no slug, no 8-char citation prefix), ` +
          `because it destroys content. Look the record up with knowledge_get and re-issue with its full uuid; nothing was written.`
      );
    }
    this.refuseStaleAddress(old, id, 'knowledge_array_remove');
    // expected_version is REQUIRED here (it is optional on knowledge_update):
    // a destroy states what it read, or it is not a conditional write at all.
    // INVALID ARGUMENT, not a CAS conflict — and it is checked HERE rather than
    // left to server.ts's `.int().positive()`, because this method is directly
    // callable and a guarantee that exists only at the MCP surface is not a
    // guarantee of the method. The two refusals are deliberately distinct: no
    // record is ever at version 0, -1 or 1.5, so calling a garbage token a
    // "version conflict" would teach the caller to retry with the current
    // version when the real fix is to pass a real token.
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error(
        `knowledge_array_remove: 'expected_version' is REQUIRED and must be a positive integer (got ${String(expectedVersion)}) — pass the ` +
          `version you read, so a removal can never land on a body you never saw. This is an invalid argument, not a stale token: no record is ` +
          `ever at version 0 or below, so re-reading the record will not help until a real version is supplied. Nothing was written.`
      );
    }
    const currentVersion = (old as unknown as { version?: number }).version;
    // A record carrying NO stored version cannot satisfy the CAS contract that
    // `expected_version` exists to provide: there is nothing for the stated
    // token to be checked against, so ANY token — right, wrong or invented —
    // would be accepted, which is precisely the outcome the required token is
    // there to forbid. Skipping the check on a DESTROYING call is therefore the
    // one thing that must not happen; an unversionable record is not
    // destroyable through this door.
    if (currentVersion === undefined) {
      throw new Error(
        `knowledge_array_remove: record '${id}' carries no stored version, so this destroying removal is REFUSED — 'expected_version' is a ` +
          `conditional-write token and an unversioned record cannot be version-checked against it: any token at all would be accepted, which is ` +
          `exactly the guarantee the required token exists to provide. Nothing was written; repair the record's version before removing from it.`
      );
    }
    if (expectedVersion !== currentVersion) {
      throw new Error(
        `knowledge_array_remove: version conflict — the caller supplied expected_version ${expectedVersion} but record '${id}' is at version ` +
          `${currentVersion}: it moved while you held it. Nothing was written; re-read the record and retry against version ${currentVersion}.`
      );
    }
    // `arr[key=value]` — knowledge_edit's grammar minus the `.sub` tail.
    const parsed = /^([A-Za-z_]\w*)\[([A-Za-z_]\w*)=(.+)\]$/.exec(selector);
    if (!parsed) {
      throw new Error(
        `knowledge_array_remove: selector '${selector}' is not of the form arr[key=value] (e.g. "files[path=scripts/prep.mjs]") — removal takes ` +
          `the WHOLE matched element, so it carries NO trailing '.sub'; that longer form is knowledge_edit's in-place string edit. Nothing was written.`
      );
    }
    const [, base, key, value] = parsed;
    // Both refusals name THIS tool: a caller mistyping a base field on a
    // knowledge_array_remove call was previously told "knowledge_update:",
    // sending them to read the wrong tool's contract.
    this.refuseServerOwnedFields({ [base]: [] }, 'knowledge_array_remove');
    this.refuseUnknownFields(old.type, { [base]: [] }, 'knowledge_array_remove');
    const arr = (old as unknown as Record<string, unknown>)[base];
    if (!Array.isArray(arr)) {
      throw new Error(
        `knowledge_array_remove: '${base}' on ${old.type} is ${arr === undefined ? 'absent' : typeof arr}, not an array — the [${key}=…] selector ` +
          `addresses array elements. Nothing was written.`
      );
    }
    // SCALAR-DISCRIMINATOR RULE, checked across the WHOLE array before any
    // matching is trusted: `String(el[key]) === value` compares a non-scalar
    // value LOSSILY (an object stringifies to "[object Object]", an array to
    // a comma-joined list), so a key that any element owns as an object or
    // array is unsound to address elements by — even for an element that
    // itself holds the key as a clean scalar, because the destroy is keyed on
    // the selector's KEY, not on any one element's value. Scanned over every
    // element that OWNS the key with a defined value (absent/undefined stays
    // a plain non-match, covered by the zero-match refusal below), so the
    // refusal fires regardless of whether the naive string comparison would
    // have produced a match.
    const nonScalarOwners = arr.filter((el) => {
      if (!el || typeof el !== 'object') return false;
      const rec = el as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(rec, key) || rec[key] === undefined) return false;
      return typeof rec[key] === 'object';
    });
    if (nonScalarOwners.length > 0) {
      throw new Error(
        `knowledge_array_remove: selector key '${key}' is not a scalar discriminator on ${old.type}.${base} — ${nonScalarOwners.length} ` +
          `element(s) own '${key}' with a non-scalar (object, array, or null) value. knowledge_array_remove addresses elements by scalar discriminators ` +
          `only (string, number, or boolean): a non-scalar value compares lossily via String() and can turn an unrelated element into a false ` +
          `match or hide a true one. Nothing was written.`
      );
    }
    // OWNERSHIP FIRST, then value. `String(el[key]) === value` alone reads an
    // ABSENT key as the string 'undefined', so `[anykey=undefined]` matched
    // every element LACKING that key — on a destroying call that turns "this
    // property does not exist" into "delete this element". The fix is an
    // ownership test, NOT a ban on the token `undefined` (an element whose
    // value genuinely IS the string "undefined" stays selectable) and NOT a
    // ban on optional keys (a present optional key stays selectable by its
    // real value). A missing key simply matches nothing, so the outcome is
    // zero matches and the refusal below already covers it.
    const hits = arr.filter((el) => {
      if (!el || typeof el !== 'object') return false;
      const rec = el as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(rec, key) || rec[key] === undefined) return false;
      return String(rec[key]) === value;
    });
    if (hits.length !== 1) {
      throw new Error(
        `knowledge_array_remove: selector [${key}=${value}] matches ${hits.length} element(s) of ${old.type}.${base} — exactly one is required, ` +
          `nothing was written. ` +
          (hits.length === 0
            ? `Confirm the ${key} value against the live array.`
            : `A blind delete inside an array too large to read is exactly the unreviewable write this grammar exists to prevent — select on a key whose value is unique in the array.`)
      );
    }
    // THE SCHEMA FLOOR, mirrored from knowledge_split's own refusal: a
    // feature_article must retain at least one owned file. featureArticleSchema
    // does not put .min(1) on files[], so an empty array would validate and the
    // article would silently become un-ownable territory — the floor has to be
    // stated here, as knowledge_split states it, and for the same reason (full
    // donation is retire-and-replace, rejected by decision 8b87efcb).
    if (old.type === 'feature_article' && base === 'files' && arr.length === 1) {
      throw new Error(
        `knowledge_array_remove: this would remove the LAST entry of feature_article.files — the article must retain at least one owned file ` +
          `(an empty files[] leaves the code it describes unowned; emptying an article is retire-and-replace, not a removal, and knowledge_split ` +
          `refuses a full donation for the same reason). Nothing was written.`
      );
    }
    // THE AUDIT-TRAIL FLOOR — A POLICY FLOOR, NOT A SCHEMA FACT. Stated
    // precisely because the first version of this comment got it wrong and an
    // independent security review caught it: `featureArticleSchema` puts NO
    // `.min(1)` on `history`, a `history: []` article parses, and there is a
    // green test proving exactly that (packages/schemas/src/tests/schemas.test.ts
    // ~:593). So the earlier claim that "no record is born without history" was
    // FALSE, and a maintainer who checked the schema would have found the
    // rationale contradicted and been entitled to delete this floor.
    //
    // The floor stands on POLICY instead, which is the stronger ground anyway:
    // `history` is the record's own account of what happened to it, and
    // anti-pattern no-bounded-trail-guard-for-destructive-addressing rests its
    // whole protection on that trail surviving — so a destroying call able to
    // empty it is that anti-pattern's root case, not an exception to it.
    //
    // The asymmetry with current_ac and live_test_refs is deliberate and rests
    // on a DIFFERENT footing, which is schema-real: both are routinely BORN
    // empty, so a removal returning one to a birth-legal state is refused by
    // nothing. History being schema-legal-empty too is why this floor must be
    // justified as policy rather than smuggled in as a schema consequence.
    if (base === 'history' && arr.length === 1) {
      throw new Error(
        `knowledge_array_remove: this would remove the LAST entry of ${old.type}.history — the record must retain at least one history entry ` +
          `(history is the record's audit trail; a destroying call that can empty it is the root case of anti-pattern ` +
          `no-bounded-trail-guard-for-destructive-addressing, whose whole protection rests on that trail surviving). The selector DID match — ` +
          `this is the floor refusing, not a failed selection. Nothing was written.`
      );
    }
    const el = hits[0];
    // Filter by IDENTITY, not by re-testing the predicate: the surviving
    // elements are the same object references in their original order, so
    // nothing is reordered, renormalised, or re-serialised on the way through.
    const nextArr = arr.filter((e) => e !== el);
    const { record } = this.splitSameSubject(
      this.knowledgeUpdate(old.id, { [base]: nextArr }, resolves, expectedVersion, 'knowledge_array_remove')
    );
    return {
      record,
      removed: { selector, element: el },
      warnings: [...this.articleOversizeWarnings(record), ...this.openReconcileLaneWarnings(this.supersedeChain(old))],
    };
  }

  /**
   * Board 8390f8fa: warn a registry-style article BEFORE it outgrows its own
   * round-trip. Measured, not guessed — every knowledge_append to
   * mcp-tool-surface (29 history entries) blew the MCP token cap on its own
   * response (68KB, then 70KB), and hooks-suite's what_it_does alone is a
   * 26,364-token string. The AC that was supposed to catch this ("split before
   * it blocks a write") is prose inside the very article it governs, and prose
   * is something a caller must CHOOSE to check — it did not fire. This does,
   * on every write that can grow a feature_article: knowledge_update (direct),
   * knowledge_append and knowledge_edit (both delegate to knowledgeUpdate, so
   * calling this once here — from THEM, on the record it returns — covers all
   * three without a second definition).
   *
   * Rides the EXISTING coherence-warning channel (decision 8ed62c1b) rather
   * than inventing a second one: knowledge_update already returns
   * {record, warnings[]} via knowledgeUpdateResult, and append/edit now carry
   * the same shape. WARNS, never refuses — same reasoning as the coherence
   * check: the write already landed, and ceremony on every partial update
   * would train callers to over-transmit, which is the problem this exists to
   * prevent.
   *
   * Size is measured as knowledge_get would return the record — i.e. the
   * record itself, since a direct-id hit in knowledge_get is exactly store.get
   * with no further projection. Deduped per ARTICLE via file_keys, not the
   * record id: a feature_article mints a new id on every version, so an
   * id-keyed maintenance item would silently stop matching the very next
   * reconcile (the same stranding bug board 6202a0f5 reports for
   * promotion_review) — the article's owned files are what stays stable.
   */
  private articleOversizeWarnings(record: DurableRecord): string[] {
    if (record.type !== 'feature_article') return [];
    // NON-history body only (board 0697c6bd): the remedy this lane names is a
    // SPLIT, and a split only ever redistributes prose — history weight is
    // bounded separately by rotation (article_history_max_entries), so counting
    // it here flagged articles a split could not fix and minted duplicate items
    // from writes the reconcile contract itself demanded.
    // recordSizes is the ONE size decomposition (board a382af6b) — the digest
    // size column and knowledge_stats measure with the same function.
    const size = recordSizes(record as unknown as Record<string, unknown>).body_chars;
    const threshold = this.config.article_oversize_chars;
    if (size <= threshold) return [];
    const a = record as unknown as { slug: string; files?: { path: string }[] };

    // Decision 881baf13 (supersedes d547d3b0): per-article accepted-oversize
    // exemption register, config.article_oversize_exempt[slug] -> justifying
    // decision id. The exemption suppresses the mint ONLY while the cited
    // decision resolves through the SAME id ladder as knowledge_get and is
    // live (status active, not superseded/retired) in the store this method
    // already has open. A missing, unresolvable, or dead citation VOIDS the
    // exemption — the mint proceeds, with the void reason appended to the
    // item text — never a silent suppression (P5).
    const exemptDecisionId = Object.hasOwn(this.config.article_oversize_exempt, a.slug)
      ? this.config.article_oversize_exempt[a.slug]
      : undefined;
    let voidReason: string | null = null;
    if (exemptDecisionId) {
      let cited: DurableRecord | undefined;
      let resolveErr: string | null = null;
      try {
        cited = this.resolveRecordId(exemptDecisionId, 'article_oversize_exempt');
      } catch (err) {
        // Carry the resolver's real refusal (collision/ambiguity/torn store)
        // instead of asserting a cause this code did not determine.
        resolveErr = err instanceof Error ? err.message : String(err);
        cited = undefined;
      }
      if (!cited) {
        voidReason = `exemption for '${a.slug}' VOID: cited decision '${exemptDecisionId}' is unresolvable (${resolveErr ?? 'does not resolve in the store'})`;
      } else if (cited.type !== 'decision') {
        voidReason = `exemption for '${a.slug}' VOID: cited record ${cited.id} is a ${cited.type}, not a decision`;
      } else if (cited.status !== 'active') {
        const supersededBy = (cited as unknown as { superseded_by?: string | null }).superseded_by;
        voidReason = `exemption for '${a.slug}' VOID: cited decision ${cited.id} is ${cited.status}${supersededBy ? ` (superseded_by ${supersededBy})` : ''}`;
      } else {
        return []; // exemption holds — suppress the mint entirely
      }
    }

    const remedy =
      'split it (one feature_article per concept FAMILY — the concept-article granularity rubric; a sub-concept splits out only when it accrues its own intent + interactions distinct from the parent) ' +
      'or, for future writes, use knowledge_edit (string fields) / knowledge_append (array fields) instead of a full knowledge_update retransmit.';
    const text = `article '${a.slug}' non-history body is ${size} chars, over the ${threshold}-char article_oversize_chars threshold — ${remedy}${voidReason ? ` (${voidReason})` : ''}`;
    const fileKeys = (a.files ?? []).map((f) => f.path);
    // Dedup on the SLUG, here at the site that owns the text format (board
    // 3acb0126): the generic enqueue dedup keys on the exact sorted file set,
    // and a reconcile that legitimately grows files[] changes that key and
    // mints a duplicate — measured 2026-08-11, contradicting decision
    // 86216751's refreshes-in-place contract. The slug is the one handle
    // stable across versions AND files[] changes; the closing quote in the
    // marker keeps a slug from prefix-matching a longer sibling.
    const marker = this.articleOversizeMarker(a.slug);
    const open = this.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 }) as unknown as { id: string; text?: string }[];
    const existing = open.find((t) => (t.text ?? '').startsWith(marker));
    if (existing) {
      this.boardUpdate(existing.id, { text, file_keys: fileKeys });
    } else {
      this.maintenanceEnqueue({ reason: 'article_oversize', text, file_keys: fileKeys });
    }
    return [
      `feature_article '${a.slug}' non-history body is now ${size} chars — over the ${threshold}-char article_oversize_chars threshold. ${remedy} ` +
        `A deduped article_oversize maintenance item has been queued.`,
    ];
  }

  /**
   * History rotation disclosure (board 0697c6bd; middle-out since ab87fe24).
   * knowledgeUpdate bounds a feature_article's history to the first
   * article_history_genesis_entries plus the newest remainder at the
   * write; this reports it on the same warnings channel the coherence and
   * oversize checks use. `attempted` is what the merged write WOULD have stored
   * unbounded (computed by attemptedHistoryLen from the caller's body and the
   * prior record). Nothing is lost by rotation — the store retains every
   * superseded version, so the chain is the archive — but a silent drop would
   * still be a lie about what the write stored (P5), hence the disclosure.
   */
  private historyRotationWarnings(attempted: number, record: DurableRecord): string[] {
    if (record.type !== 'feature_article') return [];
    const kept = ((record as unknown as { history?: unknown[] }).history ?? []).length;
    if (kept >= attempted) return [];
    const max = this.config.article_history_max_entries;
    const genesis = Math.min(this.config.article_history_genesis_entries, max - 1);
    const recentKeep = max - genesis;
    return [
      `history rotated (middle-out): kept ${kept} of ${attempted} entries — the ${genesis} genesis/founding entries plus the newest ${recentKeep} ` +
        `(article_history_max_entries=${max}, article_history_genesis_entries=${this.config.article_history_genesis_entries}); the entries evicted from the middle ` +
        `are not lost — they remain readable in the retained superseded prior version (knowledge_get a prior version's id).`,
    ];
  }

  /** The history length the caller's write would store unbounded: the passed array if the write touches history, else the prior record's. */
  private attemptedHistoryLen(old: DurableRecord, body: Record<string, unknown>): number {
    if (Array.isArray(body.history)) return body.history.length;
    const h = (old as unknown as { history?: unknown[] }).history;
    return Array.isArray(h) ? h.length : 0;
  }

  /**
   * The MCP-facing result for knowledge_update: the new version plus any COHERENCE
   * WARNINGS about what the merge left behind.
   *
   * knowledgeUpdate keeps every field you do not pass, which is what makes a
   * partial update cheap and also what lets it ship a self-contradicting record:
   * revise what_it_does, leave an intended_behavior or current_ac now asserting
   * the opposite, and nothing objects — the stale half then reads as
   * authoritative. One consuming project did exactly that four times in a single
   * session on one article.
   *
   * It WARNS rather than refuses, deliberately: only the author can judge whether
   * the untouched pairing is genuinely unaffected, and plenty of legitimate
   * updates change the description without changing the intent. A refusal here
   * would be ceremony on the common case (P1) and would train callers to pass
   * fields they had no reason to touch — which is its own drift.
   */
  knowledgeUpdateResult(
    id: string,
    body: Record<string, unknown>,
    resolves?: string[],
    expectedVersion?: number
  ): { record: DurableRecord; warnings: string[]; same_subject?: SameSubjectEntry[] } {
    // Resolved the SAME way knowledgeUpdate resolves its own `id` (uuid/slug/
    // 8-char-prefix ladder) — review finding, 2026-08-21: a raw store.get(id)
    // here only matches an exact uuid, so a slug- or prefix-addressed write
    // skipped the pre-state entirely and with it every warning below
    // (history-rotation, coherence, and the open-reconcile-lane disclosure).
    // Exact-uuid callers see byte-identical behavior — resolveRecordId returns
    // the same record store.get would, and a genuinely bad id throws here with
    // the same 'knowledge_update' naming knowledgeUpdate's own resolution would.
    const before = this.resolveRecordId(id, 'knowledge_update');
    // SAME-SUBJECT SURFACING (decision 7e3c66c5, HIGH review finding): lift
    // same_subject OUT of the flattened record and onto its own envelope
    // sibling — mirroring knowledge_create/knowledge_supersede — BEFORE this
    // wraps it as `record`. Left inside, the digest write-projection
    // (writeProjected -> digestRecord's field whitelist) silently drops it,
    // and projection:'full' would echo it back as a fake record field.
    const { record, same_subject } = this.splitSameSubject(this.knowledgeUpdate(id, body, resolves, expectedVersion));
    const warnings: string[] = before ? this.historyRotationWarnings(this.attemptedHistoryLen(before, body), record) : [];
    // A SMUGGLED `version` IS STRIPPED, AND SAID SO ([stable-identity-design-v2]
    // contract 1): the counter is server-owned, so the caller's value never
    // lands — but a silent strip is how a caller comes to believe it controls
    // the number. Refusing outright was rejected: a body copied from a previous
    // read legitimately carries the version it was read at, and refusing that
    // shape would punish the round-trip the update path exists to serve.
    if (body.version !== undefined) {
      warnings.push(
        `'version' is SERVER-OWNED and was ignored: you passed ${JSON.stringify(body.version)}, the record is now at version ` +
          `${(record as unknown as { version?: number }).version}. Each write bumps it by exactly one; pass expected_version to make a write conditional on the version you read.`
      );
    }
    if (before?.type === 'feature_article' && 'what_it_does' in body) {
      const untouched = ['intended_behavior', 'current_ac'].filter((f) => !(f in body));
      if (untouched.length > 0) {
        warnings.push(
          `what_it_does changed but ${untouched.join(' and ')} ${untouched.length === 1 ? 'was' : 'were'} not passed, so the prior text persists — ` +
            `re-read the new version and confirm it does not now contradict itself. This is a WARNING, not a refusal: the pairing is often genuinely unaffected, ` +
            `and only you can tell. (knowledge_append extends history/files/current_ac without retransmitting them.)`
        );
      }
    }
    warnings.push(...this.articleOversizeWarnings(record));
    // Cited-id scan (board fc053051 extension): only the WRITTEN partial
    // fields — `body`, the caller's own overrides — never the untouched rest
    // of the merged record, which was already scanned (or not) on whatever
    // write introduced it.
    warnings.push(...this.citedIdWarnings(JSON.stringify(body)));
    // OPEN RECONCILE-LANE DEBT DISCLOSURE (decision 68988832-2ef5-4ff3-b693-
    // d8bd8dae1): any reconcile_needed/refresh_reference item still open on
    // this article's chain, not named in this write's resolves, is unclaimed
    // debt — named here so it is visible at the exact moment the writer is
    // looking, never silent (P5). Empty when nothing is owed (P1).
    if (before) warnings.push(...this.openReconcileLaneWarnings(this.supersedeChain(before)));
    return { record, warnings, ...(same_subject ? { same_subject } : {}) };
  }

  /**
   * Digest projection for WRITE responses (2026-08-09 consuming-project
   * retrospective). Every write tool echoes the record it just wrote, and on a
   * grown article that echo is the single biggest context cost the conductor
   * pays: one history append measured 49.8KB, and two sessions independently
   * put full-record write echoes at 100KB+ of pure waste each — content the
   * caller had JUST authored and gains nothing from re-reading. With
   * projection:"digest" the result envelope survives intact (warnings,
   * check_skipped, replaced, deduped — everything a caller acts on) and only
   * the echoed record collapses to its digestRecord headline, the same
   * projection vocabulary the read side already has (decision 87a12a1e): one
   * projection concept, not two. The default is the DIGEST receipt (board
   * 7ddf13a7, flipping e23f38f8's default-full after the 2026-08-10
   * retrospective measured the echo as the biggest single context leak): the
   * envelope a caller acts on (warnings, check_skipped, replaced, deduped)
   * survives, the body the caller just authored does not come back, and
   * projection:'full' opts back in. Every boundary consumer of the full echo
   * was swept before the flip — internal callers use the tools.* methods
   * directly and still receive full records.
   */
  writeProjected<T>(result: T, projection?: 'full' | 'digest'): T | Record<string, unknown> {
    if (projection === 'full') return result;
    if (result && typeof result === 'object' && 'record' in result) {
      return { ...(result as Record<string, unknown>), record: this.digestWriteEcho((result as { record: unknown }).record as Record<string, unknown>) };
    }
    // knowledge_promote's envelope carries the written record under `promoted`
    // (not `record` — the field name says what happened to it), so it needs
    // its own branch rather than falling through to the bare-record case below,
    // which would run digestRecord over the WHOLE envelope (promoted/retired/
    // drained_review/warnings) instead of just the record it names.
    if (result && typeof result === 'object' && 'promoted' in result) {
      return { ...(result as Record<string, unknown>), promoted: this.digestWriteEcho((result as { promoted: unknown }).promoted as Record<string, unknown>) };
    }
    return this.digestWriteEcho(result as unknown as Record<string, unknown>);
  }

  /**
   * digestRecord, plus the two identity numbers a WRITE receipt exists to
   * report ([stable-identity-design-v2] contract 1): `version` and, on an
   * in-place write, `previous_version`. The whole visible contract of the pass
   * is "the id did not move, the version did" — a receipt that dropped the
   * version would hide exactly the thing the caller needs to see, and the
   * default receipt IS the digest. Only the write echo is widened; the read-side
   * digest projection (query lines) is untouched, so no read result changes
   * shape.
   */
  private digestWriteEcho(record: Record<string, unknown>): Record<string, unknown> {
    const digested = digestRecord(record);
    if (record.version !== undefined && digested.version === undefined) digested.version = record.version;
    if (record.previous_version !== undefined) digested.previous_version = record.previous_version;
    // The one write whose id MOVES (an attestation concept replacement) keeps its
    // identity_moved disclosure on the digest receipt for the same reason
    // previous_version is here: a receipt that dropped it would hide the single
    // fact the caller cannot reconstruct from what it sent.
    if (record.identity_moved !== undefined) digested.identity_moved = record.identity_moved;
    return digested;
  }

  knowledgeQueryResult(opts: QueryOptions & { projection?: Projection }): KnowledgeQueryResult {
    const { projection = 'full', ...filter } = opts;
    // projection:'count' never enumerates — no records fetch, no cap, no rank.
    // The store's uncapped count() IS the whole answer (board fa19524d): a
    // capped window can never establish absence, so a count sidesteps the
    // question of "how many can I see" entirely by never taking a window.
    if (projection === 'count') {
      const matchedFilter = this.store.count(filter);
      const byType =
        (filter.types?.length ?? 0) > 1
          ? Object.fromEntries((filter.types as string[]).map((t) => [t, this.store.count({ ...filter, types: [t] })]))
          : undefined;
      return {
        matched_filter: matchedFilter,
        returned: 0,
        cap: filter.cap ?? DEFAULT_QUERY_CAP,
        capped: false,
        answerability: matchedFilter === 0 ? 'insufficient' : 'ready',
        // A count NEVER enumerates, so no record's baseline was consulted —
        // said out loud rather than left to read as "nothing is stale here".
        provenance: 'unavailable:count_projection',
        records: [],
        ...(byType ? { by_type: byType } : {}),
      };
    }
    const records = this.knowledgeQuery(filter);
    const cap = filter.cap ?? DEFAULT_QUERY_CAP;
    // count() shares query()'s base filter but is rank-BLIND (rank_terms is a
    // no-op there), so this is "records matching the filter", which is exactly
    // the number a caller needs to see it is holding a window. Claiming it as
    // "records your query would return" would trade a silent lie for a loud one.
    const matchedFilter = this.store.count(filter);
    // returned === cap is the only truthful truncation signal: the LIMIT was
    // reached, so more MAY exist past it. returned < cap guarantees nothing was
    // dropped. Deriving capped from matchedFilter alone would false-positive
    // every time rank_terms legitimately narrowed the set.
    const capped = records.length === cap;
    const ranked = (filter.rank_terms?.length ?? 0) > 0;
    const rankRestricted = ranked && !capped && matchedFilter > records.length;
    // H19/H20 relevance slice 4b: a capped window can never establish absence
    // (verify_targets), a zero-return window carries no basis to answer from
    // (insufficient), otherwise the window is complete and non-empty (ready).
    const answerability: KnowledgeQueryResult['answerability'] = capped ? 'verify_targets' : records.length === 0 ? 'insufficient' : 'ready';
    // ABSENCE QUERY (board a577a69d): computed over the FULL match set, never
    // the capped `records` window above — min_score requires rank_terms
    // (countAboveScore refuses loudly otherwise), so a caller asking "is
    // anything ruled about X" combines the two rather than reading a bare
    // filter count as if it were a relevance judgement.
    const aboveThreshold = filter.min_score !== undefined ? this.store.countAboveScore(filter, filter.min_score) : undefined;
    // The derived baseline verdict rides EVERY enumerating projection: an
    // annotation only the expensive projection can see is one a paging reader
    // never sees. Computed over the pre-projection records, which still carry
    // the baselines projectForQuery strips.
    const { status: provenance, annotations } = this.computeBaselineDrift(records);
    const projectRecord = (r: (typeof records)[number]): Record<string, unknown> => {
      const base = projection === 'digest' ? digestRecord(r as unknown as Record<string, unknown>) : this.projectForQuery(r);
      const drift = annotations.get(r.id);
      return drift ? { ...base, baseline_drift: drift } : base;
    };
    return {
      matched_filter: matchedFilter,
      returned: records.length,
      cap,
      capped,
      ...(capped
        ? { note: this.cappedNote(records.length, matchedFilter, ranked, projection) }
        : rankRestricted
          ? {
              note: `rank_terms restricted this to ${records.length} FTS match(es); ${matchedFilter} records match the filter alone — drop or widen rank_terms to see them`,
            }
          : {}),
      answerability,
      provenance,
      records: records.map(projectRecord),
      ...(aboveThreshold !== undefined ? { above_threshold: aboveThreshold } : {}),
    };
  }

  /**
   * "Does the store govern this subject?" — asked BEFORE dispatching, rather
   * than discovering a governing record only after a subagent has already gone
   * wrong (H20/H19 relevance slice 4b). Reuses the SAME axis extraction +
   * stage-2 centrality floors H20 already applies at delivery time. Since
   * board 39c3d762 (widened by e7157d0b, then by a9be48f2) the candidate
   * surface spans all six governing types — anti_pattern, decision,
   * feature_article (territory = slug/family/title), research_finding,
   * disconfirmed_hypothesis and open_question (subject = question) — because a
   * missing type made an article-governed question answer 'nothing governs
   * this', a false negative dressed as a verdict; and
   * the no-match verdict is 'ungoverned' (renamed from 'ready', whose
   * query-envelope reading is the opposite).
   */
  knowledgePreflight(text: string): KnowledgePreflightResult {
    const terms = extractAxisTerms(text, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) {
      return { answerability: 'insufficient', reason: 'too_little_vocabulary', terms, matches: [] };
    }
    const matches = this.axisCandidateMatches(text, terms).map(({ record, hits }) => {
      // board c6e3561f disclosure-carry: a matched record carries the same
      // inbound-supersedes disclosure as knowledge_get / knowledge_query-full,
      // omitted when nothing supersedes it.
      const inbound = this.inboundSupersedesFor(record.id);
      return {
        id: record.id,
        type: record.type,
        // research_finding carries no title — its question IS the identity;
        // an article's slug beats its long title as the handle.
        title: SterlingTools.axisRecordTitle(record),
        matched_on: hits,
        central: recordCentralityHits(record, text),
        ...(inbound.length ? { inbound_supersedes: inbound } : {}),
      };
    });
    return { terms, matches, answerability: matches.length ? 'verify_targets' : 'ungoverned' };
  }

  /**
   * The candidate-matching CORE shared by knowledgePreflight and same-subject
   * surfacing on write (decision 7e3c66c5) — the preflight axis floors
   * (extractAxisTerms already run by the caller -> store.query the six
   * governing types, cap 40 each -> axisHits/hasDiscriminatingHit/
   * hasRecordCentralityHit), extracted so the floor logic is defined ONCE.
   * Callers differ only in what they do with the (record, hits) pairs and in
   * which candidates they exclude — never in how a candidate qualifies.
   */
  private axisCandidateMatches(text: string, terms: string[]): { record: DurableRecord; hits: string[] }[] {
    // rank_terms is schema-bound to <=64 chars (store's §3.4 QueryOptions
    // parse) — extractAxisTerms has no upper bound (only AXIS_MIN_TERM_LEN, a
    // floor), so a long unbroken run of the same character in authored
    // content (e.g. a filler/placeholder body) mints a term that store.query
    // would refuse outright. This is the query-building step only — filtered
    // terms still surface on knowledgePreflight's own `terms` field unchanged.
    const queryTerms = terms.filter((t) => t.length <= 64);
    // Every extracted term exceeded 64 chars: rank_terms would be [], and
    // store.query's empty-rank_terms path is a MECHANICAL RECENCY FALLBACK
    // (40 newest per type) — the wrong candidate semantics for axis matching
    // (a candidate must share vocabulary with `text`, not merely be recent)
    // and a wasted 4-type query for a result that filters to nothing once
    // axisHits runs against the (long, filtered-out-of-the-query) terms.
    if (queryTerms.length === 0) return [];
    const candidates = [
      ...this.store.query({ types: ['anti_pattern'], rank_terms: queryTerms, cap: 40 }),
      ...this.store.query({ types: ['decision'], rank_terms: queryTerms, cap: 40 }),
      ...this.store.query({ types: ['feature_article'], rank_terms: queryTerms, cap: 40 }),
      ...this.store.query({ types: ['research_finding'], rank_terms: queryTerms, cap: 40 }),
      // Refuted trails join the prior-answer surface (board e7157d0b): a brief
      // about to re-litigate a disproved hypothesis is the exact re-derivation
      // waste preflight exists to stop.
      ...this.store.query({ types: ['disconfirmed_hypothesis'], rank_terms: queryTerms, cap: 40 }),
      // OPEN QUESTIONS join it too (board a9be48f2, wiring decision
      // open-question-record-type-authorized's registered type into its
      // consuming surfaces): the prior-answer surface answers "has this been
      // settled?" — an open_question answers the adjacent "is this ALREADY
      // BEING INVESTIGATED?", and a preflight that cannot see one lets a
      // second lane restart a live investigation. axisNarrowText/axisTitleText
      // already match its `question` (packages/store/src/axis.ts), so nothing
      // in the shared matcher changes.
      ...this.store.query({ types: ['open_question'], rank_terms: queryTerms, cap: 40 }),
    ];
    return candidates
      .map((record) => ({ record, hits: axisHits(record, terms) }))
      .filter(
        ({ record, hits }) =>
          hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(hits) && hasRecordCentralityHit(record, text)
      )
      .sort((a, b) => b.hits.length - a.hits.length);
  }

  /** research_finding carries no title — its question IS the identity; an
   *  article's slug beats its long title as the handle. Shared by
   *  knowledgePreflight and sameSubjectDigest so the fallback chain is
   *  defined once. */
  private static axisRecordTitle(record: DurableRecord): string {
    return (
      (record as unknown as { title?: string }).title ??
      (record as unknown as { question?: string }).question ??
      (record as unknown as { slug?: string }).slug ??
      ''
    );
  }

  /** Disclosure cap (decision 7e3c66c5, AC7): same_subject is a hint at what
   *  else governs this subject, never an unbounded inventory. */
  private static readonly SAME_SUBJECT_CAP = 5;

  /**
   * SAME-SUBJECT SURFACING ON WRITE (decision 7e3c66c5): reuses
   * axisCandidateMatches unchanged, sourced from the WRITTEN record's own text
   * (the registered FTS extractor's output — the same text the citation scan
   * uses) rather than an outgoing dispatch prompt, and excludes a
   * caller-supplied set of ids (the write's own lineage: on update, the prior
   * version and every ancestor; on supersede, the old record and its chain;
   * on create, just the new id) rather than nothing. Advisory only: the
   * caller decides whether/where to attach the result, this never throws and
   * never influences the write itself.
   */
  private sameSubjectDigest(text: string, excludeIds: Set<string>): SameSubjectEntry[] {
    const terms = extractAxisTerms(text, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) return [];
    return this.axisCandidateMatches(text, terms)
      .filter(({ record }) => !excludeIds.has(record.id))
      .slice(0, SterlingTools.SAME_SUBJECT_CAP)
      .map(({ record, hits }) => ({
        id: record.id,
        slug: (record as unknown as { slug?: string }).slug,
        type: record.type,
        title: SterlingTools.axisRecordTitle(record),
        matched_on: hits,
        status: record.status,
      }));
  }

  /**
   * Batch preflight (board 39c3d762 slice 2 — the design_pass core): an agenda
   * of question texts in, one verdict row per question out, in input order.
   * A pure loop over knowledgePreflight — the judgment (drafting decisions for
   * the open questions) deliberately stays with the conductor (P3).
   */
  knowledgePreflightBatch(texts: string[]): { verdicts: (KnowledgePreflightResult & { text: string })[] } {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error(`knowledge_preflight: 'texts' must be a non-empty array of question texts`);
    }
    return { verdicts: texts.map((text) => ({ text, ...this.knowledgePreflight(text) })) };
  }

  /**
   * What a capped window means, and the cheapest way out of it.
   *
   * Two reported misreadings are answered here, both measured in a consuming
   * project rather than imagined:
   *
   * (1) "matched_filter: 179" against rank_terms:["garage","loadout"] was read
   *     as "179 garage decisions". It is not — rank_terms ORDER the set through
   *     bm25, they never narrow it (store query(): ORDER BY bm25, not WHERE), so
   *     the count belongs to types/stack_tags/file_keys alone. Saying only
   *     "records matching this filter" was technically true and still misread,
   *     which makes it a bad message: it let a reader believe a capped window
   *     was a relevance ranking over a relevant set.
   *
   * (2) "showing 12 of 315" left no route to the landscape — "I can neither see
   *     the whole set nor trust the sample". The digest is that route, so the
   *     message names it rather than leaving it to be discovered in a schema.
   */
  private cappedNote(returned: number, matchedFilter: number, ranked: boolean, projection: Projection): string {
    const parts = [`cap reached — showing ${returned} of ${matchedFilter} records matching the FILTER (types/stack_tags/file_keys)`];
    if (ranked) {
      parts.push(
        `rank_terms ORDERED those ${matchedFilter} and did not narrow them, so this count is NOT a measure of how many are relevant — and a capped window can never establish absence`
      );
    }
    parts.push(
      projection === 'digest'
        ? `raise cap to see the rest — at this projection every record is one headline line`
        : `raise cap, narrow the filter, or re-run with projection:"digest" to see all ${matchedFilter} as one-line headlines (id + title/trigger, no bodies) and then knowledge_get the few you want`
    );
    return parts.join('; ');
  }

  /** Query-result projection (see knowledgeQueryResult): drop the supersedes
   *  chain and the server-owned baseline hashes, keep every semantic link. */
  private projectForQuery(record: DurableRecord & { staleness?: object; verify_before_use?: boolean }): Record<string, unknown> {
    const { file_baselines: _baselines, ...rest } = record as unknown as Record<string, unknown>;
    const links = (rest.links ?? []) as { rel: string; target_id: string }[];
    const semantic = links.filter((l) => l.rel !== 'supersedes');
    const supersedesCount = links.length - semantic.length;
    // board c6e3561f disclosure-carry: the FULL projection carries the same
    // inbound-supersedes disclosure knowledge_get does (records elsewhere
    // holding a rel:'supersedes' edge onto this one). DIGEST deliberately does
    // NOT — digestRecord is a separate path that never reaches here, keeping
    // the per-record reverse-edge lookup off the landscape projection (perf).
    // Omitted when empty, matching the omit-when-empty contract.
    const inbound = this.inboundSupersedesFor(record.id);
    return {
      ...rest,
      links: semantic,
      ...(supersedesCount > 0 ? { supersedes_count: supersedesCount } : {}),
      ...(inbound.length ? { inbound_supersedes: inbound } : {}),
    };
  }

  /** The citation format the repo actually writes: 8-char id prefixes. */
  private static readonly CITATION_PREFIX_LEN = 8;

  /**
   * FULL-UUID SHAPE (canonical 8-4-4-4-12 hex, as this.newId/randomUUID mint):
   * the queue_drain_log table is keyed by exact full record id (`WHERE
   * record_id = ?`, no prefix matching), so consulting it is only a
   * meaningful check for an identifier shaped like the thing it is keyed on.
   * Gates removedItemError's drain-log clause (2026-08-22 adjudicated fix):
   * an 8-char prefix or any other non-uuid-shaped citation was NEVER going to
   * be a drain-log key, so offering "it may have aged out of the log" for one
   * sends the caller down a false trail — the honest answer is that the
   * id-resolution ladder itself found nothing, full stop.
   */
  private static readonly FULL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  /**
   * Fields knowledge_schema reports as SERVER-OWNED rather than caller-supplied:
   * the whole write-refused envelope (WRITE_REFUSED_FIELDS — one shared list
   * with refuseServerOwnedFields, so the projection and the refusal guard
   * cannot re-diverge) plus `version`, the counter this surface owns (stripped
   * with a disclosed warning at create, never honored).
   *
   * REVERSED from the earlier stance ("refuseServerOwnedFields already teaches
   * those at the write") by board 617e97d4: teaching-at-the-write IS
   * learn-by-rejection, the exact habit knowledge_schema exists to eliminate —
   * measured, a caller followed the projection's required[] verbatim and
   * composed a write the guard refused.
   */
  private static readonly SERVER_OWNED_FIELDS = SERVER_OWNED_FIELDS;

  /**
   * Envelope fields knowledge_create DEFAULTS when absent (author 'conductor',
   * links [], scope 'project', stack_tags []) — caller-SUPPLIABLE but never
   * caller-REQUIRED, so knowledge_schema reports them optional (board
   * 617e97d4: with these masked, required[] is exactly what a create must
   * supply). Keep in lockstep with the `??` defaults in knowledgeCreate.
   */
  private static readonly CREATE_DEFAULTED_FIELDS = CREATE_DEFAULTED_FIELDS;

  /** Kebab-case a record headline into its auto-minted slug (board 1e639f32). */
  private static slugify(text: string): string {
    return (
      text
        // TRANSLITERATE non-ASCII letters, never strip them (S1 design call,
        // decision human-readable-ids-for-board-items): NFD splits an accented
        // letter into its base plus a combining mark, so dropping the marks
        // gives café -> cafe and naïve -> naive. Dropping the whole letter
        // instead would give 'caf'/'nave' — a handle nobody recognises, which
        // defeats what a human-readable handle is FOR. Applied in the shared
        // slugify rather than a todo-only copy: one concept, one implementation
        // (every slug-bearing type mints the same way, canonical-naming).
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '')
    );
  }

  /**
   * A BOARD ITEM'S HEADLINE — what its slug is minted from (S1, decision
   * human-readable-ids-for-board-items). `todo` is the one slug-bearing type
   * with no headline FIELD: the precedent (de1a7329) mints from `title`, or
   * `question` on a research_finding, and a board item has only a multi-KB
   * `text`.
   *
   * FIRST LINE, NOT FIRST SENTENCE. Board items are written with an ALL-CAPS
   * opening headline on its own line, and real headlines carry internal
   * punctuation ("S1 (FIRST — S2 AND S3 BOTH CONSUME IT) — MINT A SLUG ON
   * `todo`, REUSING de1a7329."), so a first-SENTENCE rule would cut some
   * headlines mid-thought and swallow body prose whenever the headline has no
   * terminal period. The first non-blank line is the unit the convention
   * actually writes.
   *
   * A PARENTHETICAL ASIDE IS DROPPED, because real items lead with one and it
   * eats the whole 60-char budget: the item above would otherwise mint
   * 's1-first-s2-and-s3-both-consume-it-mint-a-slug-on-todo', naming the
   * sequencing note instead of the task. An aside is by definition not the main
   * clause. Fallback: a headline that is ENTIRELY parenthetical keeps its full
   * line, so dropping asides can never mint nothing.
   */
  private static todoHeadline(text: string): string {
    const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
    const withoutAsides = line.replace(/\([^)]*\)/g, ' ');
    return SterlingTools.slugify(withoutAsides) ? withoutAsides : line;
  }

  /**
   * The headline an auto-mint derives from, per type — the ONE place the
   * per-type answer lives, so the mint and any future caller cannot disagree.
   *
   * `attestation` returns '' deliberately: it has no headline field, so nothing
   * auto-mints and its slug stays explicit-only (review finding 1, 2026-08-21).
   *
   * A SYSTEM `todo` (a maintenance-queue item) likewise returns '' and mints no
   * handle (S1 design call; arm E3 of the frozen pin accepts either). Three
   * reasons: queue items are addressed by mechanisms, never cited by a human,
   * so a handle buys nothing there; their texts are near-identical by
   * construction ("reconcile article 'x' — owned file y changed"), so every
   * enqueue would walk a -2/-3/-4… suffix chain, one store query per step; and
   * a lane that mints thousands of handles would flood the one namespace the
   * cross-type collision refusal protects. Queue items still read back a
   * DISPLAY name through board_get (withDisplaySlug).
   */
  private static mintHeadlineOf(type: string, rec: Record<string, unknown>): string {
    if (type === 'todo') {
      return rec.source === 'user' ? SterlingTools.todoHeadline(String(rec.text ?? '')) : '';
    }
    return (rec.title as string | undefined) ?? (rec.question as string | undefined) ?? '';
  }

  /**
   * Auto-mint a slug from a headline (title, or question for
   * research_finding), suffixing -2/-3/... on collision. Returns undefined
   * when the headline slugifies to nothing (blank/symbols-only headline).
   * Shared by knowledgeCreate (a new record with no explicit slug) and
   * knowledge_supersede (F4 review finding: a slugless old record — e.g. a
   * pre-slug legacy row — must not silently produce a slugless new head; it
   * mints exactly the same way a brand-new create would).
   *
   * THE ≤60 CLAMP GOVERNS THE DERIVED BASE, NOT THE DISAMBIGUATOR (S1 design
   * call — de1a7329 pins "kebab-case, ≤60 chars" and says nothing about the
   * two interacting). A clash on a 60-char base therefore yields a 62-char
   * '<base>-2'. Reserving room by clamping the base shorter would shorten
   * EVERY handle to guard against a rare clash, and would break the rule that
   * the second item's handle is exactly the first's plus '-2'. The suffix is a
   * uniqueness marker, not headline text, so it is not what the budget is for.
   */
  private mintSlug(headline: string): string | undefined {
    const base = SterlingTools.slugify(headline);
    if (!base) return undefined;
    let slug = base;
    for (let n = 2; this.store.recordsBySlug(slug).length; n++) slug = `${base}-${n}`;
    return slug;
  }

  /**
   * knowledge_get — full uuid, or the 8-char PREFIX every citation in this repo
   * uses (decision 27f148c2). CLAUDE.md, code comments and record prose all cite
   * "decision 6dfbe675" style, and check-record-citations already resolves that
   * form mechanically through recordIdIndex() — so an agent handed a citation
   * from any of those surfaces could read it everywhere except through the tool
   * built for reading. Two agents in a consuming project burned a session on
   * `no record '51735bec'` for exactly this reason (the id was not stale, as
   * they concluded — superseded rows are retained by f64fd9a5 and resolve fine
   * by full id; it was truncated).
   *
   * Resolution spans the mounted fan and ANY status, tombstones included, because
   * citing a superseded record is legitimate and common. AMBIGUITY REFUSES rather
   * than picking: a prefix collision means the caller's citation is under-specified,
   * and silently serving one of two records is how a reader ends up acting on the
   * wrong one (P5).
   *
   * Extracted to `resolveRecordId` (board slice 85ecfe43) so the five write
   * tools that also take a caller-addressed id (knowledge_append, _edit,
   * _update, _retire, _link) resolve through the exact same three-form
   * contract instead of a bare store.get — knowledge_get is now a thin
   * wrapper over it.
   *
   * WINDOWED/FIELD READ (decision compaction-tooling-windowed-read-plus-split,
   * board 136091d2): `opts.field` requests one field's value instead of the
   * whole record, so an oversize article stays readable through the tool that
   * is supposed to read it — the measured defect was 4 of 77 articles in a
   * consuming project overflowing their own read tool. No `opts` (or an `opts`
   * with none of field/offset/length set) is UNCHANGED behavior — full record,
   * terminus handling included. With `field`: validated against
   * knownFieldsFor(record.type) (unknown field refused, naming it plus the
   * valid set), then projected by its runtime shape — string → kind:'string'
   * (offset/length address CHARACTERS), array → kind:'array' (offset/length
   * address ELEMENTS), anything else → kind:'value' (offset/length are refused
   * as not windowable — there is nothing to page through). offset at/past the
   * end is NOT an error: empty value/entries with the TRUE total, so paging
   * has a clean termination. `offset`/`length` without `field` is refused — a
   * window addresses one named field, never the whole record.
   *
   * VERSION PARAMETER ([stable-identity-design-v2] contract 2): `version` reads
   * the ARCHIVED snapshot at (id, version) out of record_versions, byte-exact
   * as it was stored — the point of an in-place, permanently-identified record
   * is that its history stays addressable. A version that was never archived
   * REFUSES naming it (never a silent fall back to the head, which would answer
   * a different question than the one asked); the record's CURRENT version
   * resolves to the live head, since the head is not archived until the next
   * write moves it. The parameter also accepts the bare number form
   * knowledgeGet(id, 2) alongside the options object, because the frozen S3 pin
   * suite addresses it positionally.
   */
  knowledgeGet(
    id: string,
    opts?: number | { field?: string; offset?: number; length?: number; version?: number }
  ): DurableRecord | Record<string, unknown> {
    const options = typeof opts === 'number' ? { version: opts } : opts;
    let record: DurableRecord;
    try {
      record = this.resolveRecordId(id, 'knowledge_get');
    } catch (err) {
      // A HISTORICAL id is not a miss: it resolved, to a record that now lives
      // under a canonical id. Reads serve the pinned archived snapshot plus the
      // legacy_resolution block; only writes inherit the refusal.
      //
      // THE OPTIONS ARE CONSULTED ON THIS PATH TOO (review finding): serving the
      // snapshot before reading them silently DROPPED version/field/offset/length,
      // so a windowed read through a dead id answered with a whole record and a
      // version read answered with a different version than the one asked for —
      // the exact "answered a question nobody asked" failure the version refusal
      // below exists to prevent. `version` is a pin CHECK here rather than a
      // lookup (the alias addresses exactly one archived version, so any other
      // number refuses naming both, mirroring archivedVersion's shape), and the
      // field window then rides projectFieldWindow — the same tail the live path
      // uses, which carries legacy_resolution onto the windowed shape too.
      if (err instanceof HistoricalIdError) {
        const alias = err.alias;
        if (options?.version !== undefined && options.version !== alias.archived_version) {
          throw new Error(
            `knowledge_get: '${alias.historical_id}' is a HISTORICAL id pinned to version ${alias.archived_version} of '${alias.canonical_id}', ` +
              `so version ${options.version} cannot be read through it — a dead id addresses exactly the one snapshot it was collapsed at. ` +
              `Nothing was served in its place; read version ${options.version} through the canonical id '${alias.canonical_id}'.`
          );
        }
        return this.projectFieldWindow(this.serveArchivedAlias(alias), options);
      }
      // DEAD-SLUG FALLTHROUGH (decision df361a0f, board 2b9f2f1a part 3,
      // 'supersede + disclose'), knowledge_get-ONLY: resolveRecordId already
      // tried live-slug then id-prefix resolution and both failed, so this
      // can never shadow a live record. If the id names a slug carried only
      // by superseded rows, serve the NEWEST carrier, version-pinned (own
      // id/body/status) — never redirected to the live head, which stays a
      // straight id/slug citation. No match at all (a slug never carried, or
      // an ambiguous/torn-store error) rethrows the original refusal
      // unchanged. The write surface (resolveRecordId's other callers) never
      // sees this fallback — a dead slug is not a write handle.
      //
      // The fallthrough only fires for a genuine UNRESOLVED IDENTIFIER
      // (UnresolvedIdentifierError — see resolveRecordId): the too-short and
      // no-match throws, where nothing at all matched the citation. Every
      // other refusal — a live slug collision, an ambiguous id prefix, or a
      // torn-store inconsistency — names records that DID match and must
      // reach the caller unchanged, never be swallowed in favour of a
      // superseded body (review finding, 2026-08-20).
      if (!(err instanceof UnresolvedIdentifierError)) throw err;
      const deadSlugCarriers = this.store.supersededRecordsBySlug(id);
      if (!deadSlugCarriers.length) throw err;
      record = deadSlugCarriers[0];
    }
    // Additive terminus disclosure (decision de1a7329): the pinned record's own
    // fields are never touched — a live record gets no `terminus` key at all,
    // never a null/undefined one (AC6). Only a superseded record gains it,
    // sourced from store.resolveTerminus so the disclosed end is the true chain
    // end, not the one-hop superseded_by (AC7).
    let full: DurableRecord | (DurableRecord & { terminus: unknown }) = record;
    if (options?.version !== undefined) {
      // An ARCHIVED read replaces the record entirely — no terminus disclosure,
      // because a version is not a supersession and the snapshot must come back
      // exactly as it was stored.
      full = this.archivedVersion(record, options.version) as DurableRecord;
    } else if (record.status === 'superseded') {
      const terminus = this.store.resolveTerminus(record.id);
      if (terminus) full = { ...record, terminus } as DurableRecord & { terminus: typeof terminus };
    }

    // Additive INBOUND supersedes disclosure (board c6e3561f part (a)):
    // records elsewhere holding a rel:'supersedes' link TARGETING this one.
    // Independent of this record's own status/terminus above — the whole-
    // record terminus block only ever fires for a record retired via
    // supersede(); a clause-level/partial override recorded via
    // knowledge_link never retires its target, so it stays invisible without
    // this. Skipped on an archived-version read (options.version) — a pinned
    // past snapshot is not the live relation graph — AND on a FIELD-WINDOW
    // read (options.field): projectFieldWindow's windowed shape never carries
    // this top-level key, so computing it there is pure waste (roster review
    // F1). Omitted entirely (never an empty array) when nothing supersedes
    // this record, per the "no empty-array noise" contract the rest of this
    // read already follows.
    let served: Record<string, unknown> = full as unknown as Record<string, unknown>;
    if (options?.version === undefined && options?.field === undefined) {
      const inbound = this.inboundSupersedesFor(record.id);
      if (inbound.length) {
        served = { ...served, inbound_supersedes: inbound };
      }
    }

    return this.projectFieldWindow(served, options);
  }

  /**
   * One entry of knowledgeGet's `inbound_supersedes` array — {id} always,
   * plus slug/title when cheaply available (same enrichment shape
   * knowledgePreflight's `matches` already uses via axisRecordTitle).
   *
   * INCLUDE-WITH-STATUS, not exclusion (Codex converged finding, HIGH):
   * a superseder recorded here can itself later be retired/superseded — B
   * partially supersedes A, then B is retired in favor of C — and dropping B
   * silently would recreate the exact invisibility this field exists to fix
   * (A's clause reads live-and-fresh again). So `status` always rides the
   * entry, and when the source itself is not active its own successor
   * pointer (`superseded_by`, already server-derived at hydrate time —
   * nothing extra to fetch) rides too, so the reader can follow the chain to
   * the actual survivor. A source id that no longer resolves at all is
   * dropped by the existing undefined filter in inboundSupersedes() —
   * removal already deletes the edge rows, so that case does not reach here.
   */
  private static inboundSupersedesEntry(record: DurableRecord): InboundSupersedesEntry {
    const slug = (record as unknown as { slug?: string }).slug;
    const title = SterlingTools.axisRecordTitle(record);
    const supersededBy = (record as unknown as { superseded_by?: string | null }).superseded_by;
    return {
      id: record.id,
      ...(slug ? { slug } : {}),
      ...(title ? { title } : {}),
      status: record.status,
      ...(record.status !== 'active' && supersededBy ? { superseded_by: supersededBy } : {}),
    };
  }

  /**
   * The single inbound-supersedes computation shared by every read surface
   * that carries the disclosure (knowledge_get part (a); knowledge_query-full
   * and knowledge_preflight, board c6e3561f): store.inboundSupersedes fans the
   * reverse edge across mounts, each holder is hydrated to the pinned
   * {id, slug?, title?, status, superseded_by?} entry shape. Returns [] when
   * nothing supersedes the record — every caller spreads it conditionally so
   * the key is OMITTED (never present-and-empty), matching the omit-when-empty
   * contract the rest of the read surface follows.
   */
  private inboundSupersedesFor(id: string): InboundSupersedesEntry[] {
    return this.store.inboundSupersedes(id).map((r) => SterlingTools.inboundSupersedesEntry(r));
  }

  /**
   * knowledge_get's FIELD-WINDOW tail (decision compaction-tooling-windowed-read-
   * plus-split), extracted so the ARCHIVED-ALIAS read shares it byte-for-byte
   * instead of skipping it (review finding — see the HistoricalIdError branch
   * above). `full` is whatever body the read resolved to: the live record, an
   * archived version snapshot, or an alias snapshot. legacy_resolution rides
   * through onto the windowed shape when the body carries one, because a reader
   * holding a window must still be told the id they cited is historical.
   */
  private projectFieldWindow(
    full: Record<string, unknown>,
    options?: { field?: string; offset?: number; length?: number; version?: number }
  ): DurableRecord | Record<string, unknown> {
    // No windowing requested at all: exactly today's behavior, untouched.
    if (!options || (options.field === undefined && options.offset === undefined && options.length === undefined)) {
      return full;
    }
    const { field, offset, length } = options;
    if (field === undefined) {
      throw new Error(
        `knowledge_get: 'offset'/'length' require 'field' to be set — a window addresses one named field on the record, never the whole thing.`
      );
    }
    const type = String(full.type);
    const rec = full;
    const base: Record<string, unknown> = {
      id: full.id,
      type: full.type,
      status: full.status,
      field,
      ...(rec.slug !== undefined ? { slug: rec.slug } : {}),
      ...(rec.version !== undefined ? { version: rec.version } : {}),
      // An ALIAS read keeps its disclosure on the windowed shape too: the block
      // is what tells the reader the id they cited is historical and where the
      // concept lives now, which a window has no other way to say.
      ...(rec.legacy_resolution !== undefined ? { legacy_resolution: rec.legacy_resolution } : {}),
    };
    // REAL FIELDS WIN OVER THE VIRTUAL ONE (roster review follow-up): check
    // knownFieldsFor FIRST — if some type ever registers an actual field
    // literally named 'headline', it must be reachable by field:'headline'
    // exactly like any other real field, never shadowed by the fallback
    // below. Only when no type declares 'headline' as a real field does the
    // virtual resolver get a turn.
    const known = knownFieldsFor(type);
    if (!known?.has(field)) {
      // N26: a type-agnostic headline read. 'headline' is a VIRTUAL field
      // name — not registered per-type in knownFieldsFor, because the whole
      // point is that it resolves the same way (title, falling back to
      // question, falling back to slug) on every record type, so a caller
      // does not need to know whether this record's headline lives in
      // `title` (decision/feature_article) or `question` (research_finding,
      // which carries no title at all). Reuses axisRecordTitle unchanged —
      // the same fallback chain knowledgePreflight and sameSubjectDigest
      // already rely on — so there is exactly one definition of "this
      // record's headline" in the codebase. Not windowable: it is always a
      // short derived scalar, never a long field offset/length would matter
      // for.
      if (field === 'headline') {
        if (offset !== undefined || length !== undefined) {
          throw new Error(
            `knowledge_get: field 'headline' is a derived scalar (title ?? question ?? slug) — offset/length are not windowable on it.`
          );
        }
        const value = SterlingTools.axisRecordTitle(rec as unknown as DurableRecord);
        return { ...base, kind: 'value', value };
      }
      const valid = known ? [...known].sort().join(', ') : '(unregistered type)';
      throw new Error(
        `knowledge_get: '${type}' does not define field '${field}' — valid fields: ${valid}, plus 'headline' (a virtual field on every type: title ?? question ?? slug).`
      );
    }
    const value = rec[field];
    if (typeof value === 'string') {
      const off = offset ?? 0;
      const windowed = length !== undefined ? value.slice(off, off + length) : value.slice(off);
      return { ...base, kind: 'string', total_chars: value.length, offset: off, value: windowed };
    }
    if (Array.isArray(value)) {
      const off = offset ?? 0;
      const windowed = length !== undefined ? value.slice(off, off + length) : value.slice(off);
      return { ...base, kind: 'array', total_entries: value.length, offset: off, entries: windowed };
    }
    // scalar / object / undefined: whole value, no offset/length — there is
    // nothing to page through.
    if (offset !== undefined || length !== undefined) {
      throw new Error(
        `knowledge_get: field '${field}' on ${type} is not a string or array — offset/length are not windowable on it.`
      );
    }
    return { ...base, kind: 'value', value };
  }

  /**
   * Shared id resolution (board slice 85ecfe43): full uuid, exact slug (board
   * 1e639f32), or the 8-char citation prefix (decision 27f148c2) — the same
   * three forms knowledge_get has always resolved, now reused by every write
   * tool that addresses a record by caller-supplied id so none of them can
   * drift from knowledge_get's own resolution or its ambiguity wording.
   *
   * `toolName` only changes the error prefix. `noun` lets a caller addressing
   * a LINK TARGET (knowledge_link's `to`) keep its existing "no target
   * record" phrasing distinct from "no record" for a primary subject —
   * callers outside this file already match on that distinction.
   *
   * NOT REACHED BY THE THREE DESTRUCTIVE-PATH TOOLS. board_remove,
   * maintenance_remove and validateResolveClaim resolve by EXACT id only
   * (user-ruled retraction 2026-08-22, partly retracting decision
   * id-ladder-extends-to-board-tools-with-collision-guard): every id those
   * three accept names a row that is HARD-DELETED, and an abbreviation that
   * can silently retarget must not address a destroy. They call store.get
   * directly and say why they refuse anything else — see boardRemove,
   * maintenanceRemove and validateResolveClaim.
   */
  private resolveRecordId(id: string, toolName: string, noun: 'record' | 'target record' = 'record'): DurableRecord {
    const direct = this.store.get(id);
    if (direct) return direct;
    // SLUG resolution before prefix resolution (board 1e639f32): an exact slug
    // is an IDENTITY, deterministic across the fan, and — unlike an id — it
    // names the concept, so it serves the live HEAD after any number of
    // supersessions. Slugs are unique at create, so >1 hit means a legacy or
    // cross-store clash: refuse rather than pick (P5).
    const bySlug = this.store.recordsBySlug(id);
    if (bySlug.length === 1) return bySlug[0];
    if (bySlug.length > 1) {
      // NOT an UnresolvedIdentifierError: the slug matched — more than one
      // record — so this is a genuine collision (e.g. a project record plus
      // a promoted domain copy under one slug), not a miss. knowledge_get's
      // dead-slug fallthrough must never swallow this in favour of a
      // superseded body (review finding, 2026-08-20).
      throw new Error(
        `${toolName}: slug '${id}' resolves to ${bySlug.length} records (${bySlug.map((r) => `${r.id} (${r.type})`).join('; ')}) — a slug must name one record; cite the id.`
      );
    }
    if (id.length < SterlingTools.CITATION_PREFIX_LEN) {
      throw new UnresolvedIdentifierError(
        `${toolName}: no ${noun} '${id}' — no slug matches, and it is shorter than the ${SterlingTools.CITATION_PREFIX_LEN}-char citation prefix, too little to resolve as an id. Cite at least ${SterlingTools.CITATION_PREFIX_LEN} characters, the full uuid, or an exact slug.`
      );
    }
    // HISTORICAL (aliased) ids join the ladder here, between exact-slug and
    // prefix resolution ([stable-identity-design-v2] contract 3): a LIVE record
    // always wins — an alias is consulted only once nothing live matches — and
    // an EXACT historical id is checked before any prefix, so a full dead uuid
    // never has to compete with prefixes for precedence. Read after the
    // too-short refusal because a historical id is a full uuid: nothing shorter
    // than the citation prefix can match one, so the index is not even fetched
    // on that path.
    const aliases = this.store.recordAliases();
    const exactAlias = aliases.find((a) => a.historical_id === id);
    if (exactAlias) throw this.historicalIdRefusal(exactAlias, id, toolName);
    const hits = this.store.recordIdIndex().filter((r) => r.id.startsWith(id));
    // Prefix resolution spans live ids AND aliases in ONE ambiguity judgement:
    // a prefix matching one live record and one dead id is genuinely ambiguous
    // and must refuse naming both, exactly as two live records do — picking the
    // live one silently would answer a different question than the one asked.
    // NOT an UnresolvedIdentifierError: the prefix matched real records — an
    // ambiguity between hits, not a miss. It must reach the caller unchanged,
    // same reasoning as the slug-collision throw above.
    const aliasHits = aliases.filter((a) => a.historical_id.startsWith(id));
    if (hits.length + aliasHits.length > 1) {
      throw new Error(
        `${toolName}: '${id}' is ambiguous — it prefixes ${hits.length + aliasHits.length} records: ${[
          ...hits.map((r) => `${r.id} (${r.type}, ${r.status})`),
          ...aliasHits.map((a) => `${a.historical_id} (historical id → ${a.canonical_id})`),
        ].join('; ')}. Cite more of the id.`
      );
    }
    if (hits.length === 0 && aliasHits.length === 1) throw this.historicalIdRefusal(aliasHits[0], id, toolName);
    if (hits.length === 0) throw new UnresolvedIdentifierError(`${toolName}: no ${noun} '${id}' in the project store or any mounted domain, at any status — and no slug matches`);
    const record = this.store.get(hits[0].id);
    // The index and the bodies come from the same rows, so a hit with no body is
    // a torn store, not a miss — say which it is rather than reporting "no record".
    // NOT an UnresolvedIdentifierError: the index DID resolve the id; the
    // inconsistency is in the store, not the citation.
    if (!record) throw new Error(`${toolName}: index resolved '${id}' to '${hits[0].id}' but no body was stored — the store is inconsistent`);
    return record;
  }

  /**
   * links[].target_id through the SAME id-resolution ladder as knowledge_get
   * (board 2e71d464) — a caller-supplied links[] array (knowledge_create /
   * knowledge_update / knowledge_supersede) previously reached the envelope's
   * `target_id: z.string().uuid()` schema check BEFORE anything resolved it,
   * so an 8-char prefix or a slug failed validation outright and never got
   * near resolveRecordId; the measured workaround was dropping the edge
   * entirely and keeping only a prose citation. Only a NON-full-uuid string is
   * routed through the ladder — an already-full-uuid target_id is left
   * untouched (existence is not re-checked here, preserving today's tolerance
   * for a dangling-but-well-formed target, the same shape the migration
   * classifier already expects to see) — so this only widens what resolves,
   * never what refuses. An ambiguous prefix/slug refuses naming the
   * candidates, exactly as knowledge_get does; worst case here is a
   * recoverable wrong edge, unlike the destroying paths (board_remove,
   * maintenance_remove) whose exact-id rule is untouched by this change.
   */
  private resolveLinksTargets(links: unknown, toolName: string): unknown {
    if (!Array.isArray(links)) return links;
    return links.map((link) => {
      if (!link || typeof link !== 'object') return link;
      const targetId = (link as { target_id?: unknown }).target_id;
      if (typeof targetId !== 'string' || SterlingTools.FULL_UUID_RE.test(targetId)) return link;
      const resolved = this.resolveRecordId(targetId, toolName, 'target record');
      return { ...(link as Record<string, unknown>), target_id: resolved.id };
    });
  }

  /**
   * knowledge_get's `version` read ([stable-identity-design-v2] contract 2):
   * the archived snapshot at (record id, version), or the live head when the
   * asked-for version IS the current one (the head is only archived when the
   * next write displaces it — asking for it is not an error).
   *
   * An unknown version REFUSES naming the version asked for, the versions that
   * do exist as a range, and the record — never a silent latest, which is the
   * failure that makes a reader believe an old assertion is current (P5).
   */
  private archivedVersion(record: DurableRecord, version: number): Record<string, unknown> {
    const current = (record as unknown as { version?: number }).version;
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `knowledge_get: version ${version} is not a positive integer — versions start at 1 and count up by one per write` +
          `${current !== undefined ? ` (record '${record.id}' is at version ${current})` : ''}.`
      );
    }
    if (current !== undefined && version === current) return record as unknown as Record<string, unknown>;
    const snapshot = this.store.getRecordVersion(record.id, version);
    if (!snapshot) {
      throw new Error(
        `knowledge_get: record '${record.id}' has no archived version ${version}` +
          `${current !== undefined ? ` — it is at version ${current}, so the addressable versions are 1..${current}` : ''}. ` +
          `Nothing was fabricated and the current record was NOT served in its place; re-read without 'version' for the head.`
      );
    }
    return snapshot;
  }

  /**
   * The one refusal an aliased (historical) id produces
   * ([stable-identity-design-v2] contract 3). It NAMES THE CANONICAL ID and the
   * version that id is now at, because the whole promise of the alias table is
   * that a citation written anywhere keeps resolving: telling the caller "no
   * such record" when the record is alive under another id is the false
   * negative the pass exists to remove. knowledge_get intercepts this and
   * serves the archived snapshot instead; every write tool lets it through,
   * because a write must land on the live record, never on a version-pinned
   * dead id.
   */
  private historicalIdRefusal(
    alias: { historical_id: string; canonical_id: string; archived_version: number },
    addressed: string,
    toolName: string
  ): HistoricalIdError {
    const canonical = this.store.get(alias.canonical_id) as (DurableRecord & { version?: number }) | undefined;
    const currentVersion = canonical?.version;
    const addressedAs = addressed === alias.historical_id ? `'${addressed}'` : `'${addressed}' → '${alias.historical_id}'`;
    return new HistoricalIdError(
      `${toolName}: ${addressedAs} is a HISTORICAL id — the record it named was collapsed into canonical record '${alias.canonical_id}'` +
        `${currentVersion !== undefined ? ` (now at version ${currentVersion})` : ''}, and version ${alias.archived_version} is the snapshot this id is pinned to. ` +
        `Reads through this id still work (knowledge_get serves that archived snapshot with a legacy_resolution block); a WRITE must address '${alias.canonical_id}'. Nothing was written.`,
      alias
    );
  }

  /**
   * knowledge_get's read through an alias ([stable-identity-design-v2] contract
   * 3): the ARCHIVED snapshot the historical id is pinned to, plus the
   * legacy_resolution block that tells the reader where the concept lives now
   * and how far behind this body is. Version-pinned on purpose — a citation
   * meant a specific text, and silently forwarding it to a rewritten head is
   * the failure mode decision de1a7329 already ruled out for dead ids.
   *
   * A missing snapshot refuses LOUDLY rather than falling back to the head: an
   * alias promising version N while record_versions holds no such row is a torn
   * index, and answering with different content than the caller asked for is
   * how a reader comes to believe an old citation said something it never said.
   */
  private serveArchivedAlias(alias: { historical_id: string; canonical_id: string; archived_version: number }): Record<string, unknown> {
    const canonical = this.store.get(alias.canonical_id) as (DurableRecord & { version?: number }) | undefined;
    const snapshot =
      canonical && canonical.version === alias.archived_version
        ? (canonical as unknown as Record<string, unknown>)
        : this.store.getRecordVersion(alias.canonical_id, alias.archived_version);
    if (!snapshot) {
      throw new Error(
        `knowledge_get: '${alias.historical_id}' is a historical id pinned to version ${alias.archived_version} of '${alias.canonical_id}', ` +
          `but no such archived version is stored${canonical?.version !== undefined ? ` (that record is at version ${canonical.version})` : ''} — ` +
          `the alias index and the version archive disagree, and nothing was fabricated in their place.`
      );
    }
    return {
      ...snapshot,
      legacy_resolution: {
        canonical_id: alias.canonical_id,
        archived_version: alias.archived_version,
        current_version: canonical?.version ?? alias.archived_version,
      },
    };
  }

  /**
   * Cited-id resolution warnings (board fc053051 — the phantom-id propagation
   * defect: a fabricated decision id was cited by three agents across three
   * sessions because nothing verified that record ids quoted INSIDE written
   * text actually resolve).
   *
   * Matches a citation-shaped token — a full uuid, or an 8-plus-hex-char
   * prefix — immediately following `knowledge_get` or a record-type word, the
   * convention already used throughout this store's own prose (e.g.
   * "(knowledge_get 19b506ce-…)", "decision de1a7329"). Deliberately
   * conservative: a hex-looking word with no adjacent trigger word never
   * matches, so false negatives are preferred over false positives.
   *
   * Resolution reuses recordIdIndex() — the same cheap, no-body-fetch read
   * knowledge_get's own prefix resolution uses — so ANY status resolves,
   * tombstones included (decision de1a7329: a superseded record is a
   * legitimate citation).
   */
  // Separator class widened (board fc053051 extension) to tolerate the
  // spellings already seen in review feedback and in this store's own prose:
  // a plain space, an opening paren, a colon ("decision: 19b506ce"), and a
  // backtick ("decision `19b506ce`") — alongside the original space/paren.
  // The id capture is widened from EXACTLY 8 hex chars to 8-40, because a
  // dash-less citation longer than 8 (e.g. a 12- or 16-char prefix) used to
  // be clipped at 8 chars and then fail the trailing \b boundary check
  // (still a hex digit, not a boundary) — so it silently matched nothing. A
  // real uuid's first segment is exactly 8 hex chars before its own dash, so
  // the greedy {8,40} run still stops there and the optional dashed
  // remainder below picks up the rest unchanged.
  private static readonly CITATION_TRIGGER = ['knowledge_get', ...Object.keys(RECORD_TYPES)].join('|');
  private static readonly CITATION_RE = new RegExp(
    `\\b(?:${SterlingTools.CITATION_TRIGGER})\\b[\\s(:\`]*([0-9a-fA-F]{8,40}(?:-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?)\\b`,
    'g'
  );

  // The SAME origin-only marker the knowledge-export exporter honors
  // (scripts/knowledge-export.mjs ORIGIN_IDS_OPEN/CLOSE, board c3705a15 design
  // pass 2026-08-24): prose wrapped in [origin-ids: <reason>] ... [/origin-ids]
  // legitimately carries ids that resolve on ANOTHER machine (a payload's
  // provenance block, an id map recorded in an article's history) and is never
  // meant to be treated as a fresh citation here. Duplicated rather than
  // imported — scripts/ stays standalone .mjs, tools.ts is compiled TypeScript
  // in a different workspace — so the two constants are kept textually
  // identical on purpose; a future divergence must change both call sites.
  private static readonly ORIGIN_IDS_OPEN_RE = /\[origin-ids:/g;
  private static readonly ORIGIN_IDS_CLOSE_RE = /\[\/origin-ids\]/g;
  private static readonly ORIGIN_IDS_BLOCK_RE = /\[origin-ids:[\s\S]*?\[\/origin-ids\]/g;

  /**
   * Strip balanced origin-ids regions before a citation scan. UNLIKE the
   * exporter (which REFUSES on an unbalanced marker — it can afford to, since
   * nothing has shipped yet), this write path only ever WARNS, so an
   * unbalanced '[origin-ids:' grants NO exemption at all rather than guessing
   * which close it pairs with — the citation(s) it would have shielded are
   * scanned and, if fabricated, still warned about. Fail-safe, not fail-open.
   */
  private stripOriginIdsRegions(text: string): string {
    const opens = (text.match(SterlingTools.ORIGIN_IDS_OPEN_RE) ?? []).length;
    const closes = (text.match(SterlingTools.ORIGIN_IDS_CLOSE_RE) ?? []).length;
    if (opens === 0 || opens !== closes) return text;
    return text.replace(SterlingTools.ORIGIN_IDS_BLOCK_RE, '');
  }

  private citedIdWarnings(text: string): string[] {
    if (!text) return [];
    const scanText = this.stripOriginIdsRegions(text);
    const index = this.store.recordIdIndex();
    // ALIASES COUNT AS RESOLUTION ([stable-identity-design-v2] contract 3): a
    // HISTORICAL id resolves — knowledge_get serves its archived snapshot with a
    // legacy_resolution block — so warning "fabricated or mistyped" on it would
    // be exactly the FALSE POSITIVE the pass promises never to produce, on every
    // migrated citation in the store's own prose. No new wording for this case,
    // deliberately: a citation that resolves produces NO warning, whichever
    // index resolved it.
    const aliases = this.store.recordAliases();
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const match of scanText.matchAll(SterlingTools.CITATION_RE)) {
      const cited = match[1];
      const lower = cited.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      // AMBIGUOUS PREFIX (board c3705a15 design pass): the same rule
      // scripts/lib/citations.mjs buildResolver enforces — a FULL id must
      // match a FULL id (no ambiguity is possible there, only exists/doesn't),
      // but a bare 8-hex-char citation with no dashed remainder is a PREFIX,
      // and a prefix matching more than one record's id (or historical alias)
      // is not a clean resolve — it is a distinct record picked ambiguously,
      // which must never pass silently as "resolves" just because SOME record
      // happens to start with it.
      if (lower.length === 8) {
        const hits = new Set<string>();
        for (const r of index) if (r.id.toLowerCase().startsWith(lower)) hits.add(r.id.toLowerCase());
        for (const a of aliases) if (a.historical_id.toLowerCase().startsWith(lower)) hits.add(a.historical_id.toLowerCase());
        if (hits.size === 0) {
          warnings.push(
            `cited id '${cited}' does not resolve to any record in the project store or any mounted domain, at any status — check for a fabricated or mistyped citation`
          );
        } else if (hits.size > 1) {
          warnings.push(`cited id '${cited}' is an ambiguous 8-char prefix — it matches more than one record; cite more of the id`);
        }
        continue;
      }
      const resolves =
        index.some((r) => r.id.toLowerCase().startsWith(lower)) ||
        aliases.some((a) => a.historical_id.toLowerCase().startsWith(lower));
      if (!resolves) {
        warnings.push(
          `cited id '${cited}' does not resolve to any record in the project store or any mounted domain, at any status — check for a fabricated or mistyped citation`
        );
      }
    }
    return warnings;
  }

  /**
   * knowledgeUpdate's return is the new record FLATTENED, with same_subject
   * spliced in as an extra property for ruling types — convenient for a
   * direct caller reading `.status` and `.same_subject` off one object, but
   * poison for anything that re-wraps the return as `record`: the field
   * would either vanish under the digest write-projection's field whitelist
   * (finding: knowledge_update's disclosure never reached MCP callers while
   * create/supersede, which emit it as a proper envelope sibling, survived)
   * or, on projection:'full', round-trip as a FAKE record field. Every
   * internal re-wrapper (knowledgeAppend, knowledgeEdit, knowledgeUpdateResult)
   * splits it off here first and puts it on its own envelope instead.
   */
  private splitSameSubject(rec: DurableRecord & { same_subject?: SameSubjectEntry[] }): { record: DurableRecord; same_subject?: SameSubjectEntry[] } {
    const { same_subject, ...record } = rec;
    return { record: record as DurableRecord, same_subject };
  }

  /**
   * The whole supersede lineage a maintenance item's feature_link may point
   * at: `record`'s own id plus every ancestor it already carries a
   * 'supersedes' link to. An item raised against an earlier version still
   * matches after a later reconcile superseded it — chain membership, not
   * exact-id match. Shared by knowledgeUpdate's resolves validation/drain,
   * repointPromotionReview, and the open-reconcile-lane disclosure below.
   */
  private supersedeChain(record: DurableRecord): Set<string> {
    const chain = new Set<string>([record.id]);
    for (const link of (record.links ?? []) as { rel: string; target_id: string }[]) {
      if (link.rel === 'supersedes') chain.add(link.target_id);
    }
    return chain;
  }

  /**
   * The article_oversize dedup marker articleOversizeWarnings mints/matches
   * for a slug (decision article-oversize-dedups-on-the-slug-at-its-minting-
   * site, 19b506ce-5c12-46d5-afa1-5a32170bab8d). Extracted so every caller
   * that needs to recognize "is this item the oversize item for THIS article"
   * — articleOversizeWarnings itself and validateResolveClaim's split
   * semantics below — derives the prefix from the ONE place that owns the
   * text format, never a hand-copied literal.
   */
  private articleOversizeMarker(slug: string): string {
    return `article '${slug}'`;
  }

  /**
   * VERSION-CONFLICT DISCLOSURE (board 13bd5507's live half): a uuid that
   * resolves to a SUPERSEDED record means the writer read a version that
   * moved while they held it. The store's supersede() guard would refuse the
   * fork anyway — this refusal fires FIRST, before any field logic operates
   * on the stale body (knowledge_edit's find-match, knowledge_append's array
   * read), so the stale reader learns WHAT happened and WHERE the head is
   * instead of an opaque low-context error. Slug addresses always serve the
   * head, so they never land here. resolveTerminus never PROMISES a live
   * terminus (truncation past MAX_HOPS; a dangling chain returns the record
   * itself), so the head is named only when verifiably live; otherwise the
   * remedy is slug resolution (review finding 2026-08-21).
   */
  private refuseStaleAddress(old: DurableRecord, id: string, toolName: string): void {
    if (old.status !== 'superseded') return;
    const terminus = this.store.resolveTerminus(old.id);
    const head = terminus && !terminus.truncated ? this.store.get(terminus.id) : null;
    const h = head as { id: string; status: string; slug?: string; version?: number } | null;
    const headIsLive = h !== null && h.status !== 'superseded' && h.id !== old.id;
    const where = headIsLive
      ? `The live head is ${h.id}${h.slug ? ` (slug '${h.slug}')` : ''}${h.version !== undefined ? ` v${h.version}` : ''}.`
      : `The supersession chain could not be followed to a live head from this record — resolve by SLUG, which always serves the head.`;
    const addressed = id === old.id ? `'${old.id}'` : `'${id}' → '${old.id}'`;
    throw new Error(
      `${toolName}: version conflict — ${addressed} resolves to a SUPERSEDED record: it was superseded (or retired in favour of a survivor) while you held it. ` +
        `${where} Re-read the live head and re-apply your change on it — nothing was written.`
    );
  }

  /**
   * Validate ONE `resolves` claim BEFORE any write lands (decision
   * 68988832-2ef5-4ff3-b693-4f0f0ea8dae1; board 68fe8373 — replaces the
   * implicit chain-based auto-drain of decision 8ecd435f). The named id must:
   * exist as an open maintenance item; be in a DRAINABLE lane
   * (reconcile_needed or refresh_reference — promotion_review and every
   * other lane close only through their own mechanism, never resolves); and
   * key to the record being written, via feature_link landing in its
   * supersedes chain (this id or an ancestor). Any miss throws, naming the
   * offending id and the reason, so a write that lands is a write whose
   * claims were checked — no version minted, no item removed on a refusal.
   *
   * `options.splitMarker`, set ONLY by knowledge_split (decision
   * compaction-tooling-windowed-read-plus-split), widens the lane/match rules
   * without a second copy of this function: promotion_review stays refused
   * UNCONDITIONALLY either way (P1 — a human gate, same wording both paths);
   * every OTHER lane closes when the item's feature_link lands in the
   * supersede chain passed in OR its text starts with the article-oversize
   * marker for the split's parent slug — the item a split most naturally
   * discharges (article_oversize) predates the split and carries neither a
   * matching feature_link nor a restriction to knowledgeUpdate's two lanes.
   */
  /**
   * Lanes a knowledge_update (in-place, non-split) `resolves` claim may close —
   * board 4afbfa56, extending decision 68988832's original reconcile_needed/
   * refresh_reference pair. The fulfilling-write discharge shape for these
   * three ALREADY EXISTS (knowledge_update), so this is exactly the same
   * mechanism, just a wider allowed set — not a new abstraction. The other
   * five open lanes stay unwired here on purpose: capture_owed/article_missing/
   * research_owed/concept_article_missing discharge via knowledge_create (no
   * resolves parameter yet — separate gap); deletion_candidate via
   * knowledge_retire (separate gap); promotion_review/file_parked are
   * removal-only by design; restore_performed is keyed by file_keys, not
   * feature_link, and needs its own design. USER-RULED 2026-08-25: only these
   * three tranches were selected — knowledge_create and knowledge_retire were
   * NOT.
   */
  private static readonly UPDATE_RESOLVABLE_LANES = new Set([
    'reconcile_needed',
    'refresh_reference',
    'stale_research',
    'wire_in_dormant',
    'state_review',
  ]);

  private validateResolveClaim(id: string, chain: Set<string>, options?: { splitMarker: string }): DurableRecord {
    // EXACT FULL ID ONLY — no slug rung, no prefix rung (USER-RULED RETRACTION
    // 2026-08-22, partly retracting decision
    // id-ladder-extends-to-board-tools-with-collision-guard, which had wired
    // the ladder here on the rationale that this is "an in-place edit").
    //
    // THAT RATIONALE WAS FALSE, and this is a DESTRUCTIVE path: every claim
    // this validator returns is HARD-DELETED by its caller — the attestation
    // (supersede) branch of the shared update path calls store.remove on each
    // claim directly, the in-place branch threads them into store.updateRecord
    // which drains them inside the same transaction, and knowledgeSplit removes
    // them too. So the prefix rung here was a third irreversible destruction
    // path with no guard on it at all.
    //
    // WORST CASE, concretely: reconcile_needed items A and B are SIBLINGS under
    // one article, so lane, source and feature_link are IDENTICAL and nothing
    // downstream can tell them apart. Cite prefix P for A, A is drained, B also
    // starts with P — the claim silently retargets to B, hard-deletes real
    // un-discharged reconcile debt, and the receipt reports success. Hence the
    // full uuid or nothing (P5: the dangerous case must fail loud).
    const record = this.store.get(id);
    if (!record) {
      // SHAPE FIRST: the removal log is keyed by exact full record id, so an
      // abbreviation was never a key in it — telling the caller its trace "may
      // have aged out" would be a false trail. What it actually needs to hear
      // is that this tool takes the full uuid, and why.
      if (!SterlingTools.FULL_UUID_RE.test(id)) {
        throw new Error(
          `resolves: names '${id}', which is not a full record id — resolves requires the FULL uuid of every maintenance item it claims. ` +
            `A claimed item is HARD-DELETED as the write lands, so an abbreviated citation (an 8-char prefix or a slug) could silently ` +
            `retarget to a DIFFERENT, un-discharged item — sibling reconcile items under one article are indistinguishable by lane, ` +
            `source or feature_link, so nothing downstream would catch it. Look the item up with maintenance_query and cite its full ` +
            `id; nothing was written.`
        );
      }
      // Distinguish "never existed" from "already removed" the same way
      // removedItemError does for maintenance_remove — a closed item cannot
      // be re-claimed, and that is a different refusal than a bogus id.
      const trace = this.store.drainLogEntry(id);
      if (trace) {
        throw new Error(
          `resolves: names '${id}', which is not OPEN — it was already removed` +
            (trace.drained_at ? ` at ${trace.drained_at}` : '') +
            ` (per the drain log). A closed item cannot be re-claimed; nothing was written.`
        );
      }
      throw new Error(
        `resolves: names '${id}', which does not exist as a maintenance item under that EXACT id. ` +
          `resolves matches the full uuid only — no slug, no 8-char prefix — because a claimed item is hard-deleted as the write ` +
          `lands and a stale abbreviation could silently retarget to a different item. Nothing was written.`
      );
    }
    const it = record as unknown as { type: string; source?: string; system_reason?: string; feature_link?: string; text?: string };
    if (it.type !== 'todo' || it.source !== 'system') {
      throw new Error(`resolves: names '${id}', which is not a system maintenance-queue item; nothing was written.`);
    }
    const isSplit = options !== undefined;
    const laneAllowed = isSplit
      ? it.system_reason !== 'promotion_review'
      : SterlingTools.UPDATE_RESOLVABLE_LANES.has(it.system_reason ?? '');
    if (!laneAllowed) {
      throw new Error(
        `resolves: names '${id}' (${it.system_reason ?? 'unknown'} lane) — only ${[...SterlingTools.UPDATE_RESOLVABLE_LANES].join(', ')} items ` +
          `close via resolves; every other lane, including promotion_review, closes only through its own mechanism. Nothing was written.`
      );
    }
    const inChain = it.feature_link !== undefined && chain.has(it.feature_link);
    const marksThisArticle = isSplit && (it.text ?? '').startsWith(options!.splitMarker);
    if (!inChain && !marksThisArticle) {
      throw new Error(
        isSplit
          ? `resolves: names '${id}', whose feature_link does not match this split's parent (or its supersedes-chain ancestors), and whose text does not match the article-oversize marker for the parent's slug; nothing was written.`
          : `resolves: names '${id}', whose feature_link does not match this record or any of its supersedes-chain ancestors; nothing was written.`
      );
    }
    return record;
  }

  /**
   * Open debt still standing on `chain` after a write, across every lane a
   * knowledge_update `resolves` claim can close (UPDATE_RESOLVABLE_LANES) —
   * one line per item (id + text prefix), never the whole item (decision
   * 68988832, widened board 4afbfa56). Called AFTER the write, so any item
   * this same write's `resolves` claimed is already gone from
   * maintenanceQuery and never appears here; empty when nothing is owed (P1 —
   * a clean write stays clean).
   */
  private openReconcileLaneWarnings(chain: Set<string>): string[] {
    const warnings: string[] = [];
    const sweepCap = 1000;
    const items = this.maintenanceQuery({ cap: sweepCap });
    for (const item of items) {
      const it = item as unknown as { id: string; feature_link?: string; system_reason?: string; text?: string };
      if (
        it.system_reason !== undefined &&
        SterlingTools.UPDATE_RESOLVABLE_LANES.has(it.system_reason) &&
        it.feature_link !== undefined &&
        chain.has(it.feature_link)
      ) {
        warnings.push(`open ${it.system_reason} item '${it.id}' on this article is not named in resolves and stays open — ${(it.text ?? '').slice(0, 120)}`);
      }
    }
    // The sweep is capped (P5): a queue exactly AT the cap may be hiding more
    // open debt past this window — say so rather than reading the sweep as
    // exhaustive (mirrors boardFiltered's scanTruncated disclosure).
    if (items.length >= sweepCap) {
      warnings.push(
        `the open-reconcile-lane sweep hit its ${sweepCap}-item cap — more open ${[...SterlingTools.UPDATE_RESOLVABLE_LANES].join('/')} debt may exist past this window; narrow with maintenance_query to confirm.`
      );
    }
    return warnings;
  }

  /**
   * Versioned change (§10) — IN PLACE since S3 ([stable-identity-design-v2]):
   * the record's id NEVER changes, the server-owned `version` counter bumps by
   * one, and the full prior body is archived in record_versions (readable via
   * knowledge_get's `version` parameter). The write rides the store's in-place
   * triad (store.updateRecord), which is the single transaction that also
   * drains any `resolves` claim — so a refused claim rolls the version bump
   * back with it, rather than leaving a bumped record beside an undrained item.
   *
   * WHY THIS REPLACED RE-MINTING: every citation written anywhere — commit
   * message, brief, board item, article prose, a maintenance item's
   * feature_link — used to rot the moment the record it named was edited, and
   * "this record changed" was expressed by minting a new id, which made
   * supersession meaningless as a statement about CONCEPTS. Version says
   * "changed"; supersession now says only "replaced by a different ruling".
   *
   * THE ONE EXCEPTION IS attestation: an inspection verdict is immutable by
   * construction, so an update to one is a CONCEPT REPLACEMENT — a new record
   * with a new id, the prior one retired (pinned by attestation-immutability
   * and S3-2). Nothing else re-mints here.
   *
   * `expectedVersion` is the CAS token that replaces the accidental
   * UUID-as-token of the supersede era: a stale value refuses naming BOTH
   * versions, with nothing written. It sits in the 4th positional slot and
   * `toolName` moves to the 5th — the least-disruptive extension of the already
   * frozen (id, patch, resolves) shape.
   *
   * A caller-supplied `version` is STRIPPED here, never honored: the counter is
   * server-owned at every surface, so a smuggled value can neither jump the
   * count nor be silently persisted (knowledgeUpdateResult surfaces the strip
   * as a warning rather than letting it pass unremarked).
   */
  knowledgeUpdate(
    id: string,
    body: Record<string, unknown>,
    resolves?: string[],
    expectedVersion?: number,
    toolName = 'knowledge_update'
  ): DurableRecord & { same_subject?: SameSubjectEntry[]; previous_version?: number; identity_moved?: { previous_id: string; note: string } } {
    const old = this.resolveRecordId(id, toolName);
    this.refuseStaleAddress(old, id, toolName);
    this.refuseServerOwnedFields(body, 'knowledge_update');
    const ts = this.now();
    const { id: _i, status: _s, superseded_by: _sb, created_at: _c, updated_at: _u, type: _t, version: _v, ...overrides } = body;
    // Same refusal as create, applied to the CALLER's fields rather than the
    // merged record: `old` is already valid, so anything unknown came from this
    // call. Without it the merge silently discarded the field and reported a new
    // version — the failure that makes a "fix" look applied when it never landed.
    this.refuseUnknownFields(old.type, overrides);
    // links[].target_id THROUGH THE LADDER (board 2e71d464): a caller-supplied
    // `links` array in this update's own body may cite a slug or 8-char prefix
    // the same way knowledge_get already resolves; `old.links` (spread into
    // `next` below when this call touches no links) is already stored as full
    // ids from a prior resolved write, so only an EXPLICIT overrides.links
    // needs this pass.
    if (overrides.links !== undefined) {
      overrides.links = this.resolveLinksTargets(overrides.links, toolName);
    }
    // The item's feature_link points to whatever version was current when it
    // was raised, which may now be an ancestor, so match the whole supersede
    // chain — computed for every type, since promotion_review (below) can
    // point at any supersedable record, not only feature_article/reference_material.
    const chain = this.supersedeChain(old);
    // A duplicated id is a meaningless second claim — the item can only be
    // drained once, so naming it twice is refused loudly rather than silently
    // validating and no-oping on the repeat (same refuse-on-meaningless-claim
    // posture as every other resolves violation below).
    if (resolves) {
      const seen = new Set<string>();
      const duplicate = resolves.find((rid) => (seen.has(rid) ? true : (seen.add(rid), false)));
      if (duplicate !== undefined) {
        throw new Error(`resolves: '${duplicate}' is named more than once — an item can only be claimed once; nothing was written.`);
      }
    }
    // RESOLVES CLAIM VALIDATION runs BEFORE any write (decision 68988832): a
    // write that does not validate is a write that must not land.
    const claims = (resolves ?? []).map((rid) => this.validateResolveClaim(rid, chain));
    // ATTESTATION ONLY: a new id, a new birth clock, a retired predecessor.
    // Every other type keeps its id and its created_at — identity and birth are
    // properties of the RECORD, not of the version being written.
    const replaced = old.type === 'attestation';
    const next: Record<string, unknown> = {
      ...old,
      ...overrides,
      id: replaced ? this.newId() : old.id,
      type: old.type,
      created_at: replaced ? ts : old.created_at,
      updated_at: ts,
      ...(replaced ? { status: 'active', superseded_by: null } : {}),
    };
    // History rotation (board 0697c6bd): bound the stored history to genesis +
    // newest entries. The middle is dropped from the version being written —
    // the PRIOR body, archived whole in record_versions by this same write,
    // retains them forever (the archive that decision c68eb219's rotation
    // originally leaned on the supersede chain for), so no entry ever becomes
    // unreadable. Callers see the rotation via historyRotationWarnings on the
    // write's result envelope.
    if (old.type === 'feature_article') {
      const hist = next.history as unknown[] | undefined;
      const max = this.config.article_history_max_entries;
      if (Array.isArray(hist) && hist.length > max) {
        // MIDDLE-OUT rotation (board ab87fe24, replacing the old "keep newest
        // max" behavior): keep the first `genesis` entries (founding, by array
        // position) plus the newest (max - genesis) entries, evicting the
        // middle. genesis clamps to max - 1 so at least one recent entry
        // always survives even when genesis_entries >= max.
        const genesis = Math.min(this.config.article_history_genesis_entries, max - 1);
        const recentKeep = max - genesis;
        next.history = [...hist.slice(0, genesis), ...hist.slice(hist.length - recentKeep)];
      }
    }
    // re-baseline on every reconcile: the new version's owned-file hashes become
    // the truth the next read-time drift check compares against, so reconciling
    // an article both clears its current flag and immunizes it against the next
    // merge's mtime reset (§3.2.3). Overwrites any stale baseline carried from old.
    if (next.type === 'feature_article' || next.type === 'reference_material') {
      next.file_baselines = this.computeBaselines(next);
    }
    const previousVersion = (old as unknown as { version?: number }).version;
    // EXPLICIT-RESOLVES CLOSURE (decision 68988832-2ef5-4ff3-b693-4f0f0ea8dae1;
    // board 68fe8373): drain EXACTLY the named+validated items, through the
    // SAME drain-log path maintenance_remove uses, so maintenance_remove later
    // answers already_drained:true. The old implicit chain-based auto-drain
    // (decision 8ecd435f — every open reconcile_needed/refresh_reference item
    // on the chain, discharged by ANY write, no claim required) is REMOVED: a
    // write that does not name an item leaves it open, however tightly linked.
    //
    // Since S3 the drain rides INSIDE the store write's own transaction
    // ([stable-identity-design-v2] contract 5) rather than following it as a
    // separate loop: a claim that the store cannot close now rolls the version
    // bump and the snapshot back with it. The tool-layer validation above still
    // runs FIRST and still owns every message a caller reads (lane rules,
    // feature_link matching, already-drained traces) — the store's own check is
    // the transactional backstop, not the explanation.
    let updated: DurableRecord;
    // The store's own validateRecord re-parses the merged record (`next`) and,
    // on a caller-supplied bad element (e.g. a history entry passed as a bare
    // string), throws zod's raw ZodError across the store boundary — the
    // knowledge_append/knowledge_create shared refusal-shape contract (board
    // 03c92e2a) applies here too, so it is caught and re-rendered the same way.
    try {
      if (replaced) {
        // The attestation path keeps expected_version meaningful by checking it
        // here: store.supersede has no CAS token of its own, and silently
        // ignoring a caller's token would be the exact failure the token exists
        // to prevent.
        if (expectedVersion !== undefined && previousVersion !== undefined && expectedVersion !== previousVersion) {
          throw new Error(
            `${toolName}: stale expected_version — the caller supplied expected_version ${expectedVersion} but record '${old.id}' is at version ` +
              `${previousVersion}. Nothing was written; re-read the record and retry against version ${previousVersion}.`
          );
        }
        updated = this.store.supersede(old.id, next);
        for (const claim of claims) {
          this.store.remove(claim.id, ts);
        }
      } else {
        // EVERY in-place write is CAS-GUARDED, not only the ones that passed a
        // token (review finding): this tool layer is a READ-MODIFY-WRITE — `next`
        // is merged from the `old` read at the top of this call — so the version
        // that read observed IS the write's precondition. Without it two writers
        // against one store (MCP server + TUI, both importing packages/store) can
        // each merge from version n and the second silently overwrites the first's
        // fields: a LOST UPDATE nobody sees, rather than a conflict. Covers
        // knowledge_append and knowledge_edit too, whose merge is entirely
        // server-side and had no token to pass.
        //
        // A caller-supplied expected_version still WINS — it is a stricter
        // statement about what the CALLER read, and a mismatch between the two is
        // itself a conflict worth refusing. A conflict surfaces as the store's own
        // version-conflict refusal, naming both versions with nothing written; no
        // retry loop, deliberately (a silent retry would re-merge onto a body the
        // caller never saw, which is the lost update by another route).
        const cas = expectedVersion ?? previousVersion;
        updated = this.store.updateRecord(old.id, next, {
          ...(cas !== undefined ? { expected_version: cas } : {}),
          ...(claims.length ? { resolves: claims.map((claim) => claim.id) } : {}),
        });
      }
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, old.type, toolName);
      throw err;
    }
    this.repointPromotionReview(chain, updated.id, ts);
    // SAME-SUBJECT SURFACING (decision 7e3c66c5): only for the three ruling
    // types — other types' update responses stay byte-identical. Excludes
    // the update's own lineage: `chain` (the prior version plus every
    // ancestor it already carries a 'supersedes' link to — the exact set
    // repointPromotionReview reuses above) plus the new record's own id, so
    // the disclosure never names the write's own prior self or its own new
    // self. Sourced from the registered FTS extractor's text over the
    // MERGED record about to be persisted.
    //
    // `previous_version` rides the echo on the in-place path so a caller can
    // SEE the bump it just caused (n-1 → n) without a second read — the receipt
    // for "the id did not move, the version did". The replacement path omits it:
    // a new record's version 1 has no predecessor of its own.
    //
    // THE REPLACEMENT PATH DISCLOSES THE MOVE INSTEAD (review finding): this is
    // the ONE write where the id legitimately changes, and a receipt that only
    // carried the new id left the caller's own handle silently dead — the caller
    // asked to update '<previous_id>' and got back a record with a different id,
    // with nothing saying so. `identity_moved` names it explicitly; digestWriteEcho
    // carries it through the default digest receipt the same way it carries
    // previous_version, so the disclosure survives the projection it is for.
    const bumpedTo = (updated as unknown as { version?: number }).version;
    const echo = replaced
      ? {
          ...updated,
          identity_moved: {
            previous_id: old.id,
            note: `an attestation update is a CONCEPT REPLACEMENT, not an in-place version bump (an inspection verdict is immutable by construction): this is a NEW record with a new id, and '${old.id}' was retired pointing at it. Cite '${updated.id}' from here on.`,
          },
        }
      : { ...updated, previous_version: previousVersion ?? (typeof bumpedTo === 'number' ? bumpedTo - 1 : undefined) };
    if (SterlingTools.SAME_SUBJECT_TYPES.includes(old.type)) {
      const registered = RECORD_TYPES[old.type as keyof typeof RECORD_TYPES];
      const excludeIds = new Set(chain);
      excludeIds.add(updated.id);
      const sameSubject = this.sameSubjectDigest(registered ? registered.fts(next) : '', excludeIds);
      return { ...echo, same_subject: sameSubject };
    }
    return echo;
  }

  /**
   * knowledge_split (decision compaction-tooling-windowed-read-plus-split,
   * board 136091d2) mechanically enforces the split invariants decision
   * 8b87efcb established BY HAND for the hooks-suite split. The MECHANICAL
   * guarantees — the ones this function actually enforces, in code — are:
   * files[]/current_ac[]/live_test_refs ENTRIES are relocated VERBATIM (moved
   * as the identical object, never rewritten), ac_ids are INHERITED never
   * renumbered, live_test_refs is RE-POINTED (an entry follows its ac_id to
   * whichever side — parent or child — now owns it), the parent SURVIVES
   * under its ORIGINAL slug (a split is additive children plus a parent
   * trim, never a retire-and-replace), and FILE COVERAGE stays TOTAL — every
   * path the parent owned before the split lands on exactly the parent or
   * one child afterward, never both, never neither. "VERBATIM" describes
   * ONLY that entry relocation and these structural invariants — it does
   * NOT extend to the narrative prose (each child's what_it_does/
   * intended_behavior, parent_what_it_does/parent_intended_behavior): that
   * text is caller-authored free-form content, and its fidelity to what the
   * pre-split parent actually said remains conductor discipline, the same as
   * any other knowledge_update/knowledge_create body.
   *
   * ALL validation — parent type/status, per-child move_files/move_ac_ids
   * ownership, cross-child claim collisions, child slug collisions (reusing
   * the same store.articlesBySlug check knowledgeCreate's feature_article
   * branch uses), and the retain-at-least-one-file floor (full donation is
   * refused: that shape is retire-and-replace, rejected by decision
   * 8b87efcb's own alternatives) — runs BEFORE any write, so a call mixing a
   * valid and an invalid child refuses the WHOLE thing, never creates the
   * valid one first. One shape is validated only INSIDE knowledgeCreate,
   * post-write rather than pre-write, because it is knowledgeCreate's own
   * schema that owns it, not a knowledge_split-specific rule: a child whose
   * move_files/move_ac_ids/dependencies would make the created record itself
   * schema-invalid fails there, inside the same transaction, and rolls back
   * exactly like any other mid-split failure — safe, just not pre-empted.
   *
   * The children-plus-parent write then lands in ONE store transaction
   * (store.withTransaction) so a mid-split failure leaves the store
   * byte-for-byte untouched — nothing rides on process-level try/catch
   * cleanup. `resolves` closes named open maintenance items via
   * validateResolveClaim's split semantics (options.splitMarker) — broader
   * than knowledgeUpdate's own lane-restricted resolves, since the item a
   * split most naturally discharges (article_oversize) is outside that
   * lane: promotion_review still refuses unconditionally (P1), every other
   * lane closes on a chain-matching feature_link OR the article-oversize
   * marker for this parent's slug. An item left unnamed stays open, exactly
   * the explicit-claim posture decision 68988832 established.
   */
  knowledgeSplit(input: KnowledgeSplitInput): { parent: { id: string; slug: string; version: number }; children: { id: string; slug: string }[] } {
    const { id, children, parent_what_it_does, parent_intended_behavior, reason, resolves } = input;

    if (!Array.isArray(children) || children.length === 0) {
      throw new Error(`knowledge_split: 'children' must be a non-empty array — at least one child is required; nothing was written.`);
    }

    const parent = this.resolveRecordId(id, 'knowledge_split');
    if (parent.type !== 'feature_article') {
      throw new Error(
        `knowledge_split: '${id}' resolves to a ${parent.type}, not a feature_article — only a feature_article can be split; nothing was written.`
      );
    }
    if (parent.status !== 'active') {
      throw new Error(`knowledge_split: parent '${id}' is not active (status ${parent.status}) — only a live feature_article can be split; nothing was written.`);
    }
    const parentRec = parent as unknown as {
      id: string;
      slug: string;
      state: string;
      history: { date: string; event: string; target_id?: string }[];
      files: { path: string; role: string; unverified?: boolean }[];
      current_ac: { ac_id: string; text: string; verifiable_at: string }[] | { not_applicable: { reason: string; ruling_record_id?: string } };
      live_test_refs: { ac_id: string; test_paths: string[] }[] | { not_applicable: { reason: string; ruling_record_id?: string } };
      dependencies?: { relies_on: string[]; relied_by: string[] };
    };
    // Board a9280db7 (decision c48380bf): current_ac/live_test_refs may now be
    // the structured not_applicable exemption object on a probe|tool article,
    // not an array — every read below assumed array shape unconditionally
    // (.map/.filter), which would THROW rather than refuse cleanly on such a
    // parent. Normalize FOR THE OWNERSHIP/MOVE bookkeeping only (an
    // exemption-shaped parent simply owns no ac_id entries to move, so
    // move_ac_ids validation below refuses it by its EXISTING "not owned by
    // parent" message, never a crash) — the PARENT UPDATE below does NOT use
    // these arrays: it preserves the exemption object VERBATIM when present,
    // so a file-only split of a probe/tool parent keeps its exemption and
    // succeeds, rather than being silently flattened to an empty array (which
    // the new schema gate would then reject outright on kind probe/tool).
    const currentAcIsArray = Array.isArray(parentRec.current_ac);
    const liveRefsIsArray = Array.isArray(parentRec.live_test_refs);
    const parentAcArray = currentAcIsArray ? (parentRec.current_ac as { ac_id: string; text: string; verifiable_at: string }[]) : [];
    const parentRefsArray = liveRefsIsArray ? (parentRec.live_test_refs as { ac_id: string; test_paths: string[] }[]) : [];

    // Child slugs pairwise distinct within this call, and none colliding with
    // an existing feature_article slug — the same two-records-one-slug refusal
    // knowledgeCreate's feature_article branch already enforces (board 56c8a509).
    const seenSlugs = new Set<string>();
    for (const child of children) {
      if (seenSlugs.has(child.slug)) {
        throw new Error(`knowledge_split: two children in this call share slug '${child.slug}' — child slugs must be pairwise distinct; nothing was written.`);
      }
      seenSlugs.add(child.slug);
      const clash = this.store.articlesBySlug(child.slug);
      if (clash.length) {
        throw new Error(
          `knowledge_split: child slug '${child.slug}' collides with an existing feature_article ('${clash[0].id}') — two records under one slug is worse than one wrong record; choose a distinct slug. Nothing was written.`
        );
      }
    }

    // Ownership + no-double-claim validation for move_files/move_ac_ids — ALL
    // of it before any write (P5): a call mixing a valid and an invalid child
    // must refuse the WHOLE call, never create the valid one first.
    const parentPaths = new Set(parentRec.files.map((f) => f.path));
    const parentAcIds = new Set(parentAcArray.map((a) => a.ac_id));
    const claimedPaths = new Map<string, string>();
    const claimedAcIds = new Map<string, string>();
    for (const child of children) {
      for (const path of child.move_files ?? []) {
        if (!parentPaths.has(path)) {
          throw new Error(
            `knowledge_split: child '${child.slug}' names move_files path '${path}', which parent '${parentRec.slug}' does not own — nothing was written.`
          );
        }
        if (claimedPaths.has(path)) {
          throw new Error(
            `knowledge_split: path '${path}' is claimed by two children ('${claimedPaths.get(path)}' and '${child.slug}') — a path moves to exactly one child; nothing was written.`
          );
        }
        claimedPaths.set(path, child.slug);
      }
      for (const acId of child.move_ac_ids ?? []) {
        if (!parentAcIds.has(acId)) {
          throw new Error(
            `knowledge_split: child '${child.slug}' names move_ac_ids '${acId}', which parent '${parentRec.slug}' does not own — nothing was written.`
          );
        }
        if (claimedAcIds.has(acId)) {
          throw new Error(
            `knowledge_split: ac_id '${acId}' is claimed by two children ('${claimedAcIds.get(acId)}' and '${child.slug}') — an ac_id moves to exactly one child; nothing was written.`
          );
        }
        claimedAcIds.set(acId, child.slug);
      }
    }

    // A child owning zero files is refused — it would be invisible to
    // path-scoped delivery (same invariant class as the parent's
    // retain-at-least-one floor). Checked AFTER the ownership/double-claim
    // loop so a child whose real offense is a bad ac_id is refused by that
    // name first; the wire schema (.min(1)) refuses the shape outright.
    for (const child of children) {
      if (!child.move_files?.length) {
        throw new Error(
          `knowledge_split: child '${child.slug}' names no move_files — a child article must own at least one file; nothing was written.`
        );
      }
    }

    // Full donation refused (decision 8b87efcb's own rejected alternatives:
    // that shape is retire-and-replace, not a split) — the parent must retain
    // at least one owned file.
    if (parentRec.files.length > 0 && claimedPaths.size >= parentRec.files.length) {
      throw new Error(
        `knowledge_split: this split moves all ${parentRec.files.length} of parent '${parentRec.slug}''s files — the parent must retain at least one owned file (full donation is retire-and-replace, rejected by decision 8b87efcb); nothing was written.`
      );
    }

    // resolves: validated (broader than knowledgeUpdate's own lane-restricted
    // check — see validateResolveClaim's options.splitMarker) BEFORE any
    // write, same duplicate-claim refusal knowledgeUpdate itself applies.
    if (resolves) {
      const seen = new Set<string>();
      for (const rid of resolves) {
        if (seen.has(rid)) {
          throw new Error(`resolves: '${rid}' is named more than once — an item can only be claimed once; nothing was written.`);
        }
        seen.add(rid);
      }
    }
    const parentChain = this.supersedeChain(parent);
    const splitMarker = this.articleOversizeMarker(parentRec.slug);
    const resolveClaims = (resolves ?? []).map((rid) => this.validateResolveClaim(rid, parentChain, { splitMarker }));

    const ts = this.now();
    const childSlugs = children.map((c) => c.slug).join(', ');
    const childResults: { id: string; slug: string }[] = [];
    let parentResult!: DurableRecord;

    // SYMMETRIC DEPENDENCY EDGE (skeptic finding 2, knowledge_get 2334f653):
    // relied_by is derived at READ time from the union of every OTHER
    // article's relies_on, so leaving the parent's STORED relied_by
    // untouched would read back as relied_by_stored_stale the instant a
    // reader compares it — right after the split that created the mismatch.
    // Only a child whose relies_on actually names the parent (the default —
    // dependencies ?? {relies_on: [parentRec.slug], ...} — earns the parent
    // a back-edge; a caller who passed EXPLICIT dependencies without the
    // parent gets no fabricated edge. Existing stored entries are preserved
    // and deduped, never dropped.
    const reliedByAdditions = children
      .filter((child) => (child.dependencies?.relies_on ?? [parentRec.slug]).includes(parentRec.slug))
      .map((child) => child.slug);
    const parentReliedBy = Array.from(new Set([...(parentRec.dependencies?.relied_by ?? []), ...reliedByAdditions]));

    this.store.withTransaction(() => {
      for (const child of children) {
        const movedFiles = parentRec.files.filter((f) => claimedPaths.get(f.path) === child.slug);
        const movedAc = parentAcArray.filter((a) => claimedAcIds.get(a.ac_id) === child.slug);
        const movedRefs = parentRefsArray.filter((r) => claimedAcIds.get(r.ac_id) === child.slug);
        const created = this.knowledgeCreate('feature_article', {
          slug: child.slug,
          title: child.title,
          what_it_does: child.what_it_does,
          intended_behavior: child.intended_behavior,
          files: movedFiles,
          current_ac: movedAc,
          live_test_refs: movedRefs,
          dependencies: child.dependencies ?? { relies_on: [parentRec.slug], relied_by: [] },
          state: parentRec.state,
          // No `version` passed: the counter is SERVER-OWNED at birth
          // ([stable-identity-design-v2] contract 1), so knowledgeCreate strips
          // it and stamps 1 itself. Passing 1 relied on the strip being silent
          // for that exact value — a contract this surface does not make.
          history: [{ date: ts, event: `split from '${parentRec.slug}'${reason ? ` — ${reason}` : ''}` }],
        });
        childResults.push({ id: created.record.id, slug: child.slug });
      }

      const remainingFiles = parentRec.files.filter((f) => !claimedPaths.has(f.path));
      // An exemption-shaped field is preserved VERBATIM (no ac_id was ever
      // claimable from it, so filtering would be a no-op anyway) rather than
      // flattened to []: current_ac/live_test_refs on kind probe|tool must
      // never be re-written to an empty array by this path, or the new
      // article_kind schema gate (board a9280db7) would reject the parent
      // update outright on a file-only split.
      const remainingAc = currentAcIsArray ? parentAcArray.filter((a) => !claimedAcIds.has(a.ac_id)) : parentRec.current_ac;
      const remainingRefs = liveRefsIsArray ? parentRefsArray.filter((r) => !claimedAcIds.has(r.ac_id)) : parentRec.live_test_refs;
      const splitEvent = { date: ts, event: `split off ${childSlugs}${reason ? ` — ${reason}` : ''}` };
      parentResult = this.knowledgeUpdate(parentRec.id, {
        what_it_does: parent_what_it_does,
        ...(parent_intended_behavior !== undefined ? { intended_behavior: parent_intended_behavior } : {}),
        files: remainingFiles,
        current_ac: remainingAc,
        live_test_refs: remainingRefs,
        history: [...parentRec.history, splitEvent],
        dependencies: { relies_on: parentRec.dependencies?.relies_on ?? [], relied_by: parentReliedBy },
      });

      // Explicit-claim closure (decision 68988832's posture, broadened per
      // validateResolveClaim's split semantics above): drained INSIDE the
      // same transaction so a claim only lands alongside a split that
      // actually landed.
      for (const claim of resolveClaims) {
        this.store.remove(claim.id, ts);
      }
    });

    return {
      parent: {
        id: parentResult.id,
        slug: (parentResult as unknown as { slug: string }).slug,
        version: (parentResult as unknown as { version: number }).version,
      },
      children: childResults,
    };
  }

  /**
   * knowledge_split's MCP-facing wrapper (review finding B): every other
   * write surface re-measures oversize via its own *Result wrapper
   * (knowledgeUpdateResult, above) after the version lands — knowledgeSplit
   * itself was measured by NOTHING, so a split that trimmed the parent too
   * little, or handed a child too much, silently skipped the article_oversize
   * lane every other write is held to. Wraps knowledgeSplit — which stays
   * exactly as the frozen split suite calls and asserts it, no warnings
   * expected there — and appends an ADDITIVE `warnings` sibling, the same
   * shape knowledgeUpdateResult already returns, covering the trimmed parent
   * AND every newly-created child.
   */
  knowledgeSplitResult(input: KnowledgeSplitInput): {
    parent: { id: string; slug: string; version: number };
    children: { id: string; slug: string }[];
    warnings: string[];
  } {
    const result = this.knowledgeSplit(input);
    const warnings: string[] = [];
    const parentRecord = this.store.get(result.parent.id);
    if (parentRecord) warnings.push(...this.articleOversizeWarnings(parentRecord));
    for (const child of result.children) {
      const childRecord = this.store.get(child.id);
      if (childRecord) warnings.push(...this.articleOversizeWarnings(childRecord));
    }
    return { ...result, warnings };
  }

  /**
   * knowledge_extract (decision knowledge-extract-design; board ff07e314): lift
   * a PASSAGE out of one string field of a live record into a NEW standalone
   * record, while the original stays active minus the extracted claim. Kin to
   * knowledge_split (which redistributes a feature_article among children under
   * one slug) but extract lifts a passage from a PROJECT-SCOPED, NON-ATTESTATION
   * source (domain sources are refused, pending per-mount transaction routing;
   * attestation sources are refused because knowledgeUpdate's supersession
   * semantics contradict extract's stays-live contract) into a fresh record of a
   * caller-chosen type — the point of the feature being that a half-portable
   * clause in an article most wants to become a citable decision/research_finding.
   *
   * EXCISION IS PASSAGE-SCOPED, not field-scoped (Q1): the removed text is a
   * (field, find) substring under the SAME exactly-once contract knowledge_edit
   * enforces (occurrences = field.split(find).length - 1; 0 refused with the char
   * count, >1 refused as ambiguous). The post-removal value is NEVER taken from
   * the caller (Q2) — the single occurrence located by the exactly-once check is
   * spliced in LITERALLY (never String.replace, which would interpret
   * $&/$`/$'/$$ in caller-supplied `replace` text as substitution patterns),
   * because the exactly-once check IS the safety property that a blind
   * full-field retransmit would defeat. `replace` defaults to '' (pure excision).
   *
   * PROVENANCE BOTH WAYS (Q4, the architect-flagged highest-risk path): new
   * --informed_by--> original (the edge knowledge_promote writes) AND original
   * --cites--> new. Each direction is a real record_relations row written
   * explicitly, because a generic relation materializes on the SOURCE only at
   * read — so "both ways" needs one addLink per direction. Both addLink calls run
   * INSIDE the outer store.withTransaction: `tx` is reentrant (txDepth), so the
   * create, the source update, and both edges commit as ONE transaction and a
   * mid-op failure rolls the whole thing back byte-for-byte (validated by the
   * frozen suite's both-ways + atomicity invariants).
   *
   * Extract does NOT cross scope (Q5): the new record inherits the source's scope
   * (project→project); project→domain stays knowledge_promote's job (compose
   * extract-then-promote). todo and attestation are barred targets (Q3, mirrors
   * promote's UNPROMOTABLE). resolves is the PLAIN lane (Q6): reconcile_needed +
   * refresh_reference only, promotion_review always refused, chain membership by
   * file_keys overlap with the source (see validateExtractResolveClaim) — drained
   * inside the same transaction, exactly like knowledge_split's explicit-claim
   * closure.
   *
   * NOTE (history) — the source-update appends ONE history entry ONLY for a
   * source type whose schema actually defines a `history` field (feature_article
   * / reference_material). A decision/research_finding/anti_pattern has no history
   * field (a decision is immutable-by-design, §3.2.1), so a history write would be
   * refused by refuseUnknownFields; the append is therefore conditional rather
   * than unconditional as the design's STORE-OPS line reads literally.
   */
  knowledgeExtract(input: {
    id: string;
    field: string;
    find: string;
    replace?: string;
    new_record: { type: string; fields: Record<string, unknown> };
    reason?: string;
    resolves?: string[];
  }): { extracted: string; source: { id: string; version: number }; edges: { informed_by: string; cites: string } } {
    const { id, field, find, new_record, reason, resolves } = input;
    const replace = input.replace ?? '';

    // new_record shape + barred target types FIRST (mirrors promote's
    // UNPROMOTABLE) — a barred type is refused for BEING that type, before any
    // field/find work, so the refusal names the type rather than an incidental
    // downstream error.
    if (!new_record || typeof new_record !== 'object' || typeof new_record.type !== 'string' || typeof new_record.fields !== 'object' || new_record.fields === null) {
      throw new Error(`knowledge_extract: 'new_record' must be a { type, fields } object — nothing was written.`);
    }
    const newType = new_record.type;
    const BARRED_TARGETS = ['todo', 'attestation'];
    if (BARRED_TARGETS.includes(newType)) {
      throw new Error(
        `knowledge_extract: new_record.type '${newType}' is a barred extraction target — extract lifts a passage into a durable, citable knowledge record; a ${newType} is not one (mirrors knowledge_promote's UNPROMOTABLE). Nothing was written.`
      );
    }

    // Resolve the source through the shared ladder, then guard: a superseded id
    // gets the version-conflict redirect first (refuseStaleAddress), a
    // non-active source is refused before any write.
    const original = this.resolveRecordId(id, 'knowledge_extract');
    this.refuseStaleAddress(original, id, 'knowledge_extract');
    if (original.status !== 'active') {
      throw new Error(
        `knowledge_extract: source '${original.id}' is not active (status ${original.status}) — only a live record can be extracted from; nothing was written.`
      );
    }

    // PER-MOUNT TRANSACTION ROUTING (board d47a9e2d): a domain-scoped source's
    // create + source-trim + both addLinks now commit atomically on the ONE
    // mount that owns the source, via store.withTransactionForScope(original.scope, ...)
    // below — see mounted.ts's storeFor/withTransactionForScope. The one
    // remaining hazard is `resolves`: maintenance todos are always
    // project-local (mounted.ts, §3.3), and extract removes each claimed item
    // INSIDE the transaction (below) — a domain-scoped transaction cannot
    // atomically delete a project-store row, so a non-empty `resolves` is
    // refused loudly for a domain-scoped source rather than silently split
    // across two connections.
    if (original.scope !== 'project' && resolves && resolves.length > 0) {
      throw new Error(
        `knowledge_extract: source '${original.id}' is domain-scoped (${original.scope}) and 'resolves' names ${resolves.length} item(s) — maintenance todos are project-local, so a domain-scoped extract's transaction cannot atomically close them. Retry without resolves, or close those items separately. Nothing was written.`
      );
    }

    // FIXER-MODE (converging review finding, attestation source): knowledgeUpdate
    // treats an attestation update as a concept REPLACEMENT (fresh id, retired
    // predecessor — see the ATTESTATION ONLY branch above), which contradicts
    // extract's "original stays live minus the passage" contract. Refused as a
    // SOURCE type — attestation is now barred BOTH ways: as a new_record.type
    // TARGET (BARRED_TARGETS above) and, here, as the extraction SOURCE.
    // (todo sources remain allowed; only todo as a new_record.type TARGET is barred.)
    if (original.type === 'attestation') {
      throw new Error(
        `knowledge_extract: source '${original.id}' is an attestation — knowledgeUpdate's attestation-supersession semantics (a fresh id + retired predecessor) contradict extract's stays-live contract; attestation sources are refused. Nothing was written.`
      );
    }

    // FIXER-MODE (converging review finding, scope): a caller-supplied
    // new_record.fields.scope must not silently win over the source's scope —
    // extract NEVER crosses scope (decision knowledge-extract-design Q5); an
    // explicit mismatching scope is refused, naming both values. An identical
    // explicit scope is harmless and passes.
    if (Object.prototype.hasOwnProperty.call(new_record.fields, 'scope') && new_record.fields.scope !== original.scope) {
      throw new Error(
        `knowledge_extract: new_record.fields.scope '${String(new_record.fields.scope)}' differs from the source's scope '${original.scope}' — extract never crosses scope (decision knowledge-extract-design Q5); nothing was written.`
      );
    }

    // field/find validation (the same shape knowledge_edit uses): known string
    // field, non-empty find, exactly-once occurrence.
    if (typeof find !== 'string' || find.length === 0) {
      throw new Error(`knowledge_extract: 'find' must be a non-empty string — an empty match would insert at every position; nothing was written.`);
    }
    this.refuseUnknownFields(original.type, { [field]: replace }, 'knowledge_extract');
    const current = (original as unknown as Record<string, unknown>)[field];
    if (typeof current !== 'string') {
      throw new Error(
        `knowledge_extract: '${field}' on ${original.type} is ${current === undefined ? 'absent' : typeof current}, not a string — extract lifts a passage out of a STRING field. Nothing was written.`
      );
    }
    // split().length - 1 counts occurrences without a regex, so `find` is the
    // literal text the caller saw — the SAME mechanism knowledge_edit uses.
    const occurrences = current.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `knowledge_extract: 'find' appears 0 times in ${original.type}.${field} (${current.length} chars) — nothing was written. ` +
          `Confirm the exact text (including whitespace and punctuation) before retrying.`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `knowledge_extract: 'find' appears ${occurrences} times in ${original.type}.${field} — refused as ambiguous, nothing was written. ` +
          `Extend find with surrounding text until it matches exactly one site.`
      );
    }
    // FIXER-MODE (converging review finding, literal replacement): the
    // exactly-once count above already guarantees a single occurrence, so
    // splice on that occurrence's own indexOf position rather than
    // String.replace(find, replace) — String.replace interprets $&/$`/$'/$$
    // as substitution patterns in caller-supplied `replace` text (e.g.
    // replace:'$&' would leave the passage in place instead of excising it).
    const matchIndex = current.indexOf(find);
    const splicedValue = current.slice(0, matchIndex) + replace + current.slice(matchIndex + find.length);

    // resolves: validated BEFORE any write (P5) — plain lane, file_keys overlap
    // with the source. Duplicate ids refused loudly, exactly like knowledgeUpdate.
    if (resolves) {
      const seen = new Set<string>();
      for (const rid of resolves) {
        if (seen.has(rid)) throw new Error(`resolves: '${rid}' is named more than once — an item can only be claimed once; nothing was written.`);
        seen.add(rid);
      }
    }
    const sourceFileKeys = Array.isArray((original as unknown as { file_keys?: unknown }).file_keys)
      ? ((original as unknown as { file_keys: string[] }).file_keys)
      : [];
    const resolveClaims = (resolves ?? []).map((rid) => this.validateExtractResolveClaim(rid, sourceFileKeys));

    const ts = this.now();
    // History append is conditional on the source type actually defining a
    // `history` field — see the NOTE on this method. Types without one (decision,
    // research_finding, anti_pattern) skip it rather than have refuseUnknownFields
    // reject the write.
    const typeHasHistory = (knownFieldsFor(original.type) ?? new Set<string>()).has('history');

    let newId!: string;
    let sourceVersion!: number;
    let deferredSkips: SkippedCheck[] = [];
    // FIXER-MODE (converging review finding, project-scope regression): only a
    // DOMAIN-scoped source needs the defer-then-flush dance below — its
    // transaction opens on the domain mount, while recordCheckSkipped always
    // routes to the PROJECT mount (see the comment above), so an inline audit
    // write there would commit independently of the domain BEGIN. A
    // project-scoped source's transaction already IS the project mount, so
    // its audit row was atomic inline before board d47a9e2d and stays that way
    // here — deferring it would instead turn a committed project extract into
    // a window where a post-commit flush failure errors after the records are
    // already durable. original.scope is 'project' or 'domain:<name>' (see the
    // PER-MOUNT TRANSACTION ROUTING comment above / the !== 'project' checks
    // elsewhere in this method), so the same test used there decides here.
    const isDomainScope = original.scope !== 'project';
    // ONE transaction on the source's OWNING mount (board d47a9e2d): create the
    // new record, trim the source, write BOTH provenance edges, drain resolves.
    // The knowledge RECORDS and their provenance links commit atomically on the
    // owning mount — any failure inside this body rolls all of them back. What
    // does NOT belong inside is the check_skipped AUDIT ROW: recordCheckSkipped
    // always routes to the PROJECT mount (MountedStores.recordCheckSkipped), so
    // for a domain-scoped source it would commit independently of this domain
    // BEGIN and survive a rollback. So knowledgeCreate DEFERS its skips here and
    // they are persisted AFTER a successful commit below — a rolled-back extract
    // therefore leaves NO audit row, a committed one still records them (P5). Note
    // the SEAM (deliberately narrow, not the atomicity guarantee the records get):
    // an audit-row write that itself failed after a successful record commit would
    // lose the audit row, not corrupt the records. original.scope is the SOLE
    // routing input here (id/alias/slug/prefix resolution above already ran across
    // every mount; once `original` is resolved, only its own scope decides where
    // this transaction opens).
    this.store.withTransactionForScope(original.scope, () => {
      // scope inherited from the source (Q5); an explicit new_record.fields.scope
      // that DIFFERS from the source's scope was already refused above, so the
      // spread here can only ever carry the same scope back (or none at all) —
      // it can no longer override it.
      const created = this.knowledgeCreate(newType, { scope: original.scope, ...new_record.fields }, { deferCheckSkipped: isDomainScope });
      // created.check_skipped is populated either way (knowledgeCreate always
      // returns what it skipped) — but for a project-scoped source it was
      // ALREADY persisted inline above (deferCheckSkipped: false), so only a
      // domain-scoped source's skips are collected here for the post-commit
      // flush; collecting them unconditionally would double-write the audit
      // row for project scope.
      deferredSkips = isDomainScope ? (created.check_skipped ?? []) : [];
      newId = created.record.id;
      const updateBody: Record<string, unknown> = { [field]: splicedValue };
      if (typeHasHistory) {
        const priorHistory = Array.isArray((original as unknown as { history?: unknown }).history)
          ? ((original as unknown as { history: unknown[] }).history)
          : [];
        updateBody.history = [
          ...priorHistory,
          { date: ts, event: `extracted a passage from '${field}' into ${newType} '${newId}'${reason ? ` — ${reason}` : ''}` },
        ];
      }
      const updated = this.knowledgeUpdate(original.id, updateBody);
      sourceVersion = (updated as unknown as { version: number }).version;
      // BOTH-WAYS provenance, each a real record_relations row (the flagged
      // highest-risk path — direct addLink inside the outer tx, verified to
      // persist both rows without a nested-tx conflict).
      this.store.addLink(newId, 'informed_by', original.id);
      this.store.addLink(original.id, 'cites', newId);
      // Explicit-claim closure (decision 68988832), drained inside this same
      // transaction so a claim only lands alongside an extract that landed.
      for (const claim of resolveClaims) this.store.remove(claim.id, ts);
    });

    // Post-commit: persist the deferred check_skipped audit rows now that the
    // mount transaction has committed (see the deferCheckSkipped rationale above).
    // Same (check, reason, runId, at) shape the in-line skip() would have used.
    for (const s of deferredSkips) {
      this.store.recordCheckSkipped(s.check, s.reason, this.activeRunId(), this.now());
    }

    return {
      extracted: find,
      source: { id: original.id, version: sourceVersion },
      edges: { informed_by: original.id, cites: newId },
    };
  }

  /**
   * knowledge_extract's MCP-facing wrapper (the *Result convention every other
   * write surface follows): wraps knowledgeExtract — which stays exactly as the
   * frozen extract suite calls and asserts it — and appends an ADDITIVE
   * `warnings` sibling, covering the newly-created record AND the trimmed source,
   * the same article_oversize re-measure knowledgeSplitResult/knowledgeUpdateResult
   * carry. Warnings never gate the write (P1).
   */
  knowledgeExtractResult(input: {
    id: string;
    field: string;
    find: string;
    replace?: string;
    new_record: { type: string; fields: Record<string, unknown> };
    reason?: string;
    resolves?: string[];
  }): { extracted: string; source: { id: string; version: number }; edges: { informed_by: string; cites: string }; warnings: string[] } {
    const result = this.knowledgeExtract(input);
    const warnings: string[] = [];
    const newRecord = this.store.get(result.edges.cites);
    if (newRecord) warnings.push(...this.articleOversizeWarnings(newRecord));
    const sourceRecord = this.store.get(result.source.id);
    if (sourceRecord) warnings.push(...this.articleOversizeWarnings(sourceRecord));
    return { ...result, warnings };
  }

  /**
   * knowledge_extract's resolves validator — the PLAIN lane (reconcile_needed +
   * refresh_reference; promotion_review and every other lane refused), keyed on
   * FILE_KEYS OVERLAP with the source record rather than the feature_link/chain
   * predicate validateResolveClaim uses. WHY IT DIVERGES: an extract source is
   * commonly a decision/research_finding, whose reconcile debt is raised with
   * file_keys but NO feature_link (feature_link points at feature_articles), so
   * the feature_link/chain match validateResolveClaim performs would refuse every
   * such item. Chain membership for a non-article source is therefore file_keys
   * overlap (the frozen extract suite pins this; conductor ambiguity resolution
   * #3). EXACT FULL ID ONLY, same as validateResolveClaim — a claim is
   * hard-deleted as the write lands, so an abbreviation could silently retarget.
   */
  private validateExtractResolveClaim(id: string, sourceFileKeys: string[]): DurableRecord {
    const record = this.store.get(id);
    if (!record) {
      if (!SterlingTools.FULL_UUID_RE.test(id)) {
        throw new Error(
          `resolves: names '${id}', which is not a full record id — resolves requires the FULL uuid of every maintenance item it claims. ` +
            `A claimed item is HARD-DELETED as the write lands, so an abbreviated citation could silently retarget to a DIFFERENT item. ` +
            `Look the item up with maintenance_query and cite its full id; nothing was written.`
        );
      }
      const trace = this.store.drainLogEntry(id);
      if (trace) {
        throw new Error(
          `resolves: names '${id}', which is not OPEN — it was already removed` +
            (trace.drained_at ? ` at ${trace.drained_at}` : '') +
            ` (per the drain log). A closed item cannot be re-claimed; nothing was written.`
        );
      }
      throw new Error(
        `resolves: names '${id}', which does not exist as a maintenance item under that EXACT id; nothing was written.`
      );
    }
    const it = record as unknown as { type: string; source?: string; system_reason?: string; file_keys?: string[] };
    if (it.type !== 'todo' || it.source !== 'system') {
      throw new Error(`resolves: names '${id}', which is not a system maintenance-queue item; nothing was written.`);
    }
    if (it.system_reason !== 'reconcile_needed' && it.system_reason !== 'refresh_reference') {
      throw new Error(
        `resolves: names '${id}' (${it.system_reason ?? 'unknown'} lane) — only reconcile_needed and refresh_reference items close via ` +
          `resolves; every other lane, including promotion_review, closes only through its own mechanism. Nothing was written.`
      );
    }
    const itemFileKeys = Array.isArray(it.file_keys) ? it.file_keys : [];
    if (!itemFileKeys.some((k) => sourceFileKeys.includes(k))) {
      throw new Error(
        `resolves: names '${id}', whose file_keys do not overlap the extract source's — an extract only discharges reconcile debt on its own chain; nothing was written.`
      );
    }
    return record;
  }

  /**
   * promotion_review stays a human gate (P1) — a supersession never DRAINS it,
   * it is not the review being paid. But leaving its feature_link pointed at a
   * now-superseded id STRANDS it silently (todo 6202a0f5): the review is still
   * owed, same lineage, so RE-POINT rather than drop. In-place via updateTodo
   * (no new version, no id churn) so every other reference to the item survives.
   *
   * Shared by knowledgeUpdate (decision 01f31039) and knowledge_supersede
   * (decision e17794ea). Since S3 ([stable-identity-design-v2]) knowledgeUpdate
   * writes IN PLACE, so only two shapes actually move an id and owe a re-point:
   * knowledge_supersede, and knowledgeUpdate's ONE re-minting branch — an
   * attestation concept replacement. On the in-place path `newId` IS the id the
   * item already points at, so the `feature_link !== newId` guard below makes
   * this a no-op rather than a rewrite; it is called unconditionally because the
   * caller cannot tell the two branches apart cheaply, not because both re-mint.
   * `chain` is every id this supersession's target answers
   * for (the old id plus any ancestors it already carries a 'supersedes' link
   * to) — computed for every type, since promotion_review can point at any
   * supersedable record, not only feature_article/reference_material.
   */
  private repointPromotionReview(chain: Set<string>, newId: string, ts: string): void {
    for (const item of this.maintenanceQuery({ system_reason: 'promotion_review', cap: 1000 })) {
      const it = item as DurableRecord & { feature_link?: string; system_reason?: string };
      if (it.feature_link !== undefined && chain.has(it.feature_link) && it.feature_link !== newId) {
        this.store.updateTodo(it.id, { ...it, feature_link: newId, updated_at: ts });
      }
    }
  }

  /**
   * knowledge_promote (§3.3 project→domain promotion EXECUTION): move a
   * project-scoped learning into a mounted domain store so it is shared by every
   * project that mounts that domain. Copies the record into the domain store (new
   * id, scope domain:<name>, content + clocks + author preserved, an informed_by
   * link back to the origin) and retires the project original as a superseded
   * tombstone pointing at the promoted copy — provenance and inbound links
   * survive. Promoting IS the review outcome, so a matching promotion_review is
   * drained (done = removed). feature_article is always project (§3.3); todo is
   * a project surface — neither promotes. An unmounted target domain is
   * rejected loudly by the store routing before anything is written.
   *
   * METADATA SANITISATION (board ff07e314, measured 2026-08-22): a whole-record
   * copy was carrying LOCAL SCAFFOLDING verbatim into the shared per-user
   * domain store — file_keys (a repo-relative path means nothing outside the
   * originating project) and stack_tags (copied wholesale, so a record
   * promoted to one domain kept advertising every OTHER stack tag its origin
   * project happened to carry). Both are sanitised at this one crossing point:
   * file_keys is dropped entirely (optional at the schema layer — nothing to
   * backfill), stack_tags is INTERSECTED with the target domain, and the drop
   * is disclosed on the receipt (dropped_file_keys/dropped_stack_tags/
   * kept_stack_tags) alongside a warn-only scan for suspicious project-local
   * labels (slice labels, repo-relative path mentions) still sitting in the
   * promoted prose — never a refusal (P1): the reviewer sanitises the source
   * record and re-promotes if it actually matters.
   */
  knowledgePromote(
    id: string,
    domain: string
  ): {
    promoted: DurableRecord;
    retired: string;
    drained_review: string | null;
    dropped_file_keys: number;
    dropped_stack_tags: string[];
    kept_stack_tags: string[];
    warnings: string[];
  } {
    // Through the SHARED LADDER (decision 2debab53), not a raw store.get: a
    // slug or an 8-char citation prefix resolves here exactly as it does
    // everywhere else, and — the reason this changed — a HISTORICAL id now
    // produces the designed refusal naming the canonical record instead of a
    // bare "no record", which would tell the caller their citation was wrong
    // when the record is alive under another id ([stable-identity-design-v2]
    // contract 3).
    const original = this.resolveRecordId(id, 'knowledge_promote');
    // Everything downstream addresses the RESOLVED id, never the caller's
    // spelling: a slug/prefix caller would otherwise tombstone-and-link a
    // record by a handle the store cannot resolve.
    const originalId = original.id;
    if (original.status !== 'active') throw new Error(`knowledge_promote: record '${originalId}' is not active (status ${original.status})`);
    if (original.scope !== 'project') throw new Error(`knowledge_promote: record '${originalId}' is ${original.scope} — only project-scoped records promote`);
    const UNPROMOTABLE = ['feature_article', 'todo', 'attestation'];
    if (UNPROMOTABLE.includes(original.type)) {
      throw new Error(
        `knowledge_promote: ${original.type} never promotes — feature_article is always project (§3.3); todo is a project surface; an attestation's artifact_key names a project-local artifact that means nothing in a shared domain store (review finding, 2026-08-21)`
      );
    }
    const ts = this.now();
    // copy content; the envelope (id/clocks/status/scope/links) is rebuilt for the domain
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l, ...content } = original as unknown as Record<string, unknown>;

    // (1) DROP file_keys — a repo-relative path is by definition project-scoped;
    // the schema leaves the field optional everywhere, so omitting it entirely
    // satisfies the write with nothing to backfill.
    const originalFileKeys = Array.isArray((content as Record<string, unknown>).file_keys)
      ? ((content as Record<string, unknown>).file_keys as unknown[])
      : [];
    delete (content as Record<string, unknown>).file_keys;

    // (2) INTERSECT stack_tags with the target domain rather than copying —
    // promoting to domain:node keeps 'node', drops every other tag (e.g. the
    // origin project's own 'sterling') the record happened to carry.
    const originalStackTags = Array.isArray((content as Record<string, unknown>).stack_tags)
      ? ((content as Record<string, unknown>).stack_tags as string[])
      : [];
    const keptStackTags = originalStackTags.filter((t) => t === domain);
    const droppedStackTags = originalStackTags.filter((t) => t !== domain);
    // Empty-intersection invisibility (review finding): a record tagged only
    // for OTHER stacks (e.g. only 'sterling', promoted to domain:node) is a
    // legitimate promote, but the result carries NO stack_tags at all — and a
    // zero-tag record is unreachable by every stack_tags-filtered query while
    // the project original sits tombstoned. Warned, never blocked (P1).

    // RAW-ZOD LEAK INVENTORY (board a00689b9, site 5, adjudicated): a `domain`
    // outside SCOPE_RE (project|domain:[a-z0-9_-]+ — e.g. an uppercase or
    // space-bearing name) fails MountedStores.create's own validateRecord call
    // BEFORE its unmounted-domain routing check ever runs, throwing a raw
    // ZodError across this boundary — caught and re-rendered the same way as
    // the other sites (958df5e) rather than leaking the raw issue array.
    let promoted: DurableRecord;
    try {
      promoted = this.store.create({
        ...content,
        stack_tags: keptStackTags,
        id: this.newId(),
        created_at: ts,
        updated_at: ts,
        status: 'active',
        superseded_by: null,
        scope: `domain:${domain}`,
        links: [{ rel: 'informed_by', target_id: originalId }],
      });
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, original.type, 'knowledge_promote');
      throw err;
    }
    // tombstone the project original, pointing forward to the promoted copy —
    // 'promoted' (not the default 'retired') so the activity feed names this
    // for what it is (board 39d6462d)
    this.store.retireInFavorOf(originalId, promoted.id, ts, 'promoted');
    const review = this.maintenanceQuery({ system_reason: 'promotion_review', cap: 1000 }).find(
      (t) => (t as { feature_link?: string }).feature_link === originalId
    );
    if (review) this.store.remove(review.id, ts);

    // (3) RECEIPT DISCLOSURE: what crossed the project→domain boundary and
    // what did not, surfaced on the write result — warn-only, never a
    // refusal (P1).
    const warnings: string[] = [];
    if (originalFileKeys.length) {
      warnings.push(`dropped ${originalFileKeys.length} file_keys (repo-relative paths are project-scoped and meaningless in a shared domain store)`);
    }
    if (droppedStackTags.length) {
      warnings.push(`dropped stack_tags not shared by domain:${domain}: ${droppedStackTags.join(', ')}`);
    }
    if (keptStackTags.length === 0) {
      warnings.push(
        `promoted record carries no stack_tags — unreachable by tag-filtered queries; consider tagging it in the domain store`
      );
    }
    warnings.push(...this.suspiciousLocalLabelWarnings(content as Record<string, unknown>));

    return {
      promoted,
      retired: originalId,
      drained_review: review?.id ?? null,
      dropped_file_keys: originalFileKeys.length,
      dropped_stack_tags: droppedStackTags,
      kept_stack_tags: keptStackTags,
      warnings,
    };
  }

  /**
   * knowledge_promote's warn-only scan (board ff07e314 (c)) over a record's
   * PROSE for project-local labels that read as fine inside the originating
   * project but are noise or actively misleading once shared: a slice label
   * ('S1'/'S2', word-bounded so it never matches inside a longer token) and a
   * repo-relative path mention (word/word.ext). Covers TOP-LEVEL string
   * fields (answer/statement/summary/etc) AND the nested string leaves of the
   * known array fields where the measured pollution actually lived —
   * history[].event, alternatives_rejected[].{option,reason},
   * current_ac[].text — walked cheaply rather than a generic deep-walk. Never
   * a refusal — the finding is surfaced so the reviewer can judge it, per
   * (3)'s warn-only contract.
   */
  private suspiciousLocalLabelWarnings(content: Record<string, unknown>): string[] {
    const proseParts = Object.values(content).filter((v): v is string => typeof v === 'string');
    const history = Array.isArray(content.history) ? (content.history as Record<string, unknown>[]) : [];
    for (const entry of history) if (typeof entry?.event === 'string') proseParts.push(entry.event);
    const alternatives = Array.isArray(content.alternatives_rejected) ? (content.alternatives_rejected as Record<string, unknown>[]) : [];
    for (const alt of alternatives) {
      if (typeof alt?.option === 'string') proseParts.push(alt.option);
      if (typeof alt?.reason === 'string') proseParts.push(alt.reason);
    }
    const currentAc = Array.isArray(content.current_ac) ? (content.current_ac as Record<string, unknown>[]) : [];
    for (const ac of currentAc) if (typeof ac?.text === 'string') proseParts.push(ac.text);
    const prose = proseParts.join('\n');
    const found = new Set<string>();
    for (const m of prose.matchAll(/\bS\d{1,3}\b/g)) found.add(m[0]);
    for (const m of prose.matchAll(/\b(?:[\w-]+\/)+[\w.-]+\.[a-zA-Z0-9]{1,6}\b/g)) found.add(m[0]);
    if (!found.size) return [];
    const list = [...found];
    return [
      `WARNING: possible project-local label(s) in the promoted prose — review before relying on this in a shared domain: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', …' : ''}`,
    ];
  }

  // -- session-event register writers (boards 75b1a05f + 1af5d630) ------------

  /**
   * The conductor declarations that previously lived ONLY in standalone
   * scripts (scripts/no-capture.mjs, scripts/concept-designed.mjs) join the
   * §10 surface: the scripts' relative paths are unreachable from a consuming
   * project's shell — they live in the plugin clone, not the project cwd, and
   * the 2026-08-09 retrospective burned two failed node invocations plus a
   * Glob hunt on exactly that — while the MCP surface is mounted wherever the
   * store is. The scripts survive as the no-server fallback; both writers
   * append the SAME sessionEventSchema shape to the same register, so H10
   * cannot tell them apart — one shape, one consumer (invariant 1).
   */
  private appendSessionEvents(entries: { kind: SessionEvent['kind']; detail: string; lane?: NoCaptureLane }[]): { at: string } {
    if (!this.repoRoot) {
      throw new Error(
        'session-event write: no project root is known to this server, so the transient register location cannot be resolved — use the script fallback (scripts/no-capture.mjs / scripts/concept-designed.mjs in the plugin clone)'
      );
    }
    const eventsPath = join(this.repoRoot, '.sterling', 'transient', 'session-events.json');
    mkdirSync(dirname(eventsPath), { recursive: true });
    let events: unknown[] = [];
    if (existsSync(eventsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(eventsPath, 'utf8'));
        if (Array.isArray(parsed)) events = parsed;
      } catch {
        // tolerate a malformed register exactly as H10 does — degrade to empty
        // rather than refusing the write (the register is transient state)
      }
    }
    const at = this.now();
    // `lane` rides through only when present: an entry without it is written
    // byte-identical to a pre-lane (legacy) event, which H10 reads as the
    // capture lane (decision no-capture-discharge-is-lane-scoped).
    for (const e of entries) events.push({ ...e, at });
    writeFileSync(eventsPath, JSON.stringify(events));
    return { at };
  }

  /**
   * no_capture (§10): the explicit nothing-durable-was-learned declaration
   * (board 7bbec3bd shape, MCP-served since board 75b1a05f).
   *
   * LANE-SCOPED (decision no-capture-discharge-is-lane-scoped,
   * 51ebe0dd-099e-40a9-abc5-d3c8cc767883; USER-RULED 2026-08-22): the
   * declaration discharges only the duty lane it CLAIMS. Omitted `lane` is the
   * BARE declaration — the capture lane only, exactly its pre-2026-08-22
   * behavior — so clearing the research duty takes lane 'research' or 'all'.
   * Mirrors scripts/no-capture.mjs --lane (one contract, two producers). An
   * unrecognized value is REFUSED naming the valid set, never coerced to
   * 'capture' or 'all': a discharge must be no broader than the human's claim,
   * and the silent-loss direction (a truthful "typo fix" clearing an unrelated
   * earlier research duty) is the one that loses knowledge with no trace.
   */
  noCapture(reason: string, lane?: string): { declared: string; at: string; lane: NoCaptureLane } {
    if (!reason || !reason.trim()) {
      throw new Error(`no_capture: 'reason' is required — a false declaration is drift, so say why there is nothing durable`);
    }
    if (lane !== undefined && !(NO_CAPTURE_LANES as readonly string[]).includes(lane)) {
      throw new Error(
        `no_capture: lane '${lane}' is not a valid duty lane — use one of ${NO_CAPTURE_LANES.join(' | ')}. ` +
          `Omitting lane declares the 'capture' lane only; discharging the research duty requires lane 'research' or 'all'. ` +
          `Nothing was written (decision no-capture-discharge-is-lane-scoped).`
      );
    }
    const declaredLane = lane as NoCaptureLane | undefined;
    const { at } = this.appendSessionEvents([
      declaredLane ? { kind: 'no_capture', detail: reason, lane: declaredLane } : { kind: 'no_capture', detail: reason },
    ]);
    return { declared: reason, at, lane: declaredLane ?? 'capture' };
  }

  /** concept_designed (§10): a domain concept family's design settled — H10 will demand the family's concept article (decision 7208729b). */
  conceptDesigned(families: string[]): { registered: string[]; at: string } {
    if (!Array.isArray(families) || families.length === 0 || families.some((f) => typeof f !== 'string' || !f.trim())) {
      throw new Error(`concept_designed: 'families' must be a non-empty array of concept family slugs — blank entries are refused`);
    }
    const { at } = this.appendSessionEvents(families.map((f) => ({ kind: 'concept_designed', detail: f })));
    return { registered: families, at };
  }

  /**
   * capture_pending (§10, board 1af5d630): the capture EXISTS and its write is
   * in flight on a named target (a pending gated commit, a dispatched agent, a
   * lane). Unlike no_capture this is not a claim that nothing durable was
   * learned — it is the truthful middle state the register previously could
   * not express, which trained operators to write boilerplate no_capture
   * declarations (six in ~90 minutes, measured 2026-08-09), and boilerplate is
   * exactly how a FALSE declaration eventually slips through. H10's contract
   * for this kind: defer one Stop with registers preserved (a landed write
   * settles the duty cleanly), then convert a still-pending duty to ONE
   * deduped capture_owed item citing the target — pending work defers or lands
   * on the queue, never evaporates.
   */
  capturePending(target: string, reason: string): { pending: string; at: string } {
    if (!target || !target.trim()) {
      throw new Error(`capture_pending: 'target' is required — name the commit/agent/lane the capture rides, so the deferred debt stays traceable`);
    }
    if (!reason || !reason.trim()) {
      throw new Error(`capture_pending: 'reason' is required — say what capture is in flight`);
    }
    const detail = `${target.trim()} — ${reason.trim()}`;
    const { at } = this.appendSessionEvents([{ kind: 'capture_pending', detail }]);
    return { pending: detail, at };
  }

  // -- board (§3.2.7) ----------------------------------------------------------

  /**
   * A RE-CHECKABLE REFERENCE, in any one of the accepted forms (board fd0e0907,
   * article `board-add-evidence-notice`).
   *
   * A board item states its EVIDENCE, not its conclusion: "the view faces one
   * fixed direction (camera.gd:1591 writes an identity basis)" can be re-checked
   * in one grep; "the facing is broken" cannot, and rots invisibly. MEASURED in
   * a consuming project (2026-08-28): of eight open defects re-audited, two were
   * already fixed and three had changed shape — 5 of 8 wrong, and none of it
   * failed loudly; it failed by sending a session at work that did not need
   * doing.
   *
   * ANY ONE FORM SUFFICES, and the notice therefore fires only on the absence of
   * ALL of them together. The signal is deliberately NOT "contains a number" —
   * the board item names that heuristic as too weak, because dates, ids and
   * priorities are all numbers. What counts is something a later reader can go
   * and CHECK.
   *
   * DELIBERATELY GENEROUS. A noisy advisory gets ignored, and the true positive
   * goes with it, so every form here errs toward ACCEPTING the text: a false
   * alarm costs the author's trust in the whole channel, while a missed
   * evidence-free item costs one un-warned write.
   */
  private hasCheckableEvidence(text: string): boolean {
    return [
      // a repo-relative path — a token carrying a separator and an extension
      /[\w.-]+\/[\w./-]*\.\w{1,8}\b/,
      // a path with a line number (the canonical form the contract quotes)
      /[\w.-]+\.\w{1,8}:\d+/,
      // a double-quoted literal, quoted from code or output
      /"[^"\n]+"/,
      // a backticked literal
      /`[^`\n]+`/,
      // a measured number carrying a unit or a counted noun (never a bare digit)
      /\b\d[\d,]*(\.\d+)?\s*%/,
      /\b\d[\d,]*(\.\d+)?\s+[A-Za-z]{3,}/,
      // a spelled-out count with the thing counted — the AC's worked example
      // ("three commits") is exactly this shape
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)\s+[A-Za-z]{3,}/i,
      // a record id, or the 8-char citation prefix this repo cites by
      /\b[0-9a-f]{8}\b/,
    ].some((re) => re.test(text));
  }

  boardAdd(args: Record<string, unknown>): CreateResult & { notice?: string } {
    const { text, source, objective, measured_at_head, ...rest } = args;
    // Objective grouping (decision a8d2ce6c): a grouping key for the human's
    // board only — maintenance items are lane-keyed by system_reason.
    if (objective !== undefined && source === 'system') {
      throw new Error(
        `board_add: 'objective' groups source:'user' board tasks only — maintenance-queue items are lane-keyed by system_reason, never objective-grouped`
      );
    }
    // 'standalone' (exact lowercase) is the declared answer for "not a slice";
    // it normalizes to field-absent so ungrouped items stay shapeless.
    const normalized = objective === 'standalone' ? undefined : objective;
    // board-provenance-measured-at-head: server-stamps HEAD at add time unless
    // the caller supplies its own sha (decision — the a2a17efa §13.2 incident:
    // an author who knew the head had nowhere to put it). A caller-supplied
    // sha that does not resolve in this repo is refused BY NAME rather than
    // silently replaced with HEAD (P5); an absent/unavailable git degrades to
    // no stamp at all, same swallow direction as every other write-time probe
    // in this file — the annotation surface (board_query) is where absence
    // gets disclosed, not the write.
    let stampedHead: string | undefined;
    if (measured_at_head !== undefined) {
      const candidate = String(measured_at_head);
      // FIX F5 (review 2026-08-24): the 40-hex SHAPE check runs BEFORE
      // shaResolves — git resolves an abbreviated sha too, so a short-but-real
      // value would pass shaResolves and only fail later at the schema layer
      // with a bare zod message instead of this refusal naming the value.
      if (!/^[0-9a-f]{40}$/.test(candidate) || !this.shaResolves(candidate, this.repoRoot)) {
        throw new Error(
          `board_add: measured_at_head '${candidate}' does not resolve to a commit in this repo — refused rather than silently replaced with HEAD (P5, decision board-provenance-measured-at-head)`
        );
      }
      stampedHead = candidate;
    } else {
      stampedHead = this.currentHeadSha(this.repoRoot);
    }
    const res = this.knowledgeCreate('todo', {
      text,
      source,
      ...(normalized !== undefined ? { objective: normalized } : {}),
      ...(stampedHead !== undefined ? { measured_at_head: stampedHead } : {}),
      ...rest,
    });
    const notices: string[] = [];
    if (source === 'user' && objective === undefined) {
      // Never a throw on the capture path — the item is saved; the default is
      // disclosed loudly with its remedy (decision a8d2ce6c: the server has no
      // caller identity, so a refusal could lose a user-stated task).
      notices.push(
        `objective undeclared — saved as standalone; if this task is a slice of a larger objective, set it via board_update {objective: "<name>"}`
      );
    }
    // EVIDENCE, NOT CONCLUSION (board fd0e0907). A NOTICE, NEVER A REFUSAL:
    // some legitimate items genuinely have no file evidence yet — a design
    // question, a user ruling to obtain, a coordinating parent — and a refusal
    // would force either ceremony or a fake citation, both worse than the gap.
    // It also has to be a notice for the same reason the objective default is:
    // the server has no caller identity, so refusing could lose a user-stated
    // task outright. Write time is the only cheap moment to fix this — the
    // author is still holding the evidence they are about to omit.
    //
    // USER ITEMS ONLY (AC4): the maintenance queue is mechanism-minted and
    // carries a registered system_reason, not prose evidence. Noticing it would
    // fire on every enqueue forever, which is how a channel gets ignored.
    if (source === 'user' && !this.hasCheckableEvidence(String(text ?? ''))) {
      notices.push(
        `no checkable evidence in this item's text — it reads as a CONCLUSION rather than the evidence for one, so a later reader cannot re-check ` +
          `it and it will rot invisibly (measured: of eight defects re-audited in one consuming project, 5 of 8 were wrong at HEAD). ` +
          `Quote the deciding reference: a file:line citation such as src/foo.ts:42, a repo-relative path, the literal string you saw, ` +
          `a measured count, or the id of the record this concerns. The item WAS saved — fix it in place with board_edit.`
      );
    }
    // NO HANDLE COULD BE DERIVED — SAY SO (review finding 3, 2026-08-29). The
    // mint is silent by construction: slugify keeps ASCII alphanumerics, so a
    // headline written entirely in CJK, Cyrillic or emoji ('日本語のタスク')
    // slugifies to '', mintSlug returns undefined, and the item is saved with
    // no handle at all and no word said. The item LEAST readable to the slug
    // machinery is exactly the one a human most needs a name for, so a silent
    // no-mint is the worst possible place for silence (P5).
    //
    // A NOTICE, NOT TRANSLITERATION: romanising a non-Latin script is a
    // language-specific judgment (は is 'ha' or 'wa' by grammatical role), and
    // a wrong romanisation is a handle nobody recognises — the same failure the
    // notice exists to report, wearing a costume. Latin-script accents are a
    // different case and ARE handled, by the NFD pass in slugify.
    //
    // USER ITEMS ONLY: a system maintenance item mints nothing BY DESIGN (see
    // mintHeadlineOf), so noticing it would fire on every enqueue and say
    // nothing true.
    if (source === 'user' && !(res.record as unknown as { slug?: string }).slug) {
      notices.push(
        `no handle could be derived from this item's headline — it slugifies to nothing (non-Latin script, digits or symbols only), so this item has no readable name and can be cited only by its id; give it one via board_add {slug: "<handle>"} on a re-add, or lead the text with a Latin-script headline line`
      );
    }
    if (notices.length) return { ...res, notice: notices.join(' | ') };
    return res;
  }

  /**
   * The whole filtered set, uncapped — ONE definition of the board filter, shared
   * by the capped array (boardQuery, for internal callers) and the disclosed
   * envelope (boardQueryResult, for the tool surface). Extracted so the two can
   * never disagree about what "matching" means.
   */
  private boardFiltered(filter: BoardFilter): { matching: DurableRecord[]; scanTruncated: boolean } {
    const todos = this.store.query({ types: ['todo'], file_keys: filter.file_keys, cap: BOARD_SCAN_CAP });
    // Apply EVERY filter BEFORE the cap slice (audit finding 33/43): capping the
    // mixed set first silently dropped matching items past the cap (the store
    // orders updated_at DESC, so long-standing reason-filtered items vanished).
    let filtered = filter.source ? todos.filter((t) => (t as { source: string }).source === filter.source) : todos;
    if (filter.system_reason) {
      filtered = filtered.filter((t) => (t as { system_reason?: string }).system_reason === filter.system_reason);
    }
    if (filter.contains) {
      const needle = filter.contains.toLowerCase();
      filtered = filtered.filter((t) => ((t as { text?: string }).text ?? '').toLowerCase().includes(needle));
    }
    if (filter.objective !== undefined) {
      // Same normalization the WRITE side applies (decision a8d2ce6c):
      // 'standalone' means ungrouped, which is stored as field-absent.
      const wanted = filter.objective === 'standalone' ? undefined : filter.objective;
      filtered = filtered.filter((t) => (t as { objective?: string }).objective === wanted);
    }
    if (filter.feature_slug !== undefined) {
      const chain = this.articleChainIds(filter.feature_slug);
      filtered = chain ? filtered.filter((t) => chain.has((t as { feature_link?: string }).feature_link ?? '')) : [];
    }
    // DETERMINISTIC ORDER, MADE EXPLICIT (board b786a84f, PAGING): the store's
    // own order for a rank_terms-less query() is `updated_at DESC` (mechanical
    // fallback rank, §3.4). Re-sorted here on that SAME key so the order is a
    // property of this method rather than an incidental SQL detail — but only
    // on `updated_at`: Array.prototype.sort is SPEC-GUARANTEED STABLE (ES2019),
    // so returning 0 for a tie (two todos sharing one updated_at, e.g. minted
    // in the same write or the same test tick) preserves whatever relative
    // order the underlying scan already produced for them, rather than
    // imposing a different tie-break (an id-based one was tried and reordered
    // same-timestamp items relative to existing, already-passing callers that
    // assume insertion order for ties). Paging is still exactly reproducible:
    // offset 0, cap, 2·cap, … visits every matching item once, in one order,
    // as long as the board is unchanged between calls.
    filtered = [...filtered].sort((a, b) => {
      const at = (a as { updated_at: string }).updated_at;
      const bt = (b as { updated_at: string }).updated_at;
      if (at === bt) return 0;
      return at < bt ? 1 : -1;
    });
    // The underlying scan is itself bounded; if it came back full, the count we
    // can report is a FLOOR, and saying so beats quietly under-reporting (P5).
    return { matching: filtered, scanTruncated: todos.length >= BOARD_SCAN_CAP };
  }

  /**
   * Resolves a feature_slug to its owning article's id PLUS every ancestor id
   * in its supersede chain — the article's own rel:'supersedes' links, which
   * accumulate every prior version across reconciles (the same join
   * knowledgeUpdate's drift-item auto-drain already walks, decision 8ecd435f),
   * so an item raised against an earlier version of the article still matches
   * after it was superseded. Returns null when the slug resolves to no article
   * at all — the caller treats that as "narrows to nothing", not an error.
   */
  private articleChainIds(slug: string): Set<string> | null {
    const articles = this.store.articlesBySlug(slug);
    if (articles.length === 0) return null;
    const chain = new Set<string>();
    for (const article of articles) {
      chain.add(article.id);
      for (const link of (article.links ?? []) as { rel: string; target_id: string }[]) {
        if (link.rel === 'supersedes') chain.add(link.target_id);
      }
    }
    return chain;
  }

  /**
   * PARALLEL-LANE SEED — derive `lane_advisory` from the FULL MATCHED SET.
   *
   * Deliberately fed `matching`, never the post-cap `records` window: a
   * collision the caller's cap happens to split across two pages is exactly the
   * collision most likely to be missed by hand, so scanning the page would make
   * the advisory least useful precisely where it is most needed.
   *
   * `file_keys` is read as a proxy for a slice's WRITE-SET. That proxy was
   * MEASURED before this shipped (2026-08-29, 14 sampled open user items / ~29
   * entries): all but ~2 entries were write targets, the exceptions being paths
   * an item named as the mechanism to derive FROM. So false collisions from
   * read-only entries are rare; and because this never denies anything, a false
   * collision costs a line of prose rather than a serialized lane. The blast
   * radius of the proxy being wrong is bounded BY the advisory-only design.
   *
   * Returns undefined — not an empty block — when nothing collides: an empty
   * advisory is a claim ("checked, nothing found") this cannot honestly make
   * for items that declare no file_keys at all, and absence keeps the envelope
   * silent on a board with nothing to say.
   */
  private laneAdvisory(matching: DurableRecord[]): LaneAdvisory | undefined {
    // AC4: system-source items are maintenance debt drained by an artifact-write,
    // not parallel work — they never join a group, so maintenance_query (all
    // system) never carries this key.
    const userItems = matching.filter((r) => (r as unknown as { source?: string }).source === 'user');
    // path -> the user items declaring it, in `matching` order (updated_at DESC).
    const byPath = new Map<string, DurableRecord[]>();
    for (const item of userItems) {
      const keys = (item as unknown as { file_keys?: unknown }).file_keys;
      if (!Array.isArray(keys)) continue;
      // Dedupe WITHIN one item: a path listed twice by one item is not a
      // collision with itself.
      for (const path of new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))) {
        const bucket = byPath.get(path);
        if (bucket) bucket.push(item);
        else byPath.set(path, [item]);
      }
    }
    // Merge paths sharing the IDENTICAL item set into one group — that is what
    // makes `paths` plural. Five slices that all write the same hook AND the
    // same test file read as one collision, not two.
    const groups = new Map<string, { paths: string[]; items: DurableRecord[] }>();
    for (const [path, items] of byPath) {
      if (items.length < 2) continue; // AC1: two or more, or it is not a collision
      // Separator is a SOURCE-LEVEL escape (anti-pattern d7e03137): \x1F cannot
      // occur in a uuid, so the impossibility property holds without a raw
      // control byte flipping this file to binary for grep/tooling.
      const key = items.map((i) => (i as unknown as { id: string }).id).join('\x1F');
      const group = groups.get(key);
      if (group) group.paths.push(path);
      else groups.set(key, { paths: [path], items });
    }
    if (groups.size === 0) return undefined; // AC3: absent, never an empty block
    const collisions: LaneCollision[] = [...groups.values()]
      .map((g) => ({
        paths: [...g.paths].sort(),
        // AC7: name first, id retained — never a bare id in front of a human.
        items: g.items.map((i) => {
          const rec = i as unknown as Record<string, unknown>;
          return { id: String(rec.id), name: SterlingTools.boardItemName(rec) };
        }),
      }))
      // Deterministic and useful: the widest collision first, ties broken on the
      // first path so the order never depends on Map insertion order.
      .sort((a, b) => b.items.length - a.items.length || (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
    return {
      serialized_lane: 'implementation',
      parallel_safe_lanes: ['read_only_scoping', 'test_authoring'],
      collisions,
    };
  }

  /**
   * A board item's human-readable name: its slug, or — for a legacy slugless
   * item — its clipped headline, which IS the item's title in practice (board
   * text opens with an all-caps statement of the finding). Deliberately more
   * forgiving than headlineRecord's slug-or-nothing rule: that surface prints a
   * name BESIDE a field the reader can already see, whereas a collision group's
   * whole job is to let a human recognise which items collide, and a group of
   * bare uuids is the unanswerable-question failure this rule exists to close.
   */
  private static boardItemName(rec: Record<string, unknown>): string {
    const slug = typeof rec.slug === 'string' ? rec.slug.trim() : '';
    if (slug) return clipName(slug);
    const text = typeof rec.text === 'string' ? rec.text : '';
    const headline = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
    // Last resort only — an item with neither slug nor text should not exist,
    // and a marker beats an empty string that reads as a missing field.
    return headline ? clipName(headline) : '(unnamed board item)';
  }

  boardQuery(filter: BoardFilter = {}): DurableRecord[] {
    const offset = filter.offset ?? 0;
    const cap = filter.cap ?? DEFAULT_BOARD_CAP;
    return this.boardFiltered(filter).matching.slice(offset, offset + cap);
  }

  /**
   * The MCP-facing result for board_query / maintenance_query: the same envelope
   * knowledge_query gained in decision b47889b7, extended to the two surfaces it
   * MISSED. That omission was reported from the field within a day: "maintenance_
   * query caps at 50 silently. No count, no '50 of N'. I only learned the tail was
   * deep because removing 19 revealed 19 more, including a capture_owed reason not
   * previously visible." A queue that under-reports its own depth reads as drained
   * when it is merely truncated — and a drain is exactly the operation that must
   * know what remains.
   *
   * One difference from knowledge_query, in this surface's favour: the filter runs
   * in JS over the scanned set, so `capped` here is EXACT (returned < matching)
   * rather than the returned === cap heuristic that FTS rank-blindness forces
   * there. The field NAME is deliberately the same (matched_filter = records
   * matching the filter you gave) — one name per concept, with each tool
   * documenting its own guarantee.
   */
  boardQueryResult(filter: BoardFilter = {}): BoardQueryResult {
    const { matching, scanTruncated } = this.boardFiltered(filter);
    const cap = filter.cap ?? DEFAULT_BOARD_CAP;
    const offset = filter.offset ?? 0;
    const records = matching.slice(offset, offset + cap);
    // capped is EXACT here (same guarantee as before offset existed): more of
    // the matching set sits past this page's end.
    const capped = offset + records.length < matching.length;
    const projection = filter.projection ?? 'full';
    const notes: string[] = [];
    if (capped) {
      notes.push(
        `cap reached — showing ${records.length} of ${matching.length} matching items (offset ${offset}); ` +
          `page with offset:${offset + records.length} to continue, or raise cap to see more per page (a drain that stops at the cap leaves the tail behind)` +
          (projection === 'full' ? `, or re-run with projection:"digest"/"headline" for compact items (board items run to several KB of text each)` : '')
      );
    }
    if (scanTruncated) {
      notes.push(
        `the underlying todo scan hit its ${BOARD_SCAN_CAP}-record ceiling, so matched_filter is a FLOOR, not a total — ` +
          `and PAGING IS BOUNDED BY THAT SAME CEILING: an offset at or past ${BOARD_SCAN_CAP} addresses items the scan never reached, so it cannot be served (an empty page here is not necessarily the end of the queue)`
      );
    }
    // board-provenance-measured-at-head: ONE bounded git walk for this whole
    // page (never per item), then the warning — if any — is appended to the
    // projected record's `text` (full/digest/headline all read `text`, and
    // this keeps the annotation visible through whichever projection the
    // caller asked for without adding a wire field no projection declares).
    const { status: provenance, warnings } = this.computeProvenance(records, this.repoRoot);
    // TRUTH AT READ (decision queue-truth-at-read-annotation-design): the ONE
    // integration point for the reconcile_needed drift re-check. Gated INSIDE to
    // this page's source:'system'/reconcile_needed rows, so a source:'user'
    // query pays nothing; maintenance_query delegates to this same method, so
    // both public views of one row agree about whether it is a closeable no-op.
    // AFTER pagination, deliberately: the check is page-scoped, never
    // matched-set-scoped, because its cost is per item actually served.
    const { status: reconcile_provenance, annotations: reconcileNotes } = this.reconcileTruthAtRead(records);
    if (reconcile_provenance === 'checked:budget_truncated') {
      notes.push(
        `the reconcile_needed drift re-check hit its per-call BUDGET on this page and was TRUNCATED — the items it could not finish ` +
          `say 'unavailable:budget' themselves and must be treated as OPEN; narrow the page (cap/offset, or system_reason) to re-check them`
      );
    }
    // PARALLEL-LANE SEED: derived from `matching` (the FULL matched set), NOT
    // from `records` — see laneAdvisory. Advisory only: it is computed after
    // `records` is already fixed and never touches it.
    const lane_advisory = this.laneAdvisory(matching);
    const projectRecord = (r: DurableRecord): Record<string, unknown> => {
      const base =
        projection === 'headline'
          ? headlineRecord(r as unknown as Record<string, unknown>)
          : projection === 'digest'
            ? digestRecord(r as unknown as Record<string, unknown>)
            : { ...(r as unknown as Record<string, unknown>) };
      const id = (r as unknown as { id: string }).id;
      const warning = warnings.get(id);
      // COMPOSED AFTER THE PROJECTION CLIP, like the provenance warning beside
      // it and for the same reason: a verdict clipped away by digest/headline
      // would make those surfaces the ones that lie about the item.
      const note = reconcileNotes.get(id);
      if (!warning && !note) return base;
      const text = typeof base.text === 'string' ? base.text : '';
      // OUTSIDE-MODEL FINDING 3: headline's line stays compact (short markers,
      // appended directly, no separator) — the full sentences only land on
      // digest/full, which already tolerate multi-line text. Both annotations
      // can apply to one row (an aged keyed item whose drift is also gone), so
      // they compose rather than one displacing the other.
      if (projection === 'headline') return { ...base, text: `${text}${warning ? warning.short : ''}${note ? note.short : ''}` };
      const parts = [text, warning?.full, note?.full].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return { ...base, text: parts.join('\n\n') };
    };
    return {
      matched_filter: matching.length,
      returned: records.length,
      cap,
      capped,
      offset,
      provenance,
      reconcile_provenance,
      // AC3: the key is ABSENT when nothing collides, never an empty block.
      ...(lane_advisory ? { lane_advisory } : {}),
      ...(notes.length ? { note: notes.join('; ') } : {}),
      // AC6: unchanged, unfiltered, unreordered — the advisory above is derived
      // FROM this page's matched set and never acts on it.
      records: records.map(projectRecord),
    };
  }

  /**
   * IN-PLACE edit of a board/queue item's text/priority/file_keys (work order
   * 9a06b6aa) — the id stays stable and NO new version is minted, unlike every
   * other durable record's change primitive (knowledge_update supersedes). That
   * asymmetry is deliberate: a todo is not in the immutable set (only decision
   * is), and rewriting one via remove+re-add was costing full retransmission on
   * every edit ("every retransmission is a chance to corrupt an item that was
   * previously correct") while stranding every reference keyed on the old id
   * (feature_link, H7/H10 items) on every edit — the id-rot complaint this
   * closes.
   *
   * UPDATING NEVER CLOSES AN ITEM: board_remove, bound to the fulfilling
   * artifact-write, remains the only exit (P4) — this is not a soft-close and
   * must not be used as one.
   *
   * Only text/priority/file_keys may change through this path: source and
   * system_reason decide which surface (board vs. queue) an item lives on, and
   * an edit must never move an item between them; status/id/created_at/type/
   * superseded_by are server-owned everywhere else in this store, and this
   * surface is no exception. Anything outside that set is REFUSED BY NAME,
   * naming the valid set — the same refuse-don't-drop convention as
   * refuseUnknownFields/refuseServerOwnedFields (decision b47889b7 class) —
   * rather than silently ignored, which would report success on a write that
   * changed nothing the caller asked for. An empty patch is refused for the
   * same reason: nothing to update is not a no-op success.
   */
  private static readonly BOARD_UPDATABLE_FIELDS = ['text', 'priority', 'file_keys', 'objective', 'measured_at_head'] as const;

  boardUpdate(id: string, patch: Record<string, unknown>): DurableRecord {
    // Resolves through the SAME ladder as knowledge_get/board_get (full uuid,
    // exact slug, 8-char citation prefix — resolveRecordId, decision 2debab53):
    // board_update previously used a raw store.get(id), so an unresolved
    // prefix that board_get resolved fine threw a bare "no record" here
    // (measured 2026-08-22 friction). A HistoricalIdError is deliberately left
    // to propagate unchanged — a write must address the live record, never a
    // version-pinned dead id.
    const old = this.resolveRecordId(id, 'board_update');
    if (old.type !== 'todo') throw new Error(`board_update: '${id}' is a ${old.type}, not a task — board_update only edits board/queue items`);
    const updatable: readonly string[] = SterlingTools.BOARD_UPDATABLE_FIELDS;
    const unknown = Object.keys(patch).filter((k) => !updatable.includes(k));
    if (unknown.length) {
      throw new Error(
        `board_update: ${unknown.map((k) => `'${k}'`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not editable through board_update — ` +
          `only ${updatable.join('/')} may change in place. source/system_reason decide which surface an item lives on and must never move by edit; ` +
          `status/id/created_at/type/superseded_by are server-owned. Updating never closes an item — board_remove, bound to the fulfilling ` +
          `artifact-write, remains the only exit. Valid fields: ${updatable.join(', ')}.`
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(`board_update: no fields to update — pass at least one of ${updatable.join(', ')}`);
    }
    // board-provenance-measured-at-head: a text/file_keys rewrite carries new
    // evidence, so it re-stamps measured_at_head to the CURRENT HEAD — unless
    // the caller explicitly named a measured_at_head in this same patch, which
    // wins verbatim (validated below). priority/objective-only patches leave
    // the field untouched entirely (no key added to `next`). A caller-supplied
    // measured_at_head that does not resolve is refused by name, never
    // silently replaced with HEAD (P5) — on EITHER path (bare re-verify or
    // alongside a text/file_keys change).
    if ('measured_at_head' in patch) {
      const candidate = String(patch.measured_at_head);
      // FIX F5: shape check before shaResolves (see boardAdd's identical fix).
      if (!/^[0-9a-f]{40}$/.test(candidate) || !this.shaResolves(candidate, this.repoRoot)) {
        throw new Error(
          `board_update: measured_at_head '${candidate}' does not resolve to a commit in this repo — refused rather than silently replaced with HEAD (P5, decision board-provenance-measured-at-head)`
        );
      }
    } else if ('text' in patch || 'file_keys' in patch) {
      const head = this.currentHeadSha(this.repoRoot);
      if (head) patch = { ...patch, measured_at_head: head };
    }
    const next = { ...old, ...patch, updated_at: this.now() } as Record<string, unknown>;
    // 'standalone' clears the grouping to absent (decision a8d2ce6c) — the same
    // sentinel board_add takes, so re-grouping and un-grouping share one vocabulary.
    if (next.objective === 'standalone') delete next.objective;
    // old.id (the resolved canonical id), not the caller's possibly-short
    // citation — a mounted domain store's routing (storeHolding) keys off the
    // real id, and a bare prefix would not resolve there.
    //
    // RAW-ZOD LEAK INVENTORY (board a00689b9, site 2): store.updateTodo
    // re-parses the merged candidate against the todo schema (e.g. an empty
    // `text` fails its min(1)) and throws the raw ZodError across the store
    // boundary — caught and re-rendered the same way as knowledgeUpdate's
    // own store-validation catch, rather than leaking the raw issue array on
    // a caller-triggerable, constantly-used surface.
    try {
      return this.store.updateTodo(old.id, next as typeof old);
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, 'todo', 'board_update');
      throw err;
    }
  }

  /**
   * board_get(id) — the full, untruncated board/queue item (board e725979c):
   * board_query/maintenance_query's projection:'digest' clips text at
   * DIGEST_CLIP, and until now there was no escape hatch back to the whole
   * record short of an uncapped full-projection re-query. Resolves through the
   * SAME three-form ladder as knowledge_get (full uuid, exact slug, 8-char
   * citation prefix — resolveRecordId, board slice 85ecfe43), so a citation
   * copied from anywhere in this store resolves the same way here as
   * everywhere else. An unknown id is refused, naming the id that was not
   * found, rather than returning undefined.
   */
  boardGet(id: string): DurableRecord {
    let record: DurableRecord;
    try {
      record = this.resolveRecordId(id, 'board_get');
    } catch (err) {
      // A HISTORICAL id READS (review finding), same as knowledge_get: the
      // ladder's refusal is written for WRITES and says so ("reads through this
      // id still work"), so serving it here would contradict itself. The
      // archived snapshot comes back carrying its legacy_resolution block, and
      // the type guard below still applies to it — a dead id that named
      // something other than a board item is still not a board_get.
      if (!(err instanceof HistoricalIdError)) throw err;
      record = this.serveArchivedAlias(err.alias) as unknown as DurableRecord;
    }
    if (record.type !== 'todo') {
      throw new Error(
        `board_get: '${id}' resolves to a ${record.type}, not a board/queue item — board_get reads board_add/maintenance_enqueue items only; use knowledge_get for other record types`
      );
    }
    return this.withDisplaySlug(record);
  }

  /**
   * DERIVE-ON-READ, NOT BACKFILL (S1 design call, decision
   * human-readable-ids-for-board-items). Items created before the mint — and
   * maintenance-queue items, which mint nothing (see mintHeadlineOf) — carry no
   * stored slug. Rather than migrate every legacy row, board_get derives a
   * display NAME from the item's own headline, so no surface has to print bare
   * hex for an item that predates S1. de1a7329 set the migration-free
   * precedent, and a backfill would also rewrite every legacy row's updated_at,
   * reordering the board and the activity feed for a purely cosmetic gain.
   *
   * THE DERIVED NAME IS DISPLAY-ONLY AND NOT ADDRESSABLE, and this asymmetry is
   * deliberate: nothing is persisted, so a legacy item is addressed by its uuid
   * or 8-char prefix exactly as before (the migration-free round-trip). Making
   * it addressable would mean deriving over every todo on every lookup and
   * inventing a tie-break when a derived name shadows a REAL minted slug —
   * paying a permanent ambiguity for items that already resolve fine.
   *
   * SUPPRESSED WHEN THE DERIVED NAME IS ALREADY A LIVE HANDLE (review finding
   * 1, 2026-08-29). "Not addressable" is a property of the name, not of the
   * derive: a derived name is a bare kebab string, byte-identical in shape to a
   * minted handle, so a reader handed one cites it — and if some OTHER record
   * already owns that exact string, the citation resolves through
   * resolveRecordId to THAT record and the reader reads (or board_updates) the
   * wrong item, silently. It is reachable: legacy item A opens "EXPORT THE
   * BOARD AS CSV.", the same task is later re-boarded as item B, and B MINTS
   * 'export-the-board-as-csv'. That defeats the whole point of the feature —
   * readable-ids exists so a citation names the thing the reader means
   * (decision human-readable-ids-for-board-items).
   *
   * THE CHECK IS THE RESOLVER'S OWN LOOKUP, not an approximation of it:
   * resolveRecordId's slug rung is store.recordsBySlug(id) — one hit resolves,
   * several refuse — so a derived name is unsafe to hand out exactly when
   * recordsBySlug(derived) is non-empty, and this suppression set equals the
   * resolution set by construction. It lives INSIDE the one derive path (which
   * is why this is an instance method now): there is no unchecked derive for a
   * future call site to reach for, so the guard cannot be forgotten the way a
   * per-call-site check could.
   *
   * A SUPPRESSED ITEM READS BACK WITH NO NAME — the pre-S1 bare-hex state for
   * that one shadowed item, which is the honest degradation: an absent name is
   * a visible gap, while a name that means a different record is a silent wrong
   * answer (P5, and the disclose-never-silently-serve posture of decision
   * falsified-slug-handling-supersede-disclose-user-decided-2026).
   *
   * Never applied to a record with a stored slug: a minted handle always wins.
   */
  private withDisplaySlug(record: DurableRecord): DurableRecord {
    const r = record as unknown as { slug?: string; text?: string };
    if (r.slug) return record;
    const derived = SterlingTools.slugify(SterlingTools.todoHeadline(r.text ?? ''));
    if (!derived) return record;
    if (this.store.recordsBySlug(derived).length) return record;
    return { ...record, slug: derived } as DurableRecord;
  }

  /**
   * board_edit(id, find, replace) — knowledge_edit's exactly-once find/replace
   * contract (board fd6d8da9), applied to a board/queue item's `text` IN
   * PLACE: id preserved, no new version minted, unlike knowledge_edit's
   * supersession (decision a91c80b5 — board_update's identity semantics, not
   * knowledge_update's). Delegates the actual write to boardUpdate so there is
   * exactly one in-place-edit code path — source/system_reason cannot move an
   * item between surfaces, status/id/created_at stay server-owned, updated_at
   * moves to the write-time clock — and works identically on a user task or a
   * system maintenance item; this method only adds the surgical find/replace
   * over `text` that boardUpdate's retransmit-the-whole-field shape lacked.
   * FIND MUST MATCH EXACTLY ONCE: zero and multiple matches are BOTH refused,
   * naming the count, with nothing written — the same contract knowledge_edit
   * already holds callers to, so a caller cannot lean on a blind
   * replace-first-occurrence against text nobody re-read in full.
   */
  boardEdit(id: string, find: string, replace: string): { record: DurableRecord; replaced: { chars_before: number; chars_after: number } } {
    const old = this.resolveRecordId(id, 'board_edit');
    if (old.type !== 'todo') {
      throw new Error(`board_edit: '${id}' is a ${old.type}, not a task — board_edit only edits board/queue items`);
    }
    if (typeof find !== 'string' || find.length === 0) {
      throw new Error(`board_edit: 'find' must be a non-empty string — an empty match would insert at every position`);
    }
    const current = (old as unknown as { text?: string }).text;
    if (typeof current !== 'string') {
      throw new Error(`board_edit: '${id}' has no 'text' field to edit`);
    }
    const occurrences = current.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `board_edit: 'find' does not appear in the item's text — nothing was written. ` +
          `The text is ${current.length} chars; confirm the exact text (including whitespace and punctuation) before retrying.`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `board_edit: 'find' appears ${occurrences} times in the item's text — refused as ambiguous, nothing was written. ` +
          `Extend 'find' with surrounding text until it identifies exactly one site.`
      );
    }
    const next = current.replace(find, replace);
    const record = this.boardUpdate(old.id, { text: next });
    return { record, replaced: { chars_before: current.length, chars_after: next.length } };
  }

  /**
   * P4: done = removed. The artifact-write binding is now BUILT as EVIDENCE
   * DISCLOSURE, deliberately not a refusal (board b8ff0b68 — 'the plugin's own
   * receipt admits its close-with-artifact rule is unenforced'). Two reasons a
   * hard gate is the wrong shape here: the user board is the human's own
   * surface and legitimate abandonment exists ('no longer wanted' has no
   * artifact and needs none — a refusal would trap exactly the closes only the
   * human may judge); and the failure mode P4 guards against — calling work
   * done in conversation with no artifact — is a VISIBILITY problem, so the
   * receipt now shows what the store can see: durable records touching the
   * item's file_keys written since the item was born. An empty list means the
   * close rides the operator's word, and the receipt says so out loud.
   */
  private removalArtifactEvidence(item: DurableRecord): { artifact_evidence: Record<string, unknown>[]; note?: string; check_skipped?: SkippedCheck[] } {
    const fileKeys = ((item as unknown as { file_keys?: string[] }).file_keys ?? []).filter(Boolean);
    const since = item.created_at;
    // open_question joins the evidence set (board a9be48f2): a board item can
    // legitimately close by being CONVERTED into an evidenced open question —
    // the investigation is now durable and tracked as a record — and without
    // this type the receipt would show empty artifact evidence for exactly the
    // close that produced the most durable artifact.
    const evidenceTypes = ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question', 'reference_material'];
    // FIX M1 (upgrade-polish review, 2026-08-21): the id-citation arm below needs
    // no file identity at all — concept_article_missing / research_owed / plain
    // tasks routinely carry no file_keys, and those are exactly the items most
    // wronged by an early return that skipped BOTH arms. Only the file_keys arm
    // is conditional on fileKeys being non-empty; the id-citation arm always runs.
    let fileKeyMatches: DurableRecord[] = [];
    const checkSkipped: SkippedCheck[] = [];
    if (fileKeys.length === 0) {
      // No file identity to join on for THIS arm only — it cannot run, and says
      // so (P5: a skipped check is loud, never a silent no-op).
      const skipped = { check: 'board-remove-artifact-binding', reason: 'no_file_keys' };
      this.store.recordCheckSkipped(skipped.check, skipped.reason, this.activeRunId(), this.now());
      checkSkipped.push(skipped);
    } else {
      // Scan WIDE, filter by since, THEN trim the receipt (review finding 12,
      // 2026-08-09 — the same pre-cap/post-cap ordering hazard as audit finding
      // 33/43): the store orders by file-key-overlap count first and updated_at
      // only as a tiebreak, so a small cap on a well-documented area fills with
      // old high-overlap records and pushes the one NEW artifact out — and this
      // receipt would then accuse the operator of drift that never happened.
      // 200 is a bounded scan, not a guarantee; past it the disclosure errs
      // toward the scanned window and never blocks either way.
      fileKeyMatches = this.store
        .query({ types: evidenceTypes, file_keys: fileKeys, cap: 200 })
        .filter((r) => r.created_at >= since || r.updated_at >= since);
    }
    // FIX B (upgrade-polish, 2026-08-21): a durable record can fulfil this item
    // WITHOUT ever touching its file_keys — e.g. a decision that closes the
    // item by citing its own id (the citation convention: decisions write
    // 'board <prefix8>', or occasionally the full uuid). Scan wide over the
    // same record surface (no store schema or new index — a linear scan is
    // cheap at this scale) and keep only records written at-or-after the item
    // was created, so a coincidental same-prefix record predating the item
    // never counts as its fulfilling write.
    const prefix = item.id.slice(0, 8);
    const citesItem = (r: DurableRecord): boolean => {
      const body = JSON.stringify(r);
      return body.includes(item.id) || body.includes(prefix);
    };
    // 200 is the SAME bounded scan as the file_keys arm above — the id-citation
    // window covers only the 200 most-recently-updated records of the evidence
    // types, never the whole store; past it the disclosure errs toward the
    // scanned window and never blocks either way.
    const idMatches = this.store
      .query({ types: evidenceTypes, cap: 200 })
      .filter((r) => (r.created_at >= since || r.updated_at >= since) && citesItem(r));
    // Dedupe across the two arms by record id — file_keys order first, then any
    // id-citation matches not already covered.
    const seen = new Set<string>();
    const combined: DurableRecord[] = [];
    for (const r of [...fileKeyMatches, ...idMatches]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      combined.push(r);
    }
    const evidence = combined.slice(0, 25).map((r) => digestRecord(r as unknown as Record<string, unknown>));
    return {
      artifact_evidence: evidence,
      ...(checkSkipped.length > 0 ? { check_skipped: checkSkipped } : {}),
      ...(evidence.length === 0
        ? {
            // FIX M2 (upgrade-polish review, 2026-08-21): disclose the id arm's
            // window honestly — it is a bounded scan of the 200 most-recently-
            // updated records of the evidence types, not an exhaustive search of
            // everything ever written citing this id.
            //
            // ROSTER REVIEW FIX (N28, follow-up): the file-key clause must not
            // claim a negative result for a scan that never ran. When fileKeys
            // is empty the file-key arm is SKIPPED (see check_skipped above) —
            // saying "no knowledge record touching this item's file_keys...
            // since it was created" on exactly those items (concept_article_
            // missing / research_owed / plain tasks, per the FIX M1 comment
            // above) restates the false-reason defect this note exists to fix,
            // just relocated to the keyless case. And when the file-key arm DID
            // run, it is the SAME bounded, overlap-ordered 200-record window as
            // the id-citation arm (see the comment above fileKeyMatches) — an
            // unhedged claim there is exactly as overclaiming as the id arm's
            // own "not an exhaustive search" note already guards against, so
            // both clauses carry the same window disclosure.
            note:
              (fileKeys.length > 0
                ? `no knowledge record touching this item's file_keys among the 200 most-recently-updated evidence records`
                : `this item carries no file_keys, so the file-key scan could not run (see check_skipped)`) +
              `, and no knowledge record citing its id among the 200 most-recently-updated evidence records, since it was created — removed on the operator's word. ` +
              `This checks the durable knowledge store only, never git — a commit that fulfilled this item leaves no trace here unless it was also captured as a record. ` +
              `If work fulfilled this item, its capture is missing (that is drift, not a formality).`,
          }
        : {}),
    };
  }

  /**
   * 'ALREADY REMOVED' IS NOT 'NEVER EXISTED' (board 97d773ef): a remove on a
   * freshly-minted maintenance id routinely finds the item gone because the
   * article re-baseline AUTO-DRAINED it between minting and the call — the
   * NORMAL path, not an error in the caller's id. A bare "no record" forced a
   * board_query round-trip to tell the two apart; the drain-log trace answers
   * it directly. The log keeps only the newest 50 rows, so a missing trace is
   * "no recent trace", never proof of non-existence — the message says so.
   *
   * SHAPE-GATED (2026-08-22 adjudicated fix, kept and REPOINTED by the
   * user-ruled retraction of decision
   * id-ladder-extends-to-board-tools-with-collision-guard): the drain log is
   * keyed by exact FULL record id (FULL_UUID_RE), so consulting it — and
   * offering "it may have aged out" — is only honest for an identifier that
   * could actually have been a drain-log key. An 8-char citation prefix or any
   * other non-uuid-shaped identifier was NEVER going to appear there, whatever
   * its history, so it gets a clean identifier-SHAPE refusal instead: no
   * drain-log clause, no "aged out" false trail.
   *
   * The shape branch is MORE useful now that both callers (board_remove and
   * maintenance_remove) take the exact full id ONLY: a prefix handed to a tool
   * that HARD-DELETES needs to be told it is not a full record id — and why
   * this tool insists on one — rather than be sent to the removal log.
   */
  private removedItemError(op: string, id: string): Error {
    if (!SterlingTools.FULL_UUID_RE.test(id)) {
      // Deliberately never mentions the removal log or "aged" — that clause
      // is only honest for a full-uuid-shaped citation (see doc comment
      // above); a shorter or non-hex identifier was never a candidate key
      // for it, whatever the item's actual history.
      return new UnresolvedIdentifierError(
        `${op}: no record '${id}' — and this tool addresses items by their EXACT full uuid only (no slug, no 8-char citation ` +
          `prefix), which '${id}' is not. Board rows are HARD-DELETED, so an abbreviation that once named a now-removed item can ` +
          `silently retarget to a different, live item and destroy it irreversibly; that is why the full id is required here — ` +
          `board_get, board_update and board_edit still resolve abbreviations, because their worst case is a recoverable edit. ` +
          `Look the item up with board_query or maintenance_query and re-issue with the full uuid; nothing was removed.`
      );
    }
    const trace = this.store.drainLogEntry(id);
    if (trace) {
      return new Error(
        `${op}: item '${id}' was ALREADY REMOVED at ${trace.drained_at} (${trace.system_reason || 'user item'}, per the drain log) — ` +
          `most likely auto-drained by a knowledge_update re-baseline or closed by an earlier remove. Nothing further to do.`
      );
    }
    return new Error(
      `${op}: no record '${id}', and no trace of it in the drain log (which keeps the newest 50 removals) — ` +
        `either the id is wrong, or the item was removed long enough ago that its trace aged out. ` +
        `Note that this tool matches the EXACT full uuid only (board rows are hard-deleted, so a stale abbreviation could ` +
        `silently retarget to a different item) — if you cited an abbreviation of a live item, re-issue with its full id.`
    );
  }

  /**
   * EXACT FULL ID ONLY on the destructive board path (USER-RULED RETRACTION
   * 2026-08-22, partly retracting decision
   * id-ladder-extends-to-board-tools-with-collision-guard).
   *
   * That decision extended the id-resolution ladder (full uuid → exact slug →
   * unambiguous 8-char prefix) to board_remove and maintenance_remove, and
   * closed the resulting hard-delete retarget hazard with a removal-trail
   * collision guard. TWO INDEPENDENT REVIEWS then showed the guard does not
   * close it: both removal trails are capped at 50 rows and the activity log
   * records created/updated/removed alike, so ANY 50 writes evict a removal
   * record and the guard is frequently simply ABSENT — and an absent trail read
   * as permission to delete. Prefix resolution also spans every MOUNTED store
   * while the guard read only the project store.
   *
   * THE RULING: prefix addressing is REVERTED wherever the worst case DESTROYS,
   * and kept where the worst case is a recoverable edit. So board_remove,
   * maintenance_remove and validateResolveClaim take the exact full id only;
   * board_get (read) and board_update / board_edit (in-place, visible, fixable
   * forward) keep the full ladder. Board todos carry no slug, so for these
   * three the exact id IS the whole addressing contract.
   *
   * Every refusal here NAMES WHY (removedItemError) — a bare "no record" is
   * what sent callers hunting for a deleted item in the first place.
   */
  boardRemove(id: string): { removed: string; artifact_evidence?: Record<string, unknown>[]; note?: string; check_skipped?: SkippedCheck[] } {
    const record = this.store.get(id);
    if (!record) throw this.removedItemError('board_remove', id);
    if (record.type !== 'todo') throw new Error(`board_remove: '${id}' is a ${record.type}, not a task`);
    const evidence = this.removalArtifactEvidence(record);
    this.store.remove(record.id, this.now()); // system todos land in the §3.2.7 drain log
    return { removed: record.id, ...evidence };
  }

  /**
   * maintenance_remove — board_remove NARROWED TO THE MAINTENANCE QUEUE, so the
   * librarian can finish its own job (board afeae7d9).
   *
   * The librarian is the role defined to drain the queue, and it held
   * maintenance_query without any removal tool: it could READ the queue and not
   * close anything in it. Every lane WITHOUT a feature_link (article_missing,
   * capture_owed, concept_article_missing, research_owed) is therefore
   * unclosable by it, because those never auto-drain through knowledge_update —
   * so they all bounced back to the conductor.
   *
   * WHY A SEPARATE TOOL RATHER THAN GRANTING board_remove. The MCP server has NO
   * notion of caller identity — there is no agent_id anywhere in it — so a scope
   * PARAMETER on board_remove would be no protection at all: the caller could
   * simply omit it. The scoping has to live in the TOOL, and the grant then
   * selects which surface an agent can reach. The user board (source 'user') is
   * the human's own surface and stays read-only to every agent; this tool refuses
   * a user item by design, naming board_remove as the conductor's path so the
   * refusal teaches rather than merely blocks.
   */
  maintenanceRemove(
    id: string
  ): { removed: string; artifact_evidence?: Record<string, unknown>[]; note?: string; check_skipped?: SkippedCheck[]; already_drained?: boolean } {
    // EXACT FULL ID ONLY, for the same reason board_remove is — this tool
    // hard-deletes a row too (see boardRemove's doc comment for the reverted
    // ladder extension and the two reviews that reverted it).
    const found = this.store.get(id);
    if (!found) {
      // IDEMPOTENT ALREADY-DRAINED (board 83478fc6, extending 97d773ef): a
      // drain-log trace naming a SYSTEM item (system_reason set, per the store's
      // `record.system_reason ?? ''` write) means this id was a maintenance-queue
      // item that is already gone — auto-drained by a knowledge_update
      // re-baseline (decision 8ecd435f) or closed a moment earlier by a
      // concurrent librarian call. That is the caller's desired end state, not a
      // failure, so it SUCCEEDS idempotently instead of throwing. A trace with no
      // system_reason (a user item) or no trace at all still falls through to the
      // loud refusal below — collapsing either into "already drained" would let
      // a genuine typo, or a request against the human's own board, silently
      // read as success.
      const trace = this.store.drainLogEntry(id);
      if (trace && trace.system_reason) {
        return { removed: id, already_drained: true };
      }
      throw this.removedItemError('maintenance_remove', id);
    }
    const record = found;
    if (record.type !== 'todo') throw new Error(`maintenance_remove: '${id}' is a ${record.type}, not a todo`);
    const source = (record as unknown as { source?: string }).source;
    if (source !== 'system') {
      throw new Error(
        `maintenance_remove: '${id}' is a ${source ?? 'user'}-source board item, not a maintenance-queue item. ` +
          `This tool removes system-source items only — the user board is the human's own surface and is not an agent's to clear. ` +
          `If you are the conductor and this item is genuinely fulfilled, use board_remove.`
      );
    }
    const evidence = this.removalArtifactEvidence(record);
    this.store.remove(record.id, this.now()); // logged to the §3.2.7 drain log, as every system removal is
    return { removed: record.id, ...evidence };
  }

  /**
   * knowledge_retire — the retirement path, built from a primitive that already
   * existed (board 77f00139).
   *
   * Until now `status`/`superseded_by` were server-owned and refused from the
   * tool surface, no delete tool existed, and `state: 'deprecated'` was the only
   * signal an author could set — which does not remove a record from ANY result
   * set. So retiring made a record MORE visible, not less, and if it was the
   * newest under its slug it WON retrieval. That is how a tombstone became the
   * authoritative answer for a live concept in a consuming project.
   *
   * store.retireInFavorOf already had exactly the right semantics (built for
   * knowledge_promote's cross-store tombstone): status → superseded,
   * superseded_by → the survivor, NO new row, provenance and inbound links
   * intact, and query() already never serves superseded records. It was simply
   * unreachable except through promotion. This exposes it.
   *
   * in_favor_of is REQUIRED, and that is the point. Retirement is not deletion:
   * the fix-it-forward rule stands, so a record that is merely WRONG gets
   * knowledge_update, not this. This tool is for the one shape update cannot
   * repair — a genuine DUPLICATE, where two records both claim to describe one
   * thing and the reader needs to be sent to the survivor. Requiring the survivor
   * means a retired record always forwards somewhere, so an old citation lands on
   * the right record instead of dangling.
   */
  knowledgeRetire(id: string, inFavorOf: string): { retired: DurableRecord } {
    if (id === inFavorOf) throw new Error(`knowledge_retire: a record cannot be retired in favour of itself ('${id}')`);
    // Only the id BEING RETIRED resolves through the shared contract
    // (slug/prefix/uuid) — in_favor_of stays a plain lookup, unchanged.
    const record = this.resolveRecordId(id, 'knowledge_retire');
    // The transient/user surfaces have their own P4 removal paths and must not
    // acquire a second one that leaves a superseded husk behind in a queue.
    if (record.type === 'todo') {
      throw new Error(
        `knowledge_retire: '${id}' is a todo — those leave through board_remove / maintenance_remove (done = removed, P4), not retirement.`
      );
    }
    // in_favor_of resolves through the SHARED LADDER too (review finding): a raw
    // store.get answered a HISTORICAL survivor id with "no record", which reads
    // as "your citation is fabricated" for a record that is alive under a
    // canonical id — the exact false negative record_aliases exists to remove
    // ([stable-identity-design-v2] contract 3). The historical-id refusal
    // propagates unchanged (it names the canonical id to retire into); only a
    // GENUINE miss keeps this tool's own survivor-shaped wording, which says
    // more than the ladder's generic one.
    let survivor: DurableRecord;
    try {
      survivor = this.resolveRecordId(inFavorOf, 'knowledge_retire', 'target record');
    } catch (err) {
      if (!(err instanceof UnresolvedIdentifierError)) throw err;
      throw new Error(
        `knowledge_retire: no record '${inFavorOf}' to retire in favour of. The survivor must exist first — ` +
          `retiring into a void leaves the reader nowhere to go, which is the failure this tool exists to prevent.`
      );
    }
    // The literal-string self-retire check above cannot see two SPELLINGS of one
    // record (id vs slug vs prefix), which resolving in_favor_of through the
    // ladder now makes reachable — so it is re-checked on the resolved ids.
    if (record.id === survivor.id) {
      throw new Error(
        `knowledge_retire: '${id}' and '${inFavorOf}' both resolve to record '${record.id}' — a record cannot be retired in favour of itself.`
      );
    }
    if (survivor.status === 'superseded') {
      throw new Error(
        `knowledge_retire: '${inFavorOf}' is itself superseded — retiring into a dead record forwards the reader to a tombstone. ` +
          `Resolve the survivor's chain to its live head first.`
      );
    }
    // No check_skipped here, deliberately: skip() reports reason 'not_built',
    // and there is no deferred retirement check to declare. Emitting one would
    // claim an obligation nobody planned — the opposite of what the loud-skip
    // channel is for.
    const retired = this.store.retireInFavorOf(record.id, survivor.id, this.now());
    return { retired };
  }

  // -- knowledge_supersede (decision e17794ea, board 0b33c27b) ----------------

  /** old-record types knowledge_supersede accepts — see the class comment above.
   *  attestation is deliberately NOT here: its supersession path is
   *  knowledge_update fix-forward (immutable-by-construction, the decision
   *  analog), and the orphan-coverage check below is ruling-prose-shaped. */
  private static readonly SUPERSEDE_ALLOWED_TYPES = ['decision', 'anti_pattern', 'research_finding'];

  /** ruling-write types whose create/update receipts surface SAME-SUBJECT
   *  records (decision 7e3c66c5). Superset of SUPERSEDE_ALLOWED_TYPES since
   *  2026-08-21 (review finding on board 259a455f): a second attestation on
   *  one artifact_key is exactly the write that must surface the prior verdict. */
  private static readonly SAME_SUBJECT_TYPES = ['decision', 'anti_pattern', 'research_finding', 'attestation'];

  /** Coverage threshold: a ruling unit counts as covered when at least this fraction of its own content words reappear in the replacement fields. */
  private static readonly ORPHAN_COVERAGE_THRESHOLD = 0.4;

  private static readonly ORPHAN_STOPWORDS = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'were', 'been', 'into', 'than', 'then', 'them',
    'they', 'also', 'each', 'such', 'some', 'more', 'most', 'over', 'under', 'about', 'which',
    'while', 'still', 'only', 'just', 'very', 'much', 'many', 'both', 'after', 'before', 'being',
    'doing', 'having', 'itself', 'those', 'these', 'would', 'could', 'should', 'shall', 'must',
    'might', 'when', 'where', 'what', 'your', 'their', 'there', 'here', 'other', 'above', 'below',
    'again', 'because',
  ]);

  /** Numbered marker forms: "1.", "2)", "(3)" — a marker sits at the start of the string or after whitespace, and is itself followed by whitespace. Digits land in either capture group depending on which form matched. */
  private static readonly ORPHAN_NUMBER_RE = /(?:^|(?<=\s))(?:(\d{1,3})[).]|\((\d{1,3})\))(?=\s)/g;

  /** Bulleted marker forms: "- ", "* ", "• " — counted ONLY at the start of a line (start of text, or immediately after a newline plus optional indent) so a mid-sentence prose dash ("the gate holds - which surprised us") never counts as a marker (F1 review finding). */
  private static readonly ORPHAN_BULLET_RE = /(?:^|\n)[ \t]*[-*•](?=\s)/g;

  /** The old record's primary ruling fields, per type — the fields a ruling actually lives in, not provenance/rationale filler. Returned as SEPARATE field texts, not joined, so segmentation never straddles a field boundary (F2 review finding: a final unit used to run from a marker in one field into the next field's own text). */
  private static rulingSourceFields(record: DurableRecord): string[] {
    const r = record as unknown as Record<string, unknown>;
    const parts: unknown[] =
      record.type === 'decision'
        ? [r.title, r.statement]
        : record.type === 'anti_pattern'
          ? [r.title, r.trigger, r.guidance, r.wrong_way, r.right_way]
          : record.type === 'research_finding'
            ? [r.question, r.answer]
            : [];
    return parts.filter((v): v is string => typeof v === 'string');
  }

  /**
   * Enumerated ruling units — numbered or bulleted items — segmented from
   * `text`. Bullets count only at line-start (see ORPHAN_BULLET_RE). Numbered
   * markers count as an enumeration only when the FULL sequence of numbers
   * found in `text`, in order, forms an ascending run starting at 1 — "as of
   * step 2. ... fixed in phase 3." starts at 2 and is discarded WHOLE (not
   * partially), because a fragment of an unrelated list is not evidence of an
   * enumerated ruling. Fewer than 2 total markers (bullets plus a qualifying
   * numbered run) means the record makes no enumerated claim, so this returns
   * [].
   */
  private static segmentRulingUnits(text: string): string[] {
    const bulletRe = new RegExp(SterlingTools.ORPHAN_BULLET_RE.source, 'g');
    const bulletMarkers: { start: number; contentStart: number }[] = [];
    let bm: RegExpExecArray | null;
    while ((bm = bulletRe.exec(text))) {
      const bulletPos = bm.index + bm[0].length - 1;
      bulletMarkers.push({ start: bulletPos, contentStart: bulletPos + 1 });
    }

    const numberRe = new RegExp(SterlingTools.ORPHAN_NUMBER_RE.source, 'g');
    const numberMarkers: { start: number; contentStart: number; value: number }[] = [];
    let nm: RegExpExecArray | null;
    while ((nm = numberRe.exec(text))) {
      numberMarkers.push({ start: nm.index, contentStart: nm.index + nm[0].length, value: Number(nm[1] ?? nm[2]) });
    }
    const numbersAscendFromOne = numberMarkers.length > 0 && numberMarkers.every((mk, i) => mk.value === i + 1);

    const markers = [...bulletMarkers, ...(numbersAscendFromOne ? numberMarkers : [])].sort((a, b) => a.start - b.start);
    if (markers.length < 2) return [];
    return markers
      .map((mk, i) => text.slice(mk.contentStart, i + 1 < markers.length ? markers[i + 1].start : text.length).trim())
      .filter((u) => u.length > 0);
  }

  /** Every distinct content word (lowercase, alphanumeric, 4+ chars, not a stopword) in `text`. */
  private static contentWords(text: string): Set<string> {
    const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').match(/[a-z0-9]{4,}/g) ?? [];
    return new Set(words.filter((w) => !SterlingTools.ORPHAN_STOPWORDS.has(w)));
  }

  /** Every string value in `value`, recursively (arrays and plain objects) — "the combined text of fields". */
  private static flattenFieldStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) SterlingTools.flattenFieldStrings(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) SterlingTools.flattenFieldStrings(v, out);
    return out;
  }

  private static clipExcerpt(text: string, max = 160): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  /**
   * knowledge_supersede — atomic replacement of a ruling record (decision /
   * anti_pattern / research_finding), riding the existing store.supersede()
   * transaction (new row + CAS retire of the old row, no second supersession
   * path). Distinct from knowledge_update (a fix-forward DELTA within one
   * lineage — the caller passes only what changed) and knowledge_retire (a
   * no-new-row duplicate tombstone): `fields` here is a COMPLETE create-shaped
   * body of the same type, because this is a REPLACEMENT, not a patch.
   *
   * ORPHAN DETECTION (ADDENDUM 08-14-2045): the measured incident was a
   * decision recording three separable rulings, superseded by a record that
   * only restated one of them — the other two silently stopped being served.
   * When the old record's primary text enumerates 2+ ruling units (numbered or
   * bulleted), each unit must have substantive lexical coverage in the new
   * fields or the write is REFUSED, naming the orphaned excerpts and both
   * remedies. `orphans_acknowledged: true` proceeds anyway and the response
   * discloses which candidates were accepted. Fewer than 2 units is ordinary
   * single-ruling supersession — no check.
   *
   * Every refusal below runs before store.supersede is ever called, so a
   * refused call leaves the store untouched.
   */
  knowledgeSupersede(oldId: string, fields: Record<string, unknown>, orphansAcknowledged?: boolean): { superseded: string; id: string; type: string; slug?: string; orphan_candidates?: string[]; warnings: string[]; same_subject: SameSubjectEntry[] } {
    const old = this.resolveRecordId(oldId, 'knowledge_supersede');
    if (old.type === 'todo') {
      throw new Error(
        `knowledge_supersede: '${oldId}' is a todo — those leave through board_remove / maintenance_remove (done = removed, P4), not supersession.`
      );
    }
    if (old.type === 'feature_article' || old.type === 'reference_material') {
      throw new Error(
        `knowledge_supersede: '${oldId}' is a ${old.type} — those evolve in place via knowledge_update (fix-forward, same lineage), or for a genuine ` +
          `duplicate, knowledge_retire(id, in_favor_of). knowledge_supersede replaces decision / anti_pattern / research_finding only.`
      );
    }
    if (!SterlingTools.SUPERSEDE_ALLOWED_TYPES.includes(old.type)) {
      throw new Error(
        `knowledge_supersede: '${old.type}' records are not supported — allowed: ${SterlingTools.SUPERSEDE_ALLOWED_TYPES.join(', ')}.`
      );
    }
    if (old.status === 'superseded') {
      throw new Error(`knowledge_supersede: '${oldId}' is already superseded — resolve its chain to the live head first (knowledge_get discloses the terminus).`);
    }

    this.refuseServerOwnedFields(fields, 'knowledge_supersede');
    const type = old.type;
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, type: _t, ...body } = fields;

    // Slug continuity (decision de1a7329): fields with no slug inherit the old
    // record's slug so the concept handle survives the replacement — the old
    // record itself still owns that slug at this point (it is still active),
    // so its own id is excluded from the collision check.
    const explicitSlug = (body as { slug?: string }).slug;
    let slug: string | undefined;
    if (explicitSlug !== undefined) {
      const clash = this.store.recordsBySlug(explicitSlug).filter((r) => r.id !== old.id);
      if (clash.length) {
        throw new Error(
          `knowledge_supersede: a record with slug '${explicitSlug}' already exists ('${clash[0].id}') — one handle resolves to one record. ` +
            `Choose a distinct slug, or omit it to inherit '${(old as unknown as { slug?: string }).slug ?? ''}'.`
        );
      }
      slug = explicitSlug;
    } else {
      slug = (old as unknown as { slug?: string }).slug;
      // F4 review finding: an old record with NO slug (e.g. a pre-slug legacy
      // row) used to leave the new head slugless too — the same auto-mint
      // path knowledgeCreate takes for a slugless new record applies here,
      // so a replacement of a legacy record gains the stable handle it never
      // had, exactly as if it were freshly created.
      if (slug === undefined) {
        // THROUGH mintHeadlineOf, not a second inlined `title ?? question`
        // (review finding 2, 2026-08-29): that helper's contract is to be the
        // ONE place the per-type answer lives, and a copy here made the claim
        // false as shipped. The two agree for every type SUPERSEDE_ALLOWED_TYPES
        // currently admits, so this is a latent divergence rather than a live
        // defect — it would become one the moment a headline-less type (todo,
        // attestation) joined that list and this site kept minting from a
        // `title` those types do not have.
        slug = this.mintSlug(SterlingTools.mintHeadlineOf(type, body));
      }
    }

    const ts = this.now();
    const candidate: Record<string, unknown> = {
      id: this.newId(),
      type,
      created_at: ts,
      updated_at: ts,
      author: (body.author as string) ?? 'conductor',
      status: 'active',
      superseded_by: null,
      links: body.links ?? [],
      scope: (body.scope as string) ?? 'project',
      stack_tags: body.stack_tags ?? [],
      ...body,
      ...(slug !== undefined ? { slug } : {}),
    };
    // links[].target_id THROUGH THE LADDER (board 2e71d464), set AFTER the
    // `...body` spread above for the same reason as knowledgeCreate.
    candidate.links = this.resolveLinksTargets(candidate.links, 'knowledge_supersede') ?? [];
    this.refuseUnknownFields(type, candidate, 'knowledge_supersede');
    const registered = RECORD_TYPES[type as keyof typeof RECORD_TYPES];
    // RAW-ZOD LEAK INVENTORY (board a00689b9, site 1): this parse is directly
    // MCP-reachable and does not route through knowledgeUpdate, so it was
    // untouched by the original knowledge_create/append/edit fix (board
    // 03c92e2a). Caught and re-rendered the same way (renderValidationFailure)
    // rather than letting a bad field (e.g. a malformed history element) leak
    // the raw zod issue array.
    let parsed: Record<string, unknown>;
    try {
      parsed = registered ? (registered.schema.parse(candidate) as Record<string, unknown>) : candidate;
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, type, 'knowledge_supersede');
      throw err;
    }
    // Cited-id resolution warnings (board fc053051, F3 review finding: every
    // other write path emits these — knowledge_supersede was the one gap).
    // Computed on `parsed` (post-schema, pre-store) so a scan sees exactly
    // what is about to be written, same as knowledgeCreate (tools.ts:688).
    const citationWarnings = registered ? this.citedIdWarnings(registered.fts(parsed)) : [];

    // Orphan detection — deterministic, no model call (P3), scoped to the
    // measured defect shape (enumerated multi-ruling records).
    const units = SterlingTools.rulingSourceFields(old).flatMap((f) => SterlingTools.segmentRulingUnits(f));
    let orphanCandidates: string[] = [];
    if (units.length >= 2) {
      const fieldsWords = SterlingTools.contentWords(SterlingTools.flattenFieldStrings(fields).join(' '));
      const uncovered = units.filter((u) => {
        const unitWords = SterlingTools.contentWords(u);
        if (unitWords.size === 0) return false;
        let shared = 0;
        for (const w of unitWords) if (fieldsWords.has(w)) shared++;
        return shared / unitWords.size < SterlingTools.ORPHAN_COVERAGE_THRESHOLD;
      });
      if (uncovered.length > 0) {
        if (orphansAcknowledged !== true) {
          throw new Error(
            `knowledge_supersede: '${oldId}' enumerates ${units.length} ruling units and the replacement fields leave ${uncovered.length} of them ` +
              `without substantive coverage — a whole-record supersession would silently drop the surviving ruling(s), the exact failure this check ` +
              `exists to catch. Orphaned:\n` +
              uncovered.map((u) => `  - "${SterlingTools.clipExcerpt(u)}"`).join('\n') +
              `\nExtend fields to carry the surviving ruling(s) forward, or re-call with orphans_acknowledged:true to proceed and accept the loss.`
          );
        }
        orphanCandidates = uncovered.map((u) => SterlingTools.clipExcerpt(u));
      }
    }

    const chain = new Set<string>([old.id]);
    for (const link of (old.links ?? []) as { rel: string; target_id: string }[]) {
      if (link.rel === 'supersedes') chain.add(link.target_id);
    }
    const updated = this.store.supersede(old.id, parsed);
    this.repointPromotionReview(chain, updated.id, ts);

    // SAME-SUBJECT SURFACING (decision 7e3c66c5): knowledge_supersede only
    // ever operates on the three ruling types (SUPERSEDE_ALLOWED_TYPES,
    // enforced above), so this always applies here. Excludes the old,
    // just-superseded record and its own supersede chain, plus the new
    // record's own id — never the write's own lineage.
    const sameSubjectExclude = new Set(chain);
    sameSubjectExclude.add(updated.id);
    const sameSubject = this.sameSubjectDigest(registered ? registered.fts(parsed) : '', sameSubjectExclude);

    return {
      superseded: old.id,
      id: updated.id,
      type: updated.type,
      slug: (updated as unknown as { slug?: string }).slug,
      ...(orphanCandidates.length > 0 ? { orphan_candidates: orphanCandidates } : {}),
      warnings: citationWarnings,
      same_subject: sameSubject,
    };
  }

  // -- run protocol (§5.2, §10) -------------------------------------------------

  runState(runId?: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(runId ? `run_state: no run '${runId}'` : 'run_state: no active run');
    return run;
  }

  /**
   * The run wire's precondition, stated in the CALLER's terms (decision 391fae4f).
   * agent_exit / handoff_write / handoff_read all need a run, and all used to
   * inherit runState()'s bare 'run_state: no active run' — an error naming a tool
   * the agent never called, with no direction. Agent templates grant these tools
   * unconditionally (frontmatter is static, so they cannot be withheld per
   * session) and the agents' prompts tell them to exit through the wire, so in
   * conductor-direct mode every dispatched agent discovers this mid-task. A
   * consuming project measured eight agents doing it in one session, several
   * retrying with other signals and a fabricated run_id first, each ending with a
   * paragraph apologising for infrastructure. It stays a loud refusal rather than
   * a no-op success — a silent success here would let a PIPELINE agent's exit
   * vanish if a run ended mid-phase — but it now terminates the attempt instead
   * of starting a diagnosis.
   *
   * SOFTENED 2026-08-31 (board 1259802b, adopted Codex+conductor joint): the
   * REFUSAL SEMANTICS ARE UNCHANGED — still an error, still nothing recorded,
   * still the loud refusal decision 391fae4f deliberately kept over a silent
   * no-op. What changed is the TEXT. The measured residual was agents burning a
   * tool call AND THEN A PARAGRAPH on this in conductor-direct mode (~12
   * refusals in one consuming session), which is the shape of a message that
   * reads like a fault report: four sentences, a parenthetical tool inventory,
   * and a "do not retry" that invites an explanation of why you did. So the
   * message now opens by naming the outcome as EXPECTED, states the one action
   * (put the handoff in your final text and proceed), and says explicitly that
   * one line is enough — the cheapest fix tried first, before the bigger
   * mode-aware tool-availability surface the board still holds as option (b).
   */
  private requireWireRun(tool: string, runId?: string): RunRecord {
    // Keyed on "is any run active", NOT on "did the caller omit run_id"
    // (correctness review 2026-07-30). The measured failure includes agents
    // RETRYING WITH A FABRICATED run_id, and an earlier `!runId &&` conjunct let
    // exactly that case fall through to runState(runId)'s bare `no run '<made
    // up>'` — handing the direction-free error to the one behavior this guard
    // documents. With a run active the condition is false and a wrong run_id
    // still gets the ordinary `no run '<id>'`, so run-active refusals are
    // untouched.
    if (!this.store.getRun()) {
      throw new Error(
        `${tool}: no run is active — EXPECTED in CONDUCTOR-DIRECT mode, not a fault to diagnose. Nothing was recorded. ` +
          `Put the handoff in your final text and proceed: your final message IS your deliverable. ` +
          `One line about this is enough — do not narrate it, do not retry with another signal, and never invent a run_id.`
      );
    }
    return this.runState(runId);
  }

  /**
   * agent_exit — the exit wire, never prose: zod-validated against the signal
   * registry at the server; invalid signals are rejected in-band so the agent
   * sees the error and corrects itself (§5.2).
   */
  agentExit(args: { run_id?: string; phase_id: string; agent_role: string; signal: string; payload?: Record<string, unknown> }): {
    recorded: RecordedExit;
  } {
    const parsed = signalSchema.safeParse(args.signal);
    if (!parsed.success) {
      throw new Error(
        `agent_exit: '${args.signal}' is not a registered signal — the enum is closed: ${SIGNALS.join(' | ')}. Re-call agent_exit with a valid member.`
      );
    }
    if (parsed.data === 'agent-died') {
      throw new Error(
        "agent_exit: 'agent-died' is conductor-reported, never agent-emitted (§5.1) — the conductor maps abnormal Task returns via run_signal's exit parameter."
      );
    }
    const payloadCheck = SIGNAL_PAYLOADS[parsed.data].safeParse(args.payload ?? {});
    if (!payloadCheck.success) {
      throw new Error(
        `agent_exit: payload for '${parsed.data}' does not match its typed schema (§5.1): ${payloadCheck.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}. Correct the payload and re-call agent_exit.`
      );
    }
    const run = this.requireWireRun('agent_exit', args.run_id);
    // Phase validation at the RECORD seam (board 7d051522, incident 2026-07-03):
    // an exit naming a phase that is not on the run must fail HERE, loudly,
    // with nothing recorded — an orphan in the pending slot deadlocks the wire
    // (every later agent_exit refuses on the full slot and consume-exit cannot
    // resolve the phase). Conductor-direct subagents hit this when a run is
    // active: their deliverable is their final text, not a run exit.
    const namedPhase = run.phases.find((p) => p.id === args.phase_id);
    if (!namedPhase) {
      throw new Error(
        `agent_exit: no phase '${args.phase_id}' on run '${run.id}' — nothing was recorded. ` +
          `The run's phases: ${run.phases.map((p) => p.id).join(', ')}. A pipeline agent must exit against its dispatched phase; ` +
          `an agent working OUTSIDE the pipeline (conductor-direct) must not call agent_exit while a run is active — its final message is its deliverable.`
      );
    }
    // Phase CURRENCY, not just existence (audit finding 3/43): an exit naming a
    // real-but-not-current phase (e.g. an earlier already-complete phase) would
    // otherwise drive the brain to re-spawn that phase's successor and corrupt
    // phase state (two in_progress phases, or an early run completion). The
    // dispatched phase is always the in_progress one — refuse loud, nothing
    // recorded, naming the actual current phase.
    if (namedPhase.status !== 'in_progress') {
      const current = run.phases.find((p) => p.status === 'in_progress');
      throw new Error(
        `agent_exit: phase '${args.phase_id}' is '${namedPhase.status}', not the current (in_progress) phase — nothing was recorded. ` +
          `Exit against the dispatched phase${current ? ` '${current.id}'` : ' (none is currently in_progress — the run may be completing)'}. ` +
          `Naming a stale phase would corrupt phase state.`
      );
    }
    const exit: RecordedExit = {
      signal: parsed.data,
      payload: payloadCheck.data as Record<string, unknown>,
      phase_id: args.phase_id,
      agent_role: args.agent_role,
      at: this.now(),
    };
    this.store.recordPendingExit(run.id, exit);
    return { recorded: exit };
  }

  /**
   * run_signal — the brain computes the reaction from the stored exit (or the
   * conductor-reported one, e.g. agent-died{empty_output}) and the transition
   * is applied as a CAS on machine_state. The conductor executes exactly the
   * returned action.
   *
   * Exit routing (§5.2, run-proven r-0001): ABNORMAL exits arrive here
   * immediately from any position. Normal `complete` is PHASE-SCOPED — a
   * non-terminal step's complete (e.g. the test-writer's) is consumed by the
   * conductor as the next §8.1 step (scripts/consume-exit.mjs: recorded on
   * the run record via same-state CAS, clearing the pending-exit slot, audit
   * trail intact); run_signal receives `complete` only at the phase boundary,
   * where the brain advances the phase or starts the completion sequence.
   */
  runSignal(args: { run_id?: string; exit?: ResolvedExit } = {}): { action: BrainAction; machine_state: string; run_id: string } {
    const run = this.runState(args.run_id);
    // A conductor-supplied exit must NOT silently shadow-and-destroy a recorded
    // agent exit (audit finding 2/43): casTransition NULLs the pending slot
    // unconditionally, so if an agent already recorded (e.g. blocked) via
    // agent_exit and the conductor then reports agent-died{empty_output}, the
    // real exit would vanish and the brain react to the wrong signal. Refuse
    // loud, nothing consumed — the conductor consumes the recorded exit (no
    // args.exit) or investigates the mismatch (mirrors the 32fa4a05 pattern).
    if (args.exit) {
      const recorded = this.store.getPendingExit(run.id);
      if (recorded) {
        throw new Error(
          `run_signal: an explicit exit was supplied but run '${run.id}' already has a recorded agent exit ` +
            `(signal '${recorded.signal}', phase '${recorded.phase_id}'${recorded.agent_role ? `, role '${recorded.agent_role}'` : ''}) ` +
            `— refusing to overwrite it (nothing consumed). Call run_signal with NO exit to react to the recorded one, ` +
            `or resolve the mismatch (consume-exit) before reporting a different signal.`
        );
      }
    }
    const exit: ResolvedExit | undefined = args.exit ?? this.store.getPendingExit(run.id);
    if (!exit) {
      throw new Error(
        `run_signal: no exit recorded for run '${run.id}' — if the Task returned without an exit, report {signal: 'agent-died', payload: {observed: 'empty_output'}} (§5.2)`
      );
    }
    // The reaction depends only on machine_state + phases + the exit — none of
    // which hooks touch — so it is computed ONCE from the observed run and stays
    // valid across merge retries.
    const { action, nextState } = react(run, exit, {
      phase_death_cap: this.config.caps.phase_death_cap,
      research_resume_per_phase: this.config.caps.research_resume_per_phase,
    });
    const at = this.now(); // stamp once — the mutate may re-run on a merge retry
    // Apply the brain reaction onto the FRESH run body (audit findings 1/43, 18/43):
    // casTransitionMerge re-reads inside its retry loop, so a concurrent hook write
    // (H7 reconcile marks, H6/H8 escalations) is preserved instead of clobbered by
    // a stale-body rewrite. The phase/escalation edits are re-derived from `fresh`
    // (identical to the observed run — hooks change neither phases nor state).
    this.store.casTransitionMerge(run.machine_state, run.id, (fresh) => {
      const phases = fresh.phases.map((p) => ({ ...p, signals: [...p.signals] }));
      const idx = exit.phase_id ? phases.findIndex((p) => p.id === exit.phase_id) : phases.findIndex((p) => p.status === 'in_progress');
      if (idx !== -1) {
        phases[idx].signals.push({ signal: exit.signal, payload: exit.payload ?? null, agent_role: exit.agent_role ?? null, at });
        if (action.action === 'complete_run') phases[idx].status = 'complete';
        if (action.action === 'spawn' && !('respawn' in action && action.respawn)) {
          phases[idx].status = 'complete';
          const nextIdx = phases.findIndex((p) => p.id === (action as { phase_id: string }).phase_id);
          if (nextIdx !== -1) phases[nextIdx].status = 'in_progress';
        }
      }
      const escalations = [...fresh.escalations];
      if (action.action === 'judgment_needed' || action.action === 'halt') {
        escalations.push({ kind: action.action, reason: (action as { reason: string }).reason, at });
      }
      return { ...fresh, machine_state: nextState, phases, escalations };
    });
    return { action, machine_state: nextState, run_id: run.id };
  }

  /**
   * knowledge_link (§10): typed graph edge. Both endpoints resolve through the
   * shared contract (board slice 85ecfe43) before reaching store.addLink, so a
   * slug or citation prefix links the SAME record knowledge_get would show —
   * `to` keeps the 'target record' noun addLink's own target-not-found error
   * already used, so an unresolvable target still reads the way it always has.
   */
  knowledgeLink(from: string, rel: string, to: string): DurableRecord {
    const fromRecord = this.resolveRecordId(from, 'knowledge_link');
    const toRecord = this.resolveRecordId(to, 'knowledge_link', 'target record');
    return this.store.addLink(fromRecord.id, rel, toRecord.id);
  }

  /** run_escalate (§10): surface a judgment branch / typed escalation onto the run record. */
  runEscalate(payload: Record<string, unknown>): { run_id: string; escalations: number } {
    const run = this.runState();
    this.store.appendRunEscalation(run.id, { kind: 'escalation', payload, at: this.now() });
    const after = this.runState(run.id);
    return { run_id: run.id, escalations: after.escalations.length };
  }

  /**
   * maintenance_enqueue / maintenance_query (§10): the maintenance queue IS
   * the todo store filtered source=system (§3.2.7) — no second queue exists.
   */
  maintenanceEnqueue(args: { reason: string; text: string; file_keys?: string[]; feature_link?: string }): {
    record: DurableRecord;
    check_skipped: SkippedCheck[];
  } {
    return this.boardAdd({
      text: args.text,
      source: 'system',
      system_reason: args.reason,
      file_keys: args.file_keys,
      feature_link: args.feature_link,
    });
  }

  maintenanceQuery(
    filter: { system_reason?: string; file_keys?: string[]; contains?: string; feature_slug?: string; cap?: number; offset?: number } = {}
  ): DurableRecord[] {
    // system_reason is applied inside boardQuery BEFORE the cap (finding 33/43),
    // so a reason-filtered query no longer misses matches past the cap. contains
    // (work order d9960c98) and feature_slug (board e725979c) ride the same
    // boardFiltered pass for the same reason, and combine as a genuine AND.
    return this.boardQuery({
      source: 'system',
      system_reason: filter.system_reason,
      file_keys: filter.file_keys,
      contains: filter.contains,
      feature_slug: filter.feature_slug,
      cap: filter.cap,
      offset: filter.offset,
    });
  }

  /** The disclosed envelope for maintenance_query — the queue's own depth, stated (see boardQueryResult). */
  maintenanceQueryResult(
    filter: {
      system_reason?: string;
      file_keys?: string[];
      contains?: string;
      feature_slug?: string;
      cap?: number;
      offset?: number;
      projection?: BoardProjection;
    } = {}
  ): BoardQueryResult {
    return this.boardQueryResult({
      source: 'system',
      system_reason: filter.system_reason,
      file_keys: filter.file_keys,
      contains: filter.contains,
      feature_slug: filter.feature_slug,
      cap: filter.cap,
      offset: filter.offset,
      projection: filter.projection,
    });
  }

  // -- handoff pair (§10): transient, never enters the durable store -------------

  handoffWrite(args: { run_id?: string; handoff: unknown }): { written: true; phase_id: string } {
    const run = this.requireWireRun('handoff_write', args.run_id);
    // AC2: reviewer-role disposition coverage check (decision 628c4b7f, run r-d630, phase 2).
    // Placement mirrors the 32fa4a05 agent_exit off-run-phase guard: validate BEFORE persisting —
    // a refused write records NOTHING. Non-reviewer roles skip this check entirely.
    // The handoff is pre-parsed here for the guard only; schema validation still flows through
    // the store's writeHandoff (so malformed handoffs continue to surface as schema errors).
    const parsedForCheck = handoffSchema.safeParse(args.handoff);
    if (parsedForCheck.success && REVIEWER_ROLES.has(parsedForCheck.data.agent_role)) {
      const phaseId = parsedForCheck.data.phase_id;
      const mandatoryIds = new Set(
        (run.review_mandatory ?? []).filter((m) => m.phase_id === phaseId).map((m) => m.record_id)
      );
      const dispositionIds = new Set((parsedForCheck.data.dispositions ?? []).map((d) => d.record_id));
      const missing = [...mandatoryIds].filter((id) => !dispositionIds.has(id));
      const extra = [...dispositionIds].filter((id) => !mandatoryIds.has(id));
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing mandatory ids: ${missing.join(', ')}`);
        if (extra.length > 0) parts.push(`extra ids not in review_mandatory: ${extra.join(', ')}`);
        throw new Error(
          `handoff_write: reviewer '${parsedForCheck.data.agent_role}' disposition coverage mismatch — ${parts.join('; ')}. Nothing was written.`
        );
      }
    }
    // RAW-ZOD LEAK INVENTORY (board a00689b9, site 3): store.writeHandoff
    // re-parses the handoff against handoffSchema and throws the raw ZodError
    // across the store boundary — caught and re-rendered the same way as
    // board_update's/knowledge_supersede's own store-validation catch (958df5e),
    // rather than leaking the raw issue array on this caller-triggerable surface.
    try {
      const handoff = this.store.writeHandoff(run.id, args.handoff, this.now());
      return { written: true, phase_id: handoff.phase_id };
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, 'handoff', 'handoff_write');
      throw err;
    }
  }

  handoffRead(args: { run_id?: string; phase_id?: string; files?: string[] } = {}): unknown[] {
    const run = this.requireWireRun('handoff_read', args.run_id);
    // RAW-ZOD LEAK INVENTORY (board a00689b9, site 4): store.readHandoffs
    // re-parses each stored handoff body against handoffSchema — a malformed
    // or legacy row would otherwise leak the raw ZodError across the store
    // boundary the same way site 3's write path did.
    try {
      return this.store.readHandoffs(run.id, { phase_id: args.phase_id, files: args.files });
    } catch (err) {
      if (err instanceof ZodError) throw this.renderValidationFailure(err, 'handoff', 'handoff_read');
      throw err;
    }
  }
}

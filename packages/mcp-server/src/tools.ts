// Tool surface core (spec §10, spine subset §16.1 item 3) — plain functions so
// the logic is unit-testable; server.ts wires them to MCP. Coarse tools are
// safe because schemas are exact: every write revalidates at the store.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { normalizeRepoPath, signalSchema, SIGNALS, SIGNAL_PAYLOADS, parseConfig, RECORD_TYPES, REVIEWER_ROLES, handoffSchema, knownFieldsFor, unknownFieldsIn, schemaFor, digestRecord, type DurableRecord, type FieldShape, type RunRecord, type SessionEvent, type SterlingConfig } from '@sterling/schemas';
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
  cap?: number;
  projection?: Projection;
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

/** board_query / maintenance_query's disclosed envelope (see boardQueryResult). */
export interface BoardQueryResult {
  /** items matching the filter — EXACT here, unlike knowledge_query's rank-blind count */
  matched_filter: number;
  returned: number;
  cap: number;
  /** exact: more matched than were returned */
  capped: boolean;
  note?: string;
  /** full records, or their headline digests when projection:'digest' */
  records: DurableRecord[] | Record<string, unknown>[];
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
  records: Record<string, unknown>[];
  /** projection:'count' only, and only when multiple `types` were queried: the
   *  same uncapped, rank-blind count() split per queried type, alongside the
   *  combined `matched_filter` total (board fa19524d, AC2). */
  by_type?: Record<string, number>;
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
  matches: { id: string; type: string; title: string; matched_on: string[]; central: string[] }[];
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

  /** §16.1.9: unbuilt checks emit check_skipped where they would have run — never silent success. */
  private skip(check: string, runId: string | undefined): SkippedCheck {
    const skipped = { check, reason: 'not_built' };
    this.store.recordCheckSkipped(check, skipped.reason, runId, this.now());
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
    if (isAbsolute(mapped)) return { root: mapped, unresolved: false };
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
   * Every git failure is swallowed to undefined, which degrades to today's
   * behaviour — a deletion item. That direction is deliberate: a missing git, a
   * non-repo tree root, or a corrupt ref must not SUPPRESS a real deletion
   * finding, because the informational lane demands nothing and the reconcile
   * lane is the one that gets acted on.
   */
  private parkedOnRef(rel: string, treeRoot: string): string | undefined {
    const run = (args: string[]) => {
      try {
        return spawnSync('git', ['-C', treeRoot, ...args], { encoding: 'utf8', windowsHide: true });
      } catch {
        return undefined;
      }
    };
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
      if (has('HEAD')) return 'HEAD';
      const refs = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
      if (refs?.status !== 0 || typeof refs.stdout !== 'string') return undefined;
      const branches = refs.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, PARKED_REF_PROBE_CAP);
      const base = resolveBase();
      if (base === undefined) {
        for (const b of branches) if (has(b)) return b;
        return undefined;
      }
      for (const b of branches) {
        if (!has(b)) continue;
        if (b === base) return b; // case (a): base itself still has it
        if (isMergedIntoBase(b, base)) continue; // fully merged into base — not a park
        return b; // case (b): unmerged branch still holds it
      }
      return undefined;
    } catch {
      return undefined;
    }
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

  // -- knowledge CRUD ---------------------------------------------------------

  /**
   * Refuse a write that tries to ASSIGN a server-owned envelope key, instead of
   * stripping it in silence. The stripping itself is correct and stays (finding
   * 14/43 — a caller must not be able to forge an id, a clock, or a status); what
   * was wrong is that the caller was told the write succeeded.
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
  private refuseServerOwnedFields(
    fields: Record<string, unknown>,
    op: 'knowledge_create' | 'knowledge_update' | 'knowledge_append' | 'knowledge_supersede'
  ): void {
    const SERVER_OWNED = ['id', 'created_at', 'updated_at', 'status', 'superseded_by', 'type'];
    const attempted = SERVER_OWNED.filter((k) => k in fields);
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
          : `id and the clocks are assigned at write; type is fixed at create.`)
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
   * knowledge_schema — ask what a type requires instead of guessing (board
   * 7acfbe48). Read-only, derived from the registered zod schema, so it cannot
   * drift from what a write will actually accept. Listing the registered type
   * names on an unknown type is deliberate: the commonest reason to call this is
   * not knowing the vocabulary.
   */
  knowledgeSchema(type: string): { type: string; fields: FieldShape[]; required: string[]; optional: string[] } {
    const described = schemaFor(type);
    if (!described) {
      throw new Error(`knowledge_schema: '${type}' is not a registered record type. Registered: ${Object.keys(RECORD_TYPES).sort().join(', ')}.`);
    }
    // The split lists are redundant with `fields` on purpose — "what must I
    // supply" is the actual question, and making the reader filter the array to
    // answer it is how the guessing starts.
    return {
      type: described.type,
      fields: described.fields,
      required: described.fields.filter((f) => f.required).map((f) => f.name),
      optional: described.fields.filter((f) => !f.required).map((f) => f.name),
    };
  }

  knowledgeCreate(type: string, fields: Record<string, unknown>): CreateResult {
    this.refuseServerOwnedFields(fields, 'knowledge_create');
    const ts = this.now();
    // The envelope is SERVER-OWNED: strip these keys from caller fields before
    // assembling the candidate, so a caller cannot override id/timestamps/status/
    // superseded_by/type via `...fields` (audit finding 14/43 — e.g. status:
    // 'superseded' would create an already-invisible record). knowledgeUpdate
    // strips the identical set for the same reason.
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, type: _t, ...body } = fields;
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
    };
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
    const parsed = registered ? (registered.schema.parse(candidate) as Record<string, unknown>) : candidate;
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
      skipped.push(this.skip('noise-gate', this.activeRunId()));
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
      skipped.push(this.skip('dedup-merge', this.activeRunId()));
    } else {
      // dedup guarding is defined for anti_patterns and feature_article slugs;
      // other types skip loudly
      skipped.push(this.skip('dedup-merge', this.activeRunId()));
    }

    // STABLE HANDLES (board 1e639f32): decision / anti_pattern / research_finding
    // gain the slug feature_article and brief already had — the id re-mints on
    // every supersession, the slug names the CONCEPT and survives. Auto-minted
    // from the headline when absent (an auto-derived clash takes a -2/-3 suffix,
    // deterministic); an EXPLICIT slug that collides with ANY slug-bearing
    // record is refused loudly — same two-records-one-handle reasoning as the
    // feature_article branch above, across every type knowledge_get resolves.
    if (type === 'decision' || type === 'anti_pattern' || type === 'research_finding') {
      const explicit = (parsed as { slug?: string }).slug;
      if (explicit) {
        if (this.store.recordsBySlug(explicit).length) {
          throw new Error(
            `knowledge_create: a record with slug '${explicit}' already exists — one handle resolves to one record. ` +
              `Choose a distinct slug, or omit it to auto-derive a unique one.`
          );
        }
      } else {
        const headline = ((parsed as { title?: string; question?: string }).title ?? (parsed as { question?: string }).question ?? '') as string;
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
    const sameSubject = SterlingTools.SUPERSEDE_ALLOWED_TYPES.includes(type)
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
            const open = this.maintenanceQuery({ system_reason: 'refresh_reference', file_keys: [rel], cap: 1000 });
            if (open.length === 0) {
              this.maintenanceEnqueue({
                reason: 'refresh_reference',
                text: `refresh reference '${r.title}' — ${rel} changed on disk after source_date (out-of-band edit); refresh summary + source_date`,
                file_keys: [rel],
                feature_link: r.id,
              });
            }
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
        const drifts: { path: string; missing: boolean }[] = [];
        const parkedFiles: { path: string; ref: string }[] = [];
        // Owned bytes that actually exist — the evidence for the state check below.
        // Free here: the stat is already being taken for the drift comparison.
        let liveBytes = 0;
        for (const f of a.files ?? []) {
          const stat = statSync(join(treeRoot, f.path), { throwIfNoEntry: false });
          if (!stat) {
            // ABSENT FROM THE WORKING TREE IS NOT THE SAME AS DELETED (board
            // 1d6a721a). Every check here evaluates the CHECKED-OUT tree, so a
            // file parked on an unmerged branch read as an out-of-band deletion
            // — and that item could never be closed, because the trigger is
            // absence and no write makes a file appear. It re-fired on every
            // subsequent read (this arm is a pure function of disk state), which
            // pushed a drain toward exactly the no-op version bumps the closing
            // rule calls drift. Ask git before concluding anything: `ls` proves
            // working-tree absence and nothing else.
            const ref = this.parkedOnRef(f.path, treeRoot);
            if (ref) {
              parkedFiles.push({ path: f.path, ref });
              continue; // the article is CORRECT — the path returns on merge
            }
            drifts.push({ path: f.path, missing: true });
            continue;
          }
          liveBytes += stat.size;
          // mtime newer than updated_at is the cheap pre-filter; confirm a real
          // content change against the baseline before flagging, so a git
          // merge/checkout's mtime reset is not mistaken for an out-of-band edit.
          // A registered generated projection never content-flags — every regen
          // changes it by design and the merge gate's check-projection-fresh
          // guards its currency; its DELETION still lands in the missing arm above.
          if (stat.mtimeMs > Date.parse(record.updated_at) && !this.isGeneratedProjection(f.path) && this.contentChanged(f.path, a.file_baselines, treeRoot)) {
            drifts.push({ path: f.path, missing: false });
          }
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
            this.maintenanceEnqueue({
              reason: 'reconcile_needed',
              text:
                (d.missing
                  ? `reconcile article '${a.slug}' — owned file ${d.path} no longer exists (out-of-band deletion)`
                  : `reconcile article '${a.slug}' — owned file ${d.path} changed on disk after the article's last update (out-of-band edit)`) + disclaimed,
              file_keys: [d.path],
              feature_link: a.id,
            });
          }
          if (drifts.length > DRIFT_ITEMS_PER_READ) {
            // Never truncate SILENTLY (P5): the remainder is named on the item
            // that did land, so a reader knows the queue is a floor here.
            this.maintenanceEnqueue({
              reason: 'reconcile_needed',
              text:
                `reconcile article '${a.slug}' — ${drifts.length} owned files drifted in one read; ` +
                `the first ${DRIFT_ITEMS_PER_READ} have their own items and the remainder (${drifts
                  .slice(DRIFT_ITEMS_PER_READ)
                  .map((d) => d.path)
                  .join(', ')}) are covered by this one. A drift this wide usually means a whole-area change — reconcile the article as a whole.`,
              file_keys: drifts.slice(DRIFT_ITEMS_PER_READ).map((d) => d.path),
              feature_link: a.id,
            });
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
  knowledgeAppend(id: string, field: string, entries: unknown[], resolves?: string[]): { record: DurableRecord; warnings: string[] } {
    const old = this.resolveRecordId(id, 'knowledge_append');
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
    const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [field]: next }, resolves));
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
  ): { record: DurableRecord; replaced: { field: string; chars_before: number; chars_after: number }; warnings: string[] } {
    const old = this.resolveRecordId(id, 'knowledge_edit');
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
      const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [base]: nextArr }, resolves));
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
    const { record } = this.splitSameSubject(this.knowledgeUpdate(old.id, { [field]: next }, resolves));
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
    const { history: _h, ...body } = record as unknown as Record<string, unknown>;
    const size = JSON.stringify(body).length;
    const threshold = this.config.article_oversize_chars;
    if (size <= threshold) return [];
    const a = record as unknown as { slug: string; files?: { path: string }[] };
    const remedy =
      'split it (one feature_article per concept FAMILY — the concept-article granularity rubric; a sub-concept splits out only when it accrues its own intent + interactions distinct from the parent) ' +
      'or, for future writes, use knowledge_edit (string fields) / knowledge_append (array fields) instead of a full knowledge_update retransmit.';
    const text = `article '${a.slug}' non-history body is ${size} chars, over the ${threshold}-char article_oversize_chars threshold — ${remedy}`;
    const fileKeys = (a.files ?? []).map((f) => f.path);
    // Dedup on the SLUG, here at the site that owns the text format (board
    // 3acb0126): the generic enqueue dedup keys on the exact sorted file set,
    // and a reconcile that legitimately grows files[] changes that key and
    // mints a duplicate — measured 2026-08-11, contradicting decision
    // 86216751's refreshes-in-place contract. The slug is the one handle
    // stable across versions AND files[] changes; the closing quote in the
    // marker keeps a slug from prefix-matching a longer sibling.
    const marker = `article '${a.slug}'`;
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
    resolves?: string[]
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
    const { record, same_subject } = this.splitSameSubject(this.knowledgeUpdate(id, body, resolves));
    const warnings: string[] = before ? this.historyRotationWarnings(this.attemptedHistoryLen(before, body), record) : [];
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
      return { ...(result as Record<string, unknown>), record: digestRecord((result as { record: unknown }).record as Record<string, unknown>) };
    }
    return digestRecord(result as unknown as Record<string, unknown>);
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
      records: records.map((r) => (projection === 'digest' ? digestRecord(r as unknown as Record<string, unknown>) : this.projectForQuery(r))),
    };
  }

  /**
   * "Does the store govern this subject?" — asked BEFORE dispatching, rather
   * than discovering a governing record only after a subagent has already gone
   * wrong (H20/H19 relevance slice 4b). Reuses the SAME axis extraction +
   * stage-2 centrality floors H20 already applies at delivery time. Since
   * board 39c3d762 the candidate surface spans all four governing types —
   * anti_pattern, decision, feature_article (territory = slug/family/title),
   * research_finding (subject = question) — because the two missing types made
   * an article-governed question answer 'nothing governs this', a false
   * negative dressed as a verdict; and the no-match verdict is 'ungoverned'
   * (renamed from 'ready', whose query-envelope reading is the opposite).
   */
  knowledgePreflight(text: string): KnowledgePreflightResult {
    const terms = extractAxisTerms(text, MAX_RANK_TERMS);
    if (terms.length < AXIS_MIN_HITS) {
      return { answerability: 'insufficient', reason: 'too_little_vocabulary', terms, matches: [] };
    }
    const matches = this.axisCandidateMatches(text, terms).map(({ record, hits }) => ({
      id: record.id,
      type: record.type,
      // research_finding carries no title — its question IS the identity;
      // an article's slug beats its long title as the handle.
      title: SterlingTools.axisRecordTitle(record),
      matched_on: hits,
      central: recordCentralityHits(record, text),
    }));
    return { terms, matches, answerability: matches.length ? 'verify_targets' : 'ungoverned' };
  }

  /**
   * The candidate-matching CORE shared by knowledgePreflight and same-subject
   * surfacing on write (decision 7e3c66c5) — the four preflight axis floors
   * (extractAxisTerms already run by the caller -> store.query the four
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
    return { ...rest, links: semantic, ...(supersedesCount > 0 ? { supersedes_count: supersedesCount } : {}) };
  }

  /** The citation format the repo actually writes: 8-char id prefixes. */
  private static readonly CITATION_PREFIX_LEN = 8;

  /** Kebab-case a record headline into its auto-minted slug (board 1e639f32). */
  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '');
  }

  /**
   * Auto-mint a slug from a headline (title, or question for
   * research_finding), suffixing -2/-3/... on collision. Returns undefined
   * when the headline slugifies to nothing (blank/symbols-only headline).
   * Shared by knowledgeCreate (a new record with no explicit slug) and
   * knowledge_supersede (F4 review finding: a slugless old record — e.g. a
   * pre-slug legacy row — must not silently produce a slugless new head; it
   * mints exactly the same way a brand-new create would).
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
   */
  knowledgeGet(id: string): DurableRecord {
    let record: DurableRecord;
    try {
      record = this.resolveRecordId(id, 'knowledge_get');
    } catch (err) {
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
    if (record.status !== 'superseded') return record;
    const terminus = this.store.resolveTerminus(record.id);
    if (!terminus) return record;
    return { ...record, terminus } as DurableRecord & { terminus: typeof terminus };
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
    const hits = this.store.recordIdIndex().filter((r) => r.id.startsWith(id));
    if (hits.length === 0) throw new UnresolvedIdentifierError(`${toolName}: no ${noun} '${id}' in the project store or any mounted domain, at any status — and no slug matches`);
    if (hits.length > 1) {
      // NOT an UnresolvedIdentifierError: the prefix matched multiple records
      // — an ambiguity between real hits, not a miss. Must reach the caller
      // unchanged, same reasoning as the slug-collision throw above.
      throw new Error(
        `${toolName}: '${id}' is ambiguous — it prefixes ${hits.length} records: ${hits
          .map((r) => `${r.id} (${r.type}, ${r.status})`)
          .join('; ')}. Cite more of the id.`
      );
    }
    const record = this.store.get(hits[0].id);
    // The index and the bodies come from the same rows, so a hit with no body is
    // a torn store, not a miss — say which it is rather than reporting "no record".
    // NOT an UnresolvedIdentifierError: the index DID resolve the id; the
    // inconsistency is in the store, not the citation.
    if (!record) throw new Error(`${toolName}: index resolved '${id}' to '${hits[0].id}' but no body was stored — the store is inconsistent`);
    return record;
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

  private citedIdWarnings(text: string): string[] {
    if (!text) return [];
    const index = this.store.recordIdIndex();
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const match of text.matchAll(SterlingTools.CITATION_RE)) {
      const cited = match[1];
      const lower = cited.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const resolves = index.some((r) => r.id.toLowerCase().startsWith(lower));
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
   */
  private validateResolveClaim(id: string, chain: Set<string>): DurableRecord {
    const record = this.store.get(id);
    if (!record) {
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
      throw new Error(`resolves: names '${id}', which does not exist as a maintenance item; nothing was written.`);
    }
    const it = record as unknown as { type: string; source?: string; system_reason?: string; feature_link?: string };
    if (it.type !== 'todo' || it.source !== 'system') {
      throw new Error(`resolves: names '${id}', which is not a system maintenance-queue item; nothing was written.`);
    }
    if (it.system_reason !== 'reconcile_needed' && it.system_reason !== 'refresh_reference') {
      throw new Error(
        `resolves: names '${id}' (${it.system_reason ?? 'unknown'} lane) — only reconcile_needed and refresh_reference items ` +
          `close via resolves; every other lane, including promotion_review, closes only through its own mechanism. Nothing was written.`
      );
    }
    if (it.feature_link === undefined || !chain.has(it.feature_link)) {
      throw new Error(
        `resolves: names '${id}', whose feature_link does not match this record or any of its supersedes-chain ancestors; nothing was written.`
      );
    }
    return record;
  }

  /**
   * Open reconcile_needed/refresh_reference debt still standing on `chain`
   * after a write — one line per item (id + text prefix), never the whole
   * item (decision 68988832). Called AFTER the write, so any item this same
   * write's `resolves` claimed is already gone from maintenanceQuery and
   * never appears here; empty when nothing is owed (P1 — a clean write stays
   * clean).
   */
  private openReconcileLaneWarnings(chain: Set<string>): string[] {
    const warnings: string[] = [];
    const sweepCap = 1000;
    const items = this.maintenanceQuery({ cap: sweepCap });
    for (const item of items) {
      const it = item as unknown as { id: string; feature_link?: string; system_reason?: string; text?: string };
      if (
        (it.system_reason === 'reconcile_needed' || it.system_reason === 'refresh_reference') &&
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
        `the open-reconcile-lane sweep hit its ${sweepCap}-item cap — more open reconcile_needed/refresh_reference debt may exist past this window; narrow with maintenance_query to confirm.`
      );
    }
    return warnings;
  }

  /** Versioned change (§10): new version + supersede prior. Never mutates in place. */
  knowledgeUpdate(id: string, body: Record<string, unknown>, resolves?: string[]): DurableRecord & { same_subject?: SameSubjectEntry[] } {
    const old = this.resolveRecordId(id, 'knowledge_update');
    this.refuseServerOwnedFields(body, 'knowledge_update');
    const ts = this.now();
    const { id: _i, status: _s, superseded_by: _sb, created_at: _c, updated_at: _u, type: _t, ...overrides } = body;
    // Same refusal as create, applied to the CALLER's fields rather than the
    // merged record: `old` is already valid, so anything unknown came from this
    // call. Without it the merge silently discarded the field and reported a new
    // version — the failure that makes a "fix" look applied when it never landed.
    this.refuseUnknownFields(old.type, overrides);
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
    const next: Record<string, unknown> = {
      ...old,
      ...overrides,
      id: this.newId(),
      type: old.type,
      created_at: ts,
      updated_at: ts,
      status: 'active',
      superseded_by: null,
    };
    if (old.type === 'feature_article' && body.version === undefined) {
      next.version = (old as { version: number }).version + 1;
    }
    // History rotation (board 0697c6bd): bound the stored history to genesis +
    // newest entries. The middle is dropped from THIS version only — the version
    // being superseded right here retains them forever, so the supersede chain
    // is the archive and no entry ever becomes unreadable. Callers see the
    // rotation via historyRotationWarnings on the write's result envelope.
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
    const updated = this.store.supersede(old.id, next);
    // EXPLICIT-RESOLVES CLOSURE (decision 68988832-2ef5-4ff3-b693-4f0f0ea8dae1;
    // board 68fe8373): drain EXACTLY the named+validated items, through the
    // SAME drain-log path maintenance_remove uses, so maintenance_remove later
    // answers already_drained:true. The old implicit chain-based auto-drain
    // (decision 8ecd435f — every open reconcile_needed/refresh_reference item
    // on the chain, discharged by ANY write, no claim required) is REMOVED: a
    // write that does not name an item leaves it open, however tightly linked.
    for (const claim of claims) {
      this.store.remove(claim.id, ts);
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
    if (SterlingTools.SUPERSEDE_ALLOWED_TYPES.includes(old.type)) {
      const registered = RECORD_TYPES[old.type as keyof typeof RECORD_TYPES];
      const excludeIds = new Set(chain);
      excludeIds.add(updated.id);
      const sameSubject = this.sameSubjectDigest(registered ? registered.fts(next) : '', excludeIds);
      return { ...updated, same_subject: sameSubject };
    }
    return updated;
  }

  /**
   * promotion_review stays a human gate (P1) — a supersession never DRAINS it,
   * it is not the review being paid. But leaving its feature_link pointed at a
   * now-superseded id STRANDS it silently (todo 6202a0f5): the review is still
   * owed, same lineage, so RE-POINT rather than drop. In-place via updateTodo
   * (no new version, no id churn) so every other reference to the item survives.
   *
   * Shared by knowledgeUpdate (decision 01f31039) and knowledge_supersede
   * (decision e17794ea) — both mint a new id for the same lineage, so both owe
   * the same re-point. `chain` is every id this supersession's target answers
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
   */
  knowledgePromote(id: string, domain: string): { promoted: DurableRecord; retired: string; drained_review: string | null } {
    const original = this.store.get(id);
    if (!original) throw new Error(`knowledge_promote: no record '${id}'`);
    if (original.status !== 'active') throw new Error(`knowledge_promote: record '${id}' is not active (status ${original.status})`);
    if (original.scope !== 'project') throw new Error(`knowledge_promote: record '${id}' is ${original.scope} — only project-scoped records promote`);
    const UNPROMOTABLE = ['feature_article', 'todo'];
    if (UNPROMOTABLE.includes(original.type)) {
      throw new Error(`knowledge_promote: ${original.type} never promotes — feature_article is always project (§3.3); todo is a project surface`);
    }
    const ts = this.now();
    // copy content; the envelope (id/clocks/status/scope/links) is rebuilt for the domain
    const { id: _i, created_at: _c, updated_at: _u, status: _s, superseded_by: _sb, scope: _sc, links: _l, ...content } = original as unknown as Record<string, unknown>;
    const promoted = this.store.create({
      ...content,
      id: this.newId(),
      created_at: ts,
      updated_at: ts,
      status: 'active',
      superseded_by: null,
      scope: `domain:${domain}`,
      links: [{ rel: 'informed_by', target_id: id }],
    });
    // tombstone the project original, pointing forward to the promoted copy —
    // 'promoted' (not the default 'retired') so the activity feed names this
    // for what it is (board 39d6462d)
    this.store.retireInFavorOf(id, promoted.id, ts, 'promoted');
    const review = this.maintenanceQuery({ system_reason: 'promotion_review', cap: 1000 }).find(
      (t) => (t as { feature_link?: string }).feature_link === id
    );
    if (review) this.store.remove(review.id, ts);
    return { promoted, retired: id, drained_review: review?.id ?? null };
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
  private appendSessionEvents(entries: { kind: SessionEvent['kind']; detail: string }[]): { at: string } {
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
    for (const e of entries) events.push({ ...e, at });
    writeFileSync(eventsPath, JSON.stringify(events));
    return { at };
  }

  /** no_capture (§10): the explicit nothing-durable-was-learned declaration (board 7bbec3bd shape, MCP-served since board 75b1a05f). */
  noCapture(reason: string): { declared: string; at: string } {
    if (!reason || !reason.trim()) {
      throw new Error(`no_capture: 'reason' is required — a false declaration is drift, so say why there is nothing durable`);
    }
    const { at } = this.appendSessionEvents([{ kind: 'no_capture', detail: reason }]);
    return { declared: reason, at };
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

  boardAdd(args: Record<string, unknown>): CreateResult & { notice?: string } {
    const { text, source, objective, ...rest } = args;
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
    const res = this.knowledgeCreate('todo', {
      text,
      source,
      ...(normalized !== undefined ? { objective: normalized } : {}),
      ...rest,
    });
    if (source === 'user' && objective === undefined) {
      // Never a throw on the capture path — the item is saved; the default is
      // disclosed loudly with its remedy (decision a8d2ce6c: the server has no
      // caller identity, so a refusal could lose a user-stated task).
      return {
        ...res,
        notice: `objective undeclared — saved as standalone; if this task is a slice of a larger objective, set it via board_update {objective: "<name>"}`,
      };
    }
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
    if (filter.feature_slug !== undefined) {
      const chain = this.articleChainIds(filter.feature_slug);
      filtered = chain ? filtered.filter((t) => chain.has((t as { feature_link?: string }).feature_link ?? '')) : [];
    }
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

  boardQuery(filter: BoardFilter = {}): DurableRecord[] {
    return this.boardFiltered(filter).matching.slice(0, filter.cap ?? DEFAULT_BOARD_CAP);
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
    const records = matching.slice(0, cap);
    const capped = records.length < matching.length;
    const projection = filter.projection ?? 'full';
    const notes: string[] = [];
    if (capped) {
      notes.push(
        `cap reached — showing ${records.length} of ${matching.length} matching items; raise cap to see the rest (a drain that stops at the cap leaves the tail behind)` +
          (projection === 'full' ? `, or re-run with projection:"digest" for one-line items (board items run to several KB of text each)` : '')
      );
    }
    if (scanTruncated) {
      notes.push(`the underlying todo scan hit its ${BOARD_SCAN_CAP}-record ceiling, so matched_filter is a FLOOR, not a total`);
    }
    return {
      matched_filter: matching.length,
      returned: records.length,
      cap,
      capped,
      ...(notes.length ? { note: notes.join('; ') } : {}),
      records: projection === 'digest' ? records.map((r) => digestRecord(r as unknown as Record<string, unknown>)) : records,
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
  private static readonly BOARD_UPDATABLE_FIELDS = ['text', 'priority', 'file_keys', 'objective'] as const;

  boardUpdate(id: string, patch: Record<string, unknown>): DurableRecord {
    const old = this.store.get(id);
    if (!old) throw new Error(`board_update: no record '${id}'`);
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
    const next = { ...old, ...patch, updated_at: this.now() } as Record<string, unknown>;
    // 'standalone' clears the grouping to absent (decision a8d2ce6c) — the same
    // sentinel board_add takes, so re-grouping and un-grouping share one vocabulary.
    if (next.objective === 'standalone') delete next.objective;
    return this.store.updateTodo(id, next as typeof old);
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
    const record = this.resolveRecordId(id, 'board_get');
    if (record.type !== 'todo') {
      throw new Error(
        `board_get: '${id}' resolves to a ${record.type}, not a board/queue item — board_get reads board_add/maintenance_enqueue items only; use knowledge_get for other record types`
      );
    }
    return record;
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
  private removalArtifactEvidence(item: DurableRecord): { artifact_evidence: Record<string, unknown>[]; note?: string } | { check_skipped: SkippedCheck[] } {
    const fileKeys = ((item as unknown as { file_keys?: string[] }).file_keys ?? []).filter(Boolean);
    if (fileKeys.length === 0) {
      // No file identity to join on — the check cannot run, and says so
      // (P5: a skipped check is loud, never a silent no-op).
      const skipped = { check: 'board-remove-artifact-binding', reason: 'no_file_keys' };
      this.store.recordCheckSkipped(skipped.check, skipped.reason, this.activeRunId(), this.now());
      return { check_skipped: [skipped] };
    }
    const since = item.created_at;
    // Scan WIDE, filter by since, THEN trim the receipt (review finding 12,
    // 2026-08-09 — the same pre-cap/post-cap ordering hazard as audit finding
    // 33/43): the store orders by file-key-overlap count first and updated_at
    // only as a tiebreak, so a small cap on a well-documented area fills with
    // old high-overlap records and pushes the one NEW artifact out — and this
    // receipt would then accuse the operator of drift that never happened.
    // 200 is a bounded scan, not a guarantee; past it the disclosure errs
    // toward the scanned window and never blocks either way.
    const evidence = this.store
      .query({
        types: ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'reference_material'],
        file_keys: fileKeys,
        cap: 200,
      })
      .filter((r) => r.created_at >= since || r.updated_at >= since)
      .slice(0, 25)
      .map((r) => digestRecord(r as unknown as Record<string, unknown>));
    return {
      artifact_evidence: evidence,
      ...(evidence.length === 0
        ? {
            note:
              `no fulfilling artifact-write found touching this item's file_keys since it was created — removed on the operator's word. ` +
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
   */
  private removedItemError(op: string, id: string): Error {
    const trace = this.store.drainLogEntry(id);
    if (trace) {
      return new Error(
        `${op}: item '${id}' was ALREADY REMOVED at ${trace.drained_at} (${trace.system_reason || 'user item'}, per the drain log) — ` +
          `most likely auto-drained by a knowledge_update re-baseline or closed by an earlier remove. Nothing further to do.`
      );
    }
    return new Error(
      `${op}: no record '${id}', and no trace of it in the drain log (which keeps the newest 50 removals) — ` +
        `either the id is wrong, or the item was removed long enough ago that its trace aged out.`
    );
  }

  boardRemove(id: string): { removed: string; artifact_evidence?: Record<string, unknown>[]; note?: string; check_skipped?: SkippedCheck[] } {
    const record = this.store.get(id);
    if (!record) throw this.removedItemError('board_remove', id);
    if (record.type !== 'todo') throw new Error(`board_remove: '${id}' is a ${record.type}, not a task`);
    const evidence = this.removalArtifactEvidence(record);
    this.store.remove(id, this.now()); // system todos land in the §3.2.7 drain log
    return { removed: id, ...evidence };
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
    const record = this.store.get(id);
    if (!record) {
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
    this.store.remove(id, this.now()); // logged to the §3.2.7 drain log, as every system removal is
    return { removed: id, ...evidence };
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
    const survivor = this.store.get(inFavorOf);
    if (!survivor) {
      throw new Error(
        `knowledge_retire: no record '${inFavorOf}' to retire in favour of. The survivor must exist first — ` +
          `retiring into a void leaves the reader nowhere to go, which is the failure this tool exists to prevent.`
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
    const retired = this.store.retireInFavorOf(record.id, inFavorOf, this.now());
    return { retired };
  }

  // -- knowledge_supersede (decision e17794ea, board 0b33c27b) ----------------

  /** old-record types knowledge_supersede accepts — see the class comment above. */
  private static readonly SUPERSEDE_ALLOWED_TYPES = ['decision', 'anti_pattern', 'research_finding'];

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
        const headline = ((body as { title?: string; question?: string }).title ?? (body as { question?: string }).question ?? '') as string;
        slug = this.mintSlug(headline);
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
    this.refuseUnknownFields(type, candidate, 'knowledge_supersede');
    const registered = RECORD_TYPES[type as keyof typeof RECORD_TYPES];
    const parsed = registered ? (registered.schema.parse(candidate) as Record<string, unknown>) : candidate;
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
        `${tool}: no run is active, so there is no handoff wire to write to — nothing was recorded. ` +
          `This is CONDUCTOR-DIRECT mode, not a fault to diagnose: ${tool} and its siblings (agent_exit, handoff_write, handoff_read) ` +
          `work only inside a pipeline run. Your final message IS your deliverable — report your findings in prose and stop. ` +
          `Do not retry with another signal, and never invent a run_id.`
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

  maintenanceQuery(filter: { system_reason?: string; file_keys?: string[]; contains?: string; feature_slug?: string; cap?: number } = {}): DurableRecord[] {
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
    });
  }

  /** The disclosed envelope for maintenance_query — the queue's own depth, stated (see boardQueryResult). */
  maintenanceQueryResult(
    filter: { system_reason?: string; file_keys?: string[]; contains?: string; feature_slug?: string; cap?: number; projection?: Projection } = {}
  ): BoardQueryResult {
    return this.boardQueryResult({
      source: 'system',
      system_reason: filter.system_reason,
      file_keys: filter.file_keys,
      contains: filter.contains,
      feature_slug: filter.feature_slug,
      cap: filter.cap,
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
    const handoff = this.store.writeHandoff(run.id, args.handoff, this.now());
    return { written: true, phase_id: handoff.phase_id };
  }

  handoffRead(args: { run_id?: string; phase_id?: string; files?: string[] } = {}): unknown[] {
    const run = this.requireWireRun('handoff_read', args.run_id);
    return this.store.readHandoffs(run.id, { phase_id: args.phase_id, files: args.files });
  }
}

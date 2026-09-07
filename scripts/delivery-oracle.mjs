#!/usr/bin/env node
// DELIVERY ORACLE — layer 1, the STORE-TO-HOOK CONFORMANCE AUDIT (board
// a6b118e4, objective knowledge-delivery-oracle; article 'delivery-oracle').
//
// It derives, FROM THE STORE, what knowledge delivery SHOULD happen for every
// governed path, drives the BUNDLED hooks (hooks/*.mjs — the surface the
// platform actually executes) with synthesized stdin payloads inside a
// throwaway sandbox project, reads back all three delivery channels (stdout
// hookSpecificOutput.additionalContext, the transient/delivery/pending.json
// queue plus its UserPromptSubmit drain, and stderr+exit), and scores per-hook
// recall/precision into a repeatable JSON report.
//
// WHAT IT MEASURES, AND WHAT IT CANNOT (disclosed, not buried): it observes
// what a hook WRITES, never what reached an agent — H19 may only enqueue for a
// later drain, H20's context goes to the dispatching conductor, active-run
// subagents make H19 deliberately silent. A green run can coexist with broken
// platform injection; layer 3 (live subagent acceptance probe) owns that half.
//
// HOOKS MIRRORED, exactly: h19-knowledge-delivery (file-touch),
// h19-bash-delivery (pointer surface), h19-delivery-drain (the queue's second
// half), h10-direct-capture (ownership agreement only), h20-mechanism-axis
// (the frozen probes) and h23-output-axis (board 5d462868 closure). H23's
// predicate is CONTENT-matched (axis terms extracted from tool_response, the
// same three relevance floors, a centrality check) rather than path-matched, so
// deriveExpected mirrors it only when the caller supplies `outputAxisProbes`
// ({rel, tool, tool_response, agent_id?}[]) — a cheap silence-only arm was
// rejected because H23 is silent for at least eight different reasons (an
// unsupported tool, an agent-scoped call, no tool_response, an excluded path,
// owned-path suppression, no term match, dedup, the pointer cap) and a
// verdict that cannot tell them apart is exactly the multiply-caused silence
// anti_pattern 1b141d1f warns about; `expected_reason` ('unsupported_tool' |
// 'agent_id_present' | 'no_tool_response' | 'path_excluded' |
// 'owned_suppressed' | 'below_axis_floor') names which of the six
// STORE-DERIVABLE silence causes applies (dedup and the pointer cap stay
// h23-output-axis.mjs's own frozen suite's concern, never re-derived here —
// board f1e056bd item 3 closed the other two, which this mirror omitted
// entirely until now). The content a real Read/Bash call
// would have returned cannot be reconstructed from the store alone, so a live
// `--project` run with no probes supplied drives zero h23-output-axis cases
// today — the arm itself is fully exercised by
// scripts/tests/delivery-oracle.test.mjs groups J-N; wiring main() to a real
// probe source is a separate, later follow-up.
//
// TWO STANDING LIMITS OF THIS ARM, both gating that follow-up (review 2026-09-06):
//   (1) THE VERDICT IS NOT CAP-AWARE. deriveOutputAxisExpected names every
//       matching record while the live hook renders at most
//       OUTPUT_AXIS_POINTER_CAP = 1 pointer plus a "(+N more matched)" tail
//       (decision h23-kept-raised-threshold-one-pointer-payload, 284fc4b0), and
//       run()'s `covers` is a bare `expected_ids.every(...)`. A probe matching
//       2+ records would therefore score a permanent FALSE MISS against a hook
//       behaving exactly as ruled. Latent only because main() supplies no
//       probes; wiring a probe source REQUIRES a cap-aware verdict first
//       (covered up to the cap, with parseDelivery's per-entry
//       `suppressed_count` reconciling the remainder).
//   (2) THE OUTPUT-AXIS DEDUP SEED IS HALF-WIRED, DELIBERATELY. resetSandbox
//       honours `seed_output_axis_guard` (pinned by group N1), but nothing in
//       run()/loadProbes can set it, because no output_axis case reaches run()
//       yet. It is kept, not deleted: it is the reset half of the same
//       probe-wiring follow-up, and its contract mirrors seed_ledger's. Wiring
//       it needs a seeder for guard-conductor.json's `output_axis` field and a
//       case source that sets the flag — both belong with the probe work, not
//       ahead of it.
//
// GITIGNORE is MIRRORED, not applied wholesale (pins A5/A5b/A5c/A5d, re-cut
// after an outside-family review read the hook sources). An OWNED path that git
// ignores still gets its full h19-knowledge-delivery case AND its
// h19-bash-delivery case, resolving the same owners a non-ignored sibling
// would: neither hook gates owner resolution on the ignore check
// (h19-knowledge-delivery.mjs:~115 applies it ONLY to the unowned-frontier
// decision; h19-bash-delivery.mjs:~81 has no ignore check at all). The check
// still runs and its result rides every case as gitignore_check — RECORDED,
// never suppressing. The one place it changes a verdict is the FRONTIER arm, so
// the only gitignore exclusion this oracle mints is for an UNOWNED ignored path
// (reason 'gitignored', record_id null), which is where H19 withholds its
// unowned-territory notice and H10 its article demand.
//
// The expected set MIRRORS each hook's own predicate (same types, same
// file_keys, same cap, same !working_tree filter) rather than asking an
// independent question — so the oracle measures the hooks, not its own opinion.
// Excluded paths are accounted for BY NAME (anti_pattern 1b141d1f: a deduping
// notifier's silence is multiply-caused), never silently dropped.
//
//   node scripts/delivery-oracle.mjs [--project <dir>] [--probes <dir>] [--json]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync,
  readdirSync, mkdtempSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  extractAxisTerms, axisHits, AXIS_MIN_HITS, hasDiscriminatingHit, hasRecordCentralityHit, MAX_RANK_TERMS,
  decodeLiveRecordRow, classifyClaimPath,
} from '@sterling/store';

export const ORACLE_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// The hook predicates this oracle mirrors, named once (h19-knowledge-delivery
// :86, h19-bash-delivery:103, h23-output-axis:165, h10-direct-capture:1117).
const OWNER_TYPES = ['feature_article', 'reference_material'];
const HOOK_CAP = 100;          // H19/H23's ownership cap
const ENUM_CAP = 5000;         // enumeration only — never a predicate

const H19 = 'h19-knowledge-delivery.mjs';
const H19_BASH = 'h19-bash-delivery.mjs';
const H10 = 'h10-direct-capture.mjs';
const DRAIN = 'h19-delivery-drain.mjs';
const H23 = 'h23-output-axis.mjs';
const H20 = 'h20-mechanism-axis.mjs';

// H10's demand-block header (h10-direct-capture.mjs:1712). Used as the LIVENESS
// arm of the inverted ownership verdict: its absence means H10 never printed a
// demand at all, which is unmeasured — never "the path is owned".
const H10_DUTIES_MARKER = 'H10 ▸ duties before this session ends';

// H23's own clip + candidate cap, mirrored verbatim (h23-output-axis.mjs:85,
// :181-182) so a rename there is the only place these constants must move.
const OUTPUT_AXIS_CLIP = 16_000;
const OUTPUT_AXIS_CANDIDATE_CAP = 40;

// 'output_axis_pointers' is the kind the live H23 hook actually enqueues
// (h23-output-axis.mjs:236) and is therefore the ONLY output-axis name here.
// An earlier draft also pre-seeded 'output_axis', a name the test pins had
// assumed while blind and which nothing emits; it was removed rather than
// aliased, because an oracle bucket keyed on a kind no hook produces can pass
// forever while auditing nothing — the hollow-arm failure anti_pattern
// 1b141d1f exists to prevent, and indistinguishable from a correct silence.
const QUEUE_KINDS = ['delivery', 'frontier', 'bash_pointers', 'output_axis_pointers'];
const PROBE_KINDS = ['agent', 'ask', 'consult'];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const uniq = (xs) => [...new Set(xs)];
const idsIn = (text) => uniq(String(text ?? '').match(UUID_RE) ?? []);

// ---------------------------------------------------------------------------
// deriveExpected — the store-side half.
// ---------------------------------------------------------------------------

/** Which of `paths` git ignores, or null when git cannot answer (no repo, no
 *  git). Same contract as the hooks' gitIgnored: the CALLER owns the degrade,
 *  and it degrades TOWARD signalling — a path we cannot prove is ignored stays
 *  an expectation rather than vanishing from the audit. */
function gitIgnored(paths, cwd) {
  const list = (paths ?? []).filter(Boolean);
  if (!list.length) return new Set();
  const res = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd, input: list.join('\0') + '\0', encoding: 'utf8', timeout: 30_000,
  });
  if (res.status !== 0 && res.status !== 1) return null;
  return new Set((res.stdout || '').split('\0').filter(Boolean));
}

/** Repo-relative POSIX paths a record CLAIMS — the enumeration seam only. The
 *  field carrying paths is per TYPE (feature_article -> files[{path}],
 *  reference_material -> location, decision/anti_pattern -> file_keys[]). */
function claimedPaths(record) {
  if (record.type === 'feature_article') return (record.files ?? []).map((f) => f?.path);
  if (record.type === 'reference_material') return [record.location];
  return record.file_keys ?? [];
}

/** A path this oracle is willing to MATERIALIZE inside its sandbox. Absolute
 *  paths, drive letters, URLs, backslash forms and any `..` segment are refused:
 *  a record's files[] is store data, and store data must never be able to steer
 *  a sandbox write outside the sandbox. Refusal is per-path and named by the
 *  caller, never a silent skip. */
const isRepoPath = (p) => {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('://') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return false;
  if (p.split('/').some((seg) => seg === '..')) return false;
  return true;
};

/** Canonicalize an already-isRepoPath-accepted string into the segment form
 *  every later comparison (the directory/ancestor screen, the ancestor's own
 *  entry, materialize) uses. Without this, an ALIAS SPELLING of the same
 *  path — a trailing slash ('a/'), a './' segment ('a/./b'), a doubled
 *  slash ('a//b') — compares UNEQUAL to its canonical sibling in a plain
 *  string ancestor check, so a directory-shaped claim spelled 'a/' beside a
 *  file claim 'a/b' is never recognised as the ancestor it is: on disk,
 *  resolving 'a/' collapses to the same path as 'a', and materializing it
 *  still writes a REGULAR FILE there, reproducing the exact EEXIST crash the
 *  screen exists to prevent (Codex review, MUST-FIX 1). Empty and '.'
 *  segments are dropped; a '..' segment or an all-empty result is refused
 *  (returns null) — isRepoPath already refuses raw '..', this is defense in
 *  depth against the same case surviving in a form isRepoPath did not model. */
function normalizeClaimedPath(p) {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

/** ONE H23-output-axis Case, mirroring h23-output-axis.mjs's OWN predicate
 *  exactly (board 5d462868) — never an independent opinion about relevance.
 *  Output-axis content matching confers no OWNERSHIP (decision b266d6b7): the
 *  case's `expected.owners` is always empty, and the cap
 *  (h23-output-axis.mjs's OUTPUT_AXIS_POINTER_CAP) is a DELIVERY-time concern,
 *  never applied here — `expected_ids` names every matching candidate.
 *
 *  ⚠ LATENT VERDICT DEFECT — READ THIS BEFORE WIRING PROBES INTO main().
 *  Naming every match here is correct at EXPECTATION time (pinned by group J3),
 *  but run()'s verdict is `expected_ids.every(...)` (see `covers`, ~line 1069)
 *  while the live hook renders at most OUTPUT_AXIS_POINTER_CAP = 1 pointer plus
 *  a "(+N more matched)" tail (decision h23-kept-raised-threshold-one-pointer-
 *  payload, 284fc4b0). A probe matching 2+ records would therefore score a
 *  PERMANENT FALSE MISS — the hook behaving exactly as ruled, reported as a
 *  delivery regression. It is unreachable today ONLY because main() calls
 *  deriveExpected with no `outputAxisProbes` (~line 966), so no output_axis case
 *  ever reaches run(). Wiring a probe source REQUIRES a cap-aware verdict first:
 *  covered up to the cap, with parseDelivery's per-entry `suppressed_count`
 *  reconciling the remainder. Do not wire probes before that lands. */
function deriveOutputAxisExpected(store, probe, index) {
  const tool = probe?.tool ?? 'Read';
  const rel = probe?.rel ?? null;
  const base = {
    kind: 'case',
    fixture_id: `${H23}:output_axis:${index}:${tool}:${rel ?? 'null'}`,
    hook: H23,
    payload_kind: 'output_axis',
    rel,
    tool,
    tool_response: probe?.tool_response,
  };
  // Every SILENT verdict names WHICH cause produced it (anti_pattern 1b141d1f:
  // H23's silence is multiply-caused, and a verdict that cannot tell its causes
  // apart audits nothing). One shape for the five EARLY-EXIT causes below; the
  // sixth ('below_axis_floor') is only knowable after the content match runs,
  // and is attached at this function's final return.
  const silent = (reason) => ({
    ...base,
    expected: { owners: [], hazards: [], rationale: [] },
    expected_ids: [],
    expected_reason: reason,
  });

  // UNSUPPORTED TOOL (h23-output-axis.mjs:134): the hook allows silently for
  // any tool that is not Read/Bash/PowerShell, checked FIRST and before the
  // store is even opened — board f1e056bd item 3, previously omitted from
  // this mirror entirely (a probe with tool:'Grep' would have derived a
  // non-empty expected set against a hook that is correctly silent).
  if (tool !== 'Read' && tool !== 'Bash' && tool !== 'PowerShell') return silent('unsupported_tool');

  // AGENT-SCOPED SILENCE (h23-output-axis.mjs:137): the pending queue serves
  // the CONDUCTOR's next prompt; a subagent invocation carries `agent_id` and
  // the hook allows silently before even looking at tool_response. Also board
  // f1e056bd item 3 — a probe with `agent_id` set would otherwise have
  // derived a non-empty expected set against this hook's deliberate silence.
  if (probe?.agent_id) return silent('agent_id_present');

  // NOTHING TO MATCH AGAINST (h23-output-axis.mjs:139-140), checked next in
  // the HOOK's own order — after the tool-type and agent-scope gates above,
  // before the store is even opened, and therefore before the read-seam gates
  // below. An absent/null tool_response
  // is a first-class silent allow, and it is NOT 'below_axis_floor': "there was
  // no response at all" and "the content did not clear the floors" are different
  // findings, and collapsing them would mislabel a payload-synthesis fault as a
  // relevance miss. AUTHORITY NOTE (review finding 3): the PROBE's tool_response
  // is authoritative for both halves — synthesizePayload's 'output_axis' arm
  // sends its absence through unchanged rather than substituting placeholder
  // content, so the payload the hook sees and the expectation derived here are
  // computed from the same bytes. The alternative (deriving over the substitute)
  // was rejected: it makes this hook arm unauditable, because a probe could
  // never exercise the no-response allow the hook explicitly implements.
  const raw = probe?.tool_response;
  if (raw == null) return silent('no_tool_response');

  // READ-SEAM GATES (h23-output-axis.mjs:159-169), applied in the hook's OWN
  // ORDER and checked BEFORE and INDEPENDENTLY of any content match:
  //   (1) .git, (2) .sterling/, then (3) ownership.
  // PATH EXCLUSIONS (1)+(2) mirror the hook's own mirror of
  // h19-knowledge-delivery.mjs:41-42: reading the store's own tree or its
  // delivery queue is self-referential — matching on pending.json's content
  // would let the hook feed itself — so the hook is deliberately silent there.
  // They get their own reason: without it, a Read of a .sterling/ path whose
  // content happens to match a stored record would make this mirror expect a
  // pointer and score the hook's CORRECT, deliberate silence as a regression.
  // Ownership (3) is a different silence again: H19 already delivers substance
  // on an owned path, so a second block would be double delivery.
  if (tool === 'Read') {
    if (rel === '.git' || rel?.startsWith('.git/')) return silent('path_excluded');
    if (rel?.startsWith('.sterling/')) return silent('path_excluded');
    if (rel) {
      const owners = store.query({ types: OWNER_TYPES, file_keys: [rel], cap: HOOK_CAP }).filter((r) => !r.working_tree);
      if (owners.length) return silent('owned_suppressed');
    }
  }
  // CONTENT MATCH (h23-output-axis.mjs:171-193): stringify an object-shaped
  // tool_response exactly as the hook does, clip to the same window, extract
  // axis terms, then apply the SAME three floors over the SAME two candidate
  // types at the SAME per-type cap.
  const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const clipped = content.slice(0, OUTPUT_AXIS_CLIP);
  const terms = extractAxisTerms(clipped, MAX_RANK_TERMS);
  let hazards = [];
  let rationale = [];
  if (terms.length >= AXIS_MIN_HITS) {
    const candidates = [
      ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: OUTPUT_AXIS_CANDIDATE_CAP }),
      ...store.query({ types: ['decision'], rank_terms: terms, cap: OUTPUT_AXIS_CANDIDATE_CAP }),
    ];
    const scored = candidates
      .map((r) => ({ record: r, hits: axisHits(r, terms) }))
      .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits) && hasRecordCentralityHit(x.record, clipped));
    hazards = scored.filter((x) => x.record.type === 'anti_pattern').map((x) => x.record.id);
    rationale = scored.filter((x) => x.record.type === 'decision').map((x) => x.record.id);
  }
  const expected_ids = uniq([...hazards, ...rationale]);
  return {
    ...base,
    expected: { owners: [], hazards, rationale },
    expected_ids,
    // Present ONLY when silent — the LAST of the six derivable silence
    // reasons ('unsupported_tool' | 'agent_id_present' | 'no_tool_response' |
    // 'path_excluded' | 'owned_suppressed' | 'below_axis_floor'); dedup and
    // the pointer cap stay out of scope here, per the module header and
    // h23-output-axis.mjs's own frozen suite.
    ...(expected_ids.length === 0 ? { expected_reason: 'below_axis_floor' } : {}),
  };
}

export function deriveExpected(store, { repoRoot: root, outputAxisProbes = [] } = {}) {
  // 1. ENUMERATE candidate paths from the records themselves. This is not the
  //    predicate — every path found here is re-asked through the hooks' own
  //    query below, so an enumeration quirk can never widen an expectation.
  // claimants: norm -> EVERY claimant, {record_id, record_type, raw} — never
  // just the first (roster review round 2, item 4): a directory-shaped or
  // ancestor exclusion names every record that claimed the path, and the RAW
  // spelling that produced the normalized form, so an operator reading the
  // exclusion can see WHICH claim(s) to fix.
  const claimants = new Map();
  const rejectedPaths = [];
  const addClaimant = (norm, record, raw) => {
    const list = claimants.get(norm) ?? [];
    if (!list.some((c) => c.record_id === record.id)) list.push({ record_id: record.id, record_type: record.type, raw });
    claimants.set(norm, list);
  };
  for (const type of ['feature_article', 'reference_material', 'anti_pattern', 'decision']) {
    // cap + 1 so a FULL page is detectable. A silently truncated enumeration
    // under-reports the audit's own coverage, which is the one error class an
    // audit may never make: it would read as "these records are conformant".
    const records = store.query({ types: [type], cap: ENUM_CAP + 1 });
    if (records.length > ENUM_CAP) {
      throw new Error(
        `deriveExpected: the ${type} enumeration hit its cap (${ENUM_CAP}) — the audit would silently cover only part of the store. ` +
          'Raise ENUM_CAP in scripts/delivery-oracle.mjs and re-run; never report a capped run as a clean one.'
      );
    }
    for (const record of records) {
      for (const p of claimedPaths(record)) {
        if (typeof p !== 'string' || !p) continue;
        // Accounted for BY NAME, never dropped (anti_pattern 1b141d1f).
        if (!isRepoPath(p)) { rejectedPaths.push({ rel: p, record_id: record.id }); continue; }
        // NORMALIZE BEFORE USE AS A KEY (Codex review, MUST-FIX 1): the
        // directory/ancestor screen below, and everything after it, compares
        // this canonical form — never the raw claimed string — so an alias
        // spelling ('a/', 'a/.', 'a//b') cannot dodge the ancestor check.
        const norm = normalizeClaimedPath(p);
        if (norm === null) { rejectedPaths.push({ rel: p, record_id: record.id }); continue; }
        addClaimant(norm, record, p);
      }
    }
  }
  const allRels = [...claimants.keys()].sort();

  // 1b. DIRECTORY-SHAPED / ANCESTOR CLAIMS (board 26152d5e, roster review
  //     round 2 items 2-3): a record's files[]/file_keys entry is
  //     schema-valid but names a PATH THAT IS ACTUALLY A DIRECTORY (decision
  //     1dab2a9f claims packages/mcp-server/src/tests) — every delivery
  //     consumer compares by EXACT FILE equality, so such a claim can never
  //     deliver anything. Worse, materialize() stands in a REGULAR FILE at
  //     every claimed path (h19-bash-delivery needs one to exist), so a
  //     directory-shaped claim materializes a FILE exactly where a nested
  //     claim underneath it needs a DIRECTORY, and mkdirSync throws EEXIST —
  //     the crash this fix closes. Screened here, before any case or
  //     materialization work, and reported BY NAME (anti_pattern 1b141d1f)
  //     rather than silently dropped or left to crash the run. The upstream
  //     fork this board item ALSO owes (reject vs. teach every hook a
  //     directory scope) is a separate, later decision — this fix only keeps
  //     the audit itself from choking on the data as it exists today.
  //
  //     TWO DISTINCT REASONS, not one umbrella (round 2 item 3 — no frozen
  //     pin cited the old single 'directory_shaped_claim' string, so nothing
  //     needed grandfathering): 'real_directory' when the path stats as a
  //     directory on disk; 'ancestor_of_claim' when it is merely a STRING
  //     ancestor of another claim (no disk evidence either way). A THIRD
  //     case is the opposite finding (round 2 item 2): when the ancestor
  //     stats as a REAL REGULAR FILE, that file claim is the legitimate one
  //     and the DESCENDANT claim underneath it is the malformed data — the
  //     descendant is excluded instead ('descends_from_file_claim'), naming
  //     the descendant's own claimant(s), and the file claim proceeds as an
  //     ordinary case. A real owned file must never be dropped because some
  //     OTHER record's bad descendant claim happens to nest under it.
  const excluded = new Map(); // rel -> { reason, errno? }
  for (const rel of allRels) {
    if (excluded.has(rel)) continue;
    // THE SHARED CLASSIFIER (decision
    // [path-claims-are-leaf-or-absent-directory-claims-refused-at-the-tool-write-boundary]):
    // the same @sterling/store function the MCP write boundary refuses on, so
    // the census and the gate can never disagree about what a directory claim
    // is. It replaced a hand-rolled statSync whose bare `catch {}` collapsed
    // "unreadable" into "absent" — the one verdict the write boundary REFUSES
    // was invisible here, so a claim the gate would reject read as a healthy
    // absent path. An unverifiable verdict now gets its own named exclusion
    // carrying the errno, never silence.
    const verdict = classifyClaimPath(root, rel);
    const isRealDir = verdict === 'real_directory';
    const isRealFile = verdict === 'leaf';
    const descendants = allRels.filter((other) => other !== rel && other.startsWith(`${rel}/`));
    if (typeof verdict === 'object') {
      excluded.set(rel, { reason: 'unverifiable_claim', errno: verdict.errno });
    } else if (isRealDir) {
      excluded.set(rel, { reason: 'real_directory' });
    } else if (descendants.length) {
      if (isRealFile) {
        for (const d of descendants) excluded.set(d, { reason: 'descends_from_file_claim' });
      } else {
        excluded.set(rel, { reason: 'ancestor_of_claim' });
      }
    }
  }
  const rels = allRels.filter((rel) => !excluded.has(rel));

  // 2. NEIGHBOURS — the FRONTIER arm's candidates. H19's ignore check exists
  //    solely to suppress the unowned-territory notice on ignored paths, and an
  //    unowned path is by definition one no record names, so it can never come
  //    out of the enumeration above. The bounded source is the DIRECTORIES
  //    governed territory already lives in: one non-recursive readdir per
  //    claimed directory, which finds an unowned file sitting beside an owned
  //    one and never walks node_modules (no record claims anything there).
  const claimedDirs = [...new Set(rels.map((r) => (r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '.')))];
  const neighbours = new Set();
  for (const d of claimedDirs) {
    let entriesOnDisk;
    try {
      entriesOnDisk = readdirSync(join(root, d), { withFileTypes: true });
    } catch { continue; } // a claimed directory that no longer exists is not a frontier
    for (const e of entriesOnDisk) {
      if (!e.isFile()) continue;
      const rel = d === '.' ? e.name : `${d}/${e.name}`;
      if (!claimants.has(rel) && isRepoPath(rel)) neighbours.add(rel);
    }
  }

  // 3. One batched ignore check over claimed paths AND neighbours (the hooks ask
  //    per path; the ANSWER is identical and this keeps the audit to one spawn).
  const ignored = gitIgnored([...rels, ...neighbours], root);
  const gitignore_check = ignored === null ? 'unavailable' : 'checked';

  const entries = [];
  // A path the oracle refuses to materialize is REPORTED, never dropped: an
  // unaudited path that vanishes from the report reads as a conformant one.
  for (const r of rejectedPaths) {
    entries.push({ kind: 'exclusion', rel: r.rel, record_id: r.record_id, reason: 'unsafe_path' });
  }
  // DIRECTORY-SHAPED / ANCESTOR / DESCENDANT CLAIMS, screened above (1b) —
  // reported the same way, never silently dropped, and never reaching
  // materialize(). EVERY claimant is named (record_ids), record_id kept as
  // the first for compatibility, and the RAW spelling that produced the
  // normalized rel rides beside it (roster review round 2, item 4).
  for (const [rel, x] of [...excluded.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const claims = claimants.get(rel) ?? [];
    entries.push({
      kind: 'exclusion', rel,
      record_id: claims[0]?.record_id ?? null,
      record_ids: claims.map((c) => c.record_id),
      record_type: claims[0]?.record_type ?? null,
      raw: claims[0]?.raw ?? rel,
      reason: x.reason,
      // Only 'unverifiable_claim' carries one — the errno the shared classifier
      // could not see past, so the census says WHY rather than just excluding.
      ...(x.errno ? { errno: x.errno } : {}),
    });
  }
  // FRONTIER SUPPRESSION, recorded by name. An UNOWNED path that git ignores is
  // the one place gitignore actually changes a hook's behaviour: H19 withholds
  // its unowned-territory notice there (h19-knowledge-delivery.mjs:~115) and H10
  // withholds its article demand (h10-direct-capture.mjs:~1122). That
  // suppression is scoped to THIS path — it never touches owner delivery, which
  // is why an OWNED ignored path carries no exclusion at all.
  for (const rel of [...neighbours].sort()) {
    if (ignored?.has(rel)) {
      entries.push({ kind: 'exclusion', rel, record_id: null, reason: 'gitignored' });
    }
  }
  for (const rel of rels) {
    const rawOwners = store.query({ types: OWNER_TYPES, file_keys: [rel], cap: HOOK_CAP });
    const owners = rawOwners.filter((r) => !r.working_tree);
    const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: HOOK_CAP });
    const rationale = store.query({ types: ['decision'], file_keys: [rel], cap: HOOK_CAP });

    // NO GITIGNORE SHORT-CIRCUIT HERE, deliberately — this is the arm an
    // outside-family review overturned. Neither delivery hook gates OWNER
    // resolution on the ignore check: h19-knowledge-delivery applies it only to
    // the unowned-frontier decision (:~115) and h19-bash-delivery performs no
    // ignore check at all (:~81). An oracle that excluded ignored paths
    // wholesale asked NOTHING about exactly the territory where those two hooks
    // can silently stop delivering. The check still RUNS, and its result is
    // recorded on every case as gitignore_check — recorded, never suppressing.
    // (board 1de3653b governs the FRONTIER signal, which is handled above.)

    // A working-tree copy's article is deliberately not delivered against the
    // live tree; each filtered-out claim is named rather than dropped.
    for (const wt of rawOwners.filter((r) => r.working_tree)) {
      entries.push({ kind: 'exclusion', rel, record_id: wt.id, reason: 'working_tree_article' });
    }

    const mk = (hook, payload_kind, expected) => {
      const expected_ids = uniq([...expected.owners, ...expected.hazards, ...expected.rationale]);
      entries.push({
        kind: 'case',
        fixture_id: `${hook}:${payload_kind}:${rel}`,
        hook, payload_kind, rel,
        expected, expected_ids, gitignore_check,
      });
    };
    const ids = (rs) => rs.map((r) => r.id);

    // H19 file-touch: owners + hazards (substance) + decisions (pointers).
    if (owners.length || hazards.length || rationale.length) {
      mk(H19, 'file_touch', { owners: ids(owners), hazards: ids(hazards), rationale: ids(rationale) });
    }
    // H19 bash pointers: owners + hazards only (h19-bash-delivery:102-108).
    if (owners.length || hazards.length) {
      mk(H19_BASH, 'bash', { owners: ids(owners), hazards: ids(hazards), rationale: [] });
    }
    // H10 ownership: the AGREEMENT arm. Derived from H19's cap-100 owner set on
    // purpose — H10 asks the same question at cap 25, so a path owned by more
    // records than its cap reads as UNOWNED there and shows up here as a miss
    // rather than as a matching (and therefore invisible) expectation.
    if (owners.length) {
      mk(H10, 'h10_ownership', { owners: ids(owners), hazards: [], rationale: [] });
    }
  }

  // H23 output-axis (board 5d462868): content-matched, never path-enumerated —
  // one Case per caller-supplied probe, mirroring h23-output-axis.mjs's own
  // predicate (deriveOutputAxisExpected above). Backward-compatible: an empty
  // (default) outputAxisProbes list adds nothing, so every pre-existing call
  // site is unchanged.
  outputAxisProbes.forEach((probe, i) => entries.push(deriveOutputAxisExpected(store, probe, i)));

  return entries;
}

// ---------------------------------------------------------------------------
// synthesizePayload — the exact stdin shape each hook reads.
// Returns the sandbox side-effects beside the stdin, because H10 takes its
// touched set from DISK (.sterling/transient/touches.json), never from stdin.
// ---------------------------------------------------------------------------

export function synthesizePayload(caseOrProbe, { cwd, agent_id, session_id } = {}) {
  const c = caseOrProbe ?? {};
  const kind = c.kind === 'case' ? c.payload_kind : c.kind;
  const ti = c.tool_input ?? {};
  const stdin = { cwd };
  if (session_id) stdin.session_id = session_id;
  // ABSENT, not empty: H19's AC6 silences agent touches on the enqueue rung, so
  // a stray `agent_id: ''` would change the verdict rather than describe it.
  if (agent_id) stdin.agent_id = agent_id;
  const sandbox_writes = [];

  switch (kind) {
    case 'file_touch':
      stdin.hook_event_name = c.event ?? 'PostToolUse';
      stdin.tool_name = c.tool ?? 'Read';
      stdin.tool_input = { file_path: join(cwd, c.rel) };
      break;
    case 'bash':
      stdin.hook_event_name = c.event ?? 'PostToolUse';
      stdin.tool_name = c.tool ?? 'Bash';
      stdin.tool_input = { command: `grep -n TODO ${c.rel}` };
      break;
    case 'output_axis': {
      // Unlike 'file_touch'/'bash' (always Read/Bash respectively), an
      // output_axis case's `tool` selects the SHAPE of tool_input — 'Bash'
      // carries a command string, everything else (default 'Read') carries an
      // absolute file_path under the sandbox cwd (B3/B2's own rule, extended).
      const oaTool = c.tool ?? 'Read';
      stdin.hook_event_name = c.event ?? 'PostToolUse';
      stdin.tool_name = oaTool;
      stdin.tool_input =
        oaTool === 'Bash' || oaTool === 'PowerShell'
          ? { command: c.rel ? `grep -n TODO ${c.rel}` : 'grep -rn TODO .' }
          : { file_path: join(cwd, c.rel) };
      // The real tool_response shape passes through UNCHANGED: a string is
      // sent byte-for-byte, an OBJECT is sent unstringified — the real hook
      // does its own stringification (h23-output-axis.mjs:173), so
      // pre-stringifying here would test a shape the platform never sends.
      // ABSENCE PASSES THROUGH TOO (review finding 3). The earlier
      // `?? `contents of ${c.rel}`` substitute meant the payload and
      // deriveOutputAxisExpected's expectation were computed from DIFFERENT
      // content whenever a probe omitted tool_response. THE PROBE IS
      // AUTHORITATIVE, and deriveOutputAxisExpected mirrors it: an absent
      // tool_response stays absent so the hook takes its own no-response allow
      // (h23-output-axis.mjs:139-140) and the case's 'no_tool_response'
      // expectation measures exactly that arm. Substituting instead would have
      // made that arm permanently unauditable. `null` is forwarded as null —
      // the hook treats it identically, and the platform can send it.
      if (c.tool_response !== undefined) stdin.tool_response = c.tool_response;
      break;
    }
    case 'h10_ownership':
      // NOTHING about the path in stdin — H10 reads the touched set from disk,
      // and feeding it by stdin would audit a channel the hook does not use.
      stdin.hook_event_name = c.event ?? 'Stop';
      sandbox_writes.push({
        rel: join('.sterling', 'transient', 'touches.json'),
        json: [{ path: c.rel, at: new Date().toISOString() }],
      });
      break;
    case 'agent':
      stdin.hook_event_name = c.event ?? 'PreToolUse';
      stdin.tool_name = c.tool ?? 'Task';
      stdin.tool_input = { ...ti };
      break;
    case 'ask':
      // AskUserQuestion has NO prompt field (decision f5638a84). The shape is
      // whitelisted rather than copied so a synthesized prompt cannot leak in.
      stdin.hook_event_name = c.event ?? 'PreToolUse';
      stdin.tool_name = c.tool ?? 'AskUserQuestion';
      stdin.tool_input = { questions: ti.questions ?? [] };
      break;
    case 'consult':
      stdin.hook_event_name = c.event ?? 'PreToolUse';
      stdin.tool_name = c.tool ?? 'mcp__codex__codex';
      stdin.tool_input = { ...ti };
      break;
    default:
      throw new Error(`synthesizePayload: unknown payload kind '${kind}' — an unrecognised surface is never half-synthesized (P5)`);
  }
  return { stdin, sandbox_writes };
}

// ---------------------------------------------------------------------------
// parseDelivery — the three channels.
// ---------------------------------------------------------------------------

export function parseDelivery(hookResult, sandboxDir) {
  const exit_code = hookResult?.code ?? null;
  const stdout = String(hookResult?.stdout ?? '');
  const stderr = String(hookResult?.stderr ?? '');

  let harness_error;
  let rendered_ids = [];
  let additionalContext = '';
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout);
      // SHAPE VALIDATION, not just parseability: a hook that printed a non-object
      // or a bare `{}` produced a MALFORMED ARTIFACT, and reading that as silence
      // credits the hook with a clean no-op it never performed. An object that
      // carries other keys but no hookSpecificOutput is genuine silence.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`hook stdout is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not a hook-output object`);
      }
      if (Object.keys(parsed).length === 0) {
        throw new Error('hook stdout is an empty JSON object — a malformed artifact, not silence');
      }
      additionalContext = parsed?.hookSpecificOutput?.additionalContext ?? '';
      rendered_ids = idsIn(additionalContext);
    } catch (e) {
      // NOT an empty result: null means "not measured". [] would score as a
      // real MISS and blame the hook for a harness fault.
      harness_error = `unparseable hook stdout: ${e.message}`;
      rendered_ids = null;
    }
  }

  const queued_by_kind = Object.fromEntries(QUEUE_KINDS.map((k) => [k, []]));
  const pending = join(sandboxDir, '.sterling', 'transient', 'delivery', 'pending.json');
  let queuedEntries = [];
  if (existsSync(pending)) {
    try {
      const raw = JSON.parse(readFileSync(pending, 'utf8'));
      // The queue's declared shape is an ARRAY of entries. Anything else is a
      // malformed artifact (the shape h19-delivery-drain parks as corrupt) —
      // scoring it as an empty queue would report a torn file as "nothing
      // queued" and blame the producer for a delivery it may well have made.
      if (!Array.isArray(raw)) throw new Error(`pending queue is ${raw === null ? 'null' : typeof raw}, not an array`);
      queuedEntries = raw;
    } catch (e) {
      harness_error = harness_error ?? `malformed pending queue: ${e.message}`;
    }
  }
  for (const entry of queuedEntries) {
    const kind = entry?.kind ?? 'delivery';
    // Ids are read from the WHOLE entry, not the payload alone: the drain
    // re-resolves from the entry's `recipe` (decision db3392db), and a rendered
    // full article names its record in the recipe while the prose body need not
    // print the uuid at all. A frontier entry names territory and no record —
    // assuming every queue entry is article-shaped drops the signal it carries.
    const text = JSON.stringify(entry ?? null);
    // H23's own disclosure tail (board 5d462868, decision 284fc4b0), parsed with
    // the SAME regex h23-output-axis.mjs's own frozen suite pins — a rename of
    // the tail format then breaks both suites identically instead of silently
    // diverging. 0, never undefined, when the tail is absent: "not measured"
    // would be wrong here — no tail means nothing was suppressed.
    const payloadText = typeof entry?.payload === 'string' ? entry.payload : '';
    const tailMatch = payloadText.match(/\(\+(\d+) more matched\)/);
    const parsedEntry = {
      kind, rel: entry?.rel ?? null, ids: idsIn(text), text,
      suppressed_count: tailMatch ? Number(tailMatch[1]) : 0,
    };
    (queued_by_kind[kind] ??= []).push(parsedEntry);
  }
  const queued_ids = uniq(Object.values(queued_by_kind).flat().flatMap((e) => e.ids));

  const denied = exit_code === 2;
  const denied_ids = denied ? idsIn(stderr) : [];

  // DENY OUTRANKS INJECT: an exit-2 result that also printed context is a
  // denial — the action did not proceed, whatever else was written.
  let channel;
  if (denied) channel = 'deny';
  else if (harness_error) channel = 'harness_error';
  else if (additionalContext) channel = 'inject';
  else if (queuedEntries.length) channel = 'queue';
  else if (exit_code === 1) channel = 'warn';
  else channel = 'silent';

  return {
    rendered_ids, queued_ids, queued_by_kind, exit_code, channel, denied, denied_ids,
    // The RAW channel text beside the ids: a full-article render carries the
    // article's substance without necessarily printing its uuid, so scoring on
    // ids alone would report a real delivery as a miss (measured 2026-09-05).
    rendered_text: additionalContext,
    queued_text: Object.values(queued_by_kind).flat().map((e) => e.text).join('\n'),
    queued_entries: Object.values(queued_by_kind).flat().length,
    stderr_text: stderr,
    ...(harness_error ? { harness_error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Identity + run comparison.
// ---------------------------------------------------------------------------

/** The four board-named components, PLUS the two that also change what a run
 *  means: the snapshot MODE (a fallback-taken run is not comparable to a
 *  read-only one) and a digest of the delivery-relevant config. Absent extras
 *  hash stably, so the four-component call is unchanged. */
export function runIdentity({ snapshotDigest, bundleHash, rung, oracleVersion, snapshotMode, configDigest } = {}) {
  return sha(JSON.stringify([snapshotDigest, bundleHash, rung, oracleVersion, snapshotMode ?? null, configDigest ?? null])).slice(0, 16);
}

export function caseIdentity(caseObj = {}) {
  return sha(JSON.stringify([
    caseObj.fixture_id ?? null,
    caseObj.hook ?? null,
    [...(caseObj.expected_ids ?? [])].sort(),
  ])).slice(0, 16);
}

/** The expected-set hash a run diff keys on beside the fixture id. Covers the
 *  WHOLE expectation, not just expected_ids: the PAYLOAD that was sent, the
 *  deny expectation and the must-stay-absent set are all things whose change
 *  moves the goalposts, and a diff that missed them would report an
 *  expectation change as a regression (or launder one as a recovery). */
export function expectedHash(expected_ids = [], extra = {}) {
  return sha(JSON.stringify([
    [...expected_ids].sort(),
    [...(extra.expect_deny_ids ?? [])].sort(),
    [...(extra.expected_absent_ids ?? [])].sort(),
    extra.expect_deny ?? false,
    extra.payload ?? null,
  ])).slice(0, 16);
}

const passed = (c) => Boolean(c?.rendered || c?.drained);

export function compareRuns(prev, next) {
  const pass_to_miss = [];
  const miss_to_pass = [];
  const expectation_changed = [];
  const unmeasured = [];
  const before = new Map((prev?.cases ?? []).map((c) => [c.fixture_id, c]));
  for (const c of next?.cases ?? []) {
    const p = before.get(c.fixture_id);
    if (!p) continue; // a brand-new case has no prior verdict to move from
    // A MOVED GOALPOST IS NOT A REGRESSION — and it is not a recovery either.
    if (p.expected_hash !== c.expected_hash) {
      expectation_changed.push(c.fixture_id);
      continue;
    }
    // NEITHER IS A BROKEN HARNESS. A case that could not be measured on either
    // side has produced no verdict to compare, so calling it a regression would
    // report a broken machine as a delivery failure — the same substitution the
    // metrics filter above prevents, at the diff instead of the ratio.
    if (c.harness_error || p.harness_error) {
      unmeasured.push(c.fixture_id);
      continue;
    }
    if (passed(p) && !passed(c)) pass_to_miss.push(c.fixture_id);
    else if (!passed(p) && passed(c)) miss_to_pass.push(c.fixture_id);
  }
  return { pass_to_miss, miss_to_pass, expectation_changed, unmeasured };
}

// ---------------------------------------------------------------------------
// Metrics. Division by zero is NULL — never NaN, never 0 ("0" reads as
// "measured, and it was terrible", which is a different finding entirely).
// ---------------------------------------------------------------------------

const ratio = (hits, total) => (total === 0 ? null : hits / total);

export function metrics(cases = []) {
  const per_hook = {};
  for (const c of cases) {
    (per_hook[c.hook] ??= []).push(c);
  }
  for (const [hook, all] of Object.entries(per_hook)) {
    // A HARNESS ERROR IS NOT A DELIVERY MISS. An unreadable sandbox, a git that
    // would not run, a hook that could not start — none of that is evidence
    // about delivery, and scoring it as a miss reports a broken MACHINE as "the
    // hooks stopped delivering", which is the most expensive wrong conclusion
    // this tool can produce. Unmeasured cases leave every ratio and are counted
    // in their own field instead, so the reader sees coverage drop rather than
    // quality drop.
    const harness_errors = all.filter((c) => c.harness_error).length;
    const list = all.filter((c) => !c.harness_error);
    const eligible = list.filter((c) => c.eligible);
    const queued = list.filter((c) => c.queued);
    let hit = 0;
    let delivered = 0;
    for (const c of list) {
      const expected = new Set(c.expected_ids ?? []);
      for (const id of c.delivered_ids ?? []) {
        delivered++;
        if (expected.has(id)) hit++;
      }
    }
    per_hook[hook] = {
      eligible_recall: ratio(eligible.length, list.length),
      rendered_recall: ratio(eligible.filter((c) => c.rendered).length, eligible.length),
      eventual_recall: ratio(eligible.filter((c) => c.rendered || c.drained).length, eligible.length),
      drained_recall: ratio(queued.filter((c) => c.drained).length, queued.length),
      precision: ratio(hit, delivered),
      harness_errors,
      measured: list.length,
    };
  }
  return { per_hook };
}

// ---------------------------------------------------------------------------
// Sandbox reset — THE WHOLE transient/ tree, not just delivery/.
//
// A stale guard file converts a real delivery into a dedup silence and a stale
// DENY LEDGER converts a first-attempt deny into an allow, but delivery/ is not
// the only contaminating cell: H10's entire Stop demand block is gated on
// transient/capture-nagged.json (h10-direct-capture.mjs:1714), so the FIRST
// h10_ownership case spends the marker and every later one gets an empty
// output that an inverted verdict would score as a PASS. pressure-nagged.json,
// delegation-nagged.json, session-events.json and touches.json carry the same
// class of cross-case state. So the whole directory goes, and each case
// re-seeds only what it needs.
//
// The store is contaminated too (H10 MINTS article_missing items into the
// sandbox db) — that is restored from the pristine snapshot per case by the
// runner, which is not this function's business.
// ---------------------------------------------------------------------------

export function resetSandbox(sandboxDir, caseObj = {}) {
  const dir = join(sandboxDir, '.sterling', 'transient');
  // An override case's prior denial (seed_ledger), or a deliberately-seeded
  // H23 output-axis guard (seed_output_axis_guard, board 5d462868 — mirrors
  // seed_ledger's own contract for this arm's guard), is written BEFORE this
  // call and must survive it; the runner wipes and re-seeds those cases
  // explicitly.
  //
  // seed_output_axis_guard IS HONOURED HERE BUT NOT YET REACHABLE FROM run()
  // (review 2026-09-06, finding 6) — and that is deliberate, not an oversight.
  // Only an output_axis case could set it, and none reaches run() until main()
  // supplies `outputAxisProbes` (see limit (2) in the module header). It is
  // kept rather than deleted because it is the RESET half of that follow-up and
  // is pinned by group N1; it is not wired now because doing so would add a
  // guard-conductor.json `output_axis` seeder and a run() parameter that no
  // caller can exercise and no frozen pin covers — dead machinery ahead of the
  // work that gives it meaning. Wire it WITH the probe source, beside
  // seed_ledger, and pin the pair together.
  if (caseObj.seed_ledger || caseObj.seed_output_axis_guard) return { removed: false };
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return { removed: existed };
}

// ---------------------------------------------------------------------------
// Probes — frozen, human-written, and validated STRICTLY: a probe that cannot
// fail measures nothing, and a probe faking a field the real surface never
// sends measures the wrong thing.
// ---------------------------------------------------------------------------

export function loadProbes(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const probes = [];
  for (const file of files) {
    const path = join(dir, file);
    const bad = (why) => { throw new Error(`delivery probe ${file}: ${why}`); };
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      bad(`unparseable JSON — ${e.message}`);
    }
    if (typeof json.id !== 'string' || !json.id) bad('missing id');
    if (!PROBE_KINDS.includes(json.kind)) bad(`unknown kind '${json.kind}' — kind must be one of ${PROBE_KINDS.join('|')}`);
    if (!Array.isArray(json.expected_ids)) bad('missing expected_ids — a probe with no expectation can never fail');
    const ti = json.tool_input;
    if (!ti || typeof ti !== 'object') bad('missing tool_input');
    if (json.kind === 'ask') {
      if (Object.hasOwn(ti, 'prompt')) bad('kind "ask" carries a prompt field — AskUserQuestion has none (decision f5638a84), and a synthesized one is a lie about the surface');
      if (!Array.isArray(ti.questions)) bad('kind "ask" needs tool_input.questions[]');
    } else if (typeof ti.prompt !== 'string' || !ti.prompt.trim()) {
      bad(`kind "${json.kind}" needs a tool_input.prompt string`);
    }
    if (json.expect_deny && !(Array.isArray(json.expect_deny_ids) && json.expect_deny_ids.length)) {
      bad('expect_deny with no expect_deny_ids — an unfalsifiable deny expectation is worse than none');
    }
    probes.push({
      id: json.id,
      kind: json.kind,
      note: json.note ?? '',
      tool_input: ti,
      expected_ids: json.expected_ids,
      expected_absent_ids: json.expected_absent_ids ?? [],
      expect_deny: Boolean(json.expect_deny),
      expect_deny_ids: json.expect_deny_ids ?? [],
      seed_ledger: Boolean(json.seed_ledger),
      file,
    });
  }
  // SET-LEVEL LIVENESS ARM. A negative probe passes on completely empty output,
  // so a set of negatives alone goes green against a matcher that is dead, a
  // store that is empty, or a payload shape the hook never reads — it cannot
  // fail the way retrieval fails. Every kind PRESENT must therefore carry at
  // least one probe that expects a delivery, so the same run always contains
  // something whose silence is a failure. An empty directory is not this
  // function's business (the caller records it as a named exclusion).
  if (probes.length) {
    for (const kind of [...new Set(probes.map((p) => p.kind))]) {
      if (!probes.some((p) => p.kind === kind && p.expected_ids.length > 0)) {
        throw new Error(
          `delivery probes: kind '${kind}' has no POSITIVE probe (every one expects nothing) — ` +
            'a set of negatives alone passes against a dead matcher. Add a probe of this kind with a non-empty expected_ids.'
        );
      }
    }
  }
  return probes;
}

// ---------------------------------------------------------------------------
// The report. NOT under transient/ — h19-clear-session wipes transient at every
// SessionStart, and a run history erased by the next session is not a history.
// ---------------------------------------------------------------------------

export function auditDir(projectRoot) {
  return join(projectRoot, '.sterling', 'delivery-audit');
}

export function writeRunReport(projectRoot, report) {
  const base = auditDir(projectRoot);
  const runs = join(base, 'runs');
  mkdirSync(runs, { recursive: true });
  const identity = runIdentity({
    snapshotDigest: report.identity?.snapshot_digest,
    bundleHash: report.identity?.bundle_hash,
    rung: report.identity?.rung,
    oracleVersion: report.identity?.oracle_version,
    snapshotMode: report.identity?.snapshot_mode,
    configDigest: report.identity?.config_digest,
  });
  // No ':' in the basename — illegal on Windows, and parity is standing. Still
  // lexicographically sortable by time.
  const stamp = String(report.at).replace(/[:.]/g, '-');
  const run_path = join(runs, `${stamp}-${identity}.json`);
  writeFileSync(run_path, `${JSON.stringify(report, null, 2)}\n`);

  const cases = report.cases ?? [];
  const history_path = join(base, 'history.jsonl');
  appendFileSync(history_path, `${JSON.stringify({
    at: report.at,
    identity: report.identity ?? {},
    totals: {
      cases: cases.length,
      passed: cases.filter((c) => passed(c)).length,
      harness_errors: cases.filter((c) => c.harness_error).length,
    },
    transitions: report.transitions ?? { pass_to_miss: [], miss_to_pass: [], expectation_changed: [] },
  })}\n`);
  return { run_path, history_path };
}

// ---------------------------------------------------------------------------
// THE RUN — snapshot, sandbox, drive the BUNDLES, score, report.
// ---------------------------------------------------------------------------

/** sha256 over the bundled hook set — the surface the platform executes —
 *  INCLUDING hooks.json. Registration is half the surface: the same bundles
 *  registered on different events deliver differently, so a run whose only
 *  change was a matcher edit must not carry the previous run's identity. */
export function bundleHash(root = repoRoot) {
  const dir = join(root, 'hooks');
  const h = createHash('sha256');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    h.update(f).update(readFileSync(join(dir, f)));
  }
  const registry = join(dir, 'hooks.json');
  h.update('hooks.json').update(existsSync(registry) ? readFileSync(registry) : Buffer.from('<absent>'));
  return h.digest('hex').slice(0, 16);
}

function runHook(root, hook, stdin, sandboxDir) {
  const res = spawnSync(process.execPath, [join(root, 'hooks', hook)], {
    cwd: sandboxDir, input: JSON.stringify(stdin), encoding: 'utf8', timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function buildSandbox(snapshotDb, config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-delivery-oracle-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.sterling', 'sterling.db'), readFileSync(snapshotDb));
  const git = (args) => spawnSync('git', ['-c', 'user.email=oracle@example.invalid', '-c', 'user.name=oracle', ...args], { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'oracle sandbox']);
  return dir;
}

/** Restore the sandbox store from the pristine snapshot. H10 WRITES to the
 *  store it is gated against (it mints/heals article_missing items), so without
 *  this every case after the first runs against a store the previous case
 *  mutated. WAL siblings go with it — a stale -wal would re-apply exactly the
 *  frames being discarded. */
function restoreStore(sandboxDir, snapshotDb) {
  const dest = join(sandboxDir, '.sterling', 'sterling.db');
  for (const sib of ['-wal', '-shm']) rmSync(dest + sib, { force: true });
  writeFileSync(dest, readFileSync(snapshotDb));
}

/** Write a REAL prior denial for a seed_ledger probe: H20's ledger is
 *  {entries: {<sorted ids joined by '|'>: {terms, recordIds}}, overrides: []}
 *  (scripts/hooks/lib/delivery.mjs:252-296, written at h20:462). Without this,
 *  seed_ledger only skipped a wipe — it seeded nothing, so an override probe
 *  measured a FIRST attempt while claiming to measure a second.
 *  DISCLOSED: `terms` is seeded EMPTY, so the override contract's delta floor
 *  (h20:439) is trivially cleared by any retry. A seed_ledger probe therefore
 *  measures the CITATION half of the override contract, not the delta half. */
function seedPriorDenial(sandboxDir, recordIds) {
  const ids = [...new Set(recordIds ?? [])].sort();
  if (!ids.length) return null;
  const dir = join(sandboxDir, '.sterling', 'transient', 'delivery');
  mkdirSync(dir, { recursive: true });
  const key = ids.join('|');
  writeFileSync(
    join(dir, 'deny-ledger-conductor.json'),
    JSON.stringify({ entries: { [key]: { terms: [], recordIds: ids } }, overrides: [] })
  );
  return { key, recordIds: ids, terms_seeded: 0 };
}

/** CONTAINMENT, checked at every write and not only at the path filter:
 *  isRepoPath screens store data on the way in, this refuses anything that
 *  still resolves outside the sandbox (a symlinked parent, a form the filter did
 *  not anticipate). Two independent guards, because the thing being trusted is
 *  store content. EVERY sandbox write goes through here — materialize AND
 *  applyWrites — so there is one chokepoint rather than one guarded path and
 *  one unguarded one. */
function sandboxPath(sandboxDir, rel, who) {
  const root = resolve(sandboxDir);
  const abs = resolve(sandboxDir, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`${who}: '${rel}' resolves outside the sandbox (${abs}) — refusing to write`);
  }
  return abs;
}

function materialize(sandboxDir, rel) {
  const abs = sandboxPath(sandboxDir, rel, 'materialize');
  mkdirSync(dirname(abs), { recursive: true });
  // h19-bash-delivery requires the named path to exist as a REGULAR FILE.
  if (!existsSync(abs)) writeFileSync(abs, `// oracle sandbox stand-in for ${rel}\n`);
  return abs;
}

function applyWrites(sandboxDir, writes) {
  for (const w of writes) {
    const abs = sandboxPath(sandboxDir, w.rel, 'applyWrites');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(w.json));
  }
}

function newestPriorRun(projectRoot) {
  const runs = join(auditDir(projectRoot), 'runs');
  if (!existsSync(runs)) return null;
  const files = readdirSync(runs).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.reverse()) {
    try {
      return JSON.parse(readFileSync(join(runs, f), 'utf8'));
    } catch { /* a torn report is not a baseline — try the one before it */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GOLDEN SCENARIOS — layer 2 (board ab288113), per decision 08872881
// (golden-fixture-expectations-stay-in-the-fixture-guarded-by-a-digest-pin,
// USER-RULED 2026-09-06): the expectations stay IN the fixture JSON at
// scripts/tests/fixtures/delivery-golden/*.json —
// {event, payload, expected_ids, expected_absent_ids, source_incident} — and
// the frozen test file carries a SHA-256 digest pin over a canonical manifest
// of ONLY the expectations, guarding against a coder turning a red golden
// scenario green by editing the fixture instead of the code.
//
// REPLAY MECHANISM (not pinned by the decision, decided here): each fixture
// replays against the SAME real-store sandbox/snapshot the rest of a run
// already builds — real record ids, no synthetic fixture repo — because the
// fixtures name REAL production record ids (resolved live with
// knowledge_query at authoring time, never guessed). `event` is the
// hook_event_name (PostToolUse/PreToolUse/Stop/UserPromptSubmit); which
// hook(s) fire is resolved from `event` + `payload.tool_name` via
// GOLDEN_EVENT_HOOKS below, a small table mirroring hooks/hooks.json's own
// registration for those matchers — restricted to the delivery-relevant hooks
// this oracle already knows how to run and parse. A `payload.tool_input.
// file_path` is authored REPO-RELATIVE (Windows/Linux parity, same convention
// as every other case in this file) and resolved to the sandbox's absolute
// path at replay time.
//
// A MISS CARRIES miss_reason: 'cap_evicted' means the expected record WAS a
// genuine candidate for the touched path and a rendering CAP (e.g.
// DECISION_POINTER_CAP) pushed it out of the shown slice — this is a RANKING
// finding about the live store's growth, never a hook fault, and it is NOT
// relabelled as a false positive: a cap silently dropping an incident's own
// fix is exactly the regression this layer exists to surface (roster review
// round 2, item 1). 'not_delivered' means the record was never a candidate
// at all (a stale or mis-targeted fixture, or a genuine wiring miss).
//
// THIS TABLE MIRRORS hooks/hooks.json AND MUST MOVE WITH IT (Codex review,
// MUST-FIX 2): a matcher added, removed or re-targeted there and not echoed
// here silently starves a golden fixture of the hook it needs, or routes it
// to a hook the platform would never actually run.
const GOLDEN_EVENT_HOOKS = {
  PostToolUse: {
    Read: [H19, H23],                    // hooks/hooks.json PostToolUse/Read
    Edit: [H19], Write: [H19], MultiEdit: [H19], // .../Edit|Write|MultiEdit
    Bash: [H19_BASH, H23], PowerShell: [H19_BASH, H23], // .../Bash|PowerShell
  },
  PreToolUse: {
    // hooks/hooks.json PreToolUse Edit|Write|MultiEdit ALSO carries H19
    // (material on injection_rung 'edit', where PostToolUse's own H19
    // registration is broken and PreToolUse is the only surface that injects).
    Edit: [H19], Write: [H19], MultiEdit: [H19],
    // hooks/hooks.json PreToolUse Task|Agent / AskUserQuestion /
    // mcp__codex__codex(-reply) matchers, restricted to H20 (the
    // delivery-relevant member of each of those matcher groups).
    Task: [H20], Agent: [H20], AskUserQuestion: [H20],
    'mcp__codex__codex': [H20], 'mcp__codex__codex-reply': [H20],
  },
  Stop: { '*': [H10] },                  // hooks/hooks.json Stop
  UserPromptSubmit: { '*': [DRAIN] },    // hooks/hooks.json UserPromptSubmit
};

function hooksForGolden(event, toolName) {
  const byEvent = GOLDEN_EVENT_HOOKS[event];
  if (!byEvent) return [];
  return byEvent[toolName] ?? byEvent['*'] ?? [];
}

// An id in a golden fixture is a real production uuid, never a slug or a
// placeholder — validated against the canonical shape (anchored, unlike the
// module's own extraction-purpose UUID_RE, which is unanchored and global by
// design). Codex review, MUST-FIX 3.
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Frozen, hand-authored golden fixtures — validated STRICTLY, same discipline
 *  as loadProbes: a fixture that cannot fail measures nothing. */
export function loadGoldenFixtures(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const fixtures = [];
  for (const file of files) {
    const path = join(dir, file);
    const bad = (why) => { throw new Error(`golden fixture ${file}: ${why}`); };
    let json;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      bad(`unparseable JSON — ${e.message}`);
    }
    if (typeof json.event !== 'string' || !json.event) bad('missing event');
    if (!json.payload || typeof json.payload !== 'object' || Array.isArray(json.payload)) bad('missing payload object');
    if (!Array.isArray(json.expected_ids)) bad('missing expected_ids — a fixture with no expectation can never fail');
    if (json.expected_absent_ids !== undefined && !Array.isArray(json.expected_absent_ids)) bad('expected_absent_ids must be an array when present');
    if (typeof json.source_incident !== 'string' || !json.source_incident) bad('missing source_incident');
    // A fixture with BOTH sets empty can never fail either way it is scored
    // (Codex review, MUST-FIX 3) — the same "cannot fail measures nothing"
    // rule loadProbes already enforces for a probe's own expected_ids.
    const expectedAbsentIds = json.expected_absent_ids ?? [];
    if (json.expected_ids.length === 0 && expectedAbsentIds.length === 0) {
      bad('both expected_ids and expected_absent_ids are empty — a fixture with no expectation can never fail');
    }
    // Every id is a real production uuid — never a slug, an empty string, or
    // a placeholder that would silently pass an `includes()` check forever.
    for (const [field, ids] of [['expected_ids', json.expected_ids], ['expected_absent_ids', expectedAbsentIds]]) {
      for (const id of ids) {
        if (typeof id !== 'string' || !UUID_SHAPE_RE.test(id)) {
          bad(`${field} contains '${id}', which is not a uuid — a golden expectation names a real production record id`);
        }
      }
    }
    // The event/tool_name pair must resolve to at least one hook this oracle
    // knows how to route, or the fixture can never be replayed and would
    // silently fall through to runGoldenFixtures' own harness_error at RUN
    // time instead of failing loud at LOAD time, naming the file.
    if (hooksForGolden(json.event, json.payload?.tool_name).length === 0) {
      bad(`event '${json.event}' + tool_name '${json.payload?.tool_name}' has no known hook route (see GOLDEN_EVENT_HOOKS) — the fixture can never be replayed`);
    }
    fixtures.push({
      file,
      event: json.event,
      payload: json.payload,
      expected_ids: json.expected_ids,
      expected_absent_ids: expectedAbsentIds,
      source_incident: json.source_incident,
    });
  }
  return fixtures;
}

/** The canonical manifest decision 08872881 pins — ONLY the expectations,
 *  fixtures sorted by filename, each id set sorted. Stimulus fields (event,
 *  payload, source_incident) are deliberately NOT included: they would create
 *  digest churn without buying any protection the decision's own text names. */
export function goldenManifest(fixtures = []) {
  return {
    version: 1,
    fixtures: [...fixtures]
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map((f) => ({
        file: f.file,
        expected_ids: [...(f.expected_ids ?? [])].sort(),
        expected_absent_ids: [...(f.expected_absent_ids ?? [])].sort(),
      })),
  };
}

export function goldenManifestDigest(fixtures = []) {
  return sha(JSON.stringify(goldenManifest(fixtures)));
}

/** payload.tool_input.file_path is normally authored repo-relative and is
 *  resolved against the sandbox; an ALREADY-ABSOLUTE file_path passes through
 *  unchanged (path.resolve's own semantics — a later absolute segment wins —
 *  matching materialize()/sandboxPath()'s existing behaviour, so the two
 *  never disagree about the same path). `join` was WRONG here (round-2
 *  review finding): join('/sandbox', '/abs/path') concatenates rather than
 *  replacing, producing a doubled, nonexistent path and silencing the hook
 *  entirely — never a partial credit, a bare miss indistinguishable from a
 *  real one. */
function resolveGoldenStdin(fixture, sandboxDir) {
  const payload = JSON.parse(JSON.stringify(fixture.payload ?? {}));
  if (payload.tool_input && typeof payload.tool_input.file_path === 'string') {
    payload.tool_input.file_path = resolve(sandboxDir, payload.tool_input.file_path);
  }
  return { cwd: sandboxDir, session_id: 'oracle-golden', hook_event_name: fixture.event, ...payload };
}

/** The touched path, REPO-RELATIVE to sandboxDir, derived from the RESOLVED
 *  stdin (never the raw fixture spelling, which may already be absolute) —
 *  the only form `isEligibleForRel` can compare against a record's own
 *  repo-relative file_keys/files claim. null when the resolved path falls
 *  outside the sandbox entirely (never eligible for anything). */
function goldenRelFromStdin(stdin, sandboxDir) {
  const abs = stdin?.tool_input?.file_path;
  if (typeof abs !== 'string') return null;
  const root = resolve(sandboxDir);
  const p = resolve(abs);
  if (p === root) return '.';
  if (!p.startsWith(root + sep)) return null;
  return p.slice(root.length + 1).split(sep).join('/');
}

function goldenRel(fixture) {
  const fp = fixture.payload?.tool_input?.file_path;
  return typeof fp === 'string' ? fp : null;
}

// A MISS ON A GOLDEN SCENARIO IS THE FINDING THIS LAYER EXISTS FOR — a cap
// evicting the very fix an incident recorded is a real regression, never
// relabelled as a false positive of the oracle. But a miss still has TWO
// distinct CAUSES an operator needs told apart (roster review round 2, item
// 1): the record was never even a candidate for this path (a stale/wrong
// fixture), or it WAS a candidate and a rendering CAP evicted it. The second
// is a RANKING finding — the hook did not fail, its pointer budget did not
// stretch to an old-but-still-true fix on a heavily-decisioned file — never
// a hook fault.

/** Two known disclosure-tail SHAPES report suppression: H19's direct
 *  decision/hazard-pointer tail "… N more NOT shown (cap N)"
 *  (scripts/hooks/lib/delivery.mjs renderDecisionPointers/renderHazards) and
 *  H23's queue tail "(+N more matched)" (decision 284fc4b0). Only the first
 *  names its own cap; the second's cap is a caller-known constant, so `cap`
 *  is null there rather than guessed. */
function extractSuppressionTail(text) {
  const s = String(text ?? '');
  const notShown = s.match(/…\s*(\d+)\s*more(?:\s+\S+)*\s+NOT shown\s*\(cap\s*(\d+)\)/);
  if (notShown) return { suppressed_count: Number(notShown[1]), cap: Number(notShown[2]) };
  const tail = s.match(/\(\+(\d+) more matched\)/);
  if (tail) return { suppressed_count: Number(tail[1]), cap: null };
  return null;
}

/** Was `id` a genuine CANDIDATE for `rel` — i.e. does the record's OWN claim
 *  (files[]/location/file_keys, whichever its type carries) name this exact
 *  path? Reads the raw claim directly rather than re-querying with a cap, so
 *  this answers "was it ever in scope" independent of any rendering budget. */
function isEligibleForRel(store, id, rel) {
  if (!store || !rel) return false;
  const record = store.get(id);
  if (!record) return false;
  if (record.type === 'decision' || record.type === 'anti_pattern') {
    return Array.isArray(record.file_keys) && record.file_keys.includes(rel);
  }
  if (record.type === 'feature_article') {
    return Array.isArray(record.files) && record.files.some((f) => f?.path === rel);
  }
  if (record.type === 'reference_material') {
    return record.location === rel;
  }
  return false;
}

/** Replays every golden fixture against the SAME sandbox/store the rest of
 *  the run already built (real ids, real store — see the module comment
 *  above). Each fixture gets a freshly wiped, freshly restored sandbox, same
 *  as every other case in this file, so one fixture's state can never leak
 *  into the next. A queued (not directly rendered) delivery is followed
 *  through the drain, mirroring the H19/H19_BASH cases' own `drain: true`
 *  convention. ID-ONLY matching (no token/slug fallback): every golden
 *  expectation names a real production uuid, which every delivery channel
 *  this oracle mirrors renders literally. */
// NO `repoRoot` OPTION HERE, deliberately (round-2 review finding: an API
// defect, not a test mistake). `deriveExpected`'s `repoRoot` names the
// AUDITED PROJECT; a same-named option here was read the same way by a
// test-writer blind to the implementation, but this function needs the
// CLONE root instead — where hooks/*.mjs actually live — which is always the
// module-level `repoRoot` constant above and never varies per call. Taking
// it as a caller option only invited exactly this confusion, so hook
// resolution now ALWAYS uses the module constant; nothing a caller can pass
// changes it.
/** Minimal, SYNCHRONOUS, read-only `.get(id)` shim over the records table.
 *  Deliberately NOT SterlingStore: that class only loads via a dynamic
 *  `import()`, which is asynchronous and would force this function's whole
 *  call signature to become async — breaking every existing SYNCHRONOUS
 *  caller for the sake of one optional fallback path. node:sqlite's
 *  DatabaseSync is already a static, synchronous import at the top of this
 *  file; this shim exists ONLY to answer `isEligibleForRel` and is never a
 *  general store surface.
 *
 *  IT SELECTS `body, scope` AND DECODES THROUGH THE STORE'S OWN EXPORTED
 *  DECODER (decision
 *  [path-claims-are-leaf-or-absent-directory-claims-refused-at-the-tool-write-boundary],
 *  the residual it closes). It previously selected `body` alone and
 *  JSON.parse'd it, which materialises a LIVE record carrying whatever scope
 *  the body happens to hold — the exact body/column disagreement
 *  column-authoritative reads exist to make unrepresentable. */
function openFallbackReader(snapshotDb) {
  const db = new DatabaseSync(snapshotDb, { readOnly: true });
  const stmt = db.prepare('SELECT body, scope FROM records WHERE id = ?');
  return {
    get(id) {
      const row = stmt.get(id);
      return row ? decodeLiveRecordRow('delivery-oracle fallback reader', row) : undefined;
    },
    close() { db.close(); },
  };
}

export function runGoldenFixtures(fixtures, { sandboxDir, snapshotDb, store }) {
  // `store` is an OPTIONAL reuse of the caller's already-open handle on the
  // same snapshot (main()'s own call always has one); when absent this opens
  // its OWN read-only fallback rather than silently degrading every
  // eligibility check to false (round-2 review finding: a caller that never
  // passed `store` made every miss read as 'not_delivered', permanently
  // hiding the cap_evicted arm this function exists to report).
  const ownStore = store ? null : openFallbackReader(snapshotDb);
  const effectiveStore = store ?? ownStore;
  try {
    return fixtures.map((fixture) => runOneGoldenFixture(fixture, { sandboxDir, snapshotDb, store: effectiveStore }));
  } finally {
    if (ownStore) ownStore.close();
  }
}

function runOneGoldenFixture(fixture, { sandboxDir, snapshotDb, store }) {
    const root = repoRoot;
    const hooks = hooksForGolden(fixture.event, fixture.payload?.tool_name);
    const base = {
      file: fixture.file, source_incident: fixture.source_incident,
      expected_ids: fixture.expected_ids, expected_absent_ids: fixture.expected_absent_ids,
    };
    if (!hooks.length) {
      return {
        ...base, observed_ids: [], pass: false,
        harness_error: `no delivery hook is known for event '${fixture.event}' + tool '${fixture.payload?.tool_name}' — the fixture cannot be replayed`,
      };
    }
    resetSandbox(sandboxDir, {});
    restoreStore(sandboxDir, snapshotDb);
    const rawRel = goldenRel(fixture);
    if (rawRel) materialize(sandboxDir, rawRel);
    const stdin = resolveGoldenStdin(fixture, sandboxDir);
    // REPO-RELATIVE, from the RESOLVED stdin — never the raw fixture spelling,
    // which may already be absolute (round-2 review finding: comparing an
    // absolute path against a record's repo-relative file_keys always fails,
    // permanently misclassifying every cap_evicted miss as not_delivered).
    const rel = goldenRelFromStdin(stdin, sandboxDir) ?? rawRel;
    let observed = [];
    let allText = '';
    let queuedAny = false;
    let harness_error;
    for (const hook of hooks) {
      const parsed = parseDelivery(runHook(root, hook, stdin, sandboxDir), sandboxDir);
      // ABNORMAL SHAPES FAIL LOUD — same rule the case runner applies: an exit
      // code outside the hook contract (0 allow / 1 warn / 2 deny) means the
      // fixture was NOT MEASURED, never a silent pass with an empty observed set.
      if (!parsed.harness_error && ![0, 1, 2].includes(parsed.exit_code)) {
        harness_error = harness_error ?? `${hook}: abnormal hook exit ${parsed.exit_code} (contract is 0 allow / 1 warn / 2 deny)`;
      }
      if (parsed.harness_error) harness_error = harness_error ?? `${hook}: ${parsed.harness_error}`;
      observed = uniq([...observed, ...(parsed.rendered_ids ?? []), ...parsed.denied_ids, ...parsed.queued_ids]);
      allText += `\n${parsed.rendered_text ?? ''}\n${parsed.stderr_text ?? ''}\n${parsed.queued_text ?? ''}`;
      if (parsed.queued_entries) queuedAny = true;
    }
    if (queuedAny) {
      const drainParsed = parseDelivery(
        runHook(root, DRAIN, { cwd: sandboxDir, hook_event_name: 'UserPromptSubmit', session_id: 'oracle-golden' }, sandboxDir),
        sandboxDir
      );
      if (!drainParsed.harness_error && ![0, 1, 2].includes(drainParsed.exit_code)) {
        harness_error = harness_error ?? `${DRAIN}: abnormal hook exit ${drainParsed.exit_code} (contract is 0 allow / 1 warn / 2 deny)`;
      }
      if (drainParsed.harness_error) harness_error = harness_error ?? `${DRAIN}: ${drainParsed.harness_error}`;
      observed = uniq([...observed, ...(drainParsed.rendered_ids ?? [])]);
      allText += `\n${drainParsed.rendered_text ?? ''}`;
    }
    const missing_ids = fixture.expected_ids.filter((id) => !observed.includes(id));
    const absent_violations = (fixture.expected_absent_ids ?? []).filter((id) => observed.includes(id));
    const pass = !harness_error && missing_ids.length === 0 && absent_violations.length === 0;

    // MISS REASON (roster review round 2, item 1) — computed PER MISSING ID,
    // never overriding `pass` (the audit's own verdict). A cap eviction of a
    // real candidate is the ranking finding this layer exists to surface,
    // distinguished from a record that was never even a candidate for this
    // path (a stale or mis-targeted fixture). `misses` is keyed BY ID — a
    // miss must be a reportable OBJECT, not folded into a single fixture-wide
    // verdict, because two expected ids on the same fixture can miss for two
    // DIFFERENT reasons and each needs its own cause named.
    const tail = missing_ids.length ? extractSuppressionTail(allText) : null;
    const misses = {};
    let miss_reason; // dominant summary: 'cap_evicted' if ANY id is, else 'not_delivered'
    for (const id of missing_ids) {
      const evicted = Boolean(tail) && isEligibleForRel(store, id, rel);
      if (evicted) {
        misses[id] = { miss_reason: 'cap_evicted', rendered: observed.length, suppressed_count: tail.suppressed_count, cap: tail.cap };
        miss_reason = 'cap_evicted';
      } else {
        misses[id] = { miss_reason: 'not_delivered' };
        miss_reason = miss_reason ?? 'not_delivered';
      }
    }

    return {
      ...base, observed_ids: observed, missing_ids, absent_violations, pass,
      ...(missing_ids.length ? { miss_reason, misses } : {}),
      ...(harness_error ? { harness_error } : {}),
    };
}

async function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : fallback;
  };
  const projectRoot = arg('--project', process.cwd());
  const probeDir = arg('--probes', join(repoRoot, 'scripts', 'tests', 'fixtures', 'delivery-probes'));
  const goldenDir = arg('--golden', join(repoRoot, 'scripts', 'tests', 'fixtures', 'delivery-golden'));
  const dbPath = join(projectRoot, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) {
    console.error(`delivery-oracle: no Sterling store at ${dbPath} — not an initialized project`);
    process.exit(1);
  }
  const config = existsSync(join(projectRoot, '.sterling', 'config.json'))
    ? JSON.parse(readFileSync(join(projectRoot, '.sterling', 'config.json'), 'utf8'))
    : {};
  const rung = config?.delivery?.injection_rung ?? 'prompt';

  const { SterlingStore } = await import(join(repoRoot, 'packages', 'store', 'dist', 'index.js'));

  // SNAPSHOT (VACUUM INTO — never a file copy; the live store is WAL) through a
  // READ-ONLY handle, and through NOTHING ELSE. SterlingStore's constructor
  // opens WRITABLE and runs PRAGMA + DDL, and a writable open on a WAL database
  // MUTATES the main file when it closes (anti_pattern 8616e72d) — an audit
  // that claims to be read-only must not be able to write to the store it
  // audits on ANY branch, so there is deliberately NO writable fallback: a
  // failed read-only open ABORTS the run.
  //
  // SIDECARS ARE NEVER DELETED, and this deliberately departs from 8616e72d's
  // conditional-cleanup recipe. That recipe records whether -wal/-shm existed
  // BEFORE the open and removes what it did not see; against a LIVE store that
  // is a race — a concurrent writer (the MCP server) can create the WAL between
  // the check and the unlink, and the audit would then delete a live WAL
  // holding another process's committed-but-uncheckpointed frames. The record's
  // own principle (never touch what you did not create) is better served here
  // by not deleting at all: a sidecar this open materialized is DISCLOSED and
  // left in place, which costs an empty file and risks nothing.
  const snapDir = mkdtempSync(join(tmpdir(), 'sterling-oracle-snap-'));
  const snapshotDb = join(snapDir, 'snapshot.db');
  const snapshot_mode = 'read_only';
  const hadWal = existsSync(`${dbPath}-wal`);
  const hadShm = existsSync(`${dbPath}-shm`);
  try {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      ro.exec(`VACUUM INTO '${snapshotDb.replace(/'/g, "''")}'`);
    } finally {
      ro.close();
    }
  } catch (e) {
    console.error(
      `delivery-oracle: READ-ONLY snapshot of ${dbPath} failed — ${e.message}\n` +
        '  ABORTING. There is no writable fallback by design: a writable open mutates the live WAL store on close ' +
        '(anti_pattern 8616e72d), and a read-only audit that can write to its own subject measures nothing.'
    );
    rmSync(snapDir, { recursive: true, force: true });
    process.exit(1);
  }
  const sidecarsCreated = [
    ...(!hadWal && existsSync(`${dbPath}-wal`) ? ['-wal'] : []),
    ...(!hadShm && existsSync(`${dbPath}-shm`) ? ['-shm'] : []),
  ];
  if (sidecarsCreated.length) {
    process.stderr.write(
      `delivery-oracle: the read-only open materialized ${sidecarsCreated.join(' and ')} beside ${dbPath} and LEFT them in place ` +
        '(deleting a sidecar a concurrent writer may own is the greater risk). Harmless; remove them yourself only with no writer running.\n'
    );
  }
  const store = new SterlingStore(snapshotDb);

  const at = new Date().toISOString();
  const entries = deriveExpected(store, { repoRoot: projectRoot });
  const cases = entries.filter((e) => e.kind === 'case');
  const exclusions = entries.filter((e) => e.kind === 'exclusion');
  // A MISSING OR EMPTY PROBE DIRECTORY IS A NAMED FINDING, not a quiet drop:
  // with no probes the H20 arm produces no per_hook key at all, so the report
  // reads as "H20 was not part of this audit" when the truth is "the subject
  // half of the audit went missing". Recorded as an exclusion, in the same
  // account-for-it-by-name discipline every other skipped path gets.
  let probes = [];
  if (!existsSync(probeDir)) {
    exclusions.push({ kind: 'exclusion', rel: probeDir, record_id: null, reason: 'probe_dir_missing' });
  } else {
    probes = loadProbes(probeDir);
    if (!probes.length) {
      exclusions.push({ kind: 'exclusion', rel: probeDir, record_id: null, reason: 'probe_dir_empty' });
    }
  }

  // A MISSING OR EMPTY GOLDEN DIRECTORY IS ALSO A NAMED FINDING — layer 2
  // (board ab288113) going missing must never read as "no known incidents",
  // same discipline as the probe directory above.
  let goldenFixtures = [];
  if (!existsSync(goldenDir)) {
    exclusions.push({ kind: 'exclusion', rel: goldenDir, record_id: null, reason: 'golden_dir_missing' });
  } else {
    goldenFixtures = loadGoldenFixtures(goldenDir);
    if (!goldenFixtures.length) {
      exclusions.push({ kind: 'exclusion', rel: goldenDir, record_id: null, reason: 'golden_dir_empty' });
    }
  }

  // SNAPSHOT DIGEST over the snapshot BYTES — the board's first branch, taken
  // because VACUUM INTO was MEASURED byte-deterministic (2026-09-05, this
  // repo's packages/store: three consecutive snapshots of an unchanged source
  // store hashed identically, and a second PROCESS building the same records
  // reproduced the same hash). One measured caveat, deliberately accepted: a
  // snapshot OF a snapshot does NOT match its source snapshot, so these bytes
  // track the source store's write history and not only its logical content —
  // any store write moves the run identity. That is why compareRuns diffs per
  // CASE by fixture_id + expected_hash and never bails on a changed identity.
  const snapshotDigest = sha(readFileSync(snapshotDb)).slice(0, 16);
  const bundle = bundleHash(repoRoot);

  const sandbox = buildSandbox(snapshotDb, config);
  const scored = [];
  let golden = [];
  try {
    // MATCH MODE, RECORDED PER ID (never collapsed to a boolean). A record
    // counts as DELIVERED when the channel names its uuid ('id') or renders it
    // under its quoted lineage token on a DELIVERY MARKER LINE ('token' — H19
    // prints "▸ article 'slug'" and need not repeat the uuid in the body).
    // The token arm is a known false-recall route: slugs are cited in ordinary
    // prose by convention, so it is anchored to a marker line AND every
    // token-only verdict is written to the report as match_modes[id]='token'
    // for audit. An id-mode verdict needs no such scrutiny.
    const tokenOf = (id) => {
      const r = store.get(id);
      const t = r?.slug ?? r?.title;
      return t ? `'${t}'` : null;
    };
    const markerLines = (text) => String(text ?? '').split('\n').filter((l) => l.includes('▸') || l.includes('knowledge_get'));
    const hitMode = (id, ids, text) => {
      if (ids.includes(id)) return 'id';
      const token = tokenOf(id);
      if (token && markerLines(text).some((l) => l.includes(token))) return 'token';
      return null;
    };

    const run = (unit, { hook, payloadCase, expected_ids, seed_ledger, drain, probe }) => {
      // Order matters: wipe transient WHOLESALE, then seed only what this case
      // needs. resetSandbox skips the wipe for a seed_ledger case, so the seed
      // is written first and survives.
      if (seed_ledger) rmSync(join(sandbox, '.sterling', 'transient'), { recursive: true, force: true });
      const seeded = seed_ledger ? seedPriorDenial(sandbox, probe?.expect_deny_ids) : null;
      resetSandbox(sandbox, { seed_ledger });
      restoreStore(sandbox, snapshotDb);

      const { stdin, sandbox_writes } = synthesizePayload(payloadCase, { cwd: sandbox, session_id: 'oracle-session' });
      applyWrites(sandbox, sandbox_writes);
      const parsed = parseDelivery(runHook(repoRoot, hook, stdin, sandbox), sandbox);
      let drained_ids = [];
      let drained_text = '';
      let drain_error;
      let drain_exit;
      // Drain on QUEUE ENTRIES, not on parsed ids: an entry whose ids we could
      // not read is exactly the one worth following to the drain.
      if (drain && parsed.queued_entries) {
        const drainParsed = parseDelivery(runHook(repoRoot, DRAIN, { cwd: sandbox, hook_event_name: 'UserPromptSubmit', session_id: 'oracle-session' }, sandbox), sandbox);
        drained_ids = drainParsed.rendered_ids ?? [];
        drained_text = drainParsed.rendered_text ?? '';
        drain_exit = drainParsed.exit_code;
        // THE DRAIN IS A HOOK RUN LIKE ANY OTHER and gets the same abnormality
        // rule. Without this, unparseable drain stdout reads as "nothing
        // drained" (blaming delivery for a harness fault) and a drain that
        // crashed after printing matching text still scored drained:true.
        if (drainParsed.harness_error) drain_error = `drain: ${drainParsed.harness_error}`;
        else if (![0, 1, 2].includes(drainParsed.exit_code)) {
          drain_error = `drain: abnormal exit ${drainParsed.exit_code} (contract is 0 allow / 1 warn / 2 deny)`;
        }
      }
      const rendered_ids = parsed.rendered_ids ?? [];
      const directIds = uniq([...rendered_ids, ...parsed.denied_ids]);
      const directText = `${parsed.rendered_text}\n${parsed.stderr_text}`;
      const observed = uniq([...directIds, ...parsed.queued_ids, ...drained_ids]);
      const allText = `${directText}\n${parsed.queued_text}\n${drained_text}`;

      // ABNORMAL SHAPES FAIL LOUD, and a loud failure is never a pass: an exit
      // code outside the hook contract (0 allow / 1 warn / 2 deny) or stdout we
      // could not parse means the case was NOT MEASURED.
      let harness_error = parsed.harness_error;
      if (!harness_error && ![0, 1, 2].includes(parsed.exit_code)) {
        harness_error = `abnormal hook exit ${parsed.exit_code} (contract is 0 allow / 1 warn / 2 deny)`;
      }
      harness_error = harness_error ?? drain_error;

      const match_modes = {};
      for (const id of expected_ids) match_modes[id] = hitMode(id, observed, allText);
      // ⚠ NOT CAP-AWARE — this is the OTHER half of the latent defect recorded
      // at deriveOutputAxisExpected. `every` demands that EVERY expected id be
      // observed, which is right for H19/H20 (they render the whole set) and
      // WRONG for h23-output-axis, whose OUTPUT_AXIS_POINTER_CAP = 1 renders one
      // pointer plus a "(+N more matched)" tail by ruling (decision
      // h23-kept-raised-threshold-one-pointer-payload, 284fc4b0). No output_axis
      // case reaches here today (main() supplies no `outputAxisProbes`), so the
      // false MISS is latent. WIRING PROBES INTO main() REQUIRES CHANGING THIS
      // FIRST: covered up to the cap, with parseDelivery's per-entry
      // `suppressed_count` reconciling the remainder — never a bare `every`.
      const covers = (ids, text) => expected_ids.length > 0 && expected_ids.every((id) => hitMode(id, ids, text) !== null);

      let rendered = covers(directIds, directText);
      let drainedOk = covers(drained_ids, drained_text);
      let deny_expectation;
      let absent_violations;

      // H10 IS NOT A DELIVERY HOOK — it is the ownership half of the agreement
      // check (H10 cap 25 vs H19 cap 100), so its verdict is INVERTED: the path
      // passes when H10's demand does NOT name it as unowned territory.
      // THE INVERSION NEEDS A LIVENESS ARM, or "H10 emitted nothing" (a spent
      // capture-nagged marker, a crash, a store it could not read) scores
      // identically to "H10 considers this path owned" — silence would PASS.
      // The demand block prints H10_DUTIES_MARKER whenever it fires, and this
      // case always arms a capture duty (touches.json seeded, nothing captured)
      // against a freshly-wiped transient, so the marker MUST be present.
      if (unit.payload_kind === 'h10_ownership') {
        drainedOk = false;
        const demand = directText;
        if (!demand.includes(H10_DUTIES_MARKER)) {
          harness_error = harness_error
            ?? `H10 emitted no duties block (expected "${H10_DUTIES_MARKER}") — the ownership verdict is UNMEASURED, not a pass`;
          rendered = false;
        } else {
          const namedUnowned = demand
            .split('\n')
            .some((line) => line.includes(unit.rel) && /unowned|owning article|article_missing/i.test(line));
          // THE UNOWNED CONTROL INVERTS THE INVERSION. Every other H10 case
          // passes when the path is NOT called unowned, which a predicate stuck
          // at "everything is owned" satisfies perfectly. This arm must pass for
          // the OPPOSITE reason — a path no record claims MUST be named — so the
          // two arms together can only both pass if H10 is really discriminating.
          rendered = unit.control === 'unowned' ? namedUnowned : !namedUnowned;
        }
      }

      // PROBE EXPECTATIONS ARE SCORED, not merely validated: a deny that never
      // came, a denial that named the wrong ruling, and a record that was
      // supposed to STAY AWAY all change the verdict (the negative arm is the
      // whole precision control — a probe whose absent-ids fire is a finding).
      if (probe) {
        const denyOk = probe.expect_deny
          ? parsed.denied && (probe.expect_deny_ids ?? []).every((id) => hitMode(id, parsed.denied_ids, parsed.stderr_text) !== null)
          : !parsed.denied;
        // A NEGATIVE PROBE IS FALSIFIED BY ANY DELIVERY, not only by the ids it
        // happened to enumerate. expected_absent_ids names what the author
        // specifically feared; a probe that expects NOTHING and receives some
        // other record has still fired on ungoverned territory, and scoring
        // that as a pass makes the precision control unfalsifiable — the exact
        // "cannot fail the way retrieval fails" defect the probe contract bans.
        const isNegative = expected_ids.length === 0;
        const violations = uniq([
          ...(probe.expected_absent_ids ?? []).filter((id) => hitMode(id, observed, allText) !== null),
          ...(isNegative ? observed : []),
        ]);
        deny_expectation = denyOk ? 'met' : 'violated';
        absent_violations = violations;
        const deliveryOk = expected_ids.length ? (rendered || drainedOk) : true;
        rendered = deliveryOk && denyOk && violations.length === 0;
      }

      if (harness_error) { rendered = false; drainedOk = false; }

      const delivered_ids = uniq([
        ...expected_ids.filter((id) => match_modes[id] !== null),
        ...observed.filter((id) => !expected_ids.includes(id)),
      ]);
      const caseObj = {
        ...unit,
        hook,
        expected_ids,
        // The hash covers the PAYLOAD and the probe's deny/absent expectations
        // too — change any of them and this is a different question, reported as
        // expectation_changed rather than as a regression.
        expected_hash: expectedHash(expected_ids, {
          expect_deny: probe?.expect_deny,
          expect_deny_ids: probe?.expect_deny_ids,
          expected_absent_ids: probe?.expected_absent_ids,
          payload: sha(JSON.stringify(stdin)).slice(0, 16),
        }),
        eligible: expected_ids.length > 0,
        queued: parsed.queued_entries > 0,
        rendered,
        drained: drainedOk,
        ...(drain_exit === undefined ? {} : { drain_exit }),
        delivered_ids,
        match_modes,
        // EXTRA is not automatically a precision fault: H19 delivers one-hop
        // relies_on/relied_by pointers beside the owning article, and those
        // uuids are correct delivery this expectation never named. Read a
        // non-empty `extra` as "explain these", not as "the hook over-fired".
        extra: delivered_ids.filter((id) => !expected_ids.includes(id)),
        exit_code: parsed.exit_code,
        channel: parsed.channel,
        denied: parsed.denied,
        ...(seeded ? { seeded_prior_denial: seeded } : {}),
        ...(deny_expectation ? { deny_expectation } : {}),
        ...(absent_violations ? { absent_violations } : {}),
        ...(harness_error ? { harness_error } : {}),
      };
      return { ...caseObj, case_identity: caseIdentity(caseObj) };
    };

    for (const c of cases) {
      materialize(sandbox, c.rel);
      scored.push(run(
        { fixture_id: c.fixture_id, rel: c.rel, payload_kind: c.payload_kind },
        { hook: c.hook, payloadCase: c, expected_ids: c.expected_ids, drain: true }
      ));
    }
    // THE UNOWNED CONTROL, one per run (never derived from the store — the
    // point is a path NO record claims). Without it, every h10_ownership verdict
    // in the report is satisfiable by an ownership predicate that answers
    // "owned" to everything, and the whole H10 arm would read green while
    // measuring nothing.
    // A control claimed by a record would not be a control. Named loudly if so.
    let controlRel = 'src/oracle-unowned-control.mjs';
    if (cases.some((c) => c.rel === controlRel)) controlRel = `src/oracle-unowned-control-${Date.now()}.mjs`;
    const controlCase = { kind: 'case', payload_kind: 'h10_ownership', rel: controlRel };
    materialize(sandbox, controlRel);
    scored.push(run(
      { fixture_id: `${H10}:h10_ownership_control:${controlRel}`, rel: controlRel, payload_kind: 'h10_ownership', control: 'unowned' },
      { hook: H10, payloadCase: controlCase, expected_ids: [], drain: false }
    ));

    for (const p of probes) {
      scored.push(run(
        { fixture_id: p.id, rel: null, payload_kind: p.kind, expect_deny: p.expect_deny },
        { hook: 'h20-mechanism-axis.mjs', payloadCase: p, expected_ids: p.expected_ids, seed_ledger: p.seed_ledger, drain: false, probe: p }
      ));
    }

    // GOLDEN SCENARIOS (layer 2, board ab288113) replay against this SAME
    // sandbox/snapshot — real store, real record ids, no synthetic fixture
    // repo. Each fixture wipes and re-restores the sandbox itself (see
    // runGoldenFixtures), matching the isolation every case/probe above gets.
    // repoRoot (the CLONE root, where hooks/*.mjs actually live) — NOT
    // projectRoot, which is the audited project and may differ under
    // --project. Same rule runHook already follows for every other case.
    golden = runGoldenFixtures(goldenFixtures, { sandboxDir: sandbox, snapshotDb, store });
  } finally {
    store.close();
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  }

  // The delivery-relevant config travels in the identity: payload_char_cap and
  // the article/hazard caps change what a hook renders, so two runs that differ
  // only there are not comparable and must not share an identity.
  const configDigest = sha(JSON.stringify({
    delivery: config?.delivery ?? null,
    article_demand: config?.article_demand ?? null,
  })).slice(0, 16);
  const identity = {
    snapshot_digest: snapshotDigest, bundle_hash: bundle, rung,
    oracle_version: ORACLE_VERSION, snapshot_mode, config_digest: configDigest,
  };
  const prior = newestPriorRun(projectRoot);
  const transitions = prior
    ? compareRuns(prior, { identity, cases: scored })
    : { pass_to_miss: [], miss_to_pass: [], expectation_changed: [], unmeasured: [] };
  const report = {
    schema: 1, at, identity,
    cases: scored,
    exclusions,
    metrics: metrics(scored),
    transitions,
    golden,
  };
  const { run_path, history_path } = writeRunReport(projectRoot, report);

  // THE VERDICT, and it is an EXIT CODE — not a number the reader has to notice.
  // A failed CONTROL means the audit's own discrimination is gone (every H10
  // verdict is then satisfiable by a predicate that answers "owned" to
  // everything), and a harness error means part of the run was never measured.
  // Both are conditions under which the ratios above must not be believed, so
  // neither may exit 0. Probe VERDICTS are surfaced but do NOT fail the run:
  // a probe miss is a finding about delivery, which is the thing being measured.
  const controls = scored.filter((c) => c.control);
  const controlFailures = controls.filter((c) => !c.rendered && !c.harness_error);
  // A golden fixture's harness_error (e.g. an event/tool this oracle has no
  // known hook route for) is a HARNESS defect, not a delivery finding — it
  // means the fixture was never measured, the same rule cases already follow.
  // A plain golden MISS (a known route, delivery just didn't happen) is
  // surfaced but does NOT gate the exit code, mirroring the probe convention:
  // it is a finding ABOUT delivery, which is the thing being measured.
  const harnessErrors = [...scored.filter((c) => c.harness_error), ...golden.filter((g) => g.harness_error)];

  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`delivery-oracle: ${scored.length} case(s), ${exclusions.length} exclusion(s) — ${run_path}`);
    for (const [hook, m] of Object.entries(report.metrics.per_hook)) {
      const fmt = (v) => (v === null ? 'n/a' : v.toFixed(2));
      const unmeasured = m.harness_errors ? ` · UNMEASURED ${m.harness_errors}` : '';
      console.log(`  ${hook}: rendered ${fmt(m.rendered_recall)} · eventual ${fmt(m.eventual_recall)} · drained ${fmt(m.drained_recall)} · precision ${fmt(m.precision)} (n=${m.measured})${unmeasured}`);
    }
    for (const c of controls) {
      console.log(`  control [${c.control}] ${c.fixture_id}: ${c.harness_error ? 'UNMEASURED' : c.rendered ? 'holds' : 'FAILED'}`);
    }
    for (const c of scored.filter((x) => x.deny_expectation)) {
      const bits = [c.rendered ? 'pass' : 'MISS', `deny ${c.deny_expectation}`];
      if (c.absent_violations?.length) bits.push(`ABSENT-VIOLATED ${c.absent_violations.length}`);
      console.log(`  probe ${c.fixture_id}: ${bits.join(' · ')}`);
    }
    for (const x of exclusions.filter((e) => e.reason.startsWith('probe_dir'))) {
      console.log(`  PROBE SET: ${x.reason} (${x.rel}) — the H20 arm did not run`);
    }
    for (const x of exclusions.filter((e) => e.reason.startsWith('golden_dir'))) {
      console.log(`  GOLDEN SET: ${x.reason} (${x.rel}) — layer 2 did not run`);
    }
    for (const g of golden) {
      const verdict = g.harness_error ? 'UNMEASURED' : g.pass ? 'pass' : 'MISS';
      console.log(`  golden ${g.file}: ${verdict} — ${g.source_incident}`);
    }
    if (harnessErrors.length) {
      console.log(`  HARNESS ERRORS: ${harnessErrors.length} case(s) NOT MEASURED (excluded from every ratio above)`);
      for (const c of harnessErrors) console.log(`    ${c.fixture_id ?? c.file}: ${c.harness_error}`);
    }
    if (controlFailures.length) console.log(`  CONTROL FAILED: ${controlFailures.map((c) => c.fixture_id).join(', ')} — the audit cannot discriminate; treat every verdict above as unproven`);
    if (transitions.pass_to_miss.length) console.log(`  REGRESSIONS: ${transitions.pass_to_miss.join(', ')}`);
    if (transitions.expectation_changed.length) console.log(`  expectation changed (not a regression): ${transitions.expectation_changed.length}`);
    if (transitions.unmeasured?.length) console.log(`  unmeasured this run (not a regression): ${transitions.unmeasured.length}`);
    console.log(`  history: ${history_path}`);
  }

  if (controlFailures.length || harnessErrors.length) process.exitCode = 1;
}

// Executed directly (never on import — the frozen pins import this module).
// existsSync FIRST: statSync throws on an argv[1] that is not on disk.
if (process.argv[1] && existsSync(process.argv[1]) && statSync(process.argv[1]).isFile()
    && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}

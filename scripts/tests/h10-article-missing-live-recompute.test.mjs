// H10 article-demand lane: an open `article_missing` item is a LIVE view of the
// unowned set, never a persisted snapshot that is re-stamped forward.
//
// SPEC UNDER TEST — board ef206eca, reproduced 2026-08-28. Governing AC is AC9 of
// feature_article `h10-direct-capture-gate` (v101): "the deferred demand survives
// as an article_missing item deduped by file-key overlap; creating the owning
// article clears it mechanically on the next Stop".
//
// The ownership question itself is answered LIVE and correctly (h10-direct-capture.mjs
// ~:1068-1069 queries the store and flips the instant an owning article lands) — that
// is NOT the defect. The defect is the re-mint: the dedup path finds an OPEN
// article_missing item overlapping on ONE file key (~:1310-1312) and re-supplies THAT
// ITEM'S OWN file_keys (~:1327) instead of the live unowned set. Nothing else ever
// re-verifies that snapshot: `article_missing` is deliberately outside
// UPDATE_RESOLVABLE_LANES (packages/mcp-server/src/tools.ts ~:3323) and never
// auto-drains (~:5186), and H1 only COUNTS open items per lane (~:895). So the
// snapshot is actively re-stamped forward, and it fails in BOTH directions:
//
//   OVER-REPORT (the reported, dangerous one): a file that has since gained an
//     owning article keeps being named. The lane's own prescribed remedy is "create
//     the owning article" — following it for an already-owned file writes exactly the
//     duplicate the reconcile discipline exists to prevent. STORE CORRUPTION.
//   UNDER-REPORT (falls out of the same line, and is the WORSE failure mode): a
//     genuinely unowned file that appears after the item was minted is silently
//     DROPPED from it. A demand surface that under-reports is worse than one that
//     over-reports — an over-report costs attention, an under-report costs the record
//     entirely and nothing else will ever raise it.
//
// The CONTROL arms are placed FIRST and deliberately: "an article_missing item stopped
// naming file X" has more than one possible cause, and a suppression that deletes the
// lane — or one that can only ever SHRINK file_keys — satisfies the over-report arm
// while destroying the surface. A green target arm is only evidence when the control
// arms are green for the opposite reason.
//
// FROZEN / SPEC-ONLY: authored blind against the diagnosis, not against the fix. If a
// test here is wrong, that is evidence for the conductor, not an edit.
//
// DELIBERATELY NOT PINNED (design is silent — see the report): (a) the item's
// human-facing `text`, which no existing suite pins for this lane; (b) union-vs-replace
// semantics for a previously-named file that is STILL unowned but NOT touched in the
// later session. Every fixture below keeps those two semantics in agreement, so no
// test here forces that call.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function envelope(type, at) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function makeH10Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-artmiss-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

/** Simulates a session's file-touch register — files that exist, at a given time. */
function touchRegister(dir, paths, at) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function captureDecision(store, at) {
  return store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

function article(store, slug, files, at) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);

const demands = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'article_missing');

/** Every path named by any OPEN article_missing item — the set a drain would act on. */
const demandedPaths = (store) => [...new Set(demands(store).flatMap((d) => d.file_keys ?? []))].sort();

/** One encounter = nag Stop (soft-block once, P1) then release Stop (mints/updates). */
function encounter(dir, store, paths, at, { expectNag = true } = {}) {
  touchRegister(dir, paths, at);
  captureDecision(store, at); // satisfies the CAPTURE duty so only the ARTICLE demand is in play
  const first = stop(dir);
  if (expectNag) assert.equal(first.code, 2, `encounter @${at}: the article demand soft-blocks once`);
  const second = expectNag ? stop(dir) : first;
  assert.equal(second.code, 0, `encounter @${at}: the session releases`);
  return second;
}

// =========================================================================
// CONTROL ARMS — placed FIRST. These must be GREEN both before and after the
// fix, and they must be green for the OPPOSITE reason to the target arms: the
// lane still SEES and still NAMES genuinely unowned files. A suppression that
// deletes the lane, blanks file_keys, or only ever shrinks the set passes every
// target arm below and fails here. An article_missing lane that UNDER-REPORTS is
// worse than one that over-reports.
// =========================================================================

test('CONTROL-1: genuinely unowned territory still mints article_missing naming EVERY unowned file — an under-reporting demand lane is worse than an over-reporting one', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Nothing in the store owns anything. Three unowned touched files is the
    // default article-demand threshold.
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T09:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'CONTROL-1: the demand still FIRES — exactly one article_missing item');
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
      'CONTROL-1: the item names EVERY unowned file, not a subset — a demand that names fewer files than are unowned has silently lost the debt, and nothing else in the system will ever raise it again'
    );
  } finally {
    cleanup();
  }
});

test('CONTROL-2 (under-report arm): a file that becomes unowned AFTER the item was minted is ADDED to it — the persisted snapshot must never win over the live unowned set', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1 — three unowned files mint the item.
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T09:00:00.000Z');
    const first = demands(store);
    assert.equal(first.length, 1, 'baseline: one item after session 1');

    // Session 2 — same three files, still unowned, PLUS a fourth brand-new
    // unowned file. Nothing gained an owner, so the live unowned set strictly
    // grows and union-vs-replace semantics agree: all four are owed.
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'the overlap dedup still holds — one item, not two');
    assert.ok(
      demandedPaths(store).includes('src/d.mjs'),
      "CONTROL-2: src/d.mjs is genuinely unowned and MUST be named. Re-supplying the existing item's own file_keys instead of the live unowned set drops it forever: article_missing is outside UPDATE_RESOLVABLE_LANES, never auto-drains, and H1 only counts items per lane — so no other mechanism will ever notice this file again"
    );
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'],
      'CONTROL-2: the item names the full live unowned set'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// TARGET ARMS — the reported defect (board ef206eca): a file that HAS an owning
// feature_article listing it in files[] keeps being named by the queue, whose own
// prescribed remedy is "create the owning article". Following that remedy for an
// already-owned file writes the duplicate the reconcile discipline exists to
// prevent — the queue misleading in the CORRUPTING direction.
// =========================================================================

test('TARGET-1: a file that gains an owning feature_article is DROPPED from the open article_missing item — the queue never re-stamps a demand whose remedy would write a duplicate article', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1 — four unowned files mint one item naming all four.
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'], '2026-08-28T09:00:00.000Z');
    const first = demands(store);
    assert.equal(first.length, 1, 'baseline: one item after session 1');
    assert.ok([...first[0].file_keys].includes('src/a.mjs'), 'baseline: src/a.mjs was legitimately demanded while unowned');

    // The demand for src/a.mjs is answered the RIGHT way: an owning article that
    // lists it in files[]. The live ownership join flips immediately — the
    // question is whether the PERSISTED item follows.
    article(store, 'feat-a', ['src/a.mjs'], '2026-08-28T09:30:00.000Z');

    // Session 2 — the same four files touched. Live unowned = {b, c, d}; a is
    // owned. Nothing new appears, so this arm isolates the over-report defect
    // from the under-report one (CONTROL-2 covers that half).
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'], '2026-08-28T10:00:00.000Z');

    assert.ok(
      !demandedPaths(store).includes('src/a.mjs'),
      'TARGET-1: src/a.mjs HAS an owning feature_article listing it in files[]. No open article_missing item may still name it — the lane\'s prescribed remedy is "create the owning article", and a session that believes this demand writes a second article for a file that already has one'
    );
    assert.deepEqual(
      demandedPaths(store),
      ['src/b.mjs', 'src/c.mjs', 'src/d.mjs'],
      'TARGET-1: the item is a LIVE view of the unowned set — the three still-unowned files, and only those'
    );
    assert.equal(demands(store).length, 1, 'TARGET-1: healed in place — the stale item is not left open beside a corrected new one (two items under one subject is worse than one wrong item)');
  } finally {
    cleanup();
  }
});

test("TARGET-2 (the reproduced sequence, both arms at once): the re-minted item drops the now-owned file AND picks up the newly-unowned one — a fix that only ever shrinks file_keys is a suppression, not a fix", () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1 — A, B, C unowned; one item names all three.
    encounter(dir, store, ['src/A.mjs', 'src/B.mjs', 'src/C.mjs'], '2026-08-28T09:00:00.000Z');
    const first = demands(store);
    assert.equal(first.length, 1, 'baseline: one item after session 1');
    assert.deepEqual([...first[0].file_keys].sort(), ['src/A.mjs', 'src/B.mjs', 'src/C.mjs']);

    // A gains its owning article. The live join answers "A is owned" from here on.
    article(store, 'feat-A', ['src/A.mjs'], '2026-08-28T09:30:00.000Z');

    // Session 2 — A (now owned) is still touched; B and C still unowned; D is a
    // brand-new unowned file. Live unowned = {B, C, D}. The dedup path matches
    // the open item on the B/C overlap and returns deduped:true.
    encounter(dir, store, ['src/A.mjs', 'src/B.mjs', 'src/C.mjs', 'src/D.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'still exactly one item for this subject — overlap dedup is preserved by the fix');
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      ['src/B.mjs', 'src/C.mjs', 'src/D.mjs'],
      'TARGET-2: the item must name exactly the LIVE unowned set {B, C, D}. Today it names the stale snapshot {A, B, C}: a FALSE demand for the owned A (corrupting — its remedy writes a duplicate article) and a SILENT LOSS of the genuinely unowned D (under-report — worse, because nothing else will ever raise it). Both halves come off the same line, and a fix that answers only one of them is a suppression'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// REGRESSION NET — the already-shipped full-clear path (AC9: "creating the
// owning article clears it mechanically on the next Stop") must survive a fix
// that starts rewriting file_keys. The specific hazard: recomputing file_keys
// from the live unowned set and writing an EMPTY-keyed item instead of removing
// it — an undrainable ghost that H1 would keep counting forever.
// =========================================================================

test('NET: when every named file gains an owner the item is REMOVED, never left open with an empty file_keys list', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T09:00:00.000Z');
    assert.equal(demands(store).length, 1, 'baseline: one item after session 1');

    // One article now owns all three.
    article(store, 'feat-abc', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T09:30:00.000Z');

    // Fully owned now, so the demand does not fire at all — a single releasing Stop.
    encounter(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T10:00:00.000Z', { expectNag: false });

    assert.equal(demands(store).length, 0, 'NET: full ownership clears the item mechanically (AC9) — it is removed, not emptied');
    assert.deepEqual(demandedPaths(store), [], 'NET: and no ghost item survives naming nothing, which would be undrainable debt H1 counts forever');
  } finally {
    cleanup();
  }
});

// =========================================================================
// APPENDED 2026-08-29 — pins for four fixes that a MUTATION CHECK proved
// UNPINNED by the five arms above. Measured by the fixer: reinstating
// `.slice(0, 20)` on the healed set left the suite GREEN 5/5, and disabling
// consolidation removal left it GREEN 11/11. The cause was fixture shape, not
// assertion strength: no fixture above exceeds 4 file keys, none has two open
// items reachable from one session, none reaches the no-duty terminal release,
// and all run in non-git temp dirs where every carried name exists on disk.
//
// EVERY ARM BELOW IS EXPECTED GREEN AGAINST THE CURRENT (already-fixed) code.
// That green is NOT a no-op: each arm names, in its own comment, the ONE-LINE
// SABOTAGE that must turn it RED. An arm that stays green under its own named
// sabotage is hollow and is evidence for the conductor, not a passing test.
//
// The CONTROL arms above (CONTROL-1 mints and names EVERY unowned file; NET
// removes the item rather than emptying it) carry these arms' evidence: every
// fix pinned below is of the form "keep MORE keys", and an implementation that
// simply never removes anything satisfies all of A, B, D and E while destroying
// the lane. Read the arms below only together with those two.
//
// RESOLVES ONE OPEN QUESTION FROM THIS FILE'S HEADER: the header records that
// union-vs-replace semantics for a still-unowned but UNTOUCHED carried name were
// deliberately left unpinned because the design was silent. The fix settles it —
// a carried name leaves an item for exactly three reasons (it gained an owner, it
// is gitignored, it is absent on disk) and for no other reason, room included.
// The arms below pin that ruling. The header's other exclusion (the item's
// human-facing `text`) is now pinned in ONE narrow respect only — that the count
// the text claims and the keys it names come off the same list (arm A-3).
// =========================================================================

/**
 * Like encounter(), but tolerant about WHETHER the article demand soft-blocks
 * this session. Arms below deliberately use sessions whose live unowned set is
 * under the demand threshold (that is the whole point of the carried-key
 * ruling), and the subject of those arms is the PERSISTED item, not the nag.
 * Nag behaviour itself stays pinned by CONTROL-1/CONTROL-2/NET above.
 */
function encounterTolerant(dir, store, paths, at) {
  touchRegister(dir, paths, at);
  captureDecision(store, at); // satisfies the CAPTURE duty so only the ARTICLE lane is in play
  const first = stop(dir);
  assert.ok(first.code === 0 || first.code === 2, `encounter @${at}: H10 must release or soft-block, never crash (code ${first.code}): ${first.stderr}`);
  const last = first.code === 2 ? stop(dir) : first;
  assert.equal(last.code, 0, `encounter @${at}: the session releases: ${last.stderr}`);
  return last;
}

/** Files present on disk but NOT registered as touches — carried names must exist to survive. */
function placeFiles(dir, paths) {
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// present\n');
  }
}

/**
 * Manufactures an open article_missing item directly. Needed because the hook's
 * own dedup breaks at the FIRST file-key overlap, so two items that OVERLAP can
 * never be minted through the hook — and that is exactly the shape the
 * consolidation fix exists to clean up.
 */
function systemTodo(store, fileKeys, at, extra = {}) {
  return store.create({
    ...envelope('todo', at),
    text: `article_missing fixture naming ${fileKeys.length} file(s)`,
    source: 'system',
    system_reason: 'article_missing',
    file_keys: [...fileKeys],
    priority: 'normal',
    lifecycle: 'live',
    freshness: 'fresh',
    version: 1,
    ...extra,
  });
}

const names = (prefix, n, dir = 'src') => Array.from({ length: n }, (_, i) => `${dir}/${prefix}${String(i + 1).padStart(2, '0')}.mjs`);

// =========================================================================
// A — THE PERSISTED KEY LIST IS UNCAPPED.
// The 20-key cap was removed from BOTH the recompute and the first mint. While
// it stood, `healed = [...unowned, ...carried].slice(0, 20)` EVICTED carried
// names that were still unowned to make room for this session's — and because
// article_missing sits outside UPDATE_RESOLVABLE_LANES, never auto-drains, and
// is only COUNTED by H1, an evicted name is lost permanently and silently.
// =========================================================================

test('A-1: an item carrying 20 still-unowned names keeps EVERY one of them when a new unowned file arrives — the persisted key list is capped by the RULING, never by room', () => {
  // SABOTAGE: reinstate `.slice(0, 20)` on the healed set. EXPECT RED here.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const carried = names('c', 20); // src/c01.mjs .. src/c20.mjs — all unowned, all still on disk
    encounterTolerant(dir, store, carried, '2026-08-28T09:00:00.000Z');
    const first = demands(store);
    assert.equal(first.length, 1, 'baseline: one item after session 1');
    assert.equal(first[0].file_keys.length, 20, 'baseline: 20 unowned files, 20 keys — at the old cap but not over it, so this baseline holds under the sabotage too');

    // Session 2 is Codex's exact scenario: ONE carried name is re-touched and ONE
    // brand-new unowned file appears. Nothing gained an owner, nothing was deleted,
    // nothing is gitignored — so under the ruling all 21 names are owed.
    encounterTolerant(dir, store, ['src/c01.mjs', 'src/n1.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'A-1: still exactly one item — overlap dedup is untouched by the cap removal');
    assert.ok(
      [...open[0].file_keys].includes('src/c20.mjs'),
      'A-1: src/c20.mjs is still unowned, still on disk and not gitignored, so NOTHING in the ruling permits dropping it. Under the old `[...unowned, ...carried].slice(0, 20)` the 21st entry was evicted to make room for this session\'s names: a still-owed article demand deleted with no trace, on a lane that never auto-drains and that nothing else re-raises'
    );
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      [...carried, 'src/n1.mjs'].sort(),
      'A-1: the healed set is the FULL union of the live unowned set and every still-unowned carried name — 21 keys, past the old 20 cap'
    );
  } finally {
    cleanup();
  }
});

test('A-2: a FIRST mint in territory with more than 20 unowned files names all of them — the cap was removed from the mint path too, not only the recompute', () => {
  // SABOTAGE: reinstate `.slice(0, 20)` on the first-mint key list. EXPECT RED here.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const touched = names('f', 25);
    // Three of the 25 already have an owning article: the demand set (22) is
    // deliberately DIFFERENT from the touched set (25), which arm A-3 depends on.
    article(store, 'feat-f-owned', touched.slice(0, 3), '2026-08-28T08:30:00.000Z');
    encounterTolerant(dir, store, touched, '2026-08-28T09:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'A-2: one item for the mint');
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      touched.slice(3).sort(),
      'A-2: the mint names all 22 unowned files. A 20-cap here loses two genuinely unowned files at the moment the debt is first recorded — the earliest possible point of silent loss, before any human has seen the item'
    );
  } finally {
    cleanup();
  }
});

test('A-3: the count the item CLAIMS and the keys it NAMES come off one list — an item can never say "20 file(s)" while naming 22', () => {
  // SABOTAGE: derive the count in the mint text from a different list than the
  // keys (the touched list, or a capped copy). EXPECT RED here.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const touched = names('f', 25);
    article(store, 'feat-f-owned', touched.slice(0, 3), '2026-08-28T08:30:00.000Z');
    encounterTolerant(dir, store, touched, '2026-08-28T09:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'A-3: one item');
    const keyCount = open[0].file_keys.length;
    assert.equal(keyCount, 22, 'A-3 fixture: 25 touched, 3 owned, so exactly 22 keys are owed — the three candidate counts (22 keys / 25 touched / a 20-capped copy) are all distinct, which is what makes this arm discriminating');

    const text = String(open[0].text ?? '');
    const claimed = [...text.matchAll(/(\d+)\s+(?:[a-z-]+\s+){0,3}files?\b/gi)].map((m) => Number(m[1]));
    assert.ok(
      claimed.length >= 1,
      `A-3: the item text states no file COUNT at all, so the count/keys agreement cannot be checked. This arm assumes the shipped "N file(s)" phrasing; if the wording changed, that is evidence for the conductor, not a licence to drop the pin. Text was: ${text}`
    );
    assert.equal(
      Math.max(...claimed),
      keyCount,
      `A-3: the largest file count the text claims must be the number of keys it actually names (${keyCount}). A text saying 25 (the touched list) over-promises; one saying 20 (a capped copy) under-reports the debt while the keys say otherwise — either way the reader cannot tell which half of the item to believe, and this lane's remedy is "go create articles". Text was: ${text}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// B — CONSOLIDATION. Every open article_missing item this session's paths reach
// is folded into ONE survivor carrying the union; the rest are removed. Two
// manufactured-duplicate shapes make this necessary and they fail differently.
// =========================================================================

test('B-1: two previously-DISJOINT items both reached by one session are consolidated into ONE carrying the full union — healing them independently manufactures overlapping duplicates', () => {
  // SABOTAGE: disable the consolidation removal (heal only the first matched
  // item and leave the rest open). EXPECT RED here on the survivor count.
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Item 1 and item 2 are minted by genuinely disjoint sessions — the hook's
    // overlap dedup keeps them apart, which is correct at mint time.
    encounterTolerant(dir, store, ['x/a.mjs', 'x/b.mjs', 'x/b2.mjs'], '2026-08-28T09:00:00.000Z');
    encounterTolerant(dir, store, ['y/c.mjs', 'y/c2.mjs', 'y/c3.mjs'], '2026-08-28T09:15:00.000Z');
    assert.equal(demands(store).length, 2, 'baseline: two disjoint items, one per session — no overlap, so no dedup');

    // b, b2 and c2 are answered properly; c3 stays unowned and is NOT touched again.
    article(store, 'feat-x', ['x/b.mjs', 'x/b2.mjs'], '2026-08-28T09:30:00.000Z');
    article(store, 'feat-y', ['y/c2.mjs'], '2026-08-28T09:31:00.000Z');

    // One session now reaches BOTH items (x/a.mjs hits the first, y/c.mjs the second).
    encounterTolerant(dir, store, ['x/a.mjs', 'y/c.mjs', 'z/n.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(
      open.length,
      1,
      'B-1: exactly ONE item survives. Healing each reached item against the same live unowned set turns two DISJOINT items into two OVERLAPPING ones — a manufactured duplicate whose second copy can never be reached again, because the overlap dedup breaks at the first match'
    );
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      ['x/a.mjs', 'y/c.mjs', 'y/c3.mjs', 'z/n.mjs'],
      'B-1: the survivor carries the COMPLETE union — this session\'s unowned files plus every still-unowned carried name from BOTH items. y/c3.mjs lived only on the removed item and is still unowned, so consolidating must move it across; dropping it would trade a duplicate for a silent loss, which is the worse of the two'
    );
  } finally {
    cleanup();
  }
});

test('B-2: two open items sharing a file key collapse to one — after healing they would share an IDENTICAL key list, which is enqueueSystemTodo\'s dedup key, and the second would stand open forever', () => {
  // SABOTAGE: disable the consolidation removal. EXPECT RED here on the survivor count.
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Manufactured directly: the hook's own dedup breaks at the first overlap, so
    // two OVERLAPPING items cannot be minted through it. They arise anyway (a
    // renamed file, a restored backup, an item authored before a heal), and this
    // is the shape the fix has to survive.
    placeFiles(dir, ['src/x.mjs', 'src/y.mjs', 'src/w.mjs']);
    systemTodo(store, ['src/x.mjs'], '2026-08-28T08:00:00.000Z');
    systemTodo(store, ['src/x.mjs', 'src/y.mjs', 'src/w.mjs'], '2026-08-28T08:05:00.000Z');
    assert.equal(demands(store).length, 2, 'baseline: two open items overlapping on src/x.mjs');

    // y gains an owner; x and w stay unowned; w is carried but never touched.
    article(store, 'feat-y', ['src/y.mjs'], '2026-08-28T09:30:00.000Z');
    encounterTolerant(dir, store, ['src/x.mjs', 'src/p.mjs', 'src/q.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(
      open.length,
      1,
      'B-2: one survivor. Heal both independently and they end up with the same file_keys — and file_keys IS the dedup key: the next enqueue breaks at the first match and the second item is never touched again, never drained, and counted by H1 forever'
    );
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      ['src/p.mjs', 'src/q.mjs', 'src/w.mjs', 'src/x.mjs'],
      'B-2: the union is complete and correct — src/y.mjs is owned and pruned, src/w.mjs was carried only by the REMOVED item and is still unowned, so it must survive the consolidation'
    );
  } finally {
    cleanup();
  }
});

test('B-3 (outsider guard): when an item OUTSIDE this session\'s reach already carries the healed set, THAT item is kept and ours is removed — the survivor is never a second copy of an existing demand', () => {
  // SABOTAGE: drop the outsider check (keep/update our reached item instead of
  // deferring to the identical out-of-reach one). EXPECT RED on the objective marker.
  const { dir, store, cleanup } = makeH10Project();
  try {
    placeFiles(dir, ['src/a.mjs', 'src/u.mjs']);
    // Ours: reached by this session (names src/a.mjs) and heals down to {src/u.mjs}.
    systemTodo(store, ['src/a.mjs', 'src/u.mjs'], '2026-08-28T08:00:00.000Z', { objective: 'fixture-ours' });
    // Theirs: outside this session's reach, and ALREADY exactly the healed set.
    systemTodo(store, ['src/u.mjs'], '2026-08-28T08:05:00.000Z', { objective: 'fixture-outsider' });
    // src/a.mjs gains an owner, so the session's live unowned set is EMPTY — the
    // only condition under which the healed set can equal a pre-existing item.
    article(store, 'feat-a', ['src/a.mjs'], '2026-08-28T09:00:00.000Z');

    encounterTolerant(dir, store, ['src/a.mjs'], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(open.length, 1, 'B-3: exactly one item remains — keeping both leaves two records asserting the identical demand');
    assert.equal(
      open[0].objective,
      'fixture-outsider',
      'B-3: the SURVIVOR is the pre-existing out-of-reach item, not ours. Ours healing into a byte-identical copy of an item this session never touched is duplicate manufacture by another route: the outsider is the older record with the inbound history, and two records asserting one demand is worse than one'
    );
    assert.deepEqual([...open[0].file_keys].sort(), ['src/u.mjs'], 'B-3: and the surviving demand still names the genuinely unowned file — deduplicating must not cost the debt');
  } finally {
    cleanup();
  }
});

// =========================================================================
// D — THE RECOMPUTE RUNS ON THE NO-DUTY TERMINAL RELEASE.
// Before the fix H10 returned early on that release and the stale item survived,
// still prescribing "create the owning article" for files that now have one.
// EXPLICITLY OUT OF SCOPE: the article DEMAND stays muted on this release
// (pre-existing, deliberately not widened). Nothing below pins the demand firing
// here — only that the RECOMPUTE ran.
// =========================================================================

test('D-1: a valid no_capture release still recomputes the open item — the terminal release that fires no duty is the one most likely to leave a stale demand standing', () => {
  // SABOTAGE: move the recompute back below the no-duty terminal release.
  // EXPECT RED: the item still names src/a|b|c.mjs, all three of which are owned.
  const { dir, store, cleanup } = makeH10Project();
  try {
    // Session 1 mints an item over four unowned files (capture satisfied normally).
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'], '2026-01-05T09:00:00.000Z');
    assert.equal(demands(store).length, 1, 'baseline: one item naming four files');

    // Three of the four are answered properly. src/d.mjs stays unowned and untouched.
    article(store, 'feat-abc', ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-01-05T09:30:00.000Z');

    // Session 2: touches only OWNED files, NO capture record, and discharges the
    // capture duty by declaration. No research event, no concept event, no article
    // demand (nothing touched is unowned) — the no-duty terminal release.
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-01-06T09:00:00.000Z');
    const declared = spawnSync(process.execPath, [join(root, 'scripts', 'no-capture.mjs'), '--reason', 'read-only follow-up; nothing durable learned'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
    });
    assert.equal(declared.status, 0, `D-1 fixture: the no_capture declaration must be accepted: ${declared.stderr}`);

    const release = stop(dir);
    assert.equal(
      release.code,
      0,
      `D-1 CONTROL: this Stop must RELEASE IMMEDIATELY. A code 2 here means the no_capture declaration did not discharge the capture duty, so this arm would be exercising the capture-nag path (already covered by the arms above) instead of the no-duty terminal release it exists to pin — that is evidence for the conductor, not a reason to relax the assertion. stderr: ${release.stderr}`
    );
    assert.equal(
      demands(store).filter((d) => d.system_reason === 'article_missing').length,
      1,
      'D-1: the item is not removed — src/d.mjs is still unowned, so there is still a real debt'
    );
    assert.deepEqual(
      demandedPaths(store),
      ['src/d.mjs'],
      'D-1: the recompute RAN on the no-duty release — the three now-owned files are gone and only the genuinely unowned one remains. Left below the release, the item keeps naming three files that already have an owning article, and this lane\'s prescribed remedy for them is to create a second one'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// E — CARRIED KEYS ARE PRUNED BY RULING, NOT BY ROOM. A carried name leaves an
// item for exactly three reasons: it gained an owner, it is gitignored (board
// 1de3653b — ignored territory can never be owned), or it is absent on disk.
// The DEGRADE direction is the safety property: a FAILED probe KEEPS the name.
// =========================================================================

test('E-1 (owner): a carried name that is NOT touched this session but has since gained an owning article is pruned', () => {
  // SABOTAGE: apply the ownership join only to this session's touched files, not
  // to carried names. EXPECT RED: src/c.mjs survives.
  const { dir, store, cleanup } = makeH10Project();
  try {
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T09:00:00.000Z');
    article(store, 'feat-c', ['src/c.mjs'], '2026-08-28T09:30:00.000Z');

    // src/c.mjs is NOT among this session's paths — it can only be reconsidered as
    // a carried name, which is the path this arm exists to pin.
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/d.mjs'], '2026-08-28T10:00:00.000Z');

    assert.deepEqual(
      demandedPaths(store),
      ['src/a.mjs', 'src/b.mjs', 'src/d.mjs'],
      'E-1: src/c.mjs has an owning article listing it in files[]. A demand surface that keeps naming it because this session happened not to touch it sends the reader to write the duplicate the reconcile discipline exists to prevent'
    );
  } finally {
    cleanup();
  }
});

test('E-2 (absent): a carried name whose file no longer exists on disk is pruned', () => {
  // SABOTAGE: drop the exists-on-disk check from the carried-name path.
  // EXPECT RED: src/gone.mjs survives.
  const { dir, store, cleanup } = makeH10Project();
  try {
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/gone.mjs'], '2026-08-28T09:00:00.000Z');
    assert.ok(demandedPaths(store).includes('src/gone.mjs'), 'baseline: src/gone.mjs was legitimately demanded while it existed and was unowned');

    rmSync(join(dir, 'src', 'gone.mjs'), { force: true });
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/d.mjs'], '2026-08-28T10:00:00.000Z');

    assert.deepEqual(
      demandedPaths(store),
      ['src/a.mjs', 'src/b.mjs', 'src/d.mjs'],
      'E-2: a file that is not on disk can never gain an owning article, so a demand naming it is undischargeable debt — AC10 already filters this at the touch seam and the carried list must obey the same ruling'
    );
  } finally {
    cleanup();
  }
});

test('E-3 (gitignored): a carried name that has since become gitignored is pruned — ignored territory can never be owned (board 1de3653b)', () => {
  // SABOTAGE: drop the gitignore check from the carried-name path.
  // EXPECT RED: build/gen.mjs survives.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(git.status, 0, `E-3 fixture: needs a real git repo so the ignore probe answers rather than degrading to no_git: ${git.stderr}`);

    // Minted with no .gitignore, so build/gen.mjs is legitimately demanded.
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'build/gen.mjs'], '2026-08-28T09:00:00.000Z');
    assert.ok(demandedPaths(store).includes('build/gen.mjs'), 'baseline: build/gen.mjs was demanded while nothing ignored it');

    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    encounterTolerant(dir, store, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T10:00:00.000Z');

    assert.deepEqual(
      demandedPaths(store),
      ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
      'E-3: build/ is now ignored, and AC9 excludes ignored paths from the unowned set precisely because ignored territory can never be owned — the demand is undischargeable and must leave the item'
    );
  } finally {
    cleanup();
  }
});

test('E-4 (DEGRADE control): a FAILED gitignore probe KEEPS the carried name — a broken check never costs a demand', () => {
  // SABOTAGE: make a failed ignore probe drop the name (treat probe failure as
  // "ignored"). EXPECT RED: build/gen.mjs vanishes.
  //
  // This arm is the control for E-3: "build/gen.mjs left the item" has more than
  // one possible cause, and an implementation that drops a name whenever the probe
  // does not clearly say "keep" passes E-3 for the wrong reason. Here the probe is
  // broken rather than answering, and the name must SURVIVE.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(git.status, 0, `E-4 fixture: needs a real git repo so the failure is a PROBE failure, not the no_git path: ${git.stderr}`);

    encounterTolerant(dir, store, ['src/a.mjs', 'build/gen.mjs', 'src/doomed.mjs'], '2026-08-28T09:00:00.000Z');
    assert.ok(demandedPaths(store).includes('build/gen.mjs'), 'baseline: build/gen.mjs demanded');

    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    rmSync(join(dir, 'src', 'doomed.mjs'), { force: true }); // second control, see below

    // Break the probe itself: git is unreachable, so the ignore check ERRORS
    // instead of answering. `.git` is present, so this is not the no_git path.
    const emptyBin = join(dir, '.sterling', 'no-bin');
    mkdirSync(emptyBin, { recursive: true });
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T10:00:00.000Z');
    captureDecision(store, '2026-08-28T10:00:00.000Z');
    const first = stop(dir, { PATH: emptyBin });
    assert.ok(first.code === 0 || first.code === 2, `E-4: a broken git probe must degrade, never crash the gate (code ${first.code}): ${first.stderr}`);
    if (first.code === 2) {
      const second = stop(dir, { PATH: emptyBin });
      assert.equal(second.code, 0, `E-4: the session releases: ${second.stderr}`);
    }

    const paths = demandedPaths(store);
    // CONTROL, and it must be read first: this proves the recompute actually RAN
    // under the broken probe. Without it, a hook that crashed or bailed early would
    // leave the item untouched and satisfy the survival assertion below vacuously —
    // green for the exact opposite reason to the one claimed.
    assert.ok(
      !paths.includes('src/doomed.mjs'),
      'E-4 CONTROL: the recompute ran despite the broken probe — src/doomed.mjs is gone from disk and the absent-on-disk ruling (which needs no git) still pruned it. If this fails, the run below is not evidence about the degrade path at all'
    );
    assert.ok(
      paths.includes('build/gen.mjs'),
      'E-4: the ignore probe FAILED rather than answering, so build/gen.mjs must be KEPT. Degrading toward silence deletes a still-owed demand on the strength of a broken tool — the same class of loss as the eviction cap, arriving through a check that was supposed to make the lane more accurate (AC9 degrades the mint the same way, via check_skipped)'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// APPENDED 2026-08-29 (second wave) — THE STRICT-SUBSET OUTSIDER LEAK, plus
// the check_skipped receipt E-4 deliberately left unpinned.
//
// WHY THESE ARMS EXIST, STATED PLAINLY: the shipped code comment for the
// subset sweep cites "reproduced 2026-08-29 as arm B-4", and until this block
// landed NO ARM B-4 EXISTED anywhere in scripts/tests — the reproduction lived
// in a probe that was deleted. A citation to a test that does not exist is
// worse than no citation: it tells the next reader the behaviour is pinned
// when nothing observes it. B-4 below is that arm, written to the reproduced
// red exactly:
//     one item; got 2: [["src/c1.mjs"],["src/a.mjs","src/c1.mjs"]]
//
// THE RULING. Consolidation folds every open article_missing item this
// session's paths REACH into one survivor carrying the union. An item OUTSIDE
// that reach is handled by direction, and the two directions are deliberately
// OPPOSITE:
//   EQUALITY (arm B-3, above) — the outsider carries exactly the healed set:
//     keep THEIRS, drop OURS. Both records assert the identical demand and the
//     outsider is the older record with the inbound history.
//   STRICT SUBSET (arm B-4, here) — the outsider's keys are a PROPER subset of
//     the healed set: keep OURS, drop THEIRS. Deferring to theirs here would
//     DROP the names only ours carries, and a dropped name on this lane is
//     permanent silent loss (article_missing is outside UPDATE_RESOLVABLE_LANES,
//     never auto-drains, and H1 only COUNTS it). The inversion is the whole
//     point, so it is pinned rather than inferred from the neighbouring branch.
//   DISJOINT (arm B-4-CONTROL) — untouched. This is the arm that makes B-4
//     evidence rather than a coincidence: "one item remains" has a second
//     possible cause — a sweep that removes every non-survivor — and that
//     implementation passes B-4 identically while destroying unrelated debt.
//   EMPTY KEYS (arm B-5) — skipped, deliberately, because the empty set is a
//     trivial subset of everything and would otherwise be swept by any healed
//     set at all. A conservative deviation that nothing pins looks exactly like
//     an oversight to the next reader, and gets "simplified" away.
//
// EVERY ARM BELOW IS EXPECTED GREEN AGAINST THE CURRENT (already-fixed) code,
// and each names the ONE-LINE SABOTAGE that must turn it RED.
// =========================================================================

/** One touched, live, unowned file — under the demand threshold on purpose, so
 *  the recompute path (not the mint path) is what these arms exercise. */
const OURS_LIVE = 'src/a.mjs';
const SHARED_CARRIED = 'src/c1.mjs';

test('B-4-CONTROL (must pass for the OPPOSITE reason — placed FIRST): an outsider whose keys are DISJOINT from the healed set survives the session untouched — the subset sweep is a sweep of SUBSETS, never of everything out of reach', () => {
  // SABOTAGE that must turn THIS red: widen the sweep from `subsetOf(item.file_keys, healed)`
  // to an unconditional removal of every open item that is not the survivor.
  // EXPECT RED: src/z9.mjs vanishes.
  //
  // WITHOUT THIS ARM B-4 is not evidence. Its verdict — "exactly one item
  // remains" — is satisfied identically by a lane that deletes every
  // article_missing item it did not just write, which is the most destructive
  // possible reading of consolidation and would silently erase every unrelated
  // demand on the queue.
  const { dir, store, cleanup } = makeH10Project();
  try {
    placeFiles(dir, [OURS_LIVE, SHARED_CARRIED, 'src/z9.mjs']);
    systemTodo(store, [OURS_LIVE, SHARED_CARRIED], '2026-08-28T08:00:00.000Z', { objective: 'fixture-ours' });
    systemTodo(store, ['src/z9.mjs'], '2026-08-28T08:05:00.000Z', { objective: 'fixture-disjoint-outsider' });

    encounterTolerant(dir, store, [OURS_LIVE], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    const byObjective = Object.fromEntries(open.map((d) => [d.objective, [...(d.file_keys ?? [])].sort()]));
    assert.ok(
      byObjective['fixture-disjoint-outsider'],
      `CONTROL BROKEN — OVER-SWEEP SHAPE: src/z9.mjs is still unowned, still on disk, and shares NO key with this session's healed set {${OURS_LIVE}, ${SHARED_CARRIED}}. Nothing in the ruling permits touching it. If it is gone, the sweep is removing by reachability instead of by subset, and B-4's green below means only that the lane deletes everything. Open items were: ${JSON.stringify(byObjective)}`,
    );
    assert.deepEqual(byObjective['fixture-disjoint-outsider'], ['src/z9.mjs'], 'CONTROL: and it is untouched, not merely surviving with a rewritten key list');
    assert.deepEqual(
      byObjective['fixture-ours'],
      [OURS_LIVE, SHARED_CARRIED].sort(),
      'CONTROL: our reached item heals to the union of the live unowned set and its still-owed carried name — this is the exact healed set B-4 measures against',
    );
    assert.equal(open.length, 2, `CONTROL: exactly two items — ours and the untouched disjoint outsider. Open items were: ${JSON.stringify(byObjective)}`);
  } finally {
    cleanup();
  }
});

test('B-4 (THE REPRODUCED RED — the arm the shipped code comment cites): an outsider whose keys are a STRICT SUBSET of the healed set is removed and OURS survives carrying BOTH names — at strict subset only ours carries every still-owed name', () => {
  // SABOTAGE that must turn this red: drop the subset sweep and handle only the
  // equality case (`sameSet`). EXPECT RED with exactly the reproduced shape —
  // one item; got 2: [["src/c1.mjs"],["src/a.mjs","src/c1.mjs"]].
  //
  // SECOND SABOTAGE, and it must ALSO turn this red, because it is the one a
  // reader is most likely to "fix" by symmetry with the neighbouring equality
  // branch: invert the direction — keep THEIRS and drop OURS at strict subset.
  // EXPECT RED on the surviving key list, which loses src/a.mjs permanently.
  const { dir, store, cleanup } = makeH10Project();
  try {
    placeFiles(dir, [OURS_LIVE, SHARED_CARRIED]);
    // Ours: REACHED by this session (it names src/a.mjs) and heals to
    // {src/a.mjs, src/c1.mjs} — src/c1.mjs is unowned, on disk, not gitignored,
    // so the ruling keeps it.
    systemTodo(store, [OURS_LIVE, SHARED_CARRIED], '2026-08-28T08:00:00.000Z', { objective: 'fixture-ours' });
    // Theirs: OUTSIDE this session's reach (src/a.mjs is not among its keys)
    // and a PROPER subset of the healed set — the near-miss board f4616312
    // reported, which the empty-`unowned` outsider guard could never reach.
    systemTodo(store, [SHARED_CARRIED], '2026-08-28T08:05:00.000Z', { objective: 'fixture-subset-outsider' });
    assert.equal(demands(store).length, 2, 'baseline: two open items, one a strict subset of what the other will heal to');

    encounterTolerant(dir, store, [OURS_LIVE], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    assert.equal(
      open.length,
      1,
      `MANUFACTURED-DUPLICATE SHAPE (the reproduced red, verbatim: one item; got 2: [["${SHARED_CARRIED}"],["${OURS_LIVE}","${SHARED_CARRIED}"]]): two open items now overlap on ${SHARED_CARRIED}, and file_keys IS enqueueSystemTodo's dedup key — the next enqueue breaks at the first match, so the second item stands open forever, never drained, counted by H1 forever. Open items were: ${JSON.stringify(open.map((d) => [...(d.file_keys ?? [])].sort()))}`,
    );
    assert.deepEqual(
      [...open[0].file_keys].sort(),
      [OURS_LIVE, SHARED_CARRIED].sort(),
      `DIRECTION SHAPE if this names only ${SHARED_CARRIED}: at STRICT SUBSET the survivor must be OURS, which is the only record carrying every still-owed name. The neighbouring EQUALITY branch defers to the outsider precisely because the two sets are identical there — copying that deference down to strict subset drops ${OURS_LIVE}, and a dropped name on this lane is permanent silent loss, which AC9 calls the worse direction`,
    );
    assert.equal(
      open[0].objective,
      'fixture-ours',
      'and the SURVIVOR is our reached item — the record that actually carries the union. This assertion is what distinguishes "kept ours" from "kept theirs and happened to widen its keys"',
    );
  } finally {
    cleanup();
  }
});

test('B-5 (the conservative deviation, pinned so it does not look like an oversight): an outsider with an EMPTY file_keys list is SKIPPED by the subset sweep — the empty set is a trivial subset of everything', () => {
  // SABOTAGE that must turn this red: remove the empty-file_keys skip from the
  // sweep, so `subsetOf([], healed)` returns true and the item is removed.
  // EXPECT RED: the empty-keyed item is gone.
  //
  // The deviation is deliberate and it is CONSERVATIVE: with no skip, ANY
  // healed set at all sweeps away every empty-keyed open item on the queue,
  // whatever produced it. Removing debt is the irreversible direction on a lane
  // that never auto-drains, so an item nobody can prove is a duplicate is left
  // standing.
  const { dir, store, cleanup } = makeH10Project();
  try {
    placeFiles(dir, [OURS_LIVE, SHARED_CARRIED]);
    systemTodo(store, [OURS_LIVE, SHARED_CARRIED], '2026-08-28T08:00:00.000Z', { objective: 'fixture-ours' });
    systemTodo(store, [], '2026-08-28T08:05:00.000Z', { objective: 'fixture-empty-outsider' });
    assert.equal(demands(store).length, 2, 'baseline: our item plus an empty-keyed open item');

    encounterTolerant(dir, store, [OURS_LIVE], '2026-08-28T10:00:00.000Z');

    const open = demands(store);
    const objectives = open.map((d) => d.objective).sort();
    assert.deepEqual(
      objectives,
      ['fixture-empty-outsider', 'fixture-ours'],
      `TRIVIAL-SUBSET SHAPE if the empty-keyed item is gone: [] is a subset of every set, so an unguarded subset test removes it on any session that heals anything. Open objectives were: ${JSON.stringify(objectives)}`,
    );
    assert.deepEqual(
      [...open.find((d) => d.objective === 'fixture-ours').file_keys].sort(),
      [OURS_LIVE, SHARED_CARRIED].sort(),
      'and the skip costs nothing on the healing side — our survivor still carries the full union',
    );
  } finally {
    cleanup();
  }
});

test('E-4b (the receipt E-4 could not assert): a FAILED gitignore probe on a CARRIED name records check_skipped `article-demand-carried-gitignore` — the degrade is LOUD, not merely safe', () => {
  // SABOTAGE that must turn this red: drop the check_skipped record from the
  // failed carried-name ignore probe (keep the name, say nothing).
  //
  // WHY THIS IS A SEPARATE ARM FROM E-4: E-4 pins the SAFETY property (a broken
  // probe keeps the name). Safety alone is silent — a lane that keeps names
  // because a tool is broken, and never says so, is indistinguishable from one
  // where the tool works. P5 is fail LOUD, never silent, and AC9 names this
  // receipt by its exact string. E-4's author correctly refused to assert an
  // invented accessor; the read surface is SterlingStore.listCheckSkipped(),
  // the same accessor scripts/tests/gitignore-frontier.test.mjs AC7 already
  // uses for the MINT-side degrade of the same probe.
  const { dir, store, cleanup } = makeH10Project();
  try {
    const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(git.status, 0, `E-4b fixture: needs a real git repo so the failure is a PROBE failure, not the no_git path: ${git.stderr}`);

    encounterTolerant(dir, store, ['src/a.mjs', 'build/gen.mjs', 'src/doomed.mjs'], '2026-08-28T09:00:00.000Z');
    assert.ok(demandedPaths(store).includes('build/gen.mjs'), 'baseline: build/gen.mjs demanded while nothing ignored it');

    writeFileSync(join(dir, '.gitignore'), 'build/\n');
    rmSync(join(dir, 'src', 'doomed.mjs'), { force: true }); // liveness marker, read first below

    // Break the probe itself: git is unreachable, so the ignore check ERRORS
    // instead of answering. `.git` is present, so this is not the no_git path.
    const emptyBin = join(dir, '.sterling', 'no-bin');
    mkdirSync(emptyBin, { recursive: true });
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'], '2026-08-28T10:00:00.000Z');
    captureDecision(store, '2026-08-28T10:00:00.000Z');
    const first = stop(dir, { PATH: emptyBin });
    assert.ok(first.code === 0 || first.code === 2, `E-4b: a broken git probe must degrade, never crash the gate (code ${first.code}): ${first.stderr}`);
    if (first.code === 2) {
      const second = stop(dir, { PATH: emptyBin });
      assert.equal(second.code, 0, `E-4b: the session releases: ${second.stderr}`);
    }

    const paths = demandedPaths(store);
    // LIVENESS, and it must be read first: without it a hook that crashed or
    // bailed early would leave the item untouched, and the receipt assertion
    // below would be measuring a run in which the carried-name path never
    // executed at all.
    assert.ok(
      !paths.includes('src/doomed.mjs'),
      'E-4b LIVENESS: the recompute ran despite the broken probe — src/doomed.mjs is gone from disk and the absent-on-disk ruling (which needs no git) still pruned it. If this fails, nothing below is evidence about the carried-name gitignore path',
    );
    assert.ok(
      paths.includes('build/gen.mjs'),
      'E-4b LIVENESS (the E-4 property, restated here so the receipt is checked on a run that actually exercised the degrade): the failed probe KEPT the carried name',
    );

    const skipped = store.listCheckSkipped();
    assert.ok(
      skipped.some((c) => /article-demand-carried-gitignore/.test(`${c.check_name ?? ''} ${c.reason ?? ''}`)),
      `SILENT-DEGRADE SHAPE: the carried-name ignore probe failed and the name was kept, but nothing recorded WHY. AC9 names this receipt exactly — "a FAILED gitignore probe KEEPS the name and records check_skipped article-demand-carried-gitignore" — because a lane that quietly compensates for a broken tool hides the broken tool (P5). Recorded rows were: ${JSON.stringify(skipped.map((c) => c.check_name ?? c.reason ?? c))}`,
    );
  } finally {
    cleanup();
  }
});

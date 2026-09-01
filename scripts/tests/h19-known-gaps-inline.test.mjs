// H19 KNOWN_GAPS INLINE DELIVERY (spec-only, TDD-red).
//
// Spec source (verified by knowledge_get, not paraphrase): decision
// delivery-lifecycle-and-drain-reresolve-design (db3392db) Part 3, ship-ruled by
// decision known-gaps-inline-ships-with-probe-seam-boarded (53fd6f62), board
// 3dbbdb35. The Part 3 paragraph, verbatim substance pinned here:
//
//   "when H19 file-touch delivery resolves a touched path to owning articles
//   with NON-EMPTY known_gaps, render gaps inline — per gap: site + kind +
//   whitespace-normalized first sentence of evidence (normalization so stored
//   evidence cannot fabricate a delivery line), ~400 chars/gap; a GLOBAL 3-gap
//   budget per delivery (per-article budgets multiply unboundedly when several
//   articles own one path) after deterministic article/gap ordering, omissions
//   disclosed per-article and total; mutation_survivor gaps prefixed
//   'WRONG-ON-PURPOSE test survivor'; the knowledge_get pointer retained even
//   when rendered; ONCE PER SESSION PER ARTICLE dedup on ordinary touches
//   (matches the existing lineage guard). NO site-based filtering until the
//   schema gains an explicit gap scope/path field."
//
// The Bash pointer seam (h19-bash-delivery.mjs) was originally EXCLUDED
// (53fd6f62's disclosed ship condition) and test 7 pinned that exclusion;
// board f1489964 closed the seam on 2026-09-01 — test 7 was inverted at that
// sanctioned moment (it now pins gap RE-EMISSION beside the pointer, with the
// seam's own gap_articles dedup), and test 12 pins the drained rendering.
//
// known_gaps element shape (knowledge_schema feature_article):
//   { site: string, kind: 'mutation_survivor' | 'other', evidence: string, recorded_run: string }
//
// This file follows the harness conventions of scripts/tests/h19-delivery.test.mjs
// and scripts/tests/h19-hazard-cap.test.mjs (temp project + store, runHook,
// article/envelope builders, rung 'read' for direct additionalContext
// injection, ctxOf helper) without modifying either file.
//
// EXECUTION NOTE: this agent role holds no Bash/exec tool and cannot run
// `node --test` itself. Every test below states its EXPECTED FAILURE SHAPE
// against the current (unimplemented) tree and the SABOTAGE that must
// reproduce that same red once the feature is built — both PREDICTED, not
// measured. The conductor's red-gate run is the actual verification.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-07-19T12:00:00.000Z';

let SterlingStore;
let SterlingTools; // Group-C addendum only: used by the drain-path gaps test
// below, mirroring scripts/tests/h19-drain-reresolve.test.mjs's own use of the
// compiled SterlingTools class as fixture-construction infrastructure (not
// implementation-under-test) to get a genuinely ACTIVE-then-EDITED record.
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SterlingTools } = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'tools.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function makeProject({ rung = 'read' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-gaps-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

const postBash = (dir, command, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd: dir,
  ...extra,
});

function ctxOf(result) {
  assert.equal(result.code, 0, `hook must not block (AC7): ${result.stderr}`);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

const pendingOf = (dir) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', 'pending.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};

/** Loose, format-agnostic search for a disclosure line naming `count` beside a
 * drop/omit/more-style word within 80 chars either direction. The exact
 * wording is NOT part of the cited spec paragraph (only that omission is
 * "disclosed per-article and total"), so this deliberately does not anchor to
 * an invented phrase — it anchors to the SUBSTANCE: a number, near a
 * drop-shaped word, somewhere in the payload. */
function hasCountedDisclosure(ctx, count) {
  const word = '(gap|omit|drop|elid|more|not shown|remain)';
  const forward = new RegExp(`\\b${count}\\b[^\\n]{0,80}${word}`, 'i');
  const backward = new RegExp(`${word}[^\\n]{0,80}\\b${count}\\b`, 'i');
  return forward.test(ctx) || backward.test(ctx);
}

// ---------------------------------------------------------------------------
// (1) CONTROL — no known_gaps (absent field, and explicit empty array) delivers
// exactly as today: no gap section, no WRONG-ON-PURPOSE marker.
// PREDICTED: GREEN today (the feature does not exist, so there is nothing to
// render) AND green after the feature ships — this is the regression control
// for the feature as a whole, not a red-before-green primary pin.
// SABOTAGE (post-implementation): render an unconditional gap-section header
// even when known_gaps is empty/absent → turns this red.
// ---------------------------------------------------------------------------

test('control: an article with no known_gaps (absent, or an explicit empty array) delivers exactly as today — no gap section at all', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs'])); // no known_gaps field at all
    store.create(article('beta', ['src/b.mjs'], { known_gaps: [] })); // explicit empty array

    const ctxA = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    assert.doesNotMatch(ctxA, /WRONG-ON-PURPOSE/, 'no mutation_survivor prefix when there are no gaps at all');
    assert.doesNotMatch(ctxA, /known.?gap/i, 'no gap-section header renders for an article with no known_gaps');

    const ctxB = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir));
    assert.doesNotMatch(ctxB, /known.?gap/i, 'an explicit empty known_gaps array is treated identically to an absent field');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (2) Gaps inline: site + kind context + whitespace-normalized FIRST SENTENCE
// of evidence only; the article's knowledge_get pointer is retained beside it.
// PREDICTED RED (current tree): none of these strings render at all — the
// hook does not read known_gaps today. The `knowledge_get <id>` assertion is
// the sharpest failure: today the primary article's own full body is what
// renders, not a pointer beside a gap block, so this specific adjacency does
// not exist yet.
// SABOTAGE: delete the pointer-append step (render the gap line with no
// trailing `(knowledge_get <id>)`) → the pointer-retained assertion goes red
// while the site/evidence assertions stay green — proving the pointer is a
// separately-carried guarantee, not incidental to inlining the gap text.
// ---------------------------------------------------------------------------

test('gaps inline: site + whitespace-normalized FIRST SENTENCE of evidence render, with the article pointer retained beside them', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rec = store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [
          {
            site: 'aim-solver window',
            kind: 'other',
            evidence: 'The   solver\nnever   validates the   production entry point. This second sentence must never render.',
            recorded_run: 'r1',
          },
        ],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    assert.match(ctx, /aim-solver window/, 'the gap site renders');
    assert.match(
      ctx,
      /The solver never validates the production entry point\./,
      'the first sentence renders whitespace-NORMALIZED — collapsed newlines/runs of spaces to single spaces'
    );
    assert.doesNotMatch(ctx, /This second sentence must never render/, 'only the FIRST sentence of evidence ever renders');
    assert.match(ctx, new RegExp(`knowledge_get ${rec.id}`), "the article's knowledge_get pointer is retained beside the inlined gap");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) Global 3-gap budget per delivery: 4 gaps on one delivery → exactly 3
// inline, elision disclosed.
// PREDICTED RED: 0 of the 4 fixture sites render today (feature absent), so
// `present.length` is 0, not 3 — first assertion fails immediately.
// SABOTAGE: change the cap constant/slice bound from 3 to 4 (or remove the
// slice entirely) → all 4 sites render, `present.length` becomes 4, red.
// ---------------------------------------------------------------------------

test('budget: 4 known_gaps on one delivery inline only 3 (global cap), and the elision is disclosed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const gaps = ['gap-0', 'gap-1', 'gap-2', 'gap-3'].map((site, i) => ({
      site,
      kind: 'other',
      evidence: `${site} evidence sentence number ${i}.`,
      recorded_run: 'r1',
    }));
    store.create(article('alpha', ['src/a.mjs'], { known_gaps: gaps }));
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    const present = gaps.filter((g) => ctx.includes(g.site));
    assert.equal(present.length, 3, `exactly the global 3-gap budget renders, got ${present.length}: ${present.map((g) => g.site)}`);
    assert.ok(hasCountedDisclosure(ctx, 1), `expected a disclosed elision naming the 1 dropped gap; got:\n${ctx}`);
  } finally {
    cleanup();
  }
});

test('budget: with 3 or fewer known_gaps, all render and no elision is disclosed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const gaps = ['only-0', 'only-1', 'only-2'].map((site, i) => ({
      site,
      kind: 'other',
      evidence: `${site} evidence sentence number ${i}.`,
      recorded_run: 'r1',
    }));
    store.create(article('alpha', ['src/a.mjs'], { known_gaps: gaps }));
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    for (const g of gaps) assert.match(ctx, new RegExp(g.site), `${g.site} renders — under the cap, nothing is dropped`);
    assert.ok(!hasCountedDisclosure(ctx, 1) && !hasCountedDisclosure(ctx, 2) && !hasCountedDisclosure(ctx, 3), 'no elision phrase when nothing was dropped by the cap');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) ~400-char truncation with disclosure. Evidence's first (and only)
// sentence has no period until ~590 chars in, forcing a length-cap truncation
// rather than a sentence-boundary stop.
// PREDICTED RED: the fixture's full 'reaches the true end...' tail is absent
// from the current payload for the trivial reason that nothing renders at
// all yet — `ctx.indexOf('oversize-gap')` is -1 and the first assertion fails.
// SABOTAGE: remove the length-based clip (render the full first sentence
// regardless of length) → the "text past the cap is truncated" assertion
// goes red because the full tail string now appears verbatim.
// ---------------------------------------------------------------------------

test('truncation: a gap whose evidence exceeds ~400 chars is truncated, with the truncation disclosed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const filler = 'lorem '.repeat(90); // 540 chars, no period anywhere in it
    const evidence = `${filler}reaches the true end of this one long sentence.`;
    store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [{ site: 'oversize-gap', kind: 'other', evidence, recorded_run: 'r1' }],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    const idx = ctx.indexOf('oversize-gap');
    assert.ok(idx >= 0, 'the gap site renders');
    const windowText = ctx.slice(idx, idx + 700);
    assert.match(windowText, /lorem lorem lorem/, 'the start of the (long) evidence renders');
    assert.doesNotMatch(
      windowText,
      /reaches the true end of this one long sentence\./,
      'text past the ~400-char cap is truncated — the tail of a 540+ char sentence never renders whole'
    );
    assert.match(windowText, /…|\.\.\./, 'the truncation is disclosed with a clipping marker, never a silent cut');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (5) mutation_survivor prefix 'WRONG-ON-PURPOSE'. CONTROL ARM FIRST: an
// 'other'-kind gap in the SAME delivery must NOT carry the prefix — this rules
// out an implementation that stamps every gap unconditionally, which would
// pass a mutation_survivor-only test for the wrong reason.
// PREDICTED RED: neither gap renders at all today, so the mutation_survivor
// assertion fails (no 'WRONG-ON-PURPOSE' text exists anywhere).
// SABOTAGE: hardcode the prefix onto every gap line regardless of kind → the
// control arm ('other'-kind must NOT carry it) goes red while the
// mutation_survivor assertion stays green, proving the kind check is
// load-bearing rather than decorative.
// ---------------------------------------------------------------------------

test('mutation_survivor gaps render prefixed WRONG-ON-PURPOSE; an other-kind gap in the same delivery does not (control arm first)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [
          { site: 'ordinary-blind-spot', kind: 'other', evidence: 'A probe blind spot, not a test survivor.', recorded_run: 'r1' },
          { site: 'weapon-aim-clamp', kind: 'mutation_survivor', evidence: 'Removing the clamp check left the suite green.', recorded_run: 'r9' },
        ],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    // CONTROL ARM (asserted first): the other-kind gap must pass for the
    // OPPOSITE reason — it renders, but WITHOUT the prefix.
    const otherIdx = ctx.indexOf('ordinary-blind-spot');
    assert.ok(otherIdx >= 0, 'the other-kind gap renders');
    const otherWindow = ctx.slice(Math.max(0, otherIdx - 60), otherIdx + 200);
    assert.doesNotMatch(otherWindow, /WRONG-ON-PURPOSE/, 'an other-kind gap must NOT carry the mutation_survivor prefix');

    const survivorIdx = ctx.indexOf('weapon-aim-clamp');
    assert.ok(survivorIdx >= 0, 'the mutation_survivor gap renders');
    const survivorWindow = ctx.slice(Math.max(0, survivorIdx - 60), survivorIdx + 200);
    assert.match(survivorWindow, /WRONG-ON-PURPOSE/, 'a mutation_survivor gap IS prefixed WRONG-ON-PURPOSE');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (6) ONCE-PER-SESSION-PER-ARTICLE dedup: a second touch of the same article
// re-inlines nothing; a DIFFERENT article's gaps still inline in the same
// session (rules out a global once-per-session switch that would starve every
// article after the first).
// PREDICTED RED: the FIRST touch assertion ('alpha gap' must render) fails
// today since nothing renders yet.
// SABOTAGE: key the dedup guard on the SESSION alone (a single boolean/flag)
// instead of per-article → the third assertion ('beta gap' still inlines)
// goes red because beta's gaps get silently suppressed by alpha's earlier use.
// ---------------------------------------------------------------------------

test('dedup: a second touch of the same article does not re-inline its gaps; a different article\'s gaps still inline', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs'], { known_gaps: [{ site: 'alpha gap', kind: 'other', evidence: 'Alpha has a gap here.', recorded_run: 'r1' }] }));
    store.create(article('beta', ['src/b.mjs'], { known_gaps: [{ site: 'beta gap', kind: 'other', evidence: 'Beta has a gap here.', recorded_run: 'r1' }] }));

    const first = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));
    assert.match(first, /alpha gap/, 'first touch of alpha inlines its gap');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'nothing fresh on a same-session repeat touch of the already-delivered article (matches the existing lineage guard)');

    const beta = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/b.mjs'), dir));
    assert.match(beta, /beta gap/, "a DIFFERENT article's gaps still inline — the dedup key is per-article, not a session-wide switch");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (7) The probe-output/Bash pointer path stays gap-free — the accepted,
// boarded exclusion (decision 53fd6f62; follow-up f1489964). The exclusion
// pin that stood here was INVERTED DELIBERATELY on 2026-09-01 when board
// f1489964 shipped the seam closure — exactly the deliberate change the old
// pin existed to force (its own header named f1489964 as the sanctioned
// moment). The bash pointer path now RE-EMITS gap substance for a command
// naming an owned path whose article carries non-empty known_gaps, with the
// seam's OWN dedup namespace (gap_articles), never free-text output matching.
// SABOTAGE: drop the budgetKnownGaps wiring in h19-bash-delivery.mjs (e.g.
// budgetKnownGaps([])) → 'owner gap'/'WRONG-ON-PURPOSE' vanish from the
// pointer payload, turning this red (probe-verified before application).
// ---------------------------------------------------------------------------

test('the probe-output/Bash pointer path re-emits known_gaps substance beside its pointer (board f1489964 closes the seam the old pin held as excluded)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const rec = store.create(
      article('owner', ['src/a.mjs'], {
        known_gaps: [{ site: 'owner gap', kind: 'mutation_survivor', evidence: 'Owner has a gap that must now surface in a pointer payload.', recorded_run: 'r1' }],
      })
    );
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'grep -n x src/a.mjs'), dir);
    assert.equal(r.code, 0, 'AC7: delivery never blocks');
    const q = pendingOf(dir);
    assert.equal(q.length, 1, 'the bash touch queues exactly one pointer entry');
    assert.match(q[0].payload, /owner gap/, 'gap site now re-emits beside the pointer (board f1489964)');
    assert.match(q[0].payload, /WRONG-ON-PURPOSE/, 'mutation_survivor framing re-emits too');
    assert.match(q[0].payload, new RegExp(`knowledge_get ${rec.id}`), 'the article pointer is retained beside the gap');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// APPENDED 2026-09-01 (coordinator instruction): four additional observable
// behaviors from a Codex-driven fix round. Nothing above this line is
// altered. Still spec-only — no implementation reads. Ground fixtures follow
// scripts/tests/h19-drain-reresolve.test.mjs's disclosed fixture techniques
// (that file's header comment enumerates (1) raw status envelopes, (2)
// SterlingTools for genuine post-enqueue mutation, (3) schema-discovery raw
// SQL for hard-delete). This section adds ONE more disclosed technique in the
// same spirit:
//
//  (4) SUBSTRING-LEVEL RAW SQL EDIT. Neither `store.create()` (INSERT-only, no
//      demonstrated update path in any sibling test) nor a guessed
//      `SterlingTools.knowledgeUpdate(...)` signature (not exercised by any
//      test file read for this task, and not an MCP tool granted to this
//      role — `knowledge_update` is absent from the test-writer's tool set,
//      so its exact parameter shape cannot be confirmed without reading
//      implementation) is available to produce "the SAME article record,
//      edited in place, between touch and drain". `mutateRecordJsonText`
//      below discovers (at runtime, never assumed) every table with an `id`
//      column, finds the row for the given id, and does a plain SUBSTRING
//      replace on whichever string column(s) contain the given sentinel —
//      never assuming a column name or JSON structure. This is weaker
//      leverage than technique (3)'s DELETE (a substring swap cannot corrupt
//      JSON structure the way a malformed value could), and is guarded by
//      the same `mutated >= 1` fixture-sanity pattern technique (3) uses.
// ===========================================================================

function makeProjectDrain({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-gaps-drain-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, dbPath, cleanup };
}

function mkTools(store) {
  return new SterlingTools({ store, now: () => NOW });
}

function drain(dir) {
  return runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
}

/** Technique (4), disclosed above: substring-level raw SQL edit, table/column
 * discovered at runtime. Returns the number of string columns actually
 * mutated, so every call site can assert `>= 1` as fixture sanity. */
function mutateRecordJsonText(dbPath, id, oldSubstring, newSubstring) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    let mutated = 0;
    for (const t of tables) {
      let cols;
      try {
        cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      } catch {
        continue;
      }
      if (!cols.includes('id')) continue;
      let row;
      try {
        row = db.prepare(`SELECT * FROM "${t}" WHERE id = ?`).get(id);
      } catch {
        continue;
      }
      if (!row) continue;
      for (const col of cols) {
        const val = row[col];
        if (typeof val === 'string' && val.includes(oldSubstring)) {
          const next = val.split(oldSubstring).join(newSubstring);
          db.prepare(`UPDATE "${t}" SET "${col}" = ? WHERE id = ?`).run(next, id);
          mutated += 1;
        }
      }
    }
    return mutated;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// (8) DRAIN-PATH GAPS: on rung 'prompt', a delivery drained from the queued
// recipe re-renders known_gaps computed LIVE at drain time from current store
// state — a gap edited between touch and drain shows the drained-time text,
// never the touch-time cache. Mirrors AC3's active-then-mutate sequencing in
// h19-drain-reresolve.test.mjs, generalized from supersede (new id) to an
// in-place text edit (same id) via technique (4).
// EXPECTED GREEN against the fixed implementation (regression net).
// SABOTAGE: revert to replaying the cached payload verbatim at drain (no live
// known_gaps re-read) — GAP_TOUCH_TIME_SENTINEL would then still appear (the
// stale cache), flipping the doesNotMatch assertion red, while
// GAP_DRAIN_TIME_SENTINEL would never appear, flipping the match assertion
// red too — this is the same failure shape AC3 already pins for decision
// bodies, extended to the known_gaps field specifically.
// ---------------------------------------------------------------------------

test('drain-path gaps: known_gaps are computed LIVE at drain time — a gap edited between touch and drain shows the drained-time text, not the touch-time cache', () => {
  const { dir, store, dbPath, cleanup } = makeProjectDrain({ rung: 'prompt' });
  try {
    const tools = mkTools(store);
    const created = tools.knowledgeCreate('feature_article', {
      slug: 'gapdrain',
      title: 'gapdrain',
      what_it_does: 'gapdrain does the gapdrain thing',
      intended_behavior: 'gapdrain intends',
      files: [{ path: 'src/a.mjs', role: 'owner' }],
      current_ac: [{ ac_id: 'AC1', text: 'gapdrain works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      history: [],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['scripts/tests/h19-known-gaps-inline.test.mjs'] }],
      known_gaps: [{ site: 'drain-gap-site', kind: 'other', evidence: 'GAP_TOUCH_TIME_SENTINEL text at touch time.', recorded_run: 'r1' }],
    }).record;

    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    const cached = pendingOf(dir)[0]?.payload ?? '';
    assert.match(cached, /GAP_TOUCH_TIME_SENTINEL/, 'fixture sanity: the touch-time gap text is really cached');

    const mutated = mutateRecordJsonText(dbPath, created.id, 'GAP_TOUCH_TIME_SENTINEL', 'GAP_DRAIN_TIME_SENTINEL');
    assert.ok(mutated >= 1, 'fixture sanity: the stored gap text was genuinely edited between touch and drain');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /GAP_DRAIN_TIME_SENTINEL/, 'the drained gap text reflects CURRENT store state at drain time');
    assert.doesNotMatch(ctx, /GAP_TOUCH_TIME_SENTINEL/, 'the stale touch-time cached gap text must never be served');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (9) ZERO-BUDGET DISCLOSURE: two owners of the same touched path; the
// first's 3 gaps consume the whole global budget; the second (total>0,
// shown 0) still renders its own KNOWN GAPS header plus a 0-of-N elision —
// never silent omission. Substance-anchored (not exact wording) per the
// coordinator's own framing.
// EXPECTED GREEN against the fixed implementation.
// SABOTAGE: skip rendering any gap section at all for an owner whose shown
// count is 0 (treat "nothing fit" as "nothing to say") — the
// known-gap-header/0-of-2 assertions go red while the alpha/doesNotMatch(b-*)
// assertions stay green, isolating the zero-shown disclosure as the failure.
// ---------------------------------------------------------------------------

test('zero-budget disclosure: the owning article whose gaps are entirely consumed by the other still renders its own KNOWN GAPS header and a 0-of-N elision — never a silent omission (order-agnostic: the budget winner is decided by record id, random per fixture — measured flaky 2026-09-01 when this pin assumed alpha always led)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // SYMMETRIC fixture: both articles carry 3 gaps, so whichever leads the
    // deterministic-by-id ordering consumes the whole global budget of 3 and
    // the other is ALWAYS zero-shown — the original asymmetric fixture (3+2)
    // only produced a zero-shown loser when alpha happened to sort first.
    store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [
          { site: 'a-gap-0', kind: 'other', evidence: 'Alpha gap zero sentence.', recorded_run: 'r1' },
          { site: 'a-gap-1', kind: 'other', evidence: 'Alpha gap one sentence.', recorded_run: 'r1' },
          { site: 'a-gap-2', kind: 'other', evidence: 'Alpha gap two sentence.', recorded_run: 'r1' },
        ],
      })
    );
    store.create(
      article('beta', ['src/a.mjs'], {
        known_gaps: [
          { site: 'b-gap-0', kind: 'other', evidence: 'Beta gap zero sentence.', recorded_run: 'r1' },
          { site: 'b-gap-1', kind: 'other', evidence: 'Beta gap one sentence.', recorded_run: 'r1' },
          { site: 'b-gap-2', kind: 'other', evidence: 'Beta gap two sentence.', recorded_run: 'r1' },
        ],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    const alphaWon = /a-gap-0/.test(ctx);
    const [winner, loser] = alphaWon ? ['a', 'b'] : ['b', 'a'];
    for (const i of [0, 1, 2]) {
      assert.match(ctx, new RegExp(`${winner}-gap-${i}`), `the budget winner shows all 3 of its gaps`);
      assert.doesNotMatch(ctx, new RegExp(`${loser}-gap-${i}`), 'the loser contributes 0 shown gaps once the winner exhausts the global budget');
    }
    assert.match(ctx, /alpha/i, 'both owning articles are named — no silent disappearance');
    assert.match(ctx, /beta/i);
    assert.match(ctx, /known.?gap/i, "the loser's own KNOWN GAPS header still renders even with 0 shown");
    const zeroElisions = ctx.match(/0\s*(?:of|\/)\s*3/g) ?? [];
    assert.equal(zeroElisions.length, 1, 'exactly ONE 0-of-3 elision — the loser discloses, the winner (3-of-3) carries none (rules out an unconditional 0-of-N stamp)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (10) GLOBAL SURVIVOR PRIORITY: two owners of one delivery — alpha
// (delivery-first) with 3 'other'-kind gaps, beta with 1 mutation_survivor
// gap. Beta's survivor must be among the 3 shown, AND the total shown across
// both owners stays exactly 3 (pooled, not multiplied per owner — the exact
// failure mode decision db3392db Part 3 names and rejects: "per-article
// budgets multiply unboundedly when several articles own one path").
// EXPECTED GREEN against the fixed implementation.
// SABOTAGE: cap each owner's gaps at 3 independently instead of pooling
// globally — alpha's 3 AND beta's 1 all render (total 4), flipping the
// `totalShown === 3` pooling assertion red even though the survivor
// still appears; alternatively, sort strictly by owner-then-array-order with
// no survivor priority — alpha's 3 fill the budget first, beta's survivor
// never renders, flipping the `survivorIdx >= 0` assertion red instead. Either
// mutation is caught by a different one of the two assertions below.
// ---------------------------------------------------------------------------

test('global survivor priority: a mutation_survivor gap from a SECOND owner is pooled into the shared 3-gap budget ahead of an ordinary gap from the FIRST owner', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [
          { site: 'alpha-other-0', kind: 'other', evidence: 'Alpha ordinary gap zero.', recorded_run: 'r1' },
          { site: 'alpha-other-1', kind: 'other', evidence: 'Alpha ordinary gap one.', recorded_run: 'r1' },
          { site: 'alpha-other-2', kind: 'other', evidence: 'Alpha ordinary gap two.', recorded_run: 'r1' },
        ],
      })
    );
    store.create(
      article('beta', ['src/a.mjs'], {
        known_gaps: [{ site: 'beta-survivor', kind: 'mutation_survivor', evidence: 'Beta survivor gap that a mutation left standing.', recorded_run: 'r9' }],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    const survivorIdx = ctx.indexOf('beta-survivor');
    assert.ok(survivorIdx >= 0, "the SECOND owner's mutation_survivor gap is among the 3 shown, despite the FIRST owner offering 3 ordinary gaps on its own");
    const survivorWindow = ctx.slice(Math.max(0, survivorIdx - 60), survivorIdx + 200);
    assert.match(survivorWindow, /WRONG-ON-PURPOSE/);

    const alphaSites = ['alpha-other-0', 'alpha-other-1', 'alpha-other-2'];
    const alphaShown = alphaSites.filter((s) => ctx.includes(s));
    assert.equal(alphaShown.length, 2, "exactly one of alpha's 3 ordinary gaps is bumped to make room for beta's pooled survivor");

    const totalShown = [...alphaSites, 'beta-survivor'].filter((s) => ctx.includes(s)).length;
    assert.equal(totalShown, 3, 'the global 3-gap budget is POOLED across owners, not multiplied per owner');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (11) SITE CLIPPING: a gap site >120 chars and/or multiline renders
// whitespace-normalized and clipped (~120) with a clip marker; the payload
// contains no raw newline from the site. A short control site in the SAME
// delivery renders whole and unclipped, ruling out a coincidental
// whole-payload truncation as the cause.
// EXPECTED GREEN against the fixed implementation.
// SABOTAGE: normalize whitespace but drop the length clip (render the full
// normalized site regardless of length) — the doesNotMatch(END-MARKER...)
// assertion goes red because the full tail now renders past the ~120-char
// point, while the short-site control assertion stays green (proving the
// failure is specific to the long site's clip, not the payload as a whole).
// ---------------------------------------------------------------------------

test('site clipping: a gap site longer than ~120 chars and/or multiline renders whitespace-normalized and clipped, with no raw newline — a short site in the same delivery renders in full (control)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rawSite = 'weapon-solver   window\nspans   multiple    physical\nlines and ' + 'padding '.repeat(15) + 'END-MARKER-SITE-TAIL';
    store.create(
      article('alpha', ['src/a.mjs'], {
        known_gaps: [
          { site: 'short-site', kind: 'other', evidence: 'Short site control evidence.', recorded_run: 'r1' },
          { site: rawSite, kind: 'other', evidence: 'Site clipping fixture evidence.', recorded_run: 'r1' },
        ],
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir));

    // CONTROL (asserted first): the ordinary short site renders whole.
    assert.match(ctx, /short-site/, 'the short control site renders in full');

    assert.doesNotMatch(ctx, /physical\nlines/, 'the raw newline inside the long site is never emitted verbatim');
    assert.match(ctx, /weapon-solver window/, 'the normalized, clipped prefix of the long site renders');
    assert.doesNotMatch(ctx, /END-MARKER-SITE-TAIL/, 'the tail past the ~120-char clip never renders — this is a SITE clip, not incidental payload truncation');

    const idx = ctx.indexOf('weapon-solver window');
    assert.ok(idx >= 0);
    const windowText = ctx.slice(idx, idx + 200);
    assert.match(windowText, /…|\.\.\./, 'the clip is disclosed with a marker, not a silent cut');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (12) DRAIN-PATH COVERAGE: postBash on a governed path whose owner carries a
// mutation_survivor gap, drained (not just enqueued) — the KNOWN GAPS header
// renders on its OWN line beneath the pointer, and a two-path command naming
// the SAME owner still emits the gap block only ONCE.
// SABOTAGE: revert bashPointerBlock to embedding the gap block into the
// pointer entry's `line` via a joined newline (the pre-fix newline-smuggling
// shape) instead of the separate `gapLines`/`gap_lines` field — the drain's
// unconditional flattenToOneLine() on `line` then collapses the whole gap
// block into the SAME line as the pointer, so the header-on-its-own-line
// assertion goes red.
// ---------------------------------------------------------------------------

test('drain-path (newline-smuggling revert -> header lands mid-line): a two-path command naming one owner drains the KNOWN GAPS header on its own line beneath the pointer, emitted once', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'prompt' });
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    writeFileSync(join(dir, 'src', 'b.mjs'), 'x\n');
    store.create(
      article('owner', ['src/a.mjs', 'src/b.mjs'], {
        known_gaps: [{ site: 'two-path-gap', kind: 'mutation_survivor', evidence: 'A mutation left this path standing.', recorded_run: 'r1' }],
      })
    );

    // ONE command naming BOTH paths owned by the SAME article.
    const r = runHook('h19-bash-delivery.mjs', postBash(dir, 'diff src/a.mjs src/b.mjs'), dir);
    assert.equal(r.code, 0, 'AC7: delivery never blocks');
    assert.equal(pendingOf(dir).length, 1, 'one queue batch for the one command');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    const lines = ctx.split('\n');

    const headerIdx = lines.findIndex((l) => l.trim() === 'KNOWN GAPS recorded for this territory:');
    assert.ok(headerIdx >= 0, '(a) KNOWN GAPS header renders on its OWN line at drain, not mid-line');

    const pointerIdx = lines.findIndex((l) => l.includes("article 'owner [owner]'"));
    assert.ok(pointerIdx >= 0 && pointerIdx < headerIdx, "(b) the owner's pointer line precedes the KNOWN GAPS header");
    const siteIdx = lines.findIndex((l) => l.includes('two-path-gap'));
    assert.ok(siteIdx > headerIdx, '(b) the gap site renders BENEATH the pointer line, after the header');
    assert.match(lines[siteIdx], /WRONG-ON-PURPOSE/, 'mutation_survivor framing present on the gap line');

    const headerCount = lines.filter((l) => l.trim() === 'KNOWN GAPS recorded for this territory:').length;
    const siteCount = lines.filter((l) => l.includes('two-path-gap')).length;
    assert.equal(headerCount, 1, '(c) only ONE gap-block emission for a two-path command naming the same owner');
    assert.equal(siteCount, 1, '(c) the gap site itself appears exactly once');
  } finally {
    cleanup();
  }
});

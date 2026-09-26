// H10 capture_pending grace, debt identity and fan-out hold — decision
// capture-pending-grace-per-declaration-held-while-any-dispatch-live
// (knowledge_get 294706f6), root cause in finding
// capture-pending-grace-voided-by-nag-marker-and-debt-dedup-drops-target-september-2026
// (knowledge_get b8ce1d54).
//
// (1) The one-Stop grace is counted PER DECLARATION: a nag that PRECEDES the
//     declaration (the normal order — the nag itself says "call
//     capture_pending") must not void it.
// (2) A lapsed declaration becomes debt keyed by its EXACT target: an open,
//     unrelated capture_owed never swallows it.
// (3) While ANY dispatch is presumed-active in the H22 register, the
//     declaration is neither converted nor re-demanded, whether or not its
//     text names an agent_id. After the last one lands: one grace Stop, then
//     conversion.
// A real capture still spends the declaration (decision b2474b26).
//
// NEW SIBLING FILE by the established precedent (the h10-*.test.mjs siblings
// duplicate their harness rather than importing one test file as a module,
// which would double-run its registered tests). Helpers below are copied in
// shape from h10-deferral-article-demand-and-pending-carry.test.mjs.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
const PENDING_AT = '2026-06-10T12:30:00.000Z';
const R_EVENT_AT = '2026-06-10T11:00:00.000Z';

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

function envelope(type, at = NOW) {
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

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-pgrace-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const hookInput = (dir, over = {}) => ({
  session_id: 's1',
  transcript_path: join(dir, 't', 's1.jsonl'),
  cwd: dir,
  permission_mode: 'default',
  ...over,
});

const stopOnce = (dir) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

const touchesPath = (dir) => join(dir, '.sterling', 'transient', 'touches.json');
const eventsPath = (dir) => join(dir, '.sterling', 'transient', 'session-events.json');
const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');

function touchRegister(dir, paths, at = NOW) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}

const readEvents = (dir) => (existsSync(eventsPath(dir)) ? JSON.parse(readFileSync(eventsPath(dir), 'utf8')) : []);

// Appends the way the capture_pending tool does (tools.ts appendSessionEvents):
// read, push {kind, detail, at: now}, write back.
function declarePending(dir, detail) {
  writeSessionEvents(dir, [...readEvents(dir), { kind: 'capture_pending', detail, at: new Date().toISOString() }]);
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), JSON.stringify(content));
}

const liveEntry = (agentId, files, agentType = 'coder', sessionId = 's1') => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
  files,
  at: new Date().toISOString(),
});

const cpEvent = (detail, at = PENDING_AT) => ({ kind: 'capture_pending', detail, at });
const rEvent = (detail, at = R_EVENT_AT) => ({ kind: 'research_tool', detail, at });
const hasDeclaration = (dir) => readEvents(dir).some((e) => e.kind === 'capture_pending');

function captureDecision(store, at = CAPTURE_AT) {
  store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);
const captureOwed = (store) => owed(store, 'capture_owed');

function seedUnrelatedCaptureOwed(store) {
  store.enqueueSystemTodo({
    ...envelope('todo'),
    author: 'system',
    text: 'capture owed: an older session touched src/old/legacy.mjs and ended without capture',
    source: 'system',
    system_reason: 'capture_owed',
    file_keys: ['src/old/legacy.mjs'],
  });
}

const WORKFILE = 'src/pending/work.mjs';
// Names NO agent_id: the hold must not depend on the text naming a dispatch.
const DETAIL = 'commit-7f3a9c — decision on the retry policy rides the pending commit';

test('PG-a (grace per declaration, RED at a0c0360): nag, THEN declare, then Stop defers — no debt, declaration kept; the next Stop converts', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeRegisterRaw(dir, []);

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'PRECONDITION: an undeclared capture duty nags first');
    assert.match(nag.stderr, /capture_pending/, 'PRECONDITION: the nag names capture_pending as a remedy');

    declarePending(dir, DETAIL);

    const grace = stopOnce(dir);
    assert.equal(grace.code, 0, 'the declaration defers the capture duty');
    assert.equal(captureOwed(store).length, 0, 'VOIDED-GRACE SHAPE if this is 1: a nag that PRECEDED the declaration spent its grace, so the declaration lived zero Stops');
    assert.equal(hasDeclaration(dir), true, 'the declaration survives its grace Stop');
    assert.equal(existsSync(touchesPath(dir)), true, 'the grace release is non-terminal');

    const convert = stopOnce(dir);
    assert.equal(convert.code, 0, 'the converting Stop releases');
    const items = captureOwed(store);
    assert.equal(items.length, 1, 'the lapsed declaration converts on the Stop after its grace');
    assert.match(items[0].text, /commit-7f3a9c/, 'the debt cites the declared target');
    assert.equal(existsSync(eventsPath(dir)), false, 'the conversion is terminal');
  } finally {
    cleanup();
  }
});

test('PG-b (exact-target debt, pending branch, RED at a0c0360): an open UNRELATED capture_owed does not swallow the lapsed declaration\'s debt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedUnrelatedCaptureOwed(store);
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(DETAIL)]);
    writeRegisterRaw(dir, []);

    assert.equal(stopOnce(dir).code, 0, 'grace Stop');
    assert.equal(captureOwed(store).length, 1, 'only the seeded item on the grace Stop');
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    const items = captureOwed(store);
    assert.equal(items.length, 2, `SWALLOWED-DEBT SHAPE if this is 1: the declaration was cleared while an unrelated open capture_owed suppressed its own item (texts: ${JSON.stringify(items.map((t) => t.text))})`);
    assert.ok(items.some((t) => /commit-7f3a9c/.test(t.text)), 'the lapsed target has its own item');
    assert.ok(items.some((t) => /legacy\.mjs/.test(t.text)), 'the unrelated item is untouched');
    assert.equal(stopOnce(dir).code, 0);
    assert.equal(captureOwed(store).length, 2, 'DUPLICATION SHAPE if this exceeds 2: the target\'s debt is deduped');
  } finally {
    cleanup();
  }
});

test('PG-b2 (exact-target debt, second-pass site, RED at a0c0360): with research still open the lapsed declaration converts at the second pass even though an unrelated capture_owed is open', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedUnrelatedCaptureOwed(store);
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [rEvent('WebSearch retry policy'), cpEvent(DETAIL)]);
    writeRegisterRaw(dir, []);

    assert.equal(stopOnce(dir).code, 2, 'PRECONDITION: the open research duty nags, so the pending branch is not reached');
    assert.equal(stopOnce(dir).code, 0, 'the second pass releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'PRECONDITION: this Stop took the second pass');
    const items = captureOwed(store);
    assert.equal(items.length, 2, `SWALLOWED-DEBT SHAPE if this is 1 (texts: ${JSON.stringify(items.map((t) => t.text))})`);
    assert.ok(items.some((t) => /commit-7f3a9c/.test(t.text)), 'the lapsed target has its own item');
  } finally {
    cleanup();
  }
});

test('PG-a2 (grace per declaration, second-pass site, RED at a0c0360): nag with research open, THEN declare, then Stop queues the research but defers the capture; the next Stop converts', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [rEvent('WebSearch retry policy')]);
    writeRegisterRaw(dir, []);

    assert.equal(stopOnce(dir).code, 2, 'PRECONDITION: capture and research nag');
    declarePending(dir, DETAIL);

    assert.equal(stopOnce(dir).code, 0, 'the second pass releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the research duty is queued as before — the declaration says nothing about it');
    assert.equal(captureOwed(store).length, 0, 'VOIDED-GRACE SHAPE if this is 1: the nag that preceded the declaration spent its grace at the second pass');
    assert.equal(hasDeclaration(dir), true, 'the declaration survives its grace Stop');
    assert.equal(existsSync(touchesPath(dir)), true, 'the capture work survives with it, so the debt cannot evaporate');

    assert.equal(stopOnce(dir).code, 0, 'the converting Stop releases');
    const items = captureOwed(store);
    assert.equal(items.length, 1, 'exactly one grace Stop, then conversion');
    assert.match(items[0].text, /commit-7f3a9c/);
    assert.equal(existsSync(eventsPath(dir)), false, 'the conversion is terminal');
  } finally {
    cleanup();
  }
});

test('PG-c (hold while any dispatch is live, RED at a0c0360): a live dispatch the text does NOT name holds the declaration across three Stops; after it lands, one grace Stop, then conversion', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(DETAIL)]);
    // The live entry owns a file that was NOT touched, so the fan-out FILE
    // deferral cannot be what defers WORKFILE — only the declaration can.
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    for (let i = 1; i <= 3; i += 1) {
      const r = stopOnce(dir);
      assert.equal(r.code, 0, `Stop ${i}: held, never re-demanded`);
      assert.equal(captureOwed(store).length, 0, `Stop ${i}: HELD-DECLARATION-CONVERTED SHAPE — a dispatch is still live, so the declaration must not become debt`);
      assert.equal(hasDeclaration(dir), true, `Stop ${i}: the held declaration survives on disk`);
      assert.equal(existsSync(touchesPath(dir)), true, `Stop ${i}: the hold is non-terminal`);
    }

    writeRegisterRaw(dir, []); // the dispatch's terminal hook removed its row

    assert.equal(stopOnce(dir).code, 0, 'first Stop with nothing live');
    assert.equal(captureOwed(store).length, 0, 'NO-GRACE-AFTER-HOLD SHAPE if this is 1: the normal one-Stop grace applies from the first Stop with nothing live');
    assert.equal(hasDeclaration(dir), true, 'still declared through the grace Stop');

    assert.equal(stopOnce(dir).code, 0, 'the converting Stop releases');
    const items = captureOwed(store);
    assert.equal(items.length, 1, 'EVAPORATION SHAPE if this is 0: after the grace the lapsed declaration becomes debt');
    assert.match(items[0].text, /commit-7f3a9c/);
    assert.equal(existsSync(eventsPath(dir)), false, 'the conversion is terminal');
  } finally {
    cleanup();
  }
});

test('PG-c2 (hold at the second-pass site, RED at a0c0360): with research open and an unnamed dispatch live, the second pass queues the research but neither converts nor drops the declaration', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [rEvent('WebSearch retry policy'), cpEvent(DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    assert.equal(stopOnce(dir).code, 2, 'PRECONDITION: the open research duty nags');
    assert.equal(stopOnce(dir).code, 0, 'the second pass releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'PRECONDITION: this Stop took the second pass');
    assert.equal(captureOwed(store).length, 0, 'HELD-DECLARATION-CONVERTED SHAPE at the second pass');
    assert.equal(hasDeclaration(dir), true, 'the held declaration survives the second pass');
    assert.equal(existsSync(touchesPath(dir)), true, 'the capture work survives with it');

    writeRegisterRaw(dir, []);
    assert.equal(stopOnce(dir).code, 0, 'grace Stop after the dispatch lands');
    assert.equal(captureOwed(store).length, 0, 'one grace Stop after the hold');
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    assert.equal(captureOwed(store).length, 1, 'then conversion');
  } finally {
    cleanup();
  }
});

test('PG-d (GUARD, green before and after): a real capture spends the declaration even while a dispatch is live; later work is demanded afresh', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    assert.equal(stopOnce(dir).code, 0, 'deferred');
    captureDecision(store);

    assert.equal(stopOnce(dir).code, 0, 'the landed capture settles');
    assert.equal(captureOwed(store).length, 0, 'the capture paid the duty');
    assert.equal(hasDeclaration(dir), false, 'STUCK-DECLARATION SHAPE if true: a real capture spends the declaration (decision b2474b26), live dispatch or not');

    touchRegister(dir, ['src/pending/later.mjs'], new Date().toISOString());
    const later = stopOnce(dir);
    assert.equal(later.code, 2, 'later capture work is demanded, not silently deferred by a spent declaration');
    assert.match(later.stderr, /capture_pending/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FIX ROUND (outside-family review of the first diff). Each arm below was red
// against that diff.
// ===========================================================================

// One full lapse cycle for one declaration over the given touched files,
// through the pending branch (two Stops: grace, convert) or through the
// second-pass site (an open research duty forces the nag, then the second
// pass converts). Every register is cleared by the conversion, so cycles
// compose within one project.
function lapseCycle(dir, detail, files, { secondPass = false } = {}) {
  touchRegister(dir, files);
  writeSessionEvents(dir, secondPass ? [rEvent('WebSearch lapse'), cpEvent(detail)] : [cpEvent(detail)]);
  writeRegisterRaw(dir, []);
  const codes = [stopOnce(dir).code, stopOnce(dir).code];
  assert.equal(existsSync(eventsPath(dir)), false, `PRECONDITION: the cycle ended in a terminal conversion (codes ${codes.join(', ')})`);
  return codes;
}

const TARGET_A = 'commit-aaaa111 — capture A rides this commit';
const TARGET_B = 'commit-bbbb222 — capture B rides this commit';
const OTHERFILE = 'src/pending/other.mjs';

for (const secondPass of [false, true]) {
  const site = secondPass ? 'second-pass site' : 'pending branch';

  // EXACT identity (final round): the declared target is compared byte-exact
  // after trimming — no split on ' — ', no case folding.
  for (const [a, b, why] of [
    ['release — phase 2 — capture rides the release', 'release — phase 3 — capture rides the release', "a ' — ' inside the target is not a delimiter"],
    ['Release X — capture rides it', 'release x — capture rides it', 'case is part of the identity'],
  ]) {
    test(`PG-e3 (exact target identity, ${site}): ${JSON.stringify(a)} and ${JSON.stringify(b)} are two items (${why})`, () => {
      const { dir, store, cleanup } = makeProject();
      try {
        lapseCycle(dir, a, [WORKFILE], { secondPass });
        lapseCycle(dir, b, [WORKFILE], { secondPass });
        const items = captureOwed(store);
        assert.equal(items.length, 2, `NORMALIZED-IDENTITY SHAPE if 1 (texts: ${JSON.stringify(items.map((t) => t.text))})`);
      } finally {
        cleanup();
      }
    });
  }

  test(`PG-e1 (target identity, ${site}): two DIFFERENT targets over the SAME touched file are two capture_owed items`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      lapseCycle(dir, TARGET_A, [WORKFILE], { secondPass });
      lapseCycle(dir, TARGET_B, [WORKFILE], { secondPass });
      const items = captureOwed(store);
      assert.equal(items.length, 2, `OVERWRITTEN-TARGET SHAPE if 1: target B joined target A's item because they share file_keys (texts: ${JSON.stringify(items.map((t) => t.text))})`);
      assert.ok(items.some((t) => /commit-aaaa111/.test(t.text)), 'A keeps its own item');
      assert.ok(items.some((t) => /commit-bbbb222/.test(t.text)), 'B has its own item');
    } finally {
      cleanup();
    }
  });

  test(`PG-e2 (target identity, ${site}): the SAME EXACT declared target over DIFFERENT touched files is one capture_owed item`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      lapseCycle(dir, TARGET_A, [WORKFILE], { secondPass });
      lapseCycle(dir, TARGET_A, [OTHERFILE], { secondPass });
      const items = captureOwed(store);
      assert.equal(items.length, 1, `DUPLICATED-TARGET SHAPE if 2: file_keys are context, the target is the identity (texts: ${JSON.stringify(items.map((t) => t.text))})`);
      assert.match(items[0].text, /commit-aaaa111/);
    } finally {
      cleanup();
    }
  });
}

test('PG-f1 (per-declaration conversion): two declarations that lapse together each become their own debt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(TARGET_A, '2026-06-10T12:10:00.000Z'), cpEvent(TARGET_B, '2026-06-10T12:20:00.000Z')]);
    writeRegisterRaw(dir, []);
    assert.equal(stopOnce(dir).code, 0, 'grace Stop');
    assert.equal(captureOwed(store).length, 0);
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    const items = captureOwed(store);
    assert.equal(items.length, 2, `COLLAPSED-DECLARATIONS SHAPE if 1: the terminal clear dropped declaration A with no debt (texts: ${JSON.stringify(items.map((t) => t.text))})`);
    assert.equal(existsSync(eventsPath(dir)), false, 'the conversion is terminal');
  } finally {
    cleanup();
  }
});

test('PG-f2 (per-declaration grace): a lapsed declaration A converts while a newer declaration B is still in its grace; B converts on the next Stop', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(TARGET_A)]);
    writeRegisterRaw(dir, []);
    assert.equal(stopOnce(dir).code, 0, 'A: grace Stop');

    declarePending(dir, TARGET_B);
    assert.equal(stopOnce(dir).code, 0, 'A lapses, B is in grace');
    let items = captureOwed(store);
    assert.equal(items.length, 1, `A's grace is spent, so A converts now; B's has not (texts: ${JSON.stringify(items.map((t) => t.text))})`);
    assert.match(items[0].text, /commit-aaaa111/, 'the item is A\'s');
    assert.equal(readEvents(dir).some((e) => e.kind === 'capture_pending' && e.detail === TARGET_B), true, 'B survives its grace Stop');

    assert.equal(stopOnce(dir).code, 0, 'B converts');
    items = captureOwed(store);
    assert.equal(items.length, 2, 'B has its own debt');
    assert.ok(items.some((t) => /commit-bbbb222/.test(t.text)));
    stopOnce(dir);
    assert.equal(captureOwed(store).length, 2, 'no duplicates');
  } finally {
    cleanup();
  }
});

test('PG-g (clock skew): a declaration stamped in the future still gets exactly one grace Stop, then converts', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(DETAIL, '2099-01-01T00:00:00.000Z')]);
    writeRegisterRaw(dir, []);
    assert.equal(stopOnce(dir).code, 0, 'grace Stop');
    assert.equal(captureOwed(store).length, 0);
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    assert.equal(captureOwed(store).length, 1, 'ENDLESS-GRACE SHAPE if 0: a future `at` kept the grace unspent by wall-clock comparison');
  } finally {
    cleanup();
  }
});

function sha256hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function articleWithBaseline(store, slug, files, at = NOW) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(files.map((f) => [f.path, sha256hex(f.content)])),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

test('PG-h (no settlement while the capture is deferred at the second pass): settlement waits for the terminal Stop, and is not lost', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const OWNED = 'src/pending/owned.mjs';
    // Created BEFORE the touch, so the article itself does not count as this
    // session's capture.
    articleWithBaseline(store, 'pending-owned', [{ path: OWNED, content: 'v1\n' }], '2026-06-10T10:00:00.000Z');
    touchRegister(dir, [OWNED]);
    writeFileSync(join(dir, OWNED), 'v2\n'); // differs from the article baseline
    writeSessionEvents(dir, [rEvent('WebSearch settle'), cpEvent(DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);
    const reconcile = () => owed(store, 'reconcile_needed');

    assert.equal(stopOnce(dir).code, 2, 'PRECONDITION: research nags');
    assert.equal(stopOnce(dir).code, 0, 'second pass, capture held');
    assert.equal(owed(store, 'research_owed').length, 1, 'PRECONDITION: this Stop took the second pass');
    assert.equal(reconcile().length, 0, 'EARLY-SETTLEMENT SHAPE if 1: settlement ran while the capture (which may rebaseline the article) is still outstanding');

    writeRegisterRaw(dir, []);
    stopOnce(dir); // grace
    stopOnce(dir); // convert, terminal: settles
    assert.equal(captureOwed(store).length, 1, 'the lapsed declaration converted');
    assert.equal(reconcile().length, 1, 'LOST-SETTLEMENT SHAPE if 0: the deferred candidates still settle at the terminal Stop');
  } finally {
    cleanup();
  }
});

test('PG-j (a deferring second pass never hides an article demand): 1 unowned path below the threshold, then 2 fresh unowned touches, demand the article for all 3', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const U = ['src/unowned/one.mjs', 'src/unowned/two.mjs', 'src/unowned/three.mjs'];
    touchRegister(dir, [U[0]]);
    writeSessionEvents(dir, [rEvent('WebSearch demand'), cpEvent(DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    assert.equal(stopOnce(dir).code, 2, 'PRECONDITION: research nags; one unowned path is under the threshold of 3');
    assert.equal(stopOnce(dir).code, 0, 'the second pass defers the held capture');
    assert.equal(owed(store, 'research_owed').length, 1, 'PRECONDITION: this Stop took the second pass');
    assert.equal(existsSync(touchesPath(dir)), true, 'PRECONDITION: the capture work was retained');

    // Two fresh touches arrive the way H7 appends them.
    const later = new Date().toISOString();
    for (const p of U.slice(1)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), '// touched\n');
    }
    const current = JSON.parse(readFileSync(touchesPath(dir), 'utf8'));
    writeFileSync(touchesPath(dir), JSON.stringify([...current, ...U.slice(1).map((path) => ({ path, at: later }))]));

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'HIDDEN-DEMAND SHAPE if 0: the retained path no longer counted toward the article demand');
    assert.match(r.stderr, /article demand/i);
    for (const p of U) assert.match(r.stderr, new RegExp(p.replace(/[.]/g, '\\.')), `${p} is named in the demand`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// TARGET FIELD (board f003082d residual 1): capture_pending records `target`
// as its own field on the session event (tools.ts), and the debt is keyed on
// that field alone, so the same target declared with a different reason is
// ONE item. A legacy event carries only the joined `detail` and keeps keying on
// the whole detail (PG-e1/e2/e3 above pin that; no split on ' — ').
// ===========================================================================

const cpTargetEvent = (target, reason, at = PENDING_AT) => ({ kind: 'capture_pending', detail: `${target} — ${reason}`, target, at });

for (const secondPass of [false, true]) {
  const site = secondPass ? 'second-pass site' : 'pending branch';

  test(`PG-k1 (target field, ${site}): the SAME target declared with DIFFERENT reasons across two lapses is one capture_owed item`, () => {
    const { dir, store, cleanup } = makeProject();
    try {
      for (const [reason, files] of [['decision A rides it', [WORKFILE]], ['decision B rides it', [OTHERFILE]]]) {
        touchRegister(dir, files);
        const decl = cpTargetEvent('commit-cccc333', reason);
        writeSessionEvents(dir, secondPass ? [rEvent('WebSearch lapse'), decl] : [decl]);
        writeRegisterRaw(dir, []);
        stopOnce(dir);
        stopOnce(dir);
        assert.equal(existsSync(eventsPath(dir)), false, 'PRECONDITION: the cycle ended in a terminal conversion');
      }
      const items = captureOwed(store);
      assert.equal(items.length, 1, `REASON-IN-IDENTITY SHAPE if 2: the reason split one target into two debts (texts: ${JSON.stringify(items.map((t) => t.text))})`);
      assert.match(items[0].text, / \[target "commit-cccc333"\]$/, 'the trailer carries the target alone');
    } finally {
      cleanup();
    }
  });
}

test('PG-k2 (target field, one Stop): two declarations of one target with different reasons that lapse together are one capture_owed item', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [
      cpTargetEvent('commit-dddd444', 'first reason', '2026-06-10T12:10:00.000Z'),
      cpTargetEvent('commit-dddd444', 'second reason', '2026-06-10T12:20:00.000Z'),
    ]);
    writeRegisterRaw(dir, []);
    assert.equal(stopOnce(dir).code, 0, 'grace Stop');
    assert.equal(stopOnce(dir).code, 0, 'converting Stop');
    const items = captureOwed(store);
    assert.equal(items.length, 1, `REASON-IN-IDENTITY SHAPE if 2 (texts: ${JSON.stringify(items.map((t) => t.text))})`);
    assert.match(items[0].text, /^capture owed: declared pending \(commit-dddd444 — second reason\)/, 'the readable head shows the latest declaration of the target');
  } finally {
    cleanup();
  }
});

// H19 delivery receipts are session-keyed. SessionStart only clears a receipt
// directory when compaction has removed that SAME session's context.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = join(root, 'scripts', 'hooks', 'h19-clear-session.mjs');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-20T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function sessionDir(dir, sessionId) {
  return join(dir, '.sterling', 'transient', 'delivery', encodeURIComponent(sessionId));
}

function runClear(dir, source, sessionId) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir, source, session_id: sessionId }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dgs-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runHook(script, input, cwd) {
  const result = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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

function makeProject({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dgs-'));
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
  session_id: 's1',
  cwd: dir,
  ...extra,
});

test('compact removes only the compacted session delivery directory', () => {
  const { dir, cleanup } = project();
  try {
    const compacted = sessionDir(dir, 'session-a');
    const concurrent = sessionDir(dir, 'session-b');
    mkdirSync(compacted, { recursive: true });
    mkdirSync(concurrent, { recursive: true });
    writeFileSync(join(compacted, 'guard-conductor.json'), '{}');
    writeFileSync(join(concurrent, 'guard-conductor.json'), '{}');

    const result = runClear(dir, 'compact', 'session-a');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(compacted), false, 'the compacted session loses its receipts');
    assert.equal(existsSync(concurrent), true, 'a concurrent session never shares this cleanup target');
  } finally {
    cleanup();
  }
});

test('resume keeps the current session delivery directory', () => {
  const { dir, cleanup } = project();
  try {
    const current = sessionDir(dir, 'session-a');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'guard-conductor.json'), '{}');

    const result = runClear(dir, 'resume', 'session-a');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(current), true);
  } finally {
    cleanup();
  }
});

test('startup and clear leave an earlier session directory untouched', () => {
  for (const source of ['startup', 'clear']) {
    const { dir, cleanup } = project();
    try {
      const earlier = sessionDir(dir, 'session-a');
      mkdirSync(earlier, { recursive: true });
      writeFileSync(join(earlier, 'guard-conductor.json'), '{}');
      const result = runClear(dir, source, 'session-b');
      assert.equal(result.code, 0, `${source}: ${result.stderr}`);
      assert.equal(existsSync(earlier), true, `${source} relies on its new session id rather than removing an earlier directory`);
    } finally {
      cleanup();
    }
  }
});

test('a compact without session_id announces degradation and has no cleanup target', () => {
  const { dir, cleanup } = project();
  try {
    const existing = sessionDir(dir, 'session-a');
    mkdirSync(existing, { recursive: true });
    const result = runClear(dir, 'compact', undefined);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /session_id missing.*deduplication disabled/i);
    assert.equal(existsSync(existing), true, 'missing identity cannot select another session directory');
  } finally {
    cleanup();
  }
});

test('the clear hook has no rotation-note dependency', () => {
  assert.doesNotMatch(readFileSync(hook, 'utf8'), /rotation-note/i);
});

// ---------------------------------------------------------------------------
// AC3 — SUPERSEDED 2026-09-20 (decision knowledge-delivery-target-design-no-
// delayed-delivery, 92088a62, delivery-migration step 3). The old assertion
// here was `assert.equal(second.stdout, '', '2026-09-19: an edited version of
// already-delivered knowledge must not re-deliver directly')` — lineage-keyed
// (slug-based) suppression that silently swallowed a forward-fix's corrected
// content forever. Decision 92088a62's STATE clause rules the opposite way:
// the guard keys on (id, revision), so a record superseded by knowledge_update
// (new id, bumped content) is NOT the same (id, revision) as what was marked
// delivered, and DOES re-deliver — the reader must see the correction, not a
// stale silence. (This is also, mechanically, just "scope growth": a
// supersede mints a genuinely new id, indistinguishable at the guard from any
// other new record on the same path — there is no special-case suppression to
// preserve.) A genuinely NEW record on the same path still delivers too,
// exactly as before.
// ---------------------------------------------------------------------------

test('AC3: a record superseded by knowledge_update (new id, same slug) DOES re-deliver its corrected content, and a genuinely new record on the same path still does too', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const alpha = store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(first.code, 0, first.stderr);
    let payload = JSON.parse(first.stdout).hookSpecificOutput.additionalContext; // 2026-09-19: direct read transport.
    assert.match(payload, /alpha does the alpha thing/);

    // Simulate a knowledge_update: the store's supersede path mints a NEW id for
    // the SAME lineage/slug — this is the exact shape a fix-it-forward correction
    // takes (CLAUDE.md "To correct a wrong record, fix it FORWARD").
    store.supersede(alpha.id, {
      ...alpha,
      id: randomUUID(),
      version: 2,
      what_it_does: 'alpha does the alpha thing, reconciled',
      created_at: NOW,
      updated_at: NOW,
      status: 'active',
      superseded_by: null,
      links: [],
    });

    // Decision 92088a62: a re-versioned record (new id here, since supersede
    // always mints one) is NOT the (id, revision) pair the guard marked
    // delivered — it re-delivers, carrying the RECONCILED content.
    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondPayload, /alpha does the alpha thing, reconciled/, 'the forward-fixed content reaches the reader instead of staying silently suppressed');

    // Scope growth must still re-arm: a genuinely NEW article (different lineage)
    // added to the SAME path is new knowledge, not a re-delivery of old knowledge.
    store.create(article('gamma', ['src/a.mjs']));
    const third = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(third.code, 0, third.stderr);
    payload = JSON.parse(third.stdout).hookSpecificOutput.additionalContext; // 2026-09-19: direct read transport.
    assert.match(payload, /gamma does the gamma thing/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3b — SAME-ID revision case (fix-round test-integrity requirement, HIGH 3):
// AC3 above only exercises supersede's NEW-id path. The load-bearing case per
// decision 92088a62's STATE clause + fix-round HIGH 3 is a SAME-id in-place
// forward-fix (`store.updateRecord`, the `knowledge_update` shape) — id does
// NOT change, only `version` (store-managed, bumped by the store itself) —
// and `recordRevision` must key PRIMARILY on that version, not `updated_at`
// (which a caller can resubmit unchanged on an in-place edit).
// ---------------------------------------------------------------------------

test('AC3b: a record forward-fixed IN PLACE (same id, store-bumped version, UNCHANGED updated_at) DOES re-deliver its corrected content', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const alpha = store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /alpha does the alpha thing/);

    // In-place update, SAME id, and `updated_at` deliberately left UNCHANGED
    // (`updateRecord` takes a full body, not a diff — the store still bumps
    // `version` itself regardless of what the caller passed for the clock).
    // If revision keying fell back to `updated_at` first, this exact
    // scenario would collide with the mark from `first` and stay silent.
    const updated = store.updateRecord(alpha.id, { ...alpha, what_it_does: 'alpha does the alpha thing, reconciled in place', updated_at: alpha.updated_at });
    assert.equal(updated.id, alpha.id, 'fixture control: same id, an in-place edit');
    assert.equal(updated.updated_at, alpha.updated_at, 'fixture control: updated_at is UNCHANGED — version is the only signal that moved');
    assert.ok(updated.version > alpha.version, 'fixture control: the store bumped version on its own');

    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.code, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondPayload, /alpha does the alpha thing, reconciled in place/, 'the SAME-id forward-fix reaches the reader — keyed on the bumped version, not an unchanged updated_at');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — regression smoke: the existing once-per-session dedup for an unchanged
// record is untouched. The full battery for this is pinned in
// h19-delivery.test.mjs ("guard: same file and same-article new file stay
// silent..."); this is a single smoke assertion, not a duplicate of that suite.
// ---------------------------------------------------------------------------

test('AC4 (smoke): an unchanged record does not re-deliver on a repeat touch of the same file', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    const first = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /alpha does the alpha thing/); // 2026-09-19: direct read transport.
    const second = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(second.stdout, '', '2026-09-19: no repeat direct delivery for an unchanged record');
  } finally {
    cleanup();
  }
});

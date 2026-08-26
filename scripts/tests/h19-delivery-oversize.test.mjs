// H19 knowledge-delivery OVERSIZE cap/digest (board 725299c8, research_finding
// 2b67ba97). SPEC-ONLY, written before the fix — RED until built.
//
// THE DEFECT (measured 2026-08-26): the PostToolUse:Read delivery block renders
// the owning feature_article's `what_it_does` as SUBSTANCE inline. For a large
// article (hooks-suite what_it_does ~26k tokens) the delivered block reached
// ~18.9KB and OVERFLOWED the receiving agent's tool-result view ("Output too
// large", persisted to a file the reader could not quote from) — delivery
// degrades exactly at the surface it exists to serve.
//
// THE FIX (delivery-not-gate lineage, decision 9950dfff — must NOT deny a tool
// call): past a size floor, the delivery DIGESTS/CAPS the substance and emits a
// POINTER (knowledge_get <id> / windowed-read guidance) instead of the full
// body; below the floor, delivery is unchanged.
//
// SIZE CONSTANTS THE CODER MUST MATCH (stated so the fix meets the pins):
//   FLOOR  — what_it_does length above which delivery digests. Recommended 4096
//            chars (a defensible KB-scale floor; the item left it unspecified).
//            These tests leave the floor a WIDE margin (small ~35 chars, large
//            ~26000 chars) so any defensible nearby floor passes — the pins do
//            NOT knife-edge the exact trigger value.
//   CEILING — the delivered block's hard byte ceiling. Pinned FIRM at 8192 bytes:
//            comfortably below the ~18.9KB overflow AND below the ~17KB tool-view
//            threshold observed this session. This is the load-bearing guard.
//
// Determinism: no timing, no network. Fixture store + tmp dir removed in finally.
// Child stderr flattened with oneLine (anti-pattern ee89c3fd).
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
const NOW = '2026-07-19T12:00:00.000Z';

// The hard byte ceiling the digested block must stay under (see header).
const CEILING_BYTES = 8192;

const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-oversize-'));
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

// A ~26KB what_it_does mirroring hooks-suite's real offender. HEAD sits at the
// start, TAIL at the very end: a digest that keeps only a head excerpt (or a
// pointer) drops TAIL, an uncapped full-body delivery keeps it.
const HEAD = 'BODY_HEAD_SENTINEL_a1b2c3';
const TAIL = 'BODY_TAIL_SENTINEL_z9y8x7';
const bigBody = `${HEAD} ${'padding word '.repeat(2000)} ${TAIL}`; // ~26000 chars

const ctxOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

// ---------------------------------------------------------------------------
// AC1 — CAP OVER FLOOR. When the owning article's substance exceeds the floor,
// the delivered block is CAPPED below the hard ceiling AND carries a pointer
// (knowledge_get / windowed-read guidance) instead of the full body.
//
// A control arm leads: the block must still DELIVER something that names the
// article — a green from an EMPTY block would satisfy the ceiling for the wrong
// reason (hollow). So we prove non-emptiness first, then the cap.
//
// SABOTAGE: remove the cap (render what_it_does whole) → block exceeds ceiling
//   (~26KB > 8192) and TAIL reappears → AC1 goes RED.
// RED NOW (pre-fix): the full body is delivered, so byteLength > 8192 and there
//   is no pointer → the cap + pointer assertions fail. Correct red.
// ---------------------------------------------------------------------------
test('AC1: an over-floor article is CAPPED below the ceiling and delivers a pointer, not the full body', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('bighook', ['src/a.mjs'], { what_it_does: bigBody }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, `delivery must not block (AC7/9950dfff): ${oneLine(r.stderr)}`);
    const ctx = ctxOf(r);

    // CONTROL (must pass for the opposite reason): the block is non-empty and
    // still names this article — a cap that delivered nothing would be hollow.
    assert.match(ctx, /STERLING KNOWLEDGE DELIVERY/, 'the delivery block still renders');
    assert.match(ctx, /article 'bighook'/, 'and still names the owning article');

    // CAP: the whole block stays under the hard byte ceiling.
    const bytes = Buffer.byteLength(ctx, 'utf8');
    assert.ok(bytes < CEILING_BYTES, `oversize delivery must be capped below ${CEILING_BYTES} bytes (was ${bytes})`);

    // Not the full body: the tail of the 26KB substance is dropped by the digest.
    assert.ok(!ctx.includes(TAIL), 'the article body is digested, not emitted whole (TAIL must be dropped)');

    // POINTER: a knowledge_get instruction / windowed-read guidance replaces the
    // withheld body so the reader can still fetch it.
    assert.match(ctx, /knowledge_get/, 'a pointer replaces the withheld body');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 — SMALL UNCHANGED (control). Below the floor, the FULL substance is
// delivered inline as before — no pointer-only degradation.
//
// SABOTAGE: always digest (digest regardless of size) → the small body is
//   replaced by a pointer → its what_it_does string disappears → AC2 goes RED.
// PASSES NOW and after the fix: small articles deliver their body whole today.
// ---------------------------------------------------------------------------
test('AC2 (control): a below-floor article delivers its full substance inline, undigested', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('smallhook', ['src/a.mjs'])); // what_it_does ~35 chars, well under floor
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, `delivery must not block: ${oneLine(r.stderr)}`);
    const ctx = ctxOf(r);
    assert.match(ctx, /smallhook does the smallhook thing/, 'the full body is delivered inline for a small article');
    const bytes = Buffer.byteLength(ctx, 'utf8');
    assert.ok(bytes < CEILING_BYTES, `a small delivery is trivially under the ceiling (was ${bytes})`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — NEVER DENIES (control). Delivery is an aid, not a gate: even the oversize
// path exits 0 (exit 2 is the only blocking code; a delivery failure is exit 1,
// loud on stderr — but the happy oversize path is a clean 0).
//
// SABOTAGE: make the hook deny / exit nonzero on the oversize branch → AC3 RED.
// PASSES NOW and after the fix: the hook already exits 0 delivering the body;
// the overflow was in the RECEIVER's view, never the hook's exit.
// ---------------------------------------------------------------------------
test('AC3 (control): the oversize delivery still exits 0 — delivery is not a gate (9950dfff)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    store.create(article('bighook', ['src/a.mjs'], { what_it_does: bigBody }));
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.notEqual(r.code, 2, `delivery must never DENY the tool call: ${oneLine(r.stderr)}`);
    assert.equal(r.code, 0, `the happy oversize path is a clean exit 0: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — POINTER RESOLVES. The pointer emitted for the oversize article names the
// ACTUAL owning article's id, so the reader can fetch the withheld body.
//
// SABOTAGE: emit a generic pointer that omits the id (e.g. "use knowledge_get to
//   fetch the article") → the specific id is absent → AC4 goes RED.
// RED NOW (pre-fix): the file-touch delivery prints no knowledge_get pointer for
//   the owning article itself, so its id never appears. Correct red.
// ---------------------------------------------------------------------------
test('AC4: the oversize pointer names the owning article\'s real id (knowledge_get <id>)', () => {
  const { dir, store, cleanup } = makeProject({ rung: 'read' });
  try {
    const rec = store.create(article('bighook', ['src/a.mjs'], { what_it_does: bigBody }));
    assert.ok(rec.id, 'fixture sanity: the store returns the created id');
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(r.code, 0, `delivery must not block: ${oneLine(r.stderr)}`);
    const ctx = ctxOf(r);
    // CONTROL: the block names the article (so a bare id match can't pass for an
    // unrelated reason) — placed before the id assertion.
    assert.match(ctx, /article 'bighook'/, 'the pointer belongs to this article');
    assert.ok(ctx.includes(rec.id), `the pointer carries the real owning-article id ${rec.id} so it can be fetched`);
    assert.match(ctx, new RegExp(`knowledge_get\\s+${rec.id}`), 'and it is a fetchable knowledge_get instruction');
  } finally {
    cleanup();
  }
});

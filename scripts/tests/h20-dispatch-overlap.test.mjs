// H20 dispatch-overlap advisory (decision
// h20-warns-on-dispatch-file-overlap-with-live-agents): a write-capable
// dispatch whose brief names files a presumed-active dispatch already owns gets
// one advisory block. It never blocks, and with no overlap H20's output is
// exactly what it was before. The false-positive guards (read-only lanes,
// out-of-scope sections, one-segment prefixes, command-line mentions) carry
// the deleted H26's history forward (commits 358c3bb, 260d656).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h20-mechanism-axis.mjs');
const SESSION = 's1';
const OWNER = 'a1b2c3d4e5f6a7b8c9';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-overlap-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function row(files, extra = {}) {
  return {
    agent_id: OWNER,
    agent_type: 'implementor',
    session_id: SESSION,
    files,
    at: new Date().toISOString(),
    attribution: 'block',
    files_source: 'free-prose-fallback',
    ...extra,
  };
}

function writeRegister(dir, content) {
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

function dispatch(dir, prompt, subagent_type = 'implementor') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt }, session_id: SESSION, cwd: dir };
}

function ctxOf(r) {
  assert.equal(r.code, 0, `never blocks; stderr: ${r.stderr}`);
  if (!r.stdout) return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext ?? '';
}

const WRITE_BRIEF = 'Implement the retry in scripts/lib/retry-queue.mjs and cover it in scripts/tests/retry-queue.test.mjs.';

test('overlap on an exact path: one advisory naming path ← agent_type:agent_id8 and the remedy', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib/retry-queue.mjs', 'docs/other.md'])]);
    const ctx = ctxOf(runHook(dispatch(dir, WRITE_BRIEF), dir));
    assert.match(ctx, /^DISPATCH OVERLAP \(advisory\) — this brief names files a running agent owns: /m);
    assert.ok(ctx.includes(`scripts/lib/retry-queue.mjs ← implementor:${OWNER.slice(0, 8)}`), ctx);
    assert.ok(!ctx.includes(OWNER), 'the owner id is shown as id8, not in full');
    assert.ok(!ctx.includes('docs/other.md'), 'a path the brief does not name is not listed');
    assert.ok(ctx.includes('Resume that agent, or wait for it and serialize — never two writers on one file.'), ctx);
    assert.equal((ctx.match(/DISPATCH OVERLAP/g) ?? []).length, 1, 'exactly one block');
  } finally {
    cleanup();
  }
});

test('overlap on a two-segment directory prefix (declared directory territory on the live row)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib'], { files_source: 'review-territory' })]);
    const ctx = ctxOf(runHook(dispatch(dir, WRITE_BRIEF), dir));
    assert.ok(ctx.includes(`scripts/lib/retry-queue.mjs ← implementor:${OWNER.slice(0, 8)}`), ctx);
  } finally {
    cleanup();
  }
});

test('overlap on a two-segment prefix claimed by the NEW brief as a dir/sub/** glob', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/hooks/h10-direct-capture.mjs'])]);
    const ctx = ctxOf(runHook(dispatch(dir, 'You own scripts/hooks/** for this refactor.'), dir));
    assert.ok(ctx.includes(`scripts/hooks/h10-direct-capture.mjs ← implementor:${OWNER.slice(0, 8)}`), ctx);
  } finally {
    cleanup();
  }
});

test('no false positive on a one-segment prefix, nor between two sibling files', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts'], { files_source: 'review-territory' }), row(['scripts/lib/other-module.mjs'], { agent_id: 'ffff0000ffff0000' })]);
    const r = runHook(dispatch(dir, WRITE_BRIEF), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', `no output at all:\n${r.stdout}`);
  } finally {
    cleanup();
  }
});

test('a read-only lane (researcher, scout, reviewer) gets no warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib/retry-queue.mjs'])]);
    for (const type of ['researcher', 'scout', 'reviewer', 'Explore']) {
      const r = runHook(dispatch(dir, WRITE_BRIEF, type), dir);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '', `${type}: no output`);
    }
  } finally {
    cleanup();
  }
});

test('a general-purpose lane whose brief states it is read-only gets no warning; a write brief that merely mentions "read-only" still does', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib/retry-queue.mjs'])]);
    const ro = runHook(dispatch(dir, `This is a read-only investigation. Trace how scripts/lib/retry-queue.mjs retries.`, 'general-purpose'), dir);
    assert.equal(ro.stdout, '', 'read-only brief: no output');
    const ro2 = runHook(dispatch(dir, `Read-only: trace how scripts/lib/retry-queue.mjs retries. Do not edit any files.`, 'general-purpose'), dir);
    assert.equal(ro2.stdout, '', 'read-only directive line: no output');
    const rw = runHook(dispatch(dir, `Fix scripts/lib/retry-queue.mjs; keep the read-only classification intact.`, 'general-purpose'), dir);
    assert.match(ctxOf(rw), /DISPATCH OVERLAP \(advisory\)/, 'a mention of "read-only" is not a read-only statement');
  } finally {
    cleanup();
  }
});

test("a path listed under the brief's Out of scope / do-not-touch sections gets no warning", () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib/retry-queue.mjs'])]);
    const briefs = [
      'Implement the parser in scripts/lib/parser.mjs.\nOut of scope: scripts/lib/retry-queue.mjs (another lane owns it).',
      'Implement the parser in scripts/lib/parser.mjs.\n\nOut of scope:\n- scripts/lib/retry-queue.mjs\n- the TUI\n\nAcceptance: tests green.',
      'Scope: scripts/lib/parser.mjs. Out of scope: scripts/lib/retry-queue.mjs, any other module. Acceptance: green.',
      'Implement the parser in scripts/lib/parser.mjs.\nDo NOT touch (another lane owns these): scripts/lib/retry-queue.mjs',
      'Implement the parser in scripts/lib/parser.mjs. Another lane edits scripts/lib/retry-queue.mjs in parallel. Do NOT touch those.',
    ];
    for (const brief of briefs) {
      const r = runHook(dispatch(dir, brief), dir);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '', `no warning for:\n${brief}\n---\n${r.stdout}`);
    }
  } finally {
    cleanup();
  }
});

test('a path named only as an argument of a command line is not write territory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/tests/lib/lock-root-isolation.mjs'])]);
    const brief = 'Fix scripts/lib/parser.mjs.\nAcceptance: `node --import ./scripts/tests/lib/lock-root-isolation.mjs --test scripts/tests/parser.test.mjs` green.';
    const r = runHook(dispatch(dir, brief), dir);
    assert.equal(r.stdout, '', r.stdout);
  } finally {
    cleanup();
  }
});

test('a stale (lease-expired), ended, or other-session row gets no warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    writeRegister(dir, [
      row(['scripts/lib/retry-queue.mjs'], { agent_id: 'stale0000', at: old }),
      row(['scripts/lib/retry-queue.mjs'], { agent_id: 'ended0000', ended: { event: 'SubagentStop', at: new Date().toISOString() } }),
      row(['scripts/lib/retry-queue.mjs'], { agent_id: 'other0000', session_id: 's-other' }),
    ]);
    const r = runHook(dispatch(dir, WRITE_BRIEF), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', r.stdout);
  } finally {
    cleanup();
  }
});

test('a read-only-class live row never contributes an overlap', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [row(['scripts/lib/retry-queue.mjs'], { agent_type: 'researcher' })]);
    assert.equal(runHook(dispatch(dir, WRITE_BRIEF), dir).stdout, '');
  } finally {
    cleanup();
  }
});

test('a register read failure yields one short degraded line, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, '{not json');
    const r = runHook(dispatch(dir, WRITE_BRIEF), dir);
    const ctx = ctxOf(r);
    const lines = ctx.split('\n').filter((l) => l.includes('DISPATCH OVERLAP'));
    assert.equal(lines.length, 1, ctx);
    assert.match(lines[0], /^DISPATCH OVERLAP \(advisory\) — degraded: the dispatch register could not be read/);
  } finally {
    cleanup();
  }
});

test('the display caps at 5 pairs and counts the rest', () => {
  const { dir, cleanup } = makeProject();
  try {
    const files = Array.from({ length: 7 }, (_, i) => `scripts/lib/mod-${i}.mjs`);
    writeRegister(dir, [row(files)]);
    const ctx = ctxOf(runHook(dispatch(dir, `Refactor ${files.join(', ')}.`), dir));
    assert.equal((ctx.match(/ ← implementor:/g) ?? []).length, 5, ctx);
    assert.ok(ctx.includes('(+2 more)'), ctx);
  } finally {
    cleanup();
  }
});

// The full-delivery path: a store match renders H20's usual block; the overlap
// block is appended to that same delivery, and with no overlap the output is
// byte-identical to the output with no register at all.
const NOW = new Date().toISOString();
const HAZARD_ID = randomUUID();
function hazard() {
  return {
    id: HAZARD_ID,
    type: 'anti_pattern',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    slug: 'breach-countdown-hazard',
    title: 'Breach countdown widget hazard re-triggers a HUD timer reload mid-breach',
    trigger: 'Any breach countdown widget that shows countdown seconds while the HUD timer subsystem reloads during a breach.',
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
    severity: 'block',
  };
}
const STORE_BRIEF = 'Fix the breach countdown widget in game/ui/breach_countdown.gd so the countdown seconds survive when the HUD timer reloads during a breach.';

function withStore(fn) {
  const { dir, cleanup } = makeProject();
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    store.create(hazard());
    fn(dir);
  } finally {
    store.close();
    cleanup();
  }
}

test('with a store match: no overlap leaves H20 output byte-identical to a run with no register', () => {
  let baseline;
  withStore((dir) => {
    baseline = runHook(dispatch(dir, STORE_BRIEF), dir);
  });
  withStore((dir) => {
    writeRegister(dir, [row(['game/ui/other_widget.gd'])]);
    const r = runHook(dispatch(dir, STORE_BRIEF), dir);
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, '', 'the store match still delivers');
    assert.equal(r.stdout, baseline.stdout);
    assert.ok(!r.stdout.includes('DISPATCH OVERLAP'));
  });
});

test('with a store match: the overlap block is appended to the same H20 delivery', () => {
  withStore((dir) => {
    writeRegister(dir, [row(['game/ui/breach_countdown.gd'])]);
    const ctx = ctxOf(runHook(dispatch(dir, STORE_BRIEF), dir));
    const head = ctx.indexOf('STERLING MECHANISM-AXIS DELIVERY (H20)');
    const overlap = ctx.indexOf('DISPATCH OVERLAP (advisory)');
    assert.ok(head >= 0 && overlap > head, `one delivery, overlap block after the H20 header:\n${ctx}`);
    assert.ok(ctx.includes(`game/ui/breach_countdown.gd ← implementor:${OWNER.slice(0, 8)}`));
  });
});

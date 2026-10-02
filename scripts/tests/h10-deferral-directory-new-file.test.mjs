// H10 DIRECTORY DEFERRAL — a file CREATED under a live dispatch's declared
// directory is deferred to that dispatch and raises no article demand.
//
// RULING: decision h22-dispatch-files-from-review-territory-and-resume-
// inherits-prior-round (e841facd) — "H10's deferral join treats a declared
// directory entry as a path prefix, not only an exact match." Dome Farmer
// asked whether a brand-new file under a declared directory (one that did not
// exist when the lane was dispatched) is covered; this pins that it is.
//
// WHY A GIT FIXTURE: a newly created unowned file raises the article demand on
// its own (newUnowned, tested against HEAD when no settled snapshot exists),
// so only a git repo makes "no demand" attributable to the deferral. The
// CONTROL arm runs the same fixture with an empty register and must demand.
//
// Harness duplicated rather than imported from a sibling h10-*.test.mjs
// (importing would double-run its registered test() calls).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H10 = join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs');
const TOUCH_AT = '2026-06-10T12:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
const DIR_ENTRY = 'game/world/beam_pad';
const NEW_FILE = 'game/world/beam_pad/x.gd';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.error?.message ?? ''}${r.stderr}`);
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-dirdefer-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, 'game', 'world'), { recursive: true });
  writeFileSync(join(dir, 'game', 'world', 'seed.gd'), '# seed\n');
  git(dir, ['add', 'game/world/seed.gd']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function stop(dir) {
  const r = spawnSync(process.execPath, [H10], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r) => `${r.stdout}\n${r.stderr}`;

// The file is created AFTER the seed commit, so it is absent from HEAD: new.
function createAndTouch(dir) {
  mkdirSync(dirname(join(dir, NEW_FILE)), { recursive: true });
  writeFileSync(join(dir, NEW_FILE), '# new\n');
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: NEW_FILE, at: TOUCH_AT }]));
}

// The capture lane is paid, so the article demand is the only duty that could fire.
function captureDecision(store) {
  store.create({
    id: randomUUID(), type: 'decision', created_at: CAPTURE_AT, updated_at: CAPTURE_AT, author: 'conductor',
    status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
    title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r',
  });
}

const writeRegister = (dir, entries) => writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
const liveDirEntry = () => ({
  agent_id: 'lane-beam', agent_type: 'implementor', session_id: 's1',
  files: [DIR_ENTRY], files_source: 'review-territory', attribution: 'block', at: new Date().toISOString(),
});

test('CONTROL (first): with an EMPTY register the new file under game/world/beam_pad raises the article demand', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    writeRegister(dir, []);
    createAndTouch(dir);
    const r = stop(dir);
    assert.equal(r.code, 2, `CONTROL BROKEN: one newly created unowned file must demand an article, or the deferred arm proves nothing; out=${out(r)}`);
    assert.match(r.stderr, /article demand/i, `CONTROL BROKEN: the demand text is shown; out=${out(r)}`);
    assert.match(r.stderr, /game\/world\/beam_pad\/x\.gd/, `CONTROL BROKEN: the new file is named in the demand; out=${out(r)}`);
  } finally {
    cleanup();
  }
});

test('a register row owning the directory game/world/beam_pad defers a file CREATED under it: no article demand, and the deferral names the file and its owner', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    captureDecision(store);
    writeRegister(dir, [liveDirEntry()]);
    createAndTouch(dir);
    const r = stop(dir);
    assert.doesNotMatch(out(r), /article demand/i, `the deferred new file raises no article demand; out=${out(r)}`);
    assert.notEqual(r.code, 2, `nothing blocks: the only touched file is owned by a live dispatch; out=${out(r)}`);
    // The deferral reaches the conductor as a notice, not stdout/stderr
    // (decision h10-deferral-is-conductor-facing-degradations-stay-loud).
    const notices = join(dir, '.sterling', 'transient', 'notices');
    const noticeText = readdirSync(notices).map((n) => readFileSync(join(notices, n), 'utf8')).join('\n');
    assert.match(noticeText, /deferred: 1 file\(s\) owned by live dispatch\(es\) \[lane-beam\]: game\/world\/beam_pad\/x\.gd/, `the deferral is disclosed with its owner; notices=${noticeText}`);
  } finally {
    cleanup();
  }
});

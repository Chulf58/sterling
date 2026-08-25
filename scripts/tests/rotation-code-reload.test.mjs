// Test pins for the rotation/restart messaging changes (board d5942fa0):
// a --reason code-reload mode on scripts/rotation-note.mjs, H1's restore of a
// code-reload note (scripts/hooks/h1-session-start.mjs), and the consumer
// update path's closing summary (scripts/lib/update.mjs). Authored from the
// dispatch spec, not from the implementation — fixture idioms are reused from
// scripts/tests/hooks-full.test.mjs (rotation-note + H1 restore ACs) and
// scripts/tests/update.test.mjs (runUpdate over an injected exec).
//
// Anti-pattern ee89c3fd caution observed throughout: child-process stderr is
// flattened to one line (flat()) before it is interpolated into any assertion
// message.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runUpdate } from '../lib/update.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');

function flat(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ── fixture idioms lifted from hooks-full.test.mjs ──────────────────────────

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-rcr-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function gitProject() {
  const { dir, store, cleanup } = makeProject();
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  writeFileSync(join(dir, 'base.mjs'), '// base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

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

function h1(dir, over = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', ...over }), dir, {
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

function readRotationNote(dir) {
  const p = join(dir, '.sterling', 'transient', 'rotation-note.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function writeRotationNote(dir, note) {
  writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), JSON.stringify(note, null, 2) + '\n');
}

// Loose on exact prose (the spec does not quote rotation-note.mjs's/H1's
// wording verbatim), strict on the SHAPE the spec does quote: an instruction
// to exit and relaunch the Claude Code CLI, naming the CLI explicitly.
//
// CORRECTION (coordinator run 1): this hint is NOT reason-discriminating —
// live output shows the GENERIC (no --reason) path already carries an
// unconditional relaunch mention on both the writer side ("If server/hook
// CODE changed since this session started ... EXIT AND RELAUNCH the Claude
// Code CLI first, THEN /clear.") and the H1 restore side ("...that requires
// having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear ...").
// RELAUNCH_HINT therefore stays useful only as a same-shape sanity check
// (both paths must mention relaunching the CLI at all); it is never used
// alone to distinguish code-reload from generic below.
const RELAUNCH_HINT = /exit[\s\S]{0,60}relaunch[\s\S]{0,80}claude code cli/i;

// The two-step ORDER anchored inside the relaunch sentence itself, never
// against the first unrelated "/clear" substring in the text (both the
// writer's "on /clear, H1 restores..." lead-in and H1's "...before this
// /clear" caveat contain an earlier, unrelated "/clear" that an indexOf-based
// ordering check would wrongly anchor on).
const TWO_STEP_ORDER_RE = /relaunch[\s\S]{0,200}?then\s*\/clear/i;

// Code-reload-specific markers (H1 side) vs. the generic markers that are
// present REGARDLESS of --reason — these, not RELAUNCH_HINT, are what
// actually discriminate the two paths.
const CODE_RELOAD_CAVEAT = /step 1 was skipped/i;
const WRITER_GENERIC_MARKER = /If server\/hook CODE changed/i;
const H1_GENERIC_MARKER = /that requires having EXITED AND RELAUNCHED/i;

// ── update.mjs fixture idioms lifted from update.test.mjs ──────────────────

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function fakeExec({ behind = 0, ahead = 0, dirty = [], changed = [], failing = null } = {}) {
  const calls = [];
  let merged = false;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const exec = (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (failing && line.includes(failing)) return { status: 1, stdout: '', stderr: 'step blew up' };
    if (cmd === 'git') {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return ok('.git');
      if (a === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (a === 'rev-parse HEAD') return ok(merged ? HEAD_B : HEAD_A);
      if (a.startsWith('describe')) return ok('v0.2.0');
      if (a === 'remote') return ok('origin');
      if (a.startsWith('symbolic-ref')) return ok('origin/main');
      if (a.startsWith('rev-parse --verify --quiet')) return ok(HEAD_B);
      if (a.startsWith('rev-list --left-right --count')) return ok(merged ? '0\t0' : `${behind}\t${ahead}`);
      if (a === 'status --porcelain') return ok(dirty.join('\n'));
      if (a.startsWith('merge --ff-only')) {
        merged = true;
        return ok('Fast-forward');
      }
      if (a.startsWith('diff --name-only')) return ok(changed.join('\n'));
      return ok('');
    }
    if (cmd === 'npm') return ok('npm output');
    if (args[0]?.endsWith('stamp-contract.mjs')) return { status: 0, stdout: '7 already in sync, 0 refusal(s).\n', stderr: '' };
    if (args[0]?.endsWith('sync-agents.mjs')) return { status: 0, stdout: 'up_to_date: coder\n', stderr: '' };
    return ok('done');
  };
  return { exec, calls };
}

function scratchCwd() {
  return mkdtempSync(join(tmpdir(), 'sterling-rcr-update-'));
}

// ─────────────────────────── PIN 1 ───────────────────────────
// rotation-note.mjs --reason code-reload writes note.reason and prints the
// two-step sequence (exit-and-relaunch the CLI, THEN /clear), in that order.

test('PIN 1: --reason code-reload stamps note.reason and prints the relaunch step before the /clear step', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--reason', 'code-reload']);
    assert.equal(r.status, 0, `rotation-note refused: ${flat(r.stderr)}`);

    // Behavior (a): the note file carries the reason.
    // SABOTAGE: revert the reason field write (drop `reason` from the written
    // JSON, or hardcode it to null) -> this assertion goes red.
    const note = readRotationNote(dir);
    assert.equal(note.reason, 'code-reload', 'note.reason must be stamped from --reason');

    // Roster review (run 2): TWO_STEP_ORDER_RE and RELAUNCH_HINT are both
    // ALSO satisfied by the generic conditional line, so on their own they
    // cannot tell "code-reload branch fired" apart from "generic branch
    // fired, and it happens to mention relaunching too" — deleting the
    // writer's code-reload branch in favour of the generic arm would leave
    // both green. This assertion is the actual writer-side discriminator.
    // SABOTAGE: delete the writer's code-reload branch (fall through to the
    // generic arm even when --reason code-reload is passed) -> this
    // assertion goes red while RELAUNCH_HINT/TWO_STEP_ORDER_RE stay green.
    assert.match(r.stdout, /CODE RELOAD REQUIRED/, 'stdout carries the code-reload-specific writer marker');

    // Behavior (b): stdout carries the two-step sequence, relaunch first.
    // SABOTAGE (self-derived, not in the dispatch list): replace the
    // conditional two-step print with the old unconditional generic line ->
    // both assertions below go red (no relaunch hint is found at all).
    assert.match(r.stdout, RELAUNCH_HINT, 'stdout names exiting and relaunching the Claude Code CLI');
    // CORRECTED (coordinator run 1): anchored inside the relaunch sentence
    // itself via TWO_STEP_ORDER_RE, not via a global indexOf('/clear') —
    // the writer's own lead-in line ("on /clear, H1 restores and consumes
    // this note automatically") contains an earlier, unrelated "/clear"
    // that a naive indexOf comparison wrongly anchors on.
    // SABOTAGE (self-derived): swap the two step's print order -> this
    // ordering assertion goes red even though both fragments are still present.
    assert.match(
      r.stdout,
      TWO_STEP_ORDER_RE,
      'the relaunch step is printed BEFORE its own /clear step (two-step order), anchored inside the relaunch sentence'
    );
  } finally {
    cleanup();
  }
});

// ─────────────────────────── PIN 2 ───────────────────────────
// No --reason flag: note.reason is null/absent, and stdout stays the original
// generic line — no code-reload two-step sequence is fabricated.

test('PIN 2: no --reason: note carries no reason, stdout has no code-reload two-step sequence', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations']);
    assert.equal(r.status, 0, `rotation-note refused: ${flat(r.stderr)}`);

    // SABOTAGE: default reason to 'code-reload' when --reason is absent ->
    // this assertion goes red.
    const note = readRotationNote(dir);
    assert.ok(note.reason === null || note.reason === undefined, 'note.reason must be null/absent without --reason');

    // CORRECTED (coordinator run 1): RELAUNCH_HINT is NOT a valid
    // discriminator here — the generic (no --reason) writer output already
    // carries an unconditional relaunch mention verbatim ("If server/hook
    // CODE changed since this session started ... EXIT AND RELAUNCH the
    // Claude Code CLI first, THEN /clear."), so asserting its absence was
    // wrong and would fail against CORRECT generic-path output, not just
    // against a sabotage. The writer-side discriminating power now rests on
    // note.reason (asserted above) plus the code-reload-specific writer
    // marker (asserted below, per roster review run 2).
    // Proves this control exercises the REAL generic conditional line, not
    // empty/error output — a control that passes on nothing pins nothing.
    assert.match(r.stdout, WRITER_GENERIC_MARKER, 'the control exercises the real generic conditional line');

    // Roster review (run 2): the corresponding negative to PIN 1's positive
    // marker check, giving the writer-side control the same strength as
    // PIN 4-CONTROL on the H1 side.
    // SABOTAGE: fire the code-reload writer marker unconditionally
    // (regardless of --reason) -> this assertion goes red.
    assert.doesNotMatch(r.stdout, /CODE RELOAD REQUIRED/, 'no --reason must never print the code-reload-specific writer marker');
  } finally {
    cleanup();
  }
});

// ─────────────────────────── PIN 3 ───────────────────────────
// --reason bogus refuses non-zero, naming 'code-reload' as the only supported
// value.

test('PIN 3: --reason bogus is refused non-zero, naming code-reload as the only supported value', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--reason', 'bogus']);
    // SABOTAGE: remove the --reason validation (accept any string) -> the
    // status assertion goes red (exits 0 instead of refusing).
    assert.notEqual(r.status, 0, 'an unsupported --reason value must be refused');
    const combined = flat(r.stdout) + ' ' + flat(r.stderr);
    // SABOTAGE: same removal also drops the naming of the supported value ->
    // this assertion goes red independently (covers a validator that refuses
    // but forgets to say why).
    assert.match(combined, /code-reload/, 'the refusal names code-reload as the only supported value');
    assert.equal(readRotationNote(dir), null, 'a refused write must not leave a note behind');
  } finally {
    cleanup();
  }
});

// ─────────────────────────── PIN 4 ───────────────────────────
// H1 restore of a code-reload note injects the two-step CLI-relaunch
// sequence (including the stale-server caveat); a note with no reason must
// NOT get that sequence (control, placed first per the mutation-testing
// guidance — a verdict with more than one possible cause needs a control
// that passes for the opposite reason).

test('PIN 4 CONTROL: H1 restore of a note WITHOUT reason does not inject the code-reload sequence', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'Finish Goblin animations']).status, 0);
    const r = h1(dir, { source: 'clear' });
    assert.equal(r.code, 0, `H1 failed: ${flat(r.stderr)}`);
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/, 'the ordinary restore still fires');
    // CORRECTED (coordinator run 1): RELAUNCH_HINT is NOT a valid
    // discriminator here either — H1's own generic restore text already
    // carries an unconditional relaunch mention verbatim ("...that requires
    // having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear —
    // a /clear alone never reloads code, so relaunch now if that didn't
    // happen yet."). The valid discriminator is the code-reload-specific
    // stale-server caveat, which must never appear on the generic path.
    // This is the control: if H1's code-reload branch were unconditional
    // (fires regardless of note.reason), this assertion — not the positive
    // pin below — is the one that would catch it.
    assert.doesNotMatch(ctx, CODE_RELOAD_CAVEAT, 'a reasonless note must never get the code-reload stale-server caveat');
    // Proves this control exercises H1's REAL generic restore text, not
    // empty/error output — a control that passes on nothing pins nothing.
    assert.match(ctx, H1_GENERIC_MARKER, 'the control exercises the real generic H1 restore text');
  } finally {
    cleanup();
  }
});

test('PIN 4: H1 restore of a code-reload note injects the relaunch sequence and the stale-server caveat', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'Finish Goblin animations']).status, 0);
    // Inject reason directly into the note (isolating H1's restore logic from
    // rotation-note.mjs's own --reason plumbing, pinned separately above),
    // the same idiom used by the existing Codex P2-B tests in
    // hooks-full.test.mjs (read note, mutate a field, rewrite it).
    const note = readRotationNote(dir);
    note.reason = 'code-reload';
    writeRotationNote(dir, note);

    const r = h1(dir, { source: 'clear' });
    assert.equal(r.code, 0, `H1 failed: ${flat(r.stderr)}`);
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);

    // SABOTAGE: delete the code-reload branch in h1-session-start.mjs ->
    // every assertion below goes red.
    assert.match(ctx, RELAUNCH_HINT, 'a code-reload note injects the CLI relaunch instruction');
    // CORRECTED (coordinator run 1): anchored inside the relaunch sentence
    // itself via TWO_STEP_ORDER_RE, not via a global indexOf('/clear') — the
    // ROTATION RESTORE block's own lead-in ("on /clear, H1 restores...")
    // contains an earlier, unrelated "/clear" that a naive indexOf
    // comparison wrongly anchors on.
    assert.match(
      ctx,
      TWO_STEP_ORDER_RE,
      'relaunch is named before its own /clear step, matching the writer-side two-step order, anchored inside the relaunch sentence'
    );
    assert.match(ctx, CODE_RELOAD_CAVEAT, 'the stale-server caveat covers the case where step 1 was skipped');
  } finally {
    cleanup();
  }
});

// ─────────────────────────── PIN 5 ───────────────────────────
// lib/update.mjs's closing summary contains BOTH the existing frozen
// 'RESTART THE SESSION' pin AND the new 'EXIT AND RELAUNCH the Claude Code
// CLI' instruction.

test('PIN 5: the closing summary carries both RESTART THE SESSION and EXIT AND RELAUNCH the Claude Code CLI', async () => {
  const cwd = scratchCwd();
  try {
    const { exec } = fakeExec({ behind: 1 });
    const lines = [];
    const report = await runUpdate({ cwd, exec, log: (m) => lines.push(m), projects: [], opts: {} });
    const out = lines.join('\n');

    assert.equal(report.exit, 0, `update failed: ${flat(JSON.stringify(report))}`);
    // The existing frozen pin (scripts/tests/update.test.mjs, AC7) — restated
    // here because pin 5 requires BOTH to hold in the SAME summary text.
    assert.match(out, /RESTART THE SESSION/, 'the pre-existing restart instruction must still be present');
    // SABOTAGE: revert to the bare old wording (drop the new relaunch
    // sentence) -> this assertion goes red while the one above stays green,
    // proving the two are independently pinned.
    assert.match(out, /EXIT AND RELAUNCH the Claude Code CLI/, 'the new relaunch instruction must be present verbatim');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

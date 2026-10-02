// rotation-note.mjs on both hosts. The Claude Code GOLDEN runs below were
// captured from rotation-note.mjs before OpenCode support (3c9890e), so the
// Claude Code note and printed guidance are pinned byte for byte. On OpenCode
// the session id comes from OPENCODE_SESSION_ID (the 2.0.21 shell tool sets it,
// with OPENCODE=1), the note records session_host 'opencode', and the guidance
// says READY FOR NEW SESSION.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'rotation-note.mjs');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const GOLDEN = {
  "claude-session": {
    "env": {
      "CLAUDE_CODE_SESSION_ID": "cc-session-1"
    },
    "extra": [],
    "stdout": "rotation note written (single slot — this supersedes any prior note).\nnext_slice: the next slice\nlanes: 1\nsession_id: cc-session-1\nanchored: no git (drift disclosure unavailable)\ncommits_ahead: unavailable (no origin/HEAD, main, or master to diff against — pass --into to a future version if this recurs)\nlive_dispatches: UNKNOWN — the dispatch register exists but could not be read; any subagent from this session cannot be resumed after the /clear — re-dispatch fresh if still needed\nTell the user READY TO CLEAR — on /clear, H1 restores and consumes this note automatically. The very next session STARTUP (e.g. after a relaunch) restores it the same way, single-shot — whichever comes first.\nIf server/hook CODE changed since this session started (migration, update, rebuild), /clear alone will not reload it — EXIT AND RELAUNCH the Claude Code CLI first, THEN /clear if the note has not already appeared at that relaunch's startup.\n",
    "note": {
      "plan_path": null,
      "next_slice": "the next slice",
      "lanes": [
        "impl: a.mjs done"
      ],
      "session_id": "cc-session-1",
      "objective": null,
      "risks": null,
      "pointers": null,
      "branch": null,
      "head_sha": null,
      "base_branch": null,
      "commits_ahead": null,
      "live_dispatches": null,
      "uncertain_dispatches": null,
      "reason": null
    }
  },
  "no-session": {
    "env": {},
    "extra": [],
    "stdout": "rotation note written (single slot — this supersedes any prior note).\nnext_slice: the next slice\nlanes: 1\nsession_id: unavailable (CLAUDE_CODE_SESSION_ID unset or not id-shaped) — the restore cannot name the session to resume\nanchored: no git (drift disclosure unavailable)\ncommits_ahead: unavailable (no origin/HEAD, main, or master to diff against — pass --into to a future version if this recurs)\nlive_dispatches: UNKNOWN — the dispatch register exists but could not be read; any subagent from this session cannot be resumed after the /clear — re-dispatch fresh if still needed\nTell the user READY TO CLEAR — on /clear, H1 restores and consumes this note automatically. The very next session STARTUP (e.g. after a relaunch) restores it the same way, single-shot — whichever comes first.\nIf server/hook CODE changed since this session started (migration, update, rebuild), /clear alone will not reload it — EXIT AND RELAUNCH the Claude Code CLI first, THEN /clear if the note has not already appeared at that relaunch's startup.\n",
    "note": {
      "plan_path": null,
      "next_slice": "the next slice",
      "lanes": [
        "impl: a.mjs done"
      ],
      "session_id": null,
      "objective": null,
      "risks": null,
      "pointers": null,
      "branch": null,
      "head_sha": null,
      "base_branch": null,
      "commits_ahead": null,
      "live_dispatches": null,
      "uncertain_dispatches": null,
      "reason": null
    }
  },
  "claude-code-reload": {
    "env": {
      "CLAUDE_CODE_SESSION_ID": "cc-session-2"
    },
    "extra": [
      "--reason=code-reload"
    ],
    "stdout": "rotation note written (single slot — this supersedes any prior note).\nnext_slice: the next slice\nlanes: 1\nsession_id: cc-session-2\nanchored: no git (drift disclosure unavailable)\ncommits_ahead: unavailable (no origin/HEAD, main, or master to diff against — pass --into to a future version if this recurs)\nlive_dispatches: UNKNOWN — the dispatch register exists but could not be read; any subagent from this session cannot be resumed after the /clear — re-dispatch fresh if still needed\nCODE RELOAD REQUIRED (--reason=code-reload) — /clear alone will NOT load it (MCP servers survive it). The sequence is:\n  1. exit and relaunch the Claude Code CLI now — H1 restores and consumes this note automatically at that very startup\n  2. THEN /clear — H1 restores and consumes this note automatically if step 1 hasn't already delivered it (single-shot: whichever of startup/clear happens first wins, and the other becomes a no-op)\n",
    "note": {
      "plan_path": null,
      "next_slice": "the next slice",
      "lanes": [
        "impl: a.mjs done"
      ],
      "session_id": "cc-session-2",
      "objective": null,
      "risks": null,
      "pointers": null,
      "branch": null,
      "head_sha": null,
      "base_branch": null,
      "commits_ahead": null,
      "live_dispatches": null,
      "uncertain_dispatches": null,
      "reason": "code-reload"
    }
  }
};

/** Runs rotation-note.mjs in a fresh non-git project with the ambient host variables removed. */
function run(envOver, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rotation-note-host-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
    const env = { ...process.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.OPENCODE_SESSION_ID;
    delete env.OPENCODE;
    const r = spawnSync(process.execPath, [SCRIPT, '--next-slice', 'the next slice', '--lane', 'impl: a.mjs done', ...extra], { cwd: dir, encoding: 'utf8', env: { ...env, ...envOver } });
    assert.equal(r.status, 0, r.stderr);
    const note = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), 'utf8'));
    delete note.at;
    return { stdout: r.stdout, note };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, g] of Object.entries(GOLDEN)) {
  test(`Claude Code output is byte-identical to before OpenCode support: ${name}`, () => {
    const got = run(g.env, g.extra);
    assert.equal(got.stdout, g.stdout);
    assert.deepEqual(got.note, g.note);
    assert.equal(JSON.stringify(got.note), JSON.stringify(g.note), 'same keys in the same order');
  });
}

test('OpenCode: the session id comes from OPENCODE_SESSION_ID, the note says session_host opencode, the guidance says READY FOR NEW SESSION', () => {
  const got = run({ OPENCODE_SESSION_ID: 'ses_0abc', OPENCODE: '1' });
  assert.equal(got.note.session_id, 'ses_0abc');
  assert.equal(got.note.session_host, 'opencode');
  assert.match(got.stdout, /^session_id: ses_0abc$/m);
  assert.match(got.stdout, /READY FOR NEW SESSION/);
  assert.match(got.stdout, /\/new/);
  for (const claudeOnly of ['READY TO CLEAR', '/clear', 'Claude Code CLI', 'H1']) assert.ok(!got.stdout.includes(claudeOnly), `no ${claudeOnly} on OpenCode`);
  const reload = run({ OPENCODE_SESSION_ID: 'ses_0abc', OPENCODE: '1' }, ['--reason=code-reload']);
  assert.match(reload.stdout, /exit and relaunch OpenCode/);
  assert.ok(!reload.stdout.includes('/clear'));
});

test('OpenCode without a usable session id: no session_host, and the unavailable line names OPENCODE_SESSION_ID', () => {
  const got = run({ OPENCODE: '1', OPENCODE_SESSION_ID: 'bad id;' });
  assert.equal(got.note.session_id, null);
  assert.equal('session_host' in got.note, false);
  assert.match(got.stdout, /session_id: unavailable \(OPENCODE_SESSION_ID unset or not id-shaped\)/);
  assert.match(got.stdout, /READY FOR NEW SESSION/);
});

test('both ids set without OPENCODE=1: Claude Code wins and the note is the Claude form', () => {
  const got = run({ CLAUDE_CODE_SESSION_ID: 'cc-session-1', OPENCODE_SESSION_ID: 'ses_x' });
  assert.equal(got.stdout, GOLDEN['claude-session'].stdout);
  assert.deepEqual(got.note, GOLDEN['claude-session'].note);
});

test('both ids set with OPENCODE=1 (OpenCode shell under a parent Claude Code): the OpenCode id wins, the note is the OpenCode form', () => {
  const got = run({ CLAUDE_CODE_SESSION_ID: 'cc-session-1', OPENCODE_SESSION_ID: 'ses_x', OPENCODE: '1' });
  assert.equal(got.note.session_id, 'ses_x');
  assert.equal(got.note.session_host, 'opencode');
  assert.match(got.stdout, /^session_id: ses_x$/m);
  assert.match(got.stdout, /READY FOR NEW SESSION/);
});

test('OPENCODE=1 with an unusable OPENCODE_SESSION_ID does not displace a valid Claude Code id', () => {
  const got = run({ CLAUDE_CODE_SESSION_ID: 'cc-session-1', OPENCODE_SESSION_ID: 'bad id;', OPENCODE: '1' });
  assert.equal(got.stdout, GOLDEN['claude-session'].stdout);
  assert.deepEqual(got.note, GOLDEN['claude-session'].note);
});

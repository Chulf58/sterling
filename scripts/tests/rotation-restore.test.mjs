// The rotation restore, shared by H1 (Claude Code) and the Sterling OpenCode
// server plugin (scripts/hooks/lib/rotation-restore.mjs). The GOLDEN strings
// below were captured from the pre-extraction H1 (the committed
// hooks/h1-session-start.mjs bundle at 3c9890e) for the same notes, so host
// 'claude' is pinned byte for byte to what H1 printed before the extraction.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { consumeRotationNote, readRotationNote, renderRotationRestore, rotationNotePath } from '../hooks/lib/rotation-restore.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CASES = {
  "full-clear": {
    "source": "clear",
    "note": {
      "plan_path": "docs/plans/p.md",
      "objective": "ship the thing",
      "next_slice": "write the restore lib",
      "risks": "bytes drift",
      "pointers": "board 65e2ac26",
      "branch": "feat/x",
      "session_id": "abc-123_DEF",
      "commits_ahead": 3,
      "lanes": [
        "lane one: did A, B is left",
        "lane two:\nmultiline   hand-off"
      ],
      "live_dispatches": [
        {
          "agent_type": "implementor",
          "agent_id": "a1",
          "territory": [
            "src/a.mjs",
            "src/b.mjs"
          ]
        },
        {
          "agent_id": "a2"
        }
      ],
      "uncertain_dispatches": [
        {
          "agent_type": "scout",
          "agent_id": "s9",
          "reason": "lease expired"
        }
      ],
      "reason": null
    },
    "golden": "\n\nROTATION RESTORE (H1, source=clear): a rotation note was prepared before this /clear; this injection CONSUMES it (single-shot). CAUTION: the note names a plan (docs/plans/p.md) but no plan lock is live now — it was released, or .sterling/ was recreated.\n- plan: docs/plans/p.md\n- objective: ship the thing\n- next_slice: write the restore lib\n- risks: bytes drift\n- pointers: board 65e2ac26\n- branch: feat/x\n- session_id: abc-123_DEF\n- commits_ahead: 3 (vs unknown base) (unverified — base unavailable)\n2 dispatch(es) were live at rotation. They belong to the previous session and cannot be resumed from this one (agent lookup is scoped to the current session); re-dispatch fresh if the work is still needed, and mind the territory below, which they may still be writing:\n- implementor (a1) — src/a.mjs, src/b.mjs\n- agent (a2) — no declared territory\n1 dispatch(es) UNCERTAIN at rotation (lease expired, not confirmed dead — never counted as live):\nNOTE [dispatch_status_unknown] scout:s9 — ownership uncertain (lease expired); belongs to the previous session and cannot be resumed from this one — re-dispatch fresh if still needed\n2 lane hand-off(s) carried across the rotation. Pre-clear subagents cannot be resumed with SendMessage after a /clear or restart (\"No transcript found for agent ID\"): re-dispatch each lane worth continuing fresh, with its hand-off below in the brief. The old agents are reachable only by returning to the old session: `claude --resume abc-123_DEF`, or the rewind menu's previous-session entry.\n- lane one: did A, B is left\n- lane two: multiline hand-off\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. If next_slice depends on a server/hook code change (migration, update, rebuild), that requires having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear — a /clear alone never reloads code, so relaunch now if that didn't happen yet."
  },
  "code-reload-startup": {
    "source": "startup",
    "note": {
      "next_slice": "rebuild and verify",
      "session_id": "zzz",
      "base_branch": "no-such-branch-xyz",
      "commits_ahead": 0,
      "live_dispatches": [],
      "reason": "code-reload"
    },
    "golden": "\n\nROTATION RESTORE (H1, source=startup): a rotation note was prepared before this restart; this injection CONSUMES it (single-shot).\n- next_slice: rebuild and verify\n- session_id: zzz\n- commits_ahead: 0 (vs no-such-branch-xyz) (unverified — base unavailable)\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. CODE RELOAD WAS REQUIRED (note reason: code-reload) — this restore is happening at session STARTUP, which already implies the exit-and-relaunch that reloads server/hook code."
  },
  "code-reload-clear": {
    "source": "clear",
    "note": {
      "next_slice": "n",
      "reason": "code-reload",
      "lanes": [
        "only lane"
      ]
    },
    "golden": "\n\nROTATION RESTORE (H1, source=clear): a rotation note was prepared before this /clear; this injection CONSUMES it (single-shot).\n- next_slice: n\n1 lane hand-off(s) carried across the rotation. Pre-clear subagents cannot be resumed with SendMessage after a /clear or restart (\"No transcript found for agent ID\"): re-dispatch each lane worth continuing fresh, with its hand-off below in the brief. The old agents are reachable only by returning to the old session (the rewind menu's previous-session entry); the note recorded no session id.\n- only lane\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. CODE RELOAD WAS REQUIRED (note reason: code-reload) — the correct sequence was: 1. exit and relaunch the Claude Code CLI, 2. THEN this /clear. If step 1 was skipped, this session's MCP server/hooks may still be stale: exit and relaunch the CLI now, then /clear again."
  },
  "unknown-register-no-session": {
    "source": "startup",
    "note": {
      "next_slice": "carry on",
      "live_dispatches": null,
      "lanes": [
        "l"
      ],
      "session_id": "bad id; rm -rf /"
    },
    "golden": "\n\nROTATION RESTORE (H1, source=startup): a rotation note was prepared before this restart; this injection CONSUMES it (single-shot).\n- next_slice: carry on\nNOTE [register_unavailable] dispatch register unavailable — the register existed but could not be read when the note was written, so whether any subagent was still running cannot be stated here. Any such subagent belongs to the previous session and cannot be resumed from this one: re-dispatch fresh if the work is still needed, and check git status for files it may still be writing.\n1 lane hand-off(s) carried across the rotation. Pre-clear subagents cannot be resumed with SendMessage after a /clear or restart (\"No transcript found for agent ID\"): re-dispatch each lane worth continuing fresh, with its hand-off below in the brief. The old agents are reachable only by returning to the old session (the rewind menu's previous-session entry); the note recorded no session id.\n- l\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. If next_slice depends on a server/hook code change (migration, update, rebuild), this STARTUP already reloaded it."
  }
};

function project(note) {
  const dir = mkdtempSync(join(tmpdir(), 'rotation-restore-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  if (note) writeFileSync(join(dir, '.sterling', 'transient', 'rotation-note.json'), JSON.stringify(note));
  return dir;
}

for (const [name, c] of Object.entries(CASES)) {
  test(`host 'claude' renders the pre-extraction H1 bytes: ${name}`, () => {
    const dir = project(null);
    try {
      assert.equal(renderRotationRestore(c.note, { cwd: dir, source: c.source, host: 'claude', planLock: null, planLockMalformed: false }), c.golden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`H1 still prints the same restore and consumes the note: ${name}`, () => {
    const dir = project(c.note);
    try {
      new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
      const r = spawnSync('node', [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: c.source, cwd: dir, session_id: 'ses-golden' }),
        encoding: 'utf8',
        cwd: dir,
      });
      assert.equal(r.status, 0, r.stderr);
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.equal(/\n\nROTATION RESTORE[\s\S]*?(?=\n\n|$)/.exec(ctx)?.[0], c.golden);
      assert.equal(existsSync(rotationNotePath(dir)), false, 'the note is consumed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('read leaves the note in place; consume deletes it before returning; no note is null', () => {
  const dir = project({ next_slice: 'x' });
  try {
    assert.deepEqual(readRotationNote(dir), { next_slice: 'x' });
    assert.ok(existsSync(rotationNotePath(dir)));
    assert.deepEqual(consumeRotationNote(dir), { next_slice: 'x' });
    assert.equal(existsSync(rotationNotePath(dir)), false);
    assert.equal(consumeRotationNote(dir), null);
    writeFileSync(rotationNotePath(dir), '{not json');
    assert.throws(() => consumeRotationNote(dir), SyntaxError);
    assert.ok(existsSync(rotationNotePath(dir)), 'a malformed note is not consumed (same order as H1: parse, then delete)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host 'opencode' names the new session and OpenCode's relaunch; the way back follows the note's session_host", () => {
  const dir = project(null);
  try {
    const note = { next_slice: 'go on', session_id: 'ses_abc', session_host: 'opencode', lanes: ['lane a'] };
    const oc = renderRotationRestore(note, { cwd: dir, host: 'opencode' });
    assert.match(oc, /^\n\nROTATION RESTORE \(Sterling OpenCode plugin\): a rotation note was prepared before this new session; this injection CONSUMES it \(single-shot\)\./);
    assert.match(oc, /`opencode --session ses_abc`/);
    assert.match(oc, /EXITED AND RELAUNCHED OpenCode before this new session/);
    for (const claudeOnly of ['/clear', 'claude --resume', 'SendMessage', 'Claude Code CLI', 'H1']) assert.ok(!oc.includes(claudeOnly), `no ${claudeOnly} on OpenCode`);
    assert.match(renderRotationRestore({ ...note, reason: 'code-reload' }, { cwd: dir, host: 'opencode' }), /1\. exit and relaunch OpenCode, 2\. THEN start this new session/);
    // An OpenCode-written note restored on Claude Code still points back at OpenCode.
    assert.match(renderRotationRestore(note, { cwd: dir, source: 'clear', host: 'claude' }), /`opencode --session ses_abc`/);
    // A Claude-written note restored on OpenCode points back at Claude Code.
    assert.match(renderRotationRestore({ ...note, session_host: undefined }, { cwd: dir, host: 'opencode' }), /`claude --resume ses_abc`/);
    assert.throws(() => renderRotationRestore(note, { cwd: dir, host: 'vim' }), /unknown host 'vim'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

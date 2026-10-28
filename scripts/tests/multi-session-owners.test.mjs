// Multi-session toolkit slice 3: the per-checkout owner record (scripts/lib/owner-record.mjs, the file the
// Sterling plugin already writes for the launcher), its lock (scripts/lib/file-lock.mjs), and
// wake-project --set-owner / --show-owners / --checkout. Ported from CH.Hub's per-checkout-owners,
// set-owner-command and wake-project owner tests where the behaviour is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { world, readOwner, transitionOwner, recordOwner } from './lib/multi-session-world.mjs';
import { ownerRecordPath, OWNER_RECORD_REL } from '../lib/owner-record.mjs';
import { takeFileLock, LockTimeout } from '../lib/file-lock.mjs';
import { shellQuote, setOwnerCommand } from '../lib/owner-session.mjs';
import { main } from '../wake-project.mjs';
import { CONDUCTOR_SESSION_REL } from '../../packages/opencode-plugin/src/conductor-session.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'sterling-owner-'));

test('the owner record is the launcher resume file: one path, one session id per line', () => {
  assert.equal(CONDUCTOR_SESSION_REL, OWNER_RECORD_REL);
  assert.equal(OWNER_RECORD_REL, '.sterling/transient/opencode-conductor-session');
});

test('readOwner: absent is null, a session id reads with its set time, anything else fails loud', async () => {
  const dir = tmp();
  try {
    assert.equal(readOwner(dir), null);
    assert.deepEqual(await recordOwner(dir, 'ses_A1'), { changed: true });
    assert.equal(readFileSync(ownerRecordPath(dir), 'utf8'), 'ses_A1\n');
    assert.equal(readOwner(dir).session, 'ses_A1');
    assert.ok(!Number.isNaN(Date.parse(readOwner(dir).set_at)));
    assert.deepEqual(await recordOwner(dir, 'ses_A1'), { changed: false });
    writeFileSync(ownerRecordPath(dir), 'not a session\n');
    assert.throws(() => readOwner(dir), /does not hold one session id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transitionOwner is a compare-and-set: it writes only while the record still names the expected session', async () => {
  const dir = tmp();
  try {
    assert.deepEqual(await transitionOwner(dir, { expect: null, next: 'ses_A1' }), { status: 'written', previous: null });
    assert.deepEqual(await transitionOwner(dir, { expect: null, next: 'ses_B2' }), { status: 'conflict', current: 'ses_A1' });
    assert.equal(readOwner(dir).session, 'ses_A1');
    assert.deepEqual(await transitionOwner(dir, { expect: 'ses_A1', next: 'ses_B2' }), { status: 'written', previous: 'ses_A1' });
    assert.equal(readOwner(dir).session, 'ses_B2');
    await assert.rejects(() => transitionOwner(dir, { expect: 'ses_B2', next: 'bad id' }), /not a session id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin write and a set-owner share one lock: while it is held neither writes, and the record is unchanged', async () => {
  const dir = tmp();
  try {
    await recordOwner(dir, 'ses_A1');
    const release = await takeFileLock(`${ownerRecordPath(dir)}.lock`);
    await assert.rejects(() => recordOwner(dir, 'ses_B2', { waitMs: 60 }), (e) => e instanceof LockTimeout);
    await assert.rejects(() => transitionOwner(dir, { expect: 'ses_A1', next: 'ses_B2' }, { waitMs: 60 }), (e) => e instanceof LockTimeout);
    assert.equal(readOwner(dir).session, 'ses_A1');
    release();
    assert.deepEqual(await recordOwner(dir, 'ses_B2'), { changed: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file lock: a lock of a dead process is taken over; content that is not a lock is never taken for stale', async () => {
  const dir = tmp();
  const path = join(dir, 'x.lock');
  try {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    writeFileSync(path, JSON.stringify({ pid: Number(dead.stdout.trim()), nonce: 'old' }));
    const release = await takeFileLock(path, { waitMs: 500 });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    release();
    assert.equal(existsSync(path), false);
    writeFileSync(path, '');
    await assert.rejects(() => takeFileLock(path, { waitMs: 80 }), /stayed taken/);
    assert.equal(readFileSync(path, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shellQuote leaves a plain word alone and quotes what a shell would split, expand or end; a real shell gets one argument', () => {
  assert.equal(shellQuote('proj'), 'proj');
  assert.equal(shellQuote('/a b/c'), "'/a b/c'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$HOME'), "'$HOME'");
  const word = "/tmp/a b/it's $HOME";
  const got = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(word)}`], { encoding: 'utf8' });
  assert.equal(got, word);
});

test('setOwnerCommand names the project and session, and the checkout only for a session checkout', () => {
  assert.equal(setOwnerCommand({ project: 'proj', session: '<id>' }), "node bin/wake-project.mjs --set-owner --project proj --session '<id>'");
  assert.equal(setOwnerCommand({ project: 'proj', session: 'ses_A', checkout: '/w/p q' }), "node bin/wake-project.mjs --set-owner --project proj --session ses_A --checkout '/w/p q'");
});

async function run(w, argv, over) {
  const { io, json, out } = w.io();
  const code = await main(argv, w.deps(over), io);
  return { code, res: json()[0], out };
}

test('--set-owner records an existing top-level conductor of the project folder, compare-and-set against the record it read', async () => {
  const w = world();
  try {
    w.session('ses_OLD');
    w.session('ses_NEW');
    await w.setOwner(w.ROOT, 'ses_OLD');
    const { code, res } = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_NEW']);
    assert.equal(code, 0);
    assert.equal(res.status, 'owner_set');
    assert.equal(res.previous, 'ses_OLD');
    assert.equal(readOwner(w.ROOT).session, 'ses_NEW');
    assert.equal(w.posts.length, 0);
  } finally {
    w.cleanup();
  }
});

test('--set-owner refuses a missing, subagent, archived, non-conductor or outside session and a bad id; nothing is written', async () => {
  const w = world();
  try {
    w.session('ses_TOP');
    w.session('ses_KID', { parent: 'ses_TOP' });
    w.session('ses_ARCH', { archived: true });
    w.session('ses_WORKER', { agent: 'sterling/librarian' });
    w.session('ses_FAR', { dir: w.OTHER });
    w.session('ses_LANE', { dir: w.WT });
    for (const [id, why] of [['ses_GONE', /no longer exists/], ['ses_KID', /subagent/], ['ses_ARCH', /archived/], ['ses_WORKER', /not a conductor/], ['ses_FAR', /not in the checkout/], ['ses_LANE', /not in the checkout/]]) {
      const { code, res } = await run(w, ['--set-owner', '--project', 'proj', '--session', id]);
      assert.equal(code, 1, id);
      assert.equal(res.reason, 'owner_unusable', id);
      assert.match(res.why, why, id);
    }
    assert.equal(readOwner(w.ROOT), null);
    const bad = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses-bad']);
    assert.equal(bad.code, 1);
    assert.match(bad.res.error, /unexpected session id/);
    const missing = await run(w, ['--set-owner', '--project', 'proj']);
    assert.equal(missing.code, 2);
    const unknown = await run(w, ['--set-owner', '--project', 'nope', '--session', 'ses_TOP']);
    assert.equal(unknown.code, 2);
  } finally {
    w.cleanup();
  }
});

test('--set-owner runs only from a checkout of the project it changes: the target runtime owns its record', async () => {
  const w = world();
  try {
    w.session('ses_TOP');
    const { code, res } = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_TOP'], { cwd: w.SENDER });
    assert.equal(code, 1);
    assert.equal(res.reason, 'not_own_project');
    assert.equal(readOwner(w.ROOT), null);
    const fromLane = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_TOP'], { cwd: w.WT });
    assert.equal(fromLane.res.status, 'owner_set');
  } finally {
    w.cleanup();
  }
});

test('--set-owner: the record changing while the session is checked (a plugin write) refuses, and the newer record stays', async () => {
  const w = world();
  try {
    w.session('ses_A');
    w.session('ses_B');
    w.session('ses_C');
    await w.setOwner(w.ROOT, 'ses_A');
    w.onGet = async (path) => {
      if (path === '/api/session/ses_B') {
        w.onGet = null;
        await recordOwner(w.ROOT, 'ses_C');
      }
    };
    const { code, res } = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_B']);
    assert.equal(code, 1);
    assert.equal(res.reason, 'owner_changed');
    assert.equal(readOwner(w.ROOT).session, 'ses_C');
  } finally {
    w.cleanup();
  }
});

test('--set-owner --checkout records the session under the session worktree and leaves the main owner alone', async () => {
  const w = world();
  try {
    w.session('ses_MAIN');
    w.session('ses_LANE', { dir: w.WT });
    await w.setOwner(w.ROOT, 'ses_MAIN');
    const { code, res } = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_LANE', '--checkout', w.WT]);
    assert.equal(code, 0);
    assert.equal(res.checkout, w.WT);
    assert.equal(readOwner(w.WT).session, 'ses_LANE');
    assert.equal(readOwner(w.ROOT).session, 'ses_MAIN');
    const main = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_MAIN', '--checkout', w.ROOT]);
    assert.equal(main.res.status, 'owner_set');
    assert.equal(main.res.previous, 'ses_MAIN');
  } finally {
    w.cleanup();
  }
});

test('--checkout: a folder that is no checkout, a relative path, and a nested checkout are exit 2', async () => {
  const w = world();
  try {
    w.session('ses_MAIN');
    const sub = join(w.ROOT, 'src');
    mkdirSync(sub);
    for (const path of [sub, w.OTHER, 'relative/path']) {
      const { code } = await run(w, ['--set-owner', '--project', 'proj', '--session', 'ses_MAIN', '--checkout', path]);
      assert.equal(code, 2, path);
    }
    // A second session worktree whose folder (through a link) lies inside the first one.
    const inner = join(w.WT, 'sub');
    mkdirSync(inner);
    symlinkSync(inner, join(w.base, 'proj.worktrees', 'inner'));
    const nested = await run(w, ['--project', 'proj', '--checkout', w.WT, '--dry-run'], { readdir: async (dir) => (dir === join(w.base, 'proj.worktrees') ? ['lane', 'inner'] : []), gitWorktrees: async () => [w.ROOT, w.WT, inner] });
    assert.equal(nested.code, 2);
    assert.match(nested.res.error, /nests with the session worktree/);
  } finally {
    w.cleanup();
  }
});

test('--show-owners reads the records only: every checkout of every project, one project, or one checkout; no server needed', async () => {
  const w = world();
  try {
    await w.setOwner(w.ROOT, 'ses_MAIN');
    await w.setOwner(w.WT, 'ses_LANE');
    const noServer = { api: async () => { throw new Error('no server call expected'); } };
    const all = await run(w, ['--show-owners'], noServer);
    assert.equal(all.code, 0);
    const proj = all.res.projects.find((p) => p.project === 'proj');
    assert.deepEqual(proj.checkouts.map((c) => [c.checkout, c.main, c.owner?.session ?? null]), [[w.ROOT, true, 'ses_MAIN'], [w.WT, false, 'ses_LANE']]);
    assert.equal(all.res.projects.find((p) => p.project === 'other').checkouts[0].owner, null);
    const one = await run(w, ['--show-owners', '--project', 'proj', '--checkout', w.WT], noServer);
    assert.deepEqual(one.res.checkouts.map((c) => c.owner.session), ['ses_LANE']);
    writeFileSync(ownerRecordPath(w.ROOT), 'garbage');
    const torn = await run(w, ['--show-owners', '--project', 'proj'], noServer);
    assert.match(torn.res.checkouts[0].error, /does not hold one session id/);
    const bad = await run(w, ['--show-owners', '--checkout', w.WT]);
    assert.equal(bad.code, 2);
  } finally {
    w.cleanup();
  }
});

test('bad arguments exit 2 before any call: unknown flags, an option token where a value belongs, combinations', async () => {
  const w = world();
  try {
    for (const argv of [[], ['--bogus'], ['--project', '--dry-run'], ['--show-owners', '--set-owner'], ['--project', 'proj', '--session', 'ses_A'], ['--show-owners', '--dry-run'], ['--item', 'x', '--project', 'proj']]) {
      const { code } = await run(w, argv);
      assert.equal(code, 2, argv.join(' '));
    }
    assert.equal(w.calls.length, 0);
  } finally {
    w.cleanup();
  }
});

test('the scripts run as commands: a bad argument prints the usage and exits 2 (main guard, hazard 6b1c51f4)', () => {
  const env = { ...process.env };
  for (const k of ['OPENCODE', 'OPENCODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  for (const script of ['wake-project.mjs', 'notify-project.mjs']) {
    const r = spawnSync(process.execPath, [join(repo, 'scripts', script), '--bogus'], { encoding: 'utf8', env, cwd: tmpdir() });
    assert.equal(r.status, 2, `${script}: ${r.stderr}`);
    assert.match(r.stderr, /unknown argument '--bogus'/);
  }
});

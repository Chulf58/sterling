// One case table, two hosts (decision opencode-store-guard-allows-read-only-shell-commands-like-h15):
// a shell command that names .sterling/sterling.db gets the same verdict from H15 on
// Claude Code and from the OpenCode store guard. Reads and mentions pass, write shapes
// are denied. Each case runs three ways: the shared verdict function
// (scripts/hooks/lib/store-shell-verdict.mjs), the H15 SOURCE hook spawned with a
// Bash-shaped stdin, and the OpenCode evaluate hook with the command as one resource.
// The second table holds the cases where OpenCode is stricter on purpose: its evaluate
// hook sees one simple command per resource with a leading `cd` dropped, so a bare
// sterling.db may be the store there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h15-store-guard.mjs');
const { storeShellWriteShape } = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'store-shell-verdict.mjs')).href);
const guard = await import(pathToFileURL(join(root, 'packages', 'opencode-plugin', 'src', 'store-guard.mjs')).href);

const DB = '.sterling/sterling.db';

// [command, verdict] — the verdict both hosts must give.
const SHARED = [
  // reads and mentions
  [`sqlite3 -readonly ${DB} "select 1"`, 'allow'],
  [`sqlite3 -readonly "/home/u/proj/${DB}" ".tables"`, 'allow'],
  [`sqlite3 -separator , -readonly ${DB} "select 1"`, 'allow'],
  [`sqlite3 -readonly ${DB} ".output /tmp/report.txt"`, 'allow'],
  [`ls -la ${DB}`, 'allow'],
  [`cat ${DB}`, 'allow'],
  [`cat "${DB}"`, 'allow'],
  [`grep -c x '${DB}'`, 'allow'],
  [`wc -c < ${DB}`, 'allow'],
  [`echo ${DB}`, 'allow'],
  ['cat .sterling/config.json', 'allow'],
  ['rm fixtures/other.db', 'allow'],
  // read twins of the write shapes below
  [`FOO=1 cat ${DB}`, 'allow'],
  [`timeout 5 sqlite3 -readonly ${DB} "select 1"`, 'allow'],
  [`nohup cat ${DB}`, 'allow'],
  [`bash -c "ls -la ${DB}"`, 'allow'],
  [`if true; then cat ${DB}; fi`, 'allow'],
  [`ls ${DB}*`, 'allow'],
  ["find .sterling -name 'sterling.db*'", 'allow'],
  ["find . -name '*.log' -delete", 'allow'],
  ['git status', 'allow'],
  ['git log -- .sterling/config.json', 'allow'],
  [`git log -- ${DB}`, 'allow'],
  ['git checkout -- .sterling/config.json', 'allow'],
  ['rm .sterling/transient/*', 'allow'], // every other file under .sterling/ stays writable
  ['rm .sterling/*.json', 'allow'],
  // User-ruled 2026-10-03 ("Keep deletes, drop git and find"): these four were deny rows for one fix round.
  // They block commands that do not touch the store, and the scale-down removed friction on purpose, so
  // both hosts allow them. find keeps only its older arm: a `.sterling` path plus -delete or -exec rm.
  [`git rm ${DB}`, 'allow'],
  [`git checkout -- ${DB}`, 'allow'],
  ['git rm sterling.db', 'allow'],
  ['find . -name sterling.db -delete', 'allow'],
  ["find . -name 'sterling.db*' -exec rm {} +", 'allow'],
  ['find .sterling -name config.json -delete', 'deny'],
  // write shapes
  [`cp ${DB} /tmp/copy.db`, 'deny'], // H15 does not tell a cp source from its target
  [`cp /tmp/x ${DB}`, 'deny'],
  [`rm ${DB}`, 'deny'],
  [`rm "${DB}"`, 'deny'],
  [`rm .sterling/sterling''.db`, 'deny'],
  [`mv ${DB} /tmp/x`, 'deny'],
  [`echo x > ${DB}`, 'deny'],
  [`printf x >> "${DB}"`, 'deny'],
  [`tee ${DB}-wal`, 'deny'],
  [`sed -i s/a/b/ ${DB}`, 'deny'],
  [`sudo -u root rm ${DB}`, 'deny'],
  [`cp /tmp/evil .sterling/STERLING.DB`, 'deny'],
  [`sqlite3 ${DB} "select 1"`, 'deny'],
  [`sqlite3 ${DB}-wal .tables`, 'deny'],
  [`sqlite3 -separator -readonly ${DB} "select 1"`, 'deny'],
  [`sqlite3 -readonly ${DB} "ATTACH '${DB}' AS x"`, 'deny'],
  [`sqlite3 -readonly ${DB} "VACUUM INTO '.sterling/sterling.db.bak'"`, 'deny'],
  [`sqlite3 -readonly ${DB} ".backup main .sterling/sterling.db.bak"`, 'deny'],
  [`sqlite3 -readonly /tmp/other.db ".output ${DB}"`, 'deny'],
  ['rm -rf .sterling', 'deny'],
  // a glob or brace pattern that expands to the database (task-end review, 2026-10-03)
  [`rm ${DB}*`, 'deny'],
  [`rm -f ${DB}*`, 'deny'],
  [`rm ${DB}{,-wal,-shm}`, 'deny'],
  [`rm ${DB}-*`, 'deny'],
  ['rm .sterling/*.db', 'deny'],
  ['rm .sterling/sterling.*', 'deny'],
  ['rm .sterling/*', 'deny'],
  ['rm ~/.sterling/domains/node/*', 'deny'],
  // a verb that is not the first word
  [`FOO=1 rm ${DB}`, 'deny'],
  [`timeout 5 rm ${DB}`, 'deny'],
  [`timeout -k 1 5 rm ${DB}`, 'deny'],
  [`nohup rm ${DB}`, 'deny'],
  [`/bin/rm ${DB}`, 'deny'],
  [`bash -c "rm ${DB}"`, 'deny'],
  [`sh -c 'rm ${DB}'`, 'deny'],
  [`eval rm ${DB}`, 'deny'],
  [`if true; then rm ${DB}; fi`, 'deny'],
  [`{ rm ${DB}; }`, 'deny'],
  [`! rm ${DB}`, 'deny'],
  [`sc ${DB} x`, 'deny'],
  [`ni ${DB}`, 'deny'],
  [`clc ${DB}`, 'deny'],
  [`Set-Content -Path:${DB} x`, 'deny'],
];

// [resource, H15 verdict] — OpenCode denies every one of these.
const OPENCODE_STRICTER = [
  ['rm sterling.db', 'allow'], // `cd .sterling && rm sterling.db` reaches the evaluate hook as this
  ['rm ./sterling.db-wal', 'allow'],
  ['sqlite3 sterling.db .tables', 'allow'],
  ['echo x > sterling.db', 'allow'],
  ['cp /tmp/x fixtures/sterling.db', 'allow'], // the working directory is unknown, so the name decides
  [`sqlite3 -readonly sterling.db "attach 'sterling.db' as x"`, 'allow'],
  [DB, 'allow'], // a redirect target arriving as a resource of its own
  ['rm .sterling\\sterling.db', 'allow'], // a backslash path, should the shell be PowerShell
  [`sqlite3 -readonly ${DB} <<EOF`, 'allow'], // a heredoc whose body the resource does not carry
  // the review's bare-name forms: no `.sterling` component, so H15 lets them through
  ['rm sterling.db*', 'allow'],
  ['rm sterling.*', 'allow'],
  ['FOO=1 rm sterling.db', 'allow'],
  ['timeout 5 rm sterling.db', 'allow'],
  ['nohup rm sterling.db', 'allow'],
  ['bash -c "rm sterling.db"', 'allow'],
  ['eval rm sterling.db', 'allow'],
  ['if true; then rm sterling.db; fi', 'allow'],
  ['{ rm sterling.db; }', 'allow'],
  ['! rm sterling.db', 'allow'],
  ['Set-Content -Path:sterling.db x', 'allow'],
];

let project;
before(() => {
  project = mkdtempSync(join(tmpdir(), 'store-guard-parity-'));
  mkdirSync(join(project, '.sterling'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), '{}\n');
});
after(() => rmSync(project, { recursive: true, force: true }));

function h15(command) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: project }),
    encoding: 'utf8',
    cwd: project,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  assert.ok(r.status === 0 || r.status === 2, `H15 exited ${r.status}: ${r.stderr}`);
  return r.status === 2 ? 'deny' : 'allow';
}

function opencode(resources) {
  const p = { sessionID: 'ses_1', agent: 'a', action: 'shell', resources, metadata: {}, source: { type: 'tool' }, effect: 'allow' };
  guard.onEvaluate(p);
  return p.effect;
}

test('shared table: the verdict function, the H15 hook and the OpenCode guard agree on every command', () => {
  for (const [command, verdict] of SHARED) {
    assert.equal(storeShellWriteShape(command) ? 'deny' : 'allow', verdict, `verdict function: ${command}`);
    assert.equal(h15(command), verdict, `H15: ${command}`);
    assert.equal(opencode([command]), verdict, `OpenCode: ${command}`);
  }
});

test('OpenCode: a line split into simple commands is denied when any one of them is a write shape', () => {
  assert.equal(opencode(['cat x', `rm ${DB}`]), 'deny'); // `cat x; rm .sterling/sterling.db`
  assert.equal(opencode([`cat ${DB}`, 'wc -l']), 'allow'); // `cat .sterling/sterling.db | wc -l`
  assert.equal(opencode(['cat sterling.db']), 'allow'); // `cd .sterling && cat sterling.db`
});

test('OpenCode is stricter where its resource shape hides the directory: H15 allows, OpenCode denies', () => {
  for (const [resource, h15Verdict] of OPENCODE_STRICTER) {
    assert.equal(h15(resource), h15Verdict, `H15: ${resource}`);
    assert.equal(opencode([resource]), 'deny', `OpenCode: ${resource}`);
  }
});

test('a command the parser cannot read is denied on both hosts, never passed', () => {
  const deep = '('.repeat(20000) + 'rm sterling.db';
  assert.throws(() => storeShellWriteShape(deep), RangeError);
  assert.equal(h15(deep), 'deny');
  const p = { sessionID: 'ses_1', agent: 'a', action: 'shell', resources: [deep], metadata: {}, source: { type: 'tool' }, effect: 'allow' };
  guard.onEvaluate(p);
  assert.equal(p.effect, 'deny');
  assert.equal(p.message, guard.STORE_GUARD_UNREADABLE_MESSAGE);
});

test('a long run of wildcards is decided quickly: unrelated tokens never reach the glob test, and one inside .sterling/ denies', () => {
  const stars = '*'.repeat(40);
  const timed = (command, opts) => {
    const t0 = performance.now();
    const verdict = storeShellWriteShape(command, opts);
    return { verdict, ms: performance.now() - t0 };
  };
  for (const [command, opts, verdict] of [
    [`rm a/${stars}x`, {}, false],
    [`rm a/${stars}x`, { bareDbName: true }, false],
    [`rm .sterling/${stars}`, {}, true],
    [`rm .sterling/${stars}x`, {}, false],
    [`rm sterling${'*x'.repeat(40)}`, { bareDbName: true }, true], // more wildcards than the test converts: counted as a match
    [`rm .sterling/${'*?'.repeat(40)}`, {}, true],
  ]) {
    const r = timed(command, opts);
    assert.equal(r.verdict, verdict, command.slice(0, 40));
    assert.ok(r.ms < 200, `${command.slice(0, 40)} took ${r.ms.toFixed(1)} ms`);
  }
});

test('the verdict function reads PowerShell paths when told to, and bare names only when told to', () => {
  assert.equal(storeShellWriteShape('Remove-Item .sterling\\sterling.db', { powershell: true }), true);
  assert.equal(storeShellWriteShape('Get-Content .sterling\\sterling.db', { powershell: true }), false);
  assert.equal(storeShellWriteShape('rm sterling.db'), false);
  assert.equal(storeShellWriteShape('rm sterling.db', { bareDbName: true }), true);
  assert.equal(storeShellWriteShape('cat sterling.db', { bareDbName: true }), false);
});

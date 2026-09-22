// Pins for H15's ONE rule (decision sterling-claude-code-scale-down-boundary,
// 2026-09-19): only the store DATABASE is sealed from every tool but the MCP
// server; every other file under .sterling/ is freely readable and writable.
// The suite spawns the SOURCE hook as a child process with a hook-shaped stdin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h15-store-guard.mjs');

function runRaw(stdin, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}
function run(tool_name, tool_input, cwd = project) {
  return runRaw(JSON.stringify({ tool_name, tool_input, cwd }), cwd);
}

let project;
before(() => {
  project = mkdtempSync(join(tmpdir(), 'h15-db-seal-'));
  mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), '{}\n');
});
after(() => rmSync(project, { recursive: true, force: true }));

// ── structured channel: the database is sealed ──────────────────────────────
test('Write to .sterling/sterling.db is denied', () => {
  const r = run('Write', { file_path: join(project, '.sterling', 'sterling.db'), content: 'x' });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /store database/);
});
test('Edit to .sterling/sterling.db-wal is denied', () => {
  const r = run('Edit', { file_path: join(project, '.sterling', 'sterling.db-wal') });
  assert.equal(r.code, 2, r.stderr);
});
test('Write to a sterling.db.* backup inside .sterling/ is denied', () => {
  const r = run('Write', { file_path: join(project, '.sterling', 'sterling.db.pre-v2-2026-08-22.backup.db') });
  assert.equal(r.code, 2, r.stderr);
});
test('relative .sterling/sterling.db resolved against cwd is denied', () => {
  const r = run('MultiEdit', { file_path: '.sterling/sterling.db', edits: [] });
  assert.equal(r.code, 2, r.stderr);
});
test('NotebookEdit into the database is denied', () => {
  const r = run('NotebookEdit', { notebook_path: join(project, '.sterling', 'sterling.db') });
  assert.equal(r.code, 2, r.stderr);
});

// ── structured channel: everything else under .sterling/ is free ────────────
test('Edit to .sterling/config.json is ALLOWED (the friction this rebuild removes)', () => {
  const r = run('Edit', { file_path: join(project, '.sterling', 'config.json'), old_string: 'a', new_string: 'b' });
  assert.equal(r.code, 0, r.stderr);
});
test('Write to .sterling/transient/x.json is allowed', () => {
  const r = run('Write', { file_path: join(project, '.sterling', 'transient', 'x.json'), content: '{}' });
  assert.equal(r.code, 0, r.stderr);
});
test('Write to .sterling/review-ledger.json is allowed', () => {
  const r = run('Write', { file_path: join(project, '.sterling', 'review-ledger.json'), content: '{}' });
  assert.equal(r.code, 0, r.stderr);
});
test('a file named sterling.db OUTSIDE any .sterling directory is allowed', () => {
  const r = run('Write', { file_path: join(project, 'fixtures', 'sterling.db'), content: '' });
  assert.equal(r.code, 0, r.stderr);
});
test('an ordinary project file is allowed', () => {
  const r = run('Edit', { file_path: join(project, 'src', 'index.ts') });
  assert.equal(r.code, 0, r.stderr);
});

// ── structured channel: fail closed on unusable input ───────────────────────
test('Write with no file_path is denied (fail closed)', () => {
  const r = run('Write', { content: 'x' });
  assert.equal(r.code, 2, r.stderr);
});
test('relative path with no cwd is denied (fail closed)', () => {
  const r = runRaw(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.sterling/sterling.db' } }), project);
  assert.equal(r.code, 2, r.stderr);
});
test('malformed stdin is denied (fail closed)', () => {
  const r = runRaw('not json', project);
  assert.equal(r.code, 2, r.stderr);
});
test('a tool this hook is not registered for is allowed', () => {
  const r = run('Read', { file_path: join(project, '.sterling', 'sterling.db') });
  assert.equal(r.code, 0, r.stderr);
});

// ── shell channel: literal seal on the database, nothing else ───────────────
test('Bash: cat .sterling/config.json is allowed', () => {
  const r = run('Bash', { command: 'cat .sterling/config.json' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: echo into .sterling/config.json is allowed (no verb classification)', () => {
  const r = run('Bash', { command: 'echo "{}" > .sterling/config.json && ls -la ~/.sterling/domains' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: redirect into sterling.db is denied', () => {
  const r = run('Bash', { command: 'echo x > .sterling/sterling.db' });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /sterling\.db/);
});
test('Bash: plain sqlite3 against sterling.db (no -readonly) is still denied, even for a SELECT', () => {
  const r = run('Bash', { command: 'sqlite3 .sterling/sterling.db "select count(*) from records"' });
  assert.equal(r.code, 2, r.stderr);
});
// User-ruled 2026-09-22 ("Yes, allow reads", given through the question form): sqlite3 -readonly
// against the store database is allowed — the flag decides, H15 does not parse SQL. Supersedes the
// prior "sqlite3 is destructive even for a SELECT" accepted cost recorded in article store-database-seal-h15.
test('Bash: sqlite3 -readonly against sterling.db is allowed', () => {
  const r = run('Bash', { command: 'sqlite3 -readonly .sterling/sterling.db "select count(*) from records"' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: -readonly after the db path does not count (flag must precede the path)', () => {
  const r = run('Bash', { command: 'sqlite3 .sterling/sterling.db -readonly "select 1"' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: --readonly (double dash) is not recognized — still denied', () => {
  const r = run('Bash', { command: 'sqlite3 --readonly .sterling/sterling.db "select 1"' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: sqlite3 -readonly chained with a writing sqlite3 fragment is denied on the second fragment', () => {
  const r = run('Bash', {
    command: 'sqlite3 -readonly .sterling/sterling.db "select 1" && sqlite3 .sterling/sterling.db "delete from records"',
  });
  assert.equal(r.code, 2, r.stderr);
});
// Sol cross-family review round on d2cb9f2: the TARGET of a .output/.once/.backup/.save dot-command
// decides, independent of which db the sqlite3 invocation opened as its positional argument — writing
// a store path is denied even when the opened db is some other, unprotected file, and a target that is
// NOT a store path is allowed even when the opened db IS the protected one.
test('Bash: sqlite3 -readonly with a .output/.once/.backup/.save dot-command TARGETING the db path is denied', () => {
  for (const command of [
    'sqlite3 -readonly .sterling/sterling.db ".output .sterling/sterling.db"',
    'sqlite3 -readonly .sterling/sterling.db ".once .sterling/sterling.db"',
    'sqlite3 -readonly .sterling/sterling.db ".backup .sterling/sterling.db"',
    'sqlite3 -readonly .sterling/sterling.db ".save .sterling/sterling.db"',
    // the store path is the dot-command TARGET, not the positional db opened by sqlite3 — still denied
    'sqlite3 -readonly source.db ".backup .sterling/sterling.db"',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: sqlite3 -readonly with a dot-command TARGETING somewhere else is allowed, even against the protected db', () => {
  const r = run('Bash', { command: 'sqlite3 -readonly .sterling/sterling.db ".output /tmp/report"' });
  assert.equal(r.code, 0, r.stderr);
});
// VACUUM INTO creates a brand-new file rather than writing the opened db, so -readonly's OS-level
// protection does not stop it; ATTACH opens a second db read-write by default regardless of -readonly
// on the primary connection. Both are denied by raw text when their target names a .sterling/ path.
test('Bash: sqlite3 -readonly with VACUUM INTO naming a .sterling/ path is denied', () => {
  const r = run('Bash', {
    command: `sqlite3 -readonly .sterling/sterling.db "VACUUM INTO '.sterling/sterling.db.snapshot'"`,
  });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: sqlite3 -readonly with VACUUM INTO in a heredoc BODY naming a .sterling/ path is denied (the body is opaque to fragmenting, not to this scan)', () => {
  const r = run('Bash', {
    command: "sqlite3 -readonly .sterling/sterling.db <<'EOF'\nVACUUM INTO '.sterling/sterling.db.snapshot';\nEOF",
  });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: sqlite3 -readonly with ATTACH naming a .sterling/ path is denied', () => {
  const r = run('Bash', {
    command: `sqlite3 -readonly .sterling/sterling.db "ATTACH '.sterling/sterling.db-wal' AS x"`,
  });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: sqlite3 -readonly with a plain VACUUM (no INTO) or an ATTACH naming a non-store path is allowed', () => {
  for (const command of [
    'sqlite3 -readonly .sterling/sterling.db "VACUUM;"',
    `sqlite3 -readonly .sterling/sterling.db "ATTACH '/tmp/other.db' AS x"`,
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
});
test('Bash: sqlite3 -readonly on a same-named file outside the store is allowed (unaffected)', () => {
  const r = run('Bash', { command: 'sqlite3 -readonly fixtures/sterling.db "select 1"' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: a redirect into the database alongside a -readonly sqlite3 fragment stays denied', () => {
  const r = run('Bash', { command: 'sqlite3 -readonly .sterling/sterling.db "select 1" > .sterling/sterling.db' });
  assert.equal(r.code, 2, r.stderr);
});
// `-readonly` consumed as the VALUE of a preceding value-taking sqlite3 option is not the flag — the
// db still opens writable. Value-taking options checked locally (no sqlite3 CLI installed on this
// machine; list drawn from the sqlite3.c CLI docs, not invented): -cmd, -init, -maxsize, -mmap,
// -newline, -nullvalue, -separator, -vfs (one value each); -lookaside, -pagecache (two values each).
test('Bash: -readonly consumed as a value-taking option\'s VALUE does not count as the flag', () => {
  const r = run('Bash', { command: 'sqlite3 -separator -readonly .sterling/sterling.db "select 1"' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: -readonly survives when a DIFFERENT value-taking option consumes its own value first', () => {
  const r = run('Bash', { command: 'sqlite3 -separator , -readonly .sterling/sterling.db "select 1"' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: -readonly survives past a two-value option (-pagecache SIZE N)', () => {
  const r = run('Bash', { command: 'sqlite3 -pagecache 1000 8 -readonly .sterling/sterling.db "select 1"' });
  assert.equal(r.code, 0, r.stderr);
});
test('PowerShell: Remove-Item on sterling.db is denied', () => {
  const r = run('PowerShell', { command: 'Remove-Item .sterling\\sterling.db -Force' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: a Sterling script taking --store <db> is allowed', () => {
  const r = run('Bash', { command: 'node /mnt/c/Users/x/sterling-main/scripts/migrate-stores.mjs --store .sterling/sterling.db' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: the TUI bundle taking --store <db> is allowed', () => {
  const r = run('Bash', { command: 'node packages/tui/bundle/sterling-tui.mjs --store "$PWD/.sterling/sterling.db"' });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: a command with no store mention is allowed', () => {
  const r = run('Bash', { command: 'git status --short' });
  assert.equal(r.code, 0, r.stderr);
});
// Open-world shell arm (user-ruled 2026-09-19: stop destruction, nothing more). Terra and
// Sol reviews the same day: no exemption exists, every fragment is judged on its own shape.
test('Bash: sqlite3 in a later fragment is denied whatever came before it', () => {
  const r = run('Bash', { command: 'node scripts/init.mjs --label ok; sqlite3 .sterling/sterling.db "select 1"' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: a redirect into the database is denied even when a script is mentioned', () => {
  const r = run('Bash', { command: 'cat scripts/x.mjs > .sterling/sterling.db' });
  assert.equal(r.code, 2, r.stderr);
});
test('Bash: rm / cp / mv / dd / truncate naming the database are denied', () => {
  for (const command of [
    'rm -f .sterling/sterling.db',
    'cp backup.db .sterling/sterling.db',
    'mv .sterling/sterling.db /tmp/x.db',
    'dd if=/dev/zero of=.sterling/sterling.db bs=1 count=1',
    'cd /x && truncate -s 0 .sterling/sterling.db',
    'sudo rm .sterling/sterling.db-wal',
    'echo x | tee .sterling/sterling.db',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: in-place sed/perl on the database is denied', () => {
  for (const command of ['sed -i s/a/b/ .sterling/sterling.db', 'perl -0pi -e "s/a/b/" .sterling/sterling.db']) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('PowerShell: Set-Content / Copy-Item on the database are denied', () => {
  for (const command of ['Set-Content .sterling\\sterling.db "x"', 'Copy-Item x.db .sterling\\sterling.db']) {
    const r = run('PowerShell', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: reads and mere mentions of the database are allowed', () => {
  for (const command of [
    'ls -la .sterling/sterling.db',
    'grep -c records .sterling/sterling.db',
    'stat .sterling/sterling.db && du -h .sterling/sterling.db',
    'echo "the store is at .sterling/sterling.db"',
    "cat > mcp-servers.json <<'EOF'\n{ \"args\": [\"--store\", \"${CLAUDE_PROJECT_DIR}/.sterling/sterling.db\"] }\nEOF",
    'sqlite3 --version',
    'rm -rf node_modules/.cache',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
});
test('Bash: node with flags and a quoted absolute script path taking --store <db> is allowed', () => {
  const r = run('Bash', {
    command: 'node --disable-warning=ExperimentalWarning "C:/Users/x/sterling-main/scripts/migrate-stores.mjs" --store .sterling/sterling.db',
  });
  assert.equal(r.code, 0, r.stderr);
});
test('Bash: a Sterling script invoked after cd && is allowed', () => {
  const r = run('Bash', { command: 'cd /mnt/c/x && node scripts/init.mjs --store .sterling/sterling.db' });
  assert.equal(r.code, 0, r.stderr);
});

// ── shell channel: clobber/concatenated redirects, wrapped invocations,
//    recursive directory deletion, and heredoc opacity ──────────────────────
test('Bash: clobber and concatenated redirects into the database are denied', () => {
  for (const command of [
    'cat x >| .sterling/sterling.db',
    'cat x >"$PWD"/.sterling/sterling.db',
    'cat x > "./.sterling/sterling.db"',
    'printf x &> .sterling/sterling.db',
    'cat x 2>> .sterling/sterling.db-wal',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: newline-separated and wrapper-prefixed invocations naming the database are denied', () => {
  for (const command of [
    'echo hi\nrm -f .sterling/sterling.db',
    'command rm .sterling/sterling.db',
    'sudo -n rm .sterling/sterling.db',
    'env FOO=1 rm .sterling/sterling.db',
    'exec rm .sterling/sterling.db',
    'ls | xargs rm .sterling/sterling.db',
    '(rm .sterling/sterling.db)',
    'true && $(rm .sterling/sterling.db)',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash/PowerShell: recursive deletion or cleaning of the store directory is denied', () => {
  const cases = [
    ['Bash', 'rm -rf .sterling'],
    ['Bash', 'rm -rf .sterling/'],
    ['Bash', 'rm -r ./.sterling'],
    ['Bash', 'cd packages && rm -rf ../.sterling'],
    ['Bash', 'rmdir .sterling'],
    ['Bash', 'find .sterling -delete'],
    ['Bash', 'find . -name .sterling -exec rm -rf {} +'],
    ['Bash', 'git clean -fdx'],
    ['Bash', 'git clean -fdX'],
    ['Bash', 'git clean -xdf'],
    ['PowerShell', 'Remove-Item -Recurse .sterling'],
    ['PowerShell', 'ri -r -Force .sterling'],
    ['PowerShell', 'rd /s /q .sterling'],
  ];
  for (const [tool_name, command] of cases) {
    const r = run(tool_name, { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: same-named files outside the store, reads, and mentions are allowed', () => {
  for (const command of [
    'rm /tmp/sterling.db',
    'sqlite3 fixtures/sterling.db "select 1"',
    'git log -- .sterling/sterling.db',
    'cp .sterling/config.json /tmp/',
    'rm -rf node_modules && npm ci',
    'git clean -fd',
    'tee out.log',
    'ls .sterling',
    'du -sh .sterling/',
    'echo "backup of .sterling/sterling.db done"',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
});
test('Bash: heredoc bodies quoting destructive-looking text are opaque and allowed', () => {
  for (const command of [
    "git commit -F - <<'EOF'\nrm -rf .sterling\n(rm /tmp/sterling.db is denied)\n.sterling/sterling.db\nEOF",
    "cat > notes.md <<'EOF'\nsqlite3 .sterling/sterling.db \".tables\"\nEOF",
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
});

// ── shell channel: Sol round-4 tokenizer findings ────────────────────────────
test('Bash: command substitution inside double quotes or backticks is denied', () => {
  for (const command of [
    'echo "$(rm .sterling/sterling.db)"',
    'echo "`rm .sterling/sterling.db`"',
    'x="$(cat y > .sterling/sterling.db)"',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: wrappers that take an option argument still expose the destructive verb', () => {
  for (const command of [
    'sudo -u root rm .sterling/sterling.db',
    'nice -n 5 rm .sterling/sterling.db',
    'env -i FOO=1 rm .sterling/sterling.db',
    'sudo -u root -- rm -rf .sterling',
  ]) {
    const r = run('Bash', { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash/PowerShell: the store directory match is case-insensitive', () => {
  const cases = [
    ['PowerShell', 'Remove-Item -Recurse .STERLING'],
    ['Bash', 'rm -rf .Sterling'],
    ['Bash', 'rm -f .STERLING/sterling.db'],
    ['Bash', 'echo x > .Sterling/STERLING.DB'],
  ];
  for (const [tool_name, command] of cases) {
    const r = run(tool_name, { command });
    assert.equal(r.code, 2, `${command}\n${r.stderr}`);
  }
});
test('Bash: non-string command shapes fail closed without throwing', () => {
  for (const tool_input of [{ command: { toString: null } }, { command: 12 }]) {
    const r = runRaw(JSON.stringify({ tool_name: 'Bash', tool_input, cwd: project }), project);
    assert.equal(r.code, 2, `${JSON.stringify(tool_input)}\n${r.stderr}`);
  }
  for (const tool_input of [{}, { command: '' }]) {
    const r = runRaw(JSON.stringify({ tool_name: 'Bash', tool_input, cwd: project }), project);
    assert.equal(r.code, 0, `${JSON.stringify(tool_input)}\n${r.stderr}`);
  }
});

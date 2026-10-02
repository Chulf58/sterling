// H1 SessionStart — PENDING ISSUE REPORTS LINE (decision
// projects-file-sterling-issues-as-scrubbed-github-issues-automatically). When
// report-issue.mjs could not reach GitHub it queued the report in
// .sterling/pending-issue-reports.jsonl; H1 (and the OpenCode context, through the
// same shared line in scripts/hooks/lib/operating-state.mjs) states the count from
// that local file and makes no network call. Nothing queued means no line; a file
// that cannot be read is a loud UNKNOWN line, never silence.
// Harness copied from scripts/tests/h1-project-mode-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
let lib;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  lib = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'operating-state.mjs')).href);
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

const entry = (n) => JSON.stringify({ fingerprint: `sterling-fp-${String(n).padStart(12, '0')}`, title: `t${n}`, body: 'b', labels: ['sterling-report'] });

function project(queue) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-issues-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  if (queue !== undefined) writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), queue);
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

function context(dir) {
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
  });
  assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const reportLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Sterling issue reports:'));

// ---- the shared line --------------------------------------------------------

test('shared lib: no queue file, or one holding only blank lines, states nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-issues-lib-'));
  try {
    assert.equal(lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: root }), '', 'no .sterling/ at all');
    mkdirSync(join(dir, '.sterling'));
    assert.equal(lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: root }), '', 'no queue file');
    writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), '\n  \n');
    assert.equal(lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: root }), '', 'blank lines are not reports');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared lib: the count is the non-blank lines, and the line names the flush command under the resolved root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-issues-lib-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), `${entry(1)}\n\n${entry(2)}\n`);
    const line = lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: '/opt/sterling' });
    assert.equal(
      line,
      'Sterling issue reports: 2 queued in .sterling/pending-issue-reports.jsonl, not yet filed on GitHub. ' +
        'Send them with `node "/opt/sterling/bin/report-issue.mjs" --flush` once gh is installed and logged in; the next report sends them too.',
    );
    writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), `${entry(1)}\n`);
    assert.match(lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: '/opt/sterling' }), /^Sterling issue reports: 1 queued /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared lib: an unresolved plugin root still states the count, naming the bin by its plugin-relative path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-issues-lib-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), `${entry(1)}\n`);
    const line = lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: null });
    assert.match(line, /^Sterling issue reports: 1 queued /);
    assert.match(line, /Sterling's bin\/report-issue\.mjs --flush/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared lib: a queue path that cannot be read is a loud UNKNOWN line, never silence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-issues-lib-'));
  try {
    mkdirSync(join(dir, '.sterling', 'pending-issue-reports.jsonl'), { recursive: true });
    const line = lib.pendingIssueReportsLine({ cwd: dir, pluginRoot: root });
    assert.match(line, /^Sterling issue reports: UNKNOWN — \.sterling\/pending-issue-reports\.jsonl could not be read \(/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- H1 -----------------------------------------------------------------------

test('H1 states the pending-report count once, with the flush command under the plugin root', () => {
  const dir = project(`${entry(1)}\n${entry(2)}\n${entry(3)}\n`);
  try {
    const lines = reportLines(context(dir));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Sterling issue reports: 3 queued in \.sterling\/pending-issue-reports\.jsonl, not yet filed on GitHub\./);
    assert.ok(lines[0].includes(`node "${join(root, 'bin', 'report-issue.mjs')}" --flush`), lines[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 says nothing about issue reports when nothing is queued', () => {
  for (const queue of [undefined, '']) {
    const dir = project(queue);
    try {
      assert.deepEqual(reportLines(context(dir)), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

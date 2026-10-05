// stamp-contract on an INSTALLED plugin copy (no .git; decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone). There is no
// git history to read, so the historical bullet set comes from bin/contract-history.json,
// which build:bin writes from the templates' git log minus the current template blocks.
// A missing snapshot degrades loudly to current-only (P5); the snapshot itself is stable
// across the commit that changes a template, so that commit does not make bin/ stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';
import { contractHistoryJson } from '../lib/contract-bullets.mjs';
import { renderClaudeText } from '../lib/agent-fences.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_REL = 'templates/target-agents-md.md';
const CLAUDE_REL = 'templates/target-claude-md.md';
const RECONCILE_LEAD = '- **Reconcile _every affected_ article, not just the primary one**';
// A genuine historical (commit dc366720) wording of the Reconcile bullet.
const STALE_RECONCILE = '- **Reconcile _every affected_ article, not just the primary one** — the article owning the touched files, and any whose behavior or dependencies the change invalidates (follow `relies_on` / `relied_by`). New features get a new owning article; renames rewrite `file_keys` so knowledge is never orphaned.';

const realTemplate = (rel) => readFileSync(join(root, rel), 'utf8');
const currentReconcile = () => realTemplate(CLAUDE_REL).split('\n').find((l) => l.startsWith(RECONCILE_LEAD));
const withStaleReconcile = (text) => text.replace(currentReconcile(), STALE_RECONCILE);

// The node_modules the real tree resolves @sterling/store from (a worktree has none of
// its own; resolution walks up to the main tree's).
function nodeModulesDir() {
  for (let d = root; ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', '@sterling', 'store'))) return join(d, 'node_modules');
    if (dirname(d) === d) throw new Error(`no node_modules with @sterling/store above ${root}`);
  }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

// A plugin root: the stamp-contract source, its lib, the templates, and a git repo whose
// history holds an OLDER Reconcile wording followed by the current templates.
function makePluginRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-installed-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'templates'));
  cpSync(join(root, 'scripts', 'stamp-contract.mjs'), join(dir, 'scripts', 'stamp-contract.mjs'));
  cpSync(join(root, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
  symlinkSync(nodeModulesDir(), join(dir, 'node_modules'), 'dir');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, AGENTS_REL), realTemplate(AGENTS_REL));
  writeFileSync(join(dir, CLAUDE_REL), withStaleReconcile(realTemplate(CLAUDE_REL)));
  git(dir, ['add', 'templates']);
  git(dir, ['commit', '-q', '-m', 'older Reconcile wording']);
  return dir;
}
function commitCurrentTemplates(dir) {
  writeFileSync(join(dir, CLAUDE_REL), realTemplate(CLAUDE_REL));
  git(dir, ['add', 'templates']);
  git(dir, ['commit', '-q', '-m', 'current templates']);
}

function renderTemplate(rel) {
  // CLAUDE.md is the template's Claude render (decision sterling-layer-is-one-source-with-host-blocks).
  return renderClaudeText(realTemplate(rel), rel)
    .replaceAll('{{PROJECT_NAME}}', 'installed-sibling')
    .replaceAll('{{STACK_TAGS}}', 'node')
    .replaceAll('{{TOOLCHAINS}}', 'node (**/*.mjs)')
    .replaceAll('{{LINT_COMMAND}}', 'not recorded yet; add it here')
    .replaceAll('{{DOMAINS}}', '~/.sterling/domains/node/ — created lazily on first need (§2.3)')
    .replaceAll('{{BACKUP_PATH}}', '(opted out — recorded)')
    .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
}

function withSibling(fn) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-installed-reg-'));
  const sibling = mkdtempSync(join(tmpdir(), 'sterling-installed-sibling-'));
  const regDb = join(scratch, 'registry.db');
  const registry = new ProjectRegistry(regDb);
  try {
    writeFileSync(join(sibling, 'AGENTS.md'), renderTemplate(AGENTS_REL));
    writeFileSync(join(sibling, 'CLAUDE.md'), withStaleReconcile(renderTemplate(CLAUDE_REL)));
    registry.register({ repo_path: sibling, name: 'installed-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    fn({ sibling, regDb });
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(sibling, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
const runStamp = (dir, regDb, env = process.env) =>
  spawnSync(process.execPath, [join(dir, 'scripts', 'stamp-contract.mjs'), '--apply'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, STERLING_REGISTRY_DB: regDb },
  });

test('installed copy (no .git) with bin/contract-history.json: an older template-descended bullet is replaced cleanly, exit 0', () => {
  const dir = makePluginRoot();
  try {
    commitCurrentTemplates(dir);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'contract-history.json'), contractHistoryJson(dir));
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    withSibling(({ sibling, regDb }) => {
      const r = runStamp(dir, regDb);
      assert.equal(r.status, 0, `clean replace expected:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /updated\s+- \*\*Reconcile/);
      assert.ok(!/REFUSED/.test(r.stdout), r.stdout);
      assert.ok(!/only the current template text counts/.test(r.stderr), `no degraded warning when the snapshot loads:\n${r.stderr}`);
      assert.equal(readFileSync(join(sibling, 'CLAUDE.md'), 'utf8'), renderTemplate(CLAUDE_REL), 'the old bullet became the current one');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('installed copy nested inside an unrelated git repo: git log there is empty, so the snapshot is still used, exit 0', () => {
  const dir = makePluginRoot();
  const parent = mkdtempSync(join(tmpdir(), 'sterling-installed-parent-'));
  try {
    commitCurrentTemplates(dir);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'contract-history.json'), contractHistoryJson(dir));
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    git(parent, ['init', '-q']);
    git(parent, ['config', 'user.email', 'test@example.com']);
    git(parent, ['config', 'user.name', 'test']);
    git(parent, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(parent, 'README.md'), 'unrelated\n');
    git(parent, ['add', 'README.md']);
    git(parent, ['commit', '-q', '-m', 'unrelated parent']);
    const nested = join(parent, 'plugin');
    renameSync(dir, nested);
    // No GIT_CEILING_DIRECTORIES: git discovery walks up into the parent repo.
    const env = { ...process.env };
    delete env.GIT_CEILING_DIRECTORIES;
    withSibling(({ sibling, regDb }) => {
      const r = runStamp(nested, regDb, env);
      assert.equal(r.status, 0, `clean replace expected:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /updated\s+- \*\*Reconcile/);
      assert.ok(!/REFUSED/.test(r.stdout), r.stdout);
      assert.equal(readFileSync(join(sibling, 'CLAUDE.md'), 'utf8'), renderTemplate(CLAUDE_REL), 'the old bullet became the current one');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('installed copy (no .git) WITHOUT bin/contract-history.json: degraded and announced on stderr, the older bullet reads as drift (exit 2), sibling untouched', () => {
  const dir = makePluginRoot();
  try {
    commitCurrentTemplates(dir);
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    withSibling(({ sibling, regDb }) => {
      const before = readFileSync(join(sibling, 'CLAUDE.md'), 'utf8');
      const r = runStamp(dir, regDb);
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /HAND_TUNED_REFUSED\s+- \*\*Reconcile/);
      assert.match(r.stderr, /DEGRADED/);
      assert.ok(r.stderr.includes(`${join(dir, 'bin', 'contract-history.json')} is missing`), r.stderr);
      assert.match(r.stderr, /only the current template text counts as template-descended/);
      assert.equal(readFileSync(join(sibling, 'CLAUDE.md'), 'utf8'), before);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('the generated contract history is byte-identical before and after committing a template edit, and holds the old block but not the current one', () => {
  const dir = makePluginRoot();
  try {
    writeFileSync(join(dir, CLAUDE_REL), realTemplate(CLAUDE_REL));
    const beforeCommit = contractHistoryJson(dir);
    git(dir, ['add', 'templates']);
    git(dir, ['commit', '-q', '-m', 'current templates']);
    const afterCommit = contractHistoryJson(dir);
    assert.equal(afterCommit, beforeCommit);
    assert.ok(afterCommit.endsWith('}\n'), 'trailing newline');
    const parsed = JSON.parse(afterCommit);
    assert.deepEqual(Object.keys(parsed), Object.keys(parsed).sort(), 'keys sorted');
    assert.ok(parsed[RECONCILE_LEAD].includes(STALE_RECONCILE), 'the committed older block is in the snapshot');
    assert.ok(!parsed[RECONCILE_LEAD].includes(currentReconcile()), 'the current block is subtracted');
    assert.ok(Object.hasOwn(parsed, "- **Notes are the user's surface.**"), 'a renamed lead\'s OLD lead is a key too');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

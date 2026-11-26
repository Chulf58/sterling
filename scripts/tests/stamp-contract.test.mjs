// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// the former ruling 'agents-md-is-the-instructions-file-claude-md-is-a-one-line-import' (not in the current store)): each TARGET_LEADS bullet propagates into whichever template CURRENTLY carries
// it — AGENTS.md for a tool-agnostic lead, CLAUDE.md for a Sterling-bound one — and a sibling
// lacking AGENTS.md entirely is reported not_migrated rather than partially patched.
// Since GitHub #329 the Sterling layer is a generated section of AGENTS.md: stamp-contract never
// reads or writes CLAUDE.md or GEMINI.md, does not stamp the target-claude-md.md leads anywhere,
// and stamps only AGENTS.md text outside the generated section. Tests that pinned CLAUDE.md
// stamping now pin that it stays byte-identical; the generic mechanics run on AGENTS.md leads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, lstatSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';
import { renderClaudeText } from '../lib/agent-fences.mjs';
import { AGENTS_TEMPLATE_REL, INSERT_AFTER, SUBJECT_MARKERS, TARGET_LEADS, TARGET_SECTIONS, findCoveringBullet, readTemplateBullets } from '../lib/contract-bullets.mjs';
import { LAYER_END, readLayerSection, syncLayer } from '../lib/sterling-layer.mjs';
import { stampFailures, stampResultFailures } from '../lib/stamp-outcome.mjs';
import { stampProjects, stampRefusalCount, stampResultLines } from '../lib/stamp-projects.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { leadLayer } = readTemplateBullets(root);
const AGENTS_HOMED = (lead) => leadLayer.get(lead) === AGENTS_TEMPLATE_REL;

function runStampContract(regDb, args = ['--apply', '--verbose']) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'stamp-contract.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, STERLING_REGISTRY_DB: regDb },
  });
}

// A COMPLETE, in-sync sibling pair: literally the current templates, rendered — every
// TARGET_LEADS bullet is present, in its correct home file, with today's exact wording, since
// that IS what the templates contain. Building it by rendering the real templates (not typing
// bullet text by hand) is what proves the fixture stays complete as TARGET_LEADS grows.
function renderTemplate(rel, projectName) {
  // CLAUDE.md is the template's Claude render (decision sterling-layer-is-one-source-with-host-blocks).
  return renderClaudeText(readFileSync(join(root, rel), 'utf8'), rel)
    .replaceAll('{{PROJECT_NAME}}', projectName)
    .replaceAll('{{STACK_TAGS}}', 'node')
    .replaceAll('{{TOOLCHAINS}}', 'node (**/*.mjs)')
    .replaceAll('{{LINT_COMMAND}}', 'not recorded yet; add it here')
    .replaceAll('{{DOMAINS}}', '~/.sterling/domains/node/ — created lazily on first need (§2.3)')
    .replaceAll('{{BACKUP_PATH}}', '(opted out — recorded)')
    .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
}
function writeCompleteSibling(dir, projectName) {
  writeFileSync(join(dir, 'AGENTS.md'), renderTemplate('templates/target-agents-md.md', projectName));
  writeFileSync(join(dir, 'CLAUDE.md'), renderTemplate('templates/target-claude-md.md', projectName));
}

test('stamp-contract: an AGENTS.md-homed lead is updated in AGENTS.md (ancestry followed across the split from its pre-split home in target-claude-md.md), a stale CLAUDE.md-homed lead in CLAUDE.md is left byte-identical, and a sibling lacking AGENTS.md is not_migrated (nothing written for it)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const migratedDir = mkdtempSync(join(tmpdir(), 'sterling-stamp-migrated-'));
  const legacyDir = mkdtempSync(join(tmpdir(), 'sterling-stamp-legacy-'));
  const registry = new ProjectRegistry(regDb);
  try {
    // A genuine OLDER historical wording of the Anti-speculation bullet, from when it lived only
    // in templates/target-claude-md.md, before the split moved its CURRENT home to
    // target-agents-md.md — this sibling's AGENTS.md carries that STALE, template-descended
    // block. A clean replace here proves historical ancestry is followed ACROSS the two files.
    const staleAntiSpec = '- **Anti-speculation:** never invent an API, field, flag, or behavior. Verify in docs or code first. If you cannot verify, say so and ask.';
    writeFileSync(join(migratedDir, 'AGENTS.md'), `# AGENTS.md\n\n## Conduct rules\n\n${staleAntiSpec}\n`);
    // A genuine historical (git-committed, commit dc366720) wording of the Reconcile bullet, a
    // CLAUDE.md-homed lead — proves a Sterling-bound lead propagates into CLAUDE.md, not AGENTS.md.
    const staleReconcile = '- **Reconcile _every affected_ article, not just the primary one** — the article owning the touched files, and any whose behavior or dependencies the change invalidates (follow `relies_on` / `relied_by`). New features get a new owning article; renames rewrite `file_keys` so knowledge is never orphaned.';
    writeFileSync(join(migratedDir, 'CLAUDE.md'), `@AGENTS.md\n\n# CLAUDE.md\n\n## Reconcile-always\n\n${staleReconcile}\n`);

    // A pre-split sibling: only a legacy CLAUDE.md, no AGENTS.md at all.
    writeFileSync(join(legacyDir, 'CLAUDE.md'), '# CLAUDE.md\n\n(pre-split project, never migrated)\n');

    const at = new Date().toISOString();
    registry.register({ repo_path: migratedDir, name: 'stamp-migrated', stack_tags: [], toolchains: [], sterling_version: null, at });
    registry.register({ repo_path: legacyDir, name: 'stamp-legacy', stack_tags: [], toolchains: [], sterling_version: null, at });

    const r = runStampContract(regDb);

    const agentsMdAfter = readFileSync(join(migratedDir, 'AGENTS.md'), 'utf8');
    assert.ok(
      agentsMdAfter.includes('- **Anti-speculation:** never invent an API, field, flag, or behavior; cite tool-call evidence from this turn, or say "I don\'t know, checking" and check.'),
      `AGENTS.md-homed lead updated in AGENTS.md with the CURRENT template text:\n${agentsMdAfter}`,
    );
    assert.ok(!agentsMdAfter.includes(staleAntiSpec), 'stale text replaced, not appended alongside');

    const claudeMdAfter = readFileSync(join(migratedDir, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeMdAfter, `@AGENTS.md\n\n# CLAUDE.md\n\n## Reconcile-always\n\n${staleReconcile}\n`, 'CLAUDE.md is read-only to stamp-contract (#329): its stale CLAUDE.md-homed bullet stays as it was');
    assert.ok(!/CLAUDE\.md/.test(r.stdout.split('\n').filter((l) => /^\s{4}\S/.test(l)).join('\n')), `no action names CLAUDE.md:\n${r.stdout}`);

    assert.equal(r.status, 2, 'a not_migrated sibling counts as a refusal — exit 2');
    assert.match(r.stdout, /not_migrated.*run: node "<Sterling root>\/bin\/init\.mjs" --target/,'the legacy sibling (no AGENTS.md) is reported not_migrated, naming the ensure command');
    // Review loop 5 of #329: the one classifier /sterling:update and the post-update sync share
    // reads the legacy sibling as a failed stamp, and only for that project.
    const legacyFailures = stampFailures(r.stdout, join(legacyDir, 'AGENTS.md'));
    assert.equal(legacyFailures.length, 1, r.stdout);
    assert.match(legacyFailures[0], /^not_migrated — no AGENTS\.md — run: node /);
    assert.deepEqual(stampFailures(r.stdout, join(migratedDir, 'AGENTS.md')), [], 'the migrated sibling is not failed by its neighbour');
    // legacy sibling untouched — no CLAUDE.md write, no AGENTS.md guessed into existence
    assert.equal(readFileSync(join(legacyDir, 'CLAUDE.md'), 'utf8'), '# CLAUDE.md\n\n(pre-split project, never migrated)\n', 'not_migrated sibling: nothing written');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(migratedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a COMPLETE, in-sync sibling (every TARGET_LEADS bullet, in its right home, today\'s wording) exits 0 with nothing to fix', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-clean-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'clean-sibling');
    const before = { agents: readFileSync(join(dir, 'AGENTS.md'), 'utf8'), claude: readFileSync(join(dir, 'CLAUDE.md'), 'utf8') };
    registry.register({ repo_path: dir, name: 'clean-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `a fully in-sync sibling must exit 0: ${r.stdout}\n${r.stderr}`);
    assert.ok(!/REFUSED/.test(r.stdout), 'no refusal on a clean sibling');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), before.agents, 'nothing to write — byte-identical');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), before.claude, 'nothing to write — byte-identical');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a target-claude-md.md bullet present in both AGENTS.md project text and CLAUDE.md is neither refused nor touched (#329: those leads are not stamped) — exit 0, both files byte-identical', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-dup-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'dup-sibling');
    // Plant a SECOND copy of a CLAUDE.md-homed bullet (Reconcile) inside AGENTS.md too — the
    // home file (CLAUDE.md) still has its own copy, so this is a TRUE duplicate.
    const reconcileBlock = "- **Reconcile _every affected_ article, not just the primary one** — the owner of the touched files (`what_it_does`, acceptance criteria, `files[]`, a history entry) **and** any article whose described behavior or dependencies the change invalidates; follow `relies_on` / `relied_by`. New features get a new owning article; renames rewrite `file_keys` so knowledge is never orphaned.";
    const agentsBefore = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeBefore = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeBefore.includes(reconcileBlock), 'fixture sanity: the home file already carries this bullet — this IS the true-duplicate shape');
    writeFileSync(join(dir, 'AGENTS.md'), `${agentsBefore}\n${reconcileBlock}\n`);
    const agentsPlanted = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    registry.register({ repo_path: dir, name: 'dup-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `the layer leads are not stamped, so there is nothing to refuse:\n${r.stdout}`);
    assert.ok(!/DUPLICATE_REFUSED|WRONG_LAYER_REFUSED/.test(r.stdout), `no layer refusal for a lead the layer section owns:\n${r.stdout}`);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), agentsPlanted, 'AGENTS.md untouched — no second copy written on top of the planted one');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claudeBefore, 'CLAUDE.md untouched — the home file never got an inserted/renamed copy either');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a target-claude-md.md bullet present only in AGENTS.md project text (none in CLAUDE.md) is neither refused nor moved (#329) — exit 0, both files byte-identical', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-wronglayer-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'wronglayer-sibling');
    // Move a CLAUDE.md-homed bullet (Reconcile) OUT of its home file and INTO AGENTS.md instead —
    // present ONLY in the wrong layer, absent from its rightful home.
    const reconcileBlock = "- **Reconcile _every affected_ article, not just the primary one** — the owner of the touched files (`what_it_does`, acceptance criteria, `files[]`, a history entry) **and** any article whose described behavior or dependencies the change invalidates; follow `relies_on` / `relied_by`. New features get a new owning article; renames rewrite `file_keys` so knowledge is never orphaned.";
    const agentsBefore = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeWithout = readFileSync(join(dir, 'CLAUDE.md'), 'utf8').replace(`${reconcileBlock}\n`, '');
    assert.notEqual(claudeWithout, readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'fixture sanity: the removal actually took the bullet out of its home file');
    writeFileSync(join(dir, 'CLAUDE.md'), claudeWithout);
    writeFileSync(join(dir, 'AGENTS.md'), `${agentsBefore}\n${reconcileBlock}\n`);
    const agentsPlanted = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    registry.register({ repo_path: dir, name: 'wronglayer-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `the layer leads are not stamped, so there is nothing to refuse:\n${r.stdout}`);
    assert.ok(!/DUPLICATE_REFUSED|WRONG_LAYER_REFUSED/.test(r.stdout), `no layer refusal for a lead the layer section owns:\n${r.stdout}`);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), agentsPlanted, 'AGENTS.md untouched — byte-identical');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claudeWithout, 'CLAUDE.md untouched — no insert/rename recreated it in the home file either — byte-identical');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: hand-tuned text (matches no template version, current or historical) is HAND_TUNED_REFUSED — file untouched, exit 2', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-handtuned-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'handtuned-sibling');
    // An AGENTS.md-homed lead: stamp-contract stamps only AGENTS.md (#329).
    const claudeBefore = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const agentsBefore = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const handTuned = agentsBefore.replace(
      /- \*\*Anti-speculation:\*\*[^\n]*/,
      '- **Anti-speculation:** This project tunes the rest of the rule its own hand-edited way, never matching any shipped wording.',
    );
    assert.notEqual(handTuned, agentsBefore, 'fixture sanity: the replace actually matched something');
    writeFileSync(join(dir, 'AGENTS.md'), handTuned);
    registry.register({ repo_path: dir, name: 'handtuned-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 2, 'hand-tuned text is a refusal — exit 2');
    assert.match(r.stdout, /HAND_TUNED_REFUSED/);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), handTuned, 'hand-tuned text left byte-for-byte untouched');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claudeBefore, 'CLAUDE.md is never written');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a CRLF sibling gets a stale historical bullet updated, and the WHOLE file stays CRLF afterward (writes preserve the sibling\'s own EOL)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-crlf-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'crlf-sibling');
    // Plant a genuine OLDER historical wording of Anti-speculation (AGENTS.md-homed), then
    // convert the WHOLE file to CRLF, as a Windows-authored project's file would arrive.
    const staleAntiSpec = '- **Anti-speculation:** never invent an API, field, flag, or behavior. Verify in docs or code first. If you cannot verify, say so and ask.';
    const currentAntiSpec = '- **Anti-speculation:** never invent an API, field, flag, or behavior; cite tool-call evidence from this turn, or say "I don\'t know, checking" and check.';
    let agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8').replace(currentAntiSpec, staleAntiSpec);
    assert.ok(agents.includes(staleAntiSpec), 'fixture sanity: stale text planted');
    agents = agents.replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'AGENTS.md'), agents);
    const claudeCrlf = readFileSync(join(dir, 'CLAUDE.md'), 'utf8').replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'CLAUDE.md'), claudeCrlf);
    registry.register({ repo_path: dir, name: 'crlf-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `a clean historical replace is not a refusal: ${r.stdout}\n${r.stderr}`);
    const agentsAfter = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsAfter.includes(currentAntiSpec), 'the stale bullet was updated to the current wording');
    assert.ok(!/[^\r]\n/.test(agentsAfter), 'the WHOLE file is still CRLF — no bare LF survives, including in the newly-written bullet');
    assert.ok(agentsAfter.includes('\r\n'), 'still genuinely CRLF, not accidentally flattened to LF');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Changed in the #329 fix round: the clone's skip is now one named line, not silence, because ruling
// a-sterling-source-checkout-s-agents-md-is-hand-maintained-up requires a named skip for every
// Sterling source tree, the running clone included. It is still never read or written.
test('stamp-contract: realpath self-exclusion — this Sterling clone\'s own path, if registered, is one named skip and never read or written', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const registry = new ProjectRegistry(regDb);
  try {
    const selfAgentsBefore = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const selfClaudeBefore = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    registry.register({ repo_path: root, name: 'self', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, 'the self-excluded clone contributes no drift');
    const selfLines = r.stdout.split('\n').filter((l) => l.includes('self'));
    assert.deepEqual(selfLines, [`– self (${join(root, 'AGENTS.md')}): skipped — the Sterling clone running this stamp, whose instruction files are hand-maintained; nothing stamped`], 'the self project is one named skip line and nothing else');
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), selfAgentsBefore, 'this clone\'s own AGENTS.md untouched');
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), selfClaudeBefore, 'this clone\'s own CLAUDE.md untouched');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Codex is removed (decision decommission-the-codex-model-setting-codex-is-no-longer-used): the Codex
// bullet is gone from the template, so the insert/anchor/refuse cases below run on READY TO CLEAR alone, and
// the Codex-only cases (insert, chained insert, wrong-layer refusal) were deleted with the behaviour.
// The READY TO CLEAR bullet (commit 6661665) is NEW to every existing sibling, so it can only
// arrive through the insert path — the replace path needs a block to already be there.
const READY_LEAD = '- **Say `READY TO CLEAR` plainly when it is time.**';
function dropBlock(text, lead) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(lead));
  assert.notEqual(i, -1, `fixture sanity: '${lead}' present before removal`);
  lines.splice(i, 1);
  return lines.join('\n');
}

test('stamp-contract: a retained CLAUDE.md lacking the READY TO CLEAR bullet is left byte-identical and nothing is inserted (#329: host files are read-only), exit 0', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-ready-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'ready-sibling');
    const complete = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const planted = dropBlock(complete, READY_LEAD);
    writeFileSync(join(dir, 'CLAUDE.md'), planted);
    registry.register({ repo_path: dir, name: 'ready-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    for (const mode of [['--apply-inserts'], ['--apply', '--verbose']]) {
      const r = runStampContract(regDb, mode);
      assert.equal(r.status, 0, `${mode}: ${r.stdout}\n${r.stderr}`);
      assert.ok(!/READY TO CLEAR/.test(r.stdout), `${mode}: the layer bullet is not stamped:\n${r.stdout}`);
      assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), planted, `${mode}: CLAUDE.md byte-identical`);
    }
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Sol review of b41f29d..f32c48a (HIGH): an insert anchor must be the REAL top-level bullet (never
// a copy inside a fenced example), must itself have passed validation this run (never a refused,
// hand-tuned block), and the insert must land after the anchor's COMPLETE list item.
const KNOWLEDGE_LEAD = '- **Knowledge is born structured.**';
// stampFixture mutates AGENTS.md (the only file stamp-contract writes since #329); the anchor and
// insert mechanics run on the AGENTS.md pair "No false action claims" → "Lint and tests before done."
const ANCHOR_LEAD = '- **No false action claims:**';
const INSERT_LEAD = '- **Lint and tests before done.**';
const ANTISPEC_LEAD = '- **Anti-speculation:**';
function stampFixture(name, mutate) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
  const registry = new ProjectRegistry(regDb);
  writeCompleteSibling(dir, name);
  const complete = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  const { planted, expected } = mutate(complete);
  writeFileSync(join(dir, 'AGENTS.md'), planted);
  registry.register({ repo_path: dir, name, stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
  const cleanup = () => {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { regDb, agentsPath: join(dir, 'AGENTS.md'), claudePath: join(dir, 'CLAUDE.md'), claudeBefore: readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), planted, expected, cleanup };
}

test('stamp-contract: an exact No-false-action-claims bullet inside a fenced ``` example BEFORE the conduct section is never an anchor — the missing bullets land after the REAL one, and a second run changes nothing (idempotent)', () => {
  const f = stampFixture('fenced', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(ANCHOR_LEAD));
    const fence = `\n## Example\n\n\`\`\`md\n${knowledge}\n\`\`\`\n`;
    const [first, ...rest] = complete.split('\n');
    const withFence = [first, fence, ...rest].join('\n');
    return { planted: dropBlock(withFence, INSERT_LEAD), expected: withFence };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'both bullets restored after the REAL Knowledge bullet; the fenced example is untouched');
    const r2 = runStampContract(f.regDb);
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'second run leaves the file byte-identical');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a hand-tuned MULTI-PARAGRAPH anchor bullet (with Anti-speculation, its fallback, also hand-tuned) is refused AND never used as an anchor — the lint bullet is ANCHOR_MISSING_REFUSED, file byte-identical, exit 2', () => {
  const f = stampFixture('handtuned-anchor', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(ANCHOR_LEAD));
    const antiSpec = complete.split('\n').find((l) => l.startsWith(ANTISPEC_LEAD));
    const tuned = complete
      .replace(knowledge, `${ANCHOR_LEAD} This project words it its own way.\n\n  A second paragraph of the same hand-tuned item.`)
      .replace(antiSpec, `${ANTISPEC_LEAD} This project's own wording of the fallback anchor.`);
    const planted = dropBlock(tuned, INSERT_LEAD);
    return { planted, expected: planted };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /HAND_TUNED_REFUSED {2}- \*\*No false action claims/);
    assert.match(r.stdout, /ANCHOR_MISSING_REFUSED {2}- \*\*Lint and tests before done/);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the refused bullet is not restructured and nothing is inserted');
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.claudeBefore, 'CLAUDE.md is never written');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a valid anchor followed by a blank-separated indented continuation paragraph gets the insert after the WHOLE list item, and a second run changes nothing (idempotent)', () => {
  const f = stampFixture('continuation', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(ANCHOR_LEAD));
    const extra = '\n  A project-added paragraph under the anchor item.';
    // In the render the lint line directly follows the anchor, so here it follows the continuation.
    const withExtra = complete.replace(knowledge, `${knowledge}\n${extra}`);
    return { planted: dropBlock(withExtra, INSERT_LEAD), expected: withExtra };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the lint bullet lands after the continuation paragraph, never between the item and its continuation');
    const r2 = runStampContract(f.regDb);
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected);
  } finally {
    f.cleanup();
  }
});

// Sol re-check of af99713: fences close only on the SAME character with a run at least as long
// (CommonMark), and an indented fenced block is part of the list item it continues.
test('stamp-contract: a ``` example containing a ~~~ line, then an exact anchor bullet STILL inside the fence, is never an anchor — the bullets land after the REAL one', () => {
  const f = stampFixture('fence-mixed', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(ANCHOR_LEAD));
    const fence = `\n## Example\n\n\`\`\`md\n~~~\n${knowledge}\n\`\`\`\n`;
    const [first, ...rest] = complete.split('\n');
    const withFence = [first, fence, ...rest].join('\n');
    return { planted: dropBlock(withFence, INSERT_LEAD), expected: withFence };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'a ~~~ line does not close a ``` fence; the fenced copy stays untouched');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a valid anchor whose item continues with an INDENTED fenced code block gets the insert after that block, never re-parenting it under the new bullet', () => {
  const f = stampFixture('fence-continuation', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(ANCHOR_LEAD));
    // In the render the lint line directly follows the anchor, so here it follows the fenced block.
    const withBlock = complete.replace(knowledge, `${knowledge}\n\n  \`\`\`sh\n  echo example\n\n  - not a bullet\n  \`\`\``);
    return { planted: dropBlock(withBlock, INSERT_LEAD), expected: withBlock };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the lint bullet lands after the closing fence of the item\'s code block');
    const r2 = runStampContract(f.regDb);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected);
  } finally {
    f.cleanup();
  }
});

const SOLVE_LEAD = "- **Solve, don't board.**";
const CLOSE_LEAD = '- **Close-on-commit: a commit that fulfils a board item pays it**';
// Solve and Close-on-commit are target-claude-md.md leads, no longer stamped (#329); the same
// RENAMED_LEADS guard is pinned on the AGENTS.md background bullet's old lead.
test('stamp-contract: a hand-tuned bullet under the background bullet\'s OLD lead is recognised through RENAMED_LEADS — refused as hand-tuned, never given a duplicate under the new lead, file byte-identical, exit 2', () => {
  const f = stampFixture('old-background-lead', (complete) => {
    const lines = complete.split('\n');
    const at = lines.findIndex((l) => l.startsWith('- **Start every subagent and every long shell command in the background.**'));
    assert.ok(at >= 0, 'fixture sanity: the render carries the new lead');
    lines[at] = '- **Start every subagent in the background.** Our own wording, which no template version ever used.';
    const planted = lines.join('\n');
    return { planted, expected: planted };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /HAND_TUNED_REFUSED\s+- \*\*Start every subagent and every long shell command/);
    assert.ok(!/inserted|would_insert/.test(r.stdout), `no insert beside an old-lead bullet:\n${r.stdout}`);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the old-lead bullet is left byte-for-byte untouched');
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.claudeBefore, 'CLAUDE.md is never written');
  } finally {
    f.cleanup();
  }
});

const REPORT_LEAD = '- **Report Sterling defects to its GitHub issues without asking.**';
const OLD_REPORT_LEAD = "- **Stamp Sterling's version when reporting on Sterling.**";

test('stamp-contract: a retained CLAUDE.md with the report bullet under its OLD lead is neither reported nor touched by --apply-inserts or --apply (#329: host files are read-only)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-old-report-lead-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'old-report-lead');
    const lines = readFileSync(join(dir, 'CLAUDE.md'), 'utf8').split('\n');
    const at = lines.findIndex((l) => l.startsWith(REPORT_LEAD));
    assert.ok(at >= 0, 'fixture sanity: the render carries the new lead');
    lines[at] = lines[at].replace(REPORT_LEAD, OLD_REPORT_LEAD);
    const planted = lines.join('\n');
    writeFileSync(join(dir, 'CLAUDE.md'), planted);
    const agentsBefore = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    registry.register({ repo_path: dir, name: 'old-report-lead', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    for (const mode of [['--apply-inserts'], ['--apply']]) {
      const r = runStampContract(regDb, mode);
      assert.equal(r.status, 0, `${mode}: ${r.stdout}\n${r.stderr}`);
      assert.ok(!/Report Sterling defects/.test(r.stdout), `${mode}: the layer bullet is not stamped:\n${r.stdout}`);
      assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), planted, `${mode}: CLAUDE.md byte-identical`);
      assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), agentsBefore, `${mode}: AGENTS.md gains no copy of a layer bullet`);
    }
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// ---- the Domains section (TARGET_SECTIONS in scripts/lib/contract-bullets.mjs) ----
// An AGENTS.md written before the section existed gets the whole section, heading included,
// ahead of its Conventions heading; after that its bullets are ordinary tracked leads.

const DOMAINS_SECTION = /## Domains\n[\s\S]*?(?=## Conventions)/;
const DOMAIN_DESCRIPTION_LEAD = '- **A domain needs a description**';

function sectionFixture(name, mutateAgents, mutateClaude = (text) => text) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
  writeCompleteSibling(dir, name);
  const complete = { agents: readFileSync(join(dir, 'AGENTS.md'), 'utf8'), claude: readFileSync(join(dir, 'CLAUDE.md'), 'utf8') };
  assert.match(complete.agents, DOMAINS_SECTION, 'fixture sanity: the rendered template carries the Domains section');
  writeFileSync(join(dir, 'AGENTS.md'), mutateAgents(complete.agents));
  writeFileSync(join(dir, 'CLAUDE.md'), mutateClaude(complete.claude));
  const registry = new ProjectRegistry(regDb);
  try {
    registry.register({ repo_path: dir, name, stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
  } finally {
    registry.close();
  }
  const read = () => ({ agents: readFileSync(join(dir, 'AGENTS.md'), 'utf8'), claude: readFileSync(join(dir, 'CLAUDE.md'), 'utf8') });
  const cleanup = () => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { regDb, dir, complete, read, cleanup };
}

test('stamp-contract: an AGENTS.md with no Domains section gains the whole section before Conventions; a dry run writes nothing and a second run changes nothing', () => {
  const f = sectionFixture('no-domains', (agents) => agents.replace(DOMAINS_SECTION, ''));
  try {
    const before = f.read();
    assert.ok(!before.agents.includes('## Domains'), 'fixture sanity: the section is gone');

    const dry = runStampContract(f.regDb, []);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /would_insert_section {2}## Domains/);
    assert.deepEqual(f.read(), before, 'a dry run writes nothing');

    const applied = runStampContract(f.regDb);
    assert.equal(applied.status, 0, `inserting the section is not a refusal: ${applied.stdout}\n${applied.stderr}`);
    assert.match(applied.stdout, /section_inserted {2}## Domains/);
    assert.deepEqual(f.read(), f.complete, 'the result is byte-identical to the current template render; CLAUDE.md is untouched');

    const again = runStampContract(f.regDb);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted|updated|renamed/.test(again.stdout), `a second run has nothing to do:\n${again.stdout}`);
    assert.deepEqual(f.read(), f.complete, 'a second run changes nothing');
  } finally {
    f.cleanup();
  }
});

// Review loop 7 of #329: a second registered Sterling checkout (not the one running stamp-contract)
// has hand-maintained instruction files too, so it gets no automatic insert; it is named on one
// skip line that is not a refusal and not a failure for the shared classifier.
test('stamp-contract: a second registered Sterling source checkout gets no insert — AGENTS.md byte-identical, one skip line, exit 0', () => {
  const f = sectionFixture('second-checkout', (agents) => agents.replace(DOMAINS_SECTION, ''));
  try {
    mkdirSync(join(f.dir, '.claude-plugin'));
    writeFileSync(join(f.dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling' }));
    mkdirSync(join(f.dir, 'scripts'));
    writeFileSync(join(f.dir, 'scripts', 'architecture-projection.mjs'), '');
    const before = f.read();
    assert.ok(!before.agents.includes('## Domains'), 'fixture sanity: an insert would be due in an ordinary project');
    for (const args of [['--apply-inserts'], ['--apply-inserts', '--project', f.dir]]) {
      const r = runStampContract(f.regDb, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /^– second-checkout \(.*AGENTS\.md\): skipped — a Sterling source tree, whose instruction files are hand-maintained; nothing stamped$/m);
      assert.doesNotMatch(r.stdout, /section_inserted|^✗/m);
      assert.deepEqual(stampFailures(r.stdout, join(f.dir, 'AGENTS.md')), []);
      assert.deepEqual(f.read(), before, 'nothing written');
    }
  } finally {
    f.cleanup();
  }
});

// Review loop 7 of #329: a registered path that no longer exists is a stale registry entry, not a
// failure of the run: one explicit skip line, no ✗ refusal line, exit 0, nothing for the classifier.
test('stamp-contract: a stale registry entry (path gone) beside a healthy project is one skip line, never a refusal', () => {
  const f = sectionFixture('healthy', (agents) => agents);
  const gone = join(tmpdir(), `sterling-stamp-gone-${process.pid}-${Date.now()}`);
  try {
    const registry = new ProjectRegistry(f.regDb);
    try {
      registry.register({ repo_path: gone, name: 'stale', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    } finally {
      registry.close();
    }
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^– stale \(.*AGENTS\.md\): skipped — the registered path does not exist \(a stale registry entry\); nothing stamped$/m);
    assert.doesNotMatch(r.stdout, /^✗/m, 'no refusal line');
    assert.deepEqual(stampFailures(r.stdout, join(gone, 'AGENTS.md')), []);
    assert.deepEqual(stampFailures(r.stdout), []);
    assert.deepEqual(f.read(), f.complete, 'the healthy project is in sync and untouched');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: an AGENTS.md that already has the Domains section (a newer init wrote it) is left byte-identical', () => {
  const f = sectionFixture('has-domains', (agents) => agents);
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!/section/.test(r.stdout), 'no section action on a file that has the heading');
    assert.deepEqual(f.read(), f.complete);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a Domains bullet is a tracked lead: hand-tuned text is HAND_TUNED_REFUSED and untouched, and a deleted bullet comes back in template order', () => {
  const tuned = sectionFixture('tuned-domains', (agents) => agents.replace(/^- \*\*A domain needs a description\*\*.*$/m, `${DOMAIN_DESCRIPTION_LEAD} and we write ours in Danish.`));
  try {
    const before = tuned.read();
    assert.notEqual(before.agents, tuned.complete.agents, 'fixture sanity: the bullet was changed');
    const r = runStampContract(tuned.regDb);
    assert.equal(r.status, 2, 'hand-tuned text is drift');
    assert.match(r.stdout, /HAND_TUNED_REFUSED {2}- \*\*A domain needs a description\*\*/);
    assert.deepEqual(tuned.read(), before, 'nothing written');
  } finally {
    tuned.cleanup();
  }

  const dropped = sectionFixture('dropped-domain-bullet', (agents) => dropBlock(agents, DOMAIN_DESCRIPTION_LEAD));
  try {
    assert.ok(!dropped.read().agents.includes(DOMAIN_DESCRIPTION_LEAD), 'fixture sanity: the bullet is gone');
    const r = runStampContract(dropped.regDb);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*A domain needs a description\*\*/);
    assert.deepEqual(dropped.read(), dropped.complete, 'the bullet is back where the template has it');
  } finally {
    dropped.cleanup();
  }
});

test('stamp-contract: no Domains section and no Conventions heading to put it before is one loud refusal, with nothing written', () => {
  const f = sectionFixture('no-conventions', (agents) => agents.replace(DOMAINS_SECTION, '').replace(/^## Conventions.*$/m, '## House rules'));
  try {
    const before = f.read();
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 2, `a section with nowhere to go is drift, never a silent skip: ${r.stdout}`);
    assert.match(r.stdout, /SECTION_ANCHOR_MISSING_REFUSED {2}## Domains/);
    assert.match(r.stdout, /no '## Conventions' heading/);
    assert.equal((r.stdout.match(/REFUSED {2}/g) ?? []).length, 1, `one refusal for the section, not one per bullet:\n${r.stdout}`);
    assert.deepEqual(f.read(), before, 'nothing written');
  } finally {
    f.cleanup();
  }
});

// ---- --apply-inserts: what /sterling:update and the post-update sync run (user-ruled
// 2026-10-04, "Auto-insert, new text only") ----

const STALE_ANTI_SPEC = '- **Anti-speculation:** never invent an API, field, flag, or behavior. Verify in docs or code first. If you cannot verify, say so and ask.';
const withStaleAntiSpec = (agents) => agents.replace(/^- \*\*Anti-speculation:\*\*.*$/m, STALE_ANTI_SPEC);

test('stamp-contract --apply-inserts: text that is entirely absent is written, old wording is only reported, and a second run writes nothing', () => {
  const f = sectionFixture('inserts-only', (agents) => withStaleAntiSpec(agents).replace(DOMAINS_SECTION, ''));
  try {
    const expected = { agents: withStaleAntiSpec(f.complete.agents), claude: f.complete.claude };
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /section_inserted {2}## Domains/);
    assert.match(r.stdout, /would_update {2}- \*\*Anti-speculation:\*\*/, 'a replace is reported exactly as the dry run reports it');
    assert.match(r.stdout, /INSERTS APPLIED/);
    assert.deepEqual(f.read(), expected, 'the section is in; the old-wording bullet is byte-for-byte what it was');

    const again = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted/.test(again.stdout), `nothing left to insert:\n${again.stdout}`);
    assert.deepEqual(f.read(), expected, 'a second run writes nothing');

    const full = runStampContract(f.regDb, ['--apply']);
    assert.equal(full.status, 0, `${full.stdout}\n${full.stderr}`);
    assert.deepEqual(f.read(), f.complete, 'the by-hand --apply is what replaces old wording');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a missing tracked bullet is inserted too', () => {
  const f = sectionFixture('inserts-bullet', (agents) => dropBlock(agents, DOMAIN_DESCRIPTION_LEAD));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*A domain needs a description\*\*/);
    assert.deepEqual(f.read(), f.complete);
  } finally {
    f.cleanup();
  }
});

// ---- lint and tests before done (2026-10-05) ----
// The bullet is new to every existing project, so it arrives through the insert path, after
// "No false action claims". The same change removed two untracked bullets from the template;
// stamp-contract never deletes, so a project that has them keeps them and hears nothing.

const LINT_LEAD = '- **Lint and tests before done.**';
const WRITE_PLAINLY_LEAD = '- **Write plainly; no AI tells.**';
const COPY_LEAD = '- **Text meant to be copied goes between two horizontal rules.**';
const BACKGROUND_LEAD = '- **Start every subagent and every long shell command in the background.**';
const OLD_BACKGROUND_LEAD = '- **Start every subagent in the background.**';
const OLD_NAMING = '- **Canonical naming:** one name per concept, from the registries; no dead terms.';
const OLD_EXIT_CODE = "- **A toolchain-invoked process's exit code can read as a crash when the real cause is a missing required flag.** Some test/build runners exit with an unfamiliar non-zero code when a required headless/CI-mode flag is omitted, rather than failing informatively — check the runner's own headless/CI documentation before treating a red run as a real regression.";

test('the AGENTS.md template and this repo\'s AGENTS.md both tell agents to start every subagent in the background', () => {
  for (const file of [join('templates', 'target-agents-md.md'), 'AGENTS.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    const bullet = text.split('\n').find((l) => l.startsWith(BACKGROUND_LEAD));
    assert.ok(bullet, `${file} carries the background-subagents bullet`);
    assert.ok(bullet.includes('`background: true`'), `${file} names the OpenCode flag`);
  }
});

test('the AGENTS.md template and this repo\'s AGENTS.md put long shell commands in the background and forbid foreground sleep polling, in the same sentence', () => {
  const bullets = [join('templates', 'target-agents-md.md'), 'AGENTS.md'].map((file) => {
    const bullet = readFileSync(join(root, file), 'utf8').split('\n').find((l) => l.startsWith(BACKGROUND_LEAD));
    assert.ok(bullet, `${file} carries the background bullet`);
    assert.match(bullet, /more than about 20 seconds/, `${file} names the threshold`);
    assert.match(bullet, /Never wait with a foreground \`sleep\`/, `${file} forbids foreground sleep polling`);
    assert.match(bullet, /\`dotnet test\`.*\`pr-review-wait\`.*\`gh run watch\`/, `${file} lists the long commands`);
    assert.match(bullet, /a lane waiting on its own targeted test result runs it in the foreground/, `${file} keeps the lane exception`);
    assert.match(bullet, /why-do-customer-hub-ch-conductors-sit-waiting-while-shells-r/, `${file} cites the finding`);
    return bullet;
  });
  assert.equal(bullets[0], bullets[1], 'the template and AGENTS.md carry the identical bullet');
});

test('the conductor template tells the conductor to background shells over about 20 seconds and never sleep-poll in the foreground', () => {
  const text = readFileSync(join(root, 'agent-templates', 'conductor.md'), 'utf8');
  assert.match(text, /^- Run any shell command expected to take more than about 20 seconds .*never wait in the foreground with \`sleep\`/m);
});

test('the AGENTS.md template carries the lint/format fact line and the lint bullet, and neither removed bullet', () => {
  const template = readFileSync(join(root, 'templates', 'target-agents-md.md'), 'utf8');
  assert.match(template, /^- Lint\/format command: \{\{LINT_COMMAND\}\}$/m);
  const bullet = template.split('\n').find((l) => l.startsWith(LINT_LEAD));
  assert.ok(bullet, 'the lint bullet is in the template');
  assert.match(bullet, /Red lint is a blocker, not a note\./);
  assert.match(bullet, /If no lint\/format command is recorded, say so in the report, and once you know the command add a `Lint\/format command:` line under Project facts\./);
  assert.ok(!template.includes('- **Canonical naming:**'), 'the naming bullet is gone');
  assert.ok(!template.includes('exit code can read as a crash'), 'the exit-code bullet is gone');
});

test('stamp-contract: a project that still has the two bullets removed from the template keeps them byte for byte, and no mode reports them', () => {
  const withOld = (agents) => agents.replace(/^- \*\*Never ship:\*\*.*$/m, (line) => `${OLD_NAMING}\n${line}\n${OLD_EXIT_CODE}`);
  const f = sectionFixture('old-bullets', withOld);
  try {
    const expected = { agents: withOld(f.complete.agents), claude: f.complete.claude };
    assert.ok(expected.agents.includes(OLD_NAMING) && expected.agents.includes(OLD_EXIT_CODE), 'fixture sanity: both old bullets are in the file');
    for (const args of [['--verbose'], ['--apply-inserts', '--verbose'], ['--apply', '--verbose']]) {
      const r = runStampContract(f.regDb, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /Canonical naming|toolchain-invoked|REFUSED|inserted|would_/, `${args.join(' ')} says nothing about them`);
      assert.deepEqual(f.read(), expected, `${args.join(' ')} leaves both files as they were`);
    }
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a project without the lint bullet gets it once, after "No false action claims", and a second run writes nothing', () => {
  const f = sectionFixture('lint-bullet', (agents) => dropBlock(agents, LINT_LEAD));
  try {
    const dry = runStampContract(f.regDb, []);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /would_insert {2}- \*\*Lint and tests before done\.\*\*/);
    assert.ok(!f.read().agents.includes(LINT_LEAD), 'a dry run writes nothing');

    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*Lint and tests before done\.\*\*/);
    assert.deepEqual(f.read(), f.complete, 'the bullet is in its template position and nothing else changed');

    const again = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted/.test(again.stdout), `nothing left to insert:\n${again.stdout}`);
    assert.deepEqual(f.read(), f.complete, 'a second run writes nothing');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: an AGENTS.md with the background bullet under its OLD subagents-only lead is reported would_rename by --apply-inserts (untouched), and --apply replaces it in place once with the shell-command wording; a second --apply writes nothing', () => {
  const history = JSON.parse(readFileSync(join(root, 'bin', 'contract-history.json'), 'utf8'))[OLD_BACKGROUND_LEAD];
  const oldBlock = history?.find((b) => b.includes('run_in_background'));
  assert.ok(oldBlock, 'fixture sanity: a historical block under the old lead, from before the shell-command wording');
  assert.ok(!oldBlock.includes('foreground `sleep`'), 'fixture sanity: the old block has no sleep rule');
  const f = sectionFixture('old-background-lead', (agents) => {
    const lines = agents.split('\n');
    const at = lines.findIndex((l) => l.startsWith(BACKGROUND_LEAD));
    assert.notEqual(at, -1, 'fixture sanity: the render carries the new lead');
    lines[at] = oldBlock;
    return lines.join('\n');
  });
  try {
    const planted = f.read().agents;
    const inserts = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(inserts.status, 0, `${inserts.stdout}\n${inserts.stderr}`);
    assert.match(inserts.stdout, /would_rename {2}- \*\*Start every subagent and every long shell command in the/);
    assert.equal(f.read().agents, planted, 'the old block is kept byte for byte by the inserts mode');

    const r = runStampContract(f.regDb, ['--apply']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /renamed {2}- \*\*Start every subagent and every long shell command in the/);
    assert.deepEqual(f.read(), f.complete, 'the old bullet became the current bullet, in place, and nothing else changed');
    assert.ok(!f.read().agents.includes(OLD_BACKGROUND_LEAD), 'no bullet under the old lead');

    const again = runStampContract(f.regDb, ['--apply']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.deepEqual(f.read(), f.complete, 'a second run writes nothing');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a project without the background-subagents bullet gets it once, right after the copy-friendly-text bullet, and a second run writes nothing', () => {
  const f = sectionFixture('background-bullet', (agents) => dropBlock(agents, BACKGROUND_LEAD));
  try {
    assert.ok(!f.read().agents.includes(BACKGROUND_LEAD), 'the fixture lacks the bullet');
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*Start every subagent and every long shell command in the/);
    assert.deepEqual(f.read(), f.complete, 'the bullet is in its template position and nothing else changed');
    const lines = f.read().agents.split('\n');
    assert.equal(lines.filter((l) => l.startsWith(BACKGROUND_LEAD)).length, 1, 'inserted once');
    const at = lines.findIndex((l) => l.startsWith(BACKGROUND_LEAD));
    assert.ok(lines[at - 1].startsWith(COPY_LEAD), 'right after the copy-friendly-text bullet, which follows the plain-writing bullet');

    const again = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted/.test(again.stdout), `nothing left to insert:\n${again.stdout}`);
    assert.deepEqual(f.read(), f.complete, 'a second run writes nothing');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a project missing both the plain-writing and the lint bullet gets them back in template order', () => {
  const f = sectionFixture('lint-and-plain', (agents) => dropBlock(dropBlock(agents, LINT_LEAD), WRITE_PLAINLY_LEAD));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(f.read(), f.complete);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a project that keeps the lint bullet but lacks plain-writing and background-subagents gets them in template order (lint, plain-writing, background), and a second run writes nothing', () => {
  const f = sectionFixture('lint-kept', (agents) => dropBlock(dropBlock(agents, WRITE_PLAINLY_LEAD), BACKGROUND_LEAD));
  try {
    assert.ok(f.read().agents.includes(LINT_LEAD), 'the fixture keeps the lint bullet');
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const lines = f.read().agents.split('\n');
    const at = (lead) => lines.findIndex((l) => l.startsWith(lead));
    assert.ok(at(LINT_LEAD) < at(WRITE_PLAINLY_LEAD) && at(WRITE_PLAINLY_LEAD) < at(BACKGROUND_LEAD), 'template order: lint, plain-writing, background');
    assert.deepEqual(f.read(), f.complete, 'byte-identical to the template render');

    const again = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted/.test(again.stdout), `nothing left to insert:\n${again.stdout}`);
    assert.deepEqual(f.read(), f.complete, 'a second run writes nothing');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: every partial absence of lint, plain-writing and background-subagents lands back in template order', () => {
  const leads = [LINT_LEAD, WRITE_PLAINLY_LEAD, BACKGROUND_LEAD];
  for (let mask = 1; mask < 8; mask++) {
    const dropped = leads.filter((_, i) => mask & (1 << i));
    const f = sectionFixture(`partial-${mask}`, (agents) => dropped.reduce((text, lead) => dropBlock(text, lead), agents));
    try {
      const r = runStampContract(f.regDb, ['--apply-inserts']);
      assert.equal(r.status, 0, `${dropped.join(' + ')}: ${r.stdout}\n${r.stderr}`);
      assert.deepEqual(f.read(), f.complete, `dropping ${dropped.join(' + ')} comes back in template order`);
    } finally {
      f.cleanup();
    }
  }
});

// GitHub issues #79 (finish what you start) and #42/#78 (resolve review threads): two bullets new
// to every sibling, inserted after the background-subagents bullet in template order.
const FINISH_LEAD = '- **Finish what you start.**';
const COMMENTS_LEAD = "- **Write self-explanatory code; comment only what the code can't say.**";
const RESOLVE_LEAD = '- **Resolve a review thread once its finding is handled.**';

test('stamp-contract --apply-inserts: a project without the finish and resolve bullets gets both once, after the background bullet in template order, and a second run writes nothing', () => {
  const f = sectionFixture('finish-resolve', (agents) => dropBlock(dropBlock(agents, FINISH_LEAD), RESOLVE_LEAD));
  try {
    assert.ok(!f.read().agents.includes(FINISH_LEAD) && !f.read().agents.includes(RESOLVE_LEAD), 'the fixture lacks both bullets');
    const dry = runStampContract(f.regDb, []);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /would_insert {2}- \*\*Finish what you start\.\*\*/);
    assert.match(dry.stdout, /would_insert {2}- \*\*Resolve a review thread once its finding is handled\.\*\*/);

    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*Finish what you start\.\*\*/);
    assert.match(r.stdout, /inserted {2}- \*\*Resolve a review thread once its finding is handled\.\*\*/);
    const lines = f.read().agents.split('\n');
    const at = (lead) => lines.findIndex((l) => l.startsWith(lead));
    assert.equal(lines.filter((l) => l.startsWith(FINISH_LEAD)).length, 1, 'finish inserted once');
    assert.equal(lines.filter((l) => l.startsWith(RESOLVE_LEAD)).length, 1, 'resolve inserted once');
    assert.equal(at(FINISH_LEAD), at(BACKGROUND_LEAD) + 1, 'finish right after the background bullet');
    assert.equal(at(RESOLVE_LEAD), at(FINISH_LEAD) + 1, 'resolve right after finish');
    assert.deepEqual(f.read(), f.complete, 'byte-identical to the template render');

    const again = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.ok(!/inserted/.test(again.stdout), `nothing left to insert:\n${again.stdout}`);
    assert.deepEqual(f.read(), f.complete, 'a second run writes nothing');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a project missing the background, finish and resolve bullets gets all three back in template order from one run', () => {
  const f = sectionFixture('background-finish-resolve', (agents) => [BACKGROUND_LEAD, FINISH_LEAD, RESOLVE_LEAD].reduce((text, lead) => dropBlock(text, lead), agents));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const lines = f.read().agents.split('\n');
    const at = (lead) => lines.findIndex((l) => l.startsWith(lead));
    assert.ok(at(WRITE_PLAINLY_LEAD) < at(BACKGROUND_LEAD) && at(BACKGROUND_LEAD) < at(FINISH_LEAD) && at(FINISH_LEAD) < at(RESOLVE_LEAD), 'template order: plain-writing, background, finish, resolve');
    assert.deepEqual(f.read(), f.complete, 'byte-identical to the template render');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a hand-tuned finish bullet is refused and left alone, and the resolve bullet falls back to the background bullet as its anchor', () => {
  const tuned = '- **Finish what you start.** Our own wording.';
  const f = sectionFixture('finish-tuned', (agents) => dropBlock(agents, RESOLVE_LEAD).replace(/^- \*\*Finish what you start\.\*\*.*$/m, tuned));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, 'the hand-tuned bullet is a refusal');
    assert.match(r.stdout, /HAND_TUNED_REFUSED {2}- \*\*Finish what you start\.\*\*/);
    assert.match(r.stdout, /inserted {2}- \*\*Resolve a review thread once its finding is handled\.\*\*/);
    const lines = f.read().agents.split('\n');
    assert.ok(lines.includes(tuned), 'the hand-tuned bullet is untouched');
    const at = lines.findIndex((l) => l.startsWith(RESOLVE_LEAD));
    assert.ok(lines[at - 1].startsWith(BACKGROUND_LEAD), 'resolve lands right after the fallback anchor');
  } finally {
    f.cleanup();
  }
});

// GitHub issue #111: a project that states a rule under its OWN bullet (a different bold lead, under
// its own heading) keeps it; stamp-contract inserts no template copy, prints one info line and exits 0.
const OWN_HEADING = '\n## Our rules\n\n';
const withOwnBullet = (text, own) => `${text.replace(/\n*$/, '\n')}${OWN_HEADING}${own}\n`;
// Drops `lead` from the text if the text carries it, and appends the project's own bullet instead;
// the file that does not carry the lead is returned unchanged.
const swapLead = (lead, own) => (text) => (text.split('\n').some((l) => l.startsWith(lead)) ? withOwnBullet(dropBlock(text, lead), own) : text);

for (const [lead, own, label] of [
  [BACKGROUND_LEAD, '- **Start every subagent and every long shell command in the background when the host can notify you.** Our own wording, longer than the template.', 'background'],
  [FINISH_LEAD, '- **Never stop with work half done.** Our own wording.', 'finish'],
]) {
  test(`stamp-contract (#111): a project's own ${label} bullet under another heading is kept, nothing is inserted, one info line, exit 0`, () => {
    const f = sectionFixture(`similar-${label}`, swapLead(lead, own));
    try {
      const before = f.read();
      assert.ok(!before.agents.includes(lead) && before.agents.includes(own), 'fixture: the template bullet is gone and the project bullet is there');
      for (const args of [[], ['--apply-inserts'], ['--apply', '--verbose']]) {
        const r = runStampContract(f.regDb, args);
        assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
        const info = r.stdout.split('\n').filter((l) => l.includes('SIMILAR_BULLET_KEPT'));
        assert.equal(info.length, 1, `exactly one info line:\n${r.stdout}`);
        assert.ok(info[0].includes(own.slice(0, 40)), `the info line names the project's bullet: ${info[0]}`);
        assert.ok(!/(^|\s)(would_)?insert(ed)?\s/.test(r.stdout.replace(info[0], '')), `nothing inserted:\n${r.stdout}`);
        assert.ok(!/REFUSED/.test(r.stdout), `not a refusal:\n${r.stdout}`);
        assert.deepEqual(f.read(), before, `${args.join(' ')}: nothing written, project line untouched`);
      }
    } finally {
      f.cleanup();
    }
  });
}

test("stamp-contract (#111): an unrelated bullet whose lead says 'finish' in another sense does not stop the finish bullet from being inserted", () => {
  const own = '- **Glossy finish for buttons.** Our UI rule.';
  const f = sectionFixture('finish-decoy', swapLead(FINISH_LEAD, own));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!r.stdout.includes('SIMILAR_BULLET_KEPT'), r.stdout);
    assert.match(r.stdout, /inserted {2}- \*\*Finish what you start\.\*\*/);
    const lines = f.read().agents.split('\n');
    assert.equal(lines.filter((l) => l.startsWith(FINISH_LEAD)).length, 1, 'the template bullet is inserted once');
    assert.ok(lines.includes(own), 'the project bullet is untouched');
  } finally {
    f.cleanup();
  }
});

// One project wording per insertable lead, each hitting a marker. The home layer differs per lead
// (AGENTS.md or CLAUDE.md), so swapLead acts on whichever file carries the template bullet.
const OWN_WORDING = new Map([
  ['- **Concept articles — capture design the moment it settles', '- **Capture design as concept articles.** Ours.'],
  [READY_LEAD, '- **Print READY TO CLEAR when done.** Ours.'],
  ['- **Instruction-file proposals replace memory.**', '- **Propose instruction-file changes instead of memory.** Ours.'],
  [LINT_LEAD, '- **Run lint and tests before reporting done.** Ours.'],
  [WRITE_PLAINLY_LEAD, '- **Write plainly in docs; no AI tells.** Ours.'],
  [COPY_LEAD, '- **Put text to paste between horizontal rules.** Ours.'],
  [BACKGROUND_LEAD, '- **Run subagents and long shell commands in the background.** Ours.'],
  [FINISH_LEAD, '- **Never stop with work half done.** Ours.'],
  [RESOLVE_LEAD, '- **Resolve review threads when handled.** Ours.'],
  ['- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**', '- **Run the de-ai-writing pass on prose.** Ours.'],
  [SOLVE_LEAD, '- **Every user ask is boarded at intake.** Ours.'],
  [CLOSE_LEAD, '- **Close-on-commit for board items.** Ours.'],
  [COMMENTS_LEAD, '- **Write self-explanatory code; comment only a non-obvious reason.** Ours.'],
]);

// The Domains leads arrive through TARGET_SECTIONS (the whole section is inserted, or a bullet is
// re-inserted after the one before it), and a marker there could withhold a section bullet, so
// they carry no subject marker on purpose. Every other insertable lead must have one.
const MARKERLESS_SECTION_LEADS = [
  '- **A domain is a shared knowledge store for one subject.**',
  '- **Mount every subject the project works with, its own subject included.**',
  '- **What not to do:** a Salesforce project',
  '- **A domain needs a description**',
  '- **Run `/sterling:domains` to see and change mounts.**',
];

test('stamp-contract (#111): a NEW insertable lead without a SUBJECT_MARKERS entry fails, unless it is one of the Domains section leads', () => {
  assert.deepEqual(
    MARKERLESS_SECTION_LEADS,
    TARGET_SECTIONS.flatMap((section) => section.leads),
    'the exemption list is exactly the TARGET_SECTIONS leads',
  );
  const unmarked = [...INSERT_AFTER.keys()].filter((lead) => !SUBJECT_MARKERS.has(lead) && !MARKERLESS_SECTION_LEADS.includes(lead));
  assert.deepEqual(unmarked, [], 'add a SUBJECT_MARKERS entry (and an OWN_WORDING case below) for each insertable lead');
});

test('stamp-contract (#111): every SUBJECT_MARKERS lead is a tracked lead with a positive case, and each case is kept rather than inserted', () => {
  assert.deepEqual([...OWN_WORDING.keys()].sort(), [...SUBJECT_MARKERS.keys()].sort(), 'a positive case per marker entry');
  for (const lead of SUBJECT_MARKERS.keys()) assert.ok(TARGET_LEADS.includes(lead), `${lead} is a tracked lead`);
  for (const [lead, own] of OWN_WORDING) {
    const f = sectionFixture('marker-each', swapLead(lead, own), swapLead(lead, own));
    try {
      const before = f.read();
      assert.ok(`${before.agents}\n${before.claude}`.includes(own), `fixture: ${own} placed`);
      const r = runStampContract(f.regDb, ['--apply-inserts']);
      assert.equal(r.status, 0, `${lead}: ${r.stdout}\n${r.stderr}`);
      if (!AGENTS_HOMED(lead)) {
        // A target-claude-md.md lead is not stamped (#329): nothing is said about it and nothing is written.
        assert.ok(!r.stdout.includes(lead.slice(0, 60)), `${lead}: not stamped\n${r.stdout}`);
        assert.deepEqual(f.read(), before, `${lead}: nothing written`);
        continue;
      }
      assert.match(r.stdout, /SIMILAR_BULLET_KEPT/, lead);
      assert.ok(!/(^|\s)inserted\s/.test(r.stdout), `${lead}: nothing inserted\n${r.stdout}`);
      assert.deepEqual(f.read(), before, `${lead}: nothing written`);
    } finally {
      f.cleanup();
    }
  }
});

// Unrelated bullets that share a generic word with a marker's subject (Sol review of ae858d1b): a false
// hit silently withholds a rule, so each must still get the template bullet inserted. At least one per
// SUBJECT_MARKERS entry; the issue's own 'Start everything in the background when the host can notify
// you.' is ambiguous (no agent, subagent or lane named) and is inserted over, a safe miss.
const UNRELATED_WORDING = new Map([
  ['- **Concept articles — capture design the moment it settles', ['- **Concept articles for the marketing blog.** Ours.']],
  [READY_LEAD, ['- **Ready to clear the backlog before release.** Ours.']],
  ['- **Instruction-file proposals replace memory.**', ['- **Turn off memory profiling.** Ours.']],
  [LINT_LEAD, ['- **Lint config lives next to the tests.** Ours.']],
  [WRITE_PLAINLY_LEAD, ['- **Write plain SQL migrations.** Ours.']],
  [COPY_LEAD, ['- **Copy edited text into the CMS.** Ours.', '- **Respect copyright rules for copied text.** Cite the source.', '- **Never copy secrets to the clipboard.** Ours.', '- **Use horizontal rules to separate documentation sections.** Ours.', '- **Redact secrets from text intended to be copied.** Ours.']],
  [BACKGROUND_LEAD, ['- **Run the development server in the background.** Ours.', '- **Start everything in the background when the host can notify you.** Ours.', '- **Run subagents in the background.** Ours.', '- **Start every subagent in the background when the host can notify you.** Ours.', '- **Run long shell commands.** Ours.']],
  [FINISH_LEAD, ['- **Never stop the dev server with unfinished migrations pending.** Ours.', '- **Glossy finish for buttons.** Ours.']],
  [RESOLVE_LEAD, ['- **Resolve thread pool starvation first.** Ours.']],
  ['- **Run `sterling:de-ai-writing` on prose deliverables before they ship.**', ['- **Spell-check prose deliverables.** Ours.', '- **AI-writing tools require approval.** Do not send customer data to them.']],
  [SOLVE_LEAD, ['- **Every user ask goes to the support board.** Ours.']],
  [CLOSE_LEAD, ['- **Close-on-commit for support tickets.** Ours.']],
  [COMMENTS_LEAD, ['- **Comments on the support board are public.** Ours.', '- **Code review comments get answered in a day.** Ours.', '- **Code review comments are visible only to reviewers.** Ours.', 'Code review comments are visible only to reviewers.', '- **Comments in code review are visible only to reviewers.** Ours.', '- **Code comments require no special formatting.** Ours.', '- **Default to no inline comments in code.** Ours.']],
]);

test('stamp-contract (#111): the copy-text marker matches a bullet naming both a copy context and a formatting context, in either wording', () => {
  for (const own of ['- **Put text to paste between two `---` lines.** Ours.', '- **Put text to paste between horizontal rules.** Ours.', '- **Copy-friendly text sits between two horizontal rules.** Ours.']) {
    assert.ok(findCoveringBullet(`${own}\n`, COPY_LEAD), `${own} covers the copy-text rule`);
  }
});

test('stamp-contract (#111): an unrelated bullet that shares a generic word with a marker never withholds the template bullet, for every marker entry', () => {
  assert.deepEqual([...UNRELATED_WORDING.keys()].sort(), [...SUBJECT_MARKERS.keys()].sort(), 'a negative case per marker entry');
  for (const [lead, owns] of UNRELATED_WORDING) {
    for (const own of owns) {
      const f = sectionFixture('marker-negative', swapLead(lead, own), swapLead(lead, own));
      try {
        const before = f.read();
        assert.ok(`${before.agents}\n${before.claude}`.includes(own), `fixture: ${own} placed`);
        const r = runStampContract(f.regDb, ['--apply-inserts']);
        assert.equal(r.status, 0, `${own}: ${r.stdout}\n${r.stderr}`);
        assert.ok(!r.stdout.includes('SIMILAR_BULLET_KEPT'), `${own} must not count as covering ${lead}:\n${r.stdout}`);
        if (!AGENTS_HOMED(lead)) {
          // A target-claude-md.md lead is not stamped (#329): it is never inserted, and nothing is written.
          assert.ok(!r.stdout.includes(lead.slice(0, 60)), `${lead}: not stamped\n${r.stdout}`);
          assert.deepEqual(f.read(), before, `${own}: nothing written`);
          continue;
        }
        assert.ok(r.stdout.includes(`inserted  ${lead.slice(0, 60)}`), `${own}: the template bullet is inserted:\n${r.stdout}`);
        const after = f.read();
        assert.ok(`${after.agents}\n${after.claude}`.includes(own), `${own}: the project bullet is untouched`);
      } finally {
        f.cleanup();
      }
    }
  }
});

test('stamp-contract: a project whose own background bullet covers only subagents keeps that line untouched and still receives the shell-command bullet, once, with a second run writing nothing', () => {
  const own = '- **Run subagents in the background.** Ours, with no word about shell commands.';
  for (const mode of [['--apply-inserts'], ['--apply']]) {
    const f = sectionFixture('background-subagents-only', swapLead(BACKGROUND_LEAD, own));
    try {
      const before = f.read();
      assert.ok(!before.agents.includes(BACKGROUND_LEAD) && before.agents.includes(own), 'fixture: only the project subagent bullet is there');
      const r = runStampContract(f.regDb, mode);
      assert.equal(r.status, 0, `${mode}: ${r.stdout}\n${r.stderr}`);
      assert.ok(!r.stdout.includes('SIMILAR_BULLET_KEPT'), `a subagent-only bullet does not cover the combined rule:\n${r.stdout}`);
      assert.match(r.stdout, /inserted {2}- \*\*Start every subagent and every long shell command in the/);
      const lines = f.read().agents.split('\n');
      assert.equal(lines.filter((l) => l === own).length, 1, 'the project line is kept byte for byte');
      assert.equal(lines.filter((l) => l.startsWith(BACKGROUND_LEAD)).length, 1, 'the template bullet, with the shell rule and the sleep ban, is inserted once');
      assert.match(lines.find((l) => l.startsWith(BACKGROUND_LEAD)), /Never wait with a foreground \`sleep\`/);
      const after = f.read();
      const again = runStampContract(f.regDb, mode);
      assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
      assert.ok(!/inserted|updated|renamed/.test(again.stdout), `a second run has nothing to do:\n${again.stdout}`);
      assert.deepEqual(f.read(), after, 'a second run writes nothing');
    } finally {
      f.cleanup();
    }
  }
});

test('stamp-contract (#111): findCoveringBullet ignores fenced examples and tracked template bullets, and reads only the bold lead', () => {
  const fenced = '```\n- **Never stop with work half done.**\n```\n';
  assert.equal(findCoveringBullet(fenced, FINISH_LEAD), null, 'a bullet inside a fence is an example');
  assert.equal(findCoveringBullet('- **Write plainly; no AI tells.** Never stop with work half done.\n', FINISH_LEAD), null, 'the body text is not the lead');
  assert.equal(findCoveringBullet('  - **Never stop with work half done.**\n', FINISH_LEAD), null, 'only top-level bullets');
  assert.equal(findCoveringBullet('- **Never stop with work half done.**\n', "- **Solve, don't board.**"), null, 'markers are per lead');
  assert.ok(findCoveringBullet('- **Never stop with work half done.**\n', FINISH_LEAD));
});

test('stamp-contract: a hand-tuned "No false action claims" bullet is not an anchor, so the lint bullet falls back to "Anti-speculation"', () => {
  const tuned = '- **No false action claims:** our own wording.';
  const f = sectionFixture('lint-fallback', (agents) => dropBlock(agents, LINT_LEAD).replace(/^- \*\*No false action claims:\*\*.*$/m, tuned));
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, 'the hand-tuned bullet is still a refusal');
    assert.match(r.stdout, /HAND_TUNED_REFUSED {2}- \*\*No false action claims:\*\*/);
    assert.match(r.stdout, /inserted {2}- \*\*Lint and tests before done\.\*\*/);
    const lines = f.read().agents.split('\n');
    const at = lines.findIndex((l) => l.startsWith(LINT_LEAD));
    assert.ok(lines[at - 1].startsWith('- **Anti-speculation:**'), 'inserted right after the fallback anchor');
    assert.ok(lines.includes(tuned), 'the hand-tuned bullet is untouched');
  } finally {
    f.cleanup();
  }
});

for (const heading of ['## Domains', '## Domains and hosting']) {
  test(`stamp-contract: a project's own '${heading}' heading with none of the section's bullets is ONE section refusal with what to do`, () => {
    const f = sectionFixture('own-heading', (agents) => agents.replace(DOMAINS_SECTION, `${heading}\n\nWe host at example.org.\n\n`));
    try {
      const before = f.read();
      const r = runStampContract(f.regDb);
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stdout, /SECTION_HEADING_WITHOUT_BULLETS_REFUSED {2}## Domains/);
      assert.match(r.stdout, /already has a '## Domains[^']*' heading/);
      assert.equal((r.stdout.match(/REFUSED {2}/g) ?? []).length, 1, `one refusal, not one per bullet:\n${r.stdout}`);
      assert.deepEqual(f.read(), before, 'nothing written');
    } finally {
      f.cleanup();
    }
  });
}

test("stamp-contract: the section goes before the template's Conventions heading, never before a project heading that only starts the same", () => {
  const decoy = '## Conventions of naming\n\nWe name things plainly.\n\n';
  const f = sectionFixture('decoy-conventions', (agents) => agents.replace(DOMAINS_SECTION, '').replace('## Project facts', `${decoy}## Project facts`));
  try {
    assert.ok(f.read().agents.indexOf('## Conventions of naming') < f.read().agents.indexOf('## Conventions ('), 'fixture sanity: the decoy sits above the real heading');
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(f.read().agents, f.complete.agents.replace('## Project facts', `${decoy}## Project facts`), 'the section sits where the template has it');
  } finally {
    f.cleanup();
  }

  const only = sectionFixture('only-decoy', (agents) => agents.replace(DOMAINS_SECTION, '').replace(/^## Conventions.*$/m, '## Conventions of naming'));
  try {
    const before = only.read();
    const r = runStampContract(only.regDb);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /SECTION_ANCHOR_MISSING_REFUSED {2}## Domains/);
    assert.deepEqual(only.read(), before);
  } finally {
    only.cleanup();
  }
});

// ---- the write path (--apply and --apply-inserts): a file that cannot be written is that
// project's refusal, never a crash, and never hides what was written elsewhere ----

const AS_ROOT = process.getuid?.() === 0 && 'root writes a read-only file';

// Several registered projects in one registry, each a complete sibling with no Domains section.
function projectsWithoutSection(names) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const registry = new ProjectRegistry(regDb);
  const dirs = {};
  try {
    for (const name of names) {
      const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
      writeCompleteSibling(dir, name);
      writeFileSync(join(dir, 'AGENTS.md'), readFileSync(join(dir, 'AGENTS.md'), 'utf8').replace(DOMAINS_SECTION, ''));
      registry.register({ repo_path: dir, name, stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
      dirs[name] = dir;
    }
  } finally {
    registry.close();
  }
  const agents = (name) => readFileSync(join(dirs[name], 'AGENTS.md'), 'utf8');
  const cleanup = () => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    for (const dir of Object.values(dirs)) {
      for (const f of ['AGENTS.md', 'CLAUDE.md']) chmodSync(join(dir, f), 0o644);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
  return { regDb, dirs, agents, cleanup };
}

test('stamp-contract --apply-inserts: a read-only AGENTS.md is a refusal naming the path (exit 2, no stack), and no insert is claimed', { skip: AS_ROOT }, () => {
  const f = projectsWithoutSection(['solo']);
  try {
    const path = join(f.dirs.solo, 'AGENTS.md');
    const before = f.agents('solo');
    chmodSync(path, 0o444);
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, `a file that cannot be written is drift, not a crash:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /WRITE_FAILED_REFUSED/);
    assert.ok(r.stdout.includes(path), 'the refusal names the path');
    assert.match(r.stdout, /EACCES|EPERM/);
    assert.ok(!/ section_inserted {2}/.test(r.stdout), `nothing was written, so no insert is claimed:\n${r.stdout}`);
    assert.match(r.stdout, /would_insert_section {2}## Domains/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
    assert.equal(f.agents('solo'), before);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: with one unwritable project among three, the others are written and reported, and the run exits 2', { skip: AS_ROOT }, () => {
  const f = projectsWithoutSection(['aa', 'bb', 'cc']);
  try {
    chmodSync(join(f.dirs.bb, 'AGENTS.md'), 0o444);
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    for (const name of ['aa', 'cc']) {
      assert.match(f.agents(name), /## Domains\n/, `${name} was written`);
      assert.match(r.stdout, new RegExp(`• ${name} \\([^\\n]*\\n    section_inserted {2}## Domains`), `${name}'s insert is reported`);
    }
    assert.doesNotMatch(f.agents('bb'), /## Domains\n/);
    assert.match(r.stdout, /✗ bb \(/);
    assert.ok(r.stdout.includes(join(f.dirs.bb, 'AGENTS.md')), 'the refusal names the path');
    assert.match(r.stdout, /3 project\(s\) processed/);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a read-only CLAUDE.md that needs no change is never written, so the AGENTS.md insert succeeds and is reported', { skip: AS_ROOT }, () => {
  const f = projectsWithoutSection(['solo']);
  try {
    chmodSync(join(f.dirs.solo, 'CLAUDE.md'), 0o444);
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /section_inserted {2}## Domains/);
    assert.match(f.agents('solo'), /## Domains\n/);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: in a file with mixed line endings the inserted lines take the neighbouring line ending and every existing byte stays; an untouched mixed file is not rewritten', () => {
  const f = projectsWithoutSection(['mixed']);
  try {
    const dir = f.dirs.mixed;
    const lf = f.agents('mixed');
    const at = lf.indexOf('## Conventions');
    assert.ok(at > 0);
    // CRLF above the Conventions heading, LF from it on.
    const head = lf.slice(0, at).replace(/\n/g, '\r\n');
    const tail = lf.slice(at);
    writeFileSync(join(dir, 'AGENTS.md'), head + tail);
    const claudeLines = readFileSync(join(dir, 'CLAUDE.md'), 'utf8').split('\n');
    const claudeMixed = claudeLines.map((l, i) => (i === claudeLines.length - 1 ? l : l + (i % 2 ? '\r\n' : '\n'))).join('');
    writeFileSync(join(dir, 'CLAUDE.md'), claudeMixed);

    const complete = renderTemplate('templates/target-agents-md.md', 'mixed');
    const section = DOMAINS_SECTION.exec(complete)[0];
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(f.agents('mixed'), head + section.replace(/\n/g, '\r\n') + tail, 'the section is CRLF like the line above it; nothing else moved');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claudeMixed, 'the untouched file is byte-identical');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a bullet still under its old lead is kept and reported would_rename, and a new bullet anchored after it is inserted', () => {
  // Ported from the Knowledge/READY TO CLEAR pair (target-claude-md.md leads, not stamped since #329)
  // to the AGENTS.md background bullet's old lead and the Finish bullet anchored after it.
  const NEW_LEAD = '- **Start every subagent and every long shell command in the background.**';
  const OLD_LEAD = '- **Start every subagent in the background.**';
  const NEXT_LEAD = '- **Finish what you start.**';
  const oldBlock = JSON.parse(readFileSync(join(root, 'bin', 'contract-history.json'), 'utf8'))[OLD_LEAD][0];
  assert.ok(oldBlock?.startsWith(OLD_LEAD), 'fixture sanity: a historical block under the old lead');
  const f = stampFixture('rename-anchor', (complete) => {
    const lines = dropBlock(complete, NEXT_LEAD).split('\n');
    const i = lines.findIndex((l) => l.startsWith(NEW_LEAD));
    assert.notEqual(i, -1);
    lines[i] = oldBlock;
    const planted = lines.join('\n');
    const next = complete.split('\n').find((l) => l.startsWith(NEXT_LEAD));
    const out = [...lines];
    out.splice(i + 1, 0, next);
    return { planted, expected: out.join('\n') };
  });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /would_rename {2}- \*\*Start every subagent and every long shell command/);
    assert.match(r.stdout, /inserted {2}- \*\*Finish what you start/);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the old block is byte-for-byte kept, with the new bullet after it');
  } finally {
    f.cleanup();
  }
});

// ---- the generated Sterling layer section (GitHub #329, review finding 4) ----
// stamp-contract stamps only the project's own AGENTS.md text: the section between the
// sterling:begin/end markers is never matched, refused, duplicated or rewritten, and host files
// are never written, also on the combined update path (sync-agents' layer step, then --apply-inserts).

const layerSlice = (text) => text.slice(text.indexOf('<!-- sterling:begin generated'), text.indexOf(LAYER_END) + LAYER_END.length);

function layerFixture(name, { agents, claude, gemini }) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
  writeFileSync(join(dir, 'AGENTS.md'), agents);
  if (claude !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claude);
  if (gemini !== undefined) writeFileSync(join(dir, 'GEMINI.md'), gemini);
  const registry = new ProjectRegistry(regDb);
  try {
    registry.register({ repo_path: dir, name, stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
  } finally {
    registry.close();
  }
  const cleanup = () => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, regDb, cleanup, read: (file) => readFileSync(join(dir, file), 'utf8') };
}

test('stamp-contract, combined update path: after the layer step, --apply-inserts leaves a retained CLAUDE.md and GEMINI.md and the generated section byte-identical, with no layer refusals, exit 0', () => {
  const claude = `# Our CLAUDE.md\n\n${renderTemplate('templates/target-claude-md.md', 'combined').split('\n').filter((l) => l.startsWith('- **Reconcile') || l.startsWith('- **Knowledge is born')).join('\n')}\n- **Our rule.** Tabs, never spaces.\n`;
  const gemini = '# Our GEMINI.md\n\n- **agy rule.** Our own.\n';
  const f = layerFixture('combined', { agents: renderTemplate(AGENTS_TEMPLATE_REL, 'combined'), claude, gemini });
  try {
    const sync = syncLayer({ projectDir: f.dir, pluginRoot: root });
    assert.equal(sync.refused, 0, sync.lines.join('\n'));
    const afterSync = f.read('AGENTS.md');
    assert.ok(afterSync.includes(LAYER_END), 'fixture sanity: the layer step wrote the section');
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!/DUPLICATE_REFUSED|WRONG_LAYER_REFUSED|REFUSED/.test(r.stdout), `no refusal from the generated section:\n${r.stdout}`);
    assert.equal(f.read('CLAUDE.md'), claude, 'retained CLAUDE.md byte-identical');
    assert.equal(f.read('GEMINI.md'), gemini, 'retained GEMINI.md byte-identical');
    assert.equal(f.read('AGENTS.md'), afterSync, 'AGENTS.md byte-identical: in sync outside the section, untouched inside');
    assert.equal(layerSlice(f.read('AGENTS.md')), readLayerSection(root), 'the generated section is the shipped one');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: an AGENTS.md-homed bullet inside the generated section is not counted — a missing copy is inserted OUTSIDE the markers, and the section is byte-identical', () => {
  const complete = renderTemplate(AGENTS_TEMPLATE_REL, 'masked');
  const lint = complete.split('\n').find((l) => l.startsWith(INSERT_LEAD));
  const section = readLayerSection(root).replace(LAYER_END, `${lint}\n${LAYER_END}`);
  const planted = `${dropBlock(complete, INSERT_LEAD)}\n${section}\n`;
  const f = layerFixture('masked', { agents: planted });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!/DUPLICATE_REFUSED|WRONG_LAYER_REFUSED/.test(r.stdout), r.stdout);
    assert.match(r.stdout, /inserted {2}- \*\*Lint and tests before done/);
    const after = f.read('AGENTS.md');
    assert.equal(after, `${complete}\n${section}\n`, 'the bullet lands in its template position outside the section; the section is untouched');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: malformed layer markers (a begin line missing -->) are LAYER_MARKERS_REFUSED — exit 2, AGENTS.md byte-identical', () => {
  const complete = renderTemplate(AGENTS_TEMPLATE_REL, 'malformed');
  const broken = readLayerSection(root).replace(/ -->\n/, '\n');
  const planted = `${dropBlock(complete, INSERT_LEAD)}\n${broken}\n`;
  const f = layerFixture('malformed', { agents: planted });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /LAYER_MARKERS_REFUSED/);
    assert.equal(f.read('AGENTS.md'), planted);
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: a CRLF AGENTS.md with the generated section gets only the insert; every other byte, the section included, is kept', () => {
  const complete = renderTemplate(AGENTS_TEMPLATE_REL, 'crlf-layer');
  const section = readLayerSection(root);
  const toCrlf = (t) => t.replace(/\n/g, '\r\n');
  const planted = toCrlf(`${dropBlock(complete, INSERT_LEAD)}\n${section}\n`);
  const f = layerFixture('crlf-layer', { agents: planted });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(f.read('AGENTS.md'), toCrlf(`${complete}\n${section}\n`));
  } finally {
    f.cleanup();
  }
});

// Review loop 2 of #329: stamp-contract never follows an aliased AGENTS.md, and never writes a
// planned AGENTS.md that would not fit agy's cap once the Sterling layer is in.
test('stamp-contract: a symlinked AGENTS.md (here pointing at CLAUDE.md) is AGENTS_MD_REFUSED — link and target byte-identical, exit 2', () => {
  const complete = renderTemplate(AGENTS_TEMPLATE_REL, 'linked');
  const f = layerFixture('linked', { agents: '' });
  try {
    rmSync(join(f.dir, 'AGENTS.md'));
    const claude = `${dropBlock(complete, INSERT_LEAD)}\n`;
    writeFileSync(join(f.dir, 'CLAUDE.md'), claude);
    symlinkSync('CLAUDE.md', join(f.dir, 'AGENTS.md'));
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /AGENTS_MD_REFUSED/);
    assert.equal(f.read('CLAUDE.md'), claude, 'the link target is not stamped');
    assert.ok(lstatSync(join(f.dir, 'AGENTS.md')).isSymbolicLink(), 'the link is left in place');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract --apply-inserts: an insert that would take AGENTS.md (with the layer) past agy\'s 24,000-byte cap is PLANNED_AGENTS_MD_REFUSED — nothing written, exit 2', () => {
  const complete = renderTemplate(AGENTS_TEMPLATE_REL, 'near-cap');
  const section = readLayerSection(root);
  const base = `${dropBlock(complete, INSERT_LEAD)}\n`;
  const room = 24_000 - Buffer.byteLength(`${base}\n${section}\n`);
  assert.ok(room > 200, 'fixture: the stock text fits with the layer');
  const lint = complete.split('\n').find((l) => l.startsWith(INSERT_LEAD));
  const pad = `\n## Our notes\n\n${'x'.repeat(room - Buffer.byteLength(lint) + 10 - 16)}\n`;
  const planted = `${base}${pad}\n${section}\n`;
  assert.ok(Buffer.byteLength(planted) <= 24_000, 'fixture: the file fits before the insert');
  const f = layerFixture('near-cap', { agents: planted });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PLANNED_AGENTS_MD_REFUSED/);
    assert.match(r.stdout, /over agy's 24,000-byte cap/);
    assert.equal(f.read('AGENTS.md'), planted);
  } finally {
    f.cleanup();
  }
});

// CLI surface (issues #207, #210): --help prints usage, an unknown flag and a --project that
// matches no registered project both exit 2, none of them writing anything.
test('--help prints the usage and exits 0 without running the registry pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-help-'));
  try {
    const r = runStampContract(join(dir, 'registry.db'), ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage: node scripts\/stamp-contract\.mjs /);
    assert.doesNotMatch(r.stdout, /DRY-RUN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown option exits 2 naming it, with the usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-bogus-'));
  try {
    const r = runStampContract(join(dir, 'registry.db'), ['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option --bogus/);
    assert.match(r.stderr, /usage: node scripts\/stamp-contract\.mjs /);
    assert.doesNotMatch(r.stdout, /DRY-RUN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --project that matches no registered project exits 2 naming the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-nomatch-'));
  try {
    const nope = join(dir, 'not-registered');
    const r = runStampContract(join(dir, 'registry.db'), ['--project', nope]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(`--project matched no registered project: ${nope}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --project naming a linked git worktree (issue #210, user-ruled 2026-10-27 "The worktree's
// copy"): the registry match goes through the main project, the files are the worktree's own.
// `registerWorktree`: the worktree is also a registry row of its own (review loop 8 of #329).
function worktreeFixture({ registerWorktree = false } = {}) {
  const f = stampFixture('wt', (complete) => ({ planted: dropBlock(complete, INSERT_LEAD), expected: complete }));
  const main = dirname(f.agentsPath);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: main, encoding: 'utf8' });
    assert.equal(r.status, 0, 'git setup step failed');
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  const wt = `${main}-wt`;
  git('worktree', 'add', '-q', wt, '-b', 'wt-branch');
  if (registerWorktree) {
    const registry = new ProjectRegistry(f.regDb);
    try {
      registry.register({ repo_path: wt, name: 'wt-worktree', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    } finally {
      registry.close();
    }
  }
  const cleanup = () => {
    f.cleanup();
    rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { ...f, main, wt, cleanup };
}

test('--project <linked worktree> --apply edits the worktree copy and leaves the main checkout untouched', () => {
  const f = worktreeFixture();
  try {
    const r = runStampContract(f.regDb, ['--apply', '--project', f.wt]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(join(f.wt, 'AGENTS.md'), 'utf8'), f.expected, 'the worktree copy is stamped');
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.planted, 'the main checkout is byte-identical');
    assert.match(r.stdout, /worktree .*-wt; the main checkout is not touched/);
  } finally {
    f.cleanup();
  }
});

// Since the #329 rebuild (decision 329-rebuild-how-sterling-update-stamps-sibling-projects-as-o)
// /sterling:update hands the stamper its registry rows in-process (stampProjects in
// scripts/lib/stamp-projects.mjs) instead of naming them as --project flags. A registered main
// checkout and its registered linked worktree are two rows, each stamped in its own directory; the
// interactive CLI keeps mapping a worktree argument to its main row (decision
// stamp-contract-project-on-a-worktree-stamps-the-worktree-copy).
test('stampProjects: a registered main checkout and its registered linked worktree, given as two rows, are each stamped; the CLI still maps a worktree argument to its main row', () => {
  const f = worktreeFixture({ registerWorktree: true });
  const wtAgents = join(f.wt, 'AGENTS.md');
  try {
    const interactive = runStampContract(f.regDb, ['--apply-inserts', '--project', f.wt]);
    assert.equal(interactive.status, 0, `${interactive.stdout}\n${interactive.stderr}`);
    assert.equal(readFileSync(wtAgents, 'utf8'), f.expected, 'a worktree argument stamps the worktree copy');
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.planted, 'and leaves the main checkout alone');

    writeFileSync(wtAgents, f.planted);
    const results = stampProjects([{ name: 'wt', repo_path: f.main }, { name: 'wt-worktree', repo_path: f.wt }], { repoRoot: root, applyInserts: true });
    assert.deepEqual(results.map((r) => [r.project, r.path, r.status]), [['wt', f.agentsPath, 'stamped'], ['wt-worktree', wtAgents, 'stamped']]);
    assert.ok(results.every((r) => r.actions.some((a) => a.action === 'inserted')), 'each row has its insert');
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.expected, 'the main checkout row is stamped');
    assert.equal(readFileSync(wtAgents, 'utf8'), f.expected, 'the worktree row is stamped in its own directory');
    assert.deepEqual(results.flatMap(stampResultFailures), []);
  } finally {
    f.cleanup();
  }
});

// A row is stamped where it points; no realpath folds two rows into one. The interactive CLI keeps
// its real-path fallback, so a real path reaches a registered symlink alias of it too.
test('stampProjects: a path and a symlink alias of it, given as two rows, each get their own result', () => {
  const f = stampFixture('alias-real', (complete) => ({ planted: dropBlock(complete, INSERT_LEAD), expected: complete }));
  const real = dirname(f.agentsPath);
  const alias = `${real}-alias`;
  try {
    symlinkSync(real, alias);
    const registry = new ProjectRegistry(f.regDb);
    try {
      registry.register({ repo_path: alias, name: 'alias-link', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
    } finally {
      registry.close();
    }
    const results = stampProjects([{ name: 'alias-real', repo_path: real }, { name: 'alias-link', repo_path: alias }], { repoRoot: root });
    assert.deepEqual(results.map((r) => [r.project, r.path, r.status]), [['alias-real', f.agentsPath, 'stamped'], ['alias-link', join(alias, 'AGENTS.md'), 'stamped']]);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.planted, 'a dry run writes nothing');
    const interactive = runStampContract(f.regDb, ['--project', real]);
    assert.match(interactive.stdout, /— 2 project\(s\) processed/, interactive.stdout);
  } finally {
    rmSync(alias, { force: true });
    f.cleanup();
  }
});

// One structured result per row, in row order, and the classifier /sterling:update applies to it
// (scripts/lib/stamp-outcome.mjs): a stale path and a Sterling source tree are named skips, a project
// with no AGENTS.md fails, hand-tuned text is tolerated drift, and an empty list reads nothing.
test('stampProjects: stale path and source tree are skips, not_migrated fails, HAND_TUNED_REFUSED is tolerated drift, in-sync is quiet', () => {
  const handTuned = sectionFixture('api-handtuned', (agents) => agents.replace(/- \*\*Anti-speculation:\*\*[^\n]*/, '- **Anti-speculation:** This project tunes the rule its own hand-edited way.'));
  const inSync = sectionFixture('api-insync', (agents) => agents);
  const checkout = sectionFixture('api-checkout', (agents) => agents.replace(DOMAINS_SECTION, ''));
  const legacy = mkdtempSync(join(tmpdir(), 'sterling-stamp-api-legacy-'));
  const gone = join(tmpdir(), `sterling-stamp-api-gone-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(join(checkout.dir, '.claude-plugin'));
    writeFileSync(join(checkout.dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling' }));
    mkdirSync(join(checkout.dir, 'scripts'));
    writeFileSync(join(checkout.dir, 'scripts', 'architecture-projection.mjs'), '');
    const before = [handTuned.read(), inSync.read(), checkout.read()];
    const seen = [];
    const rows = [
      { name: 'stale', repo_path: gone },
      { name: 'checkout', repo_path: checkout.dir },
      { name: 'legacy', repo_path: legacy },
      { name: 'handtuned', repo_path: handTuned.dir },
      { name: 'insync', repo_path: inSync.dir },
    ];
    const results = stampProjects(rows, { repoRoot: root, applyInserts: true, onResult: (r) => seen.push(r.project) });
    assert.deepEqual(seen, rows.map((r) => r.name), 'onResult runs per project, in row order');
    assert.deepEqual(results.map((r) => [r.row, r.status, r.reason && r.reason.split(' ')[0]]), [
      [rows[0], 'skipped', 'stale_path'],
      [rows[1], 'skipped', 'sterling_source_tree'],
      [rows[2], 'not_migrated', 'no'],
      [rows[3], 'refused', null],
      [rows[4], 'in_sync', null],
    ]);
    assert.deepEqual([handTuned.read(), inSync.read(), checkout.read()], before, 'nothing written');
    assert.ok(results[3].actions.some((a) => a.action === 'HAND_TUNED_REFUSED'));
    assert.deepEqual(results.map((r) => stampResultFailures(r).length), [0, 0, 1, 0, 0], 'only not_migrated fails');
    assert.match(stampResultFailures(results[2])[0], new RegExp(`^not_migrated — no AGENTS\\.md — run: .*--target ${legacy}$`));
    assert.deepEqual(results.map((r) => stampRefusalCount(r)), [0, 0, 1, 1, 0], 'drift counts not_migrated and every refusal');
    assert.deepEqual(stampResultLines(results[0]), [`– stale (${join(gone, 'AGENTS.md')}): skipped — the registered path does not exist (a stale registry entry); nothing stamped`]);
    assert.deepEqual(stampResultLines(results[1]), [`– checkout (${join(checkout.dir, 'AGENTS.md')}): skipped — a Sterling source tree, whose instruction files are hand-maintained; nothing stamped`]);
    assert.deepEqual(stampResultLines(results[4]), [], 'quiet on clean');
    assert.deepEqual(stampProjects([], { repoRoot: join(tmpdir(), 'no-such-sterling-root') }), [], 'an empty list reads nothing, not even the templates');
  } finally {
    for (const f of [handTuned, inSync, checkout]) f.cleanup();
    rmSync(legacy, { recursive: true, force: true });
  }
});

// The write and safety refusals are failures of that project, read from the structured actions.
test('stampProjects: a write refusal (an over-cap plan) is a failure the classifier names; the file is untouched', () => {
  const f = sectionFixture('api-cap', (agents) => {
    const base = agents.replace(DOMAINS_SECTION, '');
    return `${base}\n<!-- ${'x'.repeat(24_000 - Buffer.byteLength(base) - 20)} -->\n`;
  });
  try {
    const before = f.read();
    assert.ok(Buffer.byteLength(before.agents) <= 24_000, 'fixture: the file fits before the insert');
    const [r] = stampProjects([{ name: 'api-cap', repo_path: f.dir }], { repoRoot: root, applyInserts: true });
    assert.equal(r.status, 'refused');
    assert.deepEqual(f.read(), before, 'nothing written');
    const failures = stampResultFailures(r);
    assert.equal(failures.length, 1, JSON.stringify(r.actions));
    assert.match(failures[0], /^PLANNED_AGENTS_MD_REFUSED AGENTS\.md \(write\) — .*24,000-byte cap/);
    assert.ok(r.actions.some((a) => a.action === 'would_insert_section'), 'the unwritten insert is reported as would_*');
  } finally {
    f.cleanup();
  }
});

// The rebuild removed --exact-projects: the interactive CLI is main's again, so the flag is unknown.
test('--exact-projects is no longer an option: exit 2 naming it, before the registry is opened', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-exact-'));
  try {
    const regDb = join(scratch, 'registry.db');
    const r = runStampContract(regDb, ['--apply-inserts', '--project', scratch, '--exact-projects']);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /unknown option --exact-projects/);
    assert.equal(existsSync(regDb), false, 'the registry was never opened');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('--project <linked worktree> dry run reports the worktree path and writes nothing', () => {
  const f = worktreeFixture();
  try {
    const r = runStampContract(f.regDb, ['--project', f.wt]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes(join(f.wt, 'AGENTS.md')), 'the output names the worktree file');
    assert.ok(!r.stdout.includes(`${f.main}/AGENTS.md`), 'the main checkout file is not named');
    assert.match(r.stdout, /would_insert/);
    assert.equal(readFileSync(join(f.wt, 'AGENTS.md'), 'utf8'), f.planted);
  } finally {
    f.cleanup();
  }
});

test('naming both the registered project and its worktree stamps only the worktree copy', () => {
  const f = worktreeFixture();
  try {
    const r = runStampContract(f.regDb, ['--apply', '--project', f.main, '--project', f.wt]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(join(f.wt, 'AGENTS.md'), 'utf8'), f.expected);
    assert.equal(readFileSync(f.agentsPath, 'utf8'), f.planted);
  } finally {
    f.cleanup();
  }
});

test('a worktree whose main project is not registered exits 2 as unmatched', () => {
  const f = worktreeFixture();
  try {
    const other = mkdtempSync(join(tmpdir(), 'sterling-stamp-emptyreg-'));
    try {
      const r = runStampContract(join(other, 'registry.db'), ['--apply', '--project', f.wt]);
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes(`--project matched no registered project: ${f.wt}`));
      assert.equal(readFileSync(join(f.wt, 'AGENTS.md'), 'utf8'), f.planted);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

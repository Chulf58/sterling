// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// 161e2972): each TARGET_LEADS bullet propagates into whichever template CURRENTLY carries
// it — AGENTS.md for a tool-agnostic lead, CLAUDE.md for a Sterling-bound one — and a sibling
// lacking AGENTS.md entirely is reported not_migrated rather than partially patched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';
import { renderClaudeText } from '../lib/agent-fences.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    .replaceAll('{{DOMAINS}}', '~/.sterling/domains/node/ — created lazily on first need (§2.3)')
    .replaceAll('{{BACKUP_PATH}}', '(opted out — recorded)')
    .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)');
}
function writeCompleteSibling(dir, projectName) {
  writeFileSync(join(dir, 'AGENTS.md'), renderTemplate('templates/target-agents-md.md', projectName));
  writeFileSync(join(dir, 'CLAUDE.md'), renderTemplate('templates/target-claude-md.md', projectName));
}

test('stamp-contract: an AGENTS.md-homed lead is updated in AGENTS.md (ancestry followed across the split from its pre-split home in target-claude-md.md), a CLAUDE.md-homed lead is updated in CLAUDE.md, and a sibling lacking AGENTS.md is not_migrated (nothing written for it)', () => {
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
    assert.ok(!claudeMdAfter.includes(staleReconcile), 'the CLAUDE.md-homed lead was NOT left stale in CLAUDE.md');
    assert.ok(!claudeMdAfter.includes('- **Anti-speculation:**'), 'the AGENTS.md-homed lead was not also duplicated into CLAUDE.md');

    assert.equal(r.status, 2, 'a not_migrated sibling counts as a refusal — exit 2');
    assert.match(r.stdout, /not_migrated.*run: node scripts\/init\.mjs --target/, 'the legacy sibling (no AGENTS.md) is reported not_migrated, naming the ensure command');
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

test('stamp-contract: a bullet present in BOTH layer files (TRUE duplicate — home AND wrong layer) is exactly DUPLICATE_REFUSED before any write — exit 2, nothing written', () => {
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
    assert.equal(r.status, 2, 'a duplicate bullet is a refusal — exit 2');
    assert.match(r.stdout, /DUPLICATE_REFUSED/, 'named exactly DUPLICATE_REFUSED (present in BOTH files, home included)');
    assert.ok(!/WRONG_LAYER_REFUSED/.test(r.stdout), 'not the wrong-layer-only action — the home copy is present too');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), agentsPlanted, 'AGENTS.md untouched — no second copy written on top of the planted one');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claudeBefore, 'CLAUDE.md untouched — the home file never got an inserted/renamed copy either');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a bullet present ONLY in the wrong layer (home file has no copy at all) is exactly WRONG_LAYER_REFUSED before any write — exit 2, both files byte-identical', () => {
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
    assert.equal(r.status, 2, 'a wrong-layer-only bullet is a refusal — exit 2');
    assert.match(r.stdout, /WRONG_LAYER_REFUSED/, 'named exactly WRONG_LAYER_REFUSED (absent from home, present only in the wrong file)');
    assert.ok(!/DUPLICATE_REFUSED/.test(r.stdout), 'not the true-duplicate action — the home file has no copy at all');
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
    const claudeBefore = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const handTuned = claudeBefore.replace(
      /- \*\*Knowledge is born structured\.\*\*[^\n]*/,
      '- **Knowledge is born structured.** This project tunes the rest of the rule its own hand-edited way, never matching any shipped wording.',
    );
    assert.notEqual(handTuned, claudeBefore, 'fixture sanity: the replace actually matched something');
    writeFileSync(join(dir, 'CLAUDE.md'), handTuned);
    registry.register({ repo_path: dir, name: 'handtuned-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 2, 'hand-tuned text is a refusal — exit 2');
    assert.match(r.stdout, /HAND_TUNED_REFUSED/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), handTuned, 'hand-tuned text left byte-for-byte untouched');
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

test('stamp-contract: realpath self-exclusion — this Sterling clone\'s own path, if registered, is skipped entirely and never read or written', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const registry = new ProjectRegistry(regDb);
  try {
    const selfAgentsBefore = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const selfClaudeBefore = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    registry.register({ repo_path: root, name: 'self', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, 'the self-excluded clone contributes no drift');
    assert.ok(!r.stdout.includes('self'), 'the self project never appears in the output at all — excluded before any read');
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), selfAgentsBefore, 'this clone\'s own AGENTS.md untouched');
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), selfClaudeBefore, 'this clone\'s own CLAUDE.md untouched');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// The READY TO CLEAR bullet (commit 6661665) is NEW to every existing sibling, so it can only
// arrive through the insert path — the replace path needs a block to already be there.
const READY_LEAD = '- **Say `READY TO CLEAR` plainly when it is time.**';
const CODEX_LEAD = '- **Codex runs through the MCP tool, never the shell.**';
function dropBlock(text, lead) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(lead));
  assert.notEqual(i, -1, `fixture sanity: '${lead}' present before removal`);
  lines.splice(i, 1);
  return lines.join('\n');
}

test('stamp-contract: a sibling CLAUDE.md lacking the READY TO CLEAR bullet gets it inserted after the Codex bullet — the result is byte-identical to the current template render, exit 0', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-ready-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'ready-sibling');
    const complete = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(dir, 'CLAUDE.md'), dropBlock(complete, READY_LEAD));
    registry.register({ repo_path: dir, name: 'ready-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `inserting a missing bullet is not a refusal: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*Say `READY TO CLEAR`/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), complete, 'bullet inserted in its template position, nothing else changed');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a sibling lacking BOTH the Codex and READY TO CLEAR bullets gets both back in template order — Codex after "Knowledge is born structured.", READY TO CLEAR after Codex — byte-identical to the render, exit 0', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-ready-fallback-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'ready-fallback-sibling');
    const complete = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(dir, 'CLAUDE.md'), dropBlock(dropBlock(complete, CODEX_LEAD), READY_LEAD));
    registry.register({ repo_path: dir, name: 'ready-fallback-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `chained inserts are not a refusal: ${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), complete, 'both bullets restored in their template positions, nothing else changed');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: a sibling CLAUDE.md lacking the Codex bullet gets it inserted after "Knowledge is born structured." — byte-identical to the current template render, exit 0', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-codex-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'codex-sibling');
    const complete = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(dir, 'CLAUDE.md'), dropBlock(complete, CODEX_LEAD));
    registry.register({ repo_path: dir, name: 'codex-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 0, `inserting a missing bullet is not a refusal: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /inserted {2}- \*\*Codex runs through the MCP tool/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), complete, 'bullet inserted in its template position, nothing else changed');
  } finally {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('stamp-contract: with the Codex bullet refused (present only in AGENTS.md, the wrong layer), READY TO CLEAR still inserts via the fallback anchor "Knowledge is born structured." — exit 2 for the refusal only', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-ready-anchor-fallback-'));
  const registry = new ProjectRegistry(regDb);
  try {
    writeCompleteSibling(dir, 'ready-anchor-fallback-sibling');
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    const codexLine = claude.split('\n').find((l) => l.startsWith(CODEX_LEAD));
    const noBoth = dropBlock(dropBlock(claude, CODEX_LEAD), READY_LEAD);
    const readyLine = claude.split('\n').find((l) => l.startsWith(READY_LEAD));
    writeFileSync(join(dir, 'CLAUDE.md'), noBoth);
    writeFileSync(join(dir, 'AGENTS.md'), `${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}\n${codexLine}\n`);
    registry.register({ repo_path: dir, name: 'ready-anchor-fallback-sibling', stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });

    const r = runStampContract(regDb);
    assert.equal(r.status, 2, 'the wrong-layer Codex bullet is a refusal');
    assert.match(r.stdout, /WRONG_LAYER_REFUSED {2}- \*\*Codex runs through/);
    const knowledge = noBoth.split('\n').find((l) => l.startsWith('- **Knowledge is born structured.**'));
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), noBoth.replace(knowledge, `${knowledge}\n${readyLine}`), 'READY TO CLEAR lands directly after the Knowledge bullet; no Codex copy is written into CLAUDE.md');
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
function stampFixture(name, mutate) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
  const registry = new ProjectRegistry(regDb);
  writeCompleteSibling(dir, name);
  const complete = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  const { planted, expected } = mutate(complete);
  writeFileSync(join(dir, 'CLAUDE.md'), planted);
  registry.register({ repo_path: dir, name, stack_tags: [], toolchains: [], sterling_version: null, at: new Date().toISOString() });
  const cleanup = () => {
    registry.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { regDb, claudePath: join(dir, 'CLAUDE.md'), planted, expected, cleanup };
}

test('stamp-contract: an exact Knowledge bullet inside a fenced ``` example BEFORE the conduct section is never an anchor — the missing bullets land after the REAL one, and a second run changes nothing (idempotent)', () => {
  const f = stampFixture('fenced', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(KNOWLEDGE_LEAD));
    const fence = `\n## Example\n\n\`\`\`md\n${knowledge}\n\`\`\`\n`;
    const [first, ...rest] = complete.split('\n');
    const withFence = [first, fence, ...rest].join('\n');
    return { planted: dropBlock(dropBlock(withFence, CODEX_LEAD), READY_LEAD), expected: withFence };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'both bullets restored after the REAL Knowledge bullet; the fenced example is untouched');
    const r2 = runStampContract(f.regDb);
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'second run leaves the file byte-identical');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a hand-tuned MULTI-PARAGRAPH Knowledge bullet is refused AND never used as an anchor — Codex and READY TO CLEAR are ANCHOR_MISSING_REFUSED, file byte-identical, exit 2', () => {
  const f = stampFixture('handtuned-anchor', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(KNOWLEDGE_LEAD));
    const tuned = complete.replace(knowledge, `${KNOWLEDGE_LEAD} This project words it its own way.\n\n  A second paragraph of the same hand-tuned item.`);
    const planted = dropBlock(dropBlock(tuned, CODEX_LEAD), READY_LEAD);
    return { planted, expected: planted };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /HAND_TUNED_REFUSED {2}- \*\*Knowledge is born structured/);
    assert.match(r.stdout, /ANCHOR_MISSING_REFUSED {2}- \*\*Codex runs through/);
    assert.match(r.stdout, /ANCHOR_MISSING_REFUSED {2}- \*\*Say `READY TO CLEAR`/);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'the refused bullet is not restructured and nothing is inserted');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a valid anchor followed by a blank-separated indented continuation paragraph gets the insert after the WHOLE list item, and a second run changes nothing (idempotent)', () => {
  const f = stampFixture('continuation', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(KNOWLEDGE_LEAD));
    const extra = '\n  A project-added paragraph under the Knowledge item.';
    // In the render the Codex line directly follows Knowledge, so here it follows the continuation.
    const withExtra = complete.replace(knowledge, `${knowledge}\n${extra}`);
    return { planted: dropBlock(withExtra, CODEX_LEAD), expected: withExtra };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'Codex lands after the continuation paragraph, never between the item and its continuation');
    const r2 = runStampContract(f.regDb);
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected);
  } finally {
    f.cleanup();
  }
});

// Sol re-check of af99713: fences close only on the SAME character with a run at least as long
// (CommonMark), and an indented fenced block is part of the list item it continues.
test('stamp-contract: a ``` example containing a ~~~ line, then an exact Knowledge bullet STILL inside the fence, is never an anchor — the bullets land after the REAL one', () => {
  const f = stampFixture('fence-mixed', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(KNOWLEDGE_LEAD));
    const fence = `\n## Example\n\n\`\`\`md\n~~~\n${knowledge}\n\`\`\`\n`;
    const [first, ...rest] = complete.split('\n');
    const withFence = [first, fence, ...rest].join('\n');
    return { planted: dropBlock(dropBlock(withFence, CODEX_LEAD), READY_LEAD), expected: withFence };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'a ~~~ line does not close a ``` fence; the fenced copy stays untouched');
  } finally {
    f.cleanup();
  }
});

test('stamp-contract: a valid anchor whose item continues with an INDENTED fenced code block gets the insert after that block, never re-parenting it under the new bullet', () => {
  const f = stampFixture('fence-continuation', (complete) => {
    const knowledge = complete.split('\n').find((l) => l.startsWith(KNOWLEDGE_LEAD));
    // In the render the Codex line directly follows Knowledge, so here it follows the fenced block.
    const withBlock = complete.replace(knowledge, `${knowledge}\n\n  \`\`\`sh\n  echo example\n\n  - not a bullet\n  \`\`\``);
    return { planted: dropBlock(withBlock, CODEX_LEAD), expected: withBlock };
  });
  try {
    const r1 = runStampContract(f.regDb);
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'Codex lands after the closing fence of the item\'s code block');
    const r2 = runStampContract(f.regDb);
    assert.ok(!/inserted|updated|renamed/.test(r2.stdout), `second run writes nothing:\n${r2.stdout}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected);
  } finally {
    f.cleanup();
  }
});

const SOLVE_LEAD = "- **Solve, don't board.**";
const CLOSE_LEAD = '- **Close-on-commit: a commit that fulfils a board item pays it**';
test('stamp-contract: Solve and Close-on-commit bullets under their OLD leads are recognised through RENAMED_LEADS — refused as hand-tuned, never given a duplicate under the new lead, file byte-identical, exit 2', () => {
  const f = stampFixture('old-board-leads', (complete) => {
    const lines = complete.split('\n');
    const solve = lines.findIndex((l) => l.startsWith(SOLVE_LEAD));
    const close = lines.findIndex((l) => l.startsWith(CLOSE_LEAD));
    assert.ok(solve >= 0 && close >= 0, 'fixture sanity: the render carries both new leads');
    lines[solve] = "- **Solve, don't board** inside the current task's scope: fix a finding in-session, board only what cannot be done now and say why.";
    lines[close] = '- **Close-on-commit:** a commit that fulfils a board item pays it — `board_remove` in the same breath, citing the commit.';
    const planted = lines.join('\n');
    return { planted, expected: planted };
  });
  try {
    const r = runStampContract(f.regDb);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /HAND_TUNED_REFUSED\s+- \*\*Solve, don't board\./);
    assert.match(r.stdout, /HAND_TUNED_REFUSED\s+- \*\*Close-on-commit: a commit/);
    assert.ok(!/inserted|would_insert/.test(r.stdout), `no insert beside an old-lead bullet:\n${r.stdout}`);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'the old-lead bullets are left byte-for-byte untouched');
  } finally {
    f.cleanup();
  }
});

// ---- the Domains section (TARGET_SECTIONS in scripts/lib/contract-bullets.mjs) ----
// An AGENTS.md written before the section existed gets the whole section, heading included,
// ahead of its Conventions heading; after that its bullets are ordinary tracked leads.

const DOMAINS_SECTION = /## Domains\n[\s\S]*?(?=## Conventions)/;
const DOMAIN_DESCRIPTION_LEAD = '- **A domain needs a description**';

function sectionFixture(name, mutateAgents) {
  const scratch = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  const regDb = join(scratch, 'registry.db');
  const dir = mkdtempSync(join(tmpdir(), `sterling-stamp-${name}-`));
  writeCompleteSibling(dir, name);
  const complete = { agents: readFileSync(join(dir, 'AGENTS.md'), 'utf8'), claude: readFileSync(join(dir, 'CLAUDE.md'), 'utf8') };
  assert.match(complete.agents, DOMAINS_SECTION, 'fixture sanity: the rendered template carries the Domains section');
  writeFileSync(join(dir, 'AGENTS.md'), mutateAgents(complete.agents));
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
  return { regDb, complete, read, cleanup };
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
  const NOTES_LEAD = "- **Notes are the user's surface.**";
  const oldBlock = JSON.parse(readFileSync(join(root, 'bin', 'contract-history.json'), 'utf8'))[NOTES_LEAD][0];
  assert.ok(oldBlock?.startsWith(NOTES_LEAD), 'fixture sanity: a historical block under the old lead');
  const f = stampFixture('rename-anchor', (complete) => {
    const lines = dropBlock(dropBlock(complete, CODEX_LEAD), READY_LEAD).split('\n');
    const i = lines.findIndex((l) => l.startsWith(KNOWLEDGE_LEAD));
    assert.notEqual(i, -1);
    lines[i] = oldBlock;
    const planted = lines.join('\n');
    const codex = complete.split('\n').find((l) => l.startsWith(CODEX_LEAD));
    const ready = complete.split('\n').find((l) => l.startsWith(READY_LEAD));
    const out = [...lines];
    out.splice(i + 1, 0, codex, ready);
    return { planted, expected: out.join('\n') };
  });
  try {
    const r = runStampContract(f.regDb, ['--apply-inserts']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /would_rename {2}- \*\*Knowledge is born structured\./);
    assert.match(r.stdout, /inserted {2}- \*\*Codex runs through the MCP tool/);
    assert.match(r.stdout, /inserted {2}- \*\*Say `READY TO CLEAR`/);
    assert.equal(readFileSync(f.claudePath, 'utf8'), f.expected, 'the old block is byte-for-byte kept, with the two new bullets after it');
  } finally {
    f.cleanup();
  }
});

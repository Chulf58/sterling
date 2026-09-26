// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// 161e2972): each TARGET_LEADS bullet propagates into whichever template CURRENTLY carries
// it — AGENTS.md for a tool-agnostic lead, CLAUDE.md for a Sterling-bound one — and a sibling
// lacking AGENTS.md entirely is reported not_migrated rather than partially patched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';

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
  return readFileSync(join(root, rel), 'utf8')
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

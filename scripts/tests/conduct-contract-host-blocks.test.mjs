// The Sterling layer as one source with host blocks (decision
// sterling-layer-is-one-source-with-host-blocks): templates/target-claude-md.md carries
// claude-only / opencode-only blocks. Its Claude render is what init writes to CLAUDE.md and
// what stamp-contract propagates, byte-identical to the template before the blocks. The
// OpenCode server plugin renders the project's own CLAUDE.md for OpenCode, swapping each
// template claude-only block for its opencode-only partner and saying out loud what it
// could not map.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderClaudeText, validateFences, FENCE_KINDS } from '../lib/agent-fences.mjs';
import { readTemplateBullets, extractTemplateBlock, TARGET_LEADS } from '../lib/contract-bullets.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(repo, 'templates', 'target-claude-md.md');
// sha256 of templates/target-claude-md.md before the host blocks (a2f5c31). The Claude render
// must stay byte-identical to it until a deliberate wording change moves this pin.
// Moved 2026-11-19 (from c26bc2bb…): the two Codex lane bullets left the template (decision
// decommission-the-codex-model-setting-codex-is-no-longer-used).
// Moved 2026-10-02 (from 3b6c6d1e…): the deliberate rewrite of the "Stamp Sterling's version when
// reporting on Sterling" bullet for report-issue.mjs (decision
// projects-file-sterling-issues-as-scrubbed-github-issues-automatically).
// Moved 2026-10-03 (from cea77543…): one sentence added to each "Codex runs through the MCP tool"
// bullet, saying every Codex brief forbids reading or writing under .sterling/ (decision
// codex-reaching-around-the-store-guard-is-documented-and-codex-lanes-stay-narrow).
// Moved 2026-10-03 (from 1a96cf4e…): one bullet added to Reconcile-always, "Author records to be
// found" (decision make-records-findable-authoring-rule-disclosure-lint-then-blind-experiment).
// Moved 2026-10-03 (from e5c76140…): the "Solve, don't board" bullet gains one sentence, a multi-area
// ask is split into one-area mergeable items (decision board-asks-split-at-intake-into-mergeable-one-area-items).
// Moved 2026-10-03 (from e027f809…): the instruction audit fixes (finding
// instruction-file-audit-against-code-and-rulings-october-2026). The "Dispatch briefs declare
// territory" bullet cites the live decision h22-dispatch-files-from-review-territory-and-resume-inherits-prior-round
// in place of a slug no store holds, and "Knowledge is born structured" says the background worker
// closes already-paid reconcile_needed items and /sterling:drain works the rest.
// Moved 2026-10-03 (from ca88355f…): three changes the user ruled through the question form.
// A new bullet, "A ruling exists only if it came through the question form". The preflight bullet
// gains the phrasing rule (decision
// pull-quality-closed-at-the-floor-of-retrieval-mechanics-phrasing-rule-no-new-mechanism). The
// sparring bullet says one consult before a non-trivial design settles and that a diff goes to one
// reviewer, and the "TWO-ROUND ADVERSARIAL DESIGN SPARRING" bullet is removed.
// Moved 2026-10-04 (from b37e87bf…): the concept_designed and report-issue commands name
// node "<Sterling root>/bin/<name>.mjs" and say the root is the path the STERLING ROOT line printed
// at session start, because ${CLAUDE_PLUGIN_ROOT} is not in the Bash tool's environment (decision
// session-start-prints-the-sterling-root-plain-text-instructions-use-it; GitHub issue #16).
// Moved 2026-10-04 (from d148b6e3…): the Claude Code "Codex runs through the MCP tool" bullet says the
// pinned Codex 0.153.4 MCP server is the one supported route and that an absent `codex` tool is
// reported and its lane skipped (decision codex-route-stays-the-pinned-0-153-4-mcp-server; GitHub
// issue #18). The OpenCode bullet already said so.
// Moved 2026-10-10 (from 000cd9b3…): the auto-report bullet's lead is renamed from "Stamp Sterling's
// version when reporting on Sterling" to "Report Sterling defects to its GitHub issues without asking".
// Moved 2026-10-13 (from 97aab1a6…): the Claude Code "Codex runs through the MCP tool" bullet gains the
// dropped-server recovery, the user runs /mcp reconnect all and the call is retried once before the
// Opus or Fable fallback (GitHub issue #87; finding why-do-the-codex-mcp-tools-vanish-for-the-rest-of-a-claude-c).
// Moved 2026-10-14 (from 3ff5644b…): the same bullet gains `features: {view_image: false}` in the per-call
// config, with the reason (an image result can push one MCP message past Claude Code's 16 MB stdio limit
// and Claude Code then drops the server) and the note that `tools.view_image` does not work on 0.153.4
// (GitHub issue #90).
// Moved 2026-10-20 (from 35f1120f…): the same bullet reviews on `gpt-6.1-sol` and gains the loud
// fallback, on the ChatGPT-account 400 say so, retry once on `gpt-5.6-sol`, then review on Opus and
// tell the user to check the Codex login (decision
// claude-code-sol-route-defaults-to-gpt-6-1-sol-with-loud-fallback; GitHub issue #165).
// Moved 2026-10-20 again (from 5614a345…): GitHub issue #169 reverses that ruling. The bullet
// reviews on `gpt-5.6-sol` because the Codex MCP route is frozen at client 0.153.4 and cannot reach
// `gpt-6.1-sol`; on a refusal it says so, reviews on Opus and names the Codex login, with no retry
// on another Sol id (decision claude-code-sol-route-uses-gpt-5-6-sol-because-mcp-route-is-frozen-at-0-153-4).
// Moved 2026-10-27 (from 122d1c92…): the Close-on-commit bullet says a user task's board_remove
// takes an outcome, which the removal journal keeps (decision
// board-issue-mirror-design-required-outcome-snapshot-read-single-writer; board 2460ad0a).
// Moved 2026-11-18 (from 43ad4242…): the sparring fallback is Sol, then Opus 5.5, replacing Fable, in the
// two bullets that named it (user-ruled 2026-11-18, GitHub issue #309; decision
// sparring-steps-down-astra-sol-opus-5-5-replaces-fable).
// Moved 2026-11-19 (from 54e6d215…): the instruction-file proposal bullet always targets AGENTS.md, since
// CLAUDE.md and GEMINI.md hold only Sterling's generated layer (user-ruled 2026-11-19, decision
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer; GitHub issue #319).
const PRE_BLOCKS_CLAUDE_RENDER_SHA = '878646342ba6e1e2f26438e632f35f354adb77ab62ad08ca2d0846e280b1040f';
// What the OpenCode model can never act on. An unmapped /sterling:<name> is checked separately.
const CLAUDE_ONLY = ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear', 'AskUserQuestion'];
const MARKERS = Object.values(FENCE_KINDS).flatMap((f) => [f.open, f.close]);

let layer;
before(async () => {
  layer = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'layer.mjs')).href);
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const template = () => readFileSync(TEMPLATE, 'utf8');

function project(claudeMd) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-layer-blocks-'));
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'blocks-proj' }));
  if (claudeMd !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const initRender = (name = 'blocks-proj') => renderClaudeText(template(), 'target-claude-md.md').replaceAll('{{PROJECT_NAME}}', name);
const bodyOf = (rendered) => rendered.slice(0, rendered.indexOf('\n## OpenCode host'));

test('the Claude render of the template is byte-identical to the template before the host blocks', () => {
  assert.equal(sha(renderClaudeText(template(), 'target-claude-md.md')), PRE_BLOCKS_CLAUDE_RENDER_SHA);
});

test('the template fences are valid and every claude-only block is paired, except the @AGENTS.md import', () => {
  assert.deepEqual(validateFences(template(), 'target-claude-md.md', { allHosts: true }), []);
  const pairs = layer.hostBlockPairs(template());
  assert.equal(pairs.length, 13, 'the import plus the 12 lines the old phrase map rewrote (the Sol, Astra and Terra pair left with Codex)');
  const unpaired = pairs.filter((p) => p.opencode.length === 0).map((p) => p.claude.join('\n'));
  assert.deepEqual(unpaired, ['@AGENTS.md'], 'only the import has no OpenCode text: OpenCode reads AGENTS.md natively');
});

test('the OpenCode render of an init-written CLAUDE.md carries no Claude-only phrase, no fence marker and no claude-only block text', () => {
  const p = project(initRender());
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    for (const t of CLAUDE_ONLY) assert.ok(!out.includes(t), `OpenCode render carries ${t}`);
    for (const m of MARKERS) assert.ok(!out.includes(m), `OpenCode render carries the marker ${m}`);
    assert.ok(!out.includes('{{'), 'no placeholder survives');
    assert.doesNotMatch(out, /^@AGENTS\.md$/m, 'the import line is dropped: OpenCode reads AGENTS.md natively');
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/, 'a pristine CLAUDE.md maps cleanly, so nothing is flagged');
    for (const pair of layer.hostBlockPairs(template())) {
      for (const line of pair.claude) assert.ok(!out.includes(line), `claude-only line reached OpenCode: ${line.slice(0, 80)}`);
    }
    for (const m of out.matchAll(/\/sterling:([a-z][a-z-]*)/g)) {
      assert.ok(out.slice(m.index, m.index + 200).includes(`${root}/commands/${m[1]}.md`), `/sterling:${m[1]} is mapped to its command file`);
    }
  } finally {
    p.cleanup();
  }
});

test('every mapping the old phrase map carried has its OpenCode text in the render', () => {
  const p = project(initRender());
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    const expected = {
      'conductor-install': '.opencode/agents/sterling/conductor.md',
      'delivery-h19': 'on OpenCode the Sterling plugin appends it to the results of the read, edit, write and patch tools, and adds pointers for the paths a shell command names',
      'concept-designed-h10': `node "${root}/bin/concept-designed.mjs" --family <slug>`,
      'wired-h7-h10': 'On OpenCode the Sterling plugin settles each finished turn',
      'settle-four-duties': 'The four duties H10 holds on Claude Code are minted too',
      'concept-designed-settle': "on OpenCode the plugin's turn settlement holds it",
      'ask-question-tool': "through OpenCode's `question` tool.**",
      'ask-question-form': 'goes through the `question` tool form',
      'de-ai-skill': `Run the de-ai-writing skill (\`${root}/skills/de-ai-writing/SKILL.md\`)`,
      'de-ai-scanner': `node "${root}/skills/de-ai-writing/scripts/check-ai-signs.mjs" <file>`,
      'review-territory-h22': 'OpenCode has no H22; the line is still required',
      'store-guard-h15': "the Sterling plugin's evaluate hook denies a shell command with a write shape aimed at the store while letting reads through",
      'platform-mechanics': "OpenCode's plugin hooks, agent files and config move between versions",
      // Codex is removed (decision decommission-the-codex-model-setting-codex-is-no-longer-used): the
      // entries that pinned the native Sol/Astra/Terra route and the codex route sentences went with the
      // two template bullets, and the one remaining lane bullet lives in AGENTS.md (checked below).
      'ready-for-new-session': '- **Say `READY FOR NEW SESSION` plainly when it is time.**',
      'version-banner': `read it from \`${root}/.claude-plugin/plugin.json\``,
      'agent-currency': 'on OpenCode say that no agent-currency check ran',
      'strict-mcp-config': '- **On Claude Code, a user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.**',
    };
    for (const [id, text] of Object.entries(expected)) assert.ok(out.includes(text), `${id}: OpenCode text missing: ${text}`);
    assert.match(out, /`node "[^"]+\/bin\/rotation-note\.mjs"`.*\/new/s, 'the new-session line names rotation-note by root and /new');
    for (const codexRoute of ['uses the `codex` MCP tool', 'only when a `codex` MCP server is configured', '`sandbox` (`read-only`', 'How OpenCode handles a long Codex call', 'openai/gpt-']) {
      assert.ok(!out.includes(codexRoute), `the OpenCode render still routes a lane through the codex MCP tool: ${codexRoute}`);
    }
    // Codex is removed (decision decommission-the-codex-model-setting-codex-is-no-longer-used): the Claude
    // render no longer carries the codex route or the Sol/Astra/Terra dispatch bullet either.
    const claude = renderClaudeText(template(), 'target-claude-md.md');
    for (const gone of ['`codex` MCP tool', 'Codex runs through the MCP tool', 'openai/', 'sterling/reviewer', 'gpt-5.6-sol']) {
      assert.ok(!claude.includes(gone), `the Claude render still carries ${gone}`);
    }
  } finally {
    p.cleanup();
  }
});

// This repo's reviewer and sparring lane rule is ONE host-neutral bullet in AGENTS.md "Project rules"
// (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer). Codex is
// not used (decision decommission-the-codex-model-setting-codex-is-no-longer-used), so no instruction
// file carries a codex route or a pinned openai model.
test("this repo's AGENTS.md: one host-neutral lane bullet names the sterling/reviewer and sterling/sparring dispatches, and no instruction file carries a codex route", () => {
  const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  const claudeMd = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
  const bullets = agents.split('\n').filter((l) => l.startsWith('- **Reviewer and sparring lanes are `sterling/reviewer`'));
  assert.equal(bullets.length, 1, 'exactly one lane bullet in AGENTS.md');
  assert.ok(!bullets[0].includes('<!--'), 'no fence marker: AGENTS.md is read raw by every host');
  assert.ok(bullets[0].includes('Codex is not used'), 'the bullet says Codex is not used');
  assert.ok(!agents.includes('`codex` MCP tool') && !agents.includes('openai/gpt-'), 'AGENTS.md carries no codex route or pinned openai model');
  assert.ok(!claudeMd.includes('openai/gpt-') && !claudeMd.includes('Codex runs through the MCP tool'), 'CLAUDE.md carries neither route');
});

test("the OpenCode layer is the template's opencode-only text plus the host tail: a project's CLAUDE.md, in any form, no longer feeds it (GitHub #329)", () => {
  const own = '- **Deploys go through the blue lane.** PROJECT-BULLET-QUARTZ: never push to prod by hand.';
  const edited = project(`${initRender()}\n${own}\n`);
  const crlf = project(initRender().replace(/\n/g, '\r\n'));
  const bare = project();
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(bare.dir, root);
    assert.equal(layer.renderSterlingLayer(edited.dir, root), out, 'an edited CLAUDE.md changes nothing');
    assert.equal(layer.renderSterlingLayer(crlf.dir, root), out, 'a CRLF CLAUDE.md changes nothing');
    assert.ok(!out.includes('PROJECT-BULLET-QUARTZ'));
    assert.doesNotMatch(out, /^## Authority/m, 'the shared rules are in AGENTS.md, not injected again');
    assert.match(out, /^## Sterling layer on OpenCode/m);
    assert.match(out, /^## OpenCode host/m);
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
  } finally {
    edited.cleanup();
    crlf.cleanup();
    bare.cleanup();
  }
});

test('stamp-contract reads the Claude render: no tracked bullet carries a fence marker or OpenCode text', () => {
  const { current } = readTemplateBullets(repo);
  const claude = renderClaudeText(template(), 'target-claude-md.md');
  for (const lead of TARGET_LEADS) {
    const block = current.get(lead);
    for (const m of MARKERS) assert.ok(!block.includes(m), `${lead}: carries ${m}`);
    if (claude.includes(lead)) assert.ok(claude.includes(block), `${lead}: the propagated block is the Claude render's`);
  }
  assert.equal(extractTemplateBlock(template(), '- **Say `READY TO CLEAR` plainly when it is time.**').block.includes('READY FOR NEW SESSION'), false);
});


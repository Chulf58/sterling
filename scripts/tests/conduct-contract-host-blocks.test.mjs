// The Sterling layer as one source with host blocks (decision
// sterling-layer-is-one-source-with-host-blocks): templates/target-claude-md.md carries
// claude-only / opencode-only blocks. Its Claude render is what init writes to CLAUDE.md and
// what stamp-contract propagates, byte-identical to the template before the blocks. The
// OpenCode server plugin renders the project's own CLAUDE.md for OpenCode, swapping each
// template claude-only block for its opencode-only partner and saying out loud what it
// could not map.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const PRE_BLOCKS_CLAUDE_RENDER_SHA = '000cd9b3e1d09d5d3a92e64eb74f5abec85090e4d1229f84a02a25e6e91a697d';
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
  assert.deepEqual(validateFences(template(), 'target-claude-md.md'), []);
  const pairs = layer.hostBlockPairs(template());
  assert.equal(pairs.length, 14, 'the import plus the 13 lines the old phrase map rewrote');
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
      // GitHub issue #24 (user-ruled 2026-10-05 through the question form): the OpenCode bullet
      // no longer routes these lanes through a codex MCP server, so the two entries that pinned
      // that wording ('codex-availability', 'codex-background') are replaced by the native route.
      'native-review': 'agent `sterling/reviewer` with `model` `openai/gpt-5.6-sol#high` to review',
      'native-sparring': '`openai/gpt-6-astra#high` to spar',
      'native-implement': 'agent `sterling/implementor` with `model` `openai/gpt-5.6-terra` to implement',
      'native-no-sandbox': 'do not modify the worktree',
      'native-model-standing': 'Setting `model` on these dispatches is a standing user instruction',
      'codex-claude-code-only': 'The `codex` MCP tool is the Claude Code route only',
      'codex-ruling-2026-09-20': '*"Add that to all instruction files, that we use the codex mcp over whatever you were doing"*',
      'codex-ruling-2026-10-05': 'narrowed to Claude Code on 2026-10-05',
      'openai-not-logged-in': 'If the openai provider is not logged in, say so and use the fallbacks',
      'ready-for-new-session': '- **Say `READY FOR NEW SESSION` plainly when it is time.**',
      'version-banner': `read it from \`${root}/.claude-plugin/plugin.json\``,
      'agent-currency': 'on OpenCode say that no agent-currency check ran',
      'strict-mcp-config': '- **On Claude Code, a user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.**',
    };
    for (const [id, text] of Object.entries(expected)) assert.ok(out.includes(text), `${id}: OpenCode text missing: ${text}`);
    assert.match(out, /`node "[^"]+\/bin\/rotation-note\.mjs"`.*\/new/s, 'the new-session line names rotation-note by root and /new');
    for (const codexRoute of ['uses the `codex` MCP tool', 'only when a `codex` MCP server is configured', '`sandbox` (`read-only`', 'How OpenCode handles a long Codex call']) {
      assert.ok(!out.includes(codexRoute), `the OpenCode render still routes a lane through the codex MCP tool: ${codexRoute}`);
    }
    const claude = renderClaudeText(template(), 'target-claude-md.md');
    assert.ok(claude.includes('uses the `codex` MCP tool (the pinned Codex 0.153.4 MCP server is the one supported route'), 'the Claude render keeps the codex MCP route');
    assert.ok(!claude.includes('openai/') && !claude.includes('sterling/reviewer'), 'the native OpenCode route does not reach the Claude render');
  } finally {
    p.cleanup();
  }
});

// This repo's own CLAUDE.md fences its Codex bullet itself (decision
// sterling-repo-claude-md-restamp-template-bullets-fence-only-project-specific), so its OpenCode
// render is checked apart from the template's (GitHub issue #24).
test("this repo's CLAUDE.md: the OpenCode render names the native route, the Claude render keeps the codex MCP route", () => {
  const own = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
  const p = project(own);
  try {
    const out = layer.renderSterlingLayer(p.dir, layer.sterlingRoot());
    for (const text of ['sterling/reviewer', 'openai/gpt-5.6-sol#high', 'openai/gpt-6-astra#high', 'sterling/implementor', 'openai/gpt-5.6-terra', 'The `codex` MCP tool is the Claude Code route only', 'narrowed to Claude Code on 2026-10-05', 'do not modify the worktree']) {
      assert.ok(out.includes(text), `OpenCode render of CLAUDE.md lacks ${JSON.stringify(text)}`);
    }
    for (const codexRoute of ['uses the `codex` MCP tool', 'only when a `codex` MCP server is configured', '`sandbox` (`read-only`']) {
      assert.ok(!out.includes(codexRoute), `OpenCode render of CLAUDE.md still carries ${JSON.stringify(codexRoute)}`);
    }
    assert.doesNotMatch(out, /opencode-only block at CLAUDE\.md:\d+ does not open with "On OpenCode,"/);
    const claude = renderClaudeText(own, 'CLAUDE.md');
    assert.ok(claude.includes('uses the `codex` MCP tool (the pinned Codex 0.153.4 MCP server is the one supported route'), 'the Claude render keeps the codex MCP route');
    assert.ok(!claude.includes('openai/gpt-'), 'the native OpenCode route does not reach the Claude render');
  } finally {
    p.cleanup();
  }
});

test("a project's own Sterling bullet reaches the OpenCode render, and a project without CLAUDE.md gets the template", () => {
  const own = '- **Deploys go through the blue lane.** PROJECT-BULLET-QUARTZ: never push to prod by hand.';
  const p = project(initRender().replace('## Plugin mechanics', `${own}\n\n## Plugin mechanics`));
  const bare = project();
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    assert.ok(out.includes(own), 'the project bullet is injected verbatim');
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.equal(bodyOf(layer.renderSterlingLayer(bare.dir, root)), bodyOf(out).replace(`${own}\n\n`, ''), 'no CLAUDE.md renders the template as init would have written it');
  } finally {
    p.cleanup();
    bare.cleanup();
  }
});

test('a CRLF CLAUDE.md maps the same as its LF form', () => {
  const lf = project(initRender());
  const crlf = project(initRender().replace(/\n/g, '\r\n'));
  try {
    const root = layer.sterlingRoot();
    assert.equal(layer.renderSterlingLayer(crlf.dir, root), layer.renderSterlingLayer(lf.dir, root));
  } finally {
    lf.cleanup();
    crlf.cleanup();
  }
});

test('what cannot be mapped is loud: a Claude-only phrase in a project bullet, an unknown /sterling: command, and a template block the project changed', () => {
  const tuned = initRender().replace('plainly when it is time.** At a clean boundary', 'plainly when it is time.** At any clean boundary');
  const p = project(`${tuned}\n- ask through AskUserQuestion, then run /clear and \`/sterling:nosuch\`\n`);
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    const check = out.slice(out.indexOf('STERLING LAYER HOST CHECK'));
    assert.ok(out.startsWith('STERLING LAYER HOST CHECK'), 'the warning leads the layer, before the rules it qualifies');
    for (const t of ['READY TO CLEAR', 'AskUserQuestion', '/clear']) assert.match(check, new RegExp(`Claude-only phrase.*${t.replace('/', '\\/')}`, 's'), `${t} is named`);
    assert.match(check, /\/sterling:nosuch.*commands\/nosuch\.md/s, 'the unknown command is named with the file that is missing');
    assert.match(check, /not found verbatim.*Say `READY TO CLEAR` plainly/s, 'the template block the project changed is named by its first line');
  } finally {
    p.cleanup();
  }
});

test("a template bullet the project wrapped in its own host blocks is not flagged, and a bullet the project deleted is not flagged", () => {
  const lead = '- **Say `READY TO CLEAR` plainly when it is time.**';
  const tunedLine = `${lead} At any clean boundary, print it.`;
  const fenced = ['<!-- claude-only -->', tunedLine, '<!-- /claude-only -->', '<!-- opencode-only -->', '- **On OpenCode, say `READY FOR NEW SESSION` plainly when it is time.** OWN-OPENCODE-WORDING.', '<!-- /opencode-only -->'].join('\n');
  const base = initRender();
  const line = base.split('\n').find((l) => l.startsWith(lead));
  const wrapped = project(base.replace(line, fenced));
  const deleted = project(base.replace(`${line}\n`, ''));
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(wrapped.dir, root);
    assert.ok(out.includes('OWN-OPENCODE-WORDING') && !out.includes('READY TO CLEAR'));
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.doesNotMatch(layer.renderSterlingLayer(deleted.dir, root), /STERLING LAYER HOST CHECK/);
  } finally {
    wrapped.cleanup();
    deleted.cleanup();
  }
});

test("a project's own host blocks in CLAUDE.md are rendered for OpenCode", () => {
  const own = (oc) => ['<!-- claude-only -->', '- Run CLAUDE-OWN-ONLY via Claude.', '<!-- /claude-only -->', '<!-- opencode-only -->', oc, '<!-- /opencode-only -->'].join('\n');
  const p = project(`${initRender()}\n${own('- On OpenCode, run OPENCODE-OWN-ONLY.')}\n`);
  // Claude Code reads CLAUDE.md raw, so a project's opencode-only block must say it is for OpenCode.
  const unmarked = project(`${initRender()}\n${own('- Run OPENCODE-OWN-ONLY.')}\n`);
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    assert.ok(out.includes('OPENCODE-OWN-ONLY') && !out.includes('CLAUDE-OWN-ONLY'));
    for (const m of MARKERS) assert.ok(!out.includes(m));
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.match(layer.renderSterlingLayer(unmarked.dir, root), /^STERLING LAYER HOST CHECK.*opencode-only block at CLAUDE\.md:\d+ does not open with "On OpenCode,"/s);
  } finally {
    p.cleanup();
    unmarked.cleanup();
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

test('swapBlocks refuses a pair with no claude lines instead of looping on it', () => {
  // [].every() is true at every index, so an unguarded swap of an empty claude block splices
  // forever. Run it in a child with a timeout: a hang fails the test instead of the suite.
  const layerUrl = pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'layer.mjs')).href;
  const script = `const { swapBlocks } = await import(${JSON.stringify(layerUrl)});
try { swapBlocks(['a', 'b'], [{ claude: [], opencode: ['x'] }]); console.log('RETURNED'); }
catch (err) { console.log('THREW ' + err.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.signal, null, `swapBlocks did not finish within the timeout (killed by ${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^THREW .*no claude lines/m);
});

test('swapBlocks still swaps every occurrence of a non-empty block', () => {
  const lines = ['a', 'c1', 'c2', 'b', 'c1', 'c2'];
  assert.deepEqual(layer.swapBlocks(lines, [{ claude: ['c1', 'c2'], opencode: ['o'] }, { claude: ['missing'], opencode: [] }]), ['missing']);
  assert.deepEqual(lines, ['a', 'o', 'b', 'o']);
});

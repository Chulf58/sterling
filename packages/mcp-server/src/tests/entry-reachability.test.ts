// Feature-article state honesty, the wiring half (decision
// feature-article-states-follow-the-spec-meaning; board a11fea72):
// built = code exists but nothing reaches it, wired_in = reachable, active = in
// use. An article marks its entry file with files[].entry, and the read-time
// state_review arm looks that file up in the registries:
//   - wired_in/active whose entry no registry reaches -> a state_review item;
//   - wired_in/active with no entry declared -> a state_review item asking for one;
//   - built whose entry IS reached -> a state_review item saying it looks wired_in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { EntryReachability } from '../entry-reachability.js';

const NOW = '2026-10-03T12:00:00.000Z';

const HOOKS_JSON = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/h1-session-start.mjs"' }] }],
  },
});
const BUNDLED_ARTIFACTS = [
  'export const BIN_ENTRIES = {',
  "  'list-projects': 'scripts/list-projects.mjs',",
  "  init: 'scripts/init-impl.mjs',",
  "  'orphan-bin': 'scripts/orphan-bin.mjs',",
  '};',
  '',
].join('\n');
const SERVER_TS = [
  'server.registerTool(',
  "  'knowledge_get',",
  '  {},',
  ');',
  "server.registerTool('board_query', {});",
].join('\n');

function write(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A project tree holding one of each registry Sterling's own repo has. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-entry-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  write(dir, 'hooks/hooks.json', HOOKS_JSON);
  write(dir, 'scripts/hooks/h1-session-start.mjs', '// hook source\n');
  write(dir, 'scripts/hooks/h9-unregistered.mjs', '// hook source nothing registers\n');
  write(dir, 'commands/projects.md', 'Run `node "${CLAUDE_PLUGIN_ROOT}/bin/list-projects.mjs"`.\n');
  write(dir, 'commands/init.md', 'Run `node "${CLAUDE_PLUGIN_ROOT}/bin/init.mjs"`.\n');
  write(dir, 'skills/drain/SKILL.md', '# drain\n');
  write(dir, 'agent-templates/registry.json', JSON.stringify({ version: 1, agents: [{ name: 'scout', file: 'scout.md' }] }));
  write(dir, 'agent-templates/scout.md', '# scout\n');
  write(dir, 'agent-templates/ghost.md', '# not registered\n');
  write(dir, 'scripts/lib/bundled-artifacts.mjs', BUNDLED_ARTIFACTS);
  write(dir, 'scripts/list-projects.mjs', '// bin source\n');
  write(dir, 'scripts/init-impl.mjs', '// bin source\n');
  write(dir, 'scripts/orphan-bin.mjs', '// usage: node bin/orphan-bin.mjs (names itself only)\n');
  write(dir, 'scripts/git-ro.mjs', '// not a bin\n');
  write(dir, 'scripts/check-fresh.mjs', '// dev tool\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/check-fresh.mjs' } }));
  write(dir, 'packages/mcp-server/src/server.ts', SERVER_TS);
  write(dir, 'packages/mcp-server/src/tools.ts', '// tools\n');
  write(dir, 'src/lib.ts', 'export const x = 1;\n');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  return { dir, tools, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type FileEntry = { path: string; role: string; entry?: boolean; unverified?: boolean };

const mkArticle = (tools: SterlingTools, state: string, files: FileEntry[], slug = 'feature') =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files,
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state,
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

const stateReviews = (tools: SterlingTools) =>
  tools.maintenanceQuery({ system_reason: 'state_review', cap: 50 }) as unknown as { id: string; text: string; file_keys?: string[]; feature_link?: string }[];

// ---------------------------------------------------------------------------
// The registry lookups, one kind at a time.
// ---------------------------------------------------------------------------

test('hook: a scripts/hooks source and its hooks/ bundle are reached when hooks.json runs the bundle', () => {
  const { dir, cleanup } = project();
  try {
    const r = new EntryReachability(dir);
    assert.equal(r.judge('scripts/hooks/h1-session-start.mjs', '')?.reached, true);
    assert.equal(r.judge('hooks/h1-session-start.mjs', '')?.reached, true);
    const miss = r.judge('scripts/hooks/h9-unregistered.mjs', '');
    assert.equal(miss?.kind, 'hook');
    assert.equal(miss?.reached, false);
    assert.match(miss?.detail ?? '', /hooks\/hooks\.json/);
    assert.equal(r.judge('scripts/hooks/lib/shared.mjs', ''), null, 'a hook library is not an entry kind the check judges');
  } finally {
    cleanup();
  }
});

test('command and skill: reached by being present where the platform discovers them', () => {
  const { dir, cleanup } = project();
  try {
    const r = new EntryReachability(dir);
    assert.equal(r.judge('commands/projects.md', '')?.reached, true);
    assert.equal(r.judge('commands/gone.md', '')?.reached, false);
    assert.equal(r.judge('skills/drain/SKILL.md', '')?.reached, true);
    assert.equal(r.judge('skills/gone/SKILL.md', '')?.kind, 'skill');
    assert.equal(r.judge('skills/gone/SKILL.md', '')?.reached, false);
  } finally {
    cleanup();
  }
});

test('agent: reached when agent-templates/registry.json lists the file', () => {
  const { dir, cleanup } = project();
  try {
    const r = new EntryReachability(dir);
    assert.equal(r.judge('agent-templates/scout.md', '')?.reached, true);
    assert.equal(r.judge('agent-templates/ghost.md', '')?.reached, false);
  } finally {
    cleanup();
  }
});

test('tool: an entry on server.ts or tools.ts is reached when its role names a registerTool name', () => {
  const { dir, cleanup } = project();
  try {
    const r = new EntryReachability(dir);
    const hit = r.judge('packages/mcp-server/src/tools.ts', 'implements knowledge_get, the full-fidelity read');
    assert.equal(hit?.kind, 'tool');
    assert.equal(hit?.reached, true);
    assert.equal(r.judge('packages/mcp-server/src/server.ts', 'registers `board_query`')?.reached, true);
    const miss = r.judge('packages/mcp-server/src/tools.ts', 'implements knowledge_frobnicate');
    assert.equal(miss?.reached, false);
    assert.match(miss?.detail ?? '', /knowledge_frobnicate/);
    assert.equal(r.judge('packages/mcp-server/src/tools.ts', 'the tool layer')?.reached, false, 'a role naming no tool cannot be checked as reached');
  } finally {
    cleanup();
  }
});

test('script: a bin is reached when BIN_ENTRIES lists it AND a command, skill or script references it', () => {
  const { dir, cleanup } = project();
  try {
    const r = new EntryReachability(dir);
    assert.equal(r.judge('scripts/list-projects.mjs', '')?.reached, true);
    assert.equal(r.judge('scripts/init-impl.mjs', '')?.reached, true, 'the BIN_ENTRIES name (init), not the source basename, is what callers reference');
    assert.equal(r.judge('bin/list-projects.mjs', '')?.reached, true, 'the shipped bundle path works as the entry too');
    const orphan = r.judge('scripts/orphan-bin.mjs', '');
    assert.equal(orphan?.reached, false, 'a bin only its own source names has no caller');
    assert.match(orphan?.detail ?? '', /no command, skill or script references/);
    const notBin = r.judge('scripts/git-ro.mjs', '');
    assert.equal(notBin?.kind, 'script');
    assert.equal(notBin?.reached, false, 'the measured git-ro case: not in BIN_ENTRIES, no npm script');
    assert.equal(r.judge('scripts/check-fresh.mjs', '')?.reached, true, 'a top-level script package.json runs is reached');
  } finally {
    cleanup();
  }
});

test('an entry of a kind no registry covers (a library file) is not judged', () => {
  const { dir, cleanup } = project();
  try {
    assert.equal(new EntryReachability(dir).judge('src/lib.ts', ''), null);
  } finally {
    cleanup();
  }
});

test('a missing registry file reads as not reached and says so, never as a silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-entry-bare-'));
  try {
    const r = new EntryReachability(dir);
    const hook = r.judge('hooks/h1-session-start.mjs', '');
    assert.equal(hook?.reached, false);
    assert.match(hook?.detail ?? '', /hooks\/hooks\.json is missing/);
    write(dir, 'agent-templates/registry.json', '{not json');
    const agent = new EntryReachability(dir).judge('agent-templates/scout.md', '');
    assert.equal(agent?.reached, false);
    assert.match(agent?.detail ?? '', /registry\.json could not be parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The state_review triggers, through the read path that mints them.
// ---------------------------------------------------------------------------

test('active with a reached entry raises nothing', () => {
  const { tools, cleanup } = project();
  try {
    mkArticle(tools, 'active', [{ path: 'skills/drain/SKILL.md', role: 'the SOP', entry: true }]);
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('wired_in or active with an entry nothing reaches raises state_review naming the article, the entry and "not reached"', () => {
  for (const state of ['active', 'wired_in']) {
    const { tools, cleanup } = project();
    try {
      const art = mkArticle(tools, state, [
        { path: 'scripts/hooks/h9-unregistered.mjs', role: 'the hook', entry: true },
        { path: 'src/lib.ts', role: 'helpers' },
      ], 'unwired-hook');
      tools.knowledgeQuery({ types: ['feature_article'] });
      const items = stateReviews(tools);
      assert.equal(items.length, 1, state);
      assert.equal(items[0].feature_link, art.id);
      assert.match(items[0].text, /article 'unwired-hook'/);
      assert.match(items[0].text, new RegExp(`declares state '${state}' but its entry scripts/hooks/h9-unregistered\\.mjs is not reached`));
      assert.match(items[0].text, /wire it in, or knowledge_update the state to 'built'/);
      assert.deepEqual(items[0].file_keys, ['scripts/hooks/h9-unregistered.mjs'], 'keyed to the entry it names');
    } finally {
      cleanup();
    }
  }
});

test('wired_in or active with no entry declared raises state_review asking for one, with the call that sets it', () => {
  const { tools, cleanup } = project();
  try {
    const art = mkArticle(tools, 'wired_in', [{ path: 'skills/drain/SKILL.md', role: 'the SOP' }], 'no-entry');
    tools.knowledgeQuery({ types: ['feature_article'] });
    const items = stateReviews(tools);
    assert.equal(items.length, 1);
    assert.match(items[0].text, /declares state 'wired_in' but marks no files\[\] entry/);
    assert.ok(
      items[0].text.includes(`knowledge_edit(id: '${art.id}', field: 'files[path=<entry path>].entry', find: 'false', replace: 'true')`),
      'names the one targeted call'
    );
  } finally {
    cleanup();
  }
});

test('built whose entry IS reached raises state_review saying it looks wired_in; built with an unreached entry raises nothing', () => {
  const { tools, cleanup } = project();
  try {
    mkArticle(tools, 'built', [{ path: 'commands/projects.md', role: 'the command', entry: true }], 'reached-built');
    mkArticle(tools, 'built', [{ path: 'scripts/orphan-bin.mjs', role: 'the bin', entry: true }], 'honest-built');
    tools.knowledgeQuery({ types: ['feature_article'] });
    const items = stateReviews(tools);
    assert.equal(items.length, 1, 'only the reached one');
    assert.match(items[0].text, /article 'reached-built'/);
    assert.match(items[0].text, /declares state 'built' but its entry commands\/projects\.md is reached \(command file present\) — it looks wired_in/);
  } finally {
    cleanup();
  }
});

test('built or planned with no entry declared raises nothing from the entry check', () => {
  const { tools, cleanup } = project();
  try {
    mkArticle(tools, 'built', [{ path: 'src/lib.ts', role: 'helpers' }], 'b');
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('an active article whose only entry is of an unjudged kind raises nothing', () => {
  const { tools, cleanup } = project();
  try {
    mkArticle(tools, 'active', [{ path: 'src/lib.ts', role: 'helpers', entry: true }]);
    tools.knowledgeQuery({ types: ['feature_article'] });
    assert.equal(stateReviews(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('the entry finding and an unverified role share ONE item per article, minted once across reads', () => {
  const { tools, cleanup } = project();
  try {
    mkArticle(tools, 'active', [
      { path: 'agent-templates/ghost.md', role: 'the agent', entry: true },
      { path: 'src/lib.ts', role: 'not written yet', unverified: true },
    ], 'ghost');
    for (let i = 0; i < 3; i++) tools.knowledgeQuery({ types: ['feature_article'] });
    const items = stateReviews(tools);
    assert.equal(items.length, 1, 'the lane identity is the article');
    assert.match(items[0].text, /agent-templates\/ghost\.md is not reached \(agent-templates\/registry\.json does not list ghost\.md\)/);
    assert.match(items[0].text, /still flagged unverified/);
    assert.deepEqual([...(items[0].file_keys ?? [])].sort(), ['agent-templates/ghost.md', 'src/lib.ts']);
  } finally {
    cleanup();
  }
});

test('knowledge_edit sets an ABSENT entry flag: an absent optional boolean reads as false', () => {
  const { tools, cleanup } = project();
  try {
    const art = mkArticle(tools, 'active', [{ path: 'skills/drain/SKILL.md', role: 'the SOP' }]);
    assert.throws(
      () => tools.knowledgeEdit(art.id, 'files[path=skills/drain/SKILL.md].entry', 'true', 'false'),
      /is false, not 'true'/,
      'find must spell the current value, and absent is false'
    );
    tools.knowledgeEdit(art.id, 'files[path=skills/drain/SKILL.md].entry', 'false', 'true');
    const after = tools.knowledgeGet(art.id) as unknown as { files: FileEntry[] };
    assert.equal(after.files[0].entry, true);
    tools.knowledgeEdit(art.id, 'files[path=skills/drain/SKILL.md].entry', 'true', 'false');
    assert.equal((tools.knowledgeGet(art.id) as unknown as { files: FileEntry[] }).files[0].entry, false);
  } finally {
    cleanup();
  }
});

test('knowledge_edit still refuses an absent sub-field the schema does not declare boolean', () => {
  const { tools, cleanup } = project();
  try {
    const art = mkArticle(tools, 'active', [{ path: 'skills/drain/SKILL.md', role: 'the SOP' }]);
    assert.throws(() => tools.knowledgeEdit(art.id, 'files[path=skills/drain/SKILL.md].nonsense', 'false', 'true'));
  } finally {
    cleanup();
  }
});

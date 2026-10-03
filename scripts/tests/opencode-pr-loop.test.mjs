// The OpenCode 'PR review loop owed' notice (decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code,
// parity P9): a work project whose /sterling:merge armed
// .sterling/transient/pr-loop.json carries the duty as a notice at every
// settlement until pr-review-wait.mjs --settle changes the file, as H10 does on
// Claude Code. The rule is scripts/hooks/lib/pr-loop-duty.mjs, shared with H10.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-10-02T12:00:00.000Z';
const PR_URL = 'https://github.com/acme/widget/pull/7';
const STATE = { pr_url: PR_URL, pr_number: 7, repo: 'github.com/acme/widget', head_sha: 'a'.repeat(40), armed_at: '2026-09-26T10:00:00.000Z', status: 'owed' };
const loopFile = (dir) => join(dir, '.sterling', 'transient', 'pr-loop.json');

let SterlingStore;
let server;
let prLoop;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  server = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'server.mjs')).href);
  prLoop = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'pr-loop.mjs')).href);
});

function makeProject(mode, loop) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-prloop-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(mode === undefined ? {} : { mode }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (loop !== undefined) writeFileSync(loopFile(dir), JSON.stringify(loop));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const noticeTexts = (dir) => (existsSync(join(dir, server.NOTICES_REL)) ? JSON.parse(readFileSync(join(dir, server.NOTICES_REL), 'utf8')).map((n) => n.text) : []);
const markShown = (dir) => {
  const shown = JSON.parse(readFileSync(join(dir, server.NOTICES_REL), 'utf8'));
  writeFileSync(join(dir, server.NOTICES_REL), JSON.stringify(shown.map((n) => ({ ...n, shown_at: NOW }))));
};

test('an owed loop raises a notice with the PR link, the wait command and the settle command', () => {
  const p = makeProject('work', STATE);
  try {
    prLoop.createPrLoopNotice({ now: () => NOW, pluginRoot: '/opt/sterling' })(p.dir);
    const [text, ...rest] = noticeTexts(p.dir);
    assert.equal(rest.length, 0);
    assert.match(text, /PR review loop owed \(work mode\): PR #7 https:\/\/github\.com\/acme\/widget\/pull\/7/);
    assert.match(text, /node "\/opt\/sterling\/bin\/pr-review-wait\.mjs" https:\/\/github\.com\/acme\/widget\/pull\/7 \(background\)/);
    assert.match(text, /--settle <clean\|capped\|escalated> --pr 7/);
  } finally {
    p.cleanup();
  }
});

test('the first notice per arming is the full text; later ones are the short reminder', () => {
  const p = makeProject('work', STATE);
  try {
    const notify = prLoop.createPrLoopNotice({ now: () => NOW, pluginRoot: '/opt/sterling' });
    notify(p.dir);
    markShown(p.dir);
    notify(p.dir);
    const texts = noticeTexts(p.dir);
    assert.equal(texts.length, 2);
    assert.match(texts[0], /^• PR review loop owed \(work mode\)/);
    assert.match(texts[1], /^PR review loop owed: PR #7 .* — next: pr-review-loop skill, then --settle/);
    notify(p.dir);
    assert.equal(noticeTexts(p.dir).length, 2, 'an unshown identical reminder is not stacked');
    writeFileSync(loopFile(p.dir), JSON.stringify({ ...STATE, armed_at: '2026-09-27T10:00:00.000Z' }));
    notify(p.dir);
    assert.match(noticeTexts(p.dir).at(-1), /^• PR review loop owed \(work mode\)/, 're-arming restores the full text');
  } finally {
    p.cleanup();
  }
});

test('hobby, unarmed and settled projects raise nothing', () => {
  for (const [mode, loop] of [['hobby', STATE], ['work', undefined], ['work', { ...STATE, status: 'clean', settled_at: NOW }]]) {
    const p = makeProject(mode, loop);
    try {
      prLoop.createPrLoopNotice({ now: () => NOW, pluginRoot: '/opt/sterling' })(p.dir);
      assert.deepEqual(noticeTexts(p.dir), [], `${mode} ${loop?.status}`);
    } finally {
      p.cleanup();
    }
  }
});

test('a state that cannot be evaluated is disclosed as a notice', () => {
  const p = makeProject('work');
  try {
    writeFileSync(loopFile(p.dir), '{broken');
    prLoop.createPrLoopNotice({ now: () => NOW, pluginRoot: '/opt/sterling' })(p.dir);
    assert.match(noticeTexts(p.dir).join('\n'), /PR review loop: \.sterling\/transient\/pr-loop\.json is unreadable/);
  } finally {
    p.cleanup();
  }
});

test('the plugin raises the notice at an execution end, with or without git, until the loop is settled', async () => {
  const p = makeProject('work', STATE);
  try {
    const plugin = server.createSterlingServer({ claudeOnPath: () => false, sterlingRoot: '/opt/sterling', syncSession: async () => {}, configure: async () => {} });
    const ctx = {
      location: { directory: p.dir },
      // ses_1 is a root session (no parentID): only a root session settles (dispatch.mjs rootSessionGate).
      session: { hook: async () => {}, get: async ({ sessionID }) => ({ id: sessionID, location: { directory: p.dir } }) },
      tool: { hook: async () => {} },
      permission: { hook: async () => {} },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    };
    const cleanup = await plugin.setup(ctx);
    const succeeded = { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } };
    await plugin.handlers.event(succeeded);
    assert.match(noticeTexts(p.dir).join('\n'), /PR review loop owed \(work mode\): PR #7/);
    writeFileSync(loopFile(p.dir), JSON.stringify({ ...STATE, status: 'clean', settled_at: NOW }));
    markShown(p.dir);
    await plugin.handlers.event(succeeded);
    assert.deepEqual(noticeTexts(p.dir), [], 'a settled loop adds no notice and the shown ones are pruned');
    await cleanup();
  } finally {
    p.cleanup();
  }
});

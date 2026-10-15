// Delegated board items in the readiness lines (GitHub issue #105): a tracker
// for a task handed to another project is never READY and never WAITING ON
// YOU; H1 lists it apart with the status the caller resolved, and a caller
// that did not read the other project says so instead of guessing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let lib;
before(async () => {
  lib = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'board-ready.mjs')).href);
});

const item = (id, state, extra = {}) => ({ id, name: `${id} item (${id.slice(0, 8)})`, updated_at: '2026-10-15T12:00:00.000Z', file_keys: [], blockers: [], blockers_open: [], unblocks: [], state, ...extra });
const handoff = { role: 'sent', transfer_id: 't', to_root: '/x/beta', to_name: 'beta', to_item_id: 'b' };
const live = { availability: 'ok', count: 0, descriptions: [] };
const ceiling = { value: 3 };

test('boardGroups: delegated items are their own group, never ready, research or waiting', () => {
  const g = lib.boardGroups([item('aaaaaaaa-1', 'ready'), item('dddddddd-1', 'delegated', { handoff })]);
  assert.deepEqual(g.ready.map((r) => r.id), ['aaaaaaaa-1']);
  assert.deepEqual(g.delegated.map((r) => r.id), ['dddddddd-1']);
  assert.equal(g.waiting.length + g.research.length, 0);
});

test('renderBoardReadiness: a board with only a delegated item still renders, with the resolved status', () => {
  const d = item('dddddddd-1', 'delegated', { handoff });
  const text = lib.renderBoardReadiness({ readiness: [d], live, ceiling, handoffStatus: new Map([[d.id, { state: 'open', text: 'open in beta' }]]) });
  assert.match(text, /DELEGATED TO OTHER PROJECTS \(1, not run here\):\n- dddddddd-1 item \(dddddddd\) — project 'beta': open in beta/);
  assert.doesNotMatch(text, /READY \(/);
});

test('renderBoardReadiness: without resolved statuses a delegated line says its status was not read', () => {
  const text = lib.renderBoardReadiness({ readiness: [item('dddddddd-1', 'delegated', { handoff })], live, ceiling });
  assert.match(text, /project 'beta': status not read here \(board_query shows it\)/);
});

test('boardReadyNotice: a delegated item never reaches the BOARD READY line', () => {
  assert.equal(lib.boardReadyNotice([item('dddddddd-1', 'delegated', { handoff })], '', live, ceiling), null);
});

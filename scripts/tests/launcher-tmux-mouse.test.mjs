// Click-to-focus (fix/tmux-click-to-focus): the tmux launcher scopes `mouse on`
// to the Sterling session only, never globally (-g), so a click on the TUI pane
// moves keyboard focus there without touching the user's own tmux config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = readFileSync(join(root, 'templates', 'launcher-tmux.sh'), 'utf8');

// Strip comment lines (first non-space char '#') so a commented-out
// set-option line can never satisfy the assertions below — only executable
// lines count.
const code = raw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const SET_MOUSE_ON = 'tmux set-option -t "$SESSION" mouse on';

test('launcher-tmux.sh has exactly 3 executable session-scoped mouse-on lines, none global', () => {
  const setOptionLines = code.split('\n').filter((line) => line.includes(SET_MOUSE_ON));
  assert.equal(setOptionLines.length, 3, `expected exactly 3 executable "${SET_MOUSE_ON}" lines, got ${setOptionLines.length}`);

  const globalMouseLines = code.split('\n').filter((line) => /set-option\s+-g\s+mouse/.test(line));
  assert.equal(globalMouseLines.length, 0, 'must never set mouse mode globally (-g) — that would affect the user\'s own tmux sessions outside Sterling');
});

test('launcher-tmux.sh sets mouse on inside each of the three branches, correctly placed', () => {
  const tuiStart = code.indexOf('tui)');
  const upStart = code.indexOf('up)');
  const starStart = code.indexOf('*)');
  assert.ok(tuiStart > -1 && upStart > tuiStart && starStart > upStart, 'expected to locate tui), up), *) branch markers in order');

  // tui) branch: exactly one set-option, before add_tui_pane.
  const tuiSection = code.slice(tuiStart, upStart);
  assert.equal((tuiSection.match(new RegExp(SET_MOUSE_ON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, 'expected exactly 1 mouse-on line in the tui) branch');
  assert.ok(tuiSection.indexOf(SET_MOUSE_ON) < tuiSection.indexOf('add_tui_pane'), 'tui) branch: mouse on must be set before add_tui_pane');

  // up) branch: exactly two set-option lines — one in the re-attach path
  // (before the exec attach), one in the fresh-session path (after new-session).
  const upSection = code.slice(upStart, starStart);
  const upMatches = upSection.match(new RegExp(SET_MOUSE_ON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [];
  assert.equal(upMatches.length, 2, 'expected exactly 2 mouse-on lines in the up) branch');

  const reattachIdx = upSection.indexOf('has-session');
  const execAttachIdx = upSection.indexOf('exec tmux attach-session');
  const newSessionIdx = upSection.indexOf('tmux new-session');
  const firstSetIdx = upSection.indexOf(SET_MOUSE_ON);
  const secondSetIdx = upSection.indexOf(SET_MOUSE_ON, firstSetIdx + 1);

  assert.ok(reattachIdx > -1 && reattachIdx < firstSetIdx && firstSetIdx < execAttachIdx,
    'up) re-attach path: mouse on must be set between has-session check and exec tmux attach-session');
  assert.ok(newSessionIdx > -1 && newSessionIdx < secondSetIdx,
    'up) fresh-session path: mouse on must be set after tmux new-session');
});

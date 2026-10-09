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

// The engine now opens one session per mode through open_session (claude, opencode) and
// adds the pane to the caller's session in tui mode, so the three mouse-on lines are:
// open_session's re-attach path, its fresh-session path, and the tui) branch. $S is the
// session each of them targets (an exact '=name:' target).
const SET_MOUSE_ON = 'tmux set-option -t "=$S:" mouse on';
const count = (text) => text.split(SET_MOUSE_ON).length - 1;

test('launcher-tmux.sh has exactly 3 executable session-scoped mouse-on lines, none global', () => {
  const setOptionLines = code.split('\n').filter((line) => line.includes(SET_MOUSE_ON));
  assert.equal(setOptionLines.length, 3, `expected exactly 3 executable "${SET_MOUSE_ON}" lines, got ${setOptionLines.length}`);
  const anyMouse = code.split('\n').filter((line) => /set-option.*mouse/.test(line));
  assert.equal(anyMouse.length, 3, 'no other mouse set-option line');
  const globalMouseLines = code.split('\n').filter((line) => /set-option\s+-g\s+mouse/.test(line));
  assert.equal(globalMouseLines.length, 0, 'must never set mouse mode globally (-g) — that would affect the user\'s own tmux sessions outside Sterling');
});

test('launcher-tmux.sh sets mouse on in the re-attach path, the fresh-session path and the tui) branch, correctly placed', () => {
  const openStart = code.indexOf('open_session() {');
  const caseStart = code.indexOf('case "$MODE" in');
  const tuiStart = code.indexOf('  tui)', caseStart);
  const starStart = code.indexOf('  *)', caseStart);
  assert.ok(openStart > -1 && caseStart > openStart && tuiStart > caseStart && starStart > tuiStart, 'expected open_session, then case, tui) and *) in order');

  // open_session: one line in the re-attach path (after the running check, before its
  // exec attach), one after tmux new-session.
  const open = code.slice(openStart, caseStart);
  assert.equal(count(open), 2, 'expected exactly 2 mouse-on lines in open_session');
  const runningIdx = open.indexOf('if running "$S"');
  const firstSet = open.indexOf(SET_MOUSE_ON);
  const firstAttach = open.indexOf('exec tmux attach-session');
  const newSession = open.indexOf('tmux new-session');
  const secondSet = open.indexOf(SET_MOUSE_ON, firstSet + 1);
  assert.ok(runningIdx > -1 && runningIdx < firstSet && firstSet < firstAttach && firstAttach < newSession,
    're-attach path: mouse on must be set between the running check and exec tmux attach-session');
  assert.ok(newSession > -1 && newSession < secondSet, 'fresh-session path: mouse on must be set after tmux new-session');

  // tui) branch: exactly one, before add_tui_pane.
  const tui = code.slice(tuiStart, starStart);
  assert.equal(count(tui), 1, 'expected exactly 1 mouse-on line in the tui) branch');
  assert.ok(tui.indexOf(SET_MOUSE_ON) < tui.indexOf('add_tui_pane'), 'tui) branch: mouse on must be set before add_tui_pane');
});

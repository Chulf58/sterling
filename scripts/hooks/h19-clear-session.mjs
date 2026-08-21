// H19 lifecycle — SessionStart clears the delivery state (P4): the
// delivered-guard's TTL is the whole session (grill answer: whole session, no
// expiry), so a NEW session starts with a clean guard and an empty pending
// queue. Per-agent guard files from finished subagents die here too.
//
// EXCEPTION — a rotation-note continuation (board 5a807e68) is NOT a genuine
// new session: the conductor deliberately /clear'd mid-campaign via
// scripts/rotation-note.mjs, and H1 restores that context on this exact
// SessionStart (source=clear). Wiping the guard there would re-deliver
// everything the still-continuing work already saw. The note's presence is
// the signal (H1 consumes it after this hook runs, so it is still here to
// check); the pending queue MAY still clear — its payloads were staged for a
// prompt that will never come now that the session turned over.
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow } from './lib/common.mjs';
import { deliveryDir, pendingPath } from './lib/delivery.mjs';

const input = readStdin();
const dir = deliveryDir(input.cwd);
const rotationNotePath = join(input.cwd, '.sterling', 'transient', 'rotation-note.json');

if (existsSync(rotationNotePath)) {
  const p = pendingPath(input.cwd);
  if (existsSync(p)) rmSync(p, { force: true });
} else if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true });
}
allow();

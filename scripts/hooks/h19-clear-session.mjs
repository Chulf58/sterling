// H19 lifecycle — SessionStart clears the delivery state (P4): the
// delivered-guard's TTL is the whole session (grill answer: whole session, no
// expiry), so a NEW session starts with a clean guard and an empty pending
// queue. Per-agent guard files from finished subagents die here too.
import { rmSync, existsSync } from 'node:fs';
import { readStdin, allow } from './lib/common.mjs';
import { deliveryDir } from './lib/delivery.mjs';

const input = readStdin();
const dir = deliveryDir(input.cwd);
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
allow();

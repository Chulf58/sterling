// H19 lifecycle — delivery receipts expire when compacted context loses them.
// A fresh startup or /clear receives a new session id and therefore a new,
// empty directory; resume continues the same logical session and keeps it.
// This is the delivery-guard sibling of H1's read-evidence clear block.
import { rmSync } from 'node:fs';
import { readStdin, allow } from './lib/common.mjs';
import { deliverySessionDir } from './lib/delivery.mjs';

const input = readStdin();
if (input.source === 'compact') {
  const dir = deliverySessionDir(input.cwd, input.session_id);
  // A null directory means no session identity, so there is no safe target.
  if (dir) rmSync(dir, { recursive: true, force: true });
}
allow();

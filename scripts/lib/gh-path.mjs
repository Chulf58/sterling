// Where `gh` resolves on PATH, shared by every script that runs gh and names
// the binary in its failures (work-mode merge, report-issue, the board issue
// mirror). Store-free and dependency-light, so a small bin/ bundle can import it.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The gh that PATH resolves to (the first hit), or null. Named in every
 * failure line, because on WSL it is often a Windows gh.exe. */
export function resolveGhPath(env = process.env) {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh'] : ['gh', 'gh.exe'];
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

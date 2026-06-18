// Pick a Windows-RUNNABLE path from the output of `where <name>` (init's launcher
// detection, §11/§12). A .bat launcher hands the path to Windows Terminal, which
// CreateProcess-spawns it — so it MUST be a real executable. Prefer a .exe, then
// .cmd/.bat; NEVER an extensionless Unix shim or a .ps1. Node distributions ship
// `claude`, `claude.cmd`, `claude.ps1` side by side: `where` lists the bare shim
// first when that dir leads PATH, and launching it fails with BAD_EXE_FORMAT
// (0x800700c1). PATH order is honoured WITHIN each extension tier; no runnable
// match → undefined, so the caller falls back to the canonical install path.
export function pickRunnable(whereStdout) {
  const lines = String(whereStdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const ext of ['.exe', '.cmd', '.bat']) {
    const hit = lines.find((l) => l.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return undefined;
}

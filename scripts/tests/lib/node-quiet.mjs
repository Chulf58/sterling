// The node flags hooks/hooks.json passes in production, so a test that spawns a hook
// (or any script that loads node:sqlite) runs under the same stderr the user sees.
// Node 24.14 prints an ExperimentalWarning for node:sqlite; without this flag a test
// asserting an empty or exact stderr fails there while production stays quiet.
export const HOOK_NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

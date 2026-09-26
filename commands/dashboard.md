---
description: Open the Sterling TUI dashboard as a split pane in the current terminal window.
---

From the WSL conductor shell (the normal case — the conductor runs in a bash tmux pane), run the launcher's TUI re-opener from the project root: `./sterling-launch.sh tui`. It re-adds the dashboard as a split pane in the project's tmux session — the human can close it any time with `q` and reopen it with this command; no session restart. (`tui.bat` is the human's Windows double-click wrapper around exactly this — not runnable from bash.)

Sterling runs under WSL2 only; the native-Windows launcher (`sterling-windows.bat`) is retired (decision `native-windows-launcher-retired-wsl2-only`) and init no longer generates it. A copy left over from an earlier init is not maintained — launch through `sterling.bat` instead.

If `sterling-launch.sh` does not exist, re-run `/sterling:init` first — the ensure pass regenerates the launchers from `templates/` with machine-detected paths — then run it.

Report only whether the pane opened (or the regeneration outcome). The TUI itself is the output.

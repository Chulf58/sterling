---
description: Open the Sterling TUI dashboard (§11) as a split pane in the current terminal window.
---

From the WSL conductor shell (the normal case — the conductor runs in a bash tmux pane), run the launcher's TUI re-opener from the project root: `./sterling-launch.sh tui`. It re-adds the dashboard as a split pane in the project's tmux session — the human can close it any time with `q` and reopen it with this command; no session restart. (`tui.bat` is the human's Explorer double-click wrapper around exactly this — not runnable from bash.)

Under the native-Windows launcher (`sterling-windows.bat`, option B) there is no tmux session, so this re-opener does not apply — the TUI pane there comes from the Windows Terminal split the launcher itself created; if it was closed, relaunch via the .bat.

If `sterling-launch.sh` does not exist, re-run `/sterling:init` first — the ensure pass regenerates the launchers from `templates/` with machine-detected paths — then run it.

Report only whether the pane opened (or the regeneration outcome). The TUI itself is the output.

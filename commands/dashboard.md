---
description: Open the Sterling TUI dashboard as a split pane in the current terminal window.
---

<!-- claude-only -->
From the WSL conductor shell (the normal case — the conductor runs in a bash tmux pane), run the launcher's TUI re-opener from the project root: `./sterling-launch.sh tui`. It re-adds the dashboard as a split pane in the project's tmux session — the human can close it any time with `q` and reopen it with this command; no session restart. (`tui.bat` is the human's Windows double-click wrapper around exactly this — not runnable from bash.)

Sterling runs under WSL2 only; the native-Windows launcher (`sterling-windows.bat`) is retired (decision `native-windows-launcher-retired-wsl2-only`) and init no longer generates it. A copy left over from an earlier init is not maintained — launch through `sterling.bat` instead.

If `sterling-launch.sh` does not exist, re-run `/sterling:init` first — the ensure pass regenerates the launchers from `templates/` with machine-detected paths — then run it.

Report only whether the pane opened (or the regeneration outcome). The TUI itself is the output.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, the dashboard is the Sterling TUI plugin, already running inside OpenCode, so there is nothing to start. Its summary is a panel in the session sidebar. Open the full view with `<leader>k` (ctrl+x then k by default), with `/sterling`, or with "Open Sterling dashboard" in the command palette; Escape leaves it.

If the sidebar shows no Sterling panel, the TUI plugin is not loaded. The fix depends on where this Sterling came from (its root is named in the Sterling layer). A copy from `opencode plugin add`, under OpenCode's npm cache: tell the user to run `opencode plugin update @chulf58/sterling` and then `/sterling:init` here, which installs the OpenCode plugins. A copy from the Claude Code plugin cache or a clone: tell the user to run `/sterling:update` (or init) in Claude Code, which installs them. Either way, restart OpenCode afterwards.

Report only how to open it. The TUI itself is the output.
<!-- /opencode-only -->

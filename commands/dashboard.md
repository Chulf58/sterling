---
description: Open the Sterling TUI dashboard as a split pane in the current terminal window.
---

<!-- claude-only -->
From the conductor shell (the normal case: the conductor runs in a bash tmux pane), run the launcher engine's TUI mode from the project root: `./sterling-launch.sh tui`. Inside tmux it adds the dashboard as a split pane to the session you are in; the human can close it any time with `q` and reopen it with this command, with no session restart. If that session already shows the TUI, nothing changes. The TUI runs once per project, so if another session of this project (`sterling-<project>-opencode`, say) shows it, the TUI there is stopped and opens here, and the command prints which session lost it. Run outside tmux, it picks `sterling-<project>-claude`, then `sterling-<project>-opencode`, then a session started before the sessions had per-host names, and fails if none of them runs.

The human's own entry points are `claude-code.bat` and `opencode.bat` on Windows (WSL2), `claude-code.sh` and `opencode.sh` on Linux. Opening one again re-attaches to its session and re-adds a closed TUI pane. `sterling.bat`, `tui.bat` and the native-Windows `sterling-windows.bat` are no longer generated; a copy left over from an earlier init is not maintained.

If `sterling-launch.sh` does not exist, re-run `/sterling:init` first (the ensure pass regenerates the launchers from `templates/`), then run it.

Report only whether the pane opened (or the regeneration outcome). The TUI itself is the output.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, the dashboard is the Sterling TUI plugin, already running inside OpenCode, so there is nothing to start. Its summary is a panel in the session sidebar. Open the full view with `<leader>k` (ctrl+x then k by default), with `/sterling`, or with "Open Sterling dashboard" in the command palette; Escape leaves it.

If the sidebar shows no Sterling panel, the TUI plugin is not loaded. The fix depends on where this Sterling came from (its root is named in the Sterling layer). A copy from `opencode plugin add`, under OpenCode's npm cache: tell the user to run `opencode plugin update "github:Chulf58/sterling#semver:>=0.18.0"` and then `/sterling:init` here, which installs the OpenCode plugins. A copy from the Claude Code plugin cache or a clone: tell the user to run `/sterling:update` (or init) in Claude Code, which installs them. Either way, restart OpenCode afterwards.

Report only how to open it. The TUI itself is the output.
<!-- /opencode-only -->

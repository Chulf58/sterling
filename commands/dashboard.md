---
description: Open the Sterling TUI dashboard (§11) as a split pane in the current terminal window.
---

Run the project's generated TUI launcher from the project root: `& .\tui.bat` (PowerShell) or `tui.bat` (cmd). It opens the dashboard as a fresh vertical split in the current Windows Terminal window at the configured ratio — the human can close it any time with `q` and reopen it with this command; no session restart.

If `tui.bat` does not exist, re-run `/sterling:init` first — the ensure pass regenerates it from `templates/tui-win.bat` with machine-detected paths — then run it.

Report only whether the pane opened (or the regeneration outcome). The TUI itself is the output.

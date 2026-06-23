@echo off
rem Sterling launcher - double-click from Explorer to open this project in a
rem Windows Terminal window running the WSL tmux split (claude + TUI). GENERATED
rem by /sterling:init; machine-specific; gitignored; regenerable by re-running
rem /sterling:init. The split itself lives in sterling-launch.sh.
wt.exe wsl.exe --cd "{{WIN_PROJECT_DIR}}" -- bash -lic ./sterling-launch.sh

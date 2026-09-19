# hooks/ — bundled hook entrypoints

`hooks.json` is the live hook roster. Its registrations currently invoke these bundles:

- `h1-session-start`, `h2-selection-inject`, `h7-file-touch`, `h10-direct-capture`, `h15-store-guard`, `h16-event-register`
- `h19-clear-session`, `h19-delivery-drain`, `h19-knowledge-delivery`, `h19-bash-delivery`, `h19-dispatch-staging`
- `h20-mechanism-axis`, `h22-dispatch-register`, `h23-output-axis`, `h31-plan-lock`

The registrations are event- and matcher-specific. Read `hooks.json` for the authoritative event, matcher, and ordering for each bundle. Hook sources live under `scripts/hooks/`; the files in this directory are generated bundles.

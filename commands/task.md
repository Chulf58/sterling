---
description: Add a task to the Sterling board.
---

Call `board_add` with `source: "user"` and the user's text verbatim (plus `file_keys`/`priority` only if the user stated them). Confirm with the record id.

Answer parentage on every add (decision `a8d2ce6c`): a task that is a SLICE of a larger objective passes `objective: "<name>"` — when the conductor slices a big ask, every slice's `board_add` shares that one objective name, and the TUI groups them so the board stays readable as N objectives. A freestanding task passes `objective: "standalone"`. Omission still saves the task (loud notice, never lost); `board_update {objective}` groups it later — also the remedy for a late-discovered slice.

Routing — the board is the ONLY surface for wanted-but-not-done work, and an item leaves it solely through the artifact-write that fulfils it. Not the maintenance queue (`source: "system"`): that is mechanism-minted debt carrying a registered `system_reason`, drained by `/sterling:drain`, never a place to park a task.

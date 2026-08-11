---
description: Add a task to the Sterling board.
---

Call `board_add` with `source: "user"` and the user's text verbatim (plus `file_keys`/`priority` only if the user stated them). Confirm with the record id.

Routing — the board is the ONLY surface for wanted-but-not-done work, and an item leaves it solely through the artifact-write that fulfils it. Not the maintenance queue (`source: "system"`): that is mechanism-minted debt carrying a registered `system_reason`, drained by `/sterling:drain`, never a place to park a task.

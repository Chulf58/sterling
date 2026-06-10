---
description: Inline run/board peek — current run state, board and maintenance counts.
---

Call `run_state` (report machine_state, phase statuses, escalations, summaries if present; if there is no active run, say so), then `board_query` with source `user` and source `system` and report the counts with the top items.

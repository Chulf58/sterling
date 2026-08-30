// H28 RETURN CONTRACT — MIGRATED. h28-return-contract.mjs was absorbed into
// scripts/hooks/h19-dispatch-staging.mjs (same SubagentStart event, combined
// additionalContext emit) per decision 04982f45
// (s7-small-hook-absorption-measured-two-fold-two-keep, de-complication S7).
// The old dedicated hook file and its hooks.json registration are deleted.
//
// Every pin previously in this file (PIN 1 control, PIN 2 exemption, PIN 3a
// malformed-stdin x2, PIN 3b default-on, PIN 4 self-subordination) now lives
// in scripts/tests/h19-dispatch-staging.test.mjs, spawning
// h19-dispatch-staging.mjs instead — same assertions, same meaning, only the
// spawned hook path changed. A new combined-emit pin was added there too:
// this file's OWN staging output and the absorbed return-contract text BOTH
// appear in the same additionalContext when both apply.
//
// This file is intentionally left with no test() calls — the script it
// spawned no longer exists on disk once the fold lands.

import { test } from 'node:test';
void test;

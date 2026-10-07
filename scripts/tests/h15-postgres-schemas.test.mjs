// Pins for H15's Postgres arm (decision postgres-store-backend-design-sync-bridge-schema-per-store
// point 11; schema names per decision postgres-schema-names-sterling-p-uuid-sterling-d-domain):
// a Bash command that writes to a sterling_* schema through an ad-hoc client (psql, or a
// node/bun program given on the command line or on stdin) is denied. Sterling's own code path
// (the MCP server and the store run as processes, not as tool calls; Sterling scripts and the
// `node --test` store suites run as script files), read-only SELECTs and any schema outside the
// sterling_ prefix stay allowed. Nothing here connects to a database: the suite spawns the
// SOURCE hook with a hook-shaped stdin, like h15-db-seal.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h15-store-guard.mjs');

let project;
before(() => {
  project = mkdtempSync(join(tmpdir(), 'h15-pg-'));
  mkdirSync(join(project, '.sterling'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), '{}\n');
});
after(() => rmSync(project, { recursive: true, force: true }));

function run(command, tool_name = 'Bash') {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name, tool_input: { command }, cwd: project }),
    encoding: 'utf8',
    cwd: project,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}
function denied(command, tool) {
  const r = run(command, tool);
  assert.equal(r.code, 2, `expected DENY for: ${command}\n${r.stderr}`);
  assert.match(r.stderr, /sterling_/, 'the denial names the sterling_ schemas');
}
function allowed(command, tool) {
  const r = run(command, tool);
  assert.equal(r.code, 0, `expected ALLOW for: ${command}\n${r.stderr}`);
}

const P = 'sterling_p_0123456789abcdef0123456789abcdef';

// ── psql ────────────────────────────────────────────────────────────────────
test('psql -c with each write statement aimed at a sterling_ schema is denied', () => {
  for (const sql of [
    `INSERT INTO ${P}.records (id) VALUES ('x')`,
    `UPDATE ${P}.records SET body = '{}'`,
    `UPDATE ONLY ${P}.records SET body = '{}'`,
    `DELETE FROM ${P}.records`,
    `TRUNCATE ${P}.records`,
    `TRUNCATE TABLE ONLY ${P}.records, ${P}.record_versions`,
    `DROP SCHEMA ${P} CASCADE`,
    `DROP TABLE IF EXISTS sterling_meta.stores`,
    `ALTER TABLE sterling_d_node.records ADD COLUMN x int`,
    `CREATE SCHEMA sterling_d_genesys_cloud`,
    `CREATE INDEX idx ON ${P}.records (id)`,
    `COPY ${P}.records FROM '/tmp/rows.csv'`,
    `COPY ${P}.records (id, body) FROM STDIN`,
    `\\copy ${P}.records from 'rows.csv'`,
    `insert into "${P}"."records" (id) values ('x')`,
    `INSERT INTO STERLING_META.stores VALUES (1)`,
  ]) {
    denied(`psql "$DATABASE_URL" -c "${sql}"`);
  }
});

test('psql fed SQL through a heredoc, a pipe or -c after other options is denied', () => {
  denied(`psql -h db -U app app <<'SQL'\nBEGIN;\nDELETE FROM ${P}.records;\nCOMMIT;\nSQL`);
  denied(`echo "DROP SCHEMA sterling_test_ab12 CASCADE" | psql app`);
  denied(`/usr/bin/psql -X -v ON_ERROR_STOP=1 -c "TRUNCATE sterling_meta.stores"`);
  denied(`cd /tmp && psql app -c "UPDATE ${P}.records SET x = 1"`);
});

test('psql with an unqualified write after a sterling_ search_path is denied', () => {
  denied(`psql app -c "SET search_path TO ${P}; DELETE FROM records"`);
  denied(`PGOPTIONS='-c search_path=${P}' psql app -c "INSERT INTO records VALUES (1)"`);
});

test('psql read-only SELECTs on sterling_ schemas are allowed', () => {
  allowed(`psql app -c "SELECT count(*) FROM ${P}.records"`);
  allowed(`psql app -c "SELECT id, deleted_at, created_at, updated_at FROM sterling_meta.stores WHERE deleted_at IS NULL"`);
  allowed(`psql app -c "SELECT * FROM ${P}.records FOR UPDATE"`);
  allowed(`psql app -c "COPY ${P}.records TO STDOUT"`);
  allowed(`psql app -c "COPY (SELECT * FROM ${P}.records WHERE id IN (SELECT id FROM ${P}.record_aliases)) TO STDOUT"`);
  allowed(`psql app -c "\\dn sterling_*"`);
  allowed(`psql app -c "SET search_path TO ${P}; SELECT count(*) FROM records"`);
});

test('psql writes to schemas outside the sterling_ prefix are allowed (opensterling is not Sterling\'s)', () => {
  allowed(`psql app -c "DELETE FROM opensterling.records"`);
  allowed(`psql app -c "DROP TABLE opensterling_live.x"`);
  allowed(`psql app -c "CREATE SCHEMA scratch; INSERT INTO public.t VALUES (1)"`);
});

// ── node / bun programs given inline or on stdin ────────────────────────────
test('node -e / --eval / -p / --input-type with a write to a sterling_ schema is denied', () => {
  denied(`node -e "const {Client}=require('pg');const c=new Client();await c.connect();await c.query('DELETE FROM ${P}.records')"`);
  denied(`node --input-type=module -e "import pg from 'pg'; await new pg.Client().query(\\"DROP SCHEMA sterling_meta CASCADE\\")"`);
  denied(`node --eval 'client.query("UPDATE ${P}.records SET x = 1")'`);
  denied(`node -p 'q("TRUNCATE sterling_d_node.records")'`);
  denied(`bun -e 'await sql\`INSERT INTO ${P}.records VALUES (1)\`'`);
});

test('node fed a program on stdin (heredoc or pipe) with a write to a sterling_ schema is denied', () => {
  denied(`node --input-type=module <<'EOF'\nimport pg from 'pg';\nconst c = new pg.Client();\nawait c.connect();\nawait c.query('ALTER TABLE ${P}.records DROP COLUMN body');\nEOF`);
  denied(`node - <<'EOF'\nawait c.query("CREATE TABLE sterling_meta.x (id int)")\nEOF`);
  denied(`echo "c.query('DELETE FROM ${P}.records')" | node`);
});

test('node -e with a read-only SELECT on a sterling_ schema is allowed', () => {
  allowed(`node -e "const {Client}=require('pg');const c=new Client();await c.connect();console.log((await c.query('SELECT count(*) FROM ${P}.records')).rows)"`);
});

// ── Sterling's own code path and the sanctioned test runs ───────────────────
test('the sanctioned store test runs are allowed even when their names mention SQL and sterling_test_ schemas', () => {
  allowed('node --test packages/store/dist/tests/pg-driver.test.js');
  allowed('node --test --test-name-pattern="DROP SCHEMA sterling_test_ after the run" packages/store/dist/tests/pg-driver.test.js');
  allowed('STERLING_PG_TEST=1 npm test -w packages/store');
  allowed('node --test');
});

test('Sterling scripts and bundles run as script files are allowed', () => {
  allowed(`node bin/migrate-stores.mjs --all-stores`);
  allowed(`node scripts/knowledge-eval.mjs --store ${P}`);
  allowed('node mcp/sterling-mcp.mjs --store .sterling/sterling.db');
});

test('commands that only mention write SQL without an ad-hoc client are allowed', () => {
  allowed(`grep -rn "DELETE FROM ${P}" packages/store/src`);
  allowed(`git commit -m "store: CREATE SCHEMA sterling_meta on first open"`);
  allowed(`rg 'INSERT INTO sterling_' -g '*.ts'`);
  allowed(`cat <<'EOF' > notes.md\nDROP SCHEMA sterling_test_x CASCADE\nEOF`);
});

test('PowerShell: psql with a write to a sterling_ schema is denied', () => {
  denied(`psql.exe app -c "DELETE FROM ${P}.records"`, 'PowerShell');
});

test('the SQLite seal still applies alongside the Postgres arm', () => {
  const r = run('rm .sterling/sterling.db');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /sterling\.db/);
});

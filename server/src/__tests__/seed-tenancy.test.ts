/**
 * Regression: every seeded row in a tenant-bound table must carry `company_id`
 * AT INSERT TIME.
 *
 * migrate.ts backfills NULL tenancy (`UPDATE conversations SET company_id =
 * 'personal' WHERE company_id IS NULL`), which makes omitting the column look
 * harmless — but that backfill runs inside ensureSchema(), i.e. BEFORE
 * seedIfEmpty() in the same boot (index.ts). A row seeded without company_id
 * therefore stays NULL for the whole of that process lifetime, and only gets
 * repaired on the NEXT start.
 *
 * That window is not theoretical. `seed.ts` omitted company_id on the
 * conversations insert, so the seeded `direct-<agent>` DMs were invisible to
 * onboardStarterAgents' dedup query (which filters `company_id = $1`, and
 * `NULL = 'personal'` is NULL) — pairing a computer in the same boot created a
 * second `direct-<agent>-<hex>` for all six agents, so the sidebar showed two
 * DM entries per agent. Humans were spared only because their DMs are seeded on
 * a different code path that never ran.
 *
 * This test is a source-level assertion rather than a DB one on purpose: it
 * needs no Postgres, and it derives the tenant-table set FROM migrate.ts, so a
 * newly tenant-scoped table that seed.ts writes without company_id fails here
 * too.
 *
 * Run: node --import tsx --test server/src/__tests__/seed-tenancy.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

/** Tables migrate.ts declares tenant-bound, i.e. those given a company_id column. */
function tenantTables(): Set<string> {
  const sql = read('db/migrate.ts')
  const out = new Set<string>()
  const re = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS company_id\b/g
  for (const m of sql.matchAll(re)) out.add(m[1])
  return out
}

/** Every `INSERT INTO <table> (<cols>)` in a source file, with its column list. */
function inserts(rel: string): Array<{ table: string; cols: string; line: number }> {
  const src = read(rel)
  const out: Array<{ table: string; cols: string; line: number }> = []
  const re = /INSERT INTO\s+(\w+)\s*\(([^)]*)\)/g
  for (const m of src.matchAll(re)) {
    out.push({
      table: m[1],
      cols: m[2],
      line: src.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

test('migrate.ts declares the tables we expect to be tenant-bound', () => {
  const t = tenantTables()
  // Sanity-check the extraction itself, so a regex that silently matches
  // nothing can't make the real assertion below vacuously pass.
  assert.ok(t.size > 10, `expected many tenant tables, got ${t.size}`)
  for (const name of ['conversations', 'messages', 'participants']) {
    assert.ok(t.has(name), `${name} must be tenant-bound in migrate.ts`)
  }
})

test('every seeded INSERT into a tenant-bound table names company_id', () => {
  const tenant = tenantTables()
  const found = inserts('seed.ts')
  assert.ok(found.length > 0, 'found no INSERTs in seed.ts — the scanner is broken')

  const missing = found
    .filter((i) => tenant.has(i.table))
    .filter((i) => !/\bcompany_id\b/.test(i.cols))
    .map((i) => `  seed.ts:${i.line} → INSERT INTO ${i.table} omits company_id`)

  assert.deepEqual(
    missing,
    [],
    `\nSeeded rows would be born with NULL tenancy:\n${missing.join('\n')}\n` +
      `migrate.ts's NULL backfill runs BEFORE seedIfEmpty() in the same boot, so it ` +
      `will NOT repair these until the next restart — and any dedup/scoping query ` +
      `filtering on \`company_id = $1\` silently misses them in the meantime.`,
  )
})

test('the seeded conversations insert is the one this regression was about', () => {
  const conv = inserts('seed.ts').filter((i) => i.table === 'conversations')
  assert.equal(conv.length, 1, 'expected exactly one conversations INSERT in seed.ts')
  assert.match(conv[0].cols, /\bcompany_id\b/)
})

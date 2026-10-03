/**
 * Applies a catalog seed the way `wrangler d1 execute --file` does: one statement per line, in file order.
 * Returns what the load cost: `changes` — rows inserted or updated, `rowsWritten` — row writes as D1 bills them.
 */
export async function applySeed(db: D1Database, sql: string): Promise<{ statements: number; changes: number; rowsWritten: number }> {
  const lines = sql.split("\n").filter((line) => line.trim() !== "");
  const results = await db.batch(lines.map((line) => db.prepare(line)));
  return {
    statements: lines.length,
    changes: results.reduce((sum, r) => sum + r.meta.changes, 0),
    rowsWritten: results.reduce((sum, r) => sum + r.meta.rows_written, 0),
  };
}

/**
 * Wraps a D1Database and sums the rows D1 reads (`meta.rows_read` of every statement), the unit of the free tier's
 * daily read limit. `calls` counts the calls that hit D1, as test/helpers/countingDb.ts does.
 */
export type ReadingDb = D1Database & { rowsRead: number; calls: number };

export function readingDb(db: D1Database): ReadingDb {
  const state = { rowsRead: 0, calls: 0 };
  const add = (meta: { rows_read?: number } | undefined) => { state.rowsRead += meta?.rows_read ?? 0; };
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop, recv) {
        if (prop === "__raw") return target;
        if (prop === "bind") return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === "all" || prop === "run")
          return async () => { state.calls++; const r = await target[prop](); add(r.meta); return r; };
        // `first` gives no meta: the same statement is run with `all`, which reads the same rows.
        if (prop === "first")
          return async (column?: string) => {
            state.calls++;
            const r = await target.all<Record<string, unknown>>();
            add(r.meta);
            const row = r.results[0];
            return row === undefined ? null : column === undefined ? row : (row[column] ?? null);
          };
        return Reflect.get(target, prop, recv);
      },
    });
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "rowsRead") return state.rowsRead;
      if (prop === "calls") return state.calls;
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          state.calls++;
          const res = await target.batch(stmts.map((s) => (s as unknown as { __raw?: D1PreparedStatement }).__raw ?? s));
          for (const r of res) add(r.meta);
          return res;
        };
      return Reflect.get(target, prop, recv);
    },
    set(_t, prop, value) {
      if (prop === "rowsRead") { state.rowsRead = value as number; return true; }
      if (prop === "calls") { state.calls = value as number; return true; }
      return false;
    },
  }) as ReadingDb;
}

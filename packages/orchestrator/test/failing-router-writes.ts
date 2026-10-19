import type { Env } from "../src/env";

/** The router writes of a job start: the workflow status write and the binding write of a branch. */
function isRouterWrite(sql: string): boolean {
  return (
    sql.startsWith('update "workflows" set "status"') ||
    (sql.startsWith('insert into "bindings"') && sql.includes(" select "))
  );
}

/**
 * A D1 binding over `base` that throws on each router write of a job start while `failing` is
 * set. Every other statement runs on `base`. `thrown` counts the writes it threw on.
 */
export class FailingRouterWrites {
  failing = false;
  thrown = 0;
  readonly db: Env["DB"];

  constructor(base: Env["DB"]) {
    const refuse = async (): Promise<never> => {
      this.thrown += 1;
      throw new Error("D1_ERROR: the router database is unavailable");
    };
    const refused = { bind: () => refused, run: refuse, all: refuse, raw: refuse, first: refuse };
    const binding: object = {
      prepare: (sql: string) => (this.failing && isRouterWrite(sql) ? refused : base.prepare(sql)),
    };
    this.db = binding as Env["DB"];
  }
}

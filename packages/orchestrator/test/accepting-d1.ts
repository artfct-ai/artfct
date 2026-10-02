import type { Env } from "../src/env";

/**
 * A D1 binding that accepts every statement and holds nothing. For a small test whose code
 * writes a routing binding and never reads one.
 */
export function acceptingD1(): Env["DB"] {
  const result = { success: true, results: [], meta: {} };
  const statement = {
    bind: () => statement,
    run: async () => result,
    all: async () => result,
    raw: async () => [],
    first: async () => null,
  };
  const binding: object = { prepare: () => statement };
  return binding as Env["DB"];
}

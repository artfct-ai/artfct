import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { upsertPerson, type PersonInput } from "./persons";
import { persons } from "./schema";

const db = createDb(env.DB);
const RUNS = 100;
const PEOPLE = 3;
const ID_KINDS = ["email", "linear_user_id", "slack_user_id", "github_login"] as const;

type IdKind = (typeof ID_KINDS)[number];

type Upsert = { person: number; kinds: IdKind[]; shoutedEmail: boolean };

const upsert: fc.Arbitrary<Upsert> = fc.record({
  person: fc.integer({ min: 0, max: PEOPLE - 1 }),
  kinds: fc.subarray([...ID_KINDS], { minLength: 1 }),
  shoutedEmail: fc.boolean(),
});

function idOf(prefix: string, person: number, kind: IdKind): string {
  return kind === "email" ? `${prefix}-p${person}@acme.test` : `${prefix}-p${person}-${kind}`;
}

function inputOf(prefix: string, step: Upsert): PersonInput {
  const input: PersonInput = { display_name: `Person ${step.person}` };
  for (const kind of step.kinds) {
    const id = idOf(prefix, step.person, kind);
    input[kind] = kind === "email" && step.shoutedEmail ? id.toUpperCase() : id;
  }
  return input;
}

function idKey(kind: IdKind, id: string): string {
  return `${kind}:${id}`;
}

class NamedTogether {
  private readonly parent = new Map<string, string>();

  root(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) return key;
    const root = this.root(parent);
    this.parent.set(key, root);
    return root;
  }

  join(keys: string[]): void {
    const [first, ...rest] = keys.map((key) => this.root(key));
    if (!first) return;
    this.parent.set(first, first);
    for (const other of rest) this.parent.set(other, first);
  }

  groups(): string[][] {
    const byRoot = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.root(key);
      byRoot.set(root, [...(byRoot.get(root) ?? []), key]);
    }
    return [...byRoot.values()].map((keys) => keys.toSorted());
  }
}

async function storedGroups(prefix: string): Promise<Map<string, string[]>> {
  const rows = await db.select().from(persons);
  const byPerson = new Map<string, string[]>();
  for (const row of rows) {
    const keys = ID_KINDS.flatMap((kind) => {
      const id = row[kind];
      return id?.startsWith(prefix) ? [idKey(kind, id)] : [];
    });
    if (keys.length) byPerson.set(row.person_id, keys.toSorted());
  }
  return byPerson;
}

function sortedGroups(groups: Iterable<string[]>): string[] {
  return [...groups].map((keys) => keys.join(" ")).toSorted();
}

let runNumber = 0;

describe("person upserts", () => {
  it(
    "keep one row per group of ids that some upsert named together, and return the row that holds the named ids",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(upsert, { minLength: 1, maxLength: 10 }), async (steps) => {
          runNumber += 1;
          const prefix = `run${runNumber}`;
          const namedTogether = new NamedTogether();
          for (const step of steps) {
            const record = await upsertPerson(db, inputOf(prefix, step));
            const named = step.kinds.map((kind) => idKey(kind, idOf(prefix, step.person, kind)));
            namedTogether.join(named);
            const stored = await storedGroups(prefix);
            expect(sortedGroups(stored.values())).toEqual(sortedGroups(namedTogether.groups()));
            expect(stored.get(record.person_id)).toEqual(expect.arrayContaining(named));
          }
        }),
        propertyRuns("person upserts", RUNS),
      );
    },
    propertyTimeoutMs(60_000, RUNS),
  );
});

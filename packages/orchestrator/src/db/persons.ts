import { newPersonId } from "../ids";
import type { Actor } from "@artfct-ai/contracts/inbound";
import { eq, inArray, or, type SQL } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { persons } from "./schema";

type PersonRow = typeof persons.$inferSelect;

/** External identifiers that find or describe a person. Any subset is fine. */
export type PersonInput = {
  email?: string | null;
  linear_user_id?: string | null;
  slack_user_id?: string | null;
  github_login?: string | null;
  display_name?: string | null;
};

/** A person after an upsert, with the fields ingress needs. */
export type PersonRecord = Actor & { linear_user_id: string | null };

/**
 * Find or create a person by any known external id. Email joins Slack and Linear. When the ids
 * name more than one row, those rows become one.
 */
export async function upsertPerson(db: Database, input: PersonInput): Promise<PersonRecord> {
  const [kept, ...merged] = await findPersons(db, input);
  if (!kept) return insertPerson(db, input);
  return mergePersons(db, { kept, merged, input });
}

/** The email as stored: lower case, and null when empty. */
function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Every row any provided id matches, oldest first. Email is compared lower case. */
async function findPersons(db: Database, input: PersonInput): Promise<PersonRow[]> {
  const clauses: SQL[] = [];
  const email = normalizeEmail(input.email);
  if (email) clauses.push(eq(persons.email, email));
  if (input.linear_user_id) clauses.push(eq(persons.linear_user_id, input.linear_user_id));
  if (input.slack_user_id) clauses.push(eq(persons.slack_user_id, input.slack_user_id));
  if (input.github_login) clauses.push(eq(persons.github_login, input.github_login));
  if (clauses.length === 0) return [];
  return db
    .select()
    .from(persons)
    .where(or(...clauses))
    .orderBy(persons.created_at, persons.person_id);
}

async function insertPerson(db: Database, input: PersonInput): Promise<PersonRecord> {
  const timestamp = nowIso();
  const row = {
    person_id: newPersonId(),
    email: normalizeEmail(input.email),
    linear_user_id: input.linear_user_id ?? null,
    slack_user_id: input.slack_user_id ?? null,
    github_login: input.github_login ?? null,
    display_name: input.display_name ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await db.insert(persons).values(row);
  return toRecord(row);
}

/**
 * Keep the oldest row and fill its gaps from the other rows, then from the input. The other rows
 * go in the same batch, so no id is held twice. A new display name wins over the stored one.
 */
async function mergePersons(
  db: Database,
  { kept, merged, input }: { kept: PersonRow; merged: PersonRow[]; input: PersonInput },
): Promise<PersonRecord> {
  const rows = [kept, ...merged];
  const stored = (read: (row: PersonRow) => string | null) =>
    rows.map(read).find((value) => value !== null) ?? null;
  const fields = {
    email: stored((row) => row.email) ?? normalizeEmail(input.email),
    linear_user_id: stored((row) => row.linear_user_id) ?? input.linear_user_id ?? null,
    slack_user_id: stored((row) => row.slack_user_id) ?? input.slack_user_id ?? null,
    github_login: stored((row) => row.github_login) ?? input.github_login ?? null,
    display_name: input.display_name ?? stored((row) => row.display_name),
  };
  await db.batch([
    db.delete(persons).where(
      inArray(
        persons.person_id,
        merged.map((row) => row.person_id),
      ),
    ),
    db
      .update(persons)
      .set({ ...fields, updated_at: nowIso() })
      .where(eq(persons.person_id, kept.person_id)),
  ]);
  return toRecord({ ...kept, ...fields });
}

function toRecord(row: PersonRow): PersonRecord {
  return {
    person_id: row.person_id,
    email: row.email,
    display_name: row.display_name,
    linear_user_id: row.linear_user_id,
  };
}

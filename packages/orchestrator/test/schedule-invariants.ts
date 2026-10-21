import type { TriggerFiring } from "../src/triggers/types";

/** The values each of the five cron fields allows. Null allows every value, as `*` does. */
export type ScheduleFields = {
  minute: number[] | null;
  hour: number[] | null;
  dayOfMonth: number[] | null;
  month: number[] | null;
  dayOfWeek: number[] | null;
};

const MINUTE_MS = 60_000;

/** The cron expression of the fields, such as `0,30 9 * * 1,2`. */
export function scheduleExpression(fields: ScheduleFields): string {
  return [fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek]
    .map((values) => (values === null ? "*" : values.join(",")))
    .join(" ");
}

function allows(values: number[] | null, value: number): boolean {
  return values === null || values.includes(value);
}

function matchesInUtc(fields: ScheduleFields, minute: Date): boolean {
  return (
    allows(fields.minute, minute.getUTCMinutes()) &&
    allows(fields.hour, minute.getUTCHours()) &&
    allows(fields.dayOfMonth, minute.getUTCDate()) &&
    allows(fields.month, minute.getUTCMonth() + 1) &&
    allows(fields.dayOfWeek, minute.getUTCDay())
  );
}

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * A scheduled run queues one first attempt of the trigger exactly when its fields match the UTC
 * minute the run was scheduled for, named by that minute, however late the run starts.
 */
export function scheduleFiresOnItsMinutes(
  fields: ScheduleFields,
  scheduledTime: number,
  firings: readonly TriggerFiring[],
): void {
  const minute = new Date(Math.floor(scheduledTime / MINUTE_MS) * MINUTE_MS);
  const expected = matchesInUtc(fields, minute) ? [minute.toISOString()] : [];
  const fired = firings.map(({ cause }) => (cause.kind === "schedule" ? cause.minute : cause.kind));
  if (JSON.stringify(fired) !== JSON.stringify(expected)) {
    violated(
      "scheduleFiresOnItsMinutes",
      `${scheduleExpression(fields)} at ${minute.toISOString()} fired ${JSON.stringify(fired)}, not ${JSON.stringify(expected)}`,
    );
  }
  if (firings.some((firing) => firing.attempt !== 1 || firing.position !== 0)) {
    violated("scheduleFiresOnItsMinutes", `a firing is not the first attempt of its trigger`);
  }
}

import { Cron } from "croner";
import type { WorkflowDefinition } from "../config/workflow-definition";
import type { TriggerFiring } from "./types";

const FIVE_UTC_FIELDS = { mode: "5-part", timezone: "UTC" } as const;

const MINUTE_MS = 60_000;

function parseSchedule(expression: string): Cron {
  return new Cron(expression, FIVE_UTC_FIELDS);
}

/** Why a cron expression does not parse as five UTC fields. Null when it parses. */
export function scheduleProblem(expression: string): string | null {
  try {
    parseSchedule(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The start of the UTC minute a scheduled run was scheduled for, whenever the run starts. */
export function scheduledMinute(scheduledTime: number): Date {
  return new Date(Math.floor(scheduledTime / MINUTE_MS) * MINUTE_MS);
}

/** True when the cron expression matches the minute in UTC. */
export function scheduleMatches(expression: string, minute: Date): boolean {
  return parseSchedule(expression).match(minute);
}

/**
 * One first attempt for every schedule trigger whose cron expression matches the minute of the
 * scheduled time. A missed minute is not caught up.
 */
export function scheduledFirings(
  definitions: readonly WorkflowDefinition[],
  scheduledTime: number,
): TriggerFiring[] {
  const minute = scheduledMinute(scheduledTime);
  return definitions.flatMap((definition) =>
    definition.triggers.flatMap((trigger, position) => {
      if (!scheduleMatches(trigger.schedule, minute)) return [];
      return [
        {
          cause: { kind: "schedule" as const, minute: minute.toISOString() },
          definition: definition.name,
          position,
          attempt: 1,
        },
      ];
    }),
  );
}

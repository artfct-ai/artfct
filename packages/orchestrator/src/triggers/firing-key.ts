import type { TriggerFiring } from "./types";

/**
 * The key that decides a firing's duplicates. A schedule's key names its definition, its
 * trigger's position and the scheduled minute, so a late or repeated run for the minute gets it
 * too. A vendor event's key names its delivery, so a redelivery gets it too.
 */
export function firingKey({
  cause,
  definition,
  position,
}: Pick<TriggerFiring, "cause" | "definition" | "position">): string {
  switch (cause.kind) {
    case "schedule":
      return `schedule:${definition}:${position}:${cause.minute}`;
    case "vendor_event":
      return `trigger:${cause.delivery_id}:${definition}:${position}`;
    default: {
      const unreachable: never = cause;
      throw new Error(`unhandled firing cause ${String(unreachable)}`);
    }
  }
}

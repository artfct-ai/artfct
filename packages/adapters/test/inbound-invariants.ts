/** What one inbound mapper did with one payload: the value it returned, or what it threw. */
export type MapperOutcome =
  | { kind: "returned"; value: unknown }
  | { kind: "threw"; error: unknown };

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * An inbound mapper returns an event, or an ignore that names its reason, for any payload. It
 * never throws.
 */
export function inboundMapperNeverThrows(outcome: MapperOutcome): void {
  if (outcome.kind === "threw") {
    violated("inboundMapperNeverThrows", `the mapper threw ${String(outcome.error)}`);
  }
  if (isEventOrIgnore(outcome.value)) return;
  violated("inboundMapperNeverThrows", `the mapper returned ${describe(outcome.value)}`);
}

/** Runs one mapper call and records how it settled. */
export async function mapperOutcome(map: () => unknown): Promise<MapperOutcome> {
  try {
    return { kind: "returned", value: await map() };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function isEventOrIgnore(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("ignore" in value) return typeof value.ignore === "string" && value.ignore !== "";
  if ("event" in value) return typeof value.event === "object" && value.event !== null;
  return false;
}

function describe(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 200) ?? String(value);
}

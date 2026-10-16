/** A field of an ITF record. Null for a missing field when `optional`. */
export function itfField(value: unknown, name: string, optional = false): unknown {
  if (typeof value === "object" && value !== null && name in value) {
    return Object.getOwnPropertyDescriptor(value, name)?.value;
  }
  if (optional) return null;
  throw new Error(`the trace has no ${name} in ${JSON.stringify(value)}`);
}

/** An ITF list. */
export function itfList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`the trace has ${JSON.stringify(value)}, not a list`);
  return value;
}

/** The elements of an ITF set. */
export function itfSet(value: unknown): unknown[] {
  return itfList(itfField(value, "#set"));
}

/** An ITF integer. */
export function itfInt(value: unknown): number {
  return Number(itfText(itfField(value, "#bigint")));
}

/** An ITF boolean. */
export function itfBool(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error(`the trace has ${JSON.stringify(value)}, not a bool`);
  return value;
}

/** An ITF string. */
export function itfText(value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`the trace has ${JSON.stringify(value)}, not text`);
  return value;
}

/** An ITF variant, or null for a missing one. */
export function itfVariant(value: unknown): { tag: string; value: unknown } | null {
  if (value === null) return null;
  return { tag: itfText(itfField(value, "tag")), value: itfField(value, "value") };
}

/** The tag of an ITF variant that is one of `names`. */
export function itfOneOf<Name extends string>(name: string, names: readonly Name[]): Name {
  const known = names.find((candidate) => candidate === name);
  if (!known) throw new Error(`the trace has ${name}, not one of ${names.join(", ")}`);
  return known;
}

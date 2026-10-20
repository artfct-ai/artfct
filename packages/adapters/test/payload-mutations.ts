import fc from "fast-check";

type FieldPath = Array<string | number>;

type Mutation = { at: number; remove: boolean; value: unknown };

/** A string far longer than any field a vendor sends. */
const oversizedString: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 8, unit: "binary" }),
    fc.integer({ min: 10_000, max: 200_000 }),
  )
  .map(([unit, length]) => unit.repeat(Math.ceil(length / unit.length)));

/** A JSON value of any type: a small one, an empty one, or an oversized string. */
export const anyJsonValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }),
  fc.constantFrom(null, true, false, 0, -1, 1.5, "", [], {}),
  oversizedString,
);

/** An email in any mix of upper and lower case, as a vendor may report it. */
export const anyCaseEmail: fc.Arbitrary<string> = fc.stringMatching(
  /^[A-Za-z][A-Za-z.]{0,7}@[A-Za-z]{1,8}\.[A-Za-z]{2,4}$/,
);

/**
 * A payload derived from `base`, a real vendor payload, with fields removed or replaced by a
 * value of any type. Each mutation picks one field anywhere in the tree, nested ones included.
 */
export function mutatedPayload(base: unknown): fc.Arbitrary<unknown> {
  const mutation = fc.record({ at: fc.nat(), remove: fc.boolean(), value: anyJsonValue });
  return fc
    .array(mutation, { maxLength: 3 })
    .map((mutations) => mutations.reduce<unknown>(applyMutation, structuredClone(base)));
}

function applyMutation(payload: unknown, mutation: Mutation): unknown {
  const paths = fieldPaths(payload, []);
  if (paths.length === 0) return mutation.remove ? payload : mutation.value;
  const path = paths[mutation.at % paths.length]!;
  const parent = path.slice(0, -1).reduce<unknown>(childOf, payload);
  const key = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof key === "number") {
    if (mutation.remove) parent.splice(key, 1);
    else parent[key] = mutation.value;
  } else if (isRecord(parent)) {
    if (mutation.remove) delete parent[key];
    else parent[key] = mutation.value;
  }
  return payload;
}

function fieldPaths(value: unknown, prefix: FieldPath): FieldPath[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [
      [...prefix, index],
      ...fieldPaths(item, [...prefix, index]),
    ]);
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => [
      [...prefix, key],
      ...fieldPaths(item, [...prefix, key]),
    ]);
  }
  return [];
}

function childOf(value: unknown, key: string | number): unknown {
  if (Array.isArray(value) && typeof key === "number") return value[key];
  if (isRecord(value)) return value[key];
  return undefined;
}

function isRecord(value: unknown): value is Record<string | number, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

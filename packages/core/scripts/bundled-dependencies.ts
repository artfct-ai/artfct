/** The name and dependency ranges of one package manifest. */
export type Manifest = { name: string; dependencies?: Record<string, string> };

const WORKSPACE_RANGE = "workspace:";

/**
 * The npm dependencies the bundle leaves external: every non-workspace dependency of the
 * workspace packages reachable from `roots`. Throws when two packages ask for different ranges.
 */
export function bundledDependencies(
  workspace: readonly Manifest[],
  roots: readonly string[],
): Record<string, string> {
  const byName = new Map(workspace.map((manifest) => [manifest.name, manifest]));
  const external = new Map<string, { range: string; from: string }>();
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const manifest = byName.get(name);
    if (!manifest) throw new Error(`${name} is not a workspace package`);
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith(WORKSPACE_RANGE)) {
        pending.push(dependency);
        continue;
      }
      const known = external.get(dependency);
      if (known && known.range !== range) {
        throw new Error(
          `${dependency} is ${known.range} in ${known.from} but ${range} in ${manifest.name}`,
        );
      }
      external.set(dependency, { range, from: manifest.name });
    }
  }
  return Object.fromEntries(
    [...external]
      .map(([dependency, { range }]) => [dependency, range])
      .toSorted(([left], [right]) => left!.localeCompare(right!)),
  );
}

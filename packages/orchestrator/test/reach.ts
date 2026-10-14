const declaredPoints = new Set<string>();

let reachedPoints = new Set<string>();

/**
 * Declare a reach point: a situation in which an invariant's check can fail. Returns the marker
 * the invariant calls when a step reaches it.
 */
export function reachPoint(label: string): () => void {
  declaredPoints.add(label);
  return () => {
    reachedPoints.add(label);
  };
}

/** Every reach point the loaded invariants declare. */
export function declaredReachPoints(): string[] {
  return [...declaredPoints];
}

/** The reach points marked since the last call. The next run starts with none. */
export function takeReachedPoints(): Set<string> {
  const taken = reachedPoints;
  reachedPoints = new Set();
  return taken;
}

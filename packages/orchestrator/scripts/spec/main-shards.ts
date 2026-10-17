/** A setup and the minutes its main quint checks take on a CI runner. */
export type TimedSetup = { minutes: number };

/**
 * Splits setups into `count` main quint shards of near equal minutes. Each setup, longest first,
 * goes to the shard with the fewest minutes so far.
 */
export function mainQuintShards<Setup extends TimedSetup>(
  setups: Setup[],
  count: number,
): Setup[][] {
  const shards = Array.from({ length: count }, (): { minutes: number; setups: Setup[] } => ({
    minutes: 0,
    setups: [],
  }));
  for (const setup of setups.toSorted((left, right) => right.minutes - left.minutes)) {
    const lightest = shards.reduce((least, shard) =>
      shard.minutes < least.minutes ? shard : least,
    );
    lightest.minutes += setup.minutes;
    lightest.setups.push(setup);
  }
  return shards.map((shard) => shard.setups);
}

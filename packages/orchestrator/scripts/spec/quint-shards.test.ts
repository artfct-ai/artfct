import { describe, expect, it } from "bun:test";
import { quintShards } from "./quint-shards";

const setup = (name: string, minutes: number) => ({ name, minutes });
const names = (shards: Array<Array<{ name: string }>>) =>
  shards.map((shard) => shard.map(({ name }) => name));

describe("quintShards", () => {
  it("gives each long setup its own shard", () => {
    const shards = quintShards(
      [setup("a", 1), setup("long1", 10), setup("b", 1), setup("long2", 9), setup("long3", 10)],
      4,
    );
    expect(names(shards)).toEqual([["long1"], ["long3"], ["long2"], ["a", "b"]]);
  });

  it("balances the short setups by their minutes", () => {
    const shards = quintShards(
      [setup("a", 4), setup("b", 3), setup("c", 3), setup("d", 2), setup("e", 2)],
      2,
    );
    expect(names(shards)).toEqual([
      ["a", "d", "e"],
      ["b", "c"],
    ]);
  });

  it("assigns every setup once", () => {
    const setups = Array.from({ length: 19 }, (_, index) => setup(`s${index}`, (index * 7) % 11));
    const assigned = quintShards(setups, 7).flat();
    expect(assigned.map(({ name }) => name).toSorted()).toEqual(
      setups.map(({ name }) => name).toSorted(),
    );
  });
});

/** Hands one test body a fresh fixture with a describe block's setup applied. */
export type Scenario<Fixture> = (run: (fixture: Fixture) => void | Promise<void>) => Promise<void>;

/**
 * The fixture of a describe block whose setup cannot live in a `beforeEach`. `base` opens the
 * fixture and `setup` arranges the block's state on it. Nest blocks by passing the enclosing
 * block's scenario as the base.
 */
export function scenario<Fixture>(
  base: Scenario<Fixture>,
  setup: (fixture: Fixture) => void | Promise<void>,
): Scenario<Fixture> {
  return (run) =>
    base(async (fixture) => {
      await setup(fixture);
      await run(fixture);
    });
}

/** A recorded call on a fake: the method name and its arguments, in order. */
export type RecordedCall<Methods extends string> = { method: Methods; args: unknown[] };

/** Records calls for a fake and replays a configured failure. */
export class CallLog<Methods extends string> {
  readonly calls: RecordedCall<Methods>[] = [];

  constructor(private readonly failing: boolean) {}

  /** Record one call. Throws when the fake is configured to fail. */
  record(method: Methods, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failing) throw new Error(`${method}: boom`);
  }

  /** The argument lists of every call to `method`, in order. */
  argsOf(method: Methods): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }
}

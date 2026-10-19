/** A promise the replay settles when the spec says so. */
export class Deferred<Value> {
  resolve: (value: Value) => void = () => {};
  reject: (error: Error) => void = () => {};
  readonly promise = new Promise<Value>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

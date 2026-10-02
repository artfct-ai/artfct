/** The text a tool returned. Fails when the tool streamed instead. */
export function toolText(result: string | AsyncIterable<string>): string {
  if (typeof result !== "string") throw new Error("expected a text result");
  return result;
}

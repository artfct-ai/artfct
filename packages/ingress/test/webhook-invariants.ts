/** One webhook request that was tampered with after the vendor signed it, and what reached the orchestrator. */
export type TamperedWebhook = {
  vendor: string;
  /** What changed: the signature, the timestamp, the secret, the body, or a header. */
  tamper: string;
  /** Every orchestrator RPC method the route called, in order. */
  calls: string[];
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * A webhook with a bad signature never delivers. The route answers before it calls the
 * orchestrator at all, so it neither delivers nor looks anyone up.
 */
export function badSignatureNeverDelivers(record: TamperedWebhook): void {
  if (record.calls.length === 0) return;
  violated(
    "badSignatureNeverDelivers",
    `a ${record.vendor} webhook with ${record.tamper} reached the orchestrator through ${record.calls.join(", ")}`,
  );
}

/** One webhook request that was tampered with after the vendor signed it, and what reached the orchestrator. */
export type TamperedWebhook = {
  vendor: string;
  /** What changed: the signature, the timestamp, the secret, the body, or a header. */
  tamper: string;
  /** Every orchestrator RPC method the route called, in order. */
  calls: string[];
};

/** One webhook request the vendor signed with the right secret inside its time window, and what reached the orchestrator. */
export type GenuineWebhook = {
  vendor: string;
  /** The body the vendor signed and sent. */
  body: string;
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

/**
 * A webhook signed with the right secret over any body, inside the vendor's time window,
 * delivers exactly one event.
 */
export function genuineWebhookDelivers(record: GenuineWebhook): void {
  const deliveries = record.calls.filter((call) => call === "deliver").length;
  if (deliveries === 1) return;
  violated(
    "genuineWebhookDelivers",
    `a genuine ${record.vendor} webhook delivered ${deliveries} times through [${record.calls.join(", ")}]: ${JSON.stringify(record.body)}`,
  );
}

/**
 * Every secret in the ingress `.dev.vars.example`. Each one reaches only the check or the vendor
 * client the route builds on it, and no output a test records.
 */
export const INGRESS_SECRETS = [
  "ADMIN_TOKEN",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "NOTION_VERIFICATION_TOKEN",
  "NOTION_TOKEN",
] as const;

export type IngressSecret = (typeof INGRESS_SECRETS)[number];

/** Where an output of one ingress request went. */
export type IngressOutput =
  | "response"
  | "console"
  | "delivery"
  | "identity_query"
  | "orchestrator_call"
  | "chat_call"
  | "documents_call";

/** One request to the ingress Worker: the secrets it held and everything the request produced. */
export type IngressRequestRecord = {
  route: string;
  secrets: Partial<Record<IngressSecret, string>>;
  outputs: ReadonlyArray<{ output: IngressOutput; text: string }>;
};

/**
 * A secret the ingress Worker holds never reaches a response, a log line, an event it delivers,
 * or any other call it makes.
 */
export function ingressSecretsReachNoOutput(record: IngressRequestRecord): void {
  for (const { output, text } of record.outputs) {
    for (const [name, value] of Object.entries(record.secrets)) {
      if (!value || !text.includes(value)) continue;
      throw new Error(
        `ingressSecretsReachNoOutput: ${name} reached the ${output} of ${record.route}`,
      );
    }
  }
}

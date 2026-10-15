import { hmacSha256Hex } from "@artfct-ai/adapters/hmac";
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns } from "@artfct-ai/adapters/test/property-runs";
import { fakeDocuments, harness, SECRETS } from "../../test/app-harness";
import { badSignatureNeverDelivers } from "../../test/webhook-invariants";
import {
  githubPullRequest,
  linearSessionCreated,
  notionCommentCreated,
  slackMention,
} from "../../test/webhook-fixtures";

type Vendor = "github" | "linear" | "slack" | "notion";

type Tamper =
  | { kind: "signature byte changed"; index: number; step: number }
  | { kind: "signature replaced"; value: string }
  | { kind: "wrong secret"; secret: string }
  | { kind: "body changed after signing"; index: number; text: string }
  | { kind: "signature header missing" }
  | { kind: "signature header duplicated"; same: boolean; forgedFirst: boolean }
  | { kind: "stale timestamp"; skewSeconds: number }
  | { kind: "timestamp missing" }
  | { kind: "timestamp changed after signing"; skewSeconds: number }
  | { kind: "timestamp header duplicated" };

type Scheme = {
  path: string;
  secret: string;
  signatureHeader: string;
  signaturePrefix: string;
  headers: Record<string, string>;
};

const SCHEMES: Record<Vendor, Scheme> = {
  github: {
    path: "/webhooks/github",
    secret: SECRETS.GITHUB_WEBHOOK_SECRET,
    signatureHeader: "x-hub-signature-256",
    signaturePrefix: "sha256=",
    headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-1" },
  },
  linear: {
    path: "/webhooks/linear",
    secret: SECRETS.LINEAR_WEBHOOK_SECRET,
    signatureHeader: "linear-signature",
    signaturePrefix: "",
    headers: { "linear-delivery": "delivery-1" },
  },
  slack: {
    path: "/webhooks/slack",
    secret: SECRETS.SLACK_SIGNING_SECRET,
    signatureHeader: "x-slack-signature",
    signaturePrefix: "v0=",
    headers: {},
  },
  notion: {
    path: "/webhooks/notion",
    secret: SECRETS.NOTION_VERIFICATION_TOKEN,
    signatureHeader: "x-notion-signature",
    signaturePrefix: "sha256=",
    headers: {},
  },
};

const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

const DIGEST_LENGTH = 64;

const staleSkewSeconds = fc.oneof(
  fc.integer({ min: 400, max: 10_000_000 }),
  fc.integer({ min: -10_000_000, max: -400 }),
);

const commonTampers: fc.Arbitrary<Tamper>[] = [
  fc.record({
    kind: fc.constant("signature byte changed"),
    index: fc.nat(),
    step: fc.integer({ min: 1, max: 15 }),
  }),
  fc.record({ kind: fc.constant("signature replaced"), value: fc.string({ maxLength: 80 }) }),
  fc.record({
    kind: fc.constant("wrong secret"),
    secret: fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((secret) => !Object.values(SECRETS).includes(secret)),
  }),
  fc.record({
    kind: fc.constant("body changed after signing"),
    index: fc.nat(),
    text: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.constant({ kind: "signature header missing" }),
  fc.record({
    kind: fc.constant("signature header duplicated"),
    same: fc.boolean(),
    forgedFirst: fc.boolean(),
  }),
];

const TAMPERS: Record<Vendor, fc.Arbitrary<Tamper>> = {
  github: fc.oneof(...commonTampers),
  notion: fc.oneof(...commonTampers),
  linear: fc.oneof(
    ...commonTampers,
    fc.record({ kind: fc.constant("stale timestamp"), skewSeconds: staleSkewSeconds }),
    fc.constant({ kind: "timestamp missing" }),
  ),
  slack: fc.oneof(
    ...commonTampers,
    fc.record({ kind: fc.constant("stale timestamp"), skewSeconds: staleSkewSeconds }),
    fc.constant({ kind: "timestamp missing" }),
    fc.record({
      kind: fc.constant("timestamp changed after signing"),
      skewSeconds: fc.integer({ min: -250, max: 250 }).filter((skew) => skew !== 0),
    }),
    fc.constant({ kind: "timestamp header duplicated" }),
  ),
};

const webhookCase = fc.constantFrom<Vendor>("github", "linear", "slack", "notion").chain((vendor) =>
  fc.record({
    vendor: fc.constant(vendor),
    text: fc.string({ maxLength: 200 }),
    tamper: TAMPERS[vendor],
  }),
);

type PayloadOptions = { text: string; signedAtMs: number; tamper: Tamper | null };

const PAYLOAD_BODIES: Record<Vendor, (options: PayloadOptions) => string> = {
  github: ({ text }) => JSON.stringify(githubPullRequest("opened", { title: text })),
  linear: ({ text, signedAtMs, tamper }) => {
    const webhookTimestamp = tamper?.kind === "timestamp missing" ? undefined : signedAtMs;
    return JSON.stringify({ ...linearSessionCreated(), guidance: text, webhookTimestamp });
  },
  slack: ({ text }) => JSON.stringify(slackMention(`<@UBOT> ${text}`)),
  notion: ({ text }) => JSON.stringify({ ...notionCommentCreated(), id: `evt-${text}` }),
};

function changedHexDigit(signature: string, prefix: string, index: number, step: number): string {
  const position = prefix.length + (index % DIGEST_LENGTH);
  const digit = (parseInt(signature[position]!, 16) + step) % 16;
  return `${signature.slice(0, position)}${digit.toString(16)}${signature.slice(position + 1)}`;
}

function insertText(body: string, index: number, text: string): string {
  const position = index % (body.length + 1);
  return `${body.slice(0, position)}${text}${body.slice(position)}`;
}

async function webhookRequest(vendor: Vendor, text: string, tamper: Tamper | null) {
  const scheme = SCHEMES[vendor];
  const skewSeconds = tamper?.kind === "stale timestamp" ? tamper.skewSeconds : 0;
  const signedAtMs = Date.now() + skewSeconds * 1000;
  const timestamp = String(Math.floor(signedAtMs / 1000));
  const body = PAYLOAD_BODIES[vendor]({ text, signedAtMs, tamper });
  const secret = tamper?.kind === "wrong secret" ? tamper.secret : scheme.secret;
  const signedText = vendor === "slack" ? `v0:${timestamp}:${body}` : body;
  const signature = `${scheme.signaturePrefix}${await hmacSha256Hex(secret, signedText)}`;

  const headers = new Headers({ "content-type": "application/json", ...scheme.headers });
  const forged = changedHexDigit(signature, scheme.signaturePrefix, 0, 1);
  switch (tamper?.kind) {
    case "signature byte changed":
      headers.set(
        scheme.signatureHeader,
        changedHexDigit(signature, scheme.signaturePrefix, tamper.index, tamper.step),
      );
      break;
    case "signature replaced":
      headers.set(
        scheme.signatureHeader,
        tamper.value === signature ? `${tamper.value}0` : tamper.value,
      );
      break;
    case "signature header missing":
      break;
    case "signature header duplicated": {
      const extra = tamper.same ? signature : forged;
      const [first, second] = tamper.forgedFirst ? [extra, signature] : [signature, extra];
      headers.append(scheme.signatureHeader, first);
      headers.append(scheme.signatureHeader, second);
      break;
    }
    default:
      headers.set(scheme.signatureHeader, signature);
  }
  if (vendor === "slack") {
    switch (tamper?.kind) {
      case "timestamp missing":
        break;
      case "timestamp changed after signing":
        headers.set(SLACK_TIMESTAMP_HEADER, String(Number(timestamp) + tamper.skewSeconds));
        break;
      case "timestamp header duplicated":
        headers.append(SLACK_TIMESTAMP_HEADER, timestamp);
        headers.append(SLACK_TIMESTAMP_HEADER, timestamp);
        break;
      default:
        headers.set(SLACK_TIMESTAMP_HEADER, timestamp);
    }
  }
  const sentBody =
    tamper?.kind === "body changed after signing"
      ? insertText(body, tamper.index, tamper.text)
      : body;
  return new Request(`http://ingress${scheme.path}`, { method: "POST", headers, body: sentBody });
}

async function orchestratorCalls(vendor: Vendor, text: string, tamper: Tamper | null) {
  const app = harness({ clients: { documents: fakeDocuments() } });
  await app.request(await webhookRequest(vendor, text, tamper));
  await app.settle();
  return app.calls;
}

describe("webhook invariants", () => {
  it("hold for every vendor route and every tamper", async () => {
    await fc.assert(
      fc.asyncProperty(webhookCase, async ({ vendor, text, tamper }) => {
        expect(await orchestratorCalls(vendor, text, null)).toContain("deliver");
        badSignatureNeverDelivers({
          vendor,
          tamper: tamper.kind,
          calls: await orchestratorCalls(vendor, text, tamper),
        });
      }),
      propertyRuns("webhook signatures"),
    );
  });
});

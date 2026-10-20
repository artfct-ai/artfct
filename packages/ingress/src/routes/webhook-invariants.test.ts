import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { fakeDocuments, harness, type SECRETS } from "../../test/app-harness";
import { badSignatureNeverDelivers, genuineWebhookDelivers } from "../../test/webhook-invariants";
import {
  githubPullRequest,
  linearSessionCreated,
  notionCommentCreated,
  slackMention,
} from "../../test/webhook-fixtures";

const RUNS = 100;

type Vendor = "github" | "linear" | "slack" | "notion";

type Tamper =
  | { kind: "signature byte changed"; index: number; step: number }
  | { kind: "signature replaced"; value: string }
  | { kind: "wrong secret"; secret: string }
  | { kind: "body changed after signing"; index: number; text: string }
  | { kind: "signature header missing" }
  | { kind: "signature header duplicated"; same: boolean; forgedFirst: boolean }
  | { kind: "stale timestamp"; side: "past" | "future"; beyond: number }
  | { kind: "timestamp missing" }
  | { kind: "timestamp changed after signing"; skewSeconds: number }
  | { kind: "timestamp header duplicated" };

type Scheme = {
  path: string;
  secretName: keyof typeof SECRETS;
  signatureHeader: string;
  signaturePrefix: string;
  headers: Record<string, string>;
};

const SCHEMES: Record<Vendor, Scheme> = {
  github: {
    path: "/webhooks/github",
    secretName: "GITHUB_WEBHOOK_SECRET",
    signatureHeader: "x-hub-signature-256",
    signaturePrefix: "sha256=",
    headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-1" },
  },
  linear: {
    path: "/webhooks/linear",
    secretName: "LINEAR_WEBHOOK_SECRET",
    signatureHeader: "linear-signature",
    signaturePrefix: "",
    headers: { "linear-delivery": "delivery-1" },
  },
  slack: {
    path: "/webhooks/slack",
    secretName: "SLACK_SIGNING_SECRET",
    signatureHeader: "x-slack-signature",
    signaturePrefix: "v0=",
    headers: {},
  },
  notion: {
    path: "/webhooks/notion",
    secretName: "NOTION_VERIFICATION_TOKEN",
    signatureHeader: "x-notion-signature",
    signaturePrefix: "sha256=",
    headers: {},
  },
};

const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

const DIGEST_LENGTH = 64;

const LINEAR_WINDOW_MS = 60_000;

const SLACK_WINDOW_MS = 300_000;

/** The signed timestamps a vendor accepts at one moment, in the unit the vendor signs. */
type TimestampWindow = { lowest: number; highest: number };

const TIMESTAMP_WINDOWS: Record<Vendor, ((nowMs: number) => TimestampWindow) | null> = {
  github: null,
  notion: null,
  linear: (nowMs) => ({ lowest: nowMs - LINEAR_WINDOW_MS, highest: nowMs + LINEAR_WINDOW_MS }),
  slack: (nowMs) => ({
    lowest: Math.ceil((nowMs - SLACK_WINDOW_MS) / 1000),
    highest: Math.floor((nowMs + SLACK_WINDOW_MS) / 1000),
  }),
};

const STALE_TIMESTAMP_WEIGHT = 4;

const staleTimestamp = fc.record({
  kind: fc.constant("stale timestamp" as const),
  side: fc.constantFrom("past" as const, "future" as const),
  beyond: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 10_000_000 })),
});

const commonTampers: fc.Arbitrary<Tamper>[] = [
  fc.record({
    kind: fc.constant("signature byte changed"),
    index: fc.nat(),
    step: fc.integer({ min: 1, max: 15 }),
  }),
  fc.record({ kind: fc.constant("signature replaced"), value: fc.string({ maxLength: 80 }) }),
  fc.record({
    kind: fc.constant("wrong secret"),
    secret: fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
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
    { arbitrary: staleTimestamp, weight: STALE_TIMESTAMP_WEIGHT },
    fc.constant({ kind: "timestamp missing" }),
  ),
  slack: fc.oneof(
    ...commonTampers,
    { arbitrary: staleTimestamp, weight: STALE_TIMESTAMP_WEIGHT },
    fc.constant({ kind: "timestamp missing" }),
    fc.record({
      kind: fc.constant("timestamp changed after signing"),
      skewSeconds: fc.integer({ min: -250, max: 250 }).filter((skew) => skew !== 0),
    }),
    fc.constant({ kind: "timestamp header duplicated" }),
  ),
};

const payloadText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: fc.constantFrom("😀", "\u0000", "\r\n", "é", " ", " ", "a"), maxLength: 30 }),
);

const jsonIndent = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r\n"), maxLength: 5 });

const windowPosition = fc.oneof(fc.constantFrom(0, 1), fc.double({ min: 0, max: 1, noNaN: true }));

const webhookCase = fc.constantFrom<Vendor>("github", "linear", "slack", "notion").chain((vendor) =>
  fc.record({
    vendor: fc.constant(vendor),
    nowMs: fc.integer({ min: 1_600_000_000_000, max: 2_100_000_000_000 }),
    secret: fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }),
    text: payloadText,
    indent: jsonIndent,
    position: windowPosition,
    tamper: TAMPERS[vendor],
  }),
);

type WebhookCase = {
  vendor: Vendor;
  nowMs: number;
  secret: string;
  text: string;
  indent: string;
  position: number;
};

const PAYLOADS: Record<Vendor, (text: string, signedAt: number | undefined) => object> = {
  github: (text) => githubPullRequest("opened", { title: text }),
  linear: (text, signedAt) => ({
    ...linearSessionCreated(),
    guidance: text,
    webhookTimestamp: signedAt,
  }),
  slack: (text) => slackMention(`<@UBOT> ${text}`),
  notion: (text) => ({ ...notionCommentCreated(), id: `evt-${text}` }),
};

function signedTimestamp(webhook: WebhookCase, tamper: Tamper | null): number | undefined {
  const window = TIMESTAMP_WINDOWS[webhook.vendor]?.(webhook.nowMs);
  if (!window || tamper?.kind === "timestamp missing") return undefined;
  if (tamper?.kind === "stale timestamp") {
    return tamper.side === "past" ? window.lowest - tamper.beyond : window.highest + tamper.beyond;
  }
  return window.lowest + Math.round(webhook.position * (window.highest - window.lowest));
}

function webhookBody(webhook: WebhookCase, signedAt: number | undefined): string {
  return JSON.stringify(PAYLOADS[webhook.vendor](webhook.text, signedAt), null, webhook.indent);
}

function hmacSha256HexOracle(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("hex");
}

function changedHexDigit(signature: string, prefix: string, index: number, step: number): string {
  const position = prefix.length + (index % DIGEST_LENGTH);
  const digit = (parseInt(signature[position]!, 16) + step) % 16;
  return `${signature.slice(0, position)}${digit.toString(16)}${signature.slice(position + 1)}`;
}

function insertText(body: string, index: number, text: string): string {
  const position = index % (body.length + 1);
  return `${body.slice(0, position)}${text}${body.slice(position)}`;
}

function signingSecret(secret: string, tamper: Tamper | null): string {
  if (tamper?.kind !== "wrong secret") return secret;
  return tamper.secret === secret ? `${secret}x` : tamper.secret;
}

function webhookRequest(webhook: WebhookCase, tamper: Tamper | null): Request {
  const scheme = SCHEMES[webhook.vendor];
  const signedAt = signedTimestamp(webhook, tamper);
  const body = webhookBody(webhook, signedAt);
  const timestamp = String(signedAt);
  const signedText = webhook.vendor === "slack" ? `v0:${timestamp}:${body}` : body;
  const secret = signingSecret(webhook.secret, tamper);
  const signature = `${scheme.signaturePrefix}${hmacSha256HexOracle(secret, signedText)}`;

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
  if (webhook.vendor === "slack") {
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

async function orchestratorCalls(webhook: WebhookCase, tamper: Tamper | null) {
  const app = harness({
    clients: { documents: fakeDocuments() },
    secrets: { [SCHEMES[webhook.vendor].secretName]: webhook.secret },
  });
  await app.request(webhookRequest(webhook, tamper));
  await app.settle();
  return app.calls;
}

function holdsNonAscii(text: string): boolean {
  return Buffer.byteLength(text) !== text.length;
}

describe("webhook invariants", () => {
  afterEach(() => {
    setSystemTime();
  });

  it(
    "a genuine webhook delivers and a tampered one does not, for every vendor route",
    async () => {
      let nonAsciiBodies = 0;
      let nonAsciiSecrets = 0;
      let windowEdges = 0;
      await fc.assert(
        fc.asyncProperty(webhookCase, async ({ tamper, ...webhook }) => {
          setSystemTime(new Date(webhook.nowMs));
          const body = webhookBody(webhook, signedTimestamp(webhook, null));
          if (holdsNonAscii(body)) nonAsciiBodies++;
          if (holdsNonAscii(webhook.secret)) nonAsciiSecrets++;
          if (
            TIMESTAMP_WINDOWS[webhook.vendor] &&
            (webhook.position === 0 || webhook.position === 1)
          )
            windowEdges++;
          genuineWebhookDelivers({
            vendor: webhook.vendor,
            body,
            calls: await orchestratorCalls(webhook, null),
          });
          badSignatureNeverDelivers({
            vendor: webhook.vendor,
            tamper: tamper.kind,
            calls: await orchestratorCalls(webhook, tamper),
          });
        }),
        propertyRuns("webhook signatures", RUNS),
      );
      expect(nonAsciiBodies).toBeGreaterThan(0);
      expect(nonAsciiSecrets).toBeGreaterThan(0);
      expect(windowEdges).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});

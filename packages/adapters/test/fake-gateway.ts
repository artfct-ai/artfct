import type {
  AnthropicRoute,
  CompatRoute,
  Decisions,
  Gateway,
  GatewayMetadata,
  GatewayModel,
  JsonValue,
} from "../src/gateway/types";
import { CallLog, type RecordedCall } from "./calls";
import { FakeDecisions } from "./fake-decisions";

/** Fixed answers for a `FakeGateway`. */
export type GatewayAnswers = {
  /** Base URL. Routes hang off it as `/compat` and `/anthropic`. Default a gateway on the test account. */
  baseUrl?: string;
  /** Headers every compat route carries. Default one marker header. */
  headers?: Record<string, string>;
  /** Request fields every compat route adds. Default none. */
  fields?: Record<string, JsonValue>;
  /** False for a gateway with no Anthropic endpoint. */
  anthropic?: boolean;
  /** The decisions model the gateway carries. Default one whose every model fails. */
  decisions?: Decisions;
  /** The models the gateway lists, or an error every listing throws. Default none listed. */
  models?: GatewayModel[] | Error;
};

/** Methods a `FakeGateway` records. */
export type GatewayMethod = "compatRoute" | "anthropicRoute";

/** The metadata header a fake route carries, so a test can read what it was tagged with. */
export const FAKE_METADATA_HEADER = "x-fake-metadata";

/** An in-memory `Gateway` that routes to `baseUrl` and records what it was asked for. */
export class FakeGateway implements Gateway {
  private readonly log = new CallLog<GatewayMethod>(false);

  constructor(private readonly answers: GatewayAnswers = {}) {}

  get calls(): RecordedCall<GatewayMethod>[] {
    return this.log.calls;
  }

  compatRoute(model: string, metadata: GatewayMetadata): CompatRoute {
    this.log.record("compatRoute", model, metadata);
    return {
      baseUrl: `${this.baseUrl()}/compat`,
      model,
      apiKey: "fake-key",
      headers: {
        ...(this.answers.headers ?? { "x-fake-gateway": "yes" }),
        [FAKE_METADATA_HEADER]: JSON.stringify(metadata),
      },
      fields: this.answers.fields ?? {},
      catalog: { provider: "fake", model },
    };
  }

  anthropicRoute(metadata: GatewayMetadata): AnthropicRoute | null {
    this.log.record("anthropicRoute", metadata);
    if (this.answers.anthropic === false) return null;
    return {
      baseUrl: `${this.baseUrl()}/anthropic`,
      headers: { [FAKE_METADATA_HEADER]: JSON.stringify(metadata) },
    };
  }

  decisions(): Decisions {
    return this.answers.decisions ?? new FakeDecisions(new Error("every decisions model failed"));
  }

  async models(): Promise<GatewayModel[] | null> {
    if (this.answers.models instanceof Error) throw this.answers.models;
    return this.answers.models ?? null;
  }

  private baseUrl(): string {
    return this.answers.baseUrl ?? "https://gateway.ai.cloudflare.com/v1/acct/gw";
  }
}

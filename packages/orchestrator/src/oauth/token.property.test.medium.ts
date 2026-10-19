import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import type { TrackerOAuth, TrackerTokens } from "@artfct-ai/adapters/tracker/types";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRow } from "../../test/linear-install";
import { createDb } from "../db/client";
import { readLinearInstall, saveLinearInstall } from "../db/linear-installs";
import { InstallToken, REFRESH_MARGIN_MS } from "./token";

const db = createDb(env.DB);
const RUNS = 150;
const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const ISSUED_LIFETIME_S = 86_399;
const QUERY_LANDING_MS = 2;

type EndpointOutcome = "answers" | "fails" | "answer_lost";

type TokenPair = { access_token: string; refresh_token: string };

class RotatingTokenEndpoint implements TrackerOAuth {
  readonly initial: TokenPair;
  private live: string;
  private readonly issuedFor = new Map<string, TokenPair>();
  private calls = 0;

  constructor(
    private readonly prefix: string,
    private readonly outcomes: EndpointOutcome[],
    private readonly scheduler: fc.Scheduler,
  ) {
    this.initial = { access_token: `${prefix}-a0`, refresh_token: `${prefix}-r0` };
    this.live = this.initial.refresh_token;
  }

  authorizeUrl(): string {
    throw new Error("the property only refreshes");
  }

  exchangeCode(): Promise<TrackerTokens> {
    throw new Error("the property only refreshes");
  }

  async refreshTokens(refreshToken: string): Promise<TrackerTokens> {
    const outcome = this.outcomes[this.calls] ?? "answers";
    this.calls += 1;
    await this.scheduler.schedule(Promise.resolve(), `request ${refreshToken} ${outcome}`);
    if (outcome === "fails") throw new Error("linear oauth refresh_token: server_error");
    const pair = this.spend(refreshToken);
    await this.scheduler.schedule(Promise.resolve(), `answer ${pair.access_token}`);
    if (outcome === "answer_lost") throw new Error("network connection lost");
    return { ...pair, expires_in: ISSUED_LIFETIME_S };
  }

  private spend(refreshToken: string): TokenPair {
    const replayed = this.issuedFor.get(refreshToken);
    if (replayed) return replayed;
    if (refreshToken !== this.live) throw new Error("linear oauth refresh_token: invalid_grant");
    const generation = this.issuedFor.size + 1;
    const pair = {
      access_token: `${this.prefix}-a${generation}`,
      refresh_token: `${this.prefix}-r${generation}`,
    };
    this.issuedFor.set(refreshToken, pair);
    this.live = pair.refresh_token;
    return pair;
  }

  accepts(refreshToken: string | null): boolean {
    if (!refreshToken) return false;
    return refreshToken === this.live || this.issuedFor.has(refreshToken);
  }

  issuedPair(pair: { access_token: string; refresh_token: string | null }): boolean {
    const known = [this.initial, ...this.issuedFor.values()];
    return known.some(
      (issued) =>
        issued.access_token === pair.access_token && issued.refresh_token === pair.refresh_token,
    );
  }

  validAccessToken(accessToken: string, installedTokenAlive: boolean): boolean {
    if (accessToken === this.initial.access_token) return installedTokenAlive;
    return [...this.issuedFor.values()].some((pair) => pair.access_token === accessToken);
  }

  sawAFailure(): boolean {
    return this.outcomes.slice(0, this.calls).some((outcome) => outcome !== "answers");
  }
}

const STATEMENT_RUNS = new Set<string | symbol>(["all", "run", "first", "raw"]);

function boundMember(target: object, key: string | symbol): unknown {
  const member: unknown = Reflect.get(target, key);
  return typeof member === "function" ? member.bind(target) : member;
}

function scheduledStatement(
  statement: D1PreparedStatement,
  scheduler: fc.Scheduler,
  label: string,
): D1PreparedStatement {
  return new Proxy(statement, {
    get: (target, key) => {
      if (key === "bind") {
        return (...values: unknown[]) =>
          scheduledStatement(target.bind(...values), scheduler, label);
      }
      if (!STATEMENT_RUNS.has(key)) return boundMember(target, key);
      return async (...args: unknown[]) => {
        await scheduler.schedule(Promise.resolve(), label);
        return Reflect.apply(
          Reflect.get(target, key) as (...args: unknown[]) => unknown,
          target,
          args,
        );
      };
    },
  });
}

function scheduledD1(d1: D1Database, scheduler: fc.Scheduler): D1Database {
  return new Proxy(d1, {
    get: (target, key) =>
      key === "prepare"
        ? (query: string) =>
            scheduledStatement(target.prepare(query), scheduler, query.slice(0, 40))
        : boundMember(target, key),
  });
}

async function settleQueries(release: () => Promise<unknown>): Promise<void> {
  await release();
  await new Promise((resolve) => setTimeout(resolve, QUERY_LANDING_MS));
}

const race = fc.record({
  installedTokenAlive: fc.boolean(),
  callsPerIsolate: fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 })),
  outcomes: fc.array(fc.constantFrom<EndpointOutcome>("answers", "fails", "answer_lost"), {
    maxLength: 6,
  }),
});

let runNumber = 0;

describe("two isolates refreshing the tracker install token at once", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it(
    "give every caller a valid token unless a refresh failed on a dead token, and leave the install a refresh token the endpoint takes",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.scheduler(), race, async (scheduler, scenario) => {
          runNumber += 1;
          const endpoint = new RotatingTokenEndpoint(
            `run${runNumber}`,
            scenario.outcomes,
            scheduler,
          );
          const expiresInMs = scenario.installedTokenAlive ? REFRESH_MARGIN_MS - 1000 : -1000;
          await saveLinearInstall(
            db,
            installRow({
              ...endpoint.initial,
              expires_at: new Date(NOW + expiresInMs).toISOString(),
            }),
          );
          const installed = await readLinearInstall(db);
          if (!installed) throw new Error("no install");
          const isolateDb = createDb(scheduledD1(env.DB, scheduler));
          const isolates = [0, 1].map(
            () => new InstallToken(installed, isolateDb, endpoint, () => NOW),
          );
          const callers = isolates.flatMap((isolate, index) =>
            Array.from({ length: scenario.callsPerIsolate[index] ?? 1 }, () => isolate.current()),
          );
          const settled = await scheduler.waitFor(Promise.allSettled(callers), settleQueries);

          for (const result of settled) {
            if (result.status === "fulfilled") {
              expect(endpoint.validAccessToken(result.value, scenario.installedTokenAlive)).toBe(
                true,
              );
            } else {
              const cause = {
                installedTokenAlive: scenario.installedTokenAlive,
                sawAFailure: endpoint.sawAFailure(),
              };
              expect(cause).toEqual({ installedTokenAlive: false, sawAFailure: true });
            }
          }
          const stored = await readLinearInstall(db);
          expect(stored && endpoint.issuedPair(stored)).toBe(true);
          expect(endpoint.accepts(stored?.refresh_token ?? null)).toBe(true);
        }),
        propertyRuns("tracker install token refresh race", RUNS),
      );
    },
    propertyTimeoutMs(60_000, RUNS),
  );
});

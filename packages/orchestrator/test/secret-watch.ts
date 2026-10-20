import { debugDump, summarize } from "../src/workflow/status";
import type { SandboxRow } from "../src/workflow/store/tasks";
import type { FakeBridge } from "./fake-bridge";
import type { FakeRuntime } from "./fake-runtime";
import { storeRowsOf, type MemoryDb } from "./memory-db";
import {
  bridgeFrameExposures,
  devVarCredentials,
  outputExposures,
  secretsReachOnlyTheirDestinations,
  startSpecExposures,
  storeExposures,
  type Credential,
  type Destination,
  type Exposure,
} from "./orchestrator-secret-invariants";

/** What one check reads besides the runtime: the store, the bridges, and outputs only a caller sees. */
export type WatchedSources = {
  db: MemoryDb;
  bridges: readonly FakeBridge[];
  /** Credentials minted or issued outside the store, such as code host tokens. */
  derived: readonly Credential[];
  /** Growing lists of outputs the runtime does not hold, such as the calls a fake records. */
  outputs: Partial<Record<OutputKind, readonly unknown[]>>;
};

type OutputKind = Extract<Destination, { kind: "output" }>["output"];

/**
 * Checks every output of a fake runtime since its last check against the secret allowlist. The
 * store, the debug dump, and the status are read whole each time. A bridge token stays a secret
 * after a restart replaces it.
 */
export class SecretWatch {
  private readonly read = new Map<unknown, number>();

  private readonly bridgeTokens = new Set<string>();

  check(workflow: FakeRuntime, sources: WatchedSources): void {
    const rows = storeRowsOf(sources.db);
    const provider = workflow.sandboxProvider;
    const specs = this.newItems(provider.specs);
    for (const row of rows.sandboxes ?? []) this.bridgeTokens.add((row as SandboxRow).bridge_token);
    for (const spec of specs) this.bridgeTokens.add(spec.token);
    const bridgeTokens = [...this.bridgeTokens].map((value) => ({
      kind: "bridge_token" as const,
      value,
    }));
    const credentials = [...devVarCredentials(workflow.env), ...bridgeTokens, ...sources.derived];
    const outputs: [OutputKind, readonly unknown[]][] = [
      ["log", workflow.lines],
      ["post", workflow.posted],
      ["agent_note", workflow.notes],
      ...(Object.entries(sources.outputs) as [OutputKind, readonly unknown[]][]),
    ];
    const exposures: Exposure[] = [
      ...storeExposures(rows, credentials),
      ...outputExposures("debug_dump", [debugDump(workflow)]),
      ...outputExposures("status", [summarize(workflow)]),
      ...outputs.flatMap(([output, items]) => outputExposures(output, this.newItems(items))),
      ...specs.flatMap(startSpecExposures),
      ...this.newItems(provider.calls).map((call) => ({
        destination: call.startsWith("refreshGithubTokens ")
          ? { kind: "token_refresh" as const }
          : { kind: "sandbox_start" as const },
        text: call,
      })),
      ...sources.bridges.flatMap((bridge) =>
        this.newItems(bridge.sentFrames).flatMap(bridgeFrameExposures),
      ),
    ];
    secretsReachOnlyTheirDestinations({ credentials, exposures });
  }

  /** The items a list gained since the last check read it. */
  private newItems<Item>(items: readonly Item[]): Item[] {
    const from = this.read.get(items) ?? 0;
    this.read.set(items, items.length);
    return items.length < from ? [...items] : items.slice(from);
  }
}

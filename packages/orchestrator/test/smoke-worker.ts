import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { MockHarness } from "@artfct-ai/adapters/test/mock-harness";
import type { Actor } from "@artfct-ai/contracts/inbound";
import type { IdentityQuery } from "@artfct-ai/contracts/types";
import { registerConfig } from "../src/config/register-config";
import Orchestrator from "../src/index";
import { resolveActor } from "../src/router/identity";
import type { WorkflowServices } from "../src/conversation";
import { SMOKE_CONFIG } from "./smoke-config";
import { testServices, Conversation as TestConversation } from "./worker";

export { Sandbox, SandboxLarge } from "../src/index";

registerConfig(SMOKE_CONFIG);

/** The entrypoint of the smoke run. It holds no code host credential, so a fake says who may push. */
export default class SmokeOrchestrator extends Orchestrator {
  override resolveActor(query: IdentityQuery): Promise<Actor | null> {
    return resolveActor(this.env, query, { code: new FakeCodeHost() });
  }
}

/** The Conversation of the smoke run. Every harness is the bridge's in-process mock. */
export class Conversation extends TestConversation {
  override services: WorkflowServices = {
    ...testServices,
    harness: (_env, name) => new MockHarness(name),
  };
}

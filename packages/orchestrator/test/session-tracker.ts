import type {
  ActivityOptions,
  AgentActivityContent,
  SessionPlanItem,
} from "@artfct-ai/adapters/tracker/types";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";

export type TrackerHealth = "up" | "fails_before_storing" | "fails_after_storing";

export type StoredActivity = {
  session_id: string;
  id: string | null;
  content: AgentActivityContent;
};

export class SessionTracker extends FakeTracker {
  health: TrackerHealth = "up";
  readonly stored: StoredActivity[] = [];

  override async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    if (this.health === "fails_before_storing") throw new Error("tracker unavailable");
    const id = options.id ?? null;
    if (!id || !this.stored.some((activity) => activity.id === id)) {
      this.stored.push({ session_id: sessionId, id, content });
    }
    if (this.health === "fails_after_storing") throw new Error("tracker timed out");
  }

  override async setSessionPlan(sessionId: string, plan: SessionPlanItem[]): Promise<void> {
    if (this.health !== "up") throw new Error("tracker unavailable");
    await super.setSessionPlan(sessionId, plan);
  }
}

export function activityText(content: AgentActivityContent): string {
  if (content.type !== "action") return content.body;
  return [content.action, content.parameter, content.result ?? ""].join(" ");
}

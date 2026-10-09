import type {
  ActivityOptions,
  AgentActivityContent,
  SessionPlanItem,
} from "@artfct-ai/adapters/tracker/types";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";

/** How the tracker answers an activity: it stores it, or fails before or after storing it. */
export type TrackerHealth = "up" | "fails_before_storing" | "fails_after_storing";

/** One activity a session holds. */
export type StoredActivity = {
  session_id: string;
  id: string | null;
  content: AgentActivityContent;
};

/** A tracker that holds each session's activities and keeps one activity per id, as Linear does. */
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

/** The text a person reads in an activity. */
export function activityText(content: AgentActivityContent): string {
  if (content.type !== "action") return content.body;
  return [content.action, content.parameter, content.result ?? ""].join(" ");
}

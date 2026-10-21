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
  ephemeral: boolean;
};

/**
 * The next activity post of one of `types` that the Durable Object's restart cuts, and whether the
 * tracker stores it first.
 */
export type ActivityCut = {
  types: AgentActivityContent["type"][];
  stored: boolean;
  cut: () => void;
};

export class SessionTracker extends FakeTracker {
  health: TrackerHealth = "up";
  readonly stored: StoredActivity[] = [];
  /** Every activity post the tracker was asked for. */
  activityCalls = 0;
  private nextCut: ActivityCut | null = null;
  private narrationAttemptsToRefuse = 0;

  /** Refuse the next `attempts` narration posts before storing them. Other posts land. */
  refuseNarration(attempts: number): void {
    this.narrationAttemptsToRefuse = attempts;
  }

  /** True while the tracker still refuses narration posts. */
  refusesNarration(): boolean {
    return this.narrationAttemptsToRefuse > 0;
  }

  /** Cut the next activity post: it stores the activity or not, calls `cut`, and never returns. */
  cutNextActivity(cut: ActivityCut): void {
    this.nextCut = cut;
  }

  override async activity(
    sessionId: string,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    this.activityCalls += 1;
    const isNarration = content.type === "thought" && !options.ephemeral;
    if (isNarration && this.narrationAttemptsToRefuse > 0) {
      this.narrationAttemptsToRefuse -= 1;
      throw new Error("tracker refused the narration");
    }
    const cut = this.nextCut?.types.includes(content.type) ? this.nextCut : null;
    if (cut) {
      this.nextCut = null;
      if (cut.stored) this.store(sessionId, content, options);
      cut.cut();
      await new Promise<never>(() => {});
    }
    if (this.health === "fails_before_storing") throw new Error("tracker unavailable");
    this.store(sessionId, content, options);
    if (this.health === "fails_after_storing") throw new Error("tracker timed out");
  }

  private store(sessionId: string, content: AgentActivityContent, options: ActivityOptions): void {
    const id = options.id ?? null;
    if (!id || !this.stored.some((activity) => activity.id === id)) {
      this.stored.push({
        session_id: sessionId,
        id,
        content,
        ephemeral: options.ephemeral ?? false,
      });
    }
  }

  override async setSessionPlan(sessionId: string, plan: SessionPlanItem[]): Promise<void> {
    if (this.health !== "up") throw new Error("tracker unavailable");
    await super.setSessionPlan(sessionId, plan);
  }
}

import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { WorkflowStatus } from "@artfct-ai/contracts/types";
import { desc, eq, ne } from "drizzle-orm";
import { BoardStore } from "../board/board-store";
import { replyTargetKey } from "./reply-target-key";
import {
  agentTurn,
  conversation,
  replyTargets,
  stagePlan,
  workflowEnd,
  workflows,
  workflowSubject,
} from "./schema";
import {
  isWorkflowFinished,
  now,
  workflowStatusOf,
  type StagePlan,
  type Subject,
  type WorkflowEnd,
} from "./state";

/** The one row of the conversation: its id and its origin. */
export type ConversationRow = typeof conversation.$inferSelect;

/** One workflow of the conversation: its status, its plan, and its idle alarm. */
export type WorkflowRow = typeof workflows.$inferSelect;

/** The agent turn record: the turn that runs, or the turn a restart lost. */
export type AgentTurnRow = typeof agentTurn.$inferSelect;

/** What a turn start records about the turn that runs. */
export type RunningTurn = Omit<AgentTurnRow, "conversation_id" | "status">;

/** What the event that opens a conversation sets. */
export type NewConversation = Omit<ConversationRow, "opened_at">;

/** What the plan that creates a workflow sets. */
export type NewWorkflow = Pick<
  WorkflowRow,
  "workflow_id" | "definition" | "name" | "reason" | "repo" | "request_text" | "request_links"
> & { subject: Subject | null };

/** The workflow row columns code changes after the create. */
export type WorkflowPatch = Partial<Omit<WorkflowRow, "workflow_id" | "created_at">>;

function subjectOf(row: typeof workflowSubject.$inferSelect): Subject {
  switch (row.kind) {
    case "issue":
      return { kind: "issue", issue_id: row.tracker_id };
    case "project":
      return { kind: "project", project_id: row.tracker_id };
    default: {
      const unhandled: never = row.kind;
      throw new Error(`unknown subject kind ${String(unhandled)}`);
    }
  }
}

function subjectTrackerId(subject: Subject): string {
  return subject.kind === "issue" ? subject.issue_id : subject.project_id;
}

/**
 * Typed access to the conversation row, its workflow rows, and the tables that hold one fact about
 * one workflow: its end, its stage plan, and its subject. Also the reply targets and the agent
 * turn record of the conversation.
 */
export class WorkflowRowStore extends BoardStore {
  /** The conversation. Null before the event that opens it. */
  conversation(): ConversationRow | null {
    return this.db.select().from(conversation).get() ?? null;
  }

  /** The conversation, or throw. For code paths that run only once it was opened. */
  requireConversation(): ConversationRow {
    const row = this.conversation();
    if (!row) throw new Error("the conversation is not opened");
    return row;
  }

  /** Open the conversation, with its origin as the first reply target. */
  openConversation(opened: NewConversation): void {
    this.db
      .insert(conversation)
      .values({ ...opened, opened_at: now() })
      .run();
    if (opened.origin) this.addReplyTarget(opened.origin);
  }

  /** The one workflow of the conversation that has not ended. Null before the first and after the end. */
  activeWorkflow(): WorkflowRow | null {
    return this.db.select().from(workflows).where(ne(workflows.status, "ended")).get() ?? null;
  }

  /** The active workflow, else the last one that ended. Null before the first workflow. */
  workflowRow(): WorkflowRow | null {
    return (
      this.activeWorkflow() ??
      this.db.select().from(workflows).orderBy(desc(workflows.created_at)).get() ??
      null
    );
  }

  /** The workflow, or throw. For code paths that run only once a plan created it. */
  requireWorkflowRow(): WorkflowRow {
    const row = this.workflowRow();
    if (!row) throw new Error("the conversation has no workflow");
    return row;
  }

  /** Create a running workflow from the plan that names its definition, with its subject. */
  createWorkflow({ subject, ...created }: NewWorkflow): void {
    this.db
      .insert(workflows)
      .values({ ...created, status: "running", created_at: now() })
      .run();
    if (subject) this.writeSubject(subject);
  }

  /** Change columns of the workflow row. */
  updateWorkflow(patch: WorkflowPatch): void {
    if (Object.keys(patch).length === 0) return;
    const { workflow_id } = this.requireWorkflowRow();
    this.db.update(workflows).set(patch).where(eq(workflows.workflow_id, workflow_id)).run();
  }

  /** The status every reader outside the store sees: the end's status from the start of the end. */
  workflowStatus(): WorkflowStatus {
    return workflowStatusOf(this.requireWorkflowRow().status, this.workflowEnd());
  }

  /** True once the workflow shows a finished status. False before the first workflow. */
  workflowFinished(): boolean {
    return this.workflowRow() !== null && isWorkflowFinished(this.workflowStatus());
  }

  /** The end of the workflow. Null before a workflow, and before its end starts. */
  workflowEnd(): WorkflowEnd | null {
    const workflow = this.workflowRow();
    if (!workflow) return null;
    const { ends_as, reason, answering, posted } = workflowEnd;
    return (
      this.db
        .select({ ends_as, reason, answering, posted })
        .from(workflowEnd)
        .where(eq(workflowEnd.workflow_id, workflow.workflow_id))
        .get() ?? null
    );
  }

  /** Start the end: record it and move the workflow to `ending`, so a restart goes on with it. */
  startWorkflowEnd(end: WorkflowEnd): void {
    this.db
      .insert(workflowEnd)
      .values({ ...end, workflow_id: this.requireWorkflowRow().workflow_id })
      .run();
    this.updateWorkflow({ status: "ending" });
  }

  /** The channels heard the end, so a resumed end does not post again. */
  markWorkflowEndPosted(): void {
    const { workflow_id } = this.requireWorkflowRow();
    this.db
      .update(workflowEnd)
      .set({ posted: true })
      .where(eq(workflowEnd.workflow_id, workflow_id))
      .run();
  }

  /** What the last plan with stages set. Null before a workflow, and before such a plan. */
  stagePlan(): StagePlan | null {
    const workflow = this.workflowRow();
    if (!workflow) return null;
    const { stages, job_slots, page_parent, root_page } = stagePlan;
    return (
      this.db
        .select({ stages, job_slots, page_parent, root_page })
        .from(stagePlan)
        .where(eq(stagePlan.workflow_id, workflow.workflow_id))
        .get() ?? null
    );
  }

  /** Write the stage plan, or replace the one a former plan wrote. */
  writeStagePlan(plan: StagePlan): void {
    this.db
      .insert(stagePlan)
      .values({ ...plan, workflow_id: this.requireWorkflowRow().workflow_id })
      .onConflictDoUpdate({ target: stagePlan.workflow_id, set: plan })
      .run();
  }

  /** What the workflow works on. Null before a workflow, and until its origin, plan or an output sets it. */
  subject(): Subject | null {
    const workflow = this.workflowRow();
    if (!workflow) return null;
    const row = this.db
      .select()
      .from(workflowSubject)
      .where(eq(workflowSubject.workflow_id, workflow.workflow_id))
      .get();
    return row ? subjectOf(row) : null;
  }

  /** Write the subject of a workflow that has none. */
  writeSubject(subject: Subject): void {
    this.db
      .insert(workflowSubject)
      .values({
        workflow_id: this.requireWorkflowRow().workflow_id,
        kind: subject.kind,
        tracker_id: subjectTrackerId(subject),
      })
      .run();
  }

  /** The agent turn record. Null while no turn runs or waits to resume. */
  agentTurn(): AgentTurnRow | null {
    return this.db.select().from(agentTurn).get() ?? null;
  }

  /** Record the turn that starts, in place of the lost turn it resumes. */
  recordRunningTurn(turn: RunningTurn): void {
    const running = { ...turn, status: "running" as const };
    this.db
      .insert(agentTurn)
      .values({ ...running, conversation_id: this.requireConversation().conversation_id })
      .onConflictDoUpdate({ target: agentTurn.conversation_id, set: running })
      .run();
  }

  /** The heads-up of the running turn fired. */
  clearHeadsUpSchedule(): void {
    this.db.update(agentTurn).set({ heads_up_schedule: null }).run();
  }

  /** The running turn started or prompted a task, so the board change may be its reply. */
  markTurnBoardChanged(): void {
    this.db.update(agentTurn).set({ board_changed: true }).run();
  }

  /** A restart cut the running turn off. It keeps its first row and board change for the next start. */
  markTurnLost(): void {
    this.db
      .update(agentTurn)
      .set({ status: "lost", watchdog_schedule: null, heads_up_schedule: null })
      .run();
  }

  /** The turn ended, its watchdog fired, or a finished workflow dropped the lost turn. */
  deleteAgentTurn(): void {
    this.db.delete(agentTurn).run();
  }

  /** The places the conversation replies to, in the order they joined. */
  replyTargets(): ReplyTarget[] {
    return this.db
      .select({ target: replyTargets.target })
      .from(replyTargets)
      .orderBy(replyTargets.id)
      .all()
      .map((row) => row.target);
  }

  /** Add a place the conversation replies to. False when the place joined before. */
  addReplyTarget(target: ReplyTarget): boolean {
    const added = this.db
      .insert(replyTargets)
      .values({ target_key: replyTargetKey(target), target })
      .onConflictDoNothing()
      .returning({ id: replyTargets.id })
      .get();
    return added !== undefined;
  }
}

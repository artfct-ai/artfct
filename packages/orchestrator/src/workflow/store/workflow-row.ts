import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { BoardStore } from "../board/board-store";
import { replyTargetKey } from "./reply-target-key";
import {
  agentTurn,
  replyTargets,
  stagePlan,
  workflow,
  workflowEnd,
  workflowPlan,
  workflowSubject,
} from "./schema";
import type { StagePlan, Subject, WorkflowEnd, WorkflowPlan } from "./state";

/** The one row of the workflow: its status, request, origin, and idle alarm. */
export type WorkflowRow = typeof workflow.$inferSelect;

/** The agent turn record: the turn that runs, or the turn a restart lost. */
export type AgentTurnRow = typeof agentTurn.$inferSelect;

/** What a turn start records about the turn that runs. */
export type RunningTurn = Omit<AgentTurnRow, "workflow_id" | "status">;

/** What the event that creates a workflow sets. */
export type NewWorkflow = Pick<
  WorkflowRow,
  "workflow_id" | "request_title" | "request_text" | "request_links" | "origin"
> & { subject: Subject | null };

/** The workflow row columns code changes after the create. */
export type WorkflowPatch = Partial<Omit<WorkflowRow, "workflow_id">>;

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
 * Typed access to the workflow row and the tables that hold one fact about the whole workflow:
 * its end, its plan, its stage plan, its subject, its reply targets, and its agent turn record.
 */
export class WorkflowRowStore extends BoardStore {
  /** The workflow. Null before the event that creates it. */
  workflowRow(): WorkflowRow | null {
    return this.db.select().from(workflow).get() ?? null;
  }

  /** The workflow, or throw. For code paths that run only once it was created. */
  requireWorkflowRow(): WorkflowRow {
    const row = this.workflowRow();
    if (!row) throw new Error("the workflow is not created");
    return row;
  }

  /** Create the workflow as `new`, with its subject and its origin as the first reply target. */
  createWorkflow({ subject, ...created }: NewWorkflow): void {
    this.db
      .insert(workflow)
      .values({ ...created, status: "new" })
      .run();
    if (subject) this.writeSubject(subject);
    if (created.origin) this.addReplyTarget(created.origin);
  }

  /** Change columns of the workflow row. */
  updateWorkflow(patch: WorkflowPatch): void {
    if (Object.keys(patch).length === 0) return;
    this.db.update(workflow).set(patch).run();
  }

  /** What every reader calls the workflow: the name its plan gave it, else the request title. */
  workflowName(): string {
    return this.plan()?.name || this.requireWorkflowRow().request_title;
  }

  /** The workflow end that runs. Null while the workflow is not ending. */
  workflowEnd(): WorkflowEnd | null {
    const { ends_as, reason, answering, posted } = workflowEnd;
    return this.db.select({ ends_as, reason, answering, posted }).from(workflowEnd).get() ?? null;
  }

  /** Record the end before its first cancel, so a restart goes on with it. */
  recordWorkflowEnd(end: WorkflowEnd): void {
    this.db
      .insert(workflowEnd)
      .values({ ...end, workflow_id: this.requireWorkflowRow().workflow_id })
      .run();
  }

  /** The channels heard the end, so a resumed end does not post again. */
  markWorkflowEndPosted(): void {
    this.db.update(workflowEnd).set({ posted: true }).run();
  }

  /** The end finished its last step. */
  clearWorkflowEnd(): void {
    this.db.delete(workflowEnd).run();
  }

  /** The plan that started the workflow. Null before it. */
  plan(): WorkflowPlan | null {
    const { definition, name, reason, repo } = workflowPlan;
    return this.db.select({ definition, name, reason, repo }).from(workflowPlan).get() ?? null;
  }

  /** Write the plan, or replace the one a former plan wrote. */
  writePlan(plan: WorkflowPlan): void {
    this.db
      .insert(workflowPlan)
      .values({ ...plan, workflow_id: this.requireWorkflowRow().workflow_id })
      .onConflictDoUpdate({ target: workflowPlan.workflow_id, set: plan })
      .run();
  }

  /** What the last plan with stages set. Null before such a plan. */
  stagePlan(): StagePlan | null {
    const { stages, job_slots, page_parent, root_page } = stagePlan;
    return (
      this.db.select({ stages, job_slots, page_parent, root_page }).from(stagePlan).get() ?? null
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

  /** What the workflow works on. Null until a tracker origin, the plan or an output sets it. */
  subject(): Subject | null {
    const row = this.db.select().from(workflowSubject).get();
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
      .values({ ...running, workflow_id: this.requireWorkflowRow().workflow_id })
      .onConflictDoUpdate({ target: agentTurn.workflow_id, set: running })
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

  /** The places the workflow replies to, in the order they joined. */
  replyTargets(): ReplyTarget[] {
    return this.db
      .select({ target: replyTargets.target })
      .from(replyTargets)
      .orderBy(replyTargets.id)
      .all()
      .map((row) => row.target);
  }

  /** Add a place the workflow replies to. False when the place joined before. */
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

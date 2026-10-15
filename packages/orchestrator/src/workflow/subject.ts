import type { Tracker, TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TrackerRef } from "../artifact/types";
import type { Subject } from "./store/state";
import type { JobRow } from "./store/tasks";
import type { WorkflowRuntime } from "./types";

/** What the agent does when a tool needs a subject and the workflow does not have one yet. */
export const SET_SUBJECT_FIRST =
  "Call set_plan with subject set to the issue or project link the person named, or run the stage that produces the issues first.";

/** The subject a tracker origin sets: the issue of its session. Null for any other origin. */
export function originSubject(origin: ReplyTarget | null): Subject | null {
  if (origin?.source !== "tracker" || !origin.issue_id) return null;
  return { kind: "issue", issue_id: origin.issue_id };
}

/** The subject that an issue or project ref names. */
export function subjectOfRef(ref: TrackerRef): Subject {
  if (ref.kind === "issue") return { kind: "issue", issue_id: ref.issue_id };
  return { kind: "project", project_id: ref.project_id };
}

/** True when the ref names the subject itself. */
export function refNamesSubject(subject: Subject, ref: TrackerRef): boolean {
  if (subject.kind === "issue") return ref.kind === "issue" && ref.issue_id === subject.issue_id;
  return ref.kind === "project" && ref.project_id === subject.project_id;
}

/** True when the issue is the subject issue, one of its direct sub-issues, or an issue of the subject project. */
export function issueInSubject(subject: Subject, issue: TrackerIssue): boolean {
  if (subject.kind === "project") return issue.project_id === subject.project_id;
  return issue.id === subject.issue_id || issue.parent_id === subject.issue_id;
}

/**
 * Write the subject of a workflow that has none. A chat thread syncs into an issue subject, so
 * the thread becomes the subject issue's comment thread.
 */
export async function setWorkflowSubject(
  workflow: WorkflowRuntime,
  subject: Subject,
): Promise<void> {
  workflow.patchState({ subject });
  workflow.log(null, `subject: ${subject.kind} ${subjectId(subject)}`);
  const { origin } = workflow.state;
  if (subject.kind !== "issue" || origin?.source !== "chat") return;
  await workflow.notifier.linkChatThread({ issue_id: subject.issue_id }, origin);
}

/**
 * Validate that the output an author ended with names the subject. Null when it does, and when
 * the workflow has no subject yet.
 */
export async function validateOutputIsSubject(
  workflow: WorkflowRuntime,
  ref: TrackerRef,
): Promise<string | null> {
  const subject = workflow.state.subject ?? null;
  if (!subject || refNamesSubject(subject, ref)) return null;
  const shown = await shownSubject(workflow, subject);
  return `Your output names another ${ref.kind} than the subject of this workflow, ${shown}. A workflow works only its own subject. Put the work in ${shown} and end your turn with its link.`;
}

/** Validate that a plan names the subject the workflow already has. Null when it does, and when it has none. */
export async function validatePlanKeepsSubject(
  workflow: WorkflowRuntime,
  ref: TrackerRef,
): Promise<string | null> {
  const subject = workflow.state.subject ?? null;
  if (!subject || refNamesSubject(subject, ref)) return null;
  const shown = await shownSubject(workflow, subject);
  return `The subject of this workflow is ${shown}, and it never changes. Leave subject out, and ask the person to start a new workflow for the other ${ref.kind}.`;
}

/**
 * Validate that a job may name the issue: the workflow has a subject, and the issue is in it.
 * The issue is the tracker's answer from the lookup the start tool already made.
 */
export async function validateIssueInSubject(
  workflow: WorkflowRuntime,
  issue: TrackerIssue,
): Promise<string | null> {
  const subject = workflow.state.subject ?? null;
  if (!subject) {
    return `This workflow does not have a subject yet, so a job cannot work on ${issue.identifier}. ${SET_SUBJECT_FIRST}`;
  }
  if (issueInSubject(subject, issue)) return null;
  const name = await subjectName(workflow, subject);
  const scope =
    subject.kind === "issue"
      ? `the subject ${name} or one of its sub-issues`
      : `an issue of the subject project ${name}`;
  return `${issue.identifier} is not ${scope}. A workflow works only its own issues. Ask the person to start a new workflow for it.`;
}

/** The issues the subject covers: the subject issue and its direct sub-issues, or the project's issues. */
export async function subjectIssues(tracker: Tracker, subject: Subject): Promise<TrackerIssue[]> {
  if (subject.kind === "project") return tracker.projectIssues(subject.project_id);
  const [issue, subIssues] = await Promise.all([
    tracker.issue(subject.issue_id),
    tracker.subIssues(subject.issue_id),
  ]);
  return issue ? [issue, ...subIssues] : subIssues;
}

/**
 * True when the subject is an issue and the plan holds no stage that produces issues. Such a
 * workflow is done once the job on its subject completes the last planned stage.
 */
export function isSingleIssueWorkflow(workflow: WorkflowRuntime): boolean {
  if (workflow.state.subject?.kind !== "issue") return false;
  const { stages } = workflow.workflowDefinition();
  return !workflow.state.stages.some(
    (name) => stages.find((stage) => stage.name === name)?.artifact === "issues",
  );
}

/** True when completing this job ends a single-issue workflow: it works on the subject at the last planned stage. */
export function jobCompletesSingleIssueWorkflow(workflow: WorkflowRuntime, job: JobRow): boolean {
  const { subject, stages } = workflow.state;
  if (subject?.kind !== "issue" || job.issue_id !== subject.issue_id) return false;
  return stages.at(-1) === job.stage && isSingleIssueWorkflow(workflow);
}

function subjectId(subject: Subject): string {
  return subject.kind === "issue" ? subject.issue_id : subject.project_id;
}

/** The subject as the tracker shows it, for a message. */
async function trackedSubject(
  workflow: WorkflowRuntime,
  subject: Subject,
): Promise<{ name: string; url: string } | null> {
  const tracker = await workflow.tracker();
  if (!tracker) return null;
  if (subject.kind === "issue") {
    const issue = await tracker.issue(subject.issue_id);
    return issue ? { name: issue.identifier, url: issue.url } : null;
  }
  const project = await tracker.project(subject.project_id);
  return project ? { name: project.name, url: project.url } : null;
}

/** How a message names the subject: the issue identifier or the project name. */
async function subjectName(workflow: WorkflowRuntime, subject: Subject): Promise<string> {
  return (await trackedSubject(workflow, subject))?.name ?? subjectId(subject);
}

/** How a message shows the subject: its name and its link. */
async function shownSubject(workflow: WorkflowRuntime, subject: Subject): Promise<string> {
  const tracked = await trackedSubject(workflow, subject);
  return tracked ? `${tracked.name} (${tracked.url})` : subjectId(subject);
}

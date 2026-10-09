import type { Binding } from "./sources";

/** What an inbound event asks the workflow to do. */
export type EventKind =
  | "start"
  | "prompt"
  | "feedback"
  | "control"
  | "pr_event"
  | "ci_event"
  | "status"
  | "stop";

/** Control verbs carried by `control` events. */
export type Control = "cancel" | "pause" | "resume" | "instruct";

/** The person behind an event, resolved to an internal person ID. */
export type Actor = {
  person_id: string;
  email: string | null;
  display_name: string | null;
};

/** Where a reply to this event should go. One variant per capability. */
export type ReplyTarget =
  | { source: "tracker"; session_id: string; issue_id: string; team_id?: string }
  | { source: "chat"; channel: string; thread: string }
  | { source: "code"; repo: string; pull: number }
  | { source: "documents"; page_id: string };

/** The chat message to mark as received, for channels that show acknowledgement. */
export type Acknowledge = { message: string; user?: string };

/** What happened to one pull request. */
export type PullAction =
  | "opened"
  | "ready_for_review"
  | "reopened"
  | "closed"
  | "review"
  | "review_comment"
  | "comment"
  | "completed";

/** Details of one pull request event. */
export type PullDetail = {
  action: PullAction;
  repo: string;
  number: number;
  merged?: boolean;
  branch?: string;
  base?: string;
  conclusion?: string;
  check_names?: string[];
  reviewer?: string;
  /** True when the reviewer is an App. Access does not check an App, so the screen reads its text. */
  reviewer_is_app?: boolean;
  /** The code host's id for the review a review or review comment event belongs to. */
  review_id?: number;
  /** The code host's id for the conversation comment a `comment` event carries. */
  comment_id?: number;
  /** Inline comments. `id` is the code host's id for the comment, which a reaction is addressed to. */
  comments?: { id?: number; path?: string; line?: number; body: string }[];
};

/** Details of a push to a base branch, which every pull request on that base sees. */
export type BaseMovedDetail = {
  action: "base_moved";
  repo: string;
  base: string;
};

/** Details of one comment a person left on a document page. */
export type PageDetail = {
  /** The page, keyed the way its `documents_page` binding keys it. */
  page_id: string;
  /** The host's id for the comment, which a reply to it is addressed to. */
  comment_id: string;
};

/** Structured details for pull request and CI events. */
export type PullEventDetail = PullDetail | BaseMovedDetail;

/** Normalized event from any capability. Ingress builds it. The Workflow DO consumes it. */
export type InboundEvent = {
  id: string;
  kind: EventKind;
  actor: Actor | null;
  bindings: Binding[];
  links: string[];
  text: string;
  control?: Control;
  reply_to?: ReplyTarget;
  pull?: PullEventDetail;
  page?: PageDetail;
  title?: string;
  acknowledge?: Acknowledge;
};

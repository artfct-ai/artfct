/** One object a workflow works on, which routes events to that workflow's conversation, named by capability. */
export type Binding =
  | { source: "code_pull"; repo: string; number: number }
  | { source: "code_branch"; repo: string; branch: string }
  | { source: "tracker_issue" | "documents_page"; external_id: string };

/** The kinds of bound object, by name. */
export type BindingSource = Binding["source"];

/**
 * What a conversation belongs to: a chat thread, a tracker issue with every session on it, or a
 * tracker session without an issue.
 */
export type ConversationPlace =
  | { source: "chat_thread"; channel: string; thread: string }
  | { source: "tracker_issue"; issue_id: string }
  | { source: "tracker_session"; session_id: string };

/** One external object that routes events to a workflow, named by capability. */
export type Binding =
  | { source: "code_pull"; repo: string; number: number }
  | { source: "code_branch"; repo: string; branch: string }
  | {
      source: "tracker_issue" | "tracker_session" | "documents_page" | "chat_thread";
      external_id: string;
    };

/** The kinds of external object, by name. */
export type BindingSource = Binding["source"];

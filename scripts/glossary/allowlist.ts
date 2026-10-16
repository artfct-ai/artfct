import type { AllowedWord } from "./glossary";

const NOT_RULED_ON =
  "Existing use the owner has not ruled on. Remove the entry once it is renamed or confirmed.";

/** Uses of a banned word that name a different concept than the glossary term, with the reason. */
export const ALLOWED_WORDS: AllowedWord[] = [
  { word: "status", paths: "everywhere", reason: "Task, artifact, workflow, and HTTP statuses." },
  { word: "log", paths: "everywhere", reason: "Logging through `workflow.log` and the console." },
  { word: "write", paths: "everywhere", reason: "Writing files, rows, tokens, and prose." },
  {
    word: "step",
    paths: "everywhere",
    reason: "Model steps of `generateSteps` and numbered steps.",
  },
  { word: "session", paths: "everywhere", reason: "Chat, Linear agent, and ACP sessions." },
  {
    word: "resolve",
    paths: "everywhere",
    reason: "Resolving names, ids, references, and promises.",
  },
  { word: "place", paths: "everywhere", reason: "The plain word, as in 'in place of'." },
  { word: "board", paths: "everywhere", reason: "board is its own glossary term." },
  { word: "summary", paths: "everywhere", reason: "Step, page review, and digest summaries." },
  { word: "bridge", paths: "everywhere", reason: "The sandbox bridge process." },
  { word: "binding", paths: "everywhere", reason: "binding is its own glossary term." },
  {
    word: "scope",
    paths: "everywhere",
    reason: "The scope of a request or a change, and OAuth scopes.",
  },
  { word: "the review", paths: "everywhere", reason: "review is its own glossary term." },
  {
    word: "note",
    paths: "everywhere",
    reason: "Notes of a board or an agent, and notes in prose.",
  },
  { word: "cancel", paths: "everywhere", reason: "The cancel control word, tool, and status." },
  { word: "transcript", paths: "everywhere", reason: "transcript is its own glossary term." },
  { word: "revision", paths: "everywhere", reason: "revision is its own glossary term." },
  { word: "retry", paths: "everywhere", reason: "Retrying a request or a delivery." },
  { word: "edit", paths: "everywhere", reason: "Editing pages, issues, and comments on a vendor." },
  { word: "pass", paths: "everywhere", reason: "A model pass, and passing an argument." },
  { word: "mode", paths: "everywhere", reason: "Config modes, such as a refiner entry's mode." },
  { word: "fix", paths: "everywhere", reason: "Fixing a defect in code." },
  { word: "polish", paths: "everywhere", reason: "The polish refiner phase." },
  { word: "quote", paths: "everywhere", reason: "Quoting text, and shell quoting." },
  { word: "release", paths: "everywhere", reason: "Releasing a chat thread, and model releases." },
  { word: "version", paths: "everywhere", reason: "Package, model, and API versions." },
  { word: "phase", paths: "everywhere", reason: "phase is its own glossary term." },
  { word: "checklist", paths: "everywhere", reason: "checklist is its own glossary term." },
  {
    word: "history",
    paths: [
      "packages/adapters/src/chat/slack/chat.ts",
      "packages/adapters/src/chat/slack/failures.ts",
      "packages/adapters/src/chat/slack/history.ts",
      "packages/adapters/src/chat/types.ts",
      "packages/orchestrator/src/agent/tools/history.ts",
      "packages/orchestrator/src/agent/tools/toolset.ts",
    ],
    reason: "The Slack history API and the chat history tools.",
  },
  {
    word: "draft",
    paths: [
      "packages/adapters/src/code/github/mcp.ts",
      "packages/orchestrator/src/workflow/artifact.ts",
      "packages/orchestrator/src/workflow/refiner/outcome.ts",
      "packages/orchestrator/src/workflow/store/records.ts",
      "packages/orchestrator/src/workflow/task/harness/turn.ts",
      "template/orchestrator/writing-rules.md",
    ],
    reason: "A draft pull request, and an artifact in `drafted` status.",
  },
  {
    word: "pause",
    paths: [
      "packages/contracts/src/inbound.ts",
      "packages/orchestrator/src/agent/prompt/system-prompt.ts",
      "packages/orchestrator/src/agent/tools/task.ts",
      "packages/orchestrator/src/workflow/inbound/control-words.ts",
      "packages/orchestrator/src/workflow/inbound/controls.ts",
      "packages/orchestrator/src/workflow/refiner/feedback-route.ts",
    ],
    reason: "The pause control word and the pause_task tool.",
  },
  {
    word: "inline comment",
    paths: [
      "packages/adapters/src/code/types.ts",
      "packages/adapters/src/documents/linear/documents.ts",
      "packages/adapters/src/documents/notion/documents.ts",
      "packages/adapters/src/documents/notion/page-comments.ts",
      "packages/orchestrator/src/artifact/pull.ts",
    ],
    reason: "A vendor's inline comment on a pull request or a page.",
  },
  {
    word: "integration",
    paths: [
      "packages/adapters/src/documents/linear/held-comments.ts",
      "packages/adapters/src/documents/notion/documents.ts",
      "packages/adapters/src/tracker/linear/inbound-comment.ts",
      "packages/adapters/src/tracker/linear/tracker.ts",
    ],
    reason: "A Notion, Linear, or Slack integration is the vendor's app.",
  },
  {
    word: "Jev",
    paths: [
      "packages/adapters/src/gateway/models-in-order.ts",
      "packages/adapters/src/gateway/types.ts",
      "packages/orchestrator/src/config/config.ts",
      "packages/orchestrator/src/config/gateway.ts",
      "template/orchestrator/artfct.yaml",
    ],
    reason: "The id of one vendor's model in config and its docs.",
  },
  {
    word: "truncated",
    paths: [
      "packages/adapters/src/documents/notion/documents.ts",
      "packages/adapters/src/web/http.ts",
      "packages/adapters/src/web/types.ts",
      "packages/orchestrator/src/agent/tools/web.ts",
    ],
    reason: "A web page or a Notion page its source cut short.",
  },
  {
    word: "home",
    paths: [
      "packages/adapters/src/harness/claude-code/harness.ts",
      "packages/adapters/src/harness/opencode/harness.ts",
      "packages/adapters/src/harness/types.ts",
      "packages/orchestrator/src/sandbox/spec.ts",
    ],
    reason: "The home directory of the sandbox user.",
  },
  {
    word: "memory",
    paths: [
      "packages/orchestrator/src/agent/tools/mcp.ts",
      "packages/orchestrator/src/oauth/token.ts",
      "packages/orchestrator/src/workflow/feed/feed.ts",
      "packages/orchestrator/src/workflow/types.ts",
    ],
    reason: "State held in memory and not stored.",
  },
  {
    word: "round",
    paths: [
      "packages/orchestrator/src/config/duration.ts",
      "packages/orchestrator/src/sandbox/cloudflare.ts",
      "packages/orchestrator/src/workflow/store/schema.ts",
    ],
    reason: "Rounding a number, and a round trip.",
  },
  {
    word: "anchor",
    paths: [
      "packages/adapters/src/code/github/review.ts",
      "packages/adapters/src/documents/page-text-update.ts",
    ],
    reason: "Anchoring a vendor comment or an edit to lines.",
  },
  {
    word: "mirror",
    paths: ["packages/adapters/src/documents/linear/mentions.ts"],
    reason: "Linear's ProseMirror document format.",
  },
  {
    word: "classification",
    paths: ["template/orchestrator/skills/directions/SKILL.md"],
    reason: "Classifying a request as a defect or a capability.",
  },
  {
    word: "resolution",
    paths: [
      "packages/orchestrator/src/agent/tools/artifact.ts",
      "packages/orchestrator/src/agent/tools/read.ts",
      "packages/orchestrator/src/agent/tools/task.ts",
      "template/orchestrator/skills/design-revise/SKILL.md",
      "template/orchestrator/skills/page-revise/SKILL.md",
    ],
    reason: NOT_RULED_ON,
  },
  {
    word: "intent",
    paths: [
      "packages/orchestrator/src/agent/tools/channel.ts",
      "packages/orchestrator/src/agent/tools/start/start.ts",
      "packages/orchestrator/src/agent/tools/task.ts",
      "template/orchestrator/skills/code-cleaner/SKILL.md",
    ],
    reason: NOT_RULED_ON,
  },
  {
    word: "mirror",
    paths: ["packages/orchestrator/src/agent/tools/channel.ts"],
    reason: NOT_RULED_ON,
  },
  {
    word: "root stage",
    paths: ["packages/orchestrator/src/agent/tools/page-plan.ts"],
    reason: NOT_RULED_ON,
  },
  {
    word: "verdict",
    paths: ["template/orchestrator/skills/plan-review/SKILL.md"],
    reason: NOT_RULED_ON,
  },
];

import type { DecisionState } from "@artfct-ai/adapters/gateway/types";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { taskTools } from "../src/agent/tools/task";
import { isTaskFinished, isWorkflowFinished } from "../src/workflow/store/state";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfSet, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";
import {
  agentCancels,
  authorTurnEnds,
  firstArtifactAppears,
  personCancels,
} from "./workflow-actions";
import {
  HELD_COMMENT,
  WorkflowWorld,
  type Step,
  type WorkflowAction,
  type WorldAuthor,
  type WorldSetup,
} from "./workflow-world";

/** The setup modules of the feedback routing spec, and the artifact each one's author works on. */
export const SPEC_SETUPS = { pullRequestFeedback: "pull", pageFeedback: "page" } as const;

/** The name of one setup module of the spec. */
export type SpecSetup = keyof typeof SPEC_SETUPS;

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 12;

const FORMS = ["ReviewComment", "AppReview", "PageMention"] as const;
const SCREENS = ["Admitted", "NotAdmitted", "Unreadable"] as const;
const ACKS = ["AckSucceeds", "AckFails"] as const;
const HELD_READS = ["HeldReadable", "HeldUnreadable"] as const;
const ANSWERS = [
  "ForTheAuthor",
  "AsksForNothing",
  "BeyondTheAuthor",
  "Unsure",
  "CallFails",
] as const;
const AUTHOR_STATUSES = ["Running", "Idle", "Paused", "Finished"] as const;
const WORKFLOW_STATUSES = ["WorkflowRunning", "WorkflowEnded"] as const;
const WORDS = ["PersonWords", "AppWords", "HeldWords"] as const;
const NOTE_KINDS = [
  "NoNote",
  "NotAdmittedNote",
  "HeldUnreadableNote",
  "NotMarkedReadNote",
  "AuthorFinishedNote",
  "SentToAuthorNote",
  "AsksForNothingNote",
  "ForTheAgentNote",
] as const;
const WAKES = ["NoWake", "WakesForTheHumans"] as const;

type Words = (typeof WORDS)[number];

/** A note the spec does not name, or more than one note, shows as itself so the step diverges. */
type NoteKind = (typeof NOTE_KINDS)[number] | `OtherNote: ${string}` | "SeveralNotes";

/** A wake the spec does not name shows as itself so the step diverges. */
type WakeName = (typeof WAKES)[number] | `Wake: ${string}`;

/** What one feedback showed, as the spec counts it. */
type ShownView = {
  promptsAdded: number;
  prompted: Words[];
  note: NoteKind;
  wake: WakeName;
  heard: Words[];
};

/** The workflow, its author, its artifact, and what the last feedback showed. */
export type FeedbackView = {
  workflow: (typeof WORKFLOW_STATUSES)[number];
  author: { status: (typeof AUTHOR_STATUSES)[number]; promptsWaiting: number };
  recorded: boolean;
  heldOnPage: boolean;
  shown: ShownView | null;
};

/** What a spec action picked. */
type SpecPicks = {
  form: (typeof FORMS)[number] | null;
  screen: (typeof SCREENS)[number] | null;
  ack: (typeof ACKS)[number] | null;
  heldRead: (typeof HELD_READS)[number] | null;
  answer: (typeof ANSWERS)[number] | null;
};

/** One state of a trace: the action that led to it, what it picked, and the world as the spec sees it. */
export type TraceStep = { action: string; picks: SpecPicks; view: FeedbackView };

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "feedback-routing",
      setup,
      count,
      steps: TRACE_STEPS,
      seed,
    },
    (trace) => itfList(itfField(trace, "states")).map((state) => traceStep(state)),
  );
}

function traceStep(state: unknown): TraceStep {
  const picks = itfField(state, "mbt::nondetPicks");
  return {
    action: itfText(itfField(state, "mbt::actionTaken")),
    picks: {
      form: pickedTag(picks, "form", FORMS),
      screen: pickedTag(picks, "screen", SCREENS),
      ack: pickedTag(picks, "ack", ACKS),
      heldRead: pickedTag(picks, "heldRead", HELD_READS),
      answer: pickedTag(picks, "answer", ANSWERS),
    },
    view: specView(stateVar(state, "world"), stateVar(state, "lastFeedback")),
  };
}

function stateVar(state: unknown, name: string): unknown {
  if (typeof state !== "object" || state === null)
    throw new Error("the trace state is not a record");
  const found = Object.keys(state).find((key) => key.endsWith(`::${name}`));
  if (!found) throw new Error(`the trace has no ${name}`);
  return itfField(state, found);
}

function pickedTag<Name extends string>(
  picks: unknown,
  name: string,
  names: readonly Name[],
): Name | null {
  const picked = itfVariant(itfField(picks, name, true));
  if (picked?.tag !== "Some") return null;
  return tagOf(picked.value, names);
}

function tagOf<Name extends string>(value: unknown, names: readonly Name[]): Name {
  const variant = itfVariant(value);
  if (!variant) throw new Error(`the trace has ${JSON.stringify(value)}, not a variant`);
  return itfOneOf(variant.tag, names);
}

function wordsOf(value: unknown): Words[] {
  const words = itfSet(value).map((element) => tagOf(element, WORDS));
  return WORDS.filter((name) => words.includes(name));
}

function specView(world: unknown, lastFeedback: unknown): FeedbackView {
  const author = itfField(world, "author");
  const last = itfVariant(lastFeedback);
  const shown = last?.tag === "FeedbackArrived" ? itfField(last.value, "shown") : null;
  return {
    workflow: tagOf(itfField(world, "workflow"), WORKFLOW_STATUSES),
    author: {
      status: tagOf(itfField(author, "status"), AUTHOR_STATUSES),
      promptsWaiting: itfInt(itfField(author, "promptsWaiting")),
    },
    recorded: itfBool(itfField(world, "recorded")),
    heldOnPage: itfBool(itfField(world, "heldOnPage")),
    shown:
      shown === null
        ? null
        : {
            promptsAdded: itfInt(itfField(shown, "promptsAdded")),
            prompted: wordsOf(itfField(shown, "prompted")),
            note: tagOf(itfField(shown, "note"), NOTE_KINDS),
            wake: tagOf(itfField(shown, "wake"), WAKES),
            heard: wordsOf(itfField(shown, "heard")),
          },
  };
}

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };

const WORLD_SETUP: Omit<WorldSetup, "artifact"> = {
  opening: "job",
  refiners: "none",
  research: false,
  pageAuthor: "harness",
  checksOnPush: "passed",
  pageEnding: "acceptance",
  origin: "chat",
  firstInput: "request",
  subject: "none",
  sandboxStart: "at_task_start",
};

const PERSON_TEXT = "Why does the redirect skip the check?";
const PERSON_COMMENT = { id: 7, path: "src/login.ts", line: 12, body: "Rename this." };
const APP_TEXT = "The lint app flags the redirect.";
const APP_COMMENT = { id: 8, path: "src/login.ts", line: 30, body: "Drop the retry." };

/** What the decisions model answers one call with, or the error a failed call throws. */
type CallAnswer = Record<string, number> | Error;

const SCREEN_ANSWERS: Record<(typeof SCREENS)[number], CallAnswer> = {
  Admitted: {},
  NotAdmitted: { takes_control: 0.9 },
  Unreadable: new Error("the decisions model is down"),
};

const ROUTE_ANSWERS: Record<(typeof ANSWERS)[number], CallAnswer> = {
  ForTheAuthor: { for_author: 0.95, beyond_author: 0.05 },
  AsksForNothing: { for_author: 0.05, beyond_author: 0.05 },
  BeyondTheAuthor: { for_author: 0.9, beyond_author: 0.6 },
  Unsure: { for_author: 0.5, beyond_author: 0.05 },
  CallFails: new Error("the decisions model is down"),
};

/** Each note the code writes about a feedback, by the words that tell it apart, in the order to try them. */
const NOTE_MARKERS: [string, (typeof NOTE_KINDS)[number]][] = [
  ["Nobody was sent it and you cannot read it.", "NotAdmittedNote"],
  ["but the host could not be read. They stay held", "HeldUnreadableNote"],
  ["The host did not mark it read, so nobody was sent it.", "NotMarkedReadNote"],
  ["so nothing can be sent to it.", "AuthorFinishedNote"],
  ["and sent it whole to the author.", "SentToAuthorNote"],
  ["It asks for nothing, so nobody was sent it.", "AsksForNothingNote"],
  ["and sent it to nobody.", "ForTheAgentNote"],
];

function noteKindOf(text: string): NoteKind {
  const marked = NOTE_MARKERS.find(([marker]) => text.includes(marker));
  return marked ? marked[1] : `OtherNote: ${text.slice(0, 300)}`;
}

function wakeNameOf(wake: string): WakeName {
  if (wake === "human") return "WakesForTheHumans";
  if (wake === "none") return "NoWake";
  return `Wake: ${wake}`;
}

/** The texts of each kind of words one feedback may carry. */
type FeedbackTexts = Record<Words, string[]>;

function wordsIn(texts: string[], words: FeedbackTexts): Words[] {
  return WORDS.filter((name) =>
    words[name].some((said) => texts.some((text) => text.includes(said))),
  );
}

function worldAction(label: string, run: (world: WorkflowWorld) => Promise<void>): WorkflowAction {
  return { run, toString: () => label };
}

function required<Value>(value: Value | null): Value {
  if (value === null) throw new Error("the trace lacks a pick its action needs");
  return value;
}

/**
 * Replays spec traces through a workflow world whose one author works on a pull request or a
 * page. Feedback arrives through the inbound event entry point. A person's pull request
 * feedback takes the shape of a review, a review comment, and a comment in turn.
 */
export class FeedbackRoutingReplay {
  private feedbacks = 0;
  private shown: ShownView | null = null;

  private constructor(
    readonly world: WorkflowWorld,
    private readonly onAPage: boolean,
  ) {}

  /**
   * A world whose author's first turn runs. A page is recorded, and its comment stays held when
   * the spec starts with one. A pull request is open but not recorded.
   */
  static async open(setup: SpecSetup, initial: FeedbackView): Promise<FeedbackRoutingReplay> {
    const artifact = SPEC_SETUPS[setup];
    const world = await WorkflowWorld.open({ ...WORLD_SETUP, artifact });
    const replay = new FeedbackRoutingReplay(world, artifact === "page");
    if (artifact === "pull") {
      world.openPull(replay.author());
      return replay;
    }
    await world.apply(firstArtifactAppears(0, "author_text"));
    if (!initial.heldOnPage) {
      await world.pageHost.acknowledgeComment({
        pageId: replay.pageId(),
        commentId: HELD_COMMENT.id,
      });
    }
    return replay;
  }

  /** Take one spec action through the world. */
  async take(step: TraceStep): Promise<void> {
    if (step.action === "finished") return;
    this.shown = null;
    switch (step.action) {
      case "personPostsFeedback":
        await this.personPostsFeedback(step.picks);
        return;
      case "personLeavesAPageComment":
        await this.world.apply(
          worldAction("a person comments on the page", () => this.personLeavesAPageComment()),
        );
        return;
      case "authorRecordsItsPullRequest":
        await this.world.apply(firstArtifactAppears(0, "author_text"));
        return;
      case "authorTurnEnds":
        await this.world.apply(authorTurnEnds(0, "same", "finished"));
        return;
      case "agentPausesAuthor":
        await this.world.apply(
          worldAction("agent pauses the author", async (world) => {
            const { pause_task } = taskTools(world.workflow);
            await pause_task.execute({ task_id: this.author().taskId }, TOOL_CALL);
          }),
        );
        return;
      case "agentCancelsJob":
        await this.world.apply(agentCancels(0, "author"));
        return;
      case "workflowEnds":
        await this.world.apply(personCancels("control"));
        return;
      default:
        throw new Error(`no world action for spec action ${step.action}`);
    }
  }

  /** The world as the spec sees it. */
  project(): FeedbackView {
    const { workflow } = this.world;
    const task = this.world.taskOf(this.author());
    const status = isTaskFinished(task.status)
      ? "Finished"
      : task.paused_at !== null
        ? "Paused"
        : workflow.store.sandbox(task.task_id)?.prompt_in_flight === 1
          ? "Running"
          : "Idle";
    return {
      workflow: isWorkflowFinished(workflow.state.status) ? "WorkflowEnded" : "WorkflowRunning",
      author: {
        status,
        promptsWaiting: workflow.store.queue().filter((row) => row.task_id === task.task_id).length,
      },
      recorded: this.world.artifactOf(this.author()) !== null,
      heldOnPage: this.onAPage && this.world.pageHost.heldNow().length > 0,
      shown: this.shown,
    };
  }

  private author(): WorldAuthor {
    const author = this.world.authors[0];
    if (!author) throw new Error("the world has no author");
    return author;
  }

  private answerDecisions(picks: SpecPicks): void {
    const screen = SCREEN_ANSWERS[required(picks.screen)];
    const route = ROUTE_ANSWERS[required(picks.answer)];
    const answering = (state: DecisionState) =>
      Object.hasOwn(state, "comment") ? route : Object.hasOwn(state, "text") ? screen : {};
    this.world.workflow.gatewayInstance = new FakeGateway({
      decisions: new FakeDecisions(answering),
    });
  }

  private async personPostsFeedback(picks: SpecPicks): Promise<void> {
    this.feedbacks += 1;
    const author = this.author();
    const promptsBefore = this.world.promptsQueuedFor(author.taskId).length;
    this.answerDecisions(picks);
    const form = required(picks.form);
    const delivery =
      form === "PageMention"
        ? this.mentionOnThePage(picks)
        : { texts: this.pullFeedbackTexts(form), run: () => this.postOnThePull(picks, form) };
    const step = await this.world.apply(
      worldAction(`a person posts ${form} with ${JSON.stringify(picks)}`, delivery.run),
    );
    const prompts = this.world.promptsQueuedFor(author.taskId).slice(promptsBefore);
    this.shown = this.shownBy(step, prompts, delivery.texts);
  }

  private pullFeedbackTexts(form: "ReviewComment" | "AppReview"): FeedbackTexts {
    return form === "AppReview"
      ? { PersonWords: [], AppWords: [APP_TEXT, APP_COMMENT.body], HeldWords: [] }
      : { PersonWords: [PERSON_TEXT, PERSON_COMMENT.body], AppWords: [], HeldWords: [] };
  }

  private async postOnThePull(picks: SpecPicks, form: "ReviewComment" | "AppReview") {
    const pull = this.world.pullDetailOf(this.author());
    const event =
      form === "AppReview"
        ? {
            kind: "feedback" as const,
            text: APP_TEXT,
            pull: {
              ...pull,
              action: "review" as const,
              comments: [APP_COMMENT],
              reviewer_is_app: true,
            },
          }
        : { kind: "feedback" as const, text: PERSON_TEXT, pull: this.personPullDetail(pull) };
    if (required(picks.ack) === "AckFails") {
      await this.world.whileHostIsDown(() => this.world.deliver(event));
      return;
    }
    await this.world.deliver(event);
  }

  private personPullDetail(pull: { repo: string; number: number; branch?: string }) {
    switch (this.feedbacks % 3) {
      case 0:
        return { ...pull, action: "comment" as const, comment_id: 42 };
      case 1:
        return { ...pull, action: "review" as const, comments: [PERSON_COMMENT] };
      default:
        return {
          ...pull,
          action: "review_comment" as const,
          review_id: 500,
          comments: [PERSON_COMMENT],
        };
    }
  }

  private mentionOnThePage(picks: SpecPicks): { texts: FeedbackTexts; run: () => Promise<void> } {
    const pageId = this.pageId();
    const host = this.world.pageHost;
    const held = host.heldNow().map((comment) => comment.text);
    const body = `Mention ${this.feedbacks}: tighten the summary.`;
    const commentId = `mention-${this.feedbacks}`;
    const run = async () => {
      host.addPersonComment({
        id: commentId,
        pageId,
        lineId: null,
        authorName: "Bea",
        text: `@artfct ${body}`,
        mentionsSelf: true,
      });
      const restore =
        required(picks.heldRead) === "HeldUnreadable"
          ? this.failingHost("heldComments")
          : required(picks.ack) === "AckFails"
            ? this.failingHost("acknowledgeComment")
            : () => undefined;
      try {
        await this.world.deliver({
          kind: "feedback",
          text: `@artfct ${body}`,
          bindings: [{ source: "documents_page", external_id: pageId }],
          page: { page_id: pageId, comment_id: commentId },
        });
      } finally {
        restore();
      }
    };
    return { texts: { PersonWords: [body], AppWords: [], HeldWords: held }, run };
  }

  private async personLeavesAPageComment(): Promise<void> {
    this.feedbacks += 1;
    const pageId = this.pageId();
    const commentId = `comment-${this.feedbacks}`;
    const text = `Comment ${this.feedbacks}: name the owner of each row.`;
    this.world.pageHost.addPersonComment({
      id: commentId,
      pageId,
      lineId: null,
      authorName: "Cy",
      text,
    });
    await this.world.deliver({
      kind: "feedback",
      text,
      bindings: [{ source: "documents_page", external_id: pageId }],
      page: { page_id: pageId, comment_id: commentId },
    });
  }

  private failingHost(method: "heldComments" | "acknowledgeComment"): () => void {
    const host = this.world.pageHost;
    const original = host[method];
    Object.assign(host, {
      [method]: async () => {
        throw new Error(`${method}: the host cannot be reached`);
      },
    });
    return () => {
      Object.assign(host, { [method]: original });
    };
  }

  private pageId(): string {
    const ref = this.world.artifactOf(this.author())?.ref;
    if (ref?.kind !== "page") throw new Error("the author has no page");
    return ref.page_id;
  }

  private shownBy(step: Step, prompts: string[], texts: FeedbackTexts): ShownView {
    const notes = step.notes;
    const [note] = notes;
    return {
      promptsAdded: step.after.authorPrompts - step.before.authorPrompts,
      prompted: wordsIn(prompts, texts),
      note: notes.length > 1 ? "SeveralNotes" : note ? noteKindOf(note.text) : "NoNote",
      wake: note ? wakeNameOf(note.wake) : "NoWake",
      heard: wordsIn(
        notes.map((told) => told.text),
        texts,
      ),
    };
  }
}

import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { fakeUserActor } from "../../../test/fake-actors";
import { linearInbound } from "./inbound";
import type { AgentSessionPayload, IssuePayload } from "./inbound-payloads";
import type { TrackerActorResolver, TrackerInbound, TrackerInboundContext } from "../types";

const WORKSPACE_ID = "org_acme";

const context: TrackerInboundContext = {
  workspaceId: WORKSPACE_ID,
  resolveActor: fakeUserActor(),
  deliveryId: "delivery-1",
};

const creator = { id: "u1", email: "dev@acme.test", name: "Dev" };

const APP_USER_ID = "app1";

const resolveEveryoneButTheApp: TrackerActorResolver = (user) =>
  user.id === APP_USER_ID ? Promise.resolve(null) : fakeUserActor()(user);

const WEBHOOK_ID = "w1";

function session(action: "created" | "prompted", body?: string): AgentSessionPayload {
  return {
    type: "AgentSessionEvent",
    action,
    organizationId: WORKSPACE_ID,
    webhookId: WEBHOOK_ID,
    agentSession: {
      id: "sess1",
      creator,
      issue: {
        id: "iss1",
        identifier: "ENG-1",
        title: "Fix login",
        description: "See https://github.com/acme/app",
        team: { id: "t1" },
      },
    },
    agentActivity: body === undefined ? null : { content: { type: "prompt", body } },
  };
}

function issueMoved(state: { id: string; name: string; type: string }): IssuePayload {
  return {
    type: "Issue",
    action: "update",
    organizationId: WORKSPACE_ID,
    webhookId: WEBHOOK_ID,
    data: { id: "iss1", state },
    updatedFrom: { stateId: "s1" },
    actor: creator,
  };
}

function expectEvent(normalized: TrackerInbound) {
  if ("ignore" in normalized) throw new Error(normalized.ignore);
  return normalized;
}

describe("linear event ids", () => {
  describe("a delivery that carries the header", () => {
    it("uses the header, which is unique per delivery", async () => {
      const { event } = expectEvent(await linearInbound(session("created"), context));
      expect(event.id).toBe("linear:delivery-1");
    });
  });

  describe("deliveries without the header", () => {
    const withoutHeader = { ...context, deliveryId: null };
    let first: InboundEvent;
    let second: InboundEvent;
    let repeat: InboundEvent;

    beforeEach(async () => {
      first = expectEvent(await linearInbound(session("prompted", "status?"), withoutHeader)).event;
      second = expectEvent(await linearInbound(session("prompted", "cancel"), withoutHeader)).event;
      repeat = expectEvent(
        await linearInbound(session("prompted", "status?"), withoutHeader),
      ).event;
    });

    it("combines the constant webhook id with a payload hash", () => {
      expect(first.id).toMatch(/^linear:w1:[0-9a-f]{16}$/);
    });

    it("gives two different payloads two different ids", () => {
      expect(first.id).not.toBe(second.id);
    });

    it("gives the same payload the same id twice", () => {
      expect(first.id).toBe(repeat.id);
    });
  });
});

describe("linear agent sessions", () => {
  describe("a session a person created", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(await linearInbound(session("created"), context)).event;
    });

    it("becomes a start", () => {
      expect(event.kind).toBe("start");
    });

    it("titles the work with the issue identifier", () => {
      expect(event.title).toBe("ENG-1 Fix login");
    });

    it("reads the links out of the issue description", () => {
      expect(event.links).toEqual(["https://github.com/acme/app"]);
    });

    it("binds to the session and to the issue", () => {
      expect(event.bindings).toEqual([
        { source: "tracker_session", external_id: "sess1" },
        { source: "tracker_issue", external_id: "iss1" },
      ]);
    });

    it("replies on the session", () => {
      expect(event.reply_to).toEqual({
        source: "tracker",
        session_id: "sess1",
        issue_id: "iss1",
        team_id: "t1",
      });
    });
  });

  describe.each(["created", "prompted"] as const)(
    "a session event a user who is not authorized %s",
    (action) => {
      it("is ignored", async () => {
        const normalized = await linearInbound(session(action, "approved, ship it"), {
          ...context,
          resolveActor: fakeUserActor({ authorized: false }),
        });
        expect(normalized).toEqual({ ignore: "session event from a user who is not authorized" });
      });
    },
  );

  describe("a session the agent's own delegation created", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      const payload = session("created");
      payload.agentSession.creator = null;
      event = expectEvent(await linearInbound(payload, context)).event;
    });

    it("becomes a start all the same", () => {
      expect(event.kind).toBe("start");
    });

    it("has no creator and so no actor", () => {
      expect(event.actor).toBeNull();
    });

    it("binds to the session and to the issue", () => {
      expect(event.bindings).toEqual([
        { source: "tracker_session", external_id: "sess1" },
        { source: "tracker_issue", external_id: "iss1" },
      ]);
    });
  });

  describe("a session whose creator Linear did not expand", () => {
    it("falls back to the creator id", async () => {
      const payload = session("created");
      payload.agentSession.creator = null;
      payload.agentSession.creatorId = "u9";
      const { event } = expectEvent(await linearInbound(payload, context));
      expect(event.actor?.person_id).toBe("p_u9");
    });
  });

  describe("a prompt on a session somebody else opened", () => {
    describe("with the prompt author expanded", () => {
      let event: InboundEvent;

      beforeEach(async () => {
        const payload = session("prompted", "ship it");
        payload.agentSession.creator = null;
        payload.agentActivity = {
          content: { type: "prompt", body: "ship it" },
          user: { id: "u2", email: "lead@acme.test", name: "Lead" },
        };
        event = expectEvent(await linearInbound(payload, context)).event;
      });

      it("becomes a prompt", () => {
        expect(event.kind).toBe("prompt");
      });

      it("is from the prompt author, not from the session opener", () => {
        expect(event.actor).toEqual({
          person_id: "p_u2",
          email: "lead@acme.test",
          display_name: "Lead",
        });
      });
    });

    describe("with the prompt author named by id", () => {
      it("is from that id", async () => {
        const payload = session("prompted", "status?");
        payload.agentSession.creator = null;
        payload.agentActivity = { content: { type: "prompt", body: "status?" }, userId: "u3" };
        const { event } = expectEvent(await linearInbound(payload, context));
        expect(event.actor?.person_id).toBe("p_u3");
      });
    });

    describe("with the prompt written as a comment", () => {
      it("is from the comment author", async () => {
        const payload = session("prompted", "hi");
        payload.agentSession.creator = null;
        payload.agentActivity = {
          content: { type: "prompt", body: "hi" },
          sourceComment: { id: "c9", userId: "u4" },
        };
        const { event } = expectEvent(await linearInbound(payload, context));
        expect(event.actor?.person_id).toBe("p_u4");
      });
    });
  });

  describe("a prompt that asks for the status", () => {
    it("becomes a status", async () => {
      const { event } = expectEvent(await linearInbound(session("prompted", "status?"), context));
      expect(event.kind).toBe("status");
    });
  });

  describe("a prompt that asks for work", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(await linearInbound(session("prompted", "cancel"), context)).event;
    });

    it("becomes a prompt", () => {
      expect(event.kind).toBe("prompt");
    });

    it("carries the prompt text", () => {
      expect(event.text).toBe("cancel");
    });
  });
});

describe("linear comments", () => {
  describe("a comment on an issue", () => {
    it("is ignored, since sessions carry prompts", async () => {
      const normalized = await linearInbound(
        {
          type: "Comment",
          action: "create",
          organizationId: WORKSPACE_ID,
          data: { id: "c2", body: "looks fine", issueId: "iss1" },
        },
        context,
      );
      expect("ignore" in normalized).toBe(true);
    });
  });

  describe("a comment inside a document", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await linearInbound(
          {
            type: "Comment",
            action: "create",
            organizationId: WORKSPACE_ID,
            webhookId: WEBHOOK_ID,
            data: { id: "c3", body: "approved", documentContentId: "content1", user: creator },
          },
          context,
        ),
      ).event;
    });

    it("uses the delivery header as the id", () => {
      expect(event.id).toBe("linear:delivery-1");
    });

    it("becomes feedback on the page", () => {
      expect(event.kind).toBe("feedback");
    });

    it("names the page and the comment a reply goes under", () => {
      expect(event.page).toEqual({ page_id: "content1", comment_id: "c3" });
    });

    it("carries the comment body", () => {
      expect(event.text).toBe("approved");
    });

    it("binds to the document that holds the comment", () => {
      expect(event.bindings).toEqual([{ source: "documents_page", external_id: "content1" }]);
    });

    it("names the comment author as the actor", () => {
      expect(event.actor?.person_id).toBe("p_u1");
    });
  });

  describe("a comment inside a document that the app itself wrote", () => {
    it("is ignored, so the agent never answers its own writing", async () => {
      const normalized = await linearInbound(
        {
          type: "Comment",
          action: "create",
          organizationId: WORKSPACE_ID,
          data: {
            id: "c5",
            body: "Review: approved",
            documentContentId: "content1",
            userId: APP_USER_ID,
          },
        },
        { ...context, resolveActor: resolveEveryoneButTheApp },
      );
      expect(normalized).toEqual({ ignore: "comment no person wrote" });
    });
  });

  describe("a comment inside a document that an integration wrote", () => {
    it("is ignored, since no person signed it", async () => {
      const normalized = await linearInbound(
        {
          type: "Comment",
          action: "create",
          organizationId: WORKSPACE_ID,
          data: { id: "c6", body: "build failed", documentContentId: "content1" },
        },
        context,
      );
      expect(normalized).toEqual({ ignore: "comment no person wrote" });
    });
  });

  describe("a comment a person edited", () => {
    it("is ignored by name, since only a new comment is a reply", async () => {
      const normalized = await linearInbound(
        {
          type: "Comment",
          action: "update",
          organizationId: WORKSPACE_ID,
          data: { id: "c3", body: "approved, with one change", documentContentId: "content1" },
        },
        context,
      );
      expect(normalized).toEqual({ ignore: "Comment/update" });
    });
  });

  describe("a comment on neither an issue nor a document", () => {
    it("is ignored with the reason", async () => {
      const normalized = await linearInbound(
        {
          type: "Comment",
          action: "create",
          organizationId: WORKSPACE_ID,
          data: { id: "c4", body: "approved" },
        },
        context,
      );
      expect(normalized).toEqual({ ignore: "comment outside a document. sessions carry prompts." });
    });
  });
});

function describeEndState(state: { id: string; name: string; type: string }) {
  describe(`an issue moved into ${state.name}`, () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await linearInbound(issueMoved(state), {
          ...context,
          deliveryId: null,
        }),
      ).event;
    });

    it("gets an id from the webhook id and a payload hash", () => {
      expect(event.id).toMatch(/^linear:w1:[0-9a-f]{16}$/);
    });

    it("becomes a control event", () => {
      expect(event.kind).toBe("control");
    });

    it("cancels the work", () => {
      expect(event.control).toBe("cancel");
    });

    it("names the state in the text", () => {
      expect(event.text).toBe(`Issue moved to ${state.name}`);
    });

    it("binds to the issue", () => {
      expect(event.bindings).toEqual([{ source: "tracker_issue", external_id: "iss1" }]);
    });

    it("names whoever moved the issue as the actor", () => {
      expect(event.actor?.person_id).toBe("p_u1");
    });
  });
}

describe("linear issues", () => {
  describeEndState({ id: "s4", name: "Canceled", type: "canceled" });
  describeEndState({ id: "s5", name: "Done", type: "completed" });

  describe("an issue the app itself moved to Done", () => {
    it("is ignored, since the agent closing its own issue is not a cancel", async () => {
      const payload = issueMoved({ id: "s5", name: "Done", type: "completed" });
      payload.actor = { id: APP_USER_ID, name: "Agent" };
      const normalized = await linearInbound(payload, {
        ...context,
        resolveActor: resolveEveryoneButTheApp,
      });
      expect(normalized).toEqual({ ignore: "state Done from no person" });
    });
  });

  describe("an issue moved with no actor on the payload", () => {
    it("is ignored, since nobody asked for the work to stop", async () => {
      const payload = issueMoved({ id: "s4", name: "Canceled", type: "canceled" });
      payload.actor = null;
      const normalized = await linearInbound(payload, context);
      expect(normalized).toEqual({ ignore: "state Canceled from no person" });
    });
  });

  describe("an issue moved into a state that is not an end", () => {
    it("is ignored by state name, Approved included", async () => {
      const normalized = await linearInbound(
        issueMoved({ id: "s2", name: "Approved", type: "started" }),
        { ...context, deliveryId: null },
      );
      expect(normalized).toEqual({ ignore: "state Approved" });
    });

    it("is ignored for any other started state", async () => {
      const normalized = await linearInbound(
        issueMoved({ id: "s3", name: "In Review", type: "started" }),
        context,
      );
      expect("ignore" in normalized).toBe(true);
    });
  });
});

describe("linear payloads nobody handles", () => {
  it("ignores an unknown payload by name", async () => {
    const normalized = await linearInbound(
      { type: "Project", action: "remove", organizationId: WORKSPACE_ID },
      context,
    );
    expect(normalized).toEqual({ ignore: "Project/remove" });
  });
});

describe("linear webhooks of a workspace the deployment is not installed in", () => {
  it("ignores a webhook of another workspace", async () => {
    const payload = { ...session("created"), organizationId: "org_other" };
    expect(await linearInbound(payload, context)).toEqual({ ignore: "another workspace" });
  });

  it("ignores a webhook that names no workspace", async () => {
    const payload = { ...session("created"), organizationId: undefined };
    expect(await linearInbound(payload, context)).toEqual({ ignore: "another workspace" });
  });

  it("ignores every webhook before the install", async () => {
    const normalized = await linearInbound(session("created"), { ...context, workspaceId: null });
    expect(normalized).toEqual({ ignore: "another workspace" });
  });
});

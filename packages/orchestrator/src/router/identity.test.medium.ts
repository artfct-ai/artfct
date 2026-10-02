import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { Actor } from "@artfct-ai/contracts/inbound";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { upsertPerson, type PersonRecord } from "../db/persons";
import { persons } from "../db/schema";
import { Identity, resolveActor, resolveCodeActor } from "./identity";

const db = createDb(env.DB);

function team(members: string[]) {
  return { id: "team-1", members };
}

const bounded = { tracker_team: "team-1" };
const chatBounded = { chat_team: "T1" };
const open = {};

type PersonKey = "slack_user_id" | "linear_user_id" | "github_login" | "email";

async function personBy(column: PersonKey, value: string) {
  return (await db.select().from(persons).where(eq(persons[column], value)).get()) ?? null;
}

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("resolveCodeActor", () => {
  let actor: Actor | null;

  describe("a login that may push, recorded by nobody yet", () => {
    const octocat = { login: "octocat", repo: "acme/app", app: false };
    let code: FakeCodeHost;

    beforeEach(async () => {
      code = new FakeCodeHost({ pushers: ["octocat"] });
      actor = await resolveCodeActor(db, code, octocat);
    });

    it("returns the login as the actor", () => {
      expect(actor?.display_name).toBe("octocat");
    });

    it("asks the code host about that login on that repository", () => {
      expect(code.argsOf("canPush")).toEqual([["acme/app", "octocat"]]);
    });

    it("records the login, so the next event resolves to the same person", async () => {
      const again = await resolveCodeActor(db, code, octocat);
      expect(again?.person_id).toBe(actor?.person_id);
    });
  });

  describe("a login a known person carries", () => {
    let person: PersonRecord;

    beforeEach(async () => {
      person = await upsertPerson(db, {
        github_login: "ann",
        email: "ann@acme.test",
        display_name: "Ann",
      });
      actor = await resolveCodeActor(db, new FakeCodeHost(), {
        login: "ann",
        repo: "acme/app",
        app: false,
      });
    });

    it("returns that person", () => {
      expect(actor?.person_id).toBe(person.person_id);
    });

    it("carries their email", () => {
      expect(actor?.email).toBe("ann@acme.test");
    });
  });

  describe("a login that may not push", () => {
    const mallory = { login: "mallory", repo: "acme/app", app: false };

    beforeEach(async () => {
      actor = await resolveCodeActor(db, new FakeCodeHost({ pushers: [] }), mallory);
    });

    it("is unauthorized", () => {
      expect(actor).toBeNull();
    });

    it("records no person", async () => {
      expect(await personBy("github_login", "mallory")).toBeNull();
    });
  });

  describe("a login that lost its push access", () => {
    it("is unauthorized on the next event", async () => {
      const sam = { login: "sam", repo: "acme/app", app: false };
      await resolveCodeActor(db, new FakeCodeHost({ pushers: ["sam"] }), sam);
      expect(await resolveCodeActor(db, new FakeCodeHost({ pushers: [] }), sam)).toBeNull();
    });
  });

  describe("an App", () => {
    let code: FakeCodeHost;

    beforeEach(async () => {
      code = new FakeCodeHost({ pushers: [] });
      actor = await resolveCodeActor(db, code, {
        login: "coderabbitai[bot]",
        repo: "acme/app",
        app: true,
      });
    });

    it("is authorized, since the repository installed it", () => {
      expect(actor?.display_name).toBe("coderabbitai[bot]");
    });

    it("is not looked up", () => {
      expect(code.calls).toEqual([]);
    });
  });

  describe("a code host that cannot answer", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      actor = await resolveCodeActor(db, new FakeCodeHost({ failing: true }), {
        login: "sam",
        repo: "acme/app",
        app: false,
      });
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("leaves the person unauthorized", () => {
      expect(actor).toBeNull();
    });
  });

  describe("a deployment with no code host connected", () => {
    it("lets no person in", async () => {
      expect(
        await resolveCodeActor(db, null, { login: "sam", repo: "acme/app", app: false }),
      ).toBeNull();
    });
  });
});

describe("resolveActor for a code host user", () => {
  it("dispatches to the code host identity", async () => {
    const actor = await resolveActor(
      env,
      db,
      { source: "code", user: { login: "sam", repo: "acme/app", app: false } },
      { code: new FakeCodeHost() },
    );
    expect(actor?.display_name).toBe("sam");
  });
});
describe("Identity.fromTracker", () => {
  const user = { id: "L1", email: "Lee@acme.test", name: "Lee" };
  let actor: Actor | null;

  describe("a member of the tracker team", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker({ team: team(["L1"]) });
      actor = await new Identity(bounded, db, tracker).fromTracker(user);
    });

    it("returns the actor", () => {
      expect(actor?.display_name).toBe("Lee");
    });

    it("asks Linear whether they are in the team", () => {
      expect(tracker.calls).toEqual([{ method: "teamMembership", args: ["team-1", "L1"] }]);
    });

    it("asks again on their next event, so leaving the team takes effect at once", async () => {
      await new Identity(bounded, db, tracker).fromTracker(user);
      expect(tracker.argsOf("teamMembership")).toHaveLength(2);
    });
  });

  describe("a member who has left the tracker team", () => {
    it("is rejected on their next event", async () => {
      await new Identity(bounded, db, new FakeTracker({ team: team(["L1"]) })).fromTracker(user);
      expect(await new Identity(bounded, db, new FakeTracker()).fromTracker(user)).toBeNull();
    });
  });

  describe("a user outside the tracker team", () => {
    beforeEach(async () => {
      actor = await new Identity(bounded, db, new FakeTracker()).fromTracker(user);
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });
  });

  describe("a tracker team and no client to ask", () => {
    it("rejects them", async () => {
      expect(await new Identity(bounded, db, null).fromTracker(user)).toBeNull();
    });
  });

  describe("a user the event names, without a tracker team", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(chatBounded, db, tracker).fromTracker(user);
    });

    it("returns the actor with the email in lower case", () => {
      expect(actor).toMatchObject({ email: "lee@acme.test", display_name: "Lee" });
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });

    it("records the user under their Linear id", async () => {
      expect(await personBy("linear_user_id", "L1")).toMatchObject({ display_name: "Lee" });
    });
  });

  describe("a user with no email, without a client and without a boundary", () => {
    beforeEach(async () => {
      actor = await new Identity(open, db, null).fromTracker({ id: "L3" });
    });

    it("still answers an actor", () => {
      expect(actor?.person_id).toBeTruthy();
    });

    it("leaves the email empty", () => {
      expect(actor?.email).toBeNull();
    });
  });

  describe("the installed app's own user", () => {
    let tracker: FakeTracker;

    beforeEach(async () => {
      tracker = new FakeTracker({ appUserId: "app1" });
      actor = await new Identity(bounded, db, tracker).fromTracker({ id: "app1", name: "Agent" });
    });

    it("resolves to nobody, since the app is not a person", () => {
      expect(actor).toBeNull();
    });

    it("records no person for it", async () => {
      expect(await personBy("linear_user_id", "app1")).toBeNull();
    });
  });
});

describe("Identity.fromChat", () => {
  const user = { id: "U1", email: "sam@acme.test", name: "Sam", member_of_team: "T1" };
  let tracker: FakeTracker;
  let actor: Actor | null;

  describe("a full member of the chat team", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(chatBounded, db, tracker).fromChat(user);
    });

    it("accepts them", () => {
      expect(actor?.display_name).toBe("Sam");
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("a full member of another chat team", () => {
    it("rejects them", async () => {
      const visitor = { ...user, member_of_team: "T2" };
      expect(await new Identity(chatBounded, db, null).fromChat(visitor)).toBeNull();
    });
  });

  describe("a guest of the chat team", () => {
    it("rejects them", async () => {
      const guest = { ...user, member_of_team: null };
      expect(await new Identity(chatBounded, db, null).fromChat(guest)).toBeNull();
    });
  });

  describe("a chat team and a tracker team together", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      const both = { ...bounded, ...chatBounded };
      actor = await new Identity(both, db, tracker).fromChat(user);
    });

    it("accepts a full member of the chat team", () => {
      expect(actor).not.toBeNull();
    });

    it("asks Linear nothing", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("without a team boundary", () => {
    beforeEach(async () => {
      actor = await new Identity(open, db, null).fromChat(user);
    });

    it("accepts everyone", () => {
      expect(actor?.display_name).toBe("Sam");
    });

    it("records the Slack id with the email", async () => {
      expect(await personBy("slack_user_id", "U1")).toMatchObject({ email: "sam@acme.test" });
    });
  });

  describe("a user whose email was stored on an earlier event", () => {
    beforeEach(async () => {
      await upsertPerson(db, { slack_user_id: "U1", email: "sam@acme.test" });
      tracker = new FakeTracker({
        team: team(["L1"]),
        usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam L" } },
      });
      actor = await new Identity(bounded, db, tracker).fromChat({ id: "U1", member_of_team: null });
    });

    it("joins them by the stored email", () => {
      expect(actor?.display_name).toBe("Sam L");
    });

    it("asks Linear again, so leaving the team takes effect at once", () => {
      expect(tracker.argsOf("teamMembership")).toEqual([["team-1", "L1"]]);
    });
  });

  describe("an unknown user without an email", () => {
    beforeEach(async () => {
      tracker = new FakeTracker();
      actor = await new Identity(bounded, db, tracker).fromChat({ id: "U2", member_of_team: null });
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });

    it("asks Linear nothing, since there is no email to ask about", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("an email that belongs to a Linear user in the team", () => {
    beforeEach(async () => {
      tracker = new FakeTracker({
        team: team(["L1"]),
        usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam L" } },
      });
      actor = await new Identity(bounded, db, tracker).fromChat(user);
    });

    it("returns the Linear user under their Linear name", () => {
      expect(actor).toMatchObject({ email: "sam@acme.test", display_name: "Sam L" });
    });

    it("looks the email up and then the team membership", () => {
      expect(tracker.calls).toEqual([
        { method: "userByEmail", args: ["sam@acme.test"] },
        { method: "teamMembership", args: ["team-1", "L1"] },
      ]);
    });

    it("joins the Slack user to the Linear user", async () => {
      expect(await personBy("slack_user_id", "U1")).toMatchObject({ linear_user_id: "L1" });
    });
  });

  describe("an email that belongs to a Linear user outside the team", () => {
    beforeEach(async () => {
      tracker = new FakeTracker({ usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam" } } });
      actor = await new Identity(bounded, db, tracker).fromChat(user);
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });

    it("does not join the Slack user to the Linear user", async () => {
      expect(await personBy("slack_user_id", "U1")).toMatchObject({ linear_user_id: null });
    });
  });

  describe("when the Linear lookup fails", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      actor = await new Identity(bounded, db, new FakeTracker({ failing: true })).fromChat(user);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("rejects them", () => {
      expect(actor).toBeNull();
    });

    it("warns that the user lookup failed", () => {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/user lookup failed/));
    });
  });

  describe("an email Linear does not know", () => {
    const unknown = { id: "U3", email: "nobody@acme.test", member_of_team: null };

    beforeEach(() => {
      tracker = new FakeTracker({
        usersByEmail: { "sam@acme.test": { id: "L1", name: "Sam" } },
      });
    });

    it("rejects them", async () => {
      expect(await new Identity(bounded, db, tracker).fromChat(unknown)).toBeNull();
    });

    it("rejects them without a client too", async () => {
      expect(await new Identity(bounded, db, null).fromChat(unknown)).toBeNull();
    });
  });
});

describe("Identity.fromDocs", () => {
  let tracker: FakeTracker;

  describe("a person the page names without an email", () => {
    it("rejects them", async () => {
      expect(await new Identity(open, db, null).fromDocs({ id: "N1" })).toBeNull();
    });
  });

  describe("a Linear user for the email, without a tracker team", () => {
    let actor: Actor | null;

    beforeEach(async () => {
      tracker = new FakeTracker({ usersByEmail: { "new@acme.test": { id: "L5", name: "New" } } });
      actor = await new Identity(open, db, tracker).fromDocs({ id: "N2", email: "new@acme.test" });
    });

    it("returns them", () => {
      expect(actor?.display_name).toBe("New");
    });

    it("asks Linear for the user alone", () => {
      expect(tracker.calls).toEqual([{ method: "userByEmail", args: ["new@acme.test"] }]);
    });
  });

  describe("a team boundary and a Linear user for a new email", () => {
    beforeEach(() => {
      tracker = new FakeTracker({
        team: team(["L5"]),
        usersByEmail: { "new@acme.test": { id: "L5", name: "New" } },
      });
    });

    describe("an email Linear does not know", () => {
      let actor: Actor | null;

      beforeEach(async () => {
        actor = await new Identity(bounded, db, tracker).fromDocs({
          id: "N1",
          email: "kim@acme.test",
        });
      });

      it("is rejected", () => {
        expect(actor).toBeNull();
      });

      it("records no person", async () => {
        expect(await personBy("email", "kim@acme.test")).toBeNull();
      });
    });

    describe("an email nobody stored yet", () => {
      let actor: Actor | null;

      beforeEach(async () => {
        actor = await new Identity(bounded, db, tracker).fromDocs({
          id: "N2",
          email: "new@acme.test",
          name: "N",
        });
      });

      it("returns the Linear name, not the one the page carries", () => {
        expect(actor?.display_name).toBe("New");
      });

      it("joins the person to the Linear user", async () => {
        expect(await personBy("email", "new@acme.test")).toMatchObject({ linear_user_id: "L5" });
      });
    });
  });
});

describe("resolveActor with a given client", () => {
  let tracker: FakeTracker;

  beforeEach(() => {
    tracker = new FakeTracker({ team: team(["L7"]) });
  });

  describe("a Linear user", () => {
    let actor: Actor | null;

    beforeEach(async () => {
      actor = await resolveActor(
        env,
        db,
        { source: "tracker", user: { id: "L7", name: "Seven" } },
        { tracker },
      );
    });

    it("dispatches to the Linear identity", () => {
      expect(actor?.display_name).toBe("Seven");
    });

    it("asks Linear nothing, since the event names the user", () => {
      expect(tracker.calls).toEqual([]);
    });
  });

  describe("a Notion user without an email", () => {
    it("answers null", async () => {
      expect(
        await resolveActor(env, db, { source: "docs", user: { id: "N9" } }, { tracker }),
      ).toBeNull();
    });
  });
});

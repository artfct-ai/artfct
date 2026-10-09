import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeLinear, PAGE, type Call } from "../../../test/linear-graphql";
import { LinearTracker } from "./tracker";
import type { AppUser, TeamMembership, TrackerIssue, TrackerUser, WorkflowState } from "../types";

afterEach(() => mock.restore());

const VIEWER = { viewer: { id: "app1", name: "Agent" } };
const ORGANIZATION = { organization: { id: "org1", name: "Acme", projectStatuses: [] } };

describe("LinearTracker credentials", () => {
  describe("a personal API key", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({ viewer: VIEWER, organization: ORGANIZATION });
      await new LinearTracker("lin_api_x").appUser();
    });

    it("goes to the default endpoint", () => {
      expect(calls[0]?.url).toBe("https://api.linear.app/graphql");
    });

    it("is sent bare", () => {
      expect(calls[0]?.authorization).toBe("lin_api_x");
    });
  });

  describe("an OAuth token with a base URL override", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({ viewer: VIEWER, organization: ORGANIZATION });
      await new LinearTracker("lin_oauth_t", { baseUrl: "https://linear.test" }).appUser();
    });

    it("goes to the override endpoint", () => {
      expect(calls[0]?.url).toBe("https://linear.test/graphql");
    });

    it("is sent as a bearer", () => {
      expect(calls[0]?.authorization).toBe("Bearer lin_oauth_t");
    });
  });

  describe("a token source that refreshes on the third call", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({ users: { users: { nodes: [], pageInfo: PAGE } } });
      const tokens = ["lin_oauth_1", "lin_oauth_1", "lin_oauth_2"];
      const tracker = new LinearTracker(async () => tokens.shift() ?? "none");
      await tracker.userByEmail("a@x.y");
      await tracker.userByEmail("a@x.y");
      await tracker.userByEmail("a@x.y");
    });

    it("asks the source on every call and follows the new token", () => {
      expect(calls.map((call) => call.authorization)).toEqual([
        "Bearer lin_oauth_1",
        "Bearer lin_oauth_1",
        "Bearer lin_oauth_2",
      ]);
    });
  });

  describe("a token source that throws", () => {
    it("surfaces the failure as the call's error", async () => {
      fakeLinear({});
      const tracker = new LinearTracker(async () => {
        throw new Error("not installed");
      });
      await expect(tracker.userByEmail("a@x.y")).rejects.toThrow("not installed");
    });
  });

  describe("the app user id", () => {
    it("is null without the option", () => {
      expect(new LinearTracker("lin_api_x").appUserId).toBeNull();
    });

    it("carries the id the tracker was built with", () => {
      expect(new LinearTracker("lin_api_x", { appUserId: "app1" }).appUserId).toBe("app1");
    });
  });
});

describe("LinearTracker reads", () => {
  describe("appUser", () => {
    let calls: Call[];
    let appUser: AppUser;

    beforeEach(async () => {
      calls = fakeLinear({ viewer: VIEWER, organization: ORGANIZATION });
      appUser = await new LinearTracker("lin_api_x").appUser();
    });

    it("reads the viewer and then its organization", () => {
      expect(calls.map((call) => call.operation)).toEqual(["viewer", "organization"]);
    });

    it("maps the viewer with its organization", () => {
      expect(appUser).toEqual({
        id: "app1",
        name: "Agent",
        organization: { id: "org1", name: "Acme" },
      });
    });
  });

  describe("teamMembership of a team named by key", () => {
    let calls: Call[];
    let membership: TeamMembership;

    beforeEach(async () => {
      calls = fakeLinear({
        team: { team: { id: "t1", key: "ENG", name: "Eng" } },
        team_members: { team: { members: { nodes: [{ id: "u1", name: "U" }], pageInfo: PAGE } } },
      });
      membership = await new LinearTracker("lin_api_x").teamMembership("ENG", "u1");
    });

    it("resolves the team and then filters its members by id", () => {
      expect(calls.map((call) => call.variables)).toEqual([
        { id: "ENG" },
        { id: "t1", filter: { id: { eq: "u1" } } },
      ]);
    });

    it("answers the resolved team id and a member", () => {
      expect(membership).toEqual({ team_id: "t1", member: true });
    });
  });

  it("teamMembership is false when the filtered members are empty", async () => {
    fakeLinear({
      team: { team: { id: "t1" } },
      team_members: { team: { members: { nodes: [], pageInfo: PAGE } } },
    });
    expect(await new LinearTracker("lin_api_x").teamMembership("t1", "u2")).toEqual({
      team_id: "t1",
      member: false,
    });
  });

  describe("userByEmail with one match", () => {
    let calls: Call[];
    let user: TrackerUser | null;

    beforeEach(async () => {
      calls = fakeLinear({
        users: { users: { nodes: [{ id: "u1", name: "Ann", email: "ann@x.y" }], pageInfo: PAGE } },
      });
      user = await new LinearTracker("lin_api_x").userByEmail("ann@x.y");
    });

    it("filters the users by email", () => {
      expect(calls[0]?.variables).toEqual({ filter: { email: { eq: "ann@x.y" } } });
    });

    it("maps the first match", () => {
      expect(user).toEqual({ id: "u1", name: "Ann" });
    });
  });

  it("userByEmail is null without a match", async () => {
    fakeLinear({ users: { users: { nodes: [], pageInfo: PAGE } } });
    expect(await new LinearTracker("lin_api_x").userByEmail("nobody@x.y")).toBeNull();
  });

  describe("teamStates", () => {
    let calls: Call[];
    let states: WorkflowState[];

    beforeEach(async () => {
      calls = fakeLinear({
        team: { team: { id: "t1" } },
        team_states: {
          team: {
            states: {
              nodes: [
                { id: "b", name: "Done", type: "completed", position: 2 },
                { id: "a", name: "Todo", type: "unstarted", position: 0 },
              ],
              pageInfo: PAGE,
            },
          },
        },
      });
      states = await new LinearTracker("lin_api_x").teamStates("t1");
    });

    it("resolves the team and then reads its states", () => {
      expect(calls.map((call) => call.operation)).toEqual(["team", "team_states"]);
    });

    it("orders the states by position", () => {
      expect(states.map((state) => state.id)).toEqual(["a", "b"]);
    });

    it("maps the id, name, type, and position", () => {
      expect(states[0]).toEqual({ id: "a", name: "Todo", type: "unstarted", position: 0 });
    });
  });
});

const ISSUE_NODE = {
  id: "i1",
  identifier: "ENG-1",
  title: "One",
  url: "https://l/ENG-1",
  state: { type: "unstarted", name: "Todo" },
  team: { id: "t1" },
  labels: { nodes: [{ name: "harness: opencode" }, { name: "bug" }] },
  inverseRelations: {
    nodes: [
      { type: "blocks", issue: { id: "i0", identifier: "ENG-0", state: { type: "started" } } },
      { type: "related", issue: { id: "i9", identifier: "ENG-9", state: { type: "started" } } },
    ],
  },
};

const MAPPED_ISSUE: TrackerIssue = {
  id: "i1",
  identifier: "ENG-1",
  title: "One",
  url: "https://l/ENG-1",
  state: { type: "unstarted", name: "Todo" },
  team_id: "t1",
  labels: ["harness: opencode", "bug"],
  blockers: [{ id: "i0", identifier: "ENG-0", state: { type: "started" } }],
};

describe("LinearTracker raw issue reads", () => {
  describe("an issue with labels and inverse relations", () => {
    let calls: Call[];
    let issue: TrackerIssue | null;

    beforeEach(async () => {
      calls = fakeLinear({ Issue: { issue: ISSUE_NODE } });
      issue = await new LinearTracker("lin_api_x").issue("ENG-1");
    });

    it("asks for the identifier it was given", () => {
      expect(calls[0]?.variables).toEqual({ id: "ENG-1" });
    });

    it("selects the labels and the inverse relations", () => {
      expect(calls[0]?.query).toContain("labels { nodes { name } }");
      expect(calls[0]?.query).toContain("inverseRelations { nodes { type issue { id identifier");
    });

    it("keeps only the relations that block", () => {
      expect(issue).toEqual(MAPPED_ISSUE);
    });
  });

  it("issue is null when Linear has none", async () => {
    fakeLinear({ Issue: { issue: null } });
    expect(await new LinearTracker("lin_api_x").issue("ENG-404")).toBeNull();
  });

  it("issue reads a team_id of null when the issue has no team", async () => {
    fakeLinear({ Issue: { issue: { ...ISSUE_NODE, team: null } } });
    expect((await new LinearTracker("lin_api_x").issue("ENG-1"))?.team_id).toBeNull();
  });

  describe("a project whose issues span two pages", () => {
    let calls: Call[];
    let issues: TrackerIssue[];

    beforeEach(async () => {
      const second = { ...ISSUE_NODE, id: "i2", identifier: "ENG-2" };
      calls = fakeLinear({
        ProjectIssues: (call: Call) =>
          call.variables.after === null
            ? {
                project: {
                  issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: true, endCursor: "c1" } },
                },
              }
            : {
                project: {
                  issues: { nodes: [second], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
      });
      issues = await new LinearTracker("lin_api_x").projectIssues("p1");
    });

    it("asks for fifty issues after the cursor", () => {
      expect(calls[0]?.query).toContain("issues(first: 50, after: $after)");
    });

    it("follows the cursor across the pages", () => {
      expect(calls.map((call) => call.variables)).toEqual([
        { id: "p1", after: null },
        { id: "p1", after: "c1" },
      ]);
    });

    it("returns the issues of both pages", () => {
      expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
    });
  });

  it("projectIssues is empty for an unknown project", async () => {
    fakeLinear({ ProjectIssues: { project: null } });
    expect(await new LinearTracker("lin_api_x").projectIssues("p404")).toEqual([]);
  });
});

describe("LinearTracker writes", () => {
  describe("updateIssue", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({ updateIssue: { issueUpdate: { success: true, lastSyncId: 1 } } });
      await new LinearTracker("lin_api_x").updateIssue("i1", { stateId: "s1", delegateId: "u1" });
    });

    it("sends the id and the input in one mutation", () => {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.variables).toEqual({ id: "i1", input: { stateId: "s1", delegateId: "u1" } });
    });
  });

  describe("syncChatThread", () => {
    const threadUrl = "https://slack.test/archives/C1/p17";
    const linked = { success: true, lastSyncId: 1, attachment: { id: "a1" } };

    describe("on a thread that syncs nowhere yet", () => {
      let calls: Call[];

      beforeEach(async () => {
        calls = fakeLinear({ attachmentLinkSlack: { attachmentLinkSlack: linked } });
        await new LinearTracker("lin_api_x").syncChatThread("i1", threadUrl);
      });

      it("syncs the thread into the issue comments in one mutation", () => {
        expect(calls.map((call) => call.operation)).toEqual(["attachmentLinkSlack"]);
        expect(calls[0]?.variables).toEqual({
          issueId: "i1",
          url: threadUrl,
          syncToCommentThread: true,
        });
      });
    });

    describe("on a thread that already syncs into another issue", () => {
      let calls: Call[];

      beforeEach(async () => {
        calls = fakeLinear({
          attachmentLinkSlack: {
            errors: [{ message: "Message already synced", extensions: { code: "INPUT_ERROR" } }],
          },
          attachmentLinkURL: { attachmentLinkURL: linked },
        });
        await new LinearTracker("lin_api_x").syncChatThread("i2", threadUrl);
      });

      it("links the thread to the issue instead", () => {
        expect(calls.map((call) => call.operation)).toEqual([
          "attachmentLinkSlack",
          "attachmentLinkURL",
        ]);
        expect(calls[1]?.variables).toEqual({ issueId: "i2", url: threadUrl });
      });
    });

    it("throws any other refusal without linking", async () => {
      const calls = fakeLinear({
        attachmentLinkSlack: { errors: [{ message: "Entity not found: Issue" }] },
        attachmentLinkURL: { attachmentLinkURL: linked },
      });
      await expect(
        new LinearTracker("lin_api_x").syncChatThread("i3", threadUrl),
      ).rejects.toThrow();
      expect(calls.map((call) => call.operation)).toEqual(["attachmentLinkSlack"]);
    });
  });

  describe("an activity posted without options", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({
        createAgentActivity: { agentActivityCreate: { success: true, lastSyncId: 1 } },
      });
      await new LinearTracker("lin_api_x").activity("sess", { type: "thought", body: "hi" });
    });

    it("posts the content in one call", () => {
      expect(calls).toHaveLength(1);
    });

    it("sends ephemeral false by default", () => {
      expect(calls[0]?.variables).toEqual({
        input: {
          agentSessionId: "sess",
          content: { type: "thought", body: "hi" },
          ephemeral: false,
        },
      });
    });
  });

  describe("an activity posted with external urls", () => {
    let calls: Call[];

    beforeEach(async () => {
      calls = fakeLinear({
        createAgentActivity: { agentActivityCreate: { success: true, lastSyncId: 1 } },
        updateAgentSession: { agentSessionUpdate: { success: true, lastSyncId: 1 } },
      });
      await new LinearTracker("lin_api_x").activity(
        "sess",
        { type: "response", body: "done" },
        { ephemeral: true, externalUrls: [{ url: "https://x.y", label: "PR" }] },
      );
    });

    it("posts the activity and then updates the session", () => {
      expect(calls.map((call) => call.operation)).toEqual([
        "createAgentActivity",
        "updateAgentSession",
      ]);
    });

    it("carries the ephemeral option", () => {
      expect(calls[0]?.variables).toMatchObject({ input: { ephemeral: true } });
    });

    it("adds the urls in the second call", () => {
      expect(calls[1]?.variables).toEqual({
        id: "sess",
        input: { addedExternalUrls: [{ url: "https://x.y", label: "PR" }] },
      });
    });
  });
});

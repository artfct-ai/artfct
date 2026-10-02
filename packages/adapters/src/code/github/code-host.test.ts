import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "bun:test";
import { fetchBody, fetchHeader, fetchUrl } from "../../../test/fetch";
import { GithubCodeHost, type GithubAppAuth } from "./code-host";
import type {
  CheckRun,
  CommitAuthor,
  CommitChecks,
  MintedToken,
  PullRequest,
  PullRequestReview,
  PullRequestReviewComment,
} from "../types";

const BASE_URL = "https://gh.test";
const EXPIRES_AT = "2026-01-01T01:00:00.000Z";

const KEY_PAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = KEY_PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();
const PKCS8_PEM = KEY_PAIR.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PKCS1_PEM = KEY_PAIR.privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const APP_AUTH: GithubAppAuth = { appId: "1234", privateKeyPem: PKCS8_PEM, installationId: "77" };
const MINT_PATH = "/app/installations/77/access_tokens";

type Recorded = {
  method: string;
  url: URL;
  body: string;
  authorization: string | null;
  userAgent: string | null;
  signal: AbortSignal | null;
};

type Routes = Record<string, (request: Recorded) => Response>;

type FakeClient = { host: GithubCodeHost; requests: Recorded[]; mints: Recorded[] };

function json(value: unknown): (request: Recorded) => Response {
  return () => Response.json(value);
}

function fakeGithub(routes: Routes) {
  const requests: Recorded[] = [];
  const mints: Recorded[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(fetchUrl(input));
    const request: Recorded = {
      method: init?.method ?? "GET",
      url,
      body: fetchBody(init),
      authorization: fetchHeader(init, "authorization"),
      userAgent: fetchHeader(init, "user-agent"),
      signal: init?.signal ?? null,
    };
    if (url.pathname === MINT_PATH) {
      mints.push(request);
      return Response.json({ token: "ghs_1", expires_at: EXPIRES_AT }, { status: 201 });
    }
    requests.push(request);
    const route = routes[`${request.method} ${url.pathname}`];
    if (route) return Object.defineProperty(route(request), "url", { value: url.href });
    const message = `no route ${request.method} ${url.pathname}`;
    return Response.json({ message }, { status: 404 });
  };
  return { fetch, requests, mints };
}

function client(routes: Routes, auth: GithubAppAuth = APP_AUTH): FakeClient {
  const fake = fakeGithub(routes);
  const host = new GithubCodeHost(auth, { baseUrl: BASE_URL, fetch: fake.fetch });
  return { host, requests: fake.requests, mints: fake.mints };
}

function expectAppJwt(authorization: string | null): void {
  expect(authorization).toMatch(/^bearer /);
  const [header = "", payload = "", signature = ""] = (authorization ?? "").slice(7).split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  expect(verifier.verify(PUBLIC_KEY_PEM, Buffer.from(signature, "base64url"))).toBe(true);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: unknown };
  expect(String(claims.iss)).toBe("1234");
}

const APP_ROUTE: Routes = { "GET /app": json({ slug: "ao-bot" }) };

const FULL_PULL = {
  number: 1,
  html_url: "https://gh.test/acme/app/pull/1",
  state: "open",
  title: "Fix",
  head: { ref: "feature/x", sha: "abc", repo: { full_name: "acme/app" } },
  base: { ref: "main", repo: { full_name: "acme/app" } },
  merged_at: null,
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
};

describe("GithubCodeHost", () => {
  describe("two mints of a token narrowed to the same permissions", () => {
    let github: FakeClient;
    let first: MintedToken;
    let second: MintedToken;

    beforeEach(async () => {
      github = client({});
      first = await github.host.mintToken("acme/app", { contents: "read" });
      second = await github.host.mintToken("acme/app", { contents: "read" });
    });

    it("call the endpoint every time", () => {
      expect(github.mints).toHaveLength(2);
    });

    it("read the token and the moment it expires", () => {
      expect(first).toEqual({ token: "ghs_1", expiresAt: Date.parse(EXPIRES_AT) });
    });

    it("answer the same the second time", () => {
      expect(second).toEqual(first);
    });

    it("ask for the one repository and the permissions the caller named", () => {
      expect(JSON.parse(github.mints[0]?.body ?? "")).toEqual({
        repositories: ["app"],
        permissions: { contents: "read" },
      });
    });

    it("authenticate with the App JWT", () => {
      expectAppJwt(github.mints[0]?.authorization ?? null);
    });
  });

  it("names the repository alone when no permissions are asked for", async () => {
    const github = client({});
    await github.host.mintToken("acme/app");
    expect(JSON.parse(github.mints[0]?.body ?? "")).toEqual({ repositories: ["app"] });
  });

  describe("two reads of the reviewer login", () => {
    let github: FakeClient;
    let logins: string[];

    beforeEach(async () => {
      github = client(APP_ROUTE);
      logins = [await github.host.reviewerLogin(), await github.host.reviewerLogin()];
    });

    it("answer the app slug as a bot login", () => {
      expect(logins).toEqual(["ao-bot[bot]", "ao-bot[bot]"]);
    });

    it("read /app once and cache the login", () => {
      expect(github.requests).toHaveLength(1);
    });

    it("authenticate /app with the App JWT", () => {
      expectAppJwt(github.requests[0]?.authorization ?? null);
    });
  });

  describe("two reads of the commit author", () => {
    let github: FakeClient;
    let authors: CommitAuthor[];

    beforeEach(async () => {
      github = client({
        ...APP_ROUTE,
        "GET /users/ao-bot%5Bbot%5D": json({ login: "ao-bot[bot]", id: 4242 }),
      });
      authors = [await github.host.commitAuthor(), await github.host.commitAuthor()];
    });

    it("answer the bot login at its noreply address", () => {
      expect(authors).toEqual([
        { name: "ao-bot[bot]", email: "4242+ao-bot[bot]@users.noreply.github.com" },
        { name: "ao-bot[bot]", email: "4242+ao-bot[bot]@users.noreply.github.com" },
      ]);
    });

    it("read the bot account once", () => {
      expect(
        github.requests.filter((request) => request.url.pathname.startsWith("/users/")),
      ).toHaveLength(1);
    });
  });

  describe("the PKCS#1 key GitHub downloads", () => {
    let github: FakeClient;
    let login: string;

    beforeEach(async () => {
      github = client(APP_ROUTE, { ...APP_AUTH, privateKeyPem: PKCS1_PEM });
      login = await github.host.reviewerLogin();
    });

    it("reads the reviewer login", () => {
      expect(login).toBe("ao-bot[bot]");
    });

    it("signs the App JWT", () => {
      expectAppJwt(github.requests[0]?.authorization ?? null);
    });
  });

  describe("two calls to the same repository", () => {
    let github: FakeClient;

    beforeEach(async () => {
      github = client({ "GET /repos/acme/app/pulls/1": json(FULL_PULL) });
      await github.host.getPull("acme/app", 1);
      await github.host.getPull("acme/app", 1);
    });

    it("mint one installation token for both", () => {
      expect(github.mints).toHaveLength(1);
    });

    it("carry that token", () => {
      expect(github.requests.map((request) => request.authorization)).toEqual([
        "token ghs_1",
        "token ghs_1",
      ]);
    });

    it("name artfct as the user agent", () => {
      expect(github.requests[0]?.userAgent).toStartWith("artfct ");
    });
  });

  describe("the installation's repositories", () => {
    let github: FakeClient;
    let repositories: string[];

    beforeEach(async () => {
      github = client({
        "GET /installation/repositories": json({
          repositories: [{ full_name: "acme/app" }, { full_name: "acme/web" }],
        }),
      });
      repositories = await github.host.repositories();
    });

    it("come back as full names", () => {
      expect(repositories).toEqual(["acme/app", "acme/web"]);
    });

    it("are asked for a hundred at a time", () => {
      expect(github.requests[0]?.url.searchParams.get("per_page")).toBe("100");
    });
  });

  it("gives every request a timeout signal", async () => {
    const github = client(APP_ROUTE);
    await github.host.reviewerLogin();
    expect(github.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(github.requests[0]?.signal?.aborted).toBe(false);
  });
});

function reviews(start: number, count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: start + index,
    user: { login: "ao-bot[bot]", type: "Bot" },
    state: "COMMENTED",
    body: "",
    commit_id: "abc",
    submitted_at: EXPIRES_AT,
  }));
}

function reviewPage(page: number, count: number, hasNext: boolean): Response {
  const next = `${BASE_URL}/repos/acme/app/pulls/1/reviews?per_page=100&page=${page + 1}`;
  return Response.json(reviews((page - 1) * 100 + 1, count), {
    headers: hasNext ? { link: `<${next}>; rel="next"` } : {},
  });
}

describe("GithubCodeHost mapping", () => {
  it("maps a full pull request", async () => {
    const github = client({ "GET /repos/acme/app/pulls/1": json(FULL_PULL) });
    expect(await github.host.getPull("acme/app", 1)).toEqual({
      number: 1,
      html_url: "https://gh.test/acme/app/pull/1",
      state: "open",
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
      head: { ref: "feature/x", sha: "abc" },
      base: { ref: "main" },
      from_fork: false,
      title: "Fix",
    });
  });

  describe("a pull request whose head is in another repository", () => {
    it("is from a fork", async () => {
      const forked = { ...FULL_PULL.head, repo: { full_name: "mallory/app" } };
      const github = client({
        "GET /repos/acme/app/pulls/1": json({ ...FULL_PULL, head: forked }),
      });
      expect((await github.host.getPull("acme/app", 1)).from_fork).toBe(true);
    });
  });

  describe("a pull request whose head repository was deleted", () => {
    it("is from a fork", async () => {
      const github = client({
        "GET /repos/acme/app/pulls/1": json({
          ...FULL_PULL,
          head: { ...FULL_PULL.head, repo: null },
        }),
      });
      expect((await github.host.getPull("acme/app", 1)).from_fork).toBe(true);
    });
  });

  describe("a merged pull request found by branch", () => {
    let github: FakeClient;
    let pull: PullRequest | undefined;

    beforeEach(async () => {
      const { number, html_url, state, title, head, base } = FULL_PULL;
      const listItem = { number, html_url, state, title, head, base, merged_at: EXPIRES_AT };
      github = client({ "GET /repos/acme/app/pulls": json([listItem]) });
      const pulls = await github.host.pullsForBranch("acme/app", "feature/x");
      pull = pulls[0];
    });

    it("is looked up among the owner's open pulls", () => {
      expect(github.requests[0]?.url.searchParams.get("state")).toBe("open");
      expect(github.requests[0]?.url.searchParams.get("head")).toBe("acme:feature/x");
    });

    it("reads as merged, with the mergeable fields the list item lacks", () => {
      expect(pull).toMatchObject({ merged: true, mergeable: null, mergeable_state: "unknown" });
    });
  });

  describe("the check runs of a ref", () => {
    let github: FakeClient;
    let checkRuns: CheckRun[];

    beforeEach(async () => {
      github = client({
        "GET /repos/acme/app/commits/abc/check-runs": json({
          check_runs: [{ name: "ci", conclusion: "success", html_url: null, extra: 1 }],
        }),
      });
      checkRuns = await github.host.checkRunsForRef("acme/app", "abc");
    });

    it("come out of the wrapper with only the fields we map", () => {
      expect(checkRuns).toEqual([{ name: "ci", conclusion: "success", html_url: "" }]);
    });

    it("are asked for a hundred at a time", () => {
      expect(github.requests[0]?.url.searchParams.get("per_page")).toBe("100");
    });
  });

  describe("the checks of a commit", () => {
    let github: FakeClient;
    let commitChecks: CommitChecks;

    beforeEach(async () => {
      github = client({
        "GET /repos/acme/app/commits/abc/check-runs": json({
          total_count: 1,
          check_runs: [
            {
              name: "unit",
              conclusion: "failure",
              completed_at: "2026-01-01T00:00:00Z",
              html_url: "https://gh.test/acme/app/runs/1",
              output: { title: "2 tests failed", summary: null },
            },
          ],
        }),
        "GET /repos/acme/app/commits/abc/check-suites": json({
          total_count: 1,
          check_suites: [{ status: "completed", latest_check_runs_count: 1 }],
        }),
        "GET /repos/acme/app/commits/abc/status": json({
          statuses: [
            {
              context: "deploy/preview",
              state: "success",
              description: null,
              target_url: null,
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      });
      commitChecks = await github.host.commitChecks("acme/app", "abc");
    });

    it("reads the runs, the suites, and the statuses", () => {
      expect(github.requests.map((request) => request.url.pathname).toSorted()).toEqual([
        "/repos/acme/app/commits/abc/check-runs",
        "/repos/acme/app/commits/abc/check-suites",
        "/repos/acme/app/commits/abc/status",
      ]);
    });

    it("asks for each a hundred at a time", () => {
      expect(github.requests.map((request) => request.url.searchParams.get("per_page"))).toEqual([
        "100",
        "100",
        "100",
      ]);
    });

    it("says the failed run", () => {
      expect(commitChecks).toEqual({
        state: "failed",
        failures: [
          {
            name: "unit",
            conclusion: "failure",
            detail: "2 tests failed",
            url: "https://gh.test/acme/app/runs/1",
          },
        ],
      });
    });
  });

  describe("a review with inline comments", () => {
    let github: FakeClient;
    let pullReviews: PullRequestReview[];
    let comments: PullRequestReviewComment[];
    let posted: { id: number };

    beforeEach(async () => {
      github = client({
        "GET /repos/acme/app/pulls/1/reviews": () => reviewPage(1, 1, false),
        "GET /repos/acme/app/pulls/1/reviews/1/comments": json([
          { id: 11, path: "a.ts", line: 3, original_line: 2, body: "nit" },
          { id: 12, path: "b.ts", body: "outdated" },
        ]),
        "POST /repos/acme/app/issues/1/comments": json({ id: 5 }),
      });
      pullReviews = await github.host.pullReviews("acme/app", 1);
      comments = await github.host.reviewComments("acme/app", 1, 1);
      posted = await github.host.commentOnPull("acme/app", 1, "looks good");
    });

    it("maps the review with its author and commit", () => {
      expect(pullReviews).toEqual([
        {
          id: 1,
          user: { login: "ao-bot[bot]", type: "Bot" },
          state: "COMMENTED",
          body: "",
          commit_id: "abc",
          submitted_at: EXPIRES_AT,
        },
      ]);
    });

    it("maps the comments and reads a comment without a line as null", () => {
      expect(comments).toEqual([
        { id: 11, path: "a.ts", line: 3, original_line: 2, body: "nit" },
        { id: 12, path: "b.ts", line: null, original_line: null, body: "outdated" },
      ]);
    });

    it("returns the id of the comment it posts", () => {
      expect(posted).toEqual({ id: 5 });
    });

    it("posts the body it was given", () => {
      expect(JSON.parse(github.requests[2]?.body ?? "")).toEqual({ body: "looks good" });
    });
  });
});

describe("GithubCodeHost pagination", () => {
  describe("a list of two pages", () => {
    let github: FakeClient;
    let result: PullRequestReview[];

    beforeEach(async () => {
      github = client({
        "GET /repos/acme/app/pulls/1/reviews": (request) => {
          const page = Number(request.url.searchParams.get("page") ?? "1");
          return page === 1 ? reviewPage(1, 100, true) : reviewPage(2, 2, false);
        },
      });
      result = await github.host.pullReviews("acme/app", 1);
    });

    it("follows the link header to the last page", () => {
      expect(github.requests).toHaveLength(2);
    });

    it("returns the rows of both pages", () => {
      expect(result).toHaveLength(102);
    });

    it("ends on the last row of the last page", () => {
      expect(result.at(-1)?.id).toBe(102);
    });
  });

  describe("a runaway list that always names a next page", () => {
    let github: FakeClient;
    let result: PullRequestReview[];

    beforeEach(async () => {
      github = client({
        "GET /repos/acme/app/pulls/1/reviews": (request) => {
          const page = Number(request.url.searchParams.get("page") ?? "1");
          return reviewPage(page, 100, true);
        },
      });
      result = await github.host.pullReviews("acme/app", 1);
    });

    it("stops after ten pages", () => {
      expect(github.requests).toHaveLength(10);
    });

    it("returns the rows of those ten pages", () => {
      expect(result).toHaveLength(1000);
    });
  });
});

describe("GithubCodeHost asked whether a login may push", () => {
  const PERMISSION_PATH = "GET /repos/acme/app/collaborators/sam/permission";

  function permission(level: string): Routes {
    return { [PERMISSION_PATH]: json({ permission: level, role_name: level }) };
  }

  describe("a login with write access", () => {
    let github: FakeClient;
    let allowed: boolean;

    beforeEach(async () => {
      github = client(permission("write"));
      allowed = await github.host.canPush("acme/app", "sam");
    });

    it("may push", () => {
      expect(allowed).toBe(true);
    });

    it("asks for the permission of that login on that repository", () => {
      const paths = github.requests.map((request) => `${request.method} ${request.url.pathname}`);
      expect(paths).toEqual([PERMISSION_PATH]);
    });
  });

  describe("an admin", () => {
    it("may push", async () => {
      expect(await client(permission("admin")).host.canPush("acme/app", "sam")).toBe(true);
    });
  });

  describe.each(["read", "none"])("a login with %s access", (level) => {
    it("may not push", async () => {
      expect(await client(permission(level)).host.canPush("acme/app", "sam")).toBe(false);
    });
  });

  describe("a login the host does not know", () => {
    it("throws", async () => {
      await expect(client({}).host.canPush("acme/app", "sam")).rejects.toThrow();
    });
  });
});

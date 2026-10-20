import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  githubFailedCheckWinsInAnyOrder,
  githubPullLinkNamesOnlyAGithubPull,
  githubPullLinkRoundTrips,
} from "../../../test/github-code-invariants";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import {
  githubCommitChecks,
  type CommitCheckRunPayload,
  type CommitStatusPayload,
  type GithubCommitChecksInput,
} from "./commit-checks";
import { githubPullFromUrl, githubPullUrl } from "./url";

const RUNS = 100;

const githubTime = fc
  .date({
    min: new Date("2026-01-01T00:00:00Z"),
    max: new Date("2026-01-01T00:10:00Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().replace(/\.\d{3}Z$/, "Z"));

const checkName = fc.oneof(fc.constantFrom("unit", "e2e", "lint", "ci/build"), fc.string());

const checkText = fc.option(
  fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.integer({ min: 1990, max: 2010 }).map((length) => "x".repeat(length)),
  ),
);

const checkUrl = fc.option(
  fc.constantFrom("https://github.com/acme/app/runs/1", "https://ci.test/1"),
);

const run: fc.Arbitrary<CommitCheckRunPayload> = fc.record({
  name: checkName,
  conclusion: fc.oneof(
    fc.constantFrom(
      null,
      "success",
      "neutral",
      "skipped",
      "failure",
      "timed_out",
      "cancelled",
      "action_required",
      "stale",
      "startup_failure",
    ),
    fc.string({ maxLength: 8 }),
  ),
  completed_at: fc.option(githubTime),
  html_url: checkUrl,
  output: fc.record({ title: checkText, summary: checkText }),
});

const commitStatus: fc.Arbitrary<CommitStatusPayload> = fc.record({
  context: checkName,
  state: fc.oneof(
    fc.constantFrom("pending", "success", "failure", "error"),
    fc.string({ maxLength: 8 }),
  ),
  description: checkText,
  target_url: checkUrl,
  updated_at: githubTime,
});

const suite = fc.record({
  status: fc.constantFrom(
    null,
    "queued",
    "in_progress",
    "completed",
    "requested",
    "waiting",
    "pending",
  ),
  latest_check_runs_count: fc.nat(3),
});

const permutation = <Item>(items: Item[]) =>
  fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length });

const checksInAnyTwoOrders = fc
  .record({
    runs: fc.array(run, { maxLength: 4 }),
    suites: fc.array(suite, { maxLength: 3 }),
    statuses: fc.array(commitStatus, { maxLength: 4 }),
  })
  .chain((input) =>
    fc.record({
      input: fc.constant(input),
      shuffled: fc.record({
        runs: permutation(input.runs),
        suites: permutation(input.suites),
        statuses: permutation(input.statuses),
      }),
    }),
  );

function standingsOf(input: GithubCommitChecksInput): { stopped: boolean; failed: boolean } {
  const runConclusions = input.runs.map((check) => check.conclusion);
  const failed =
    runConclusions.some((conclusion) => conclusion === "failure" || conclusion === "timed_out") ||
    input.statuses.some((check) => check.state === "failure");
  const stopped =
    runConclusions.includes("cancelled") || input.statuses.some((check) => check.state === "error");
  return { stopped, failed };
}

function runningAlongside(input: GithubCommitChecksInput): boolean {
  return (
    input.runs.some((check) => check.conclusion === null) ||
    input.statuses.some((check) => check.state === "pending")
  );
}

const repoSegment = fc.stringMatching(/^[\w.-]{1,12}$/).filter((name) => !/^\.{1,2}$/.test(name));

const pullRequest = fc.record({
  repo: fc.tuple(repoSegment, repoSegment).map(([owner, name]) => `${owner}/${name}`),
  number: fc.oneof(
    fc.integer({ min: 1, max: 100_000 }),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  ),
});

const linkSuffix = fc.constantFrom("", "/", "/files", "/files#r1", "?w=1", "#issuecomment-1");

const hostilePrefix = fc.constantFrom(
  "https://github.com/",
  "http://github.com/",
  "https://www.github.com/",
  "https://notgithub.com/",
  "https://evil.test/github.com/",
  "https://github.com.evil.test/",
  "https://evil.test/?next=https://github.com/",
  "https://github.com@evil.test/",
  "ftp://github.com/",
);

const pullNumberText = fc.oneof(
  fc.nat().map(String),
  fc.bigInt({ min: 2n ** 53n, max: 10n ** 30n }).map(String),
  fc.constant("9".repeat(400)),
  fc.nat().map((number) => `${number}abc`),
);

const hostileLink = fc.oneof(
  fc
    .tuple(hostilePrefix, repoSegment, repoSegment, pullNumberText, linkSuffix)
    .map(
      ([prefix, owner, name, number, suffix]) =>
        `${prefix}${owner}/${name}/pull/${number}${suffix}`,
    ),
  fc.string(),
);

describe("GitHub code invariants", () => {
  it(
    "a failed check wins and the reading does not depend on the order of the checks",
    () => {
      let stoppedWhileRunning = 0;
      let errorStatusWithoutFailure = 0;
      fc.assert(
        fc.property(checksInAnyTwoOrders, ({ input, shuffled }) => {
          const { stopped, failed } = standingsOf(input);
          if (stopped && !failed && runningAlongside(input)) stoppedWhileRunning++;
          if (!failed && input.statuses.some((check) => check.state === "error")) {
            errorStatusWithoutFailure++;
          }
          githubFailedCheckWinsInAnyOrder(
            input,
            githubCommitChecks(input),
            githubCommitChecks(shuffled),
          );
        }),
        propertyRuns("github failed check wins", RUNS),
      );
      expect(stoppedWhileRunning).toBeGreaterThan(0);
      expect(errorStatusWithoutFailure).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "a link reads as a pull request only on github.com",
    () => {
      let foreignHosts = 0;
      fc.assert(
        fc.property(hostileLink, (url) => {
          if (!url.startsWith("https://github.com/") && url.includes("github.com/")) foreignHosts++;
          githubPullLinkNamesOnlyAGithubPull(url, githubPullFromUrl(url));
        }),
        {
          ...propertyRuns("github pull link names only a github pull", RUNS),
          examples: [
            ["https://evil.test/github.com/acme/app/pull/7"],
            ["https://github.com/acme/app/pull/7abc"],
            ["https://github.com/acme/app/pull/9007199254740993"],
          ],
        },
      );
      expect(foreignHosts).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "the link written for a pull request reads back as that pull request",
    () => {
      let largeNumbers = 0;
      fc.assert(
        fc.property(pullRequest, linkSuffix, (pull, suffix) => {
          if (pull.number > 2 ** 32) largeNumbers++;
          githubPullLinkRoundTrips(pull, githubPullFromUrl(`${githubPullUrl(pull)}${suffix}`));
        }),
        propertyRuns("github pull link round trips", RUNS),
      );
      expect(largeNumbers).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});

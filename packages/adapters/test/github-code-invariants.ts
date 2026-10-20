import type {
  CommitCheckRunPayload,
  CommitStatusPayload,
  GithubCommitChecksInput,
} from "../src/code/github/commit-checks";
import type { CheckFailure, CommitChecks } from "../src/code/types";

/** How GitHub's documented check run conclusions read. Any other non-null conclusion is stopped. */
const RUN_CONCLUSION_STANDINGS: Record<string, "passed" | "failed"> = {
  success: "passed",
  neutral: "passed",
  skipped: "passed",
  failure: "failed",
  timed_out: "failed",
};

/** The most a failure detail holds, so the prompt to the author stays short. */
const FAILURE_DETAIL_LIMIT = 2000;

type Standing = "passed" | "running" | "failed" | "stopped";

type ExpectedCheck = {
  name: string;
  conclusion: string | null;
  standing: Standing;
  at: string | null;
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

function expectedRun(run: CommitCheckRunPayload): ExpectedCheck {
  if (run.conclusion === null) {
    return { name: run.name, conclusion: null, standing: "running", at: null };
  }
  const standing = RUN_CONCLUSION_STANDINGS[run.conclusion] ?? "stopped";
  return { name: run.name, conclusion: run.conclusion, standing, at: run.completed_at };
}

function expectedStatus(status: CommitStatusPayload): ExpectedCheck {
  const standing: Standing =
    status.state === "pending"
      ? "running"
      : status.state === "success"
        ? "passed"
        : status.state === "failure"
          ? "failed"
          : "stopped";
  return { name: status.context, conclusion: status.state, standing, at: status.updated_at };
}

function failureKeys(failures: Array<{ name: string; conclusion: string | null }>): string[] {
  return failures.map((failure) => JSON.stringify([failure.name, failure.conclusion])).toSorted();
}

function readingKey(checks: CommitChecks): string {
  if (checks.state === "passed") return JSON.stringify([checks.state, checks.settled_at]);
  if (checks.state === "failed" || checks.state === "stopped") {
    return JSON.stringify([
      checks.state,
      checks.failures.map((failure) => JSON.stringify(failure)).toSorted(),
    ]);
  }
  return checks.state;
}

function newestTime(times: string[]): string | undefined {
  return times.reduce<string | undefined>(
    (newest, time) =>
      newest === undefined || Date.parse(time) > Date.parse(newest) ? time : newest,
    undefined,
  );
}

function checkFailures(name: string, failures: CheckFailure[], expected: ExpectedCheck[]): void {
  const want = failureKeys(expected);
  const got = failureKeys(failures);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    violated(name, `the failures are ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }
  const long = failures.find((failure) => failure.detail.length > FAILURE_DETAIL_LIMIT);
  if (long) violated(name, `${long.name} carries ${long.detail.length} detail characters`);
}

/**
 * A failed check wins, then a stopped one, then a running check or an open suite with runs. The
 * commit passed only when every check passed, at the newest finish. The order GitHub lists the
 * checks in does not change the reading, and a failure detail holds at most 2000 characters.
 */
export function githubFailedCheckWinsInAnyOrder(
  input: GithubCommitChecksInput,
  checks: CommitChecks,
  shuffledChecks: CommitChecks,
): void {
  const name = "githubFailedCheckWinsInAnyOrder";
  if (readingKey(checks) !== readingKey(shuffledChecks)) {
    violated(name, `${readingKey(checks)} becomes ${readingKey(shuffledChecks)} in another order`);
  }
  const expected = [...input.runs.map(expectedRun), ...input.statuses.map(expectedStatus)];
  const withStanding = (standing: Standing) =>
    expected.filter((check) => check.standing === standing);
  const openSuite = input.suites.some(
    (suite) => suite.latest_check_runs_count > 0 && suite.status !== "completed",
  );
  const passedTimes = withStanding("passed").flatMap((check) => (check.at ? [check.at] : []));
  const newest = newestTime(passedTimes);
  const want = withStanding("failed").length
    ? "failed"
    : withStanding("stopped").length
      ? "stopped"
      : withStanding("running").length || openSuite
        ? "running"
        : newest
          ? "passed"
          : "unreported";
  if (checks.state !== want) violated(name, `the commit reads ${checks.state}, not ${want}`);
  switch (checks.state) {
    case "failed":
    case "stopped":
      checkFailures(name, checks.failures, withStanding(checks.state));
      return;
    case "passed":
      if (newest && Date.parse(checks.settled_at) !== Date.parse(newest)) {
        violated(name, `the commit settled at ${checks.settled_at}, not ${newest}`);
      }
      return;
    case "running":
    case "unreported":
      return;
  }
}

/** A link reads as a pull request only when it is an https link on github.com to that pull request. */
export function githubPullLinkNamesOnlyAGithubPull(
  url: string,
  reading: { repo: string; number: number } | null,
): void {
  if (!reading) return;
  const name = "githubPullLinkNamesOnlyAGithubPull";
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed?.protocol !== "https:" || parsed.hostname !== "github.com") {
    violated(
      name,
      `${JSON.stringify(url)} is not on github.com but reads as ${JSON.stringify(reading)}`,
    );
  }
  const [, owner, repo, pull, number] = parsed.pathname.split("/");
  const named =
    pull === "pull" && `${owner}/${repo}` === reading.repo && Number(number) === reading.number;
  if (!named || !Number.isSafeInteger(reading.number)) {
    violated(name, `${JSON.stringify(url)} reads as ${JSON.stringify(reading)}`);
  }
}

/** The link the system writes for a pull request reads back as that pull request. */
export function githubPullLinkRoundTrips(
  pull: { repo: string; number: number },
  reading: { repo: string; number: number } | null,
): void {
  if (reading?.repo === pull.repo && reading.number === pull.number) return;
  violated(
    "githubPullLinkRoundTrips",
    `the link of ${JSON.stringify(pull)} reads as ${JSON.stringify(reading)}`,
  );
}

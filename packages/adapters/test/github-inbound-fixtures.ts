import { expect } from "bun:test";
import { githubInbound } from "../src/code/github/inbound";
import { ownGithubLogins } from "../src/code/github/inbound-shared";
import type { CodeActorResolver, CodeInbound } from "../src/code/types";
import { fakeLoginActor } from "./fake-actors";

/** The repository every GitHub fixture below belongs to. */
export const repo = { full_name: "acme/app", default_branch: "main" };

/** A head branch the orchestrator owns, with the workflow id inside the name. */
export const branch = "artfct/wf_abcdefghij-1-fix";

/** An open pull request on the orchestrator branch. */
export const pr = {
  number: 7,
  html_url: "https://github.com/acme/app/pull/7",
  head: { ref: branch, sha: "abc", repo: { full_name: "acme/app" } },
  base: { ref: "main" },
  title: "Fix login",
};

/** The same pull request opened from a fork of the repository. */
export const forkPr = { ...pr, head: { ...pr.head, repo: { full_name: "mallory/app" } } };

/** The GitHub App login the fixtures configure as the orchestrator's own. */
export const OUR_APP_LOGIN = "orchestrator-app";

/** A person who reviews pull requests. */
export const sam = { login: "sam" };

/** Maps a payload for `repo` on delivery `d1`. The resolver lets everyone in unless replaced. */
export function normalizeGithubWebhook(
  eventName: string,
  payload: Record<string, unknown>,
  resolveActor: CodeActorResolver = fakeLoginActor,
) {
  return githubInbound(
    eventName,
    { repository: repo, ...payload },
    { resolveActor, deliveryId: "d1", ownLogins: ownGithubLogins(OUR_APP_LOGIN) },
  );
}

/** A review from `sam`, unless the caller replaces the user. */
export function reviewPayload(state: string, body: string) {
  return { id: 501, state, body, user: sam };
}

/** Unwraps a normalized event, or fails the test with the reason it was ignored. */
export function expectEvent(normalized: CodeInbound) {
  if ("ignore" in normalized) throw new Error(normalized.ignore);
  return normalized;
}

/** Asserts the mapper refused the payload. */
export function expectIgnored(normalized: CodeInbound) {
  expect("ignore" in normalized).toBe(true);
}

---
name: design-functionality-review
description: Review a page for whether what it proposes works in the code as it is today. Check that the mechanisms hold, cover every path, enforce their conditions, and do not collide with existing behaviour or existing state. Use this when the task is a functionality review of a page.
---

## Rules

You are a read-only reviewer. Rules:
- Do not change the page or any file. Do not run git write commands.
- Read the page, the request, and the research payload in your prompt. Read the repository source, docs, and any rules file, glossary, or invariants it holds. The research payload was the writer's only source, and the writer could not see the code. Do not stop at the research payload. Read the code each mechanism touches.
- Write plain English. Short sentences. No em dashes, no semicolons. Quote the documents when you make a claim about them.
- Be concrete. Every finding names the section and quotes the sentence.
- Apply the `review-conduct` skill to every finding you file.

## Task

Review the page for function. Later stages build what the page states. Find where the result would not work, or would not do what the request asks, in the code as it is today. Review for what changes what a reader or a later agent would do.

Trace before you judge. For each mechanism the page states, find in the code every path that produces the behaviour the mechanism changes. Find every rule, timer, limit, and reader that acts on the state the mechanism touches. When the page proposes more than one direction, review each direction on its own.

Review the page for:
9. A mechanism that does not hold. The page builds on a component the code already has, and that component behaves differently in a case the page depends on.
10. Uncovered paths. The page changes or stops a behaviour, and a path in the code that produces that behaviour does not pass through the mechanisms the page states.
11. Unenforced conditions. The page states who or what may trigger an action, or when the action may happen, and the mechanisms it states do not enforce that. A condition that only an agent's instructions hold is a finding when breaking it defeats what the request asks for.
12. Collisions with existing behaviour. A rule, a timer, a limit, or an invariant the code already has acts on the state the page adds or changes, and produces a wrong outcome there.
13. Existing state. Work in flight or stored state exists when the change ships, and the mechanisms the page states produce a wrong outcome on it.

Check 5, misstated facts about the code today, belongs to the facts review. Do not report a wrong fact on its own. Report it only as the ground of one of your checks. The other checks belong to the consistency review. Do not report them here.

## Limits

- Judge the mechanisms the page states. The page leaves tactical details to a later stage, so a missing implementation detail is not a finding.
- Do not report a cost the page already states as a tradeoff, a risk, or an open question, unless it defeats what the request asks for.
- Stay inside the approach of the page. Do not propose another approach. Do not report simplicity, scope, or taste.

## Prior findings

When an earlier review on the page left findings, first check each prior finding. Report it as held, regressed, or not resolved. A regressed or unresolved finding is a finding again in this review.

## Severity

Severity for each finding: `blocking` (a gap that produces a wrong outcome for an input or a state that occurs and defeats what the request asks for) or `minor` (a gap that produces a wrong outcome a person would see and recover from). Do not report nitpicks. Every edit can cause a new issue, so report only what changes what a reader would do.

## Findings form

Post the review in the form your review instructions give. Its first line follows the severity of the findings:
- `Review: blocking` when any finding is blocking.
- `Review: findings` when there are findings and none is blocking.
- `Review: approved` when there are no findings.

The summary paragraph gives the count of findings by severity, and the prior findings held, regressed, and not resolved. Then write each finding as one line, in exactly this form:

```
- <section or sections>: Severity: <blocking | minor>. Claim: "<exact quote from the page>". Criterion: <the number and name of the check>. Ground: <the quote from the source that shows the problem, with file and line, and the input or state that produces the wrong outcome>. Resolve: <the exact change to make, in one to three sentences>.
```

The editor who resolves the findings cannot see the code. Put every fact about the code that the change needs in Ground or Resolve.

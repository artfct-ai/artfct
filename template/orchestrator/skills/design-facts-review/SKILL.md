---
name: design-facts-review
description: Review a page for misstated facts about the code today, and check every quoted rule, invariant, and glossary entry word for word against the repository. Use this when the task is a facts review of a page.
---

## Rules

You are a read-only reviewer. Rules:
- Do not change the page or any file. Do not run git write commands.
- Read the page and the research payload in your prompt. Read the repository source, docs, and any rules file, glossary, or invariants it holds to check each fact. The research payload was the writer's only source, and the writer could not see the code.
- Write plain English. Short sentences. No em dashes, no semicolons. Quote the documents when you make a claim about them.
- Be concrete. Every finding names the section and quotes the sentence.
- Apply the `review-conduct` skill to every finding you file.

## Task

Review the page for facts. Later stages act on what the page states. Review for what changes what a reader or a later agent would do.

Review the page for:
5. Misstated facts about the code today. When the page quotes a rule, an invariant, or a glossary entry, check the quote word for word against the repository.

Do not judge whether the design works. That belongs to the functionality review. The other checks belong to the consistency review. Do not report them here.

## Fact sweep

Sweep the whole page for facts once, before you write findings. List every sentence that says what the code does today, in every section. Why, Tradeoffs, the Appendix, and any reference block or diagram count. A sentence that says the change follows a path the code already has is such a sentence. Check each one against the repository. Check each code name a reference block gives against the code.

## Prior findings

When an earlier review on the page left findings, first check each prior finding. Report it as held, regressed, or not resolved. A regressed or unresolved finding is a finding again in this review.

## Severity

Severity for each finding: `blocking` (a wrong fact), `minor` (a misquote that does not change the meaning), or `nitpick` (word choice a reader would not act on). When the repository has a glossary, report a nitpick only when it is a word the glossary says not to use. Otherwise do not report nitpicks. Every edit can cause a new issue, so report only what changes what a reader would do.

## Findings form

Post the review in the form your review instructions give. Its first line follows the severity of the findings:
- `Review: blocking` when any finding is blocking.
- `Review: findings` when there are findings and none is blocking.
- `Review: approved` when there are no findings.

The summary paragraph gives the count of findings by severity, and the prior findings held, regressed, and not resolved. Then write each finding as one line, in exactly this form:

```
- <section or sections>: Severity: <blocking | minor | nitpick>. Claim: "<exact quote from the page>". Criterion: 5, misstated fact. Ground: <the quote from the research payload or the source that shows the problem, with file and line>. Resolve: <the exact change to make, in one to three sentences>.
```

The editor who resolves the findings cannot see the code. Put every fact about the code that the change needs in Ground or Resolve.

Do not report taste. Do not propose design changes beyond what the facts require.

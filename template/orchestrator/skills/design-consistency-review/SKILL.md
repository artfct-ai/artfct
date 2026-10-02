---
name: design-consistency-review
description: Review a design page for contradictions, naming drift, repetition, departures from the direction, Design Rules violations, and an Appendix out of step with Design. Use this when the task is a consistency review of a design page. It does not read the code.
---

## Rules

You are a read-only reviewer. Rules:
- Do not change the page or any file. Do not run git write commands.
- Do not read the code.
- Write plain English. Short sentences. Do not use em dashes or semicolons. Quote the documents when you make a claim about them.
- Be concrete. Every finding names the section and quotes the sentence.
- Apply the `review-conduct` skill to every finding you file.

## Task

Review the design page for consistency. The page feeds a plan stage. Agents act on Design, Decisions, and Guardrails. The Why and Tradeoffs sections are for the person who approves the design. Review for what changes what an agent would do.

The review is three passes: naming, internal, and reference. Each pass has its own checks and its own reading.

- When your task names one pass, run that pass yourself. Do not launch subagents. Reply with only the finding lines of that pass and the state of each prior finding you were given. When the pass does not have findings, reply with the line `Findings: 0`.
- Otherwise, run the review. Launch one subagent for each pass, and run the three at the same time. Do not run a pass yourself. Then merge what they report.

Tell each subagent to apply this skill and run one pass, and name the pass. Give it:
- The links your prompt gives for the page, the request, and the direction page. The direction page is the page of an earlier stage your prompt links under the artifacts from earlier stages, or the page it links as the input artifact. When your prompt does not link one, the request is the direction.
- The prior findings of its pass, when an earlier review on the page left findings. A prior finding belongs to the pass that holds the check its Criterion names.

Check 5, misstated facts about the code today, belongs to the facts review. Checks 9 to 13, on whether the design works in the code, belong to the functionality review. Do not report them here. Do not review the page against the writing rules.

## Naming pass

Read the page. When the repository has a glossary, read it too.

2. Naming drift. The page gives two terms to one thing. When the repository has a glossary, the page uses a glossary term with another meaning, or uses a word the glossary says not to use.

A term is a fixed label. The terms of the page are:
- The names it gives to what the change adds: a mechanism, a state, a stored value, a role.
- The names in a reference block and in a proposed glossary or invariant row.
- The glossary terms it uses.

A name the page uses for a state or a value without defining it is a term too, such as a name in a heading. Report it when Design already states that state or value in other words.

Check terms only. Ordinary wording is not naming drift. Do not report:
- A description in plain words beside a term, such as "the jobs that wait" beside the term "retry queue".
- A short form whose meaning is plain in its sentence, such as "the queue" after "the retry queue".
- Two wordings for something the change does not add and the glossary does not define.

First list the terms, one line each. Do not list every noun phrase. Then take one term at a time and search the page for a second term for the same thing. Report each thing that has two terms, each glossary term the page uses with another meaning, and each word the glossary says not to use. File one finding for each thing, however many terms it has.

A word the glossary says not to use is a nitpick when its meaning on the page is still plain.

## Internal pass

Read only the page. This pass checks the page against itself.

1. Cross-section contradictions. Two sections say different things about one mechanism, rule, or outcome. Why and Tradeoffs may not contradict Design. Their coverage is not reviewed.
3. Repetition within or between Problem, Solution, Design, and the Appendix. Do not report repetition in Why or Tradeoffs.
7. Appendix out of step with Design. Decisions and Guardrails describe only the mechanisms Design states. A Guardrail that keeps a behaviour the code has today is not out of step with Design, so do not report it.

Work in steps, and write down the result of each step before you start the next. Do not compare the whole page at once.
- List the mechanisms, rules, and outcomes Design states, one line each.
- Take one line at a time. Search the page for every other sentence about it, in every section. Compare those sentences with Design, and write the finding when they disagree or repeat.
- Take each Decisions entry, and each Guardrails entry that describes a mechanism of the change, in turn. Search Design for the mechanism it describes, and write the finding when Design does not state it.

## Reference pass

Read the page, the request, and the direction page. This pass checks the page against what it was asked to be.

4. Departures from the direction.
6. Design Rules violations. The page specifies tactical implementation details of the change: config keys, columns, function signatures, file layouts. A reference block that defines what the code has today is not a violation.

## Merge

After the three subagents reply:
- A subagent that replies with an empty message did not finish its pass. Launch it once more. When it replies empty again, name the pass in the summary paragraph as not run.
- Check that each Claim is a quote from the page. Drop a finding whose quote is not on the page.
- Keep one finding when two passes report the same sentence for the same problem.
- Keep each finding as its pass wrote it. Do not add a finding of your own, and do not change a severity.

## Prior findings

In a pass, first check each prior finding you were given. Report it as held, regressed, or not resolved. A regressed or unresolved finding is a finding again in this review.

## Severity

Severity for each finding: `blocking` (a contradiction, a departure from the direction, naming drift, or an Appendix entry that does not match Design), `minor` (repetition, a Design Rules violation), or `nitpick` (word choice a reader would not act on). When the repository has a glossary, report a nitpick only when it is a word the glossary says not to use. Otherwise do not report nitpicks. Every edit can cause a new issue, so report only what changes what a reader would do.

## Findings form

Post the review in the form your review instructions give. Its first line follows the severity of the findings:
- `Review: blocking` when any finding is blocking.
- `Review: findings` when the review has findings and none is blocking.
- `Review: approved` when the review does not have findings.

The summary paragraph gives the count of findings by severity, and the prior findings held, regressed, and not resolved. Then write each finding as one line, in exactly this form:

```
- <section or sections>: Severity: <blocking | minor | nitpick>. Claim: "<exact quote from the page>". Criterion: <which of the checks>. Ground: <the quote from the page, the direction, the request, or the glossary that shows the problem>. Resolve: <the exact change to make, in one to three sentences>.
```

Do not report taste. Do not propose design changes beyond what the direction requires.

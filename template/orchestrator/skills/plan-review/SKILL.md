---
name: plan-review
description: Review an implementation plan against its design. Use this when the task is to review a plan and report what fails.
---

## Objective
Audit an implementation plan against its design and the code. The plan opens with its Milestones and then lists its steps under Plan. A writer who could not see the code wrote it from the design and a research payload. You can see the code. Check the plan against it.

## Review Criteria
- **Apply** the `review-conduct` skill to every finding you file.
- **Verify scope parity**: Ensure the plan implements only what the design specifies, including explicitly requested refactoring.
- **Check every name**: Each file, symbol, table, column, invariant, glossary row, and test a step names exists in the repository with that spelling, or the step says it is new.
- **Check the order**: Each step depends only on steps before it, and each step leaves the code passing its tests.
- **Check the tests**: Each step names the tests it adds or changes and what they assert. A behaviour change with no test is a finding.
- **Check the guardrails**: Each step that touches a guardrail of the design's Appendix says so and keeps it.
- **Evaluate the milestones**: Every step lands in exactly one milestone, each milestone leaves the code operational, and the grouping is right-sized to the design. A single slice verdict is right only when the work is one pull request.
- **Apply simplicity standards**: Audit the changes the steps describe against `simplicity-principles` and the repository's rules file (`CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md`) when it has one.
- **Enforce concise documentation**: Ensure all text conveys load-bearing technical directives without filler.

## Out of Scope
- **Do not permit** scope expansion beyond what the design explicitly mandates.
- **Do not restate** the design document section-by-section.
- **Do not decompose** milestones into issues or pull requests.
- **Do not allow** workarounds that bypass or fight changes specified in the design.

## Output States
- **No findings**: Report zero findings when every criterion holds.
- **Findings**: File one finding for each failing criterion with a concise description of the exact discrepancy or defect.

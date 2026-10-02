---
name: implement-review
description: Review a code change against the issue it resolves. Use this when the task is to review a pull request and report what fails.
---

## Objective
Review a proposed code change against the target issue, repository conventions, and technical correctness standards. Report only failing criteria.

## Prerequisites
- **Apply** the `review-conduct` skill to every finding you file.
- **Read** the linked issue to define the exact scope boundaries.
- **Read** the repository's rules file (`CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md`) to load repository conventions and architectural patterns, when the repository has one.
- **Inspect** the diff and all touched call sites.

## Review Criteria
- **Verify scope alignment**: Confirm the change resolves the issue and nothing more. Permit local refactoring only when directly relevant to the problem.
- **Enforce repository conventions**: Verify strict adherence to code style, structural guidelines, and conventions defined in the rules file.
- **Audit simplicity**: Confirm the implementation is the simplest viable solution without unnecessary complexity or premature abstractions.
- **Validate test coverage**: Ensure tests cover the changed behavior and genuinely fail without the implementation changes.
- **Assess human readability**: Confirm naming, structure, and execution flow are self-evident and easy to maintain.
- **Verify correctness and robustness**: Ensure the code introduces zero logic bugs, unhandled error/failure paths, race conditions, data loss risks, or security vulnerabilities.

## Out of Scope
- **Do not permit** new capabilities, feature creep, or unrelated improvements beyond the targeted issue.
- **Do not flag** subjective stylistic preferences that are not documented in the rules file.
- **Do not lint/build/test** CI runs all checks and the author watches them. NEVER waste time duplicating that effort.

## Output States
- **No findings**: Report zero findings when every criterion holds.
- **Findings**: File one finding for each failing criterion with a concise description of the exact defect, discrepancy, and impacted call site.

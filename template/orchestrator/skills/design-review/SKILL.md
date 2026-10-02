---
name: design-review
description: Review a design document against the request. Use this when the task is to review a design and report what fails.
---

## Objective
Review a system design document against request requirements, architectural boundaries, and simplicity standards. Report only failing criteria.

## Prerequisites
- **Apply** the `review-conduct` skill to every finding you file.
- **Read** the initial request, problem statement, and goals.
- **Read** the design document.
- **Apply** the `simplicity-principles` skill throughout the audit.

## Review Criteria
- **Verify goal alignment**: Confirm the design completely satisfies the request and stated goals.
- **Audit simplicity**: Ensure the approach is the simplest viable architecture. Apply `simplicity-principles` to prevent premature abstractions and verify the current model is updated rather than worked around.
- **Enforce scope boundaries**: Permit localized refactoring strictly relevant to the core problem. Reject any expansion of capabilities or unrequested features.
- **Enforce architectural abstraction**: Verify the design remains high-level and delegates tactical implementation mechanics to later stages.
- **Assess information density**: Confirm the document contains only load-bearing architectural decisions without narrative filler.
- **Audit trade-off documentation**: Ensure "Open Questions" and "Rejected Options" are included only when essential to clarify trade-offs, constraints, or decisions.

## Out of Scope
- **Do not permit** capability growth, feature creep, or speculative architecture.
- **Do not permit** low-level implementation details (database schemas, table/column names, config keys, function signatures, file layouts).
- **Do not permit** speculative or placeholder "Open Questions" and "Rejected Options" that distract from the core design.

## Output States
- **No findings**: Report zero findings when every criterion holds.
- **Findings**: File one finding for each failing criterion with a concise description of the exact architectural discrepancy, over-specification, or defect.

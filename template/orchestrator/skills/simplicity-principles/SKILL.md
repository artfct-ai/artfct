---
name: simplicity-principles
description: Principles this codebase uses to judge an approach. Use this when you weigh whether a design, plan, or change abstracts and models the problem well.
---

## Objective
Evaluate proposed designs, plans, and code changes against codebase simplicity and abstraction standards.

## Evaluation Criteria
- **Isolate** external dependencies from core business logic using minimal, targeted abstractions.
- **Update** the underlying domain model directly when doing so provides a cleaner solution than working around it.
- **Prioritize** disposable, easily deletable code over premature extensibility.
- **Tolerate** localized duplication over speculative or unproven abstractions.

## Out of Scope
- **Do not introduce** early abstractions to enforce DRY patterns or support hypothetical future consumers.
- **Do not build** architectural workarounds that fight or bypass the existing domain design.
- **Do not couple** external dependencies, frameworks, or transport layers directly into domain logic.

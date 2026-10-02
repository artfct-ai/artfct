---
name: code-cleaner
description: Make code easy for a human to read without changing what it does. Use this when the task is to polish names, JSDoc, and comments in a change.
---

## Objective
Refactor code to maximize human readability and cognitive clarity while strictly preserving existing behavior.

## Core Constraint
- **Preserve** runtime behavior, execution paths, and semantics without modification.

## Review & Refactoring Rules

### JSDoc Standards
- **Document** complex functions with concise, single-purpose JSDoc blocks.
- **State** strictly what the function does.
- **Trim** all JSDoc blocks to remove redundancy and fluff.

### Inline Comments
- **Restrict** inline comments to critical, non-obvious logic that clean code cannot convey.
- **Cap** necessary inline comments at one to two lines.
- **Delete** comments that narrate readable code, describe trivial operations, or recount some 'why' that likely lives in a pull request or design doc.

### Identifier Naming
- **Name** variables, functions, classes, and types so their intent and operation are self-evident in isolation.
- **Ensure** no identifier requires the reader to inspect its declaration site or parent module context to understand its purpose.

## Out of Scope
- **Do not alter** runtime behavior, functional logic, or public contracts.
- **Do not restate** types, compiler-enforced constraints, or signatures inside JSDocs.
- **Do not record** commit histories, authorship, or architectural decision logs in comments.

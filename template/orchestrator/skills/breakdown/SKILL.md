---
name: breakdown
description: Split an accepted plan into tracker issues. Use this when the task is to file one issue per pull request of work.
---

## Objective
Decompose an accepted implementation plan into deliverable, pull-request-sized tracker issues.

## Prerequisites
- **Apply** the `working-with-findings` skill to every finding a review leaves on your artifact.
- **Read** the accepted plan in full before splitting tasks.
- **Inspect** all codebase areas touched by the plan to verify scope and boundaries.

## Issue Decomposition Rules
- **Break** milestones into granular chunks that map directly to single, reasonably sized pull requests.
- **Create** exactly one tracker issue per decomposed chunk.
- **Ensure** every issue is independently deliverable and preserves a working codebase state at completion.
- **Define** issues by intended outcome rather than prescribed implementation mechanics.
- **Map** tracker relationships to explicitly show blocking and dependent dependencies.
- **Link** every issue directly to the source plan.

## Out of Scope
- **Exclude** work, extensions, or refactors not explicitly requested in the plan.
- **Omit** implementation recipes, granular mechanics, or tactical code instructions.
- **Omit** test or verification steps covered by repository guidelines.

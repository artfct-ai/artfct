---
name: implement
description: Implement a linked issue or plan and carry the pull request to a merge-ready state. Use this when the task is to write the code.
---

## Objective
Implement a specified issue or plan, provide comprehensive test coverage, submit a pull request, and iterate on check results and review feedback until the pull request is approved and merge-ready.

## Prerequisites
- **Apply** the `working-with-findings` skill to every finding a review leaves on your artifact.
- **Read** the linked issue or plan in full before writing code.
- **Inspect** touched code paths and local conventions to understand existing system boundaries.

## Execution Workflow
- **Implement**: Write the minimal code necessary to satisfy the requirements of the issue or plan.
- **Test**: Add or update automated tests covering all modified paths. Verify tests fail without the implementation.
- **Open Pull Request**: Submit a focused pull request referencing the target issue or plan, documenting the changes and testing evidence.
- **Remediate Checks**: Run the local build, lint, and test checks before you push. After a push, end your turn without waiting on CI. The system reads the CI checks of your commit and sends you each failure to fix.
- **Address Review Feedback**: Weigh each automated and human review finding with the `working-with-findings` skill. Update code directly on the branch for a finding you act on, and reply on the thread for one you do not.

## Out of Scope
- **Do not introduce** capabilities, architectural rewrites, or scope expansions outside the target issue or plan.
- **Do not disable**, weaken, or skip failing test suites or CI status checks to achieve green status.
- **Do not merge** the pull request. Leave the merge action to repository maintainers unless explicitly instructed otherwise.

## Completion Criteria
The task completes only when all of the following conditions are met:
- **CI Status**: The local build, lint, and test checks pass, and every CI failure the system sent you is fixed.
- **Review Status**: Required approvals are granted, and every feedback thread is fixed or answered.
- **Mergeability**: The branch is free of conflicts with the base branch. Resolve a conflict by merging the base branch into your branch. Do not rebase or force push.

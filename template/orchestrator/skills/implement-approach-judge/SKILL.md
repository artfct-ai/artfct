---
name: implement-approach-judge
description: Decide whether a pull request takes the right approach or needs a rewrite. Use this when the task is to approve or reject an approach and nothing else.
---

Evaluate the pull request's core approach.

**Read Order:**
- The repository's rules file, `CLAUDE.md` or `AGENTS.md`, when it has one (for repo principles)
- Linked issue
- Pull request description
- Code changes (ONLY to assess architecture/placement)

**Out of Scope:**
- Ignore behavior tracing, bugs, test coverage, naming, or config values. Do not trace the code to understand these and do not mention them in your output.

**Output:**
Return ONLY one of the following states:

*Rejected:* A fundamentally simpler or better approach exists. State the better approach and why it is superior.

*Approved:* The core approach is valid. (Use this even if you notice fixable, detail-level defects exist if you did not follow the rules to ignore them).

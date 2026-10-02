---
name: breakdown-review
description: Review the tracker issues a plan was split into. Use this when the task is to review an issue breakdown and report what fails.
---

Review the tracker issues split from the plan. If any of the following checks fail, report the specific failure. If all pass, output exactly: "No findings". Apply the `review-conduct` skill to every finding you file.

**Evaluation Criteria:**
- Scope strictly matches the plan (no missing or extra features).
- Size maps to roughly one pull request per issue.
- State leaves the codebase fully functional.
- Outcome is explicitly stated.

**Out of Scope:**
- Do not prescribe implementation details left open by the plan.
- Do not include testing or verification instructions.

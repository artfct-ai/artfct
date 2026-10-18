# artfct

An orchestrator agent that runs a control loop for software development agents on Cloudflare Workers. Engineers reach it through chat (Slack), a tracker (Linear), a code host (GitHub), and documents (Notion). It splits a request into stages, by default design, ticket breakdown, and pull requests. A coding agent in a sandbox runs each stage as a job of tasks over [ACP](https://agentcommunicationprotocol.dev/). Engineers give feedback at each step.

## Infrastructure

- Prefer usage-based Cloudflare Workers services. Use Cloudflare's official skills and MCPs.
- Route models directly to OpenRouter by default. Workers AI and the AI Gateway are too slow today.

## Tools and commands

- The type-aware lint is the type gate. Do not run `tsc`.
- `scripts/test-near <file-or-dir>...` runs nearby tests in seconds. Use it while you work.
- `bun run check` runs the CI checks. `bun run fmt` formats. `bun run smoke` must print `SMOKE PASSED`.
- `wrangler types` generates each app's `worker-configuration.d.ts`. Never add `@cloudflare/workers-types` to an app.
- The decisions model is a System One model. It returns probabilities for yes-or-no and choice questions and does not generate text. Each gateway picks its own, such as TypeSafe's Jev or Cloudflare's Clef.
- Write a decisions question against the `Decisions` interface. Load the `typesafe:typesafe-ai` skill before you write or change one.

## Boundaries

- Lint and the `scripts/entrypoints` test enforce the import boundaries.
- Import a large vendor SDK lazily in the first method that needs it, and cache the promise. Every medium test boots the Worker, so the import graph sets its speed.
- `@artfct-ai/contracts` is the contract between ingress and the orchestrator. It holds only plain types. Each app owns its schemas and helpers. A contract field needs a reader in the other app.
- Ingress and the orchestrator name capabilities: `code`, `tracker`, `chat`, `documents`. A vendor's URL shapes, id formats, header names, signing schemes, and payload types go in its directory under its capability, such as `chat/slack/`.
- Ingress never touches storage. It calls the orchestrator through the service binding typed by `OrchestratorRpc`. An ingress route verifies the webhook with the vendor adapter's function, maps the payload with the vendor's mapper, and delivers one `InboundEvent`.
- `packages/adapters`:
  - `types.ts` holds one interface per capability. Each vendor gets a directory under its capability.
  - The vendor directory holds the implementation on the vendor's official SDK, in a file named after its interface. It also holds the vendor's pure functions: the inbound mapper, signature verification, and URL readers and writers.
  - When two adapters need the same vendor code, each keeps its own copy.
  - Make a pure parse a function, not an interface method, so a caller without a credential can use it.
  - Never hand-roll an API client when an SDK exists. Every SDK gets its fetch through `workerdFetch`.
  - Each adapter has a workerd test that validates its requests.
- Skills:
  - Harness prompts are skills in `template/orchestrator/skills/`.
  - `SKILL.md` frontmatter uses only [Agent Skills standard](https://agentskills.io/specification) keys. The structure of the work, such as its sections, their order, and other skills to apply, goes in the instructions. The orchestrator never reads it from frontmatter.
  - A harness session gets every skill, so a skill applies another by naming it. A model call reads only its own skill and its activity's `preload_skills`.
- A workflow definition in `orchestrator/workflows/<name>.yaml` may define any stages, with any names, in any order. Code, schemas, prompts, and tests never assume today's stages. What belongs to a kind of work, such as a document's sections and which comes first, lives in that work's skill, not in the stage.
- Each database belongs to one package, through Drizzle. Do not write raw SQL in packages. `bun run db:generate` writes the migrations. Never hand-edit one.
- Durable Object logic lives in `packages/orchestrator/src/workflow/*` and `packages/orchestrator/src/agent/*` as functions over `WorkflowRuntime`. The `Workflow` class only wires them.
- Do not build anything in Docker. `SANDBOX_VERSION` in the sandbox `Dockerfile` equals the orchestrator's `@cloudflare/sandbox` version.
- `packages/orchestrator/sandbox/NOTICES.md` lists each prebuilt program the `Dockerfile` copies or downloads, with its license text. Update it when that list changes.

## Dependencies

- Use the current stable release of every package. Before you add or bump one, run `npm view <pkg> version deprecated` and check the vendor docs for renames. Never use a deprecated package.
- Pin with caret ranges. Run `bun install` after you edit any `package.json`.

## Code vs agent

- Code, data, and architecture cost upkeep. Agent tokens cost money. Weigh both for each case. Often the answer is a little processing up front, with the bulk deferred to the agent.

## Complexity

Judge a change by the complexity it leaves behind, not by its size. An interface method, a vendor implementation, a fake, and a workerd test can be the clear change. A change that deletes as much as it adds is welcome.

- Fix the representation. When code models the problem wrong, change the model, even when that touches more code. Do not build a workaround on it.
- Refactor the code you touch. Do not copy a pattern because it exists. Do not add a layer to avoid changing code that should change.
- Add state only when something reads it today. Do not persist, cache, or copy an unread value. Store each fact once, or derive it.
- Add a guard only for an input or state that occurs, and name the wrong outcome it prevents.
- Add a config key, mode, flag, or option only for a use today. One place sets a value and one place reads it.
- A helper needs two callers today, or a name that lets a reader skip its body. Keep callers loosely coupled. Do not add a flag, mode, or fallback to serve different callers. Split it instead. Inline a helper that fails these tests.
- Do not wrap one field access or one method call in a function. Call `workflow.store.activeTasks()` directly.
- Put a method on an interface only when a consumer outside the package calls it. A method that only the vendor implementations call stays on the class, off the interface and the fake.

## Representation

- Pass fields as fields, such as `{ repo, number }`, not a URL or a key string. One encoder derives a string key where the row is written. Never parse a key back into fields.
- Normalize a vendor value, such as a page id or a login, once in the adapter mapper or the ingress route. Downstream code trusts it.
- Do not use sentinel values. Give a case with a different shape its own union arm. Never fill a field with `0` or `""` to satisfy a type.
- Each path, key, or id format has one module that both writes and reads it.

## Stored state

Run a model check when a change adds or changes stored state: a column, the shape of a JSON column, or a field of a spec's state.

1. Read the whole table, the tables it references or that reference it, and the code that writes them. For a spec, read its whole state.
2. List what the state carries today: the entity each table holds, the states it moves through, and the columns that record each state.
3. Describe the model the change needs: the entity, its states, and where each fact belongs.
4. Compare the two. When they differ, refactor the existing state to match the needed model. A new column is right only when the existing model already matches.
5. Put the list, the needed model, and the decision in the PR body under "Model check".

Judge the model by these rules:
- A table holds one entity. Every column applies to every row. A fact about only some rows goes in its own table, keyed by the row it describes.
- A lifecycle is one status column with named values, not a boolean per stage.
- Store each fact once. Do not store what you can derive.
- A JSON column holds data that is read and written whole. Code does not branch on it or query into it.
- On SQLite a column change rebuilds the table, so a schema change is worth it only when the model needs it.

## Domain spec

- Specify every change before you build it. The spec is the glossary and the invariants.
- Propose both with the design, before you write code and before the owner asks. Wait for the owner's answer. A spec that changes in review can force a rewrite.
- A subagent returns its proposal and stops.
- After approval, the PR carries the spec in its diff next to its code. A change without its spec is not done.

### Glossary

- `spec/glossary.md` is the authority on domain terms. Use its terms in identifiers, JSDoc, prompts, logs, and documents. Never use a word from its `Do not say` column for that concept.
- Propose a row with the design for each new concept, changed meaning, renamed term, or removed term. Add the approved row in the same change as the code.
- Only the repository owner changes the glossary. The PR lists each approved glossary change in its description.
- Never edit the glossary to match code that drifted. When the code and the glossary disagree, stop and ask.

### Invariants

- Every behavior a person sees or the system relies on has an invariant. When a change adds or alters one, propose its invariants with the design. After approval, add each one with its property test in the same change.
- Every invariant has a property test on random sequences. A new invariant ships with generator actions that reach it, including failures, hangs, restarts, and concurrent events. An invariant that no sequence reaches is not tested.
- When a change would let an invariant pass without testing anything, such as a new post that satisfies a reply check, propose the tightened invariant with the design.
- Workflow invariants live in `packages/orchestrator/test/invariants.ts`. `packages/orchestrator/src/workflow/invariants.test.ts` checks them after every action.
- Agent turn invariants live in the Quint spec in `spec/agent-turns/`. Its replay, `packages/orchestrator/test/agent-turns-replay.ts`, runs the code on the spec's traces.
- Code outside the workflow and the agent turn, such as the router or ingress, follows the same rule. Add a missing property test in the same change.
- Only the repository owner adds, changes, or removes an invariant. The PR lists each approved invariant and its property test in its description.
- When a property test fails, never weaken an invariant, an action, or a generator. Stop and report the shrunk sequence and the seed.

### Behavior map

- `spec/behavior-map.md` lists each effect a person sees or the system relies on, and the invariants that guard it.
- A change that adds or alters an effect edits its row in the same change. A proposed invariant names the row it guards. The design includes new rows.
- A row's guard list changes only with an approved invariant.
- The PR lists map edits under "Spec in this diff (approved by merging)".

### Quint specs

- A folder under `spec/` holds one Quint spec, one file per setup, and `checks.json`. Only `packages/orchestrator/scripts/spec/check-spec.ts` reads `checks.json`. CI calls it for every setup, so a new spec needs no workflow change.
- Write every rule as a state invariant, so simulation and TLC both check it.
- Give each list or number that grows a counter val. Cap it per setup under `tlc.bounds` in `checks.json`, at `pr` and `nightly` depth. Main runs TLC at the `pr` bounds. Keep each main quint job shorter than the main spec replay job. Record each setup's minutes on main under `mainMinutes` in `checks.json`. The main quint shards balance on them.
- Remove a call from the state once it returns. A restart drops every call that is out.
- Write a before-and-after rule as a pure def over one step: the state before, the state after, and the kind of step. Each step records whether it kept each rule in a record variable, and the invariant reads that field. Do not store the state before the step.
- Record a witness that needs the step in its own record variable, and list that variable under `tlc.ignoredVariables`.
- Do not range over a length that depends on the state, such as the jobs so far. Range over the constant cap and filter, so Apalache can translate the spec.
- Run quint locally through the check-spec script, at small sample counts.
- Run at most two heavy processes at a time, such as quint, TLC, a replay, or a property test.

## Code style

- Prefer the plainest conventional solution. Check for a standard convention before you build a script, generator, or abstraction.
- Do not use single-letter or cryptic identifiers, including loop and callback parameters.
- A name reads at the call site without opening its module, such as `settleReviewForAuthor`, not `settle`. An export from a protocol or vendor module carries that prefix, such as `jsonRpcRequest` or `linearAuthorizeUrl`.
- Never group functions into a namespace object. Name each function fully and import it directly.
- Rename only when the current name fails at a call site.
- Do not suppress lint. When a rule misfires and cannot be satisfied, add a one-line suppression with a one-line comment that says why the rule is wrong here.
- Avoid inline comments. Write one only to say what the code cannot, such as a check that looks redundant but guards an interleaving.
- A directory holds one concept. A vendor gets a directory under its capability. A file holds one concern. Shared types go in one `types.ts` per directory.
- Extract pure functions and test them. Return early. Use discriminated unions with exhaustive switches. Use an options object in place of more than three positional parameters.
- Give every exported symbol a JSDoc of one to three short lines that says what it is for. Do not restate the types or narrate the design, the history, or the alternatives.
- Do not write comments inside function bodies or in test files, JSDoc included. Rationale goes in the PR description.
- Write prose in plain technical English, in short sentences. Do not use semicolons or em dashes.
- Tests:
  - Write a small test (`*.test.ts`) unless the code needs a Durable Object, D1, or `cloudflare:workers`. Then write a medium test (`*.test.medium.ts`).
  - Test logic over `WorkflowRuntime` with `freshRuntime` and `freshStore`, which do not need a Durable Object.
  - Test helpers live in `<package>/test/`, never in `src/`. A fake, mock, or scripted stand-in that only tests, smoke, or `bun run dev` use is a test helper, even when a Worker entry wires it in.
  - Production code never checks for a mock mode or a mock name.
  - Build fully typed fixtures.

## Done means

- A change carries its spec: the glossary rows for its concepts and the invariants for its behavior, with their property tests.
- While you work, run `scripts/test-near` on the files you change. Before you push, `bun run lint` passes with zero warnings and the nearby tests pass.
- Push early and open a draft PR. Do not stop at a local commit, and do not ask first.
- Do not repeat CI runs locally. CI runs these:
  - Pull request: `bun run check` then smoke in one job, and a light quint run in 3 shards when spec or workflow code changes.
  - Main: full quint with TLC at the `pr` bounds, the spec replays, and the properties at reduced counts.
  - Nightly: deep quint, the full property counts, and the mutants. To bisect a failure, start the nightly workflow by hand with a commit.
- CI does not run on a fork's PR until a maintainer approves it. A fork runs `bun run check` and `bun run smoke` locally before it pushes.
- Run `gh pr checks <number> --watch --fail-fast`. Fix what fails and push until every check is green.
- Never leave a lint warning or a failing test because it was already there. Fix it in the same change and mention the fix in one line.
- The PR description states the reason for each part of the change.
- When a stacked PR's base merges, run `git rebase --onto origin/main <old-base-tip> <branch>`, push with `--force-with-lease`, and retarget with `gh pr edit <number> --base main`.

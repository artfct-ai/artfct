# artfct

A control loop for software development agents conducted by an orchestrator agent. Runs on cloudflare workers platform. Engineers can engage the orchestrator through a chat app (such as slack), a work tracker (linear), SCM (github), and documents (notion). It splits a request into stages. By default: design, ticket breakdown, and pull requests. A coding agent in a sandbox executes each stage as a job of tasks over [ACP](https://agentcommunicationprotocol.dev/). Engineers give feedback at each step. 

## Infrastructure

The ideal state is to use usage based services on the cloudflare workers platform for simplicity and minimal overhead. Cloudflare's official plugin of skills and MCPs is available, use it. 

### Exceptions

Both Workers AI hosted models and the AI Gateway have latency issues today, so by default we route directly to OpenRouter instead.

## Tools and commands

- bun workspaces, turborepo, TypeScript 7, oxlint/oxfmt. Small tests run under `bun test`. Medium tests run under vitest with `@cloudflare/vitest-plugin`, because they need workerd.
- `deploy` depends on `bun run check`. The lint is type aware and is the type gate. Nothing in CI runs `tsc`.
- `scripts/test-near <file-or-dir>...` runs the tests next to a file or under a directory in seconds. Use it for every change. CI runs everything else.
- `bun run fmt` formats. `bun run smoke` runs the end-to-end mock flow and must print `SMOKE PASSED`.
- `wrangler types` generates `worker-configuration.d.ts` per app. Never add `@cloudflare/workers-types` to an app.
- The decisions model is a System One model. It answers yes-or-no and choice questions with probabilities and does not generate text. Each gateway picks its own, such as TypeSafe's Jev or Cloudflare's Clef. Write a decisions question against the `Decisions` interface, not against one vendor's model. Load the `typesafe:typesafe-ai` skill before you write or change a decisions question.

## Boundaries

- Import the module that defines a symbol, for example `@artfct-ai/contracts/sources`. No barrel files. `index.ts` exists only as a Worker entrypoint. Use `import type` for types. Import a large vendor SDK lazily inside the first method that needs it, and cache the promise. Every medium test boots the Worker entrypoint, so a large import graph makes every medium test slow.
- ACP protocol types come from `@agentclientprotocol/sdk`. Do not hand-write them.
- `@artfct-ai/contracts` is the contract between ingress and the orchestrator. It holds plain types and nothing else. No functions, no zod, no helpers. Each app owns its own schemas and helpers. A contract field needs a reader in the other app.
- Ingress and the orchestrator name capabilities: `code`, `tracker`, `chat`, `docs`. A vendor name appears only under `packages/adapters` and in a `clients.ts`. A vendor URL shape, id format, header name, signing scheme, or payload type belongs in the vendor's directory under its capability, such as `chat/slack/`.
- Ingress never imports the orchestrator and never touches storage. It calls the orchestrator through the service binding typed by `OrchestratorRpc`. An ingress route is the vendor edge. It verifies the webhook through the vendor's adapter function, maps the payload through the vendor's adapter mapper, and delivers one `InboundEvent`.
- `packages/adapters` holds one interface per capability in `types.ts` and one directory per vendor under each capability. The vendor directory holds the implementation on the vendor's official SDK, in a file named after the interface it implements, and the vendor's pure functions: the inbound mapper, signature verification, and URL readers and writers. A vendor directory never imports from another vendor directory. When two adapters need the same vendor code, each keeps its own copy. Duplication is cheaper than the wrong abstraction. A pure parse is a function, not an interface method, so a caller without a credential can use it. Never hand-roll an API client when an SDK exists. Consumers import the interface. Only `clients.ts` files construct implementations. Every SDK gets its fetch through `workerdFetch`. Each adapter has a workerd test that validates its requests.
- Harness prompts are defined as skills within `template/orchestrator/skills/<skill-name>/`, requiring a `SKILL.md` file. Individual harness adapters manage their own installation paths and execution logic.
- A `SKILL.md` uses only the frontmatter keys of the [Agent Skills standard](https://agentskills.io/specification), so the skill works in any harness. How the work is structured, such as its sections, their order, and other skills to apply, goes in the skill's instructions. The orchestrator never reads it from frontmatter.
- A harness session gets every skill, so a skill applies another by naming it in its instructions. A model call reads only its own skill and the skills its activity lists in `preload_skills`.
- A workflow is arbitrary. A workflow definition in `orchestrator/workflows/<name>.yaml` may define any stages, with any names, in any order. Code, schemas, prompts, and tests never assume today's stages. What belongs to a kind of work, such as the sections of a document and the one that comes first, lives in that work's skill, not in the stage.
- A database belongs to exactly one package, through Drizzle. No raw SQL in packages. `bun run db:generate` writes the migrations. Never hand-edit one.
- Durable Object logic lives in `packages/orchestrator/src/workflow/*` and `packages/orchestrator/src/agent/*` as functions over the `WorkflowRuntime` interface. The `Workflow` class only wires them.
- Nothing is built in Docker. `SANDBOX_VERSION` in the sandbox `Dockerfile` must equal the `@cloudflare/sandbox` version in the orchestrator. `packages/orchestrator/sandbox/NOTICES.md` lists each prebuilt program the `Dockerfile` puts in the image, whether copied or downloaded, with its license text. Update it when the `Dockerfile` adds or removes such a program.

## Dependencies

Use the current stable release of every package. Before you add or bump one, run `npm view <pkg> version deprecated` and check the vendor docs for renames. A deprecated package is never allowed. Pin with caret ranges. Run `bun install` after you edit any `package.json`.

## Code vs agent

Code, data, and architecture accrual is expensive. Tokens to run an agent are also expensive. Weigh which is cheaper for the case at hand. Often the answer is a little processing up front, with the bulk of the work deferred to the agent.

## Complexity

Judge a change by the complexity it leaves behind. Do not judge it by its size. A clear change may add an interface method, a vendor implementation, a fake, and a workerd request test. A change that deletes as much as it adds is welcome.

- Fix the representation. When a change is awkward because the code models the problem wrong, change the model. Do this even when it touches more code. A workaround on a wrong model is worse than the refactor that removes it.
- Refactor the code you touch. Do not follow an existing pattern because it is there. Do not add a layer to avoid contending with code that should change.
- Add no state without a reader today. Do not persist, cache, or copy a value that nothing reads yet. Never keep two copies of one fact in sync by hand. Store it once, or derive it.
- Add no guard without a named input. A check needs an input or a state that occurs, and a wrong outcome it prevents. A guard for a case that cannot happen costs tests and handling in adjacent code for nothing.
- Add no config key, mode, or option without a use today. Do not add a key, a flag, or an override for a need that may never come. One place sets a value and one place reads it.
- A schema change needs a reason in the PR. On SQLite a column change rebuilds the table.
- Helpers provide value 3 ways. Two callers today, or a name that lets a reader skip the body. No flag, mode, or fallback to serve different callers. Split it instead. Callers stay loosely coupled. Inline a helper that fails the second or third test.
- Do not wrap one field access or one method call in a function. `workflow.store.activeTasks()` is the call. A wrapper around it is indirection.
- An interface method needs a consumer outside the package. A method only the vendor implementations call stays on the class and off the interface and the fake.

## Representation

- Fields travel as fields. Carry `{ repo, number }`, not a URL and not a key string. A string key is derived once, where the row is written, by one encoder. Nothing parses a key back into fields.
- Normalize once, at the edge. The adapter mapper or the ingress route normalizes a vendor value such as a page id or a login. Downstream code trusts it and does not normalize again.
- No sentinel values. When one case has a different shape, give it its own union arm. Never fill a field with `0` or `""` to satisfy a type.
- One format has one writer and one reader. A path, key, or id format lives in one module that both writes and reads it.

## Domain spec

- `spec/glossary.md` is the authority on domain terms. Use its terms in identifiers, JSDoc, prompts, logs, and documents. Never use a word from its `Do not say` column for that concept.
- Only the repository owner changes the glossary. Edit it only when the owner asked for that change or approved it beforehand. Otherwise stop and ask for approval before you edit it. This holds for a new row, a changed meaning, a renamed term, and a removed row.
- A new domain concept needs a glossary row. Propose the term and its meaning, get approval, then add the row in the same change as the code.
- Never edit the glossary to match code that drifted. When the code and the glossary disagree, stop and ask.
- `packages/orchestrator/test/invariants.ts` holds the workflow invariants. Each one is a rule the workflow must keep after every action. `packages/orchestrator/src/workflow/invariants.test.ts` checks them on random action sequences.
- `packages/orchestrator/test/agent-invariants.ts` holds the agent turn invariants. Each one is a rule the orchestrator agent must keep after every turn. `packages/orchestrator/src/agent/turn/turn-invariants.test.medium.ts` checks them on random turn sequences.
- Only the repository owner adds, changes, or removes an invariant. Edit one only when the owner asked for that change or approved it beforehand.
- When the property test fails, never weaken an invariant, an action, or a generator to make it pass. Stop and report the shrunk sequence and the seed.

## Code style

- Prefer the plainest conventional solution. Before you build a script, generator, or abstraction, check whether a standard convention does the job.
- No single-letter or cryptic identifiers, including loop and callback parameters. Use short clear names such as `request`, `payload`, `event`, and `index`.
- A name reads at the call site without opening its module. `settleReviewForAuthor`, not `settle`. `markArtifactReady`, not `markReady`. An export from a protocol or vendor module carries that prefix, for example `jsonRpcRequest` and `linearAuthorizeUrl`.
- Never group functions into a namespace object to shorten their names. It bloats the import graph and defeats tree shaking. Name the function fully and import it directly.
- Rename only when the current name fails at a call site. Do not rename to add words.
- No lint suppressions. When a rule misfires and cannot be satisfied, the one-line suppression gets a one-line comment that says why the rule is wrong here. That is the only expected inline comment. Any other inline comment must say something the code cannot, such as a check that looks redundant but guards an interleaving.
- Group files by concept. A directory holds one concept. A vendor gets a directory under its capability.
- Keep one concern per file. Put shared types in `types.ts`, one per directory. Extract pure functions and test them. Return early. Use discriminated unions with exhaustive switches. Use an options object in place of more than three positional parameters.
- Every exported symbol gets a JSDoc of one to three short lines that says what it is for. It does not restate the types. It does not narrate the design, the history, or the alternatives. No comments inside function bodies. No comments in test files, JSDoc included. Rationale goes in the PR description. Name variables and functions so the code says what it does. Write prose in plain technical English. Use short sentences. Do not use semicolons or em dashes.
- Tests are colocated. Small tests are `*.test.ts` on `bun:test`. Medium tests are `*.test.medium.ts` on vitest, only for code that needs a Durable Object, D1, or a module that imports `cloudflare:workers`. Write a small test unless the code cannot load outside workerd. The workflow store runs on `bun:sqlite` in memory through `freshRuntime` and `freshStore`, so a test of logic over `WorkflowRuntime` needs no Durable Object. Test helpers live in `<package>/test/`, never in `src/`. A fake, mock, or scripted stand-in that only tests, the smoke run, or `bun run dev` use is a test helper, even when a Worker entry wires it in. Production code never checks for a mock mode or a mock name. The test Worker entries in `packages/orchestrator/test/` swap the fakes in through `WorkflowServices`. Build fully typed fixtures. Never cast with `as unknown as`.

## Done means

Never run `bun run check`, `bun run test`, or a full package test suite yourself. They take minutes, and CI runs them. Run `scripts/test-near` on the files you changed, `bun run lint`, and `bun run fmt` until they pass with zero errors and zero warnings. `bun run smoke` passes. `CONTRIBUTING.md` reflects a development setup change, and `docs` reflects a change a deployer sees. Do not add either to `README.md`. Push the branch and open a draft PR. Then run `gh pr checks <number> --watch --fail-fast`, fix what fails, and push again until every check is green. Do not stop at a local commit, and do not ask first. Never leave a lint warning or a failing test because it was already there. Fix it in the same change and mention the fix in one line.

The PR description states the reason for each part of the change. That is where rationale lives. When a stacked PR's base merges, replay the branch with `git rebase --onto origin/main <old-base-tip> <branch>`, push with `--force-with-lease`, and retarget with `gh pr edit <number> --base main`.

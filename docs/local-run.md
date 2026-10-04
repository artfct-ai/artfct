# Local run

A local run starts one author, reviewer, or polisher of the template's workflow definition in a Docker container on your machine. It does not start a workflow. Use it to try a change to a skill or a prompt in a clone of the artfct repository.

A local run uses the production skills, prompts, and harness setup. It changes the real artifact unless you pass `--dry-run`.

## Before the first run

Fill in `packages/orchestrator/.dev.vars`, start Docker, and build the sandbox image:

```sh
bun run sandbox:build
```

## Run

```sh
bun run local-run <stage> <role> [artifact-link] --title "..."
```

| Argument | Meaning |
|---|---|
| `<stage>` | A stage of the template's workflow definition. |
| `<role>` | `author`, or the name of a reviewer or a polisher of the stage. |
| `[artifact-link]` | The artifact the run works on. |

| Option | Meaning |
|---|---|
| `--title` | The title of the work. |
| `--request` | The request text. |
| `--brief` | The brief of the author. |
| `--repo owner/name` and `--branch name` | The checkout the stage works in. |
| `--dry-run` | Print the first prompt and stop. |

## Output

Each run writes its first prompt, its session updates, and its closing text under `.local-runs/`.

## Details

- **Secrets.** The run reads them from `packages/orchestrator/.dev.vars`. It connects to the MCP servers of the template's `artfct.yaml` with the same secrets.
- **Linear pages.** The run changes a Linear page as the owner of `LINEAR_API_KEY`. The install token of a deployment lives only in its database.
- **Model-call authors.** The author of a stage whose `author.produce` has `execution: model` runs its produce call on its gateway, and the call writes the whole page. With `--dry-run` it prints the system message, writes the document to `document.md` in the output directory, and does not create a page.

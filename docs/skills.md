# Skills

A skill holds the instructions an agent follows for one job, such as writing a design or reviewing a plan. The template ships a default set. Change them or add your own in your deployment repo.

## Layout

Each skill is a directory under `orchestrator/skills/`. The directory holds a `SKILL.md` file and any reference files or scripts the skill uses.

```
orchestrator/skills/
  design/
    SKILL.md
  design-review/
    SKILL.md
```

`SKILL.md` starts with frontmatter that follows the [Agent Skills standard](https://agentskills.io/specification). Its `name` must match the directory name.

```md
---
name: design-review
description: Review a design page. Use this when the task is to review a design and report what fails.
---
```

## Use a skill in a stage

The workflow definition under `orchestrator/workflows/` names a skill by its directory name. An author, a research step, a reviewer, and a polisher each take a `skill` key.

## File rules

The deploy build bundles every file under `orchestrator/skills/`. `npx artfct check` applies the same rules before a deploy.

| Rule | Reason |
|---|---|
| Every file sits inside a skill directory. | The build rejects a file directly under `skills`. |
| Every file is UTF-8 text. | A binary file, such as an image or a PDF, fails the build. |
| Call a bundled script through its interpreter, for example `python scripts/fill_form.py`. | A bundled script loses its executable bit. |

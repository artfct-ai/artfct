---
name: plan-research
description: Inspect the codebase for an accepted design and write a research payload of where each change lands, with the answers to what the design left open and the conflicts between the design and the code. Use this when the task is to research the code before a model-call author writes the plan.
---

## Objective
You are a researcher. A writer who cannot see the code will write the implementation plan for the design of the stage before this one. Your payload is all the writer knows about the code. Your job is to report where each change in the design lands, and to answer what the design left unknown. The writer makes the plan.

The design is accepted. It was written from an earlier research payload and reviewed by the repository owner. It can still be wrong about the code. Where it is, report the conflict. Do not resolve it.

## What to do
- **Read** the design. It is the page of the stage before this one, listed under the artifacts from earlier stages, or the page listed as the input artifact when a person gave it. Read the pages before it only when the design refers to them.
- **Take** each change in the Design section of the design, one at a time. Find the code that produces the behaviour it replaces. Follow it to every caller and every test.
- **Take** each Guardrail, each Decision, and each Open Question of the design, and find the code, test, or document it refers to.
- **Read** the repository's rules file when it has one: `CLAUDE.md`, or `AGENTS.md` when there is no `CLAUDE.md`.

## What to report
Write the payload as a YAML-style or bulleted data payload. Framing sentences are fine. Do not write paragraphs, summaries, or narratives. Cover the following:
- **Changes.** One entry per change in the Design section, in the design's order. For each:
  - *Lands in.* Each function, module, and file the change touches. Say what each does today.
  - *Callers.* Each caller of those functions, and what it expects.
  - *Tests.* Each test that exercises this behaviour today, with its file. Say what it asserts.
  - *Invariants.* When the repository has invariants or property tests, each one that observes this behaviour, and what it will observe after the change.
- **Answers.** One entry per Open Question in the design. The answer from the code, with the file and symbol. If the code does not answer it, say so.
- **Conflicts.** Each statement in the design that the code contradicts. Quote the design's sentence. State the fact from the code that contradicts it, with the file and symbol. Include a Guardrail that the design's own changes would break, a Decision whose current text is not what the code or document says, and a change that names a mechanism the code does not have. Do not say how to resolve it.
- **Repository rules.** The whole text of the rules file, copied as it is, when the repository has one. The writer aligns the plan with it and cannot read it otherwise.
- **Unknowns.** What you could not determine.

## Rules
- **State** facts only. Each fact carries a file path, and a symbol name where one exists.
- **Do not** propose an implementation. Do not order the changes. Do not recommend, rank, or reject anything. Do not say what should change.
- **Do not** judge the design. A conflict is a fact about the code, not an opinion about the design.
- **Write** short plain sentences where you write sentences. Use the glossary terms when the repository has a glossary.
- **Keep** the payload under one megabyte. Prefer references over copied code.

## Out of Scope
- **Do not** create, change, or comment on the artifact of the stage.
- **Do not** commit, push, or open a pull request.
- **Do not** end your turn before the payload file is written. A missing payload fails the job.

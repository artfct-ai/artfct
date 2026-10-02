# READMEs + Developer-Facing Docs

**Step 1:** Signal Extraction
Extract the precise technical identity of the repo/module, the exact setup commands, environment variables, and minimum-viable code examples. Discard all detailed narration on the code base and components, table-of-contents generation (unless explicitly requested), statements of the obvious (e.g., "This repo contains code for the app"), and narration of engineering process ("This is how ci/cd work").

*If this is a monorepo or there is more than one README target for another reason:* eliminate duplication and make sure any instructions are owned by the one closest to the relevent code. The others should link to it, when needed for ref in another scope (e.g. If there is a shared lib in the monorepo to provision SSO auth for frontends, the first-time setup instructions should not be in every app that uses the lib, the monorepo root, or the golden path generator. If and when it's relevent, those READMEs should link back to the SSO shared lib README which owns those instructions).

**Step 2:** Rewrite Rules
Rebuild the document strictly for developer scannability to gain understanding how to use the project, repo, or whatever scope the README applies to. A README should include:

- A summary overview of the repo/project/whatever it is
- How to get setup
- How to work on the project (Important commands, Manual tasks, etc) / whatever it is for

Follow these syntax rules:

- *Header Formatting:* Use standard Markdown headings (##, ###) to separate logical sections. You are strictly forbidden from numbering headings (e.g., use ## Architecture, not ## 1. Architecture).
- *The 5-Second Rule:* The first sentence must define exactly what the tool does and what depends on it. No warm-ups.
- *Imperative Setup:* Keep installation steps to terse, numbered lists. (e.g., "1. Install dependencies: yarn install").
- *Assume Competence:* Do not explain basic programming concepts (e.g., do not explain what a .env file is, just list the required variables).
- *Show, don't tell:* Use code blocks and inline code to show exactly what to do rather than describing it with verbose narration.
- *Banned Words:* welcome, embark, dive in, robust, seamless, tapestry, delve, magic, simply, just.

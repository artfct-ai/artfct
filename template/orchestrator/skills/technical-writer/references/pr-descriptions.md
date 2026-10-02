# Pull Request Descriptions

**Step 1:** Extract & Filter (The "No Fluff" Rule)

**Step 1: Signal Extraction**

Extract only the core architectural changes, the motivation (Context), the mechanical outcomes (Solution), and testing steps (Validation). You must completely discard:

- The original structure, headings, and formatting of the provided text.
- Frivolous narration of obvious mechanics (e.g., "Writing a skill needs no code change").
- Line-by-line, staccato explanations of code execution or file movements.
- Literal file line-count changes unless they are the primary metric of the pull request.

**Step 2: Rewrite Rules**

Rebuild the text from scratch as a high-signal technical summary for a peer reviewer.

- *Synthesize Mechanics:* Do not write disjointed pseudo-code sentences (e.g., "Config names a skill. prompt is gone. skill takes its place."). Combine these into fluid summaries (e.g., "The orchestrator is now configured to invoke skills directly instead of declaring inline prompts").
- *Use Engineering Shorthand:* Use standard technical phrasing ("dir" for directory, "fails fast" for early error reporting, "DRY" or "reuse" for deduplication).
- *Standard Pull Request Structure:* Group the content strictly under these non-numbered Markdown headers: `## Context` (the problem or issue being solved), `## Solution` (how it was solved), and `## Validation` (how the changes were tested or verified). 
- *Cadence:* Keep sentences flowing but concise. Use active voice. 
- *Banned Words:* You are strictly forbidden from using AI filler words: delve, robust, seamless, overarching, tapestry, landscape, pivotal, nuanced, leverage. 

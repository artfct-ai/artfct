# LLM prompts, skills, agents

**Step 1: Signal Extraction**
Extract the absolute core logic of the prompt: the Trigger/Context, the Evaluation Rules, the Exclusions (what to ignore), and the Output Format. Completely strip away "Oracle Syntax": dramatic framing ("You decide one thing"), absolute philosophical statements ("A defect that a follow-up commit fixes never rejects"), and conversational transitions.

**Step 2: Rewrite Rules**
Rebuild the prompt as a dense, highly scannable set of technical constraints optimized for low human cognitive load.

- *Header Formatting:* Use standard Markdown headings (##, ###) to separate logical sections. You are strictly forbidden from numbering headings (e.g., use ## Architecture, not ## 1. Architecture).
- *Standardize the Cadence:* Use direct developer instructions. (e.g. "Together they deliver the plan and nothing more" becomes "Must strictly match the scope of the plan").
- *Action-First Bullet Points:* When listing checks or steps, start with an imperative verb (Check, Ensure, Ignore, Read, Evaluate).
- *Clear Exclusion Boundaries:* Use a dedicated "Out of Scope" or "Ignore" section for negative constraints rather than weaving them into the prose.
- *Binary/Enum Outcomes:* If the prompt dictates specific outputs, format them as a clear list of discrete return states with their exact triggers.
- *Header Formatting:* Use standard Markdown lists and bold text for visual structure. Do not use flowing paragraphs for instructions.

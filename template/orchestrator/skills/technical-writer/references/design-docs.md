# Design Docs, RFCs

**Step 1:** Signal Extraction

Isolate the core architectural decisions:
- the "Why" (business or technical constraints)
- the "What" (state changes, new components, APIs)
- the trade-offs (what is being sacrificed). 

Completely strip away all marketing language, philosophical introductions, external system analogies (e.g., comparing to Jenkins or ArgoCD), and hypothetical praise for the design.

* **ANTI-PRESERVATION OVERRIDE:** You are explicitly AUTHORIZED and REQUIRED to destroy the document's original structure. Do not attempt to map your rewrite to the existing sections or headers.

**Step 2:** Rewrite Rules
Rebuild the document as a dense, objective engineering spec using the extracted concepts.

- *Header Formatting:* Use standard Markdown headings (##, ###) to separate logical sections. You are strictly forbidden from numbering headings (e.g., use ## Architecture, not ## 1. Architecture).
- *Kill the Intro Fluff:* Start immediately with the problem statement or goal. Delete any sentence that acts as a narrative warm-up.
- *Objective Nouns over Adjectives:* Do not describe a system as "fast" or "scalable". Describe the actual mechanism (e.g., "Uses Redis for sub-millisecond caching", "Horizontally scales via Kubernetes HPA").
- *System Boundaries:* Clearly define what is in-scope and out-of-scope.
- *Active Voice, System-Subject:* Make the system the subject of the sentence. (e.g., "The orchestrator routes the request", NOT "The request is seamlessly routed by the orchestrator").
- *Banned Words:* robust, seamless, tapestry, delve, nuanced, landscape, pivotal, paradigm, leverage, testament.

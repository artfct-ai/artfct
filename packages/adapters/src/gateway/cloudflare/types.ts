/** One decisions question as Clef and OpenRouter's decisions endpoint both take it. */
export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** One answer of a decisions model, by question name. */
export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> };

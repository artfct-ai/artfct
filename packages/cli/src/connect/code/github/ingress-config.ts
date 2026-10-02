import { readFileSync, writeFileSync } from "node:fs";
import { applyEdits, modify } from "jsonc-parser";

/** Set the `GITHUB_APP_LOGIN` var of the ingress wrangler config and keep its comments. */
export function writeIngressAppLogin(configPath: string, appLogin: string): void {
  const text = readFileSync(configPath, "utf8");
  const edits = modify(text, ["vars", "GITHUB_APP_LOGIN"], appLogin, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(configPath, applyEdits(text, edits));
}

import { readFileSync, writeFileSync } from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";

const APP_LOGIN_PATH = ["vars", "GITHUB_APP_LOGIN"];

/** Set the `GITHUB_APP_LOGIN` var of the ingress wrangler config and keep its comments. */
export function writeIngressAppLogin(configPath: string, appLogin: string): void {
  const text = readFileSync(configPath, "utf8");
  const edits = modify(text, APP_LOGIN_PATH, appLogin, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(configPath, applyEdits(text, edits));
}

/**
 * The GitHub App slug in the `GITHUB_APP_LOGIN` var of the ingress wrangler config. Null while
 * the var is unset or still holds the template's `<your GitHub App slug>` placeholder.
 */
export function readIngressAppLogin(configPath: string): string | null {
  const config: unknown = parse(readFileSync(configPath, "utf8"));
  const vars =
    typeof config === "object" && config !== null && "vars" in config ? config.vars : null;
  const appLogin =
    typeof vars === "object" && vars !== null && "GITHUB_APP_LOGIN" in vars
      ? vars.GITHUB_APP_LOGIN
      : null;
  if (typeof appLogin !== "string" || appLogin === "" || appLogin.startsWith("<")) return null;
  return appLogin;
}

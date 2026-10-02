import { parseArgs } from "node:util";

/** A command line the `artfct` binary read. */
export type Command =
  | { kind: "check" }
  | { kind: "init" }
  | { kind: "connect-code"; org: string | undefined }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

/** The help text of the `artfct` binary. */
export const ARTFCT_USAGE = `Usage: artfct <command>

Commands:
  check                     Check the deployment repo in the current directory before a deploy.
  init                      Scaffold a deployment repo in the current directory and create its
                            D1 database.
  connect code [--org <o>]  Create and install a GitHub App and write its credentials into the
                            deployment repo. --org makes the organization own the app.
`;

/** Read the arguments after the program name into a command. */
export function parseCommand(args: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, org: { type: "string" } },
    });
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.values.help) return { kind: "help" };
  const [name, ...rest] = parsed.positionals;
  if (name === undefined) return { kind: "invalid", message: "Name a command." };
  if (name === "connect") {
    if (rest.length !== 1 || rest[0] !== "code") {
      return { kind: "invalid", message: "connect takes one capability: code." };
    }
    return { kind: "connect-code", org: parsed.values.org };
  }
  if (name !== "check" && name !== "init") {
    return { kind: "invalid", message: `Unknown command ${name}.` };
  }
  if (rest.length > 0 || parsed.values.org !== undefined) {
    return { kind: "invalid", message: `${name} takes no arguments.` };
  }
  return { kind: name };
}

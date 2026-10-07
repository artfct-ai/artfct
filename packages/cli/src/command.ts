import { parseArgs } from "node:util";

/** A command line the `artfct` binary read. */
export type Command =
  | { kind: "check"; offline: boolean }
  | { kind: "init" }
  | { kind: "connect-code"; org: string | undefined }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

/** The help text of the `artfct` binary. */
export const ARTFCT_USAGE = `Usage: artfct <command>

Commands:
  check [--offline]         Check the deployment repo in the current directory before a deploy.
                            --offline skips the Cloudflare credential, so CI can run the other
                            checks as tests.
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
      options: {
        help: { type: "boolean", short: "h" },
        org: { type: "string" },
        offline: { type: "boolean" },
      },
    });
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.values.help) return { kind: "help" };
  const [name, ...rest] = parsed.positionals;
  const { org, offline } = parsed.values;
  if (name === undefined) return { kind: "invalid", message: "Name a command." };
  if (name !== "check" && offline !== undefined) {
    return { kind: "invalid", message: "--offline is an option of check." };
  }
  if (name === "connect") {
    if (rest.length !== 1 || rest[0] !== "code") {
      return { kind: "invalid", message: "connect takes one capability: code." };
    }
    return { kind: "connect-code", org };
  }
  if (name !== "check" && name !== "init") {
    return { kind: "invalid", message: `Unknown command ${name}.` };
  }
  if (rest.length > 0 || org !== undefined) {
    return { kind: "invalid", message: `${name} takes no arguments.` };
  }
  if (name === "init") return { kind: "init" };
  return { kind: "check", offline: offline ?? false };
}

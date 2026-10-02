import { describe, expect, it } from "bun:test";
import { parseCommand } from "./command";

describe("parseCommand", () => {
  it("reads check", () => {
    expect(parseCommand(["check"])).toEqual({ kind: "check" });
  });

  it("reads init", () => {
    expect(parseCommand(["init"])).toEqual({ kind: "init" });
  });

  it("rejects an argument after init", () => {
    expect(parseCommand(["init", "extra"])).toEqual({
      kind: "invalid",
      message: "init takes no arguments.",
    });
  });

  it("reads connect code with and without an organization", () => {
    expect(parseCommand(["connect", "code"])).toEqual({ kind: "connect-code", org: undefined });
    expect(parseCommand(["connect", "code", "--org", "acme"])).toEqual({
      kind: "connect-code",
      org: "acme",
    });
  });

  it("rejects connect without the code capability", () => {
    expect(parseCommand(["connect"]).kind).toBe("invalid");
    expect(parseCommand(["connect", "chat"]).kind).toBe("invalid");
  });

  it("rejects --org on check", () => {
    expect(parseCommand(["check", "--org", "acme"]).kind).toBe("invalid");
  });

  it("reads --help and -h as help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["-h"])).toEqual({ kind: "help" });
  });

  it("rejects an empty command line", () => {
    expect(parseCommand([])).toEqual({ kind: "invalid", message: "Name a command." });
  });

  it("rejects an unknown command", () => {
    expect(parseCommand(["deploy"])).toEqual({
      kind: "invalid",
      message: "Unknown command deploy.",
    });
  });

  it("rejects an argument after check", () => {
    expect(parseCommand(["check", "extra"])).toEqual({
      kind: "invalid",
      message: "check takes no arguments.",
    });
  });

  it("rejects an unknown option", () => {
    expect(parseCommand(["check", "--fix"]).kind).toBe("invalid");
  });
});

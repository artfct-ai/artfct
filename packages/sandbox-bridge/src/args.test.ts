import { describe, expect, it } from "bun:test";
import { harnessEnv, harnessSpec, parseBridgeArgs, readArg } from "./args";

const USAGE = "usage: artfct-bridge";

describe("readArg", () => {
  describe("a flag, an env var, and a fallback all set", () => {
    it("prefers the flag", () => {
      expect(readArg(["--dial", "ws://flag"], { ARTFCT_DIAL: "ws://env" }, "dial", "ws://fb")).toBe(
        "ws://flag",
      );
    });
  });

  describe("an env var and a fallback set", () => {
    it("prefers the env var", () => {
      expect(readArg([], { ARTFCT_DIAL: "ws://env" }, "dial", "ws://fb")).toBe("ws://env");
    });
  });

  describe("a flag written with no value after it", () => {
    it("ignores the flag and reads the env var", () => {
      expect(readArg(["--dial"], { ARTFCT_DIAL: "ws://env" }, "dial")).toBe("ws://env");
    });
  });

  describe("no flag and no env var", () => {
    it("uses the fallback", () => {
      expect(readArg([], {}, "dial", "ws://fb")).toBe("ws://fb");
    });

    it("is undefined when there is no fallback either", () => {
      expect(readArg([], {}, "dial")).toBeUndefined();
    });
  });
});

describe("parseBridgeArgs", () => {
  const argv = ["bun", "cli.ts", "--dial", "wss://o/bridge"];
  const tokenEnv = { ARTFCT_TOKEN: "tok" };

  describe("only the dial on the command line and the token in the environment", () => {
    it("fills defaults for harness, cwd, model, and generation", () => {
      expect(parseBridgeArgs(argv, tokenEnv, "/work")).toEqual({
        harness: "claude-code",
        dial: "wss://o/bridge",
        token: "tok",
        cwd: "/work",
        model: undefined,
        generation: 0,
      });
    });
  });

  describe("every argument on the command line", () => {
    const full = [
      ...argv,
      "--harness",
      "opencode",
      "--cwd",
      "/repo",
      "--model",
      "m",
      "--generation",
      "3",
    ];

    it("reads every argument and parses generation as a number", () => {
      expect(parseBridgeArgs(full, tokenEnv, "/work")).toEqual({
        harness: "opencode",
        dial: "wss://o/bridge",
        token: "tok",
        cwd: "/repo",
        model: "m",
        generation: 3,
      });
    });
  });

  describe("arguments in the environment", () => {
    const env = { ARTFCT_DIAL: "wss://env", ARTFCT_TOKEN: "envtok", ARTFCT_GENERATION: "2" };

    it("reads the dial, the token, and the generation", () => {
      expect(parseBridgeArgs([], env, "/work")).toMatchObject({
        dial: "wss://env",
        token: "envtok",
        generation: 2,
      });
    });
  });

  describe("a required argument that is missing", () => {
    it("returns the usage error without a dial", () => {
      const noDial = parseBridgeArgs([], tokenEnv, "/work");
      expect("error" in noDial && noDial.error.startsWith(USAGE)).toBe(true);
    });

    it("returns the usage error without a token", () => {
      const noToken = parseBridgeArgs(["--dial", "wss://o"], {}, "/work");
      expect("error" in noToken && noToken.error.startsWith(USAGE)).toBe(true);
    });
  });

  describe("a token on the command line", () => {
    it("ignores it and returns the usage error", () => {
      const flagOnly = parseBridgeArgs([...argv, "--token", "tok"], {}, "/work");
      expect("error" in flagOnly && flagOnly.error.startsWith(USAGE)).toBe(true);
    });
  });
});

describe("harnessEnv", () => {
  const env = { HOME: "/home/node", ARTFCT_TASK_ID: "wf_x.1", ARTFCT_TOKEN: "tok" };

  it("drops the bridge token", () => {
    expect(harnessEnv(env)).not.toHaveProperty("ARTFCT_TOKEN");
  });

  it("keeps everything else", () => {
    expect(harnessEnv(env)).toEqual({ HOME: "/home/node", ARTFCT_TASK_ID: "wf_x.1" });
  });
});

describe("harnessSpec", () => {
  describe("a harness the adapter knows", () => {
    it("asks the adapter for the command and passes the model along", () => {
      expect(harnessSpec("claude-code", "claude-x")).toEqual({
        command: ["claude-agent-acp"],
        env: { ANTHROPIC_MODEL: "claude-x" },
      });
    });
  });

  describe("a harness nobody registered", () => {
    it("names the harness in the error", () => {
      expect(harnessSpec("nope", undefined)).toEqual({ error: "unknown harness: nope" });
    });
  });
});

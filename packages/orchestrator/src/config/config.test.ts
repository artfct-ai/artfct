import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, SleepAfter } from "./config";

describe("loadConfig", () => {
  describe("an empty artfct.yaml", () => {
    const config = loadConfig("");

    it("names one provider per capability", () => {
      expect(config.adapters).toEqual({
        code: { provider: "github" },
        tracker: { provider: "linear" },
        chat: { provider: "slack" },
        documents: { provider: "linear" },
        gateway: { provider: "cloudflare" },
      });
    });

    it("gives the orchestrator no extra request fields", () => {
      expect(config.orchestrator.model_params).toEqual({});
    });

    it("gives a sandbox ten minutes to start", () => {
      expect(config.orchestrator.sandbox.startup_timeout).toBe(600_000);
    });

    it("keeps each sandbox to the task's repository", () => {
      expect(config.orchestrator.sandbox.read_all_repos).toBe(false);
    });

    it("leaves the decisions model to the gateway", () => {
      expect(config.orchestrator.decisions_model).toBeUndefined();
    });
  });

  describe("a config that names the decisions model", () => {
    it("reads one model as a list of one", () => {
      const config = loadConfig("orchestrator: { decisions_model: typesafe/jev-1.13 }");
      expect(config.orchestrator.decisions_model).toEqual(["typesafe/jev-1.13"]);
    });

    it("keeps the order of a list", () => {
      const config = loadConfig(
        "orchestrator: { decisions_model: [typesafe/jev-1.13, typesafe/jev-1.12] }",
      );
      expect(config.orchestrator.decisions_model).toEqual([
        "typesafe/jev-1.13",
        "typesafe/jev-1.12",
      ]);
    });

    it("rejects an empty list", () => {
      expect(() => loadConfig("orchestrator: { decisions_model: [] }")).toThrow(/decisions_model/);
    });
  });

  describe("a config that sets the sandbox startup timeout", () => {
    it("reads the duration in milliseconds", () => {
      const config = loadConfig("orchestrator: { sandbox: { startup_timeout: 45m } }");
      expect(config.orchestrator.sandbox.startup_timeout).toBe(2_700_000);
    });

    it("rejects a timeout that is not above zero", () => {
      expect(() => loadConfig("orchestrator: { sandbox: { startup_timeout: 0 } }")).toThrow(
        /invalid duration: 0/,
      );
    });
  });

  describe("a sandbox that may read every repository", () => {
    it("reads the setting from YAML", () => {
      const config = loadConfig("orchestrator: { sandbox: { read_all_repos: true } }");
      expect(config.orchestrator.sandbox.read_all_repos).toBe(true);
    });

    it("rejects a value that is not a boolean", () => {
      expect(() => loadConfig("orchestrator: { sandbox: { read_all_repos: everything } }")).toThrow(
        /read_all_repos/,
      );
    });
  });

  describe("an orchestrator with request fields", () => {
    const { orchestrator } = loadConfig(`
orchestrator:
  model_params:
    reasoning_effort: none
    chat_template_kwargs: { enable_thinking: false }
`);

    it("keeps the request fields", () => {
      expect(orchestrator.model_params).toEqual({
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
      });
    });
  });

  describe("a config that sets values of its own", () => {
    const config = loadConfig(`
orchestrator:
  task:
    harness: opencode
    timeouts:
      time_elapsed_minutes: 45
`);

    it("keeps the harness", () => {
      expect(config.orchestrator.task.harness).toBe("opencode");
    });

    it("keeps the limit it sets", () => {
      expect(config.orchestrator.task.timeouts.time_elapsed_minutes).toBe(45);
    });

    it("still fills the limits it leaves out", () => {
      expect(config.orchestrator.task.timeouts.no_progress_minutes).toBe(10);
    });
  });

  describe("effort levels", () => {
    it("takes the level from the task settings", () => {
      expect(loadConfig("orchestrator: { task: { effort: max } }").orchestrator.task.effort).toBe(
        "max",
      );
    });

    it("rejects a level it does not know", () => {
      expect(() => loadConfig("orchestrator: { task: { effort: extreme } }")).toThrow();
    });
  });

  describe("a config the schema refuses", () => {
    it("rejects a stages list, which belongs in a workflow definition", () => {
      expect(() =>
        loadConfig(`
stages:
  - { name: implement, artifact: pull, author: { produce: { execution: harness, skill: implement } } }
`),
      ).toThrow(/stages/);
    });

    it("rejects a key it does not know", () => {
      expect(() => loadConfig("defaults: { harness: opencode }")).toThrow(/defaults/);
    });

    it("rejects a duration it cannot read", () => {
      expect(() => loadConfig("orchestrator: { sandbox: { sleep_after: later } }")).toThrow(
        /invalid duration: later/,
      );
    });

    it("rejects a task timeout that is not above zero", () => {
      for (const key of ["time_elapsed_minutes", "no_progress_minutes"]) {
        for (const minutes of [0, -5]) {
          expect(() =>
            loadConfig(`orchestrator: { task: { timeouts: { ${key}: ${minutes} } } }`),
          ).toThrow(new RegExp(key));
        }
      }
    });
  });
});

describe("SleepAfter", () => {
  describe("the schema", () => {
    it("allows 0 to keep the sandbox alive", () => {
      expect(SleepAfter.parse(0)).toBe(0);
    });

    it("allows a positive duration", () => {
      expect(SleepAfter.parse("10m")).toBe(600_000);
    });

    it("rejects a negative number", () => {
      expect(SleepAfter.safeParse(-5).success).toBe(false);
    });

    it("rejects zero with a unit", () => {
      expect(SleepAfter.safeParse("0s").success).toBe(false);
    });
  });

  describe("a config that sets sleep_after to 0", () => {
    it("reads the 0 from YAML", () => {
      const config = loadConfig("orchestrator: { sandbox: { sleep_after: 0 } }");
      expect(config.orchestrator.sandbox.sleep_after).toBe(0);
    });
  });
});

describe("adapters", () => {
  describe("a config that names a documents provider", () => {
    const config = loadConfig("adapters: { documents: { provider: notion } }");

    it("takes the named provider", () => {
      expect(config.adapters.documents.provider).toBe("notion");
    });

    it("leaves the rest on their defaults", () => {
      expect(config.adapters.tracker.provider).toBe("linear");
    });
  });

  describe("a config that names a provider with no implementation", () => {
    it("is refused", () => {
      expect(() => loadConfig("adapters: { documents: { provider: confluence } }")).toThrow();
    });
  });
});

describe("access", () => {
  it("names no team by default", () => {
    expect(loadConfig("").access).toEqual({});
  });

  it("takes a tracker team and a chat team", () => {
    const yaml = "access: { tracker_team: ENG, chat_team: T0123ABCD }";
    expect(loadConfig(yaml).access).toEqual({ tracker_team: "ENG", chat_team: "T0123ABCD" });
  });

  it("refuses a key it does not know, so a misspelled team does not open the deployment", () => {
    expect(() => loadConfig("access: { slack_team: T0123ABCD }")).toThrow();
  });

  it("refuses an empty team", () => {
    expect(() => loadConfig('access: { tracker_team: "" }')).toThrow();
  });
});

describe("the template artfct.yaml", () => {
  it("parses", () => {
    const text = readFileSync(
      join(import.meta.dirname, "../../../../template/orchestrator/artfct.yaml"),
      "utf8",
    );
    expect(loadConfig(text).adapters.code.provider).toBe("github");
  });
});

import { describe, expect, it } from "bun:test";
import { runInteractiveProcess, runProcess } from "./process";

describe("runProcess", () => {
  it("collects the exit code and both output streams", async () => {
    const script = "console.log('out'); console.error('err'); process.exit(3)";
    expect(await runProcess(process.execPath, ["-e", script], import.meta.dirname)).toEqual({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("rejects when the program does not exist", async () => {
    await expect(runProcess("artfct-no-such-program", [], import.meta.dirname)).rejects.toThrow();
  });
});

describe("runInteractiveProcess", () => {
  it("returns the exit code", async () => {
    expect(
      await runInteractiveProcess(process.execPath, ["-e", "process.exit(3)"], import.meta.dirname),
    ).toBe(3);
  });

  it("rejects when the program does not exist", async () => {
    await expect(
      runInteractiveProcess("artfct-no-such-program", [], import.meta.dirname),
    ).rejects.toThrow();
  });
});

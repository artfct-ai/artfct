import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDevVar, setDevVars, writeDevVarsFile } from "./dev-vars";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "artfct-dev-vars-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setDevVars", () => {
  it("replaces a value in place and appends a missing one", () => {
    expect(setDevVars("# App\nGITHUB_APP_ID=\nOTHER=1\n", { GITHUB_APP_ID: "12", NEW: "x" })).toBe(
      "# App\nGITHUB_APP_ID=12\nOTHER=1\nNEW=x\n",
    );
  });

  it("quotes a multi-line value and replaces an earlier multi-line value whole", () => {
    const text = 'A=1\nKEY="first\nsecond"\nB=2\n';
    expect(setDevVars(text, { KEY: "one\ntwo\nthree\n" })).toBe(
      'A=1\nKEY="one\ntwo\nthree"\nB=2\n',
    );
  });

  it("replaces an empty quoted value", () => {
    expect(setDevVars('KEY=""\nB=2\n', { KEY: "a\nb" })).toBe('KEY="a\nb"\nB=2\n');
  });

  it("writes into an empty text", () => {
    expect(setDevVars("", { KEY: "v" })).toBe("KEY=v\n");
  });
});

describe("readDevVar", () => {
  it("reads a set value and treats an empty one as missing", () => {
    expect(readDevVar('A=1\nB=\nC="x"\n', "A")).toBe("1");
    expect(readDevVar('A=1\nB=\nC="x"\n', "B")).toBeUndefined();
    expect(readDevVar('A=1\nB=\nC="x"\n', "C")).toBe("x");
    expect(readDevVar("A=1\n", "D")).toBeUndefined();
  });
});

describe("writeDevVarsFile", () => {
  it("starts a missing file from its example and makes it readable only by its owner", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".dev.vars.example"), "# Secrets\nKEY=\n");
    writeDevVarsFile(join(dir, ".dev.vars"), { KEY: "v" });
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("# Secrets\nKEY=v\n");
    expect(statSync(join(dir, ".dev.vars")).mode & 0o777).toBe(0o600);
  });

  it("narrows the mode of an existing file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".dev.vars"), "KEY=old\n", { mode: 0o644 });
    writeDevVarsFile(join(dir, ".dev.vars"), { KEY: "new" });
    expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toBe("KEY=new\n");
    expect(statSync(join(dir, ".dev.vars")).mode & 0o777).toBe(0o600);
  });
});

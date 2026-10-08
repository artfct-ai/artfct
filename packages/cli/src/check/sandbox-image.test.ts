import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSandboxImage } from "./sandbox-image";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;
const PUBLISHED_IMAGE = `docker.io/artfct/sandbox:3f9a2c1d8e7b6a50@${DIGEST}`;
const DOCKERFILE = "../node_modules/@artfct-ai/core/dist/sandbox/Dockerfile";

const repoDirs: string[] = [];

function deploymentRepo(wranglerConfig: string, publishedImage: string | null): string {
  const repoDir = mkdtempSync(join(tmpdir(), "artfct-sandbox-image-"));
  repoDirs.push(repoDir);
  mkdirSync(join(repoDir, "orchestrator"));
  writeFileSync(join(repoDir, "orchestrator/wrangler.jsonc"), wranglerConfig);
  const sandboxDir = join(repoDir, "node_modules/@artfct-ai/core/dist/sandbox");
  mkdirSync(sandboxDir, { recursive: true });
  if (publishedImage !== null)
    writeFileSync(join(sandboxDir, "published-image"), `${publishedImage}\n`);
  return repoDir;
}

function withImage(image: string): string {
  return `{\n  // ours\n  "containers": [{ "image": "${image}" },],\n}`;
}

function checkImage(image: string, publishedImage: string | null = PUBLISHED_IMAGE) {
  return checkSandboxImage(deploymentRepo(withImage(image), publishedImage));
}

afterEach(() => {
  for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
});

describe("checkSandboxImage", () => {
  it("passes the Dockerfile in @artfct-ai/core", () => {
    expect(checkImage(DOCKERFILE)).toEqual({ outcome: "passed", detail: DOCKERFILE });
  });

  it("passes the published image at the digest the installed core pins", () => {
    expect(checkImage(PUBLISHED_IMAGE)).toEqual({ outcome: "passed", detail: PUBLISHED_IMAGE });
  });

  it("reports the published image named by its tag alone, since a tag can move", () => {
    expect(checkImage("docker.io/artfct/sandbox:3f9a2c1d8e7b6a50")).toEqual({
      outcome: "failed",
      problems: [
        `docker.io/artfct/sandbox:3f9a2c1d8e7b6a50 is not the image the installed @artfct-ai/core was published with. Use ${PUBLISHED_IMAGE}.`,
      ],
    });
  });

  it("reports the published image at another digest", () => {
    const image = `docker.io/artfct/sandbox:3f9a2c1d8e7b6a50@${OTHER_DIGEST}`;
    expect(checkImage(image)).toMatchObject({ outcome: "failed" });
  });

  it("reports the published image of another commit", () => {
    const image = `docker.io/artfct/sandbox:0.3.0-def5678@${DIGEST}`;
    expect(checkImage(image)).toMatchObject({ outcome: "failed" });
  });

  it("reports the published image named by a digest without a tag", () => {
    expect(checkImage(`docker.io/artfct/sandbox@${OTHER_DIGEST}`)).toMatchObject({
      outcome: "failed",
    });
  });

  it("reports a published image when the installed core names none", () => {
    expect(checkImage(PUBLISHED_IMAGE, null)).toEqual({
      outcome: "failed",
      problems: [
        `${PUBLISHED_IMAGE} cannot be checked, because the installed @artfct-ai/core names no published image. Use ${DOCKERFILE}.`,
      ],
    });
  });

  it("passes the Dockerfile when the installed core names no published image", () => {
    expect(checkImage(DOCKERFILE, null)).toEqual({ outcome: "passed", detail: DOCKERFILE });
  });

  it("passes an image from another registry", () => {
    const image = "registry.example.com/acme/sandbox:7";
    expect(checkImage(image)).toEqual({ outcome: "passed", detail: image });
  });

  it("reports a config without a container", () => {
    expect(checkSandboxImage(deploymentRepo("{}", PUBLISHED_IMAGE))).toEqual({
      outcome: "failed",
      problems: ["orchestrator/wrangler.jsonc names no container"],
    });
  });
});

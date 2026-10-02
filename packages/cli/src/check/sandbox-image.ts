import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { CheckOutcome } from "./types";

const ORCHESTRATOR_WRANGLER_CONFIG = "orchestrator/wrangler.jsonc";
const PUBLISHED_SANDBOX_IMAGE = "docker.io/artfct/sandbox";
const CORE_SANDBOX_DIR = "node_modules/@artfct-ai/core/dist/sandbox";

type ContainersConfig = { containers?: { image: string }[] };

function readContainerImages(repoDir: string): string[] {
  const path = join(repoDir, ORCHESTRATOR_WRANGLER_CONFIG);
  const errors: ParseError[] = [];
  const config: ContainersConfig = parseJsonc(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new Error(`${path} is not valid JSONC`);
  return (config.containers ?? []).map((container) => container.image);
}

function isPublishedSandboxImage(image: string): boolean {
  return [":", "@"].some((separator) => image.startsWith(`${PUBLISHED_SANDBOX_IMAGE}${separator}`));
}

/** The image reference the installed @artfct-ai/core was published with, digest included. Null when it names none. */
function readPublishedImage(repoDir: string): string | null {
  const path = join(repoDir, CORE_SANDBOX_DIR, "published-image");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function describeMismatch(image: string, publishedImage: string | null): string {
  if (publishedImage === null) {
    return `${image} cannot be checked, because the installed @artfct-ai/core names no published image. Use ../${CORE_SANDBOX_DIR}/Dockerfile.`;
  }
  return `${image} is not the image the installed @artfct-ai/core was published with. Use ${publishedImage}.`;
}

/** Confirm that a published sandbox image the orchestrator config names is the one the installed @artfct-ai/core pins by digest. */
export function checkSandboxImage(repoDir: string): CheckOutcome {
  const images = readContainerImages(repoDir);
  if (images.length === 0) {
    return { outcome: "failed", problems: [`${ORCHESTRATOR_WRANGLER_CONFIG} names no container`] };
  }
  const publishedImage = readPublishedImage(repoDir);
  const problems = images
    .filter((image) => isPublishedSandboxImage(image) && image !== publishedImage)
    .map((image) => describeMismatch(image, publishedImage));
  if (problems.length > 0) return { outcome: "failed", problems };
  return { outcome: "passed", detail: images.join(", ") };
}

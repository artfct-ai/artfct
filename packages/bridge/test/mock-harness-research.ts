/** What the mock agent writes when the smoke starts it as the researcher of a job. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The line of a researcher prompt that names the container path of the research payload. */
const PAYLOAD_PATH_LINE = /Write the research payload to `([^`]+)`/;

/** The container path a researcher prompt asks the payload to be written to. Null for any other prompt. */
export function researchPayloadPath(prompt: string): string | null {
  return PAYLOAD_PATH_LINE.exec(prompt)?.[1] ?? null;
}

/** The research payload the mock researcher of a stage finds. */
export function mockResearchPayload(stage: string): string {
  return JSON.stringify({
    stage,
    findings: [
      {
        file: "src/auth/redirect.ts",
        line: 42,
        note: "the redirect runs before the session is set",
      },
    ],
  });
}

/** Writes the payload at a container path. */
export async function writeMockResearchPayload(options: {
  sandboxRoot: string;
  path: string;
  payload: string;
}): Promise<void> {
  const target = join(options.sandboxRoot, options.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, options.payload);
}

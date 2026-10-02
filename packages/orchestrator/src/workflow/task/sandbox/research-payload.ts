import type { SandboxProvider } from "../../../sandbox/provider";
import type { SandboxRef } from "../../../sandbox/spec";

/**
 * Where a researcher writes its research payload. The path is absolute and outside the repository
 * checkout, so the file never lands in a commit.
 */
export const RESEARCH_PAYLOAD_PATH = "/workspace/research-payload.md";

/** The largest research payload a job stores, in bytes. */
export const RESEARCH_PAYLOAD_MAX_BYTES = 1_048_576;

/**
 * The research payload a researcher wrote, why its job cannot use it, or the error text of a
 * read the sandbox refused.
 */
export type ResearchPayloadRead = { payload: string } | { failure: string } | { readError: string };

/** Read the research payload from the researcher's sandbox while its container is awake. */
export async function readResearchPayload(
  provider: SandboxProvider,
  sandbox: SandboxRef,
): Promise<ResearchPayloadRead> {
  let payload: string;
  try {
    payload = await provider.readFile(sandbox, RESEARCH_PAYLOAD_PATH);
  } catch (error) {
    return { readError: String(error) };
  }
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > RESEARCH_PAYLOAD_MAX_BYTES) {
    return {
      failure: `The research payload is ${bytes} bytes, over the limit of ${RESEARCH_PAYLOAD_MAX_BYTES}.`,
    };
  }
  return { payload };
}

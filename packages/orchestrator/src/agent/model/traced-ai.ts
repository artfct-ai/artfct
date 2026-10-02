import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";

/**
 * The `ai` SDK namespace wrapped with Cloudflare Agents tracing. Calls through it emit the
 * spans the Agents dashboard reads, without message or tool payloads.
 */
export const tracedAI = wrapAISDK(ai);

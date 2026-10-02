import type { Context } from "hono";
import type { HonoEnv } from "../env";

/** Parse a JSON body. Null when the text is not JSON. */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Fail closed when a signing secret is unset. The log names the missing secret. */
export function secretNotConfigured(ctx: Context<HonoEnv>, name: string): Response {
  console.error(`${name} is not set. Webhook rejected.`);
  return ctx.text("signing secret not configured", 401);
}

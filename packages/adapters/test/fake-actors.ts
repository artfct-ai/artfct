import type { Actor } from "@artfct-ai/contracts/inbound";
import type { CodeUser, ExternalUser } from "@artfct-ai/contracts/types";

/** Resolves every external user to a member actor. With `authorized: false` nobody resolves. */
export function fakeUserActor(options: { authorized?: boolean } = {}) {
  const authorized = options.authorized ?? true;
  return async (user: ExternalUser): Promise<Actor | null> => {
    if (!authorized) return null;
    return { email: user.email ?? null, display_name: user.name ?? null };
  };
}

/** Resolves every code host user to an actor named after the login. */
export async function fakeLoginActor(user: CodeUser): Promise<Actor | null> {
  return { email: null, display_name: user.login };
}

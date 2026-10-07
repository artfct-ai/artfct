import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Actor } from "@artfct-ai/contracts/inbound";
import type { ChatUser, CodeUser, ExternalUser, IdentityQuery } from "@artfct-ai/contracts/types";
import type { Access } from "../config/config";
import { registeredConfig } from "../config/register-config";
import type { Database } from "../db/client";
import { upsertPerson, type PersonRecord } from "../db/persons";
import { codeHost, tracker as installedTracker } from "../clients";
import type { Env } from "../env";

/** The vendor clients identity asks. Null stands for a vendor that is not connected. */
export type IdentityClients = { tracker?: Tracker | null; code?: CodeHost | null };

/**
 * Resolve an external user to an authorized actor. Null means not authorized. `clients` is a
 * seam for tests. A client left out is built from the deployment's credentials.
 */
export async function resolveActor(
  env: Env,
  db: Database,
  query: IdentityQuery,
  clients: IdentityClients = {},
): Promise<Actor | null> {
  const { access, adapters } = registeredConfig().config;
  if (query.source === "code") {
    const code = clients.code === undefined ? codeHost(env, adapters.code.provider) : clients.code;
    return resolveCodeActor(db, code, query.user);
  }
  const tracker = clients.tracker === undefined ? await installedTracker(env) : clients.tracker;
  const identity = new Identity(access, db, tracker);
  switch (query.source) {
    case "tracker":
      return identity.fromTracker(query.user);
    case "chat":
      return identity.fromChat(query.user);
    case "docs":
      return identity.fromDocs(query.user);
    default: {
      const unhandled: never = query;
      throw new Error(`unhandled identity source ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A code host user as an actor. An App is authorized, since the repository installed it. A person is
 * authorized when they may push to the repository, asked on every event.
 */
export async function resolveCodeActor(
  db: Database,
  code: CodeHost | null,
  user: CodeUser,
): Promise<Actor | null> {
  if (!user.app && !(await mayPush(code, user))) return null;
  const person = await upsertPerson(db, { github_login: user.login, display_name: user.login });
  return toActor(person);
}

/** An unanswered lookup leaves the person unauthorized. */
async function mayPush(code: CodeHost | null, user: CodeUser): Promise<boolean> {
  if (!code) return false;
  try {
    return await code.canPush(user.repo, user.login);
  } catch (error) {
    console.warn(`code host permission check failed: ${String(error)}`);
    return false;
  }
}

/**
 * Resolves external users to people. A tracker user is unauthorized unless they are a member of
 * `access.tracker_team`. A chat user is unauthorized unless they are a full member of
 * `access.chat_team`. Without a chat team, a chat user joins a tracker user by email, and a
 * document user always does. A team that is not set lets everyone of its app in.
 */
export class Identity {
  constructor(
    private access: Access,
    private db: Database,
    private tracker: Tracker | null,
  ) {}

  /** The installed app's own user is not a person. */
  async fromTracker(user: ExternalUser): Promise<Actor | null> {
    if (user.id === this.tracker?.appUserId) return null;
    const person = await upsertPerson(this.db, {
      linear_user_id: user.id,
      email: user.email,
      display_name: user.name,
    });
    return (await this.isMember(user.id)) ? toActor(person) : null;
  }

  async fromChat(user: ChatUser): Promise<Actor | null> {
    const person = await upsertPerson(this.db, {
      slack_user_id: user.id,
      email: user.email,
      display_name: user.name,
    });
    const { chat_team: chatTeam, tracker_team: trackerTeam } = this.access;
    if (chatTeam) return user.member_of_team === chatTeam ? toActor(person) : null;
    if (!trackerTeam) return toActor(person);
    const email = person.email ?? user.email ?? null;
    if (!email) return null;
    return this.joinByEmail(email, { slack_user_id: user.id });
  }

  async fromDocs(user: ExternalUser): Promise<Actor | null> {
    if (!user.email) return null;
    return this.joinByEmail(user.email, {});
  }

  /** Look the Linear user up by email and join the person to them. Null when unknown or not a member. */
  private async joinByEmail(email: string, ids: { slack_user_id?: string }): Promise<Actor | null> {
    const linearUser = await this.userByEmail(email);
    if (!linearUser) return null;
    const membership = await this.isMember(linearUser.id);
    if (!membership) return null;
    const person = await upsertPerson(this.db, {
      ...ids,
      email,
      linear_user_id: linearUser.id,
      display_name: linearUser.name,
    });
    return toActor(person);
  }

  /** The Linear user with this email. Null when there is none, or when Linear cannot answer. */
  private async userByEmail(email: string): Promise<{ id: string; name: string } | null> {
    if (!this.tracker) return null;
    try {
      return await this.tracker.userByEmail(email);
    } catch (error) {
      console.warn(`linear user lookup failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * Whether the user is a member of the tracker team, asked on every event so that a person who
   * left the team is out at once. Without a team everyone is a member. An unanswered lookup
   * leaves the person unauthorized.
   */
  private async isMember(linearUserId: string): Promise<boolean> {
    const trackerTeam = this.access.tracker_team;
    if (!trackerTeam) return true;
    if (!this.tracker) return false;
    try {
      const membership = await this.tracker.teamMembership(trackerTeam, linearUserId);
      return membership.member;
    } catch (error) {
      console.warn(`linear membership check failed: ${String(error)}`);
      return false;
    }
  }
}

function toActor(person: PersonRecord): Actor {
  return { person_id: person.person_id, email: person.email, display_name: person.display_name };
}

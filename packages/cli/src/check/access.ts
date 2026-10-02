import { loadConfig, readDeploymentConfig } from "@artfct-ai/core/config";
import type { CheckOutcome } from "./types";

const ACCESS_TEAMS = ["tracker_team", "chat_team"] as const;

const TEAM_KEY_OR_ID = /^[A-Za-z0-9-]+$/;

/**
 * Validate the `access` teams of `artfct.yaml`. A team that is not a key or an id fails, which
 * is how the placeholders of the template fail until somebody replaces or deletes them.
 */
export function checkAccess(configDir: string): CheckOutcome {
  const { access } = loadConfig(readDeploymentConfig(configDir).config);
  const teams = ACCESS_TEAMS.flatMap((key) => {
    const team = access[key];
    return team === undefined ? [] : [{ key, team }];
  });
  const invalid = teams.filter(({ team }) => !TEAM_KEY_OR_ID.test(team));
  if (invalid.length > 0) {
    return {
      outcome: "failed",
      problems: [
        ...invalid.map(
          ({ key, team }) =>
            `access.${key} is "${team}", which is not a team key or id. Set it to your team, or delete the line`,
        ),
        "Delete the whole access block to let in everyone who reaches the bot",
      ],
    };
  }
  if (teams.length === 0) {
    return {
      outcome: "passed",
      detail: "not limited to a team. Everyone who reaches the bot is let in",
    };
  }
  return {
    outcome: "passed",
    detail: `limited to ${teams.map(({ key, team }) => `${key} ${team}`).join(" and ")}`,
  };
}

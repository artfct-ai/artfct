import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import {
  readLinearInstall,
  saveLinearInstall,
  updateLinearTokens,
  type LinearInstallInput,
  type LinearInstallRow,
} from "./linear-installs";

const db = createDb(env.DB);

function install(patch: Partial<LinearInstallInput> = {}): LinearInstallInput {
  return {
    organization_id: "org1",
    organization_name: "Acme",
    app_user_id: "app1",
    access_token: "lin_oauth_a",
    refresh_token: "r1",
    expires_at: "2026-09-04T10:00:00.000Z",
    scope: "read,write",
    ...patch,
  };
}

const refreshed = {
  access_token: "lin_oauth_c",
  refresh_token: "r2",
  expires_at: "2026-09-05T10:00:00.000Z",
  scope: "read,write",
};

describe("linear installs", () => {
  describe("before the first install", () => {
    it("reads nothing", async () => {
      expect(await readLinearInstall(db)).toBeNull();
    });
  });

  describe("a saved install", () => {
    let row: LinearInstallRow | null;
    beforeEach(async () => {
      await saveLinearInstall(db, install());
      row = await readLinearInstall(db);
    });

    it("reads back every field it was given", () => {
      expect(row).toMatchObject(install());
    });

    it("stamps created_at and updated_at together", () => {
      expect(row?.created_at).toBe(row?.updated_at);
    });

    describe("saved again by the same workspace", () => {
      beforeEach(async () => {
        await saveLinearInstall(db, install({ access_token: "lin_oauth_b", app_user_id: "app2" }));
        row = await readLinearInstall(db);
      });

      it("takes the new token", () => {
        expect(row?.access_token).toBe("lin_oauth_b");
      });

      it("takes the new app user", () => {
        expect(row?.app_user_id).toBe("app2");
      });
    });

    describe("refreshed with the token that is still current", () => {
      let updated: boolean;
      beforeEach(async () => {
        updated = await updateLinearTokens(db, "org1", "r1", refreshed);
        row = await readLinearInstall(db);
      });

      it("reports the update", () => {
        expect(updated).toBe(true);
      });

      it("stores the new pair", () => {
        expect(row).toMatchObject({ access_token: "lin_oauth_c", refresh_token: "r2" });
      });

      it("keeps the workspace name", () => {
        expect(row?.organization_name).toBe("Acme");
      });
    });
  });

  describe("an install whose refresh token another refresh already spent", () => {
    let updated: boolean;
    let row: LinearInstallRow | null;
    beforeEach(async () => {
      await saveLinearInstall(db, install({ refresh_token: "r9", access_token: "lin_oauth_z" }));
      updated = await updateLinearTokens(db, "org1", "r1", refreshed);
      row = await readLinearInstall(db);
    });

    it("refuses the update", () => {
      expect(updated).toBe(false);
    });

    it("leaves the stored pair alone", () => {
      expect(row).toMatchObject({ access_token: "lin_oauth_z", refresh_token: "r9" });
    });
  });
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { consumeOauthState, saveOauthState } from "./linear-oauth-states";

const db = createDb(env.DB);
const NOW = "2026-09-03T10:00:00.000Z";
const LATER = "2026-09-03T10:20:00.000Z";
const EXPIRES = "2026-09-03T10:15:00.000Z";
const STATE = "n1";

describe("linear oauth states", () => {
  describe("a state the install route minted", () => {
    beforeEach(async () => {
      await saveOauthState(db, STATE, EXPIRES);
    });

    describe("consumed while it is fresh", () => {
      let firstUse: boolean;
      beforeEach(async () => {
        firstUse = await consumeOauthState(db, STATE, NOW);
      });

      it("accepts the state", () => {
        expect(firstUse).toBe(true);
      });

      it("refuses a second use of it", async () => {
        expect(await consumeOauthState(db, STATE, NOW)).toBe(false);
      });
    });

    describe("consumed after it expired", () => {
      let lateUse: boolean;
      beforeEach(async () => {
        lateUse = await consumeOauthState(db, STATE, LATER);
      });

      it("refuses the state", () => {
        expect(lateUse).toBe(false);
      });

      it("removes it, so an in time call refuses it too", async () => {
        expect(await consumeOauthState(db, STATE, NOW)).toBe(false);
      });
    });
  });

  describe("a state nobody minted", () => {
    it("is refused", async () => {
      expect(await consumeOauthState(db, "unknown", NOW)).toBe(false);
    });
  });
});

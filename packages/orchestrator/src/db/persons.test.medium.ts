import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { upsertPerson, type PersonRecord } from "./persons";
import { persons } from "./schema";

const db = createDb(env.DB);

describe("upsertPerson", () => {
  describe("a person nobody stored yet", () => {
    let person: PersonRecord;
    beforeEach(async () => {
      person = await upsertPerson(db, { email: "Ann@Example.com", display_name: "Ann" });
    });

    it("mints a person id", () => {
      expect(person.person_id).toMatch(/^p_/);
    });

    it("stores the email in lower case", () => {
      expect(person.email).toBe("ann@example.com");
    });
  });

  describe("a person known by a Slack id and an email", () => {
    let first: PersonRecord;
    beforeEach(async () => {
      first = await upsertPerson(db, { slack_user_id: "U1", email: "ann@example.com" });
    });

    describe("upserted again by the email, with a Linear id", () => {
      let second: PersonRecord;
      beforeEach(async () => {
        second = await upsertPerson(db, {
          linear_user_id: "L1",
          email: "ANN@example.com",
        });
      });

      it("matches the person the email names", () => {
        expect(second.person_id).toBe(first.person_id);
      });

      it("fills in the Linear id the row lacked", () => {
        expect(second.linear_user_id).toBe("L1");
      });

      describe("upserted once more by the Linear id alone", () => {
        let third: PersonRecord;
        beforeEach(async () => {
          third = await upsertPerson(db, { linear_user_id: "L1" });
        });

        it("matches the same person", () => {
          expect(third.person_id).toBe(first.person_id);
        });

        it("keeps the stored email", () => {
          expect(third.email).toBe("ann@example.com");
        });
      });
    });
  });

  describe("a person known by a GitHub login", () => {
    let first: PersonRecord;
    beforeEach(async () => {
      first = await upsertPerson(db, { github_login: "ann", display_name: "ann" });
    });

    describe("upserted with a new display name", () => {
      let second: PersonRecord;
      beforeEach(async () => {
        second = await upsertPerson(db, { github_login: "ann", display_name: "Ann Lee" });
      });

      it("takes the new display name", () => {
        expect(second.display_name).toBe("Ann Lee");
      });

      describe("upserted again without a display name", () => {
        let third: PersonRecord;
        beforeEach(async () => {
          third = await upsertPerson(db, { github_login: "ann" });
        });

        it("matches the same person", () => {
          expect(third.person_id).toBe(first.person_id);
        });

        it("keeps the display name the input leaves out", () => {
          expect(third.display_name).toBe("Ann Lee");
        });
      });
    });
  });

  describe("two inputs whose ids do not match", () => {
    it("creates separate people", async () => {
      const ann = await upsertPerson(db, { slack_user_id: "U1" });
      const bob = await upsertPerson(db, { slack_user_id: "U2" });
      expect(bob.person_id).not.toBe(ann.person_id);
    });
  });

  describe("an input with no id at all", () => {
    let person: PersonRecord;
    beforeEach(async () => {
      person = await upsertPerson(db, { display_name: "Nobody" });
    });

    it("creates a person with the display name", () => {
      expect(person.display_name).toBe("Nobody");
    });

    it("leaves the email empty", () => {
      expect(person.email).toBeNull();
    });
  });

  describe("the same input upserted twice", () => {
    const input = { linear_user_id: "L1", email: "ann@example.com", display_name: "Ann" };
    let first: PersonRecord;
    let second: PersonRecord;
    beforeEach(async () => {
      first = await upsertPerson(db, input);
      second = await upsertPerson(db, input);
    });

    it("returns the same person both times", () => {
      expect(second).toEqual(first);
    });

    it("keeps one row", async () => {
      expect(await db.select().from(persons)).toHaveLength(1);
    });

    it("keeps the row's id", async () => {
      const rows = await db.select().from(persons);
      expect(rows[0]?.person_id).toBe(first.person_id);
    });
  });

  describe("two people whose email is empty", () => {
    let first: PersonRecord;
    let second: PersonRecord;
    beforeEach(async () => {
      first = await upsertPerson(db, { slack_user_id: "U_e1", email: "", display_name: "A" });
      second = await upsertPerson(db, { slack_user_id: "U_e2", email: "", display_name: "B" });
    });

    it("stores no email for the first", () => {
      expect(first.email).toBeNull();
    });

    it("stores no email for the second", () => {
      expect(second.email).toBeNull();
    });

    it("keeps them apart", () => {
      expect(second.person_id).not.toBe(first.person_id);
    });
  });

  describe("an email with spaces and capitals", () => {
    let created: PersonRecord;
    beforeEach(async () => {
      created = await upsertPerson(db, { email: " Mixed@Acme.TEST ", display_name: "M" });
    });

    it("stores it trimmed and in lower case", () => {
      expect(created.email).toBe("mixed@acme.test");
    });

    it("finds the person again by the plain email", async () => {
      const found = await upsertPerson(db, { email: "mixed@acme.test" });
      expect(found.person_id).toBe(created.person_id);
    });
  });
});

describe("a person whose ids are split across two rows", () => {
  let chatRow: PersonRecord;
  let trackerRow: PersonRecord;
  let joined: PersonRecord;
  beforeEach(async () => {
    chatRow = await upsertPerson(db, { slack_user_id: "U_split" });
    trackerRow = await upsertPerson(db, { linear_user_id: "L_split", email: "split@acme.test" });
    joined = await upsertPerson(db, {
      slack_user_id: "U_split",
      email: "split@acme.test",
      display_name: "Split",
    });
  });

  it("returns the person of one of the two rows", () => {
    expect([chatRow.person_id, trackerRow.person_id]).toContain(joined.person_id);
  });

  it("keeps that one row, holding every id", async () => {
    expect(await db.select().from(persons)).toEqual([
      expect.objectContaining({
        person_id: joined.person_id,
        slack_user_id: "U_split",
        linear_user_id: "L_split",
        email: "split@acme.test",
        display_name: "Split",
      }),
    ]);
  });
});

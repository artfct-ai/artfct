import { describe, expect, it } from "bun:test";
import { sqliteD1 } from "../../test/sqlite-d1";
import type { TriggerFiring } from "../triggers/types";
import { createDb } from "./client";
import {
  deleteFiringThreadsBefore,
  keepFiringThread,
  recordedFiringThread,
} from "./firing-threads";

const FIRING: TriggerFiring = {
  cause: { kind: "schedule", minute: "2026-10-19T09:00:00.000Z" },
  reports: { kind: "channel", channel: "C0123456" },
  definition: "dependency-upgrades",
  position: 0,
  attempt: 1,
};

describe("keepFiringThread", () => {
  it("keeps the start line a racing attempt recorded first", async () => {
    const db = createDb(sqliteD1());
    await keepFiringThread(db, FIRING, { channel: "C1", thread: "1.0" });
    expect(await keepFiringThread(db, FIRING, { channel: "C1", thread: "2.0" })).toEqual({
      channel: "C1",
      thread: "1.0",
    });
  });

  it("keys the record by the firing, not by its attempt", async () => {
    const db = createDb(sqliteD1());
    await keepFiringThread(db, FIRING, { channel: "C1", thread: "1.0" });
    expect(await recordedFiringThread(db, { ...FIRING, attempt: 3 })).toEqual({
      channel: "C1",
      thread: "1.0",
    });
  });
});

describe("deleteFiringThreadsBefore", () => {
  it("deletes the start lines recorded before the time", async () => {
    const db = createDb(sqliteD1());
    await keepFiringThread(db, FIRING, { channel: "C1", thread: "1.0" });
    await deleteFiringThreadsBefore(db, new Date(Date.now() + 1_000));
    expect(await recordedFiringThread(db, FIRING)).toBeNull();
  });

  it("keeps the start lines recorded since", async () => {
    const db = createDb(sqliteD1());
    await keepFiringThread(db, FIRING, { channel: "C1", thread: "1.0" });
    await deleteFiringThreadsBefore(db, new Date(Date.now() - 60_000));
    expect(await recordedFiringThread(db, FIRING)).not.toBeNull();
  });
});

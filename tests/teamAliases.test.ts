import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { teamsMatch } from "../src/shared/teamAliases.js";
import { Store } from "../src/server/store.js";

describe("team aliases", () => {
  it("matches MPP French names with Polymarket names", () => {
    expect(teamsMatch("États-Unis", "United States")).toBe(true);
    expect(teamsMatch("Bosnie", "Bosnia-Herzegovina")).toBe(true);
    expect(teamsMatch("Suisse", "Switzerland")).toBe(true);
    expect(teamsMatch("Algérie", "Algeria")).toBe(true);
    expect(teamsMatch("Cap-Vert", "Cabo Verde")).toBe(true);
  });

  it("merges MPP and Polymarket rows with aliased team names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpp-edge-alias-"));
    const store = new Store(path.join(dir, "test.sqlite"));
    const kickoffUtc = "2026-07-02T00:00:00.000Z";

    const mpp = store.upsertMatch({
      kickoffUtc,
      homeTeam: "États-Unis",
      awayTeam: "Bosnie",
      phase: "1/16 de finale",
      source: "mpp"
    });
    const market = store.upsertMatch({
      kickoffUtc,
      homeTeam: "United States",
      awayTeam: "Bosnia-Herzegovina",
      source: "polymarket",
      polymarketSlug: "united-states-bosnia-herzegovina"
    });

    expect(market.id).toBe(mpp.id);
    expect(store.getMatches()).toHaveLength(1);
    expect(store.getMatches()[0]).toMatchObject({
      source: "merged",
      homeTeam: "États-Unis",
      awayTeam: "Bosnie",
      polymarketSlug: "united-states-bosnia-herzegovina"
    });
  });
});

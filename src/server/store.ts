import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { hoursBetween, nowIso, parseJson, stableId, uid } from "./utils.js";
import { matchSimilarity, slugify, teamsMatch } from "../shared/teamAliases.js";
import type { AppStatus, MarketSnapshot, Match, MatchScope, MppSnapshot, SpreadMarket, TotalMarket } from "../shared/types.js";

type DbMatch = Omit<Match, "source"> & { source: string };

export class Store {
  private db: DatabaseSync;

  constructor(dbPath = path.join(config.dataDir, "mpp-edge-finder.sqlite")) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        kickoffUtc TEXT NOT NULL,
        homeTeam TEXT NOT NULL,
        awayTeam TEXT NOT NULL,
        phase TEXT,
        scope TEXT,
        source TEXT NOT NULL,
        polymarketSlug TEXT,
        mppKey TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mpp_snapshots (
        id TEXT PRIMARY KEY,
        matchId TEXT NOT NULL,
        pointsHome INTEGER NOT NULL,
        pointsDraw INTEGER NOT NULL,
        pointsAway INTEGER NOT NULL,
        crowdHomePct REAL NOT NULL,
        crowdDrawPct REAL NOT NULL,
        crowdAwayPct REAL NOT NULL,
        currentHomeScore INTEGER,
        currentAwayScore INTEGER,
        rawSource TEXT NOT NULL,
        scrapedAt TEXT NOT NULL,
        FOREIGN KEY(matchId) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id TEXT PRIMARY KEY,
        matchId TEXT NOT NULL,
        pHome REAL NOT NULL,
        pDraw REAL NOT NULL,
        pAway REAL NOT NULL,
        totalsJson TEXT NOT NULL,
        spreadsJson TEXT NOT NULL,
        volume REAL,
        liquidity REAL,
        source TEXT NOT NULL,
        fetchedAt TEXT NOT NULL,
        FOREIGN KEY(matchId) REFERENCES matches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        matchId TEXT NOT NULL,
        type TEXT NOT NULL,
        sentAt TEXT NOT NULL,
        UNIQUE(matchId, type)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    this.ensureColumn("matches", "scope", "TEXT");
  }

  getMatches(): Match[] {
    const rows = this.db.prepare("SELECT * FROM matches ORDER BY kickoffUtc ASC").all() as DbMatch[];
    return rows.map(rowToMatch);
  }

  getMatch(id: string): Match | undefined {
    const row = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as DbMatch | undefined;
    return row ? rowToMatch(row) : undefined;
  }

  findCompatibleMatch(homeTeam: string, awayTeam: string, kickoffUtc: string): Match | undefined {
    const rows = this.db
      .prepare("SELECT * FROM matches WHERE kickoffUtc BETWEEN ? AND ?")
      .all(
        new Date(new Date(kickoffUtc).getTime() - 6 * 36e5).toISOString(),
        new Date(new Date(kickoffUtc).getTime() + 6 * 36e5).toISOString()
      ) as DbMatch[];

    const candidates = rows
      .map((row) => rowToMatch(row))
      .map((match) => {
        const direct = matchSimilarity(match.homeTeam, homeTeam) + matchSimilarity(match.awayTeam, awayTeam);
        const reversed = matchSimilarity(match.homeTeam, awayTeam) + matchSimilarity(match.awayTeam, homeTeam);
        return { match, score: Math.max(direct, reversed), hours: hoursBetween(match.kickoffUtc, kickoffUtc) };
      })
      .filter((item) => item.score >= 1.55)
      .sort((a, b) => b.score - a.score || a.hours - b.hours);

    return candidates[0]?.match;
  }

  upsertMatch(input: {
    kickoffUtc: string;
    homeTeam: string;
    awayTeam: string;
    phase?: string | null;
    scope?: Match["scope"];
    source: Match["source"];
    polymarketSlug?: string | null;
    mppKey?: string | null;
  }): Match {
    const compatible = this.findCompatibleMatch(input.homeTeam, input.awayTeam, input.kickoffUtc);
    const id =
      compatible?.id ??
      stableId(
        "match",
        input.kickoffUtc.slice(0, 10),
        slugify(input.homeTeam),
        slugify(input.awayTeam)
      );
    const existing = this.getMatch(id);
    const now = nowIso();
    const source = mergeSource(existing?.source, input.source);
    const homeTeam = canonicalTeamName(existing, input.source, input.homeTeam, "home");
    const awayTeam = canonicalTeamName(existing, input.source, input.awayTeam, "away");

    this.db
      .prepare(
        `INSERT INTO matches
          (id, kickoffUtc, homeTeam, awayTeam, phase, scope, source, polymarketSlug, mppKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          kickoffUtc = excluded.kickoffUtc,
          homeTeam = excluded.homeTeam,
          awayTeam = excluded.awayTeam,
          phase = COALESCE(excluded.phase, matches.phase),
          scope = COALESCE(excluded.scope, matches.scope),
          source = excluded.source,
          polymarketSlug = COALESCE(excluded.polymarketSlug, matches.polymarketSlug),
          mppKey = COALESCE(excluded.mppKey, matches.mppKey),
          updatedAt = excluded.updatedAt`
      )
      .run(
        id,
        input.kickoffUtc,
        homeTeam,
        awayTeam,
        input.phase ?? existing?.phase ?? null,
        input.scope ?? existing?.scope ?? scopeFromPhase(input.phase ?? existing?.phase),
        source,
        input.polymarketSlug ?? existing?.polymarketSlug ?? null,
        input.mppKey ?? existing?.mppKey ?? null,
        existing?.createdAt ?? now,
        now
      );

    return this.getMatch(id)!;
  }

  addMppSnapshot(input: Omit<MppSnapshot, "id">): MppSnapshot {
    const snapshot: MppSnapshot = { ...input, id: uid("mpp") };
    this.db
      .prepare(
        `INSERT INTO mpp_snapshots
          (id, matchId, pointsHome, pointsDraw, pointsAway, crowdHomePct, crowdDrawPct, crowdAwayPct,
           currentHomeScore, currentAwayScore, rawSource, scrapedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.matchId,
        snapshot.pointsHome,
        snapshot.pointsDraw,
        snapshot.pointsAway,
        snapshot.crowdHomePct,
        snapshot.crowdDrawPct,
        snapshot.crowdAwayPct,
        snapshot.currentHomeScore ?? null,
        snapshot.currentAwayScore ?? null,
        snapshot.rawSource,
        snapshot.scrapedAt
      );
    this.setSetting("lastMppSync", snapshot.scrapedAt);
    return snapshot;
  }

  addMarketSnapshot(input: Omit<MarketSnapshot, "id">): MarketSnapshot {
    const snapshot: MarketSnapshot = { ...input, id: uid("market") };
    this.db
      .prepare(
        `INSERT INTO market_snapshots
          (id, matchId, pHome, pDraw, pAway, totalsJson, spreadsJson, volume, liquidity, source, fetchedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.matchId,
        snapshot.pHome,
        snapshot.pDraw,
        snapshot.pAway,
        JSON.stringify(snapshot.totals),
        JSON.stringify(snapshot.spreads),
        snapshot.volume ?? null,
        snapshot.liquidity ?? null,
        snapshot.source,
        snapshot.fetchedAt
      );
    this.setSetting("lastPolymarketSync", snapshot.fetchedAt);
    return snapshot;
  }

  latestMppSnapshots(): Record<string, MppSnapshot> {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM mpp_snapshots s
         JOIN (
           SELECT matchId, MAX(scrapedAt) AS scrapedAt
           FROM mpp_snapshots
           GROUP BY matchId
         ) latest ON latest.matchId = s.matchId AND latest.scrapedAt = s.scrapedAt`
      )
      .all() as Array<Record<string, unknown>>;
    return Object.fromEntries(rows.map((row) => [String(row.matchId), rowToMpp(row)]));
  }

  latestMarketSnapshots(): Record<string, MarketSnapshot> {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM market_snapshots s
         JOIN (
           SELECT matchId, MAX(fetchedAt) AS fetchedAt
           FROM market_snapshots
           GROUP BY matchId
         ) latest ON latest.matchId = s.matchId AND latest.fetchedAt = s.fetchedAt`
      )
      .all() as Array<Record<string, unknown>>;
    return Object.fromEntries(rows.map((row) => [String(row.matchId), rowToMarket(row)]));
  }

  mppHistory(matchId: string, limit = 20): MppSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM mpp_snapshots WHERE matchId = ? ORDER BY scrapedAt DESC LIMIT ?")
      .all(matchId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToMpp);
  }

  marketHistory(matchId: string, limit = 60): MarketSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM market_snapshots WHERE matchId = ? ORDER BY fetchedAt DESC LIMIT ?")
      .all(matchId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToMarket);
  }

  alreadyNotified(matchId: string, type: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM notifications WHERE matchId = ? AND type = ?").get(matchId, type));
  }

  recordNotification(matchId: string, type: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO notifications (id, matchId, type, sentAt) VALUES (?, ?, ?, ?)")
      .run(uid("notif"), matchId, type, nowIso());
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt")
      .run(key, value, nowIso());
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  status(): AppStatus {
    const count = (table: string) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    };
    return {
      now: nowIso(),
      matches: count("matches"),
      mppSnapshots: count("mpp_snapshots"),
      marketSnapshots: count("market_snapshots"),
      lastMppSync: this.getSetting("lastMppSync"),
      lastPolymarketSync: this.getSetting("lastPolymarketSync"),
      lastMppScrapeError: this.getSetting("lastMppScrapeError") || null,
      telegramConfigured: Boolean(config.telegramBotToken && config.telegramChatId),
      ntfyConfigured: Boolean(config.ntfyTopic),
      mppAutoScrape: config.mppAutoScrape,
      mppPollMinutes: config.mppPollMinutes,
      mppProfileDir: config.mppProfileDir,
      mppStrategyMode: config.mppStrategyMode,
      mppAutoPlay: config.mppAutoPlay,
      mppAutoPlayDryRun: config.mppAutoPlayDryRun,
      mppAutoPlayLeadSeconds: config.mppAutoPlayLeadSeconds,
      polymarketLeagueSlug: config.polymarketLeagueSlug
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mergeSource(current: Match["source"] | undefined, next: Match["source"]): Match["source"] {
  if (!current) return next;
  if (current === next) return current;
  return "merged";
}

function canonicalTeamName(existing: Match | undefined, incomingSource: Match["source"], incomingName: string, side: "home" | "away"): string {
  if (incomingSource === "mpp" || !existing || existing.source === "polymarket") return incomingName;
  return side === "home" ? existing.homeTeam : existing.awayTeam;
}

function rowToMatch(row: DbMatch): Match {
  return {
    ...row,
    source: row.source as Match["source"],
    phase: row.phase ?? null,
    scope: row.scope ?? scopeFromPhase(row.phase),
    polymarketSlug: row.polymarketSlug ?? null,
    mppKey: row.mppKey ?? null
  };
}

function scopeFromPhase(phase?: string | null): MatchScope | null {
  if (!phase) return null;
  return /^J\.\d+$/i.test(phase) ? "90min" : "120min";
}

function rowToMpp(row: Record<string, unknown>): MppSnapshot {
  return {
    id: String(row.id),
    matchId: String(row.matchId),
    pointsHome: Number(row.pointsHome),
    pointsDraw: Number(row.pointsDraw),
    pointsAway: Number(row.pointsAway),
    crowdHomePct: Number(row.crowdHomePct),
    crowdDrawPct: Number(row.crowdDrawPct),
    crowdAwayPct: Number(row.crowdAwayPct),
    currentHomeScore: row.currentHomeScore == null ? null : Number(row.currentHomeScore),
    currentAwayScore: row.currentAwayScore == null ? null : Number(row.currentAwayScore),
    rawSource: String(row.rawSource) as MppSnapshot["rawSource"],
    scrapedAt: String(row.scrapedAt)
  };
}

function rowToMarket(row: Record<string, unknown>): MarketSnapshot {
  return {
    id: String(row.id),
    matchId: String(row.matchId),
    pHome: Number(row.pHome),
    pDraw: Number(row.pDraw),
    pAway: Number(row.pAway),
    totals: parseJson<TotalMarket[]>(String(row.totalsJson), []),
    spreads: parseJson<SpreadMarket[]>(String(row.spreadsJson), []),
    volume: row.volume == null ? null : Number(row.volume),
    liquidity: row.liquidity == null ? null : Number(row.liquidity),
    source: "polymarket",
    fetchedAt: String(row.fetchedAt)
  };
}

export function sameFixture(a: Match, home: string, away: string, kickoffUtc: string): boolean {
  const direct = teamsMatch(a.homeTeam, home) && teamsMatch(a.awayTeam, away);
  const reversed = teamsMatch(a.homeTeam, away) && teamsMatch(a.awayTeam, home);
  return (direct || reversed) && hoursBetween(a.kickoffUtc, kickoffUtc) <= 6;
}

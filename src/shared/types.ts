export type Outcome = "home" | "draw" | "away";

export type Confidence = "high" | "medium" | "low" | "missing-data";

export type MatchScope = "90min" | "120min";

export type Match = {
  id: string;
  kickoffUtc: string;
  homeTeam: string;
  awayTeam: string;
  phase?: string | null;
  scope?: MatchScope | null;
  source: "mpp" | "polymarket" | "merged";
  polymarketSlug?: string | null;
  mppKey?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MppSnapshot = {
  id: string;
  matchId: string;
  pointsHome: number;
  pointsDraw: number;
  pointsAway: number;
  crowdHomePct: number;
  crowdDrawPct: number;
  crowdAwayPct: number;
  currentHomeScore?: number | null;
  currentAwayScore?: number | null;
  rawSource: "dom" | "playwright" | "api";
  scrapedAt: string;
};

export type MarketSnapshot = {
  id: string;
  matchId: string;
  pHome: number;
  pDraw: number;
  pAway: number;
  totals: TotalMarket[];
  spreads: SpreadMarket[];
  volume?: number | null;
  liquidity?: number | null;
  source: "polymarket";
  fetchedAt: string;
};

export type TotalMarket = {
  threshold: number;
  pOver: number;
  pUnder: number;
};

export type SpreadMarket = {
  team: "home" | "away" | "unknown";
  line: number;
  pCover: number;
};

export type ScorePick = {
  home: number;
  away: number;
  probability: number;
  estimatedBonus: number;
  expectedBonusPoints: number;
};

export type PlayInstruction = {
  ready: boolean;
  instruction: string;
  outcomeLabel?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  x2: boolean;
};

export type Recommendation = {
  match: Match;
  mpp?: MppSnapshot;
  market?: MarketSnapshot;
  outcome: Outcome | "needs-data";
  score?: ScorePick;
  play: PlayInstruction;
  outcomeEvs: Record<Outcome, number>;
  totalEv: number;
  edge: number;
  confidence: Confidence;
  x2Rank?: number | null;
  x2Candidate: boolean;
  reasons: string[];
};

export type ExtractedToken = {
  type: "text" | "input";
  value: string;
};

export type AppStatus = {
  now: string;
  matches: number;
  mppSnapshots: number;
  marketSnapshots: number;
  lastMppSync?: string | null;
  lastPolymarketSync?: string | null;
  lastMppScrapeError?: string | null;
  telegramConfigured: boolean;
  ntfyConfigured: boolean;
  mppAutoScrape: boolean;
  mppPollMinutes: number;
  mppProfileDir: string;
  polymarketLeagueSlug: string;
};

export type SyncResult = {
  ok: boolean;
  message: string;
  importedMatches?: number;
  matchedMarkets?: number;
  recommendations?: number;
};

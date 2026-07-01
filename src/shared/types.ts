export type Outcome = "home" | "draw" | "away";

export type Confidence = "high" | "medium" | "low" | "missing-data";

export type MatchScope = "90min" | "120min";

export type StrategyMode = "ev" | "chase";

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

export type MppResult = {
  id: string;
  matchId: string;
  actualHomeScore: number;
  actualAwayScore: number;
  userHomeScore?: number | null;
  userAwayScore?: number | null;
  basePoints?: number | null;
  exactPoints?: number | null;
  extraPoints?: number | null;
  bonusPoints?: number | null;
  totalPoints?: number | null;
  quotationPoints?: number | null;
  period?: string | null;
  matchStatus?: string | null;
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
  objective: number;
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
  outcomeAnalysis: Record<Outcome, OutcomeAnalysis>;
  totalEv: number;
  edge: number;
  evEdge: number;
  strategy: StrategyMode;
  strategyScore: number;
  strategyEdge: number;
  leverage: number;
  crowdEdge: number;
  confidence: Confidence;
  x2Rank?: number | null;
  x2Candidate: boolean;
  reasons: string[];
};

export type BacktestVariantSummary = {
  strategy: StrategyMode;
  playable: number;
  points: number;
  correctOutcomes: number;
  exactScores: number;
};

export type BacktestRow = {
  match: Match;
  result: MppResult;
  decisionAt: string;
  skippedReason?: string | null;
  recommendation?: Recommendation | null;
  botPoints: number;
  userPoints?: number | null;
  correctOutcome: boolean;
  exactScore: boolean;
  mppSnapshotAt?: string | null;
  mppSnapshotMode?: "pre-decision" | "historical-result" | null;
  marketSnapshotAt?: string | null;
  variants: BacktestVariantSummary[];
};

export type BacktestReport = {
  generatedAt: string;
  leadSeconds: number;
  totalResults: number;
  playable: number;
  skipped: number;
  botPoints: number;
  userPoints: number;
  deltaPoints: number;
  correctOutcomes: number;
  exactScores: number;
  variants: BacktestVariantSummary[];
  rows: BacktestRow[];
};

export type OutcomeAnalysis = {
  probability: number;
  points: number;
  crowdPct: number;
  expectedPoints: number;
  leverage: number;
  crowdEdge: number;
  attackScore: number;
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
  mppResults: number;
  lastMppSync?: string | null;
  lastPolymarketSync?: string | null;
  lastMppScrapeError?: string | null;
  telegramConfigured: boolean;
  ntfyConfigured: boolean;
  mppAutoScrape: boolean;
  mppPollMinutes: number;
  mppProfileDir: string;
  mppStrategyMode: StrategyMode;
  mppAutoPlay: boolean;
  mppAutoPlayDryRun: boolean;
  mppAutoPlayLeadSeconds: number;
  mppAvailableAutoPlay: boolean;
  mppAvailableAutoPlayDryRun: boolean;
  mppHourlyAutoPlay: boolean;
  mppHourlyAutoPlayDryRun: boolean;
  mppHourlyAutoPlayIntervalMinutes: number;
  polymarketLeagueSlug: string;
};

export type SyncResult = {
  ok: boolean;
  message: string;
  importedMatches?: number;
  matchedMarkets?: number;
  recommendations?: number;
};

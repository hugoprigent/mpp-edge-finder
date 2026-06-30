import { config } from "../config.js";
import { hoursBetween } from "../utils.js";
import { teamsMatch } from "../../shared/teamAliases.js";
import { parseMppTokens } from "./mppTextParser.js";
import { extractVisibleTokens } from "./mppScraper.js";
import { withMppBrowserLock } from "./mppBrowserLock.js";
import type { Match, Recommendation } from "../../shared/types.js";

export type MppAutoPlayResult = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  matchId: string;
  matchTitle: string;
  homeScore?: number;
  awayScore?: number;
  currentHomeScore?: string;
  currentAwayScore?: string;
};

export async function applyMppRecommendation(rec: Recommendation, dryRun = config.mppAutoPlayDryRun): Promise<MppAutoPlayResult> {
  return withMppBrowserLock(() => applyMppRecommendationUnlocked(rec, dryRun));
}

async function applyMppRecommendationUnlocked(rec: Recommendation, dryRun: boolean): Promise<MppAutoPlayResult> {
  if (!rec.score || rec.outcome === "needs-data") {
    return {
      ok: false,
      dryRun,
      matchId: rec.match.id,
      matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
      message: "Recommandation incomplète: score absent."
    };
  }

  return fillMppScore({
    match: rec.match,
    homeScore: rec.score.home,
    awayScore: rec.score.away,
    dryRun,
    source: "recommendation"
  });
}

export async function applyManualMppScore(match: Match, homeScore: number, awayScore: number, dryRun = false): Promise<MppAutoPlayResult> {
  return withMppBrowserLock(() =>
    fillMppScore({
      match,
      homeScore,
      awayScore,
      dryRun,
      source: "manual"
    })
  );
}

async function fillMppScore(input: { match: Match; homeScore: number; awayScore: number; dryRun: boolean; source: "recommendation" | "manual" }): Promise<MppAutoPlayResult> {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(config.mppProfileDir, {
    headless: config.mppHeadless,
    viewport: { width: 1440, height: 1100 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://mpp.football/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(4_000);

    const tokens = await extractVisibleTokens(page);
    const mppMatches = parseMppTokens(tokens);
    const target = findMppMatch(mppMatches, input.match);
    if (!target) {
      return {
        ok: false,
        dryRun: input.dryRun,
        matchId: input.match.id,
        matchTitle: `${input.match.homeTeam} - ${input.match.awayTeam}`,
        message: "Match introuvable dans la page MPP connectée."
      };
    }

    const inputs = page.locator("input,textarea");
    const homeInput = inputs.nth(target.index * 2);
    const awayInput = inputs.nth(target.index * 2 + 1);
    const currentHomeScore = await homeInput.inputValue();
    const currentAwayScore = await awayInput.inputValue();
    const homeScore = target.reversed ? input.awayScore : input.homeScore;
    const awayScore = target.reversed ? input.homeScore : input.awayScore;

    if (!input.dryRun) {
      await homeInput.fill(String(homeScore));
      await awayInput.fill(String(awayScore));
      await awayInput.blur();
      await page.waitForTimeout(1_500);
    }

    const afterHome = input.dryRun ? currentHomeScore : await homeInput.inputValue();
    const afterAway = input.dryRun ? currentAwayScore : await awayInput.inputValue();
    const changed = afterHome === String(homeScore) && afterAway === String(awayScore);
    const title = `${input.match.homeTeam} - ${input.match.awayTeam}`;
    const action = input.source === "manual" ? "Score manuel MPP" : "MPP rempli";

    return {
      ok: input.dryRun || changed,
      dryRun: input.dryRun,
      matchId: input.match.id,
      matchTitle: title,
      homeScore,
      awayScore,
      currentHomeScore,
      currentAwayScore,
      message: input.dryRun
        ? `Dry-run MPP: ${title} serait joué ${homeScore}-${awayScore}.`
        : changed
          ? `${action}: ${title} ${homeScore}-${awayScore}.`
          : `MPP rempli mais relecture inattendue: attendu ${homeScore}-${awayScore}, lu ${afterHome}-${afterAway}.`
    };
  } finally {
    await context.close();
  }
}

function findMppMatch(matches: Array<{ kickoffUtc: string; homeTeam: string; awayTeam: string }>, match: Match): { index: number; reversed: boolean } | null {
  for (let index = 0; index < matches.length; index += 1) {
    const mppMatch = matches[index];
    if (hoursBetween(mppMatch.kickoffUtc, match.kickoffUtc) > 6) continue;
    const direct = teamsMatch(mppMatch.homeTeam, match.homeTeam) && teamsMatch(mppMatch.awayTeam, match.awayTeam);
    if (direct) return { index, reversed: false };
    const reversed = teamsMatch(mppMatch.homeTeam, match.awayTeam) && teamsMatch(mppMatch.awayTeam, match.homeTeam);
    if (reversed) return { index, reversed: true };
  }
  return null;
}

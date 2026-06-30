import { config } from "../config.js";
import { hoursBetween } from "../utils.js";
import { teamsMatch } from "../../shared/teamAliases.js";
import { parseMppTokens } from "./mppTextParser.js";
import { extractVisibleTokens } from "./mppScraper.js";
import type { Recommendation } from "../../shared/types.js";

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
  if (!rec.score || rec.outcome === "needs-data") {
    return {
      ok: false,
      dryRun,
      matchId: rec.match.id,
      matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
      message: "Recommandation incomplète: score absent."
    };
  }

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
    const target = findMppMatch(mppMatches, rec);
    if (!target) {
      return {
        ok: false,
        dryRun,
        matchId: rec.match.id,
        matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
        message: "Match introuvable dans la page MPP connectée."
      };
    }

    const inputs = page.locator("input,textarea");
    const homeInput = inputs.nth(target.index * 2);
    const awayInput = inputs.nth(target.index * 2 + 1);
    const currentHomeScore = await homeInput.inputValue();
    const currentAwayScore = await awayInput.inputValue();
    const homeScore = target.reversed ? rec.score.away : rec.score.home;
    const awayScore = target.reversed ? rec.score.home : rec.score.away;

    if (!dryRun) {
      await homeInput.fill(String(homeScore));
      await awayInput.fill(String(awayScore));
      await awayInput.blur();
      await page.waitForTimeout(1_500);
    }

    const afterHome = dryRun ? currentHomeScore : await homeInput.inputValue();
    const afterAway = dryRun ? currentAwayScore : await awayInput.inputValue();
    const changed = afterHome === String(homeScore) && afterAway === String(awayScore);

    return {
      ok: dryRun || changed,
      dryRun,
      matchId: rec.match.id,
      matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
      homeScore,
      awayScore,
      currentHomeScore,
      currentAwayScore,
      message: dryRun
        ? `Dry-run MPP: ${rec.match.homeTeam} - ${rec.match.awayTeam} serait joué ${homeScore}-${awayScore}.`
        : changed
          ? `MPP rempli: ${rec.match.homeTeam} - ${rec.match.awayTeam} ${homeScore}-${awayScore}.`
          : `MPP rempli mais relecture inattendue: attendu ${homeScore}-${awayScore}, lu ${afterHome}-${afterAway}.`
    };
  } finally {
    await context.close();
  }
}

function findMppMatch(matches: Array<{ kickoffUtc: string; homeTeam: string; awayTeam: string }>, rec: Recommendation): { index: number; reversed: boolean } | null {
  for (let index = 0; index < matches.length; index += 1) {
    const mppMatch = matches[index];
    if (hoursBetween(mppMatch.kickoffUtc, rec.match.kickoffUtc) > 6) continue;
    const direct = teamsMatch(mppMatch.homeTeam, rec.match.homeTeam) && teamsMatch(mppMatch.awayTeam, rec.match.awayTeam);
    if (direct) return { index, reversed: false };
    const reversed = teamsMatch(mppMatch.homeTeam, rec.match.awayTeam) && teamsMatch(mppMatch.awayTeam, rec.match.homeTeam);
    if (reversed) return { index, reversed: true };
  }
  return null;
}

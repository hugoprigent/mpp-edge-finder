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

type MppScoreInput = {
  match: Match;
  homeScore: number;
  awayScore: number;
  dryRun: boolean;
  source: "recommendation" | "manual";
};

export async function applyMppRecommendation(rec: Recommendation, dryRun = config.mppAutoPlayDryRun): Promise<MppAutoPlayResult> {
  const results = await applyMppRecommendations([rec], dryRun);
  return results[0] ?? {
    ok: false,
    dryRun,
    matchId: rec.match.id,
    matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
    message: "Recommandation incomplète: score absent."
  };
}

export async function applyMppRecommendations(recs: Recommendation[], dryRun = config.mppAutoPlayDryRun, writeDelayMs = 0): Promise<MppAutoPlayResult[]> {
  const results: MppAutoPlayResult[] = [];
  const inputs: MppScoreInput[] = [];
  for (const rec of recs) {
    if (!rec.score || rec.outcome === "needs-data") {
      results.push({
        ok: false,
        dryRun,
        matchId: rec.match.id,
        matchTitle: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
        message: "Recommandation incomplète: score absent."
      });
      continue;
    }
    inputs.push({
      match: rec.match,
      homeScore: rec.score.home,
      awayScore: rec.score.away,
      dryRun,
      source: "recommendation"
    });
  }
  if (inputs.length === 0) return results;
  const applied = await withMppBrowserLock(() => fillMppScores(inputs, writeDelayMs));
  return results.concat(applied);
}

export async function applyManualMppScore(match: Match, homeScore: number, awayScore: number, dryRun = false): Promise<MppAutoPlayResult> {
  const results = await withMppBrowserLock(() =>
    fillMppScores([
      {
        match,
        homeScore,
        awayScore,
        dryRun,
        source: "manual"
      }
    ])
  );
  return results[0] ?? {
    ok: false,
    dryRun,
    matchId: match.id,
    matchTitle: `${match.homeTeam} - ${match.awayTeam}`,
    message: "Saisie MPP non exécutée."
  };
}

async function fillMppScores(inputs: MppScoreInput[], writeDelayMs = 0): Promise<MppAutoPlayResult[]> {
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
    const scoreInputs = page.locator("input,textarea");
    const results: MppAutoPlayResult[] = [];

    for (let index = 0; index < inputs.length; index += 1) {
      const result = await fillMppScoreOnPage(scoreInputs, mppMatches, inputs[index]);
      results.push(result);
      const shouldPause = !inputs[index].dryRun && writeDelayMs > 0 && index < inputs.length - 1;
      if (shouldPause) await page.waitForTimeout(writeDelayMs);
    }

    return results;
  } finally {
    await context.close();
  }
}

async function fillMppScoreOnPage(
  inputs: import("playwright").Locator,
  mppMatches: Array<{ kickoffUtc: string; homeTeam: string; awayTeam: string }>,
  input: MppScoreInput
): Promise<MppAutoPlayResult> {
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

  const homeInput = inputs.nth(target.index * 2);
  const awayInput = inputs.nth(target.index * 2 + 1);
  const currentHomeScore = await homeInput.inputValue();
  const currentAwayScore = await awayInput.inputValue();
  const homeScore = target.reversed ? input.awayScore : input.homeScore;
  const awayScore = target.reversed ? input.homeScore : input.awayScore;
  const title = `${input.match.homeTeam} - ${input.match.awayTeam}`;
  const action = input.source === "manual" ? "Score manuel MPP" : "MPP rempli";

  if (currentHomeScore === String(homeScore) && currentAwayScore === String(awayScore)) {
    return {
      ok: true,
      dryRun: input.dryRun,
      matchId: input.match.id,
      matchTitle: title,
      homeScore,
      awayScore,
      currentHomeScore,
      currentAwayScore,
      message: input.dryRun
        ? `Dry-run MPP: ${title} est déjà à ${homeScore}-${awayScore}.`
        : `MPP déjà à jour: ${title} ${homeScore}-${awayScore}.`
    };
  }

  if (!input.dryRun) {
    await homeInput.fill(String(homeScore));
    await awayInput.fill(String(awayScore));
    await awayInput.blur();
    await pagePauseAfterWrite(1_500);
  }

  const afterHome = input.dryRun ? currentHomeScore : await homeInput.inputValue();
  const afterAway = input.dryRun ? currentAwayScore : await awayInput.inputValue();
  const changed = afterHome === String(homeScore) && afterAway === String(awayScore);

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
}

async function pagePauseAfterWrite(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

import { config } from "../config.js";
import { parseMppApiPayload, type ParsedMppApiData } from "./mppApiParser.js";
import { parseMppTokens, type ParsedMppMatch } from "./mppTextParser.js";
import { withMppBrowserLock } from "./mppBrowserLock.js";
import type { ExtractedToken } from "../../shared/types.js";

export type ScrapedMppData = ParsedMppApiData & { rawSource: "api" | "playwright" };

export async function scrapeMppWithPlaywright(): Promise<ParsedMppMatch[]> {
  const data = await scrapeMppDataWithPlaywright();
  return data.matches;
}

export async function scrapeMppDataWithPlaywright(): Promise<ScrapedMppData> {
  return withMppBrowserLock(scrapeMppDataWithPlaywrightUnlocked);
}

async function scrapeMppDataWithPlaywrightUnlocked(): Promise<ScrapedMppData> {
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
    const apiData = await tryScrapeMppApi(page).catch(() => ({ matches: [], results: [] }));
    if (apiData.matches.length > 0) return { ...apiData, rawSource: "api" };

    const tokens = await extractVisibleTokens(page);
    const matches = parseMppTokens(tokens);
    if (matches.length === 0) {
      throw new Error(
        "Aucun match MPP détecté. Sur VPS, connecte une fois le profil Chromium persistant MPP, puis relance le scraping automatique."
      );
    }
    return { matches, results: [], rawSource: "playwright" };
  } finally {
    await context.close();
  }
}

async function tryScrapeMppApi(page: import("playwright").Page): Promise<ParsedMppApiData> {
  const token = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.includes("secureStorage") && key.includes("accessToken")) return localStorage.getItem(key);
    }
    return null;
  });
  if (!token) return { matches: [], results: [] };

  const headers = {
    authorization: `Bearer ${token}`,
    application: "mppLfp",
    "app-context": "internationalEvent",
    "client-version": "11.12.0",
    "client-language": "fr-FR",
    platform: "web",
    accept: "application/json, text/plain, */*"
  };
  const [matchesPayload, clubsPayload] = await Promise.all([
    fetchMppApi("https://api.mpp.football/championships-current-matches", headers),
    fetchMppApi("https://api.mpp.football/championship-clubs", headers)
  ]);
  return parseMppApiPayload(matchesPayload, clubsPayload, config.mppChampionshipId);
}

async function fetchMppApi(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`API MPP ${response.status} sur ${url}`);
  return response.json() as Promise<unknown>;
}

export async function extractVisibleTokens(page: import("playwright").Page): Promise<ExtractedToken[]> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const out: ExtractedToken[] = [];

    function walk(node: Node) {
      if (!node || out.length > 800) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = clean(node.nodeValue);
        if (text) out.push({ type: "text", value: text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as HTMLInputElement;
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        out.push({ type: "input", value: element.value || "" });
        return;
      }
      for (const child of Array.from(node.childNodes || [])) walk(child);
    }

    walk(document.body);
    return out;
  });
}

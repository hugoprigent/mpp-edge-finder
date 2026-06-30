import { config } from "../config.js";
import { parseMppTokens, type ParsedMppMatch } from "./mppTextParser.js";
import type { ExtractedToken } from "../../shared/types.js";

export async function scrapeMppWithPlaywright(): Promise<ParsedMppMatch[]> {
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
    const matches = parseMppTokens(tokens);
    if (matches.length === 0) {
      throw new Error(
        "Aucun match MPP détecté. Sur VPS, connecte une fois le profil Chromium persistant MPP, puis relance le scraping automatique."
      );
    }
    return matches;
  } finally {
    await context.close();
  }
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

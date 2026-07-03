import { describe, expect, it } from "vitest";
import { parsePolymarketEvent } from "../src/server/services/polymarket.js";

describe("parsePolymarketEvent", () => {
  it("normalizes 1N2 probabilities when Yes is at different outcome indexes", () => {
    const [event] = parsePolymarketEvent({
      title: "Japan vs. Sweden",
      slug: "jpn-swe",
      startDate: "2026-06-25T23:00:00Z",
      volume: 1000,
      markets: [
        {
          marketType: "drawable_outcome",
          question: "Will Japan win against Sweden in the World Cup match scheduled for Jun 25, 2026?",
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0.4800\",\"0.4900\"]"
        },
        {
          marketType: "drawable_outcome",
          question: "Will the World Cup match Japan vs Sweden scheduled for Jun 25, 2026 end in a draw?",
          outcomes: "[\"No\",\"Yes\"]",
          outcomePrices: "[\"0.2800\",\"0.2900\"]"
        },
        {
          marketType: "drawable_outcome",
          question: "Will Sweden win against Japan in the World Cup match scheduled for Jun 25, 2026?",
          outcomes: "[\"No\",\"Yes\"]",
          outcomePrices: "[\"0.2400\",\"0.2500\"]"
        },
        {
          marketType: "totals",
          question: "Will the total in JPN vs SWE be more than 2.5?",
          outcomes: "[\"Under\",\"Over\"]",
          outcomePrices: "[\"0.4900\",\"0.4950\"]"
        }
      ]
    });

    expect(event.homeTeam).toBe("Japan");
    expect(event.awayTeam).toBe("Sweden");
    expect(event.pHome + event.pDraw + event.pAway).toBeCloseTo(1, 3);
    expect(event.pHome).toBeGreaterThan(event.pAway);
    expect(event.totals[0]).toMatchObject({ threshold: 2.5, pOver: 0.495, pUnder: 0.49 });
  });

  it("matches aliased team names embedded in Polymarket questions", () => {
    const [event] = parsePolymarketEvent({
      title: "Argentina vs. Cabo Verde",
      slug: "fwc-arg-cpv-2026-07-03",
      startDate: "2026-07-03T22:00:00Z",
      volume: 2614421,
      markets: [
        {
          marketType: "drawable_outcome",
          question: "Will Argentina win against Cabo Verde in the World Cup match scheduled for Jul 3, 2026?",
          outcomes: "[\"No\",\"Yes\"]",
          outcomePrices: "[\"0.8600\",\"0.8650\"]"
        },
        {
          marketType: "drawable_outcome",
          question: "Will the World Cup match Argentina vs Cabo Verde scheduled for Jul 3, 2026 end in a draw?",
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0.1050\",\"0.1100\"]"
        },
        {
          marketType: "drawable_outcome",
          question: "Will Cabo Verde win against Argentina in the World Cup match scheduled for Jul 3, 2026?",
          outcomes: "[\"Yes\",\"No\"]",
          outcomePrices: "[\"0.0350\",\"0.0400\"]"
        }
      ]
    });

    expect(event).toMatchObject({
      homeTeam: "Argentina",
      awayTeam: "Cabo Verde",
      slug: "fwc-arg-cpv-2026-07-03",
      pHome: 0.8607,
      pDraw: 0.1045,
      pAway: 0.0348
    });
  });
});

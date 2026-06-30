import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { AppStatus, MarketSnapshot, MppSnapshot, Recommendation, SyncResult } from "../shared/types.js";

type RecommendationsResponse = { recommendations: Recommendation[] };
type BookmarkletResponse = { bookmarklet: string; importBookmarklet?: string };
type MatchHistoryResponse = { mppHistory: MppSnapshot[]; marketHistory: MarketSnapshot[] };

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [mppText, setMppText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [bookmarklet, setBookmarklet] = useState("");
  const [importBookmarklet, setImportBookmarklet] = useState("");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [history, setHistory] = useState<MatchHistoryResponse | null>(null);
  const [browserAlerts, setBrowserAlerts] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  async function refresh() {
    const [statusRes, recRes, bookmarkletRes] = await Promise.all([
      fetchJson<AppStatus>("/api/status"),
      fetchJson<RecommendationsResponse>("/api/recommendations?window=120"),
      fetchJson<BookmarkletResponse>("/api/bookmarklet")
    ]);
    setStatus(statusRes);
    setRecommendations(recRes.recommendations);
    setBookmarklet(bookmarkletRes.bookmarklet);
    setImportBookmarklet(bookmarkletRes.importBookmarklet ?? "");
  }

  async function runAction(name: string, action: () => Promise<SyncResult | unknown>) {
    setBusy(name);
    setMessage("");
    try {
      const result = await action();
      setMessage(result && typeof result === "object" && "message" in result ? String((result as SyncResult).message) : "Action terminée.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void checkAuth(setAuthenticated).then((ok) => {
      if (ok) void refresh();
    });
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/api/events");
    events.addEventListener("sync", () => void refresh());
    events.addEventListener("notification", (event) => {
      void refresh();
      const payload = parseEventPayload(event);
      if (payload && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(payload.title, { body: payload.body, tag: payload.matchId });
      }
    });
    events.addEventListener("error", () => void refresh());
    return () => events.close();
  }, [authenticated]);

  useEffect(() => {
    if (!selectedMatchId) {
      setHistory(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/matches/${selectedMatchId}/history?limit=24`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Historique indisponible"))))
      .then((payload) => setHistory(payload as MatchHistoryResponse))
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setHistory(null);
      });
    return () => controller.abort();
  }, [selectedMatchId, status?.lastMppSync, status?.lastPolymarketSync]);

  const actionable = useMemo(() => recommendations.filter((rec) => rec.outcome !== "needs-data"), [recommendations]);
  const missing = recommendations.length - actionable.length;
  const x2 = actionable.find((rec) => rec.x2Candidate);
  const selectedRec = selectedMatchId ? recommendations.find((rec) => rec.match.id === selectedMatchId) ?? null : null;

  if (authenticated === null) {
    return <main className="authShell"><div className="loginPanel"><h1>MPP Edge Finder</h1><p>Chargement...</p></div></main>;
  }

  if (!authenticated) {
    return <LoginScreen setAuthenticated={setAuthenticated} refresh={refresh} message={message} setMessage={setMessage} />;
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>MPP Edge Finder</h1>
          <p>Probabilités Polymarket publiques + points MPP + foule MPP = pronos classés selon la stratégie active.</p>
        </div>
        <a className="mppLink" href="https://mpp.football/" target="_blank" rel="noreferrer">
          Ouvrir MPP
        </a>
        <button onClick={() => void logout(setAuthenticated)}>Verrouiller</button>
      </header>

      <section className="statusGrid">
        <StatusCard label="Matchs" value={status?.matches ?? 0} />
        <StatusCard label="Snapshots MPP" value={status?.mppSnapshots ?? 0} sub={formatDate(status?.lastMppSync)} />
        <StatusCard label="Snapshots marchés" value={status?.marketSnapshots ?? 0} sub={formatDate(status?.lastPolymarketSync)} />
        <StatusCard
          label="Scraper MPP"
          value={status?.mppAutoScrape ? "auto" : "manuel"}
          sub={status?.lastMppScrapeError ? "login/scrape à vérifier" : status?.mppPollMinutes ? `${status.mppPollMinutes} min` : undefined}
        />
        <StatusCard label="Stratégie" value={status?.mppStrategyMode ?? "chase"} sub={status?.mppStrategyMode === "ev" ? "EV pure" : "remontée"} />
        <StatusCard
          label="Auto MPP"
          value={status?.mppAutoPlay ? "on" : "off"}
          sub={status?.mppAutoPlay ? `${status.mppAutoPlayDryRun ? "dry-run" : "réel"} T-${status.mppAutoPlayLeadSeconds}s` : "manuel"}
        />
        <StatusCard label="Push VPS" value={status?.ntfyConfigured ? "ntfy" : status?.telegramConfigured ? "telegram" : "off"} sub="optionnel" />
      </section>

      {status?.lastMppScrapeError && <div className="message warning">MPP auto: {status.lastMppScrapeError}</div>}

      <section className="actions">
        <button disabled={Boolean(busy)} onClick={() => runAction("poly", () => post("/api/sync/polymarket/run"))}>
          {busy === "poly" ? "Sync..." : "Sync Polymarket"}
        </button>
        <button disabled={Boolean(busy)} onClick={() => runAction("scrape", () => post("/api/scrape/mpp/run"))}>
          {busy === "scrape" ? "Scrape..." : "Scrape MPP Chromium"}
        </button>
        <button disabled={Boolean(busy) || actionable.length === 0} onClick={() => runAction("notify", () => post("/api/notifications/test", {}))}>
          {busy === "notify" ? "Envoi..." : "Test notifications"}
        </button>
        <button disabled={Boolean(busy) || actionable.length === 0} onClick={() => runAction("dryrun", () => post("/api/automation/mpp/apply", { dryRun: true }))}>
          {busy === "dryrun" ? "Test..." : "Dry-run MPP"}
        </button>
        <button disabled={Boolean(busy) || actionable.length === 0} onClick={() => runAction("autoplay", () => post("/api/automation/mpp/apply", { dryRun: false }))}>
          {busy === "autoplay" ? "Saisie..." : "Jouer MPP maintenant"}
        </button>
        <button disabled={browserAlerts === "unsupported" || browserAlerts === "granted"} onClick={() => void enableBrowserAlerts(setBrowserAlerts)}>
          {browserAlerts === "granted" ? "Alertes navigateur actives" : "Activer alertes navigateur"}
        </button>
        <button disabled={Boolean(busy)} onClick={() => void refresh()}>
          Rafraîchir
        </button>
      </section>

      {message && <div className="message">{message}</div>}

      <section className="importBox">
        <div className="importHeader">
          <div>
            <h2>Import MPP sans API payante</h2>
            <p>Depuis MPP connecté: import direct en un clic, ou copie JSON puis colle ici.</p>
          </div>
          <div className="buttonGroup">
            <button disabled={!importBookmarklet} onClick={() => navigator.clipboard.writeText(importBookmarklet)}>
              Copier import direct
            </button>
            <button onClick={() => navigator.clipboard.writeText(bookmarklet)}>Copier JSON</button>
          </div>
        </div>
        <textarea
          placeholder='Colle ici le JSON copié depuis MPP, par exemple [{"type":"text","value":"Vendredi 26 juin"}, ...]'
          value={mppText}
          onChange={(event) => setMppText(event.target.value)}
        />
        <button
          disabled={Boolean(busy) || !mppText.trim()}
          onClick={() => runAction("import", () => post("/api/import/mpp-text", { text: mppText }))}
        >
          {busy === "import" ? "Import..." : "Importer snapshot MPP"}
        </button>
      </section>

      <section className="x2Panel">
        <h2>Spot X2</h2>
        {x2 ? (
          <p>
            Meilleur spot actuel: <strong>{x2.match.homeTeam} - {x2.match.awayTeam}</strong>, reco <strong>{labelOutcome(x2)}</strong>{" "}
            {x2.score ? <strong>{x2.score.home}-{x2.score.away}</strong> : null}, score stratégie {x2.strategyScore.toFixed(1)}, EV {x2.totalEv.toFixed(1)} pts.
          </p>
        ) : (
          <p>Pas encore assez de données pour recommander le X2.</p>
        )}
      </section>

      <section>
        <div className="sectionTitle">
          <h2>Recommandations</h2>
          <span>{actionable.length} exploitables triées par score stratégie{missing ? `, ${missing} à compléter` : ""}</span>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Match</th>
                <th>Heure</th>
                <th>MPP</th>
                <th>Polymarket</th>
                <th>À jouer</th>
                <th>Objectif</th>
                <th>Confiance</th>
                <th>X2</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((rec) => (
                <tr
                  key={rec.match.id}
                  className={`${rec.outcome === "needs-data" ? "muted" : ""} ${rec.match.id === selectedRec?.match.id ? "selected" : ""}`}
                  tabIndex={0}
                  onClick={() => setSelectedMatchId(rec.match.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setSelectedMatchId(rec.match.id);
                  }}
                >
                  <td>
                    <strong>{rec.match.homeTeam}</strong>
                    <span> - </span>
                    <strong>{rec.match.awayTeam}</strong>
                    <small>{rec.reasons[0]}</small>
                  </td>
                  <td>{formatKickoff(rec.match.kickoffUtc)}</td>
                  <td>{rec.mpp ? `${rec.mpp.pointsHome}/${rec.mpp.pointsDraw}/${rec.mpp.pointsAway}` : "à importer"}</td>
                  <td>{rec.market ? `${pct(rec.market.pHome)} / ${pct(rec.market.pDraw)} / ${pct(rec.market.pAway)}` : "à sync"}</td>
                  <td>
                    <strong className="playText">{rec.play.instruction}</strong>
                    {rec.score ? <small>{labelOutcome(rec)}, bonus rareté +{rec.score.estimatedBonus}</small> : null}
                  </td>
                  <td>
                    {rec.strategyScore.toFixed(1)}
                    <small>EV {rec.totalEv.toFixed(1)} | edge {signedNumber(rec.evEdge)}</small>
                  </td>
                  <td><Badge value={rec.confidence} /></td>
                  <td>{rec.x2Candidate ? "meilleur" : rec.x2Rank ? `#${rec.x2Rank}` : "-"}</td>
                  <td>
                    <button
                      className="smallButton"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedMatchId(rec.match.id);
                      }}
                    >
                      Voir
                    </button>
                  </td>
                </tr>
              ))}
              {recommendations.length === 0 && (
                <tr>
                  <td colSpan={9}>Commence par “Sync Polymarket”, puis importe un snapshot MPP.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selectedRec && <MatchDetail rec={selectedRec} history={selectedRec.match.id === selectedMatchId ? history : null} onClose={() => setSelectedMatchId(null)} />}
      </section>
    </main>
  );
}

function LoginScreen({
  setAuthenticated,
  refresh,
  message,
  setMessage
}: {
  setAuthenticated: (value: boolean) => void;
  refresh: () => Promise<void>;
  message: string;
  setMessage: (value: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await post("/api/auth/login", { pin });
      setAuthenticated(true);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setAuthenticated(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="authShell">
      <form className="loginPanel" onSubmit={(event) => void submit(event)}>
        <h1>MPP Edge Finder</h1>
        <p>Accès privé</p>
        <input
          className="pinInput"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
          autoFocus
        />
        <button disabled={busy || pin.length < 4}>{busy ? "Ouverture..." : "Entrer"}</button>
        {message && <div className="message warning">{message}</div>}
      </form>
    </main>
  );
}

function MatchDetail({ rec, history, onClose }: { rec: Recommendation; history: MatchHistoryResponse | null; onClose: () => void }) {
  const marketHistory = history?.marketHistory ?? [];
  const mppHistory = history?.mppHistory ?? [];

  return (
    <aside className="detailPanel">
      <div className="detailHeader">
        <div>
          <h2>{rec.match.homeTeam} - {rec.match.awayTeam}</h2>
          <p>{formatKickoff(rec.match.kickoffUtc)} | {rec.match.phase ?? "phase inconnue"} | {scopeLabel(rec.match.scope)}</p>
        </div>
        <button onClick={onClose}>Fermer</button>
      </div>

      <div className="detailGrid">
        <Metric label="À jouer" value={rec.play.instruction} />
        <Metric label="EV" value={`${rec.totalEv.toFixed(1)} pts`} sub={`edge EV ${signedNumber(rec.evEdge)}`} />
        <Metric label="Objectif" value={`${rec.strategyScore.toFixed(1)} pts`} sub={`${rec.strategy} | leverage ${rec.leverage.toFixed(1)} | foule ${signedPctPoints(rec.crowdEdge)}`} />
        <Metric label="Confiance" value={rec.confidence} sub={rec.x2Candidate ? "spot X2" : rec.x2Rank ? `X2 #${rec.x2Rank}` : "hors X2"} />
        <Metric label="Snapshots" value={`${mppHistory.length} MPP / ${marketHistory.length} marchés`} sub={rec.market ? `vol. ${compactNumber(rec.market.volume)}` : "marché manquant"} />
      </div>

      <div className="detailColumns">
        <section>
          <h3>Issues</h3>
          <dl className="kvList">
            <div><dt>{rec.match.homeTeam}</dt><dd>{issueSummary(rec, "home")}</dd></div>
            <div><dt>Nul</dt><dd>{issueSummary(rec, "draw")}</dd></div>
            <div><dt>{rec.match.awayTeam}</dt><dd>{issueSummary(rec, "away")}</dd></div>
          </dl>
        </section>

        <section>
          <h3>MPP</h3>
          {rec.mpp ? (
            <dl className="kvList">
              <div><dt>Points</dt><dd>{rec.mpp.pointsHome} / {rec.mpp.pointsDraw} / {rec.mpp.pointsAway}</dd></div>
              <div><dt>Foule</dt><dd>{rec.mpp.crowdHomePct}% / {rec.mpp.crowdDrawPct}% / {rec.mpp.crowdAwayPct}%</dd></div>
              <div><dt>Score saisi</dt><dd>{rec.mpp.currentHomeScore ?? "-"}-{rec.mpp.currentAwayScore ?? "-"}</dd></div>
            </dl>
          ) : <p>MPP à importer.</p>}
        </section>

        <section>
          <h3>Polymarket</h3>
          {rec.market ? (
            <dl className="kvList">
              <div><dt>1N2</dt><dd>{pct(rec.market.pHome)} / {pct(rec.market.pDraw)} / {pct(rec.market.pAway)}</dd></div>
              <div><dt>Totals</dt><dd>{rec.market.totals.slice(0, 4).map((total) => `O${total.threshold} ${pct(total.pOver)}`).join(" | ") || "-"}</dd></div>
              <div><dt>Spreads</dt><dd>{rec.market.spreads.slice(0, 3).map((spread) => `${spread.team} ${spread.line}: ${pct(spread.pCover)}`).join(" | ") || "-"}</dd></div>
            </dl>
          ) : <p>Polymarket à synchroniser.</p>}
        </section>
      </div>

      <div className="detailColumns two">
        <section>
          <h3>Raisons</h3>
          <ul className="reasonList">
            {rec.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </section>

        <section>
          <h3>Historique marché</h3>
          <div className="miniTableWrap">
            <table className="miniTable">
              <thead>
                <tr>
                  <th>Sync</th>
                  <th>1</th>
                  <th>N</th>
                  <th>2</th>
                </tr>
              </thead>
              <tbody>
                {marketHistory.slice(0, 8).map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td>{formatDate(snapshot.fetchedAt)}</td>
                    <td>{pct(snapshot.pHome)}</td>
                    <td>{pct(snapshot.pDraw)}</td>
                    <td>{pct(snapshot.pAway)}</td>
                  </tr>
                ))}
                {marketHistory.length === 0 && (
                  <tr><td colSpan={4}>Aucun historique marché.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </aside>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function StatusCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="statusCard">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value}</span>;
}

async function post(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: body == null ? undefined : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as Partial<{ message: string; error: string }>;
    return payload.message || payload.error || text;
  } catch {
    return text;
  }
}

async function checkAuth(setAuthenticated: (value: boolean) => void): Promise<boolean> {
  try {
    const payload = await fetchJson<{ authenticated: boolean }>("/api/auth/status");
    setAuthenticated(payload.authenticated);
    return payload.authenticated;
  } catch {
    setAuthenticated(false);
    return false;
  }
}

async function logout(setAuthenticated: (value: boolean) => void) {
  await post("/api/auth/logout", {}).catch(() => null);
  setAuthenticated(false);
}

async function enableBrowserAlerts(setBrowserAlerts: (value: NotificationPermission | "unsupported") => void) {
  if (typeof Notification === "undefined") {
    setBrowserAlerts("unsupported");
    return;
  }
  setBrowserAlerts(await Notification.requestPermission());
}

function parseEventPayload(event: Event): null | { title: string; body: string; matchId: string } {
  if (!("data" in event) || typeof event.data !== "string") return null;
  try {
    const payload = JSON.parse(event.data) as Partial<{ title: string; body: string; matchId: string }>;
    if (!payload.title || !payload.body || !payload.matchId) return null;
    return { title: payload.title, body: payload.body, matchId: payload.matchId };
  } catch {
    return null;
  }
}

function labelOutcome(rec: Recommendation): string {
  if (rec.outcome === "home") return rec.match.homeTeam;
  if (rec.outcome === "away") return rec.match.awayTeam;
  if (rec.outcome === "draw") return "Nul";
  return "n/a";
}

function issueSummary(rec: Recommendation, outcome: "home" | "draw" | "away"): string {
  const item = rec.outcomeAnalysis[outcome];
  return `EV ${item.expectedPoints.toFixed(1)} | atk ${item.attackScore.toFixed(1)} | foule ${item.crowdPct.toFixed(0)}% | edge ${signedPctPoints(item.crowdEdge)}`;
}

function signedNumber(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function signedPctPoints(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function compactNumber(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function scopeLabel(scope?: string | null): string {
  if (scope === "120min") return "scope MPP 120 min";
  if (scope === "90min") return "scope 90 min";
  return "scope à confirmer";
}

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDate(iso?: string | null): string {
  if (!iso) return "jamais";
  return new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
}

import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { AppStatus, BacktestReport, BacktestRow, MarketSnapshot, MppSnapshot, Recommendation, SyncResult } from "../shared/types.js";

type RecommendationsResponse = { recommendations: Recommendation[] };
type MatchHistoryResponse = { mppHistory: MppSnapshot[]; marketHistory: MarketSnapshot[] };
type BacktestResponse = { backtest: BacktestReport };
type AppView = "live" | "backtest" | "algo";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [view, setView] = useState<AppView>(() => viewFromPath(window.location.pathname));
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [history, setHistory] = useState<MatchHistoryResponse | null>(null);
  const [backtest, setBacktest] = useState<BacktestReport | null>(null);

  async function refresh() {
    const [statusRes, recRes] = await Promise.all([
      fetchJson<AppStatus>("/api/status"),
      fetchJson<RecommendationsResponse>("/api/recommendations?window=120")
    ]);
    setStatus(statusRes);
    setRecommendations(recRes.recommendations);
    if (view === "backtest") {
      const backtestRes = await fetchJson<BacktestResponse>("/api/backtest/mpp");
      setBacktest(backtestRes.backtest);
    }
  }

  function switchView(nextView: AppView) {
    setView(nextView);
    window.history.pushState(null, "", pathForView(nextView));
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
  }, [view]);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/api/events");
    events.addEventListener("sync", () => void refresh());
    events.addEventListener("notification", () => {
      void refresh();
    });
    events.addEventListener("error", () => void refresh());
    return () => events.close();
  }, [authenticated, view]);

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
          <p>Décisions MPP en direct: points, foule, marché Polymarket et saisie automatique.</p>
        </div>
        <div className="topActions">
          <button className={view === "live" ? "activeButton" : ""} onClick={() => switchView("live")}>Live</button>
          <button className={view === "backtest" ? "activeButton" : ""} onClick={() => switchView("backtest")}>Backtest</button>
          <button className={view === "algo" ? "activeButton" : ""} onClick={() => switchView("algo")}>Algo</button>
          <a className="mppLink" href="https://mpp.football/" target="_blank" rel="noreferrer">Ouvrir MPP</a>
          <button onClick={() => void logout(setAuthenticated)}>Verrouiller</button>
        </div>
      </header>

      <section className="statusGrid">
        <StatusCard label="Matchs suivis" value={status?.matches ?? 0} />
        <StatusCard label="MPP" value={formatDate(status?.lastMppSync)} sub={status?.lastMppScrapeError ? "à vérifier" : compactStatus(status?.lastMppScrapeMessage) ?? "scrape auto"} />
        <StatusCard label="Polymarket" value={formatDate(status?.lastPolymarketSync)} sub={compactStatus(status?.lastPolymarketSyncMessage) ?? status?.polymarketLeagueSlug ?? "fwc"} />
        <StatusCard label="Résultats" value={status?.mppResults ?? 0} sub={view === "backtest" && backtest ? `${backtest.playable} simulables` : "backtest dispo"} />
        <StatusCard
          label="Saisie auto"
          value={autoPlayLabel(status)}
          sub={lastAutomationSub(status) ?? autoPlaySub(status)}
        />
        <StatusCard label="Stratégie" value={status?.mppStrategyMode ?? "chase"} sub={status?.mppStrategyMode === "ev" ? "EV pure" : "remontée"} />
      </section>

      {status?.lastMppScrapeError && <div className="message warning">MPP auto: {status.lastMppScrapeError}</div>}

      <section className="actions">
        <button disabled={Boolean(busy)} onClick={() => runAction("poly", () => post("/api/sync/polymarket/run"))}>
          {busy === "poly" ? "Sync..." : "Sync marchés"}
        </button>
        <button disabled={Boolean(busy)} onClick={() => runAction("scrape", () => post("/api/scrape/mpp/run"))}>
          {busy === "scrape" ? "Lecture..." : "Lire MPP"}
        </button>
        {view === "backtest" && (
          <button disabled={Boolean(busy)} onClick={() => runAction("poly-history", () => post("/api/sync/polymarket/history/run"))}>
            {busy === "poly-history" ? "Import..." : "Importer historique"}
          </button>
        )}
        <button disabled={Boolean(busy) || actionable.length === 0} onClick={() => runAction("dryrun", () => post("/api/automation/mpp/apply", { dryRun: true }))}>
          {busy === "dryrun" ? "Test..." : "Tester contrôle MPP"}
        </button>
        <button disabled={Boolean(busy)} onClick={() => void refresh()}>
          Rafraîchir
        </button>
      </section>

      {message && <div className="message">{message}</div>}

      {view === "algo" ? (
        <AlgorithmPage status={status} />
      ) : view === "backtest" ? (
        backtest ? <BacktestPanel backtest={backtest} /> : <section className="x2Panel"><h2>Backtest</h2><p>Chargement...</p></section>
      ) : (
        <LiveView
          recommendations={recommendations}
          actionable={actionable}
          missing={missing}
          x2={x2}
          selectedRec={selectedRec}
          selectedMatchId={selectedMatchId}
          setSelectedMatchId={setSelectedMatchId}
          history={history}
        />
      )}
    </main>
  );
}

function viewFromPath(pathname: string): AppView {
  if (pathname === "/backtest") return "backtest";
  if (pathname === "/algo") return "algo";
  return "live";
}

function pathForView(view: AppView): string {
  if (view === "backtest") return "/backtest";
  if (view === "algo") return "/algo";
  return "/";
}

function LiveView({
  recommendations,
  actionable,
  missing,
  x2,
  selectedRec,
  selectedMatchId,
  setSelectedMatchId,
  history
}: {
  recommendations: Recommendation[];
  actionable: Recommendation[];
  missing: number;
  x2: Recommendation | undefined;
  selectedRec: Recommendation | null;
  selectedMatchId: string | null;
  setSelectedMatchId: (value: string | null) => void;
  history: MatchHistoryResponse | null;
}) {
  return (
    <>
      <section className="x2Panel">
        <h2>Décision prioritaire</h2>
        {x2 ? (
          <p>
            <strong>{x2.match.homeTeam} - {x2.match.awayTeam}</strong> · <strong>{x2.play.instruction}</strong> · objectif {x2.strategyScore.toFixed(1)} · EV {x2.totalEv.toFixed(1)}
          </p>
        ) : (
          <p>Pas encore assez de données synchronisées.</p>
        )}
      </section>

      <section>
        <div className="sectionTitle">
          <h2>Recommandations</h2>
          <span>{actionable.length} jouables{missing ? `, ${missing} à compléter` : ""}</span>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Match</th>
                <th>Heure</th>
                <th>Points MPP</th>
                <th>Marché</th>
                <th>Décision</th>
                <th>Score</th>
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
                    <small>{rec.mpp ? `Foule ${rec.mpp.crowdHomePct}% / ${rec.mpp.crowdDrawPct}% / ${rec.mpp.crowdAwayPct}%` : "MPP manquant"}</small>
                  </td>
                  <td>{formatKickoff(rec.match.kickoffUtc)}</td>
                  <td>
                    {rec.mpp ? `${rec.mpp.pointsHome}/${rec.mpp.pointsDraw}/${rec.mpp.pointsAway}` : "à lire"}
                    {rec.mpp ? <small>Saisi {scoreText(rec.mpp.currentHomeScore, rec.mpp.currentAwayScore)}</small> : null}
                  </td>
                  <td>
                    {rec.market ? `${pct(rec.market.pHome)} / ${pct(rec.market.pDraw)} / ${pct(rec.market.pAway)}` : "à sync"}
                    {rec.market ? <small>{marketTableSummary(rec.market)}</small> : null}
                  </td>
                  <td>
                    <strong className="playText">{rec.play.instruction}</strong>
                    {rec.score ? <small>{labelOutcome(rec)}, bonus rareté +{rec.score.estimatedBonus}</small> : null}
                  </td>
                  <td>
                    {rec.strategyScore.toFixed(1)}
                    <small>EV {rec.totalEv.toFixed(1)} · edge {signedNumber(rec.evEdge)}</small>
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
                  <td colSpan={9}>Commence par “Sync marchés”, puis “Lire MPP”.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selectedRec && <MatchDetail rec={selectedRec} history={selectedRec.match.id === selectedMatchId ? history : null} onClose={() => setSelectedMatchId(null)} />}
      </section>
    </>
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

function BacktestPanel({ backtest }: { backtest: BacktestReport }) {
  const latestRows = backtest.rows.slice(0, 10);
  const bestVariant = backtest.variants.slice().sort((a, b) => b.points - a.points)[0];

  return (
    <section className="backtestPanel">
      <div className="sectionTitle">
        <div>
          <h2>Simulation algo</h2>
          <span>T-{Math.round(backtest.leadSeconds / 60)} min · {backtest.playable}/{backtest.totalResults} matchs simulés</span>
        </div>
        <span>MAJ {formatDate(backtest.generatedAt)}</span>
      </div>

      <div className="backtestGrid">
        <Metric label="Algo actuel" value={`${backtest.botPoints} pts`} sub={`${backtest.correctOutcomes} issues justes · ${backtest.exactScores} exacts`} />
        <Metric label="Compte MPP" value={`${backtest.userPoints} pts`} sub="tous résultats MPP pris en compte" />
        <Metric label="Écart" value={`${signedInteger(backtest.deltaPoints)} pts`} sub={`${backtest.fallbackMarkets} fallback MPP`} />
        <Metric label="Meilleure variante" value={bestVariant ? bestVariant.strategy : "-"} sub={bestVariant ? `${bestVariant.points} pts sur ${bestVariant.playable} matchs` : "à venir"} />
      </div>

      <div className="variantList">
        {backtest.variants.map((variant) => (
          <span className="dataChip" key={variant.strategy}>
            {variant.strategy}: {variant.points} pts · {variant.correctOutcomes}/{variant.playable} issues · {variant.exactScores} exacts
          </span>
        ))}
      </div>

      <div className="miniTableWrap">
        <table className="miniTable backtestTable">
          <thead>
            <tr>
              <th>Match</th>
              <th>Réel</th>
              <th>Algo</th>
              <th>Compte</th>
              <th>Données</th>
            </tr>
          </thead>
          <tbody>
            {latestRows.map((row) => (
              <BacktestTableRow row={row} key={`${row.match.id}-${row.result.id}`} />
            ))}
            {latestRows.length === 0 && (
              <tr><td colSpan={5}>Aucun résultat MPP stocké pour l’instant.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BacktestTableRow({ row }: { row: BacktestRow }) {
  const rec = row.recommendation;
  return (
    <tr className={row.skippedReason ? "muted" : ""}>
      <td>
        <strong>{row.match.homeTeam} - {row.match.awayTeam}</strong>
        <small>{formatKickoff(row.match.kickoffUtc)}</small>
      </td>
      <td>{row.result.actualHomeScore}-{row.result.actualAwayScore}</td>
      <td>
        {row.skippedReason ? row.skippedReason : `${rec?.play.instruction ?? "-"} · ${row.botPoints} pts`}
        {!row.skippedReason && <small>{row.correctOutcome ? "issue juste" : "issue fausse"}{row.exactScore ? " · exact" : ""}</small>}
      </td>
      <td>
        {row.userPoints ?? 0} pts
        <small>{scoreText(row.result.userHomeScore, row.result.userAwayScore)}</small>
      </td>
      <td>
        <small>MPP {formatDate(row.mppSnapshotAt)}</small>
        {row.mppSnapshotMode && <small>{row.mppSnapshotMode === "pre-decision" ? "pré-match" : "historique MPP"}</small>}
        <small>{row.marketSnapshotMode === "mpp-crowd-fallback" ? "Fallback MPP" : `Poly ${formatDate(row.marketSnapshotAt)}`}</small>
      </td>
    </tr>
  );
}

function AlgorithmPage({ status }: { status: AppStatus | null }) {
  const strategy = status?.mppStrategyMode ?? "chase";
  const leadTime = status?.mppAutoPlayLeadSeconds ? leadTimeLabel(status.mppAutoPlayLeadSeconds) : "T-10 min";
  const hourly = status?.mppHourlyAutoPlay ? `toutes les ${status.mppHourlyAutoPlayIntervalMinutes} min` : "manuel";
  const modeLabel = strategy === "ev" ? "EV pure" : "Chase";

  return (
    <section className="algoPage">
      <div className="sectionTitle">
        <div>
          <h2>Fonctionnement de l'algorithme</h2>
          <span>Lecture MPP, probabilités Polymarket, choix du score et contrôle par backtest.</span>
        </div>
        <span>{modeLabel} · {leadTime}</span>
      </div>

      <div className="backtestGrid">
        <Metric label="Mode actif" value={modeLabel} sub={strategy === "ev" ? "maximise l'espérance brute" : "remontée classement avec levier"} />
        <Metric label="Décision auto" value={leadTime} sub={autoPlaySub(status)} />
        <Metric label="Mise à jour" value={hourly} sub="scrape MPP + sync marchés" />
        <Metric label="Historique MPP" value={`${status?.mppResults ?? 0} matchs`} sub="utilisé pour le backtest" />
      </div>

      <div className="algoLayout">
        <section className="algoBlock">
          <h3>Données utilisées</h3>
          <div className="algoFlow">
            <div>
              <strong>MPP</strong>
              <span>points 1/N/2, foule, score déjà saisi, résultats passés et matchs disponibles.</span>
            </div>
            <div>
              <strong>Polymarket</strong>
              <span>probabilités 1/N/2, volume, liquidité, totals et spreads quand le marché les expose.</span>
            </div>
            <div>
              <strong>Matching</strong>
              <span>rapprochement des équipes par noms et alias, puis stockage d'un snapshot horodaté.</span>
            </div>
          </div>
        </section>

        <section className="algoBlock">
          <h3>Calcul de l'issue</h3>
          <ol className="stepList">
            <li>Chaque issue reçoit une probabilité marché: domicile, nul, extérieur.</li>
            <li>Le rendement de base est l'espérance MPP: <code>EV = proba_poly x points_MPP</code>.</li>
            <li>En mode chase, l'algo ajoute du levier si l'issue paie beaucoup et reste assez probable.</li>
            <li>Il récompense les issues sous-jouées par la foule MPP et pénalise les issues surjouées.</li>
            <li>Il retire une pénalité si la probabilité devient trop faible, pour éviter les purs tickets loterie.</li>
          </ol>
        </section>

        <section className="algoBlock">
          <h3>Formule principale</h3>
          <div className="formulaStack">
            <div>
              <span>EV pure</span>
              <code>proba x points</code>
            </div>
            <div>
              <span>Levier</span>
              <code>points x sqrt(proba) x (1 - part_foule)</code>
            </div>
            <div>
              <span>Score chase</span>
              <code>EV + 0.35 x levier + edge_foule - penalites</code>
            </div>
          </div>
          <p>Le score final choisit l'issue avec le meilleur objectif stratégique. Le X2 est ensuite mis sur le match qui a le meilleur score stratégique global.</p>
        </section>

        <section className="algoBlock">
          <h3>Score exact</h3>
          <ol className="stepList">
            <li>L'algo ajuste deux lambdas Poisson pour reproduire les probabilités 1/N/2 Polymarket.</li>
            <li>Si les marchés de totals sont disponibles, ils corrigent le nombre de buts attendu.</li>
            <li>Les scores de 0-0 à 5-5 sont testés, en gardant seulement ceux qui correspondent à l'issue choisie.</li>
            <li>Le bonus rareté estimé vaut +20, +30, +50, +70 ou +100 selon la popularité probable du score.</li>
            <li>Le 0-0 a une petite pénalité, car il ressortait trop souvent dans les tests.</li>
          </ol>
        </section>

        <section className="algoBlock">
          <h3>Automatisation</h3>
          <div className="algoFlow compact">
            <div>
              <strong>Dès disponibilité</strong>
              <span>si un match MPP apparaît sans score, le système peut remplir une recommandation.</span>
            </div>
            <div>
              <strong>Horaire</strong>
              <span>un passage régulier remet à jour MPP et Polymarket pour éviter les matchs oubliés.</span>
            </div>
            <div>
              <strong>{leadTime}</strong>
              <span>la décision proche du match utilise les derniers snapshots disponibles.</span>
            </div>
          </div>
        </section>

        <section className="algoBlock">
          <h3>Backtest</h3>
          <p>La page Backtest rejoue les résultats MPP passés avec les cotes Polymarket historiques avant match quand elles existent.</p>
          <p>Quand Polymarket manque pour un vieux match, le test utilise un fallback basé sur la foule MPP. Ces lignes sont marquées fallback et sont moins fiables que les snapshots Polymarket réels.</p>
        </section>

        <section className="algoBlock wide">
          <h3>Exemple rapide</h3>
          <div className="exampleGrid">
            <div>
              <span>Polymarket</span>
              <strong>Belgique 58% · nul 24% · adversaire 18%</strong>
            </div>
            <div>
              <span>Points MPP</span>
              <strong>Belgique 44 · nul 80 · adversaire 120</strong>
            </div>
            <div>
              <span>EV brute</span>
              <strong>25.5 · 19.2 · 21.6</strong>
            </div>
            <div>
              <span>Décision</span>
              <strong>Belgique si son score chase reste devant</strong>
            </div>
          </div>
          <p>Si la Belgique est peu jouée par la foule MPP, son score chase monte encore. Si au contraire tout le monde joue Belgique, l'algo peut préférer une issue un peu moins probable mais beaucoup plus rentable.</p>
        </section>

        <section className="algoBlock wide">
          <h3>Limites à garder en tête</h3>
          <ul className="reasonList">
            <li>En phase à élimination directe, MPP peut compter 120 minutes alors que certains marchés externes sont en 90 minutes; la confiance est donc réduite.</li>
            <li>Les cotes bougent: une recommandation ancienne doit être relue avant saisie.</li>
            <li>Le bonus de score exact est estimé, pas directement donné par MPP.</li>
          </ul>
        </section>
      </div>
    </section>
  );
}

function MatchDetail({ rec, history, onClose }: { rec: Recommendation; history: MatchHistoryResponse | null; onClose: () => void }) {
  const marketHistory = history?.marketHistory ?? [];
  const mppHistory = history?.mppHistory ?? [];
  const selectedAnalysis = rec.outcome === "needs-data" ? null : rec.outcomeAnalysis[rec.outcome];

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
        <Metric label="Marché" value={rec.market ? `${pct(rec.market.pHome)} / ${pct(rec.market.pDraw)} / ${pct(rec.market.pAway)}` : "manquant"} sub={rec.market ? `vol. ${compactNumber(rec.market.volume)} | liq. ${compactNumber(rec.market.liquidity)}` : "Polymarket à sync"} />
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
          ) : <p>MPP à lire.</p>}
        </section>

        <section>
          <h3>Polymarket</h3>
          {rec.market ? (
            <dl className="kvList">
              <div><dt>1N2 proba</dt><dd>{pct(rec.market.pHome)} / {pct(rec.market.pDraw)} / {pct(rec.market.pAway)}</dd></div>
              <div><dt>Cotes implicites</dt><dd>{odds(rec.market.pHome)} / {odds(rec.market.pDraw)} / {odds(rec.market.pAway)}</dd></div>
              <div><dt>Volume</dt><dd>{compactNumber(rec.market.volume)} | liq. {compactNumber(rec.market.liquidity)}</dd></div>
              <div><dt>Sync</dt><dd>{formatDate(rec.market.fetchedAt)}</dd></div>
              <div><dt>Slug</dt><dd>{rec.match.polymarketSlug ?? "-"}</dd></div>
            </dl>
          ) : <p>Polymarket à synchroniser.</p>}
        </section>
      </div>

      {rec.market && (
        <div className="marketBands">
          <section>
            <h3>Totals Polymarket</h3>
            <div className="chipList">
              {rec.market.totals.slice(0, 8).map((total) => (
                <span className="dataChip" key={total.threshold}>O{total.threshold}: {pct(total.pOver)} / U{total.threshold}: {pct(total.pUnder)}</span>
              ))}
              {rec.market.totals.length === 0 && <span className="dataChip mutedChip">aucun total</span>}
            </div>
          </section>

          <section>
            <h3>Spreads Polymarket</h3>
            <div className="chipList">
              {rec.market.spreads.slice(0, 10).map((spread, index) => (
                <span className="dataChip" key={`${spread.team}-${spread.line}-${index}`}>{spreadLabel(rec, spread.team)} {spread.line}: {pct(spread.pCover)}</span>
              ))}
              {rec.market.spreads.length === 0 && <span className="dataChip mutedChip">aucun spread</span>}
            </div>
          </section>
        </div>
      )}

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

      {selectedAnalysis && rec.score && (
        <section className="calcPanel">
          <h3>Calcul reco</h3>
          <div className="calcGrid">
            <div>
              <span>Issue choisie</span>
              <strong>{labelOutcome(rec)}</strong>
              <small>{pct(selectedAnalysis.probability)} x {selectedAnalysis.points} pts = {selectedAnalysis.expectedPoints.toFixed(1)} pts EV</small>
            </div>
            <div>
              <span>Objectif {rec.strategy}</span>
              <strong>{selectedAnalysis.attackScore.toFixed(1)} + {rec.score.objective.toFixed(1)} = {rec.strategyScore.toFixed(1)}</strong>
              <small>leverage {selectedAnalysis.leverage.toFixed(1)} | foule {signedPctPoints(selectedAnalysis.crowdEdge)}</small>
            </div>
            <div>
              <span>Score exact</span>
              <strong>{rec.score.home}-{rec.score.away}</strong>
              <small>{pct(rec.score.probability)} x bonus +{rec.score.estimatedBonus} = {rec.score.expectedBonusPoints.toFixed(1)} pts EV</small>
            </div>
          </div>
        </section>
      )}
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

function autoPlayLabel(status?: AppStatus | null): string {
  if (!status) return "off";
  const modes = [
    status.mppAvailableAutoPlay ? "dès dispo" : "",
    status.mppHourlyAutoPlay ? "horaire" : "",
    status.mppAutoPlay ? leadTimeLabel(status.mppAutoPlayLeadSeconds) : ""
  ].filter(Boolean);
  return modes.length ? modes.join(" + ") : "off";
}

function autoPlaySub(status?: AppStatus | null): string {
  if (!status) return "manuel";
  if (status.mppAvailableAutoPlay) {
    const mode = status.mppAvailableAutoPlayDryRun ? "dry-run" : "réel";
    const hourly = status.mppHourlyAutoPlay ? ` | horaire ${status.mppHourlyAutoPlayIntervalMinutes} min` : "";
    return `${mode} scores vides${hourly}`;
  }
  if (status.mppHourlyAutoPlay) {
    return `${status.mppHourlyAutoPlayDryRun ? "dry-run" : "réel"} toutes les ${status.mppHourlyAutoPlayIntervalMinutes} min`;
  }
  if (status.mppAutoPlay) return `${status.mppAutoPlayDryRun ? "dry-run" : "réel"} ${leadTimeLabel(status.mppAutoPlayLeadSeconds)}`;
  return "manuel";
}

function lastAutomationSub(status?: AppStatus | null): string | undefined {
  if (!status) return undefined;
  const items = [
    { at: status.lastT10AutoPlay, message: status.lastT10AutoPlayMessage },
    { at: status.lastHourlyAutoPlay, message: status.lastHourlyAutoPlayMessage },
    { at: status.lastAvailableAutoPlay, message: status.lastAvailableAutoPlayMessage }
  ]
    .filter((item): item is { at: string; message: string } => Boolean(item.at && item.message))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = items[0];
  return latest ? `${formatDate(latest.at)} | ${compactStatus(latest.message)}` : undefined;
}

function compactStatus(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

function leadTimeLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `T-${seconds / 60} min`;
  return `T-${seconds}s`;
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

function marketTableSummary(market: MarketSnapshot): string {
  const total = closestTotal(market, 2.5) ?? market.totals[0];
  const totalText = total ? `O${total.threshold} ${pct(total.pOver)}` : "totals -";
  return `Vol ${compactNumber(market.volume)} | Liq ${compactNumber(market.liquidity)} | ${totalText}`;
}

function closestTotal(market: MarketSnapshot, threshold: number) {
  return market.totals
    .slice()
    .sort((a, b) => Math.abs(a.threshold - threshold) - Math.abs(b.threshold - threshold))[0];
}

function odds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return `@${(1 / value).toFixed(2)}`;
}

function spreadLabel(rec: Recommendation, team: "home" | "away" | "unknown"): string {
  if (team === "home") return rec.match.homeTeam;
  if (team === "away") return rec.match.awayTeam;
  return "Équipe";
}

function scoreText(home?: number | null, away?: number | null): string {
  return home == null || away == null ? "-" : `${home}-${away}`;
}

function signedNumber(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function signedInteger(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
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

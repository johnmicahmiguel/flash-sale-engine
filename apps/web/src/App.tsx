import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  DependenciesHealth,
  DependencyConnectionStatus,
  PurchaseResult,
  SaleProduct,
  SaleStatusResponse,
  SecuredItemCheckResponse,
  SimulationStatsResponse,
} from "@flash-sale/shared-types";
import {
  apiBaseUrl,
  checkSecuredItem,
  fetchHealth,
  fetchSaleStatus,
  resetSale,
  submitPurchase,
  verifySimulationLabUnlock,
} from "./lib/api";
import "./App.css";

type LoadingTarget =
  | "status"
  | "purchase"
  | "check"
  | "reset"
  | "simulation"
  | null;

/**
 * Modal-only union: extends PurchaseResult with a synthetic "network_error"
 * variant for cases where the request itself failed (no JSON body).
 */
type PurchaseOutcome =
  | PurchaseResult
  | { status: "network_error" };

const USER_ID_STORAGE_KEY = "flash-sale-user-id";
/** Session-only: skip password prompts until tab closes */
const SIMLAB_UNLOCK_SESSION_KEY = "flash-sale-simlab-unlocked";
const EMPTY_SIMULATION_STATS: SimulationStatsResponse = {
  total: 0,
  inFlight: 0,
  success: 0,
  alreadyPurchased: 0,
  soldOut: 0,
  saleEnded: 0,
  failed: 0,
};

function App() {
  const [saleStatus, setSaleStatus] = useState<SaleStatusResponse | null>(null);
  const [purchaseResult, setPurchaseResult] = useState<PurchaseOutcome | null>(
    null,
  );
  const [securedCheck, setSecuredCheck] =
    useState<SecuredItemCheckResponse | null>(null);
  const [securedCheckError, setSecuredCheckError] = useState<string | null>(
    null,
  );
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [loading, setLoading] = useState<LoadingTarget>(null);
  const [userId, setUserId] = useState(() => getInitialUserId());
  const [resetStock, setResetStock] = useState(100);
  const [resetStartsAt, setResetStartsAt] = useState("");
  const [resetEndsAt, setResetEndsAt] = useState("");
  const [simulationStats, setSimulationStats] = useState<SimulationStatsResponse>(
    EMPTY_SIMULATION_STATS,
  );
  const [depsHealth, setDepsHealth] = useState<DependenciesHealth | null>(
    null,
  );
  const [simLabVisible, setSimLabVisible] = useState(false);
  const [simLabModalOpen, setSimLabModalOpen] = useState(false);
  const [simLabPw, setSimLabPw] = useState("");
  const [simLabError, setSimLabError] = useState<string | null>(null);
  const [simLabVerifying, setSimLabVerifying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const resetWindowInitialized = useRef(false);

  function simLabSessionUnlocked(): boolean {
    try {
      return sessionStorage.getItem(SIMLAB_UNLOCK_SESSION_KEY) === "1";
    } catch {
      return false;
    }
  }

  const product = saleStatus?.product ?? null;
  const canPurchase = saleStatus?.status === "active" && loading === null;
  const isBusy = loading !== null;
  const resetWindowValid = isResetWindowValid(resetStartsAt, resetEndsAt);

  useEffect(() => {
    localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  }, [userId]);

  useEffect(() => {
    void handleRefreshStatus();
  }, []);

  useEffect(() => {
    if (!saleStatus || resetWindowInitialized.current) return;
    setResetStartsAt(toDateTimeLocalInput(saleStatus.startsAt));
    setResetEndsAt(toDateTimeLocalInput(saleStatus.endsAt));
    resetWindowInitialized.current = true;
  }, [saleStatus]);

  // Tick once a second so the countdown updates live.
  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  // When the countdown crosses endsAt, ask the server for the fresh status.
  const endedRefireGuard = useRef(false);
  useEffect(() => {
    if (!saleStatus) return;
    const ended = now >= new Date(saleStatus.endsAt).getTime();
    if (ended && !endedRefireGuard.current && saleStatus.status === "active") {
      endedRefireGuard.current = true;
      void refreshStatusSilently();
    }
    if (!ended) {
      endedRefireGuard.current = false;
    }
    // refreshStatusSilently is stable and only updates local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, saleStatus]);

  function handleDevModeToggle(wantOn: boolean) {
    setSimLabError(null);
    if (!wantOn) {
      setSimLabVisible(false);
      setSimLabModalOpen(false);
      return;
    }
    if (simLabSessionUnlocked()) {
      setSimLabVisible(true);
      return;
    }
    setSimLabPw("");
    setSimLabModalOpen(true);
  }

  async function handleSimulationLabUnlockSubmit(event: FormEvent) {
    event.preventDefault();
    setSimLabVerifying(true);
    setSimLabError(null);
    const r = await verifySimulationLabUnlock({ password: simLabPw });
    setSimLabVerifying(false);
    if (r.ok && r.data?.ok === true) {
      sessionStorage.setItem(SIMLAB_UNLOCK_SESSION_KEY, "1");
      setSimLabVisible(true);
      setSimLabModalOpen(false);
      setSimLabPw("");
      return;
    }
    const msg =
      r.status === 401
        ? "Wrong password."
        : r.error ?? "Unlock failed.";
    setSimLabError(msg);
  }

  async function refreshDepsHealth() {
    const r = await fetchHealth();
    if (r.ok && r.data) {
      setDepsHealth(r.data.dependencies);
    }
  }

  async function handleRefreshStatus() {
    setLoading("status");
    const [saleR] = await Promise.all([
      fetchSaleStatus(),
      refreshDepsHealth(),
    ]);
    const r = saleR;
    if (r.ok && r.data) {
      setSaleStatus(r.data);
      syncSimulationStats(r.data);
    }
    setLoading(null);
  }

  async function refreshStatusSilently() {
    const r = await fetchSaleStatus();
    if (r.ok && r.data) {
      setSaleStatus(r.data);
      syncSimulationStats(r.data);
    }
  }

  function syncSimulationStats(status: SaleStatusResponse) {
    if (status.simulation) {
      setSimulationStats(status.simulation);
    }
  }

  async function handlePurchase() {
    setLoading("purchase");
    setPurchaseResult(null);
    setSecuredCheck(null);
    setSecuredCheckError(null);
    setPurchaseModalOpen(false);
    const r = await submitPurchase({ userId });
    if (r.ok && r.data) {
      setPurchaseResult(r.data);
      if (r.data.status === "success") {
        setSecuredCheck({
          userId: r.data.userId,
          secured: true,
          purchasedAt: r.data.purchasedAt,
        });
      }
      setPurchaseModalOpen(true);
    } else {
      setPurchaseResult({ status: "network_error" });
      setPurchaseModalOpen(true);
    }
    await refreshStatusSilently();
    setLoading(null);
  }

  async function handleCheckSecuredItem() {
    setLoading("check");
    setSecuredCheck(null);
    setSecuredCheckError(null);
    const r = await checkSecuredItem({ userId });
    if (r.ok && r.data) {
      setSecuredCheck(r.data);
    } else {
      setSecuredCheckError(r.error ?? "Could not check secured item.");
    }
    setLoading(null);
  }

  async function handleResetSale() {
    if (!resetWindowValid) return;
    setLoading("reset");
    setPurchaseResult(null);
    setSecuredCheck(null);
    setSecuredCheckError(null);
    setPurchaseModalOpen(false);
    setSimulationStats(EMPTY_SIMULATION_STATS);
    const r = await resetSale({
      totalStock: resetStock,
      startsAt: dateTimeLocalToIso(resetStartsAt),
      endsAt: dateTimeLocalToIso(resetEndsAt),
    });
    if (r.ok && r.data) {
      setSaleStatus(r.data.sale);
      setResetStartsAt(toDateTimeLocalInput(r.data.sale.startsAt));
      setResetEndsAt(toDateTimeLocalInput(r.data.sale.endsAt));
    }
    setLoading(null);
  }

  async function handleSimulation(total: number) {
    setLoading("simulation");
    setPurchaseResult(null);
    setPurchaseModalOpen(false);
    await refreshStatusSilently();

    const poll = window.setInterval(() => {
      void refreshStatusSilently();
    }, 250);

    const batchId = crypto.randomUUID().slice(0, 8);
    const embedDupUserId = `sim-${batchId}-embed-dup`;

    try {
      const requests = Array.from({ length: total }, (_, index) => {
        const simulatedUserId =
          index % 6 === 0 ? embedDupUserId : `sim-${batchId}-${index}`;

        return submitPurchase({ userId: simulatedUserId }).catch(
          () => undefined,
        );
      });

      await Promise.all(requests);
      await refreshStatusSilently();
    } finally {
      window.clearInterval(poll);
      setLoading(null);
    }
  }

  function handleNewUser() {
    setUserId(createUserId());
    setPurchaseResult(null);
    setSecuredCheck(null);
    setSecuredCheckError(null);
    setPurchaseModalOpen(false);
  }

  function dismissPurchaseModal() {
    setPurchaseModalOpen(false);
  }

  return (
    <div className="page">
      <header className="nav">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            F
          </div>
          <span>Flash Sale Engine</span>
        </div>
        <div className="nav-right">
          <div
            className="nav-meta"
            role="status"
            aria-label="Database and cache connection status"
          >
            <DependencyTag
              label="MongoDB"
              state={depsHealth?.mongo ?? "unknown"}
            />
            <DependencyTag
              label="Redis"
              state={depsHealth?.redis ?? "unknown"}
            />
          </div>
          <label className="dev-mode">
            <span className="dev-mode__label">Dev mode</span>
            <input
              type="checkbox"
              role="switch"
              className="dev-mode__input"
              checked={simLabVisible}
              onChange={(event) =>
                handleDevModeToggle(event.target.checked)
              }
              aria-label="Dev mode: show Simulation Lab"
            />
            <span className="dev-mode__track" aria-hidden="true">
              <span className="dev-mode__thumb" />
            </span>
          </label>
        </div>
      </header>

      <main className="container">
        <section className="sale-grid" aria-label="Flash sale">
          <ProductHero
            saleStatus={saleStatus}
            product={product}
            now={now}
          />

          <div className="card purchase-card">
            <header className="card-head">
              <h2>Claim your pair</h2>
              <p>One per customer. No backorders.</p>
            </header>

            <div className="card-body">
              <label className="field">
                <span>Username</span>
                <div className="input-with-action">
                  <input
                    value={userId}
                    onChange={(event) => {
                      setUserId(event.target.value);
                      setSecuredCheck(null);
                      setSecuredCheckError(null);
                    }}
                    placeholder="jane.doe"
                  />
                  <button
                    type="button"
                    className="input-icon-btn"
                    onClick={handleNewUser}
                    disabled={loading !== null}
                    aria-label="Generate new username"
                    title="Generate new username"
                  >
                    ↻
                  </button>
                </div>
              </label>

              <div className="actions purchase-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-buy"
                  onClick={handlePurchase}
                  disabled={!canPurchase || userId.trim().length === 0}
                >
                  {loading === "purchase" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : null}
                  <span>
                    {loading === "purchase"
                      ? "Buying…"
                      : product
                        ? `Buy now · ${formatPrice(product.priceCents, product.currency)}`
                        : "Buy now"}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => void handleCheckSecuredItem()}
                  disabled={loading !== null || userId.trim().length === 0}
                >
                  {loading === "check" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : null}
                  Check secured item
                </button>
              </div>
              <SecuredItemCheckPanel
                check={securedCheck}
                error={securedCheckError}
              />
            </div>
          </div>
        </section>

        {simLabVisible ? (
          <section className="card simulation-card">
            <header className="card-head">
              <h2>Simulation Lab</h2>
            </header>

            <div className="card-body">
              <div className="simulation-reset">
                <label className="field compact-field">
                  <span>Reset stock</span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={resetStock}
                    onChange={(event) =>
                      setResetStock(
                        Number.parseInt(event.target.value, 10) || 1,
                      )
                    }
                  />
                </label>
                <label className="field compact-field">
                  <span>Starts at</span>
                  <input
                    type="datetime-local"
                    value={resetStartsAt}
                    onChange={(event) => setResetStartsAt(event.target.value)}
                  />
                </label>
                <label className="field compact-field">
                  <span>Ends at</span>
                  <input
                    type="datetime-local"
                    value={resetEndsAt}
                    onChange={(event) => setResetEndsAt(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleResetSale}
                  disabled={isBusy || !resetWindowValid}
                >
                  {loading === "reset" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : null}
                  Reset sale
                </button>
              </div>
              {!resetWindowValid ? (
                <p className="field-hint field-hint--error">
                  End time must be after start time.
                </p>
              ) : null}

              <div className="actions">
                {[50, 100, 500, 1000].map((count) => (
                  <button
                    key={count}
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleSimulation(count)}
                    disabled={isBusy}
                  >
                    Simulate {count} buyers
                  </button>
                ))}
              </div>

              <SimulationStatsPanel stats={simulationStats} />
            </div>
          </section>
        ) : null}
      </main>

      {purchaseModalOpen ? (
        <PurchaseResultModal
          result={purchaseResult}
          product={product}
          onDismiss={dismissPurchaseModal}
        />
      ) : null}

      {simLabModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setSimLabModalOpen(false)}
        >
          <div
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="simlab-unlock-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-stack">
              <h3 id="simlab-unlock-title" className="modal-title">
                Unlock Simulation Lab
              </h3>
              <p className="modal-lede">
                Enter the demo password configured on the API.
              </p>
              <form
                className="modal-form"
                onSubmit={(event) =>
                  void handleSimulationLabUnlockSubmit(event)
                }
              >
                <label className="field modal-field">
                  <span>Password</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={simLabPw}
                    onChange={(event) => setSimLabPw(event.target.value)}
                    disabled={simLabVerifying}
                  />
                </label>
                {simLabError ? (
                  <p className="modal-error" role="alert">
                    {simLabError}
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setSimLabModalOpen(false)}
                    disabled={simLabVerifying}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={simLabVerifying || simLabPw.trim().length === 0}
                  >
                    {simLabVerifying ? (
                      <span className="spinner" aria-hidden="true" />
                    ) : null}
                    {simLabVerifying ? "Checking…" : "Unlock"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="footer">
        <span>Flash Sale Engine · v0.0.1</span>
        <span className="mono">{apiBaseUrl}</span>
      </footer>
    </div>
  );
}

function ProductHero({
  saleStatus,
  product,
  now,
}: {
  saleStatus: SaleStatusResponse | null;
  product: SaleProduct | null;
  now: number;
}) {
  if (!saleStatus || !product) {
    return (
      <div className="hero hero--loading" aria-busy="true">
        <span className="hero__skeleton" />
      </div>
    );
  }

  const status = saleStatus.status;
  const remaining = saleStatus.remainingStock;
  const total = saleStatus.totalStock || product.editionTotal;
  const sold = Math.max(0, total - remaining);
  const remainingPct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const savingsPct =
    product.originalPriceCents > 0
      ? Math.round(
          ((product.originalPriceCents - product.priceCents) /
            product.originalPriceCents) *
            100,
        )
      : 0;

  const endsAtMs = new Date(saleStatus.endsAt).getTime();
  const startsAtMs = new Date(saleStatus.startsAt).getTime();
  const targetMs = status === "upcoming" ? startsAtMs : endsAtMs;
  const countdown = formatCountdown(Math.max(0, targetMs - now));

  return (
    <div className={`hero hero--${status}`}>
      <div className="hero__top">
        <span className="hero__edition">
          Edition {pad3(product.editionNumber)} / {pad3(product.editionTotal)}
        </span>
        <span className={`hero__pill hero__pill--${status}`}>
          {status === "active" ? (
            <>
              <span className="hero__pulse" aria-hidden="true" />
              Live now
            </>
          ) : (
            statusLabel(status)
          )}
        </span>
      </div>

      <div className="hero__product" aria-hidden="true">
        <span className="hero__product-shadow" />
        <span className="hero__emoji">{product.imageEmoji}</span>
      </div>

      <div className="hero__title">
        <h1>{product.name}</h1>
        <p>{product.tagline}</p>
      </div>

      <div className="hero__price-row">
        <strong className="hero__price">
          {formatPrice(product.priceCents, product.currency)}
        </strong>
        {product.originalPriceCents > product.priceCents ? (
          <>
            <span className="hero__price-was">
              {formatPrice(product.originalPriceCents, product.currency)}
            </span>
            {savingsPct > 0 ? (
              <span className="hero__save">−{savingsPct}%</span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="hero__countdown" aria-live="polite">
        <span className="hero__countdown-label">
          {status === "upcoming" ? "Starts in" : "Ends in"}
        </span>
        <span className="hero__countdown-digits">{countdown}</span>
      </div>

      <div className="hero__stock">
        <div className="hero__stock-row">
          <span>{remaining.toLocaleString()} of {total.toLocaleString()} left</span>
          <span className="hero__stock-sold">{sold.toLocaleString()} sold</span>
        </div>
        <div className="hero__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remainingPct)}>
          <span style={{ width: `${remainingPct}%` }} />
        </div>
      </div>
    </div>
  );
}

function PurchaseResultModal({
  result,
  product,
  onDismiss,
}: {
  result: PurchaseOutcome | null;
  product: SaleProduct | null;
  onDismiss: () => void;
}) {
  const variant = useMemo(() => resolveResultVariant(result), [result]);
  if (!variant) return null;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className={`modal-panel result-modal result-modal--${variant.tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="purchase-result-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-stack">
          <div className={`result-modal__icon result-modal__icon--${variant.tone}`} aria-hidden="true">
            {variant.glyph}
          </div>
          <h3 id="purchase-result-title" className="modal-title">
            {variant.title}
          </h3>
          <p className="modal-lede">{variant.body}</p>
          {variant.detail ? (
            <p className="result-modal__detail">{variant.detail}</p>
          ) : null}
          {variant.tone === "ok" && product ? (
            <div className="result-modal__receipt">
              <span>{product.imageEmoji}</span>
              <div>
                <strong>{product.name}</strong>
                <span>
                  {formatPrice(product.priceCents, product.currency)}
                  {" · "}Edition {pad3(product.editionNumber)} / {pad3(product.editionTotal)}
                </span>
              </div>
            </div>
          ) : null}
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDismiss}
            >
              {variant.cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ResultVariant {
  tone: "ok" | "warn" | "err" | "info";
  title: string;
  body: string;
  detail?: string;
  glyph: string;
  cta: string;
}

function resolveResultVariant(result: PurchaseOutcome | null): ResultVariant | null {
  if (!result) return null;
  switch (result.status) {
    case "success":
      return {
        tone: "ok",
        glyph: "✓",
        title: "You got a pair!",
        body: "Your purchase is locked in. Inventory has been decremented.",
        detail: `Buyer: ${result.userId} · ${new Date(result.purchasedAt).toLocaleTimeString()}`,
        cta: "Done",
      };
    case "already_purchased":
      return {
        tone: "info",
        glyph: "i",
        title: "You already claimed yours",
        body: "Only one per customer. Switch user to make another attempt.",
        cta: "Got it",
      };
    case "sold_out":
      return {
        tone: "err",
        glyph: "✕",
        title: "Sold out",
        body: "Every pair from this drop has been claimed.",
        cta: "Close",
      };
    case "sale_not_active":
      return {
        tone: "warn",
        glyph: "!",
        title: "Sale is not active",
        body: "The drop window has ended or hasn't started yet.",
        cta: "Close",
      };
    case "network_error":
      return {
        tone: "err",
        glyph: "!",
        title: "Something went wrong",
        body: "We couldn't reach the sale service. Check the connection and try again.",
        cta: "Close",
      };
    default:
      return null;
  }
}

function SecuredItemCheckPanel({
  check,
  error,
}: {
  check: SecuredItemCheckResponse | null;
  error: string | null;
}) {
  if (!check && !error) return null;

  if (error) {
    return (
      <p className="secured-check secured-check--error" role="alert">
        {error}
      </p>
    );
  }

  if (!check) return null;

  return (
    <p
      className={`secured-check secured-check--${check.secured ? "ok" : "miss"}`}
      role="status"
    >
      {check.secured
        ? `Secured for ${check.userId}${check.purchasedAt ? ` at ${new Date(check.purchasedAt).toLocaleString()}` : ""}.`
        : `No secured item found for ${check.userId}.`}
    </p>
  );
}

function SimulationStatsPanel({ stats }: { stats: SimulationStatsResponse }) {
  return (
    <div className="simulation-stats" aria-live="polite">
      <Stat label="In flight" value={stats.inFlight} />
      <Stat label="Success" value={stats.success} tone="ok" emphasize />
      <Stat label="Sold out" value={stats.soldOut} />
      <Stat label="Already purchased" value={stats.alreadyPurchased} />
      <Stat label="After sale end" value={stats.saleEnded} tone="warn" />
      <Stat label="Failed" value={stats.failed} tone="err" />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "ok" | "err" | "warn";
  emphasize?: boolean;
}) {
  return (
    <div
      className={`stat stat-${tone}${emphasize ? " stat-emphasize-success" : ""}`}
    >
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function DependencyTag({
  label,
  state,
}: {
  label: string;
  state: DependencyConnectionStatus | "unknown";
}) {
  const mod =
    state === "unknown"
      ? "pending"
      : state === "connected"
        ? "live"
        : state === "disconnected"
          ? "down"
          : "unset";
  const short =
    state === "unknown"
      ? "…"
      : state === "connected"
        ? "live"
        : state === "disconnected"
          ? "down"
          : "unset";

  const ariaLabel =
    state === "unknown"
      ? `${label}, checking connection`
      : state === "connected"
        ? `${label} connected`
        : state === "disconnected"
          ? `${label} disconnected`
          : `${label} not configured`;

  return (
    <span
      className={`dependency-tag dependency-tag--${mod}`}
      aria-label={ariaLabel}
    >
      <span className="dependency-tag__name">{label}</span>
      <span className="dependency-tag__sep" aria-hidden="true">
        ·
      </span>
      <span className="dependency-tag__state">{short}</span>
    </span>
  );
}

const HANDLE_ADJECTIVES = [
  "calm",
  "swift",
  "lucky",
  "quiet",
  "bright",
  "brave",
  "gentle",
  "mighty",
  "silver",
  "amber",
  "rapid",
  "keen",
] as const;

const HANDLE_NOUNS = [
  "river",
  "mesa",
  "haven",
  "ridge",
  "pixel",
  "tiger",
  "ocean",
  "apple",
  "north",
  "spark",
  "meadow",
  "falcon",
] as const;

const HANDLE_SUFFIX_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

function randomHandleSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) {
    s += HANDLE_SUFFIX_CHARS[bytes[i]! % HANDLE_SUFFIX_CHARS.length]!;
  }
  return s;
}

function getInitialUserId(): string {
  return localStorage.getItem(USER_ID_STORAGE_KEY) ?? createUserId();
}

function createUserId(): string {
  const i = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const j = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const adj = HANDLE_ADJECTIVES[i % HANDLE_ADJECTIVES.length];
  const noun = HANDLE_NOUNS[j % HANDLE_NOUNS.length];
  return `${adj}-${noun}-${randomHandleSuffix(4)}`;
}

function toDateTimeLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // datetime-local expects wall-clock local time, while the API stores ISO UTC.
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isResetWindowValid(startsAt: string, endsAt: string): boolean {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return (
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    end > start
  );
}

function statusLabel(status: SaleStatusResponse["status"]): string {
  switch (status) {
    case "active":
      return "Live now";
    case "sold_out":
      return "Sold out";
    case "ended":
      return "Ended";
    case "upcoming":
      return "Starts soon";
    default:
      return "Unknown";
  }
}

function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(0)}`;
  }
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export default App;

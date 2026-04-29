import { useState } from "react";
import {
  apiBaseUrl,
  fetchHealth,
  fetchHello,
  type ApiResult,
} from "./lib/api";
import "./App.css";

type AnyResult = ApiResult<unknown>;
type LoadingTarget = "hello" | "health" | null;

function App() {
  const [result, setResult] = useState<AnyResult | null>(null);
  const [loading, setLoading] = useState<LoadingTarget>(null);

  async function handlePing() {
    setLoading("hello");
    const r = await fetchHello();
    setResult(r);
    setLoading(null);
  }

  async function handleHealth() {
    setLoading("health");
    const r = await fetchHealth();
    setResult(r);
    setLoading(null);
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
        <div className="nav-meta">
          <span className="tag">Phase 4 · SST + Actions</span>
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <span className="eyebrow">Skeleton ready</span>
          <h1>A high-throughput flash sale, built honestly.</h1>
          <p>
            Monorepo scaffold for a Senior Full Stack assessment. The API and
            web client are wired up — start by pinging the server below.
          </p>
        </section>

        <section className="card">
          <header className="card-head">
            <h2>API connection</h2>
            <p>
              Trigger a request to the NestJS server to verify your local
              environment.
            </p>
          </header>

          <div className="card-body">
            <div className="endpoint" aria-label="Default endpoint">
              <span className="method">GET</span>
              <span>{apiBaseUrl}/</span>
            </div>

            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handlePing}
                disabled={loading !== null}
              >
                {loading === "hello" ? (
                  <span className="spinner" aria-hidden="true" />
                ) : null}
                {loading === "hello" ? "Pinging…" : "Ping API"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleHealth}
                disabled={loading !== null}
              >
                {loading === "health" ? (
                  <span className="spinner" aria-hidden="true" />
                ) : null}
                {loading === "health" ? "Checking…" : "Check /health"}
              </button>
            </div>

            <div className="response" aria-live="polite">
              {result ? <ResponsePanel result={result} /> : <EmptyState />}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>Flash Sale Engine · v0.0.1</span>
        <span className="mono">{apiBaseUrl}</span>
      </footer>
    </div>
  );
}

function ResponsePanel({ result }: { result: AnyResult }) {
  const success = result.ok && result.error === null;
  const label = success
    ? `${result.status} OK`
    : result.status === 0
      ? "FAILED"
      : `${result.status} ERROR`;

  return (
    <>
      <div className="response-meta">
        <span className={`status-pill ${success ? "ok" : "err"}`}>
          <span className="status-dot" aria-hidden="true" />
          {label}
        </span>
        <span>·</span>
        <span>
          {result.method} {result.endpoint}
        </span>
        <span>·</span>
        <span>{result.latencyMs}ms</span>
      </div>
      <pre className="code-block">
        {result.error ?? JSON.stringify(result.data, null, 2)}
      </pre>
    </>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <span>
        No request yet. Press <strong>Ping API</strong> to fetch from the
        server.
      </span>
    </div>
  );
}

export default App;

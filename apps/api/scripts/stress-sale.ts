import type { PurchaseResult, ResetSaleResponse } from '@flash-sale/shared-types';

type PurchaseOutcomeLabel =
  | PurchaseResult['status']
  | 'request_failed'
  | 'http_error'
  | 'invalid_json';

interface PurchaseAttempt {
  index: number;
  userId: string;
  latencyMs: number;
  httpStatus: number;
  outcome: PurchaseOutcomeLabel;
  detail: string | null;
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  rawBodySnippet: string | null;
}

const apiUrl = process.env.API_URL ?? 'http://localhost:3000';
const buyers = getPositiveInt('STRESS_BUYERS', 1_000);
const stock = getPositiveInt('STRESS_STOCK', 100);
const shouldReset = process.env.STRESS_RESET !== 'false';

const progressEveryMs = getNonNegativeInt('STRESS_PROGRESS_MS', 200);
const logEach = envBool('STRESS_LOG_EACH', true);
const logMax = resolveLogMax(buyers);

async function main() {
  if (shouldReset) {
    await resetSale();
  }

  console.log('Flash sale stress test starting…');
  console.log(`API URL: ${apiUrl}`);
  console.log(`Buyers: ${buyers.toLocaleString()} · Stock: ${stock.toLocaleString()}`);
  if (progressEveryMs > 0) {
    console.log(
      `Live progress every ${progressEveryMs.toLocaleString()}ms on stderr (set STRESS_PROGRESS_MS=0 to disable)`,
    );
  } else {
    console.log('Live progress: disabled');
  }
  if (logEach) {
    console.log(
      `Per-request logs on stderr: on (max ${logMax === 0 ? '∞' : logMax.toLocaleString()} · STRESS_LOG_MAX=0 for unlimited · STRESS_LOG_EACH=false to silence)`,
    );
  } else {
    console.log('Per-request logs: off (set STRESS_LOG_EACH=true to enable)');
  }

  const tallies: Record<PurchaseOutcomeLabel, number> = {
    success: 0,
    already_purchased: 0,
    sold_out: 0,
    sale_not_active: 0,
    http_error: 0,
    invalid_json: 0,
    request_failed: 0,
  };

  let completed = 0;
  let logCount = 0;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let progressStream: 'tty-stderr' | 'tty-stdout' | 'log-stdout' | null = null;

  function formatProgressLine() {
    if (completed === 0) {
      return `launched ${buyers.toLocaleString()} requests · waiting for first response`;
    }

    return [
      `responses ${completed}/${buyers}`,
      `success ${(tallies.success ?? 0).toLocaleString()}`,
      `sold_out responses ${(tallies.sold_out ?? 0).toLocaleString()}`,
      `inactive responses ${(tallies.sale_not_active ?? 0).toLocaleString()}`,
      `duplicate responses ${(tallies.already_purchased ?? 0).toLocaleString()}`,
      `http ${(tallies.http_error ?? 0).toLocaleString()}`,
      `json ${(tallies.invalid_json ?? 0).toLocaleString()}`,
      `net ${(tallies.request_failed ?? 0).toLocaleString()}`,
    ].join(' · ');
  }

  function renderProgressLine() {
    if (progressEveryMs <= 0 || progressStream === null) return;

    const line = formatProgressLine();

    if (progressStream === 'tty-stderr') {
      process.stderr.write(`\r${line}`);
      return;
    }

    if (progressStream === 'tty-stdout') {
      process.stdout.write(`\r\x1b[K${line}`);
    }
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (progressEveryMs > 0 && progressStream === 'tty-stderr' && process.stderr.isTTY) {
      process.stderr.write('\r\x1b[K');
    }
    if (progressEveryMs > 0 && progressStream === 'tty-stdout' && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  }

  if (progressEveryMs > 0) {
    if (process.stderr.isTTY) {
      progressStream = 'tty-stderr';
      process.stderr.write('Live progress (updates in-place on stderr):\n');
      progressTimer = setInterval(renderProgressLine, progressEveryMs);
    } else if (process.stdout.isTTY) {
      progressStream = 'tty-stdout';
      process.stdout.write('Live progress (updates in-place on stdout):\n');
      progressTimer = setInterval(renderProgressLine, progressEveryMs);
    } else {
      console.log(
        'Live progress: non-interactive terminal — printing periodic summaries to stdout.',
      );
      progressStream = 'log-stdout';
      progressTimer = setInterval(() => {
        console.log(`progress · ${formatProgressLine()}`);
      }, progressEveryMs);
    }
  }

  const startedAt = performance.now();

  try {
    const requests = Array.from({ length: buyers }, (_, index) => {
      const userId = `stress-user-${Date.now()}-${index}`;
      return purchaseAttempt(index, userId).then((attempt) => {
        tallies[attempt.outcome] += 1;
        completed += 1;

        if (logEach && (logMax === 0 || logCount < logMax)) {
          const tail = attempt.detail ? ` · ${attempt.detail}` : '';
          console.error(
            `[${attempt.index + 1}/${buyers}] ${attempt.latencyMs.toFixed(0)}ms ` +
              `HTTP ${attempt.httpStatus} ${attempt.outcome}${tail}`,
          );
          logCount += 1;
        }

        return attempt.outcome;
      });
    });

    renderProgressLine();
    await Promise.all(requests);
  } finally {
    stopProgress();
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const success = tallies.success ?? 0;
  const failed =
    (tallies.request_failed ?? 0) +
    (tallies.http_error ?? 0) +
    (tallies.invalid_json ?? 0);
  const oversold = success > stock;

  console.log('Flash sale stress test complete');
  console.log(`Duration: ${durationMs.toLocaleString()}ms`);
  console.log(
    `Throughput: ${Math.round((buyers / durationMs) * 1000).toLocaleString()} req/s`,
  );
  console.log('Results:');
  for (const [status, count] of Object.entries(tallies)) {
    if (count > 0) {
      console.log(`  ${status}: ${count.toLocaleString()}`);
    }
  }
  console.log(`Oversold: ${oversold ? 'YES' : 'NO'}`);

  if (failed > 0 || oversold) {
    process.exitCode = 1;
  }
}

async function resetSale() {
  const now = Date.now();
  const result = await postJson<ResetSaleResponse>('/sale/reset', {
    totalStock: stock,
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 10 * 60_000).toISOString(),
  });

  if (!result.ok) {
    throw new Error(
      `Reset failed (${result.status}): ${result.error}. ` +
        'Set SIMULATION_ENABLED=true for the API or run with STRESS_RESET=false.',
    );
  }
}

async function purchaseAttempt(
  index: number,
  userId: string,
): Promise<PurchaseAttempt> {
  const started = performance.now();
  const result = await postJson<PurchaseResult>('/sale/purchase', { userId });
  const latencyMs = performance.now() - started;

  if (!result.ok) {
    const detail =
      result.error ??
      result.rawBodySnippet ??
      (result.data ? JSON.stringify(result.data) : 'No response details');
    const outcome: PurchaseOutcomeLabel =
      result.status === 0 ? 'request_failed' : 'http_error';
    return {
      index,
      userId,
      latencyMs,
      httpStatus: result.status,
      outcome,
      detail: truncate(detail, 240),
    };
  }

  if (!result.data) {
    const detail =
      result.error ??
      result.rawBodySnippet ??
      'Empty or non-JSON body';
    return {
      index,
      userId,
      latencyMs,
      httpStatus: result.status,
      outcome: 'invalid_json',
      detail: truncate(detail, 240),
    };
  }

  return {
    index,
    userId,
    latencyMs,
    httpStatus: result.status,
    outcome: result.data.status,
    detail: null,
  };
}

async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const snippet = text.length > 0 ? truncate(text.replace(/\s+/g, ' '), 240) : null;

    let data: T | null = null;
    let parseError: string | null = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        parseError = 'Response was not valid JSON';
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? parseError : `${response.status} ${response.statusText}`,
      rawBodySnippet: snippet,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : 'Network error',
      rawBodySnippet: null,
    };
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function getPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getNonNegativeInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Per-request log cap:
 * - `STRESS_LOG_MAX=0` means unlimited
 * - if unset, default to a small sample on large runs so demos stay readable
 */
function resolveLogMax(buyerCount: number): number {
  const raw = process.env.STRESS_LOG_MAX;
  if (raw !== undefined) {
    return getNonNegativeInt('STRESS_LOG_MAX', 0);
  }

  if (buyerCount <= 200) return 0;
  if (buyerCount <= 1_000) return 50;
  return 100;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

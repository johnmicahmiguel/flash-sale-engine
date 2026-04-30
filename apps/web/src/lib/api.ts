import type {
  HealthResponse,
  PurchaseRequest,
  PurchaseResult,
  ResetSaleRequest,
  ResetSaleResponse,
  RootDbStatusResponse,
  SaleStatusResponse,
  SecuredItemCheckResponse,
  SimulationLabVerifyRequest,
  SimulationLabVerifyResponse,
} from "@flash-sale/shared-types";

const API_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const apiBaseUrl = API_URL;

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  latencyMs: number;
  data: T | null;
  error: string | null;
  endpoint: string;
  method: "GET" | "POST";
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  return requestJson<T>(path, { method: "GET" });
}

async function postJson<T>(
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  return requestJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson<T>(
  path: string,
  init: RequestInit & { method: "GET" | "POST" },
): Promise<ApiResult<T>> {
  const endpoint = `${API_URL}${path}`;
  const start = performance.now();

  try {
    const res = await fetch(endpoint, init);
    const latencyMs = Math.round(performance.now() - start);
    const text = await res.text();

    let data: T | null = null;
    let parseError: string | null = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        parseError = "Response was not valid JSON";
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      data,
      error: res.ok ? parseError : `${res.status} ${res.statusText}`.trim(),
      endpoint,
      method: init.method,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      status: 0,
      latencyMs,
      data: null,
      error: err instanceof Error ? err.message : "Network error",
      endpoint,
      method: init.method,
    };
  }
}

export const fetchHello = () => getJson<RootDbStatusResponse>("/");
export const fetchHealth = () => getJson<HealthResponse>("/health");
export const fetchSaleStatus = () =>
  getJson<SaleStatusResponse>("/sale/status");
export const submitPurchase = (body: PurchaseRequest) =>
  postJson<PurchaseResult>("/sale/purchase", body);
export const checkSecuredItem = (body: PurchaseRequest) =>
  getJson<SecuredItemCheckResponse>(
    `/sale/secured?userId=${encodeURIComponent(body.userId)}`,
  );
export const resetSale = (body: ResetSaleRequest) =>
  postJson<ResetSaleResponse>("/sale/reset", body);
export const verifySimulationLabUnlock = (
  body: SimulationLabVerifyRequest,
) =>
  postJson<SimulationLabVerifyResponse>("/sale/simulation-lab/verify", body);

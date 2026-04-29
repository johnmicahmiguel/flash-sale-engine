import type {
  HealthResponse,
  RootDbStatusResponse,
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
  method: "GET";
}

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const endpoint = `${API_URL}${path}`;
  const start = performance.now();

  try {
    const res = await fetch(endpoint, { method: "GET" });
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
      method: "GET",
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
      method: "GET",
    };
  }
}

export const fetchHello = () => getJson<RootDbStatusResponse>("/");
export const fetchHealth = () => getJson<HealthResponse>("/health");

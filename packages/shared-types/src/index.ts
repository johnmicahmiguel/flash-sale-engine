export type SaleStatus = "upcoming" | "active" | "ended" | "sold_out";

export interface SaleStatusResponse {
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  remainingStock: number;
}

export interface PurchaseRequest {
  userId: string;
}

export type PurchaseResult =
  | { status: "success"; userId: string; purchasedAt: string }
  | { status: "already_purchased" }
  | { status: "sold_out" }
  | { status: "sale_not_active" };

export interface HelloResponse {
  message: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
  timestamp: string;
}

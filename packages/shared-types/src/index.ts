export type SaleStatus = "upcoming" | "active" | "ended" | "sold_out";

export interface SaleProduct {
  name: string;
  tagline: string;
  imageEmoji: string;
  priceCents: number;
  originalPriceCents: number;
  currency: string;
  editionNumber: number;
  editionTotal: number;
}

export interface SaleStatusResponse {
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  totalStock: number;
  remainingStock: number;
  product: SaleProduct;
  simulation?: SimulationStatsResponse;
}

export interface PurchaseRequest {
  userId: string;
}

export interface SecuredItemCheckResponse {
  userId: string;
  secured: boolean;
  purchasedAt?: string;
}

export interface ResetSaleRequest {
  totalStock?: number;
  startsAt?: string;
  endsAt?: string;
}

export type PurchaseResult =
  | { status: "success"; userId: string; purchasedAt: string }
  | { status: "already_purchased" }
  | { status: "sold_out" }
  | { status: "sale_not_active" };

export type SimulationEventStatus =
  | PurchaseResult["status"]
  | "failed"
  /** Not a purchase response — grouped under API `sale_not_active`; past `endsAt` */
  | "sale_ended";

export interface SimulationStatsResponse {
  total: number;
  inFlight: number;
  success: number;
  alreadyPurchased: number;
  soldOut: number;
  /** Purchase attempts after `endsAt` (sale window closed; stock may remain). */
  saleEnded: number;
  failed: number;
}

export interface ResetSaleResponse {
  sale: SaleStatusResponse;
  totalStock: number;
}

export interface SimulationLabVerifyRequest {
  password: string;
}

export interface SimulationLabVerifyResponse {
  ok: true;
}

export interface RootDbStatusResponse {
  connected: boolean;
  userCount: number;
  error?: string;
}

/** Web /health: Redis can be unset (no REDIS_URL). Mongo is always configured when the API boots with Prisma. */
export type DependencyConnectionStatus =
  | "connected"
  | "disconnected"
  | "not_configured";

export interface DependenciesHealth {
  mongo: "connected" | "disconnected";
  redis: DependencyConnectionStatus;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
  timestamp: string;
  dependencies: DependenciesHealth;
}

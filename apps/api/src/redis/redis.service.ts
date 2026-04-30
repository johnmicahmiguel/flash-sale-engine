import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  PurchaseResult,
  SimulationEventStatus,
  SimulationStatsResponse,
} from '@flash-sale/shared-types';
import Redis from 'ioredis';

export type StockReservationResult =
  | { status: 'reserved'; remainingStock: number }
  | { status: 'already_purchased' }
  | { status: 'sold_out' };

const RESERVE_STOCK_SCRIPT = `
local stockKey = KEYS[1]
local buyersKey = KEYS[2]
local userId = ARGV[1]

-- Keep duplicate checks and stock decrement in one Redis command so concurrent
-- buyers cannot oversell between separate read/write operations.
if redis.call("SISMEMBER", buyersKey, userId) == 1 then
  return { "already_purchased" }
end

local stock = tonumber(redis.call("GET", stockKey) or "0")
if stock <= 0 then
  return { "sold_out" }
end

local remainingStock = redis.call("DECR", stockKey)
redis.call("SADD", buyersKey, userId)
return { "reserved", tostring(remainingStock) }
`;

const SEED_STOCK_SCRIPT = `
local stockKey = KEYS[1]
local buyersKey = KEYS[2]
local versionKey = KEYS[3]
local remainingStock = ARGV[1]
local version = ARGV[2]

-- Seeding is intentionally no-op once the hot-path key exists; only reset clears
-- active buyer reservations.
if redis.call("EXISTS", stockKey) == 1 then
  return { "exists" }
end

redis.call("SET", stockKey, remainingStock)
redis.call("DEL", buyersKey)
redis.call("SET", versionKey, version)
return { "seeded" }
`;

const FINISH_SIMULATION_ATTEMPT_SCRIPT = `
local statsKey = KEYS[1]
local statusField = ARGV[1]
local inFlight = tonumber(redis.call("HGET", statsKey, "inFlight") or "0")

if inFlight > 0 then
  redis.call("HINCRBY", statsKey, "inFlight", -1)
else
  redis.call("HSET", statsKey, "inFlight", 0)
end

redis.call("HINCRBY", statsKey, statusField, 1)
return { "recorded" }
`;

type SimulationOutcomeStatus = SimulationEventStatus;

@Injectable()
export class RedisService implements OnModuleDestroy, OnModuleInit {
  private readonly log = new Logger(RedisService.name);
  private readonly client: Redis | null;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL');
    this.client = url
      ? new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        })
      : null;
  }

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!this.client) {
      this.log.warn(
        'Redis unavailable (REDIS_URL not set) — concurrency hot-path will rely on Mongo/Prisma only',
      );
      return;
    }

    try {
      await this.ensureConnected();
      await this.client.ping();
      this.log.log(`Redis online (${this.describeRedis(url)})`);
    } catch {
      this.log.warn(`Redis unreachable (${this.describeRedis(url)})`);
    }
  }

  async seedSaleStock(
    saleSlug: string,
    remainingStock: number,
    version: string,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureConnected();
    await this.client.eval(
      SEED_STOCK_SCRIPT,
      3,
      this.stockKey(saleSlug),
      this.buyersKey(saleSlug),
      this.versionKey(saleSlug),
      String(remainingStock),
      version,
    );
  }

  async reserveStock(
    saleSlug: string,
    userId: string,
  ): Promise<StockReservationResult | null> {
    if (!this.client) {
      return null;
    }

    await this.ensureConnected();
    const result = await this.client.eval(
      RESERVE_STOCK_SCRIPT,
      2,
      this.stockKey(saleSlug),
      this.buyersKey(saleSlug),
      userId,
    );

    return this.parseReservationResult(result);
  }

  async startSimulationAttempt(saleSlug: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureConnected();
    await this.client
      .multi()
      .hincrby(this.simulationStatsKey(saleSlug), 'total', 1)
      .hincrby(this.simulationStatsKey(saleSlug), 'inFlight', 1)
      .exec();
  }

  async finishSimulationAttempt(
    saleSlug: string,
    status: SimulationOutcomeStatus,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureConnected();
    await this.client.eval(
      FINISH_SIMULATION_ATTEMPT_SCRIPT,
      1,
      this.simulationStatsKey(saleSlug),
      this.toSimulationStatField(status),
    );
  }

  async getSimulationStats(
    saleSlug: string,
  ): Promise<SimulationStatsResponse | null> {
    if (!this.client) {
      return null;
    }

    await this.ensureConnected();
    const stats = await this.client.hgetall(this.simulationStatsKey(saleSlug));
    return this.parseSimulationStats(stats);
  }

  async getRemainingStock(saleSlug: string): Promise<number | null> {
    if (!this.client) {
      return null;
    }

    await this.ensureConnected();
    const value = await this.client.get(this.stockKey(saleSlug));
    if (value === null) {
      return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async releaseReservation(saleSlug: string, userId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureConnected();
    await this.client
      .multi()
      .incr(this.stockKey(saleSlug))
      .srem(this.buyersKey(saleSlug), userId)
      .exec();
  }

  async resetSale(
    saleSlug: string,
    remainingStock: number,
    version: string,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.ensureConnected();
    await this.client
      .multi()
      .del(...this.saleRedisKeys(saleSlug))
      .set(this.stockKey(saleSlug), remainingStock)
      .set(this.versionKey(saleSlug), version)
      .exec();
  }

  async onModuleDestroy(): Promise<void> {
    this.client?.disconnect();
  }

  /**
   * Live check for status endpoints. `not_configured` when REDIS_URL is absent.
   */
  async getConnectionStatus(): Promise<
    'connected' | 'disconnected' | 'not_configured'
  > {
    if (!this.client) {
      return 'not_configured';
    }
    try {
      await this.ensureConnected();
      const pong = await this.client.ping();
      return pong === 'PONG' ? 'connected' : 'disconnected';
    } catch {
      return 'disconnected';
    }
  }

  private stockKey(saleSlug: string): string {
    return `sale:${saleSlug}:stock`;
  }

  private buyersKey(saleSlug: string): string {
    return `sale:${saleSlug}:buyers`;
  }

  private versionKey(saleSlug: string): string {
    return `sale:${saleSlug}:version`;
  }

  private simulationStatsKey(saleSlug: string): string {
    return `sale:${saleSlug}:simulation:stats`;
  }

  private simulationHistoryKey(saleSlug: string): string {
    return `sale:${saleSlug}:simulation:history`;
  }

  private saleRedisKeys(saleSlug: string): string[] {
    return [
      this.stockKey(saleSlug),
      this.buyersKey(saleSlug),
      this.versionKey(saleSlug),
      this.simulationStatsKey(saleSlug),
      this.simulationHistoryKey(saleSlug),
    ];
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client || this.client.status === 'ready') {
      return;
    }

    await this.client.connect();
  }

  private parseReservationResult(value: unknown): StockReservationResult | null {
    if (!Array.isArray(value) || typeof value[0] !== 'string') {
      return null;
    }

    if (value[0] === 'already_purchased') {
      return { status: 'already_purchased' };
    }

    if (value[0] === 'sold_out') {
      return { status: 'sold_out' };
    }

    if (value[0] === 'reserved') {
      const remainingStock = Number.parseInt(String(value[1]), 10);
      return Number.isFinite(remainingStock)
        ? { status: 'reserved', remainingStock }
        : null;
    }

    return null;
  }

  private parseSimulationStats(
    value: Record<string, string>,
  ): SimulationStatsResponse {
    return {
      total: this.parseRedisInt(value.total),
      inFlight: this.parseRedisInt(value.inFlight),
      success: this.parseRedisInt(value.success),
      alreadyPurchased: this.parseRedisInt(value.alreadyPurchased),
      soldOut: this.parseRedisInt(value.soldOut),
      saleEnded: this.parseRedisInt(value.saleEnded),
      failed: this.parseRedisInt(value.failed),
    };
  }

  private parseRedisInt(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toSimulationStatField(status: SimulationOutcomeStatus): string {
    switch (status) {
      case 'already_purchased':
        return 'alreadyPurchased';
      case 'sold_out':
        return 'soldOut';
      case 'sale_ended':
        return 'saleEnded';
      case 'sale_not_active':
        return 'saleNotActive';
      default:
        return status;
    }
  }

  /**
   * Redacts credentials for logs. Prefer host + port logging over full URLs.
   */
  private describeRedis(urlRaw: string | undefined): string {
    if (!urlRaw) {
      return 'no URL configured';
    }

    try {
      const url = new URL(urlRaw.replace(/^redis\+tls:\/\//, 'redis://'));
      const port = url.port ? `:${url.port}` : '';
      return `${url.hostname}${port}`;
    } catch {
      return 'configured';
    }
  }
}

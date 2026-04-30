import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Sale } from '@prisma/client';
import type {
  PurchaseRequest,
  PurchaseResult,
  ResetSaleRequest,
  ResetSaleResponse,
  SaleStatus,
  SaleStatusResponse,
  SecuredItemCheckResponse,
  SimulationEventStatus,
  SimulationStatsResponse,
} from '@flash-sale/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService, type StockReservationResult } from '../redis/redis.service';

const MAX_WRITE_CONFLICT_RETRIES = 5;
const WRITE_CONFLICT_BASE_DELAY_MS = 8;
const EMPTY_SIMULATION_STATS: SimulationStatsResponse = {
  total: 0,
  inFlight: 0,
  success: 0,
  alreadyPurchased: 0,
  soldOut: 0,
  saleEnded: 0,
  failed: 0,
};

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async getStatus(): Promise<SaleStatusResponse> {
    const sale = await this.getOrCreateConfiguredSale();
    const [remainingStock, simulation] = await Promise.all([
      this.getHotPathRemainingStock(sale),
      this.getSimulationStatsForSale(sale.slug),
    ]);

    return {
      ...this.toStatusResponse(sale, new Date(), remainingStock),
      simulation,
    };
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    const sale = await this.getOrCreateConfiguredSale();
    let trackedStatus: SimulationEventStatus = 'failed';

    await this.trackSimulationStart(sale.slug);

    try {
      const now = new Date();
      const saleStatus = this.resolveStatus(sale, now);

      if (saleStatus === 'sold_out') {
        trackedStatus = 'sold_out';
        return { status: 'sold_out' };
      }

      if (saleStatus !== 'active') {
        trackedStatus =
          saleStatus === 'ended' ? 'sale_ended' : 'sale_not_active';
        return { status: 'sale_not_active' };
      }

      // Redis is the hot-path gate: one atomic script handles duplicate buyers
      // and stock reservation before we do the slower durable Mongo write.
      const redisReservation = await this.reserveInRedis(sale, request.userId);
      if (redisReservation?.status === 'already_purchased') {
        trackedStatus = 'already_purchased';
        return { status: 'already_purchased' };
      }

      if (redisReservation?.status === 'sold_out') {
        trackedStatus = 'sold_out';
        return { status: 'sold_out' };
      }

      let result: PurchaseResult;
      try {
        result =
          redisReservation?.status === 'reserved'
            ? await this.persistRedisReservedPurchase(sale, request.userId)
            : await this.persistPurchaseWithMongoStock(sale, request.userId);
      } catch (error) {
        // If Mongo persistence fails after Redis reserved stock, put the
        // reservation back so the item is not stranded for this simulation run.
        if (redisReservation?.status === 'reserved') {
          await this.redis.releaseReservation(sale.slug, request.userId);
        }
        throw error;
      }

      if (
        redisReservation?.status === 'reserved' &&
        result.status !== 'success'
      ) {
        // Unique-key races can still happen at the durable layer; release the
        // temporary Redis reservation when Mongo says the buyer did not win.
        await this.redis.releaseReservation(sale.slug, request.userId);
      }

      if (
        redisReservation?.status === 'reserved' &&
        result.status === 'success'
      ) {
        // Redis remains the live counter during the burst. Mongo stock is synced
        // best-effort for status/read consistency after each successful purchase.
        await this.syncMongoRemainingStock(
          sale,
          redisReservation.remainingStock,
        );
      }

      trackedStatus = result.status;
      return result;
    } finally {
      await this.trackSimulationFinish(sale.slug, trackedStatus);
    }
  }

  async checkSecuredItem(
    request: PurchaseRequest,
  ): Promise<SecuredItemCheckResponse> {
    const sale = await this.getOrCreateConfiguredSale();
    const purchase = await this.prisma.db.purchase.findUnique({
      where: {
        saleId_userId: {
          saleId: sale.id,
          userId: request.userId,
        },
      },
    });

    return {
      userId: request.userId,
      secured: purchase !== null,
      purchasedAt: purchase?.purchasedAt.toISOString(),
    };
  }

  async resetForSimulation(
    request: ResetSaleRequest,
  ): Promise<ResetSaleResponse> {
    if (this.config.get<string>('SIMULATION_ENABLED') !== 'true') {
      throw new ForbiddenException('Simulation reset is disabled');
    }

    const configuredSale = this.getConfiguredSale({
      totalStockOverride: request.totalStock,
      startsAtOverride: request.startsAt,
      endsAtOverride: request.endsAt,
    });
    const sale = await this.prisma.db.$transaction(async (tx) => {
      const resetSale = await tx.sale.upsert({
        where: { slug: configuredSale.slug },
        update: configuredSale,
        create: configuredSale,
      });

      await tx.purchase.deleteMany({
        where: { saleId: resetSale.id },
      });

      return resetSale;
    });

    await this.redis.resetSale(
      sale.slug,
      sale.remainingStock,
      sale.updatedAt.toISOString(),
    );

    return {
      sale: this.toStatusResponse(sale, new Date()),
      totalStock: sale.totalStock,
    };
  }

  toStatusResponse(
    sale: Sale,
    now: Date,
    remainingStockOverride?: number,
  ): SaleStatusResponse {
    const remainingStock = remainingStockOverride ?? sale.remainingStock;

    return {
      status: this.resolveStatus(sale, now, remainingStock),
      startsAt: sale.startsAt.toISOString(),
      endsAt: sale.endsAt.toISOString(),
      totalStock: sale.totalStock,
      remainingStock,
      product: {
        name: sale.name,
        tagline: sale.tagline,
        imageEmoji: sale.productImageEmoji,
        priceCents: sale.priceCents,
        originalPriceCents: sale.originalPriceCents,
        currency: sale.currency,
        editionNumber: sale.editionNumber,
        editionTotal: sale.editionTotal,
      },
    };
  }

  private async getOrCreateConfiguredSale(): Promise<Sale> {
    const configuredSale = this.getConfiguredSale();
    return this.prisma.db.sale.upsert({
      where: { slug: configuredSale.slug },
      update: {},
      create: configuredSale,
    });
  }

  private getConfiguredSale(options: {
    totalStockOverride?: number;
    startsAtOverride?: string;
    endsAtOverride?: string;
  } = {}): {
    slug: string;
    name: string;
    tagline: string;
    productImageEmoji: string;
    priceCents: number;
    originalPriceCents: number;
    currency: string;
    editionNumber: number;
    editionTotal: number;
    totalStock: number;
    remainingStock: number;
    startsAt: Date;
    endsAt: Date;
  } {
    const totalStock =
      options.totalStockOverride ?? this.getPositiveInt('SALE_TOTAL_STOCK', 100);
    const editionTotal = this.getPositiveInt('SALE_EDITION_TOTAL', 100);
    const editionNumber = Math.min(
      this.getPositiveInt('SALE_EDITION_NUMBER', 47),
      editionTotal,
    );
    const startsAt = options.startsAtOverride
      ? new Date(options.startsAtOverride)
      : this.getDate('SALE_STARTS_AT', -60_000);
    const endsAt = options.endsAtOverride
      ? new Date(options.endsAtOverride)
      : this.getDate('SALE_ENDS_AT', 24 * 60 * 60 * 1000);

    if (endsAt <= startsAt) {
      throw new BadRequestException('Sale end time must be after start time');
    }

    return {
      slug: this.config.get<string>('SALE_ID') ?? 'bookipi-flash-sale',
      name:
        this.config.get<string>('SALE_NAME') ?? 'Cloudrunner Limited Edition',
      tagline:
        this.config.get<string>('SALE_TAGLINE') ??
        'Sneaker drop · ultra limited',
      productImageEmoji:
        this.config.get<string>('SALE_IMAGE_EMOJI') ?? '👟',
      priceCents: this.getPositiveInt('SALE_PRICE_CENTS', 9_900),
      originalPriceCents: this.getPositiveInt(
        'SALE_ORIGINAL_PRICE_CENTS',
        24_900,
      ),
      currency: this.config.get<string>('SALE_CURRENCY') ?? 'AUD',
      editionNumber,
      editionTotal,
      totalStock,
      remainingStock: totalStock,
      startsAt,
      endsAt,
    };
  }

  private resolveStatus(
    sale: Sale,
    now: Date,
    remainingStock = sale.remainingStock,
  ): SaleStatus {
    if (now < sale.startsAt) {
      return 'upcoming';
    }

    if (remainingStock <= 0) {
      return 'sold_out';
    }

    if (now >= sale.endsAt) {
      return 'ended';
    }

    return 'active';
  }

  private async reserveInRedis(
    sale: Sale,
    userId: string,
  ): Promise<StockReservationResult | null> {
    try {
      await this.redis.seedSaleStock(
        sale.slug,
        sale.remainingStock,
        sale.updatedAt.toISOString(),
      );
      return await this.redis.reserveStock(sale.slug, userId);
    } catch {
      return null;
    }
  }

  private async getHotPathRemainingStock(sale: Sale): Promise<number> {
    try {
      await this.redis.seedSaleStock(
        sale.slug,
        sale.remainingStock,
        sale.updatedAt.toISOString(),
      );
      return (
        (await this.redis.getRemainingStock(sale.slug)) ?? sale.remainingStock
      );
    } catch {
      return sale.remainingStock;
    }
  }

  private async trackSimulationStart(saleSlug: string): Promise<void> {
    try {
      await this.redis.startSimulationAttempt(saleSlug);
    } catch {
      // Metrics should never block the purchase path.
    }
  }

  private async getSimulationStatsForSale(
    saleSlug: string,
  ): Promise<SimulationStatsResponse> {
    try {
      return (
        (await this.redis.getSimulationStats(saleSlug)) ?? EMPTY_SIMULATION_STATS
      );
    } catch {
      return EMPTY_SIMULATION_STATS;
    }
  }

  private async trackSimulationFinish(
    saleSlug: string,
    status: SimulationEventStatus,
  ): Promise<void> {
    try {
      await this.redis.finishSimulationAttempt(saleSlug, status);
    } catch {
      // Metrics should never block the purchase path.
    }
  }

  private async persistRedisReservedPurchase(
    sale: Sale,
    userId: string,
  ): Promise<PurchaseResult> {
    try {
      const purchase = await this.prisma.db.purchase.create({
        data: {
          saleId: sale.id,
          userId,
        },
      });

      return {
        status: 'success',
        userId: purchase.userId,
        purchasedAt: purchase.purchasedAt.toISOString(),
      };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { status: 'already_purchased' };
      }

      throw error;
    }
  }

  private async syncMongoRemainingStock(
    sale: Sale,
    remainingStock: number,
  ): Promise<void> {
    try {
      await this.prisma.db.sale.updateMany({
        where: {
          id: sale.id,
          remainingStock: { gt: remainingStock },
        },
        data: {
          remainingStock,
        },
      });
    } catch {
      // Purchase success is already durably recorded. Stock sync is best-effort
      // because Redis remains the live counter during the hot sale window.
    }
  }

  private async persistPurchaseWithMongoStock(
    sale: Sale,
    userId: string,
  ): Promise<PurchaseResult> {
    for (let attempt = 0; attempt <= MAX_WRITE_CONFLICT_RETRIES; attempt += 1) {
      try {
        // Fallback path when Redis is unavailable: stock decrement and purchase
        // insert stay in one transaction to prevent overselling.
        const purchase = await this.prisma.db.$transaction(async (tx) => {
          const stockUpdate = await tx.sale.updateMany({
            where: {
              id: sale.id,
              remainingStock: { gt: 0 },
            },
            data: {
              remainingStock: { decrement: 1 },
            },
          });

          if (stockUpdate.count === 0) {
            throw new SoldOutError();
          }

          return tx.purchase.create({
            data: {
              saleId: sale.id,
              userId,
            },
          });
        });

        return {
          status: 'success',
          userId: purchase.userId,
          purchasedAt: purchase.purchasedAt.toISOString(),
        };
      } catch (error) {
        if (error instanceof SoldOutError) {
          return { status: 'sold_out' };
        }

        if (this.isUniqueConstraintError(error)) {
          return { status: 'already_purchased' };
        }

        if (
          this.isWriteConflictError(error) &&
          attempt < MAX_WRITE_CONFLICT_RETRIES
        ) {
          await this.waitForRetry(attempt);
          continue;
        }

        throw error;
      }
    }

    return { status: 'sold_out' };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return this.getPrismaErrorCode(error) === 'P2002';
  }

  private isWriteConflictError(error: unknown): boolean {
    return this.getPrismaErrorCode(error) === 'P2034';
  }

  private getPrismaErrorCode(error: unknown): string | null {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : null;
  }

  private async waitForRetry(attempt: number): Promise<void> {
    const delayMs = WRITE_CONFLICT_BASE_DELAY_MS * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private getPositiveInt(key: string, fallback: number): number {
    const value = this.config.get<string>(key);
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getDate(key: string, fallbackOffsetMs: number): Date {
    const value = this.config.get<string>(key);
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date(Date.now() + fallbackOffsetMs);
  }
}

class SoldOutError extends Error {}

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Sale } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SaleService } from './sale.service';

describe('SaleService', () => {
  let service: SaleService;
  let prisma: {
    db: {
      $transaction: jest.Mock;
      sale: {
        upsert: jest.Mock;
        updateMany: jest.Mock;
      };
      purchase: {
        create: jest.Mock;
        deleteMany: jest.Mock;
        findUnique: jest.Mock;
      };
    };
  };
  let config: {
    get: jest.Mock;
  };
  let redis: {
    seedSaleStock: jest.Mock;
    reserveStock: jest.Mock;
    getRemainingStock: jest.Mock;
    releaseReservation: jest.Mock;
    resetSale: jest.Mock;
    startSimulationAttempt: jest.Mock;
    finishSimulationAttempt: jest.Mock;
    getSimulationStats: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      db: {
        $transaction: jest.fn(async (callback) => callback(prisma.db)),
        sale: {
          upsert: jest.fn(),
          updateMany: jest.fn(),
        },
        purchase: {
          create: jest.fn(),
          deleteMany: jest.fn(),
          findUnique: jest.fn(),
        },
      },
    };
    config = {
      get: jest.fn(),
    };
    redis = {
      seedSaleStock: jest.fn(),
      reserveStock: jest.fn().mockResolvedValue(null),
      getRemainingStock: jest.fn().mockResolvedValue(null),
      releaseReservation: jest.fn(),
      resetSale: jest.fn(),
      startSimulationAttempt: jest.fn(),
      finishSimulationAttempt: jest.fn(),
      getSimulationStats: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SaleService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: ConfigService,
          useValue: config,
        },
        {
          provide: RedisService,
          useValue: redis,
        },
      ],
    }).compile();

    service = module.get<SaleService>(SaleService);
  });

  describe('getStatus', () => {
    it('returns sale status with Redis-backed simulation stats', async () => {
      const sale = makeSale({});
      const stats = {
        total: 2,
        inFlight: 0,
        success: 1,
        alreadyPurchased: 1,
        soldOut: 0,
        saleEnded: 0,
        failed: 0,
      };
      prisma.db.sale.upsert.mockResolvedValue(sale);
      redis.getRemainingStock.mockResolvedValue(8);
      redis.getSimulationStats.mockResolvedValue(stats);

      await expect(service.getStatus()).resolves.toEqual({
        status: 'active',
        startsAt: sale.startsAt.toISOString(),
        endsAt: sale.endsAt.toISOString(),
        totalStock: sale.totalStock,
        remainingStock: 8,
        product: expectedProduct(sale),
        simulation: stats,
      });
      expect(redis.getSimulationStats).toHaveBeenCalledWith(sale.slug);
    });
  });

  it.each([
    {
      status: 'upcoming',
      remainingStock: 10,
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-05-02T00:00:00.000Z',
    },
    {
      status: 'active',
      remainingStock: 10,
      startsAt: '2026-04-29T00:00:00.000Z',
      endsAt: '2026-05-02T00:00:00.000Z',
    },
    {
      status: 'sold_out',
      remainingStock: 0,
      startsAt: '2026-04-29T00:00:00.000Z',
      endsAt: '2026-05-02T00:00:00.000Z',
    },
    {
      status: 'ended',
      remainingStock: 10,
      startsAt: '2026-04-29T00:00:00.000Z',
      endsAt: '2026-04-30T00:00:00.000Z',
    },
  ] as const)(
    'returns $status when stock is $remainingStock and sale window is $startsAt to $endsAt',
    ({ status, remainingStock, startsAt, endsAt }) => {
      const sale = makeSale({
        remainingStock,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      });

      expect(
        service.toStatusResponse(sale, new Date('2026-04-30T12:00:00.000Z')),
      ).toEqual({
        status,
        startsAt,
        endsAt,
        totalStock: sale.totalStock,
        remainingStock,
        product: expectedProduct(sale),
      });
    },
  );

  describe('purchase', () => {
    it('returns success after reserving stock and persisting the purchase', async () => {
      const sale = makeSale({});
      const purchasedAt = new Date('2026-04-30T12:00:00.000Z');
      prisma.db.sale.upsert.mockResolvedValue(sale);
      redis.reserveStock.mockResolvedValue({
        status: 'reserved',
        remainingStock: 9,
      });
      prisma.db.purchase.create.mockResolvedValue({
        id: 'purchase-object-id',
        saleId: sale.id,
        userId: 'user-1',
        purchasedAt,
      });
      prisma.db.sale.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'success',
        userId: 'user-1',
        purchasedAt: purchasedAt.toISOString(),
      });
      expect(redis.releaseReservation).not.toHaveBeenCalled();
      expect(prisma.db.$transaction).not.toHaveBeenCalled();
      expect(redis.startSimulationAttempt).toHaveBeenCalledWith(sale.slug);
      expect(redis.finishSimulationAttempt).toHaveBeenCalledWith(
        sale.slug,
        'success',
      );
      expect(prisma.db.sale.updateMany).toHaveBeenCalledWith({
        where: {
          id: sale.id,
          remainingStock: { gt: 9 },
        },
        data: {
          remainingStock: 9,
        },
      });
    });

    it('retries transient Prisma write conflicts before returning success', async () => {
      const sale = makeSale({});
      const purchasedAt = new Date('2026-04-30T12:00:00.000Z');
      prisma.db.sale.upsert.mockResolvedValue(sale);
      redis.reserveStock.mockResolvedValue(null);
      prisma.db.$transaction
        .mockRejectedValueOnce({ code: 'P2034' })
        .mockImplementationOnce(async (callback) => callback(prisma.db));
      prisma.db.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.db.purchase.create.mockResolvedValue({
        id: 'purchase-object-id',
        saleId: sale.id,
        userId: 'user-1',
        purchasedAt,
      });

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'success',
        userId: 'user-1',
        purchasedAt: purchasedAt.toISOString(),
      });
      expect(prisma.db.$transaction).toHaveBeenCalledTimes(2);
      expect(redis.releaseReservation).not.toHaveBeenCalled();
    });

    it('returns sold_out and skips Prisma when Redis has no stock', async () => {
      prisma.db.sale.upsert.mockResolvedValue(makeSale({}));
      redis.reserveStock.mockResolvedValue({ status: 'sold_out' });

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'sold_out',
      });
      expect(prisma.db.purchase.create).not.toHaveBeenCalled();
      expect(redis.finishSimulationAttempt).toHaveBeenCalledWith(
        'bookipi-flash-sale',
        'sold_out',
      );
    });

    it('returns sold_out when Mongo already shows no remaining stock', async () => {
      prisma.db.sale.upsert.mockResolvedValue(makeSale({ remainingStock: 0 }));

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'sold_out',
      });
      expect(redis.reserveStock).not.toHaveBeenCalled();
      expect(redis.finishSimulationAttempt).toHaveBeenCalledWith(
        'bookipi-flash-sale',
        'sold_out',
      );
    });

    it('returns sale_not_active (tracks saleNotActive Redis field) before window opens', async () => {
      prisma.db.sale.upsert.mockResolvedValue(
        makeSale({
          startsAt: new Date('2099-05-01T00:00:00.000Z'),
          endsAt: new Date('2099-05-02T00:00:00.000Z'),
        }),
      );

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'sale_not_active',
      });
      expect(redis.reserveStock).not.toHaveBeenCalled();
      expect(redis.finishSimulationAttempt).toHaveBeenCalledWith(
        'bookipi-flash-sale',
        'sale_not_active',
      );
    });

    it('returns sale_not_active (tracks sale_ended) after window closes', async () => {
      prisma.db.sale.upsert.mockResolvedValue(
        makeSale({
          startsAt: new Date('2020-01-01T00:00:00.000Z'),
          endsAt: new Date('2020-06-01T00:00:00.000Z'),
        }),
      );

      await expect(service.purchase({ userId: 'user-1' })).resolves.toEqual({
        status: 'sale_not_active',
      });
      expect(redis.reserveStock).not.toHaveBeenCalled();
      expect(redis.finishSimulationAttempt).toHaveBeenCalledWith(
        'bookipi-flash-sale',
        'sale_ended',
      );
    });
  });

  describe('checkSecuredItem', () => {
    it('returns secured true when the user has a purchase for the current sale', async () => {
      const sale = makeSale({});
      const purchasedAt = new Date('2026-04-30T12:00:00.000Z');
      prisma.db.sale.upsert.mockResolvedValue(sale);
      prisma.db.purchase.findUnique.mockResolvedValue({
        id: 'purchase-object-id',
        saleId: sale.id,
        userId: 'user-1',
        purchasedAt,
      });

      await expect(
        service.checkSecuredItem({ userId: 'user-1' }),
      ).resolves.toEqual({
        userId: 'user-1',
        secured: true,
        purchasedAt: purchasedAt.toISOString(),
      });
      expect(prisma.db.purchase.findUnique).toHaveBeenCalledWith({
        where: {
          saleId_userId: {
            saleId: sale.id,
            userId: 'user-1',
          },
        },
      });
    });

    it('returns secured false when the user has no purchase for the current sale', async () => {
      prisma.db.sale.upsert.mockResolvedValue(makeSale({}));
      prisma.db.purchase.findUnique.mockResolvedValue(null);

      await expect(
        service.checkSecuredItem({ userId: 'user-2' }),
      ).resolves.toEqual({
        userId: 'user-2',
        secured: false,
        purchasedAt: undefined,
      });
    });
  });

  describe('resetForSimulation', () => {
    it('resets stock and sale window from the simulation request', async () => {
      const sale = makeSale({
        totalStock: 25,
        remainingStock: 25,
        startsAt: new Date('2026-04-30T01:00:00.000Z'),
        endsAt: new Date('2026-04-30T02:00:00.000Z'),
      });
      config.get.mockImplementation((key: string) =>
        key === 'SIMULATION_ENABLED' ? 'true' : undefined,
      );
      prisma.db.sale.upsert.mockResolvedValue(sale);

      await expect(
        service.resetForSimulation({
          totalStock: 25,
          startsAt: '2026-04-30T01:00:00.000Z',
          endsAt: '2026-04-30T02:00:00.000Z',
        }),
      ).resolves.toMatchObject({
        totalStock: 25,
        sale: {
          startsAt: '2026-04-30T01:00:00.000Z',
          endsAt: '2026-04-30T02:00:00.000Z',
          totalStock: 25,
          remainingStock: 25,
        },
      });
      expect(prisma.db.sale.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            totalStock: 25,
            remainingStock: 25,
            startsAt: new Date('2026-04-30T01:00:00.000Z'),
            endsAt: new Date('2026-04-30T02:00:00.000Z'),
          }),
        }),
      );
      expect(redis.resetSale).toHaveBeenCalledWith(
        sale.slug,
        25,
        sale.updatedAt.toISOString(),
      );
    });

    it('rejects a reset window where the end is not after the start', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'SIMULATION_ENABLED' ? 'true' : undefined,
      );

      await expect(
        service.resetForSimulation({
          startsAt: '2026-04-30T02:00:00.000Z',
          endsAt: '2026-04-30T01:00:00.000Z',
        }),
      ).rejects.toThrow('Sale end time must be after start time');
      expect(prisma.db.sale.upsert).not.toHaveBeenCalled();
    });
  });

});

function expectedProduct(sale: Sale) {
  return {
    name: sale.name,
    tagline: sale.tagline,
    imageEmoji: sale.productImageEmoji,
    priceCents: sale.priceCents,
    originalPriceCents: sale.originalPriceCents,
    currency: sale.currency,
    editionNumber: sale.editionNumber,
    editionTotal: sale.editionTotal,
  };
}

function makeSale(overrides: Partial<Sale>): Sale {
  return {
    id: 'sale-object-id',
    slug: 'bookipi-flash-sale',
    name: 'Bookipi Flash Sale',
    tagline: 'Sneaker drop · ultra limited',
    productImageEmoji: '👟',
    priceCents: 9_900,
    originalPriceCents: 24_900,
    currency: 'AUD',
    editionNumber: 47,
    editionTotal: 100,
    totalStock: 10,
    remainingStock: 10,
    startsAt: new Date('2026-04-29T00:00:00.000Z'),
    endsAt: new Date('2026-05-02T00:00:00.000Z'),
    createdAt: new Date('2026-04-29T00:00:00.000Z'),
    updatedAt: new Date('2026-04-29T00:00:00.000Z'),
    ...overrides,
  };
}

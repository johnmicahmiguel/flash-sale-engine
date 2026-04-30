import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type {
  PurchaseResult,
  ResetSaleResponse,
  SaleStatusResponse,
  SecuredItemCheckResponse,
} from '@flash-sale/shared-types';
import request from 'supertest';
import { App } from 'supertest/types';
import { SaleController } from '../src/sale/sale.controller';
import { SaleService } from '../src/sale/sale.service';

describe('Sale API (e2e)', () => {
  let app: import('@nestjs/common').INestApplication<App>;
  let saleService: {
    getStatus: jest.Mock<Promise<SaleStatusResponse>>;
    purchase: jest.Mock<Promise<PurchaseResult>>;
    checkSecuredItem: jest.Mock<Promise<SecuredItemCheckResponse>>;
    resetForSimulation: jest.Mock<Promise<ResetSaleResponse>>;
  };

  const saleStatus: SaleStatusResponse = {
    status: 'active',
    startsAt: '2026-04-30T00:00:00.000Z',
    endsAt: '2026-04-30T01:00:00.000Z',
    totalStock: 10,
    remainingStock: 9,
    product: {
      name: 'Cloudrunner Limited Edition',
      tagline: 'Sneaker drop · ultra limited',
      imageEmoji: '👟',
      priceCents: 9_900,
      originalPriceCents: 24_900,
      currency: 'AUD',
      editionNumber: 47,
      editionTotal: 100,
    },
  };

  beforeEach(async () => {
    saleService = {
      getStatus: jest.fn().mockResolvedValue(saleStatus),
      purchase: jest.fn().mockResolvedValue({
        status: 'success',
        userId: 'user-1',
        purchasedAt: '2026-04-30T00:05:00.000Z',
      }),
      checkSecuredItem: jest.fn().mockResolvedValue({
        userId: 'user-1',
        secured: true,
        purchasedAt: '2026-04-30T00:05:00.000Z',
      }),
      resetForSimulation: jest.fn().mockResolvedValue({
        sale: saleStatus,
        totalStock: saleStatus.totalStock,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SaleController],
      providers: [
        { provide: SaleService, useValue: saleService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'SIMULATION_LAB_SECRET' ? 'demo-password' : undefined,
            ),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the current sale status', async () => {
    await request(app.getHttpServer())
      .get('/sale/status')
      .expect(200)
      .expect(saleStatus);
  });

  it('accepts a purchase attempt for a valid user id', async () => {
    await request(app.getHttpServer())
      .post('/sale/purchase')
      .send({ userId: 'user-1' })
      .expect(201)
      .expect({
        status: 'success',
        userId: 'user-1',
        purchasedAt: '2026-04-30T00:05:00.000Z',
      });

    expect(saleService.purchase).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('rejects invalid purchase payloads at the API boundary', async () => {
    await request(app.getHttpServer())
      .post('/sale/purchase')
      .send({})
      .expect(400);

    expect(saleService.purchase).not.toHaveBeenCalled();
  });

  it('checks whether a user secured an item', async () => {
    await request(app.getHttpServer())
      .get('/sale/secured')
      .query({ userId: 'user-1' })
      .expect(200)
      .expect({
        userId: 'user-1',
        secured: true,
        purchasedAt: '2026-04-30T00:05:00.000Z',
      });

    expect(saleService.checkSecuredItem).toHaveBeenCalledWith({
      userId: 'user-1',
    });
  });

  it('resets sale state with stock and sale-window overrides', async () => {
    const body = {
      totalStock: 10,
      startsAt: '2026-04-30T00:00:00.000Z',
      endsAt: '2026-04-30T01:00:00.000Z',
    };

    await request(app.getHttpServer())
      .post('/sale/reset')
      .send(body)
      .expect(201)
      .expect({
        sale: saleStatus,
        totalStock: 10,
      });

    expect(saleService.resetForSimulation).toHaveBeenCalledWith(body);
  });

  it('verifies the simulation lab password', async () => {
    await request(app.getHttpServer())
      .post('/sale/simulation-lab/verify')
      .send({ password: 'demo-password' })
      .expect(200)
      .expect({ ok: true });

    await request(app.getHttpServer())
      .post('/sale/simulation-lab/verify')
      .send({ password: 'wrong' })
      .expect(401);
  });
});

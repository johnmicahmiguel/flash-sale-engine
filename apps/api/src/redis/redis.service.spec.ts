import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

const mockPipeline = {
  set: jest.fn().mockReturnThis(),
  del: jest.fn().mockReturnThis(),
  hincrby: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

const mockRedisClient = {
  status: 'ready',
  eval: jest.fn(),
  hgetall: jest.fn(),
  multi: jest.fn(() => mockPipeline),
  disconnect: jest.fn(),
};

jest.mock('ioredis', () => jest.fn(() => mockRedisClient));

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.status = 'ready';
    mockPipeline.set.mockReturnThis();
    mockPipeline.del.mockReturnThis();
    mockPipeline.hincrby.mockReturnThis();
    mockRedisClient.hgetall.mockResolvedValue({});

    service = new RedisService({
      get: jest.fn((key: string) =>
        key === 'REDIS_URL' ? 'redis://localhost:6379' : undefined,
      ),
    } as unknown as ConfigService);
  });

  it('seeds stock atomically without clearing active reservations on version changes', async () => {
    await service.seedSaleStock('bookipi-flash-sale', 71, 'mongo-updated-at');

    expect(mockRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS'),
      3,
      'sale:bookipi-flash-sale:stock',
      'sale:bookipi-flash-sale:buyers',
      'sale:bookipi-flash-sale:version',
      '71',
      'mongo-updated-at',
    );
    expect(mockRedisClient.multi).not.toHaveBeenCalled();
  });

  it('resetSale explicitly clears sale Redis keys before reseeding stock', async () => {
    await service.resetSale('bookipi-flash-sale', 100, 'reset-version');

    expect(mockRedisClient.multi).toHaveBeenCalledTimes(1);
    expect(mockPipeline.del).toHaveBeenCalledWith(
      'sale:bookipi-flash-sale:stock',
      'sale:bookipi-flash-sale:buyers',
      'sale:bookipi-flash-sale:version',
      'sale:bookipi-flash-sale:simulation:stats',
      'sale:bookipi-flash-sale:simulation:history',
    );
    expect(mockPipeline.set).toHaveBeenNthCalledWith(
      1,
      'sale:bookipi-flash-sale:stock',
      100,
    );
    expect(mockPipeline.set).toHaveBeenNthCalledWith(
      2,
      'sale:bookipi-flash-sale:version',
      'reset-version',
    );
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('tracks simulation attempt counters in Redis', async () => {
    await service.startSimulationAttempt('bookipi-flash-sale');
    await service.finishSimulationAttempt('bookipi-flash-sale', 'sold_out');

    expect(mockPipeline.hincrby).toHaveBeenNthCalledWith(
      1,
      'sale:bookipi-flash-sale:simulation:stats',
      'total',
      1,
    );
    expect(mockPipeline.hincrby).toHaveBeenNthCalledWith(
      2,
      'sale:bookipi-flash-sale:simulation:stats',
      'inFlight',
      1,
    );
    expect(mockRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining('HINCRBY'),
      1,
      'sale:bookipi-flash-sale:simulation:stats',
      'soldOut',
    );
  });

  it('reads simulation stats from Redis', async () => {
    mockRedisClient.hgetall.mockResolvedValue({
      total: '3',
      inFlight: '0',
      success: '1',
      alreadyPurchased: '1',
      soldOut: '1',
    });

    await expect(
      service.getSimulationStats('bookipi-flash-sale'),
    ).resolves.toEqual({
      total: 3,
      inFlight: 0,
      success: 1,
      alreadyPurchased: 1,
      soldOut: 1,
      saleEnded: 0,
      failed: 0,
    });
  });

  it('does not create a Redis client when REDIS_URL is unset', async () => {
    service = new RedisService({
      get: jest.fn(),
    } as unknown as ConfigService);

    await service.seedSaleStock('bookipi-flash-sale', 100, 'version');

    expect(Redis).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.eval).not.toHaveBeenCalled();
  });
});

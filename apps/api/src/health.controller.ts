import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@flash-sale/shared-types';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [mongo, redis] = await Promise.all([
      this.checkMongo(),
      this.redis.getConnectionStatus(),
    ]);

    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dependencies: { mongo, redis },
    };
  }

  private async checkMongo(): Promise<'connected' | 'disconnected'> {
    try {
      await this.prisma.db.$runCommandRaw({ ping: 1 });
      return 'connected';
    } catch {
      return 'disconnected';
    }
  }
}

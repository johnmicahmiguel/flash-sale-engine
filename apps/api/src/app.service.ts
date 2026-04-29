import { Injectable } from '@nestjs/common';
import type { RootDbStatusResponse } from '@flash-sale/shared-types';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async getRootStatus(): Promise<RootDbStatusResponse> {
    try {
      const userCount = await this.prisma.db.user.count();
      return { connected: true, userCount };
    } catch {
      return {
        connected: false,
        userCount: 0,
        error: 'Database unavailable',
      };
    }
  }
}

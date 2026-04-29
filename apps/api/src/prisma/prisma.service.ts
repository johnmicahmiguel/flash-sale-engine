import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPrisma } from './prisma.singleton';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly db = getPrisma();

  async onModuleInit(): Promise<void> {
    await this.db.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}

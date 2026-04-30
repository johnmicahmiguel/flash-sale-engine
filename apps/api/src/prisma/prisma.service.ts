import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { getPrisma } from './prisma.singleton';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);
  readonly db = getPrisma();

  async onModuleInit(): Promise<void> {
    try {
      await this.db.$connect();
      await this.db.$runCommandRaw({ ping: 1 });
      this.log.log('MongoDB (Prisma) online');
    } catch (error) {
      this.log.warn('MongoDB (Prisma) connection check failed');
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}

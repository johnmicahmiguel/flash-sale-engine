import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@flash-sale/shared-types';

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}

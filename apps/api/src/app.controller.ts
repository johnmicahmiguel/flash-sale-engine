import { Controller, Get } from '@nestjs/common';
import type { RootDbStatusResponse } from '@flash-sale/shared-types';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getRoot(): Promise<RootDbStatusResponse> {
    return this.appService.getRootStatus();
  }
}

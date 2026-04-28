import { Controller, Get } from '@nestjs/common';
import type { HelloResponse } from '@flash-sale/shared-types';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): HelloResponse {
    return this.appService.getHello();
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  PurchaseResult,
  ResetSaleResponse,
  SaleStatusResponse,
  SecuredItemCheckResponse,
  SimulationLabVerifyResponse,
} from '@flash-sale/shared-types';
import { ConfigService } from '@nestjs/config';
import { PurchaseDto } from './dto/purchase.dto';
import { ResetSaleDto } from './dto/reset-sale.dto';
import { SecuredItemCheckDto } from './dto/secured-item-check.dto';
import { SimulationLabVerifyDto } from './dto/simulation-lab-verify.dto';
import { SaleService } from './sale.service';

@Controller('sale')
export class SaleController {
  constructor(
    private readonly saleService: SaleService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  getStatus(): Promise<SaleStatusResponse> {
    return this.saleService.getStatus();
  }

  @Post('purchase')
  purchase(@Body() body: PurchaseDto): Promise<PurchaseResult> {
    return this.saleService.purchase(body);
  }

  @Get('secured')
  checkSecuredItem(
    @Query() query: SecuredItemCheckDto,
  ): Promise<SecuredItemCheckResponse> {
    return this.saleService.checkSecuredItem(query);
  }

  @Post('reset')
  reset(@Body() body: ResetSaleDto): Promise<ResetSaleResponse> {
    return this.saleService.resetForSimulation(body);
  }

  @Post('simulation-lab/verify')
  @HttpCode(200)
  verifySimulationLab(
    @Body() body: SimulationLabVerifyDto,
  ): SimulationLabVerifyResponse {
    const secret =
      this.config.get<string>('SIMULATION_LAB_SECRET')?.trim() ?? '';
    if (secret === '') {
      throw new BadRequestException(
        'Simulation lab unlock is not configured (SIMULATION_LAB_SECRET)',
      );
    }
    if (body.password !== secret) {
      throw new UnauthorizedException('Invalid password');
    }
    return { ok: true };
  }
}

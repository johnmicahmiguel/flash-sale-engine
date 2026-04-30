import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { SimulationLabVerifyRequest } from '@flash-sale/shared-types';

export class SimulationLabVerifyDto implements SimulationLabVerifyRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}

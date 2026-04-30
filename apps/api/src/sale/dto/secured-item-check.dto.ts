import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { PurchaseRequest } from '@flash-sale/shared-types';

export class SecuredItemCheckDto implements PurchaseRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId!: string;
}

import { IsInt, IsString, IsOptional, IsObject, Min } from 'class-validator';

export class InitiatePaymentDto {
  @IsInt()
  @Min(100)
  amount: number;

  @IsString()
  currency: string = 'NGN';

  @IsString()
  idempotencyKey: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
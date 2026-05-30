import { Controller, Post, Get, Body, Param, Headers } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post()
  async initiate(
    @Body() dto: InitiatePaymentDto,
    @Headers('idempotency-key') headerKey?: string,
  ) {
    const key = dto.idempotencyKey || headerKey;
    if (!key) {
      throw new Error('Idempotency key required');
    }
    return this.paymentService.initiatePayment({ ...dto, idempotencyKey: key });
  }

  @Get(':reference')
  async getPayment(@Param('reference') reference: string) {
    return this.paymentService.getPayment(reference);
  }
}
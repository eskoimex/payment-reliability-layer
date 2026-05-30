import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaymentEventLogger } from './events/payment-event-logger.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { MockProviderService } from './providers/mock-provider.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentController, ReconciliationController],
  providers: [
    PaymentService,
    PaymentEventLogger,
    IdempotencyService,
    MockProviderService,
    ReconciliationService,
  ],
  exports: [PaymentService, ReconciliationService, MockProviderService],
})
export class PaymentModule {}
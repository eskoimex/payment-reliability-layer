import { Injectable, Logger, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentEventLogger } from './events/payment-event-logger.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { MockProviderService } from './providers/mock-provider.service';
import { PaymentStatus, PaymentEventType } from '@prisma/client';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

export class PaymentResult {
  success: boolean;
  paymentId: string;
  reference: string;
  status: PaymentStatus;
  providerRef?: string;
  message: string;
  cached?: boolean;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLogger: PaymentEventLogger,
    private readonly idempotency: IdempotencyService,
    private readonly provider: MockProviderService,
  ) {}

  async initiatePayment(dto: InitiatePaymentDto): Promise<PaymentResult> {
    const { amount, currency, idempotencyKey, metadata } = dto;

    const idempotencyCheck = await this.idempotency.checkKey(idempotencyKey);
    if (!idempotencyCheck.proceed) {
      this.logger.log(`Idempotency cache hit for key: ${idempotencyKey}`);
      return {
        success: true,
        ...idempotencyCheck.cached,
        message: 'Payment retrieved from idempotency cache',
        cached: true,
      };
    }

    const reference = `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const payment = await this.prisma.payment.create({
      data: {
        reference,
        amount,
        currency,
        status: PaymentStatus.PENDING,
        idempotencyKey,
        metadata: metadata as any,
      },
    });

    await this.idempotency.createKey(idempotencyKey, payment.id);
    await this.eventLogger.logEvent(payment.id, PaymentEventType.INITIATED, { amount, currency, reference });

    return this.processPayment(payment.id, reference, amount, currency, idempotencyKey, metadata);
  }

  private async processPayment(
    paymentId: string,
    reference: string,
    amount: number,
    currency: string,
    idempotencyKey: string,
    metadata?: Record<string, any>,
  ): Promise<PaymentResult> {
    try {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PROCESSING },
      });

      await this.eventLogger.logEvent(paymentId, PaymentEventType.PROVIDER_CALLED, {
        provider: 'MockProvider',
        reference,
      });

      const providerResponse = await this.callProviderWithTimeout({
        reference,
        amount,
        currency,
        metadata,
      });

      if (providerResponse.success) {
        const updated = await this.prisma.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.COMPLETED,
            providerRef: providerResponse.providerRef,
            providerResponse: providerResponse as any,
          },
        });

        await this.eventLogger.logEvent(paymentId, PaymentEventType.CONFIRMED, {
          providerRef: providerResponse.providerRef,
          response: providerResponse,
        });

        await this.idempotency.completeKey(idempotencyKey, {
          status: PaymentStatus.COMPLETED,
          providerRef: providerResponse.providerRef,
        });

        return {
          success: true,
          paymentId: updated.id,
          reference: updated.reference,
          status: PaymentStatus.COMPLETED,
          providerRef: providerResponse.providerRef,
          message: 'Payment completed successfully',
        };
      } else {
        const updated = await this.prisma.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.FAILED,
            providerResponse: providerResponse as any,
          },
        });

        await this.eventLogger.logEvent(paymentId, PaymentEventType.FAILED, {
          reason: 'PROVIDER_ERROR',
          response: providerResponse,
        });

        await this.idempotency.failKey(idempotencyKey);

        return {
          success: false,
          paymentId: updated.id,
          reference: updated.reference,
          status: PaymentStatus.FAILED,
          message: providerResponse.message || 'Payment failed at provider',
        };
      }
    } catch (error) {
      return this.handleFailure(error, paymentId, reference, idempotencyKey);
    }
  }

  private async callProviderWithTimeout(request: any, timeoutMs = 5000, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.providerWithTimeout(request, timeoutMs);
      } catch (error) {
        if (attempt === retries) throw error;
        if (error.message === 'Request timeout') {
          this.logger.warn(`Provider timeout, attempt ${attempt}/${retries}. Retrying...`);
          await this.delay(Math.pow(2, attempt) * 100);
        } else if (error.message.includes('ECONNREFUSED') || error.message.includes('NETWORK')) {
          this.logger.warn(`Network failure, attempt ${attempt}/${retries}. Retrying...`);
          await this.delay(Math.pow(2, attempt) * 200);
        } else {
          throw error;
        }
      }
    }
  }

  private providerWithTimeout(request: any, timeoutMs: number): Promise<any> {
    return Promise.race([
      this.provider.charge(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), timeoutMs),
      ),
    ]);
  }

  private async handleFailure(error: Error, paymentId: string, reference: string, idempotencyKey: string): Promise<PaymentResult> {
    const errorMessage = error.message || 'Unknown error';

    if (errorMessage === 'Request timeout') {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PENDING_PROVIDER_CONFIRMATION },
      });

      await this.eventLogger.logEvent(paymentId, PaymentEventType.TIMEOUT, {
        error: errorMessage,
        action: 'REQUIRES_RECONCILIATION',
      });

      await this.idempotency.failKey(idempotencyKey);

      return {
        success: false,
        paymentId,
        reference,
        status: PaymentStatus.PENDING_PROVIDER_CONFIRMATION,
        message: 'Payment provider timeout. Transaction will be reconciled.',
      };
    }

    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('NETWORK') || errorMessage.includes('ENOTFOUND')) {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.FAILED },
      });

      await this.eventLogger.logEvent(paymentId, PaymentEventType.NETWORK_ERROR, {
        error: errorMessage,
        action: 'CAN_RETRY_WITH_SAME_KEY',
      });

      await this.idempotency.failKey(idempotencyKey);

      return {
        success: false,
        paymentId,
        reference,
        status: PaymentStatus.FAILED,
        message: 'Network failure connecting to provider. Please retry.',
      };
    }

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.FAILED },
    });

    await this.eventLogger.logEvent(paymentId, PaymentEventType.FAILED, {
      error: errorMessage,
      stack: error.stack,
    });

    await this.idempotency.failKey(idempotencyKey);

    return {
      success: false,
      paymentId,
      reference,
      status: PaymentStatus.FAILED,
      message: `Payment failed: ${errorMessage}`,
    };
  }

  async getPayment(reference: string) {
    return this.prisma.payment.findUnique({
      where: { reference },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
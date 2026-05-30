import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyStatus, PaymentStatus } from '@prisma/client';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async checkKey(key: string): Promise<{ proceed: boolean; cached?: any }> {
    const record = await this.prisma.idempotencyKey.findUnique({
      where: { key },
      include: { payment: true },
    });

    if (!record) {
      return { proceed: true };
    }

    if (record.status === IdempotencyStatus.PROCESSING) {
      throw new ConflictException('Payment is already being processed for this idempotency key');
    }

    if (record.status === IdempotencyStatus.COMPLETED && record.payment) {
      return {
        proceed: false,
        cached: {
          id: record.payment.id,
          reference: record.payment.reference,
          status: record.payment.status,
          amount: record.payment.amount,
          currency: record.payment.currency,
          providerRef: record.payment.providerRef,
          createdAt: record.payment.createdAt,
        },
      };
    }

    if (record.status === IdempotencyStatus.FAILED) {
      await this.prisma.idempotencyKey.delete({ where: { key } });
      return { proceed: true };
    }

    return { proceed: true };
  }

  async createKey(key: string, paymentId: string) {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    return this.prisma.idempotencyKey.create({
      data: {
        key,
        status: IdempotencyStatus.PROCESSING,
        paymentId,
        expiresAt,
      },
    });
  }

  async completeKey(key: string, response: Record<string, any>) {
    return this.prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: IdempotencyStatus.COMPLETED,
        response: response as any,
      },
    });
  }

  async failKey(key: string) {
    return this.prisma.idempotencyKey.update({
      where: { key },
      data: { status: IdempotencyStatus.FAILED },
    });
  }
}
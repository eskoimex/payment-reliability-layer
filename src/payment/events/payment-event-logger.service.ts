import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentEventType, Prisma } from '@prisma/client';

@Injectable()
export class PaymentEventLogger {
  constructor(private readonly prisma: PrismaService) {}

  async logEvent(
    paymentId: string,
    type: PaymentEventType,
    payload?: Record<string, any>,
    metadata?: Record<string, any>,
  ) {
    return this.prisma.paymentEvent.create({
      data: {
        paymentId,
        type,
        payload: payload as Prisma.JsonValue,
        metadata: metadata as Prisma.JsonValue,
      },
    });
  }

  async getEventsByPayment(paymentId: string) {
    return this.prisma.paymentEvent.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getEventsForReconciliation(startDate: Date, endDate: Date) {
    return this.prisma.paymentEvent.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        type: { in: [PaymentEventType.CONFIRMED, PaymentEventType.FAILED, PaymentEventType.RECONCILED] },
      },
      include: { payment: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
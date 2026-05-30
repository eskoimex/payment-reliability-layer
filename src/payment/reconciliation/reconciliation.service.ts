import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentEventLogger } from '../events/payment-event-logger.service';
import { MockProviderService } from '../providers/mock-provider.service';
import { ProviderTransaction } from '../providers/provider.interface';
import { PaymentStatus, PaymentEventType } from '@prisma/client';

export interface ReconciliationResult {
  matched: number;
  discrepancies: Discrepancy[];
  summary: string;
}

export interface Discrepancy {
  type: 'PROVIDER_SUCCESS_INTERNAL_PENDING' | 'PROVIDER_SUCCESS_INTERNAL_FAILED' | 'INTERNAL_SUCCESS_PROVIDER_MISSING' | 'AMOUNT_MISMATCH' | 'STATUS_MISMATCH';
  reference: string;
  providerStatus: string;
  internalStatus: string;
  providerAmount?: number;
  internalAmount?: number;
  action: string;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventLogger: PaymentEventLogger,
    private readonly provider: MockProviderService,
  ) {}

  async reconcile(startDate: Date, endDate: Date): Promise<ReconciliationResult> {
    this.logger.log(`Starting reconciliation for ${startDate.toISOString()} - ${endDate.toISOString()}`);

    const providerTransactions = await this.provider.getTransactions(startDate, endDate);
    const internalPayments = await this.prisma.payment.findMany({
      where: { createdAt: { gte: startDate, lte: endDate } },
      include: { events: true },
    });

    const discrepancies: Discrepancy[] = [];
    let matched = 0;

    const providerMap = new Map(providerTransactions.map(t => [t.reference, t]));
    const internalMap = new Map(internalPayments.map(p => [p.reference, p]));

    for (const providerTx of providerTransactions) {
      const internalPayment = internalMap.get(providerTx.reference);

      if (!internalPayment) {
        discrepancies.push({
          type: 'INTERNAL_SUCCESS_PROVIDER_MISSING',
          reference: providerTx.reference,
          providerStatus: providerTx.status,
          internalStatus: 'MISSING',
          action: 'INVESTIGATE_OR_CREATE_INTERNAL_RECORD',
        });
        continue;
      }

      if (providerTx.status === 'success' && internalPayment.status === PaymentStatus.PENDING_PROVIDER_CONFIRMATION) {
        discrepancies.push({
          type: 'PROVIDER_SUCCESS_INTERNAL_PENDING',
          reference: providerTx.reference,
          providerStatus: providerTx.status,
          internalStatus: internalPayment.status,
          providerAmount: providerTx.amount,
          internalAmount: internalPayment.amount,
          action: 'UPDATE_INTERNAL_TO_COMPLETED',
        });

        await this.healDiscrepancy(internalPayment.id, providerTx, 'Provider confirmed success after timeout');
        continue;
      }

      if (providerTx.status === 'success' && internalPayment.status === PaymentStatus.FAILED) {
        discrepancies.push({
          type: 'PROVIDER_SUCCESS_INTERNAL_FAILED',
          reference: providerTx.reference,
          providerStatus: providerTx.status,
          internalStatus: internalPayment.status,
          providerAmount: providerTx.amount,
          internalAmount: internalPayment.amount,
          action: 'CRITICAL_REQUIRES_MANUAL_REVIEW',
        });
        continue;
      }

      if (providerTx.amount !== internalPayment.amount) {
        discrepancies.push({
          type: 'AMOUNT_MISMATCH',
          reference: providerTx.reference,
          providerStatus: providerTx.status,
          internalStatus: internalPayment.status,
          providerAmount: providerTx.amount,
          internalAmount: internalPayment.amount,
          action: 'CRITICAL_REQUIRES_MANUAL_REVIEW',
        });
        continue;
      }

      if (
        (providerTx.status === 'success' && internalPayment.status !== PaymentStatus.COMPLETED) ||
        (providerTx.status === 'failed' && internalPayment.status === PaymentStatus.COMPLETED)
      ) {
        discrepancies.push({
          type: 'STATUS_MISMATCH',
          reference: providerTx.reference,
          providerStatus: providerTx.status,
          internalStatus: internalPayment.status,
          action: 'REQUIRES_MANUAL_REVIEW',
        });
        continue;
      }

      matched++;
    }

    for (const internalPayment of internalPayments) {
      if (!providerMap.has(internalPayment.reference)) {
        if (internalPayment.status === PaymentStatus.COMPLETED) {
          discrepancies.push({
            type: 'INTERNAL_SUCCESS_PROVIDER_MISSING',
            reference: internalPayment.reference,
            providerStatus: 'MISSING',
            internalStatus: internalPayment.status,
            action: 'VERIFY_PROVIDER_LEDGER_OR_INVESTIGATE_VOID',
          });
        }
      }
    }

    const summary = `Reconciliation complete: ${matched} matched, ${discrepancies.length} discrepancies found.`;
    this.logger.log(summary);

    return { matched, discrepancies, summary };
  }

  private async healDiscrepancy(paymentId: string, providerTx: ProviderTransaction, reason: string) {
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.COMPLETED,
        providerRef: providerTx.providerRef,
      },
    });

    await this.eventLogger.logEvent(paymentId, PaymentEventType.RECONCILED, {
      reason,
      providerRef: providerTx.providerRef,
      providerStatus: providerTx.status,
      previousStatus: PaymentStatus.PENDING_PROVIDER_CONFIRMATION,
    });

    this.logger.log(`Auto-healed payment ${paymentId} to COMPLETED via reconciliation`);
  }
}
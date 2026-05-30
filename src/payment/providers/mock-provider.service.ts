import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProvider, ProviderChargeRequest, ProviderChargeResponse, ProviderTransaction } from './provider.interface';

export enum MockFailureMode {
  NONE = 'none',
  TIMEOUT = 'timeout',
  ERROR_RESPONSE = 'error_response',
  NETWORK_FAILURE = 'network_failure',
}

@Injectable()
export class MockProviderService implements IPaymentProvider {
  private readonly logger = new Logger(MockProviderService.name);
  private readonly ledger = new Map<string, ProviderTransaction>();
  private failureMode: MockFailureMode = MockFailureMode.NONE;
  private failureRate = 0;

  setFailureMode(mode: MockFailureMode, rate = 1) {
    this.failureMode = mode;
    this.failureRate = rate;
  }

  reset() {
    this.ledger.clear();
    this.failureMode = MockFailureMode.NONE;
    this.failureRate = 0;
  }

  getLedger(): Map<string, ProviderTransaction> {
    return this.ledger;
  }

  async charge(request: ProviderChargeRequest): Promise<ProviderChargeResponse> {
    this.logger.log(`MockProvider: Charging ${request.reference} - ${request.amount}${request.currency}`);

    if (this.shouldFail()) {
      switch (this.failureMode) {
        case MockFailureMode.TIMEOUT:
          this.logger.warn(`MockProvider: Simulating TIMEOUT for ${request.reference}`);
          await this.simulateTimeout();
          break;
        case MockFailureMode.NETWORK_FAILURE:
          this.logger.warn(`MockProvider: Simulating NETWORK_FAILURE for ${request.reference}`);
          throw new Error('ECONNREFUSED: Connection refused by mock provider');
        case MockFailureMode.ERROR_RESPONSE:
          this.logger.warn(`MockProvider: Simulating ERROR_RESPONSE for ${request.reference}`);
          return {
            success: false,
            message: 'Provider declined transaction: Insufficient funds',
            status: 'failed',
          };
      }
    }

    const providerRef = `MOCK_REF_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tx: ProviderTransaction = {
      reference: request.reference,
      providerRef,
      amount: request.amount,
      currency: request.currency,
      status: 'success',
      processedAt: new Date(),
    };

    this.ledger.set(request.reference, tx);

    return {
      success: true,
      providerRef,
      message: 'Payment processed successfully',
      status: 'success',
    };
  }

  async getTransactions(startDate: Date, endDate: Date): Promise<ProviderTransaction[]> {
    return Array.from(this.ledger.values()).filter(
      (tx) => tx.processedAt >= startDate && tx.processedAt <= endDate,
    );
  }

  private shouldFail(): boolean {
    return this.failureMode !== MockFailureMode.NONE && Math.random() < this.failureRate;
  }

  private async simulateTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 100);
    });
  }
}
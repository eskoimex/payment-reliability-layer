export interface ProviderTransaction {
  reference: string;
  providerRef: string;
  amount: number;
  currency: string;
  status: 'success' | 'failed' | 'pending';
  processedAt: Date;
}

export interface ProviderChargeRequest {
  reference: string;
  amount: number;
  currency: string;
  metadata?: Record<string, any>;
}

export interface ProviderChargeResponse {
  success: boolean;
  providerRef?: string;
  message: string;
  status: 'success' | 'failed' | 'pending';
}

export interface IPaymentProvider {
  charge(request: ProviderChargeRequest): Promise<ProviderChargeResponse>;
  getTransactions(startDate: Date, endDate: Date): Promise<ProviderTransaction[]>;
}
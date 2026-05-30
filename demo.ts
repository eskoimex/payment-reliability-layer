import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PaymentService } from './src/payment/payment.service';
import { ReconciliationService } from './src/payment/reconciliation/reconciliation.service';
import { MockProviderService, MockFailureMode } from './src/payment/providers/mock-provider.service';
import { PrismaService } from './src/prisma/prisma.service';

function banner(text: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'='.repeat(60)}\n`);
}

async function runDemo() {
  console.log('Bootstrapping Payment Reliability Layer...\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  
  const paymentService = app.get(PaymentService);
  const reconciliationService = app.get(ReconciliationService);
  const mockProvider = app.get(MockProviderService);
  const prisma = app.get(PrismaService);

  // ── 1. Successful Payment ──
  banner('1. SUCCESSFUL PAYMENT');
  const success = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-success-1',
  });
  console.log('✅  Reference:', success.reference);
  console.log('   Status:', success.status);
  console.log('   Provider Ref:', success.providerRef);
  
  const p1 = await paymentService.getPayment(success.reference);
  console.log('   Audit Trail:', p1.events.map(e => e.type).join(' → '));

  // ── 2. Idempotency ──
  banner('2. IDEMPOTENCY — Same Key, No Double Charge');
  const idem = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-success-1',
  });
  console.log('✅  Cached response:', idem.cached);
  console.log('   Same reference:', idem.reference === success.reference);
  const count = await prisma.payment.count({ where: { idempotencyKey: 'demo-success-1' } });
  console.log('   DB records for this key:', count, '(should be 1)');

  // ── 3. Provider Timeout ──
  banner('3. FAILURE: PROVIDER TIMEOUT');
  mockProvider.setFailureMode(MockFailureMode.TIMEOUT, 1);
  const timeout = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-timeout-1',
  });
  console.log('⏱️  Status:', timeout.status);
  console.log('   Message:', timeout.message);
  const tp = await paymentService.getPayment(timeout.reference);
  console.log('   Audit Trail:', tp.events.map(e => e.type).join(' → '));

  // ── 4. Provider Error ──
  banner('4. FAILURE: PROVIDER ERROR RESPONSE');
  mockProvider.setFailureMode(MockFailureMode.ERROR_RESPONSE, 1);
  const error = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-error-1',
  });
  console.log('❌  Status:', error.status);
  console.log('   Message:', error.message);
  const ep = await paymentService.getPayment(error.reference);
  console.log('   Audit Trail:', ep.events.map(e => e.type).join(' → '));

  // ── 5. Network Failure + Retry ──
  banner('5. FAILURE: NETWORK FAILURE + RETRY');
  mockProvider.setFailureMode(MockFailureMode.NETWORK_FAILURE, 1);
  const network = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-network-1',
  });
  console.log('❌  First attempt:', network.status);
  console.log('   Message:', network.message);
  
  mockProvider.setFailureMode(MockFailureMode.NONE);
  const retry = await paymentService.initiatePayment({
    amount: 50000,
    currency: 'NGN',
    idempotencyKey: 'demo-network-1',
  });
  console.log('✅  Retry result:', retry.status);
  console.log('   Same reference:', retry.reference === network.reference);

  // ── 6. Reconciliation: Auto-heal Timeout ──
  banner('6. RECONCILIATION — Auto-heal Timeout Discrepancy');
  mockProvider.setFailureMode(MockFailureMode.TIMEOUT, 1);
  const timeout2 = await paymentService.initiatePayment({
    amount: 75000,
    currency: 'NGN',
    idempotencyKey: 'demo-recon-1',
  });
  console.log('⏱️  Timeout payment:', timeout2.reference);
  console.log('   Status before recon:', timeout2.status);
  
  // Simulate provider confirming the payment later
  mockProvider.getLedger().set(timeout2.reference, {
    reference: timeout2.reference,
    providerRef: 'MOCK_RECON_HEALED',
    amount: 75000,
    currency: 'NGN',
    status: 'success',
    processedAt: new Date(),
  });
  
  const recon = await reconciliationService.reconcile(
    new Date(Date.now() - 60000),
    new Date(Date.now() + 60000),
  );
  console.log('🔍  Reconciliation:', recon.summary);
  console.log('   Discrepancies:', recon.discrepancies.length);
  
  const healed = await paymentService.getPayment(timeout2.reference);
  console.log('   Status after recon:', healed.status);
  console.log('   Provider ref after recon:', healed.providerRef);
  console.log('   Audit Trail:', healed.events.map(e => e.type).join(' → '));

  // ── 7. Reconciliation: Critical Discrepancy ──
  banner('7. RECONCILIATION — Detect Critical Discrepancy');
  await prisma.payment.create({
    data: {
      reference: 'DEMO_CRITICAL',
      amount: 100000,
      currency: 'NGN',
      status: 'FAILED',
      idempotencyKey: 'demo-critical-key',
    },
  });
  mockProvider.getLedger().set('DEMO_CRITICAL', {
    reference: 'DEMO_CRITICAL',
    providerRef: 'MOCK_CRITICAL',
    amount: 100000,
    currency: 'NGN',
    status: 'success',
    processedAt: new Date(),
  });
  
  const recon2 = await reconciliationService.reconcile(
    new Date(Date.now() - 60000),
    new Date(Date.now() + 60000),
  );
  const critical = recon2.discrepancies.find(d => d.type === 'PROVIDER_SUCCESS_INTERNAL_FAILED');
  console.log('🚨  Critical discrepancy detected:', !!critical);
  console.log('   Type:', critical?.type);
  console.log('   Action:', critical?.action);

  banner('DEMO COMPLETE');
  console.log('All flows demonstrated. Data remains in MongoDB for inspection.');
  
  await app.close();
  process.exit(0);
}

runDemo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
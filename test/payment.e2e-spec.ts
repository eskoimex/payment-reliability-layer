import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { MockProviderService, MockFailureMode } from './../src/payment/providers/mock-provider.service';

jest.setTimeout(30000);

describe('Payment Reliability Layer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockProvider: MockProviderService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = moduleFixture.get<PrismaService>(PrismaService);
    mockProvider = moduleFixture.get<MockProviderService>(MockProviderService);
    
    await app.init();
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  }, 30000);

  beforeEach(() => {
    // Only reset mock provider state; DB cleanup skipped since DB is empty
    mockProvider.reset();
  });

  // Helper to generate unique test identifiers
  const unique = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  describe('Idempotency', () => {
    it('should not double-charge when same idempotency key is used', async () => {
      const idempotencyKey = unique('idem');
      const payload = { amount: 50000, currency: 'NGN', idempotencyKey };

      const res1 = await request(app.getHttpServer())
        .post('/payments')
        .send(payload)
        .expect(201);

      expect(res1.body.success).toBe(true);
      expect(res1.body.status).toBe('COMPLETED');

      const res2 = await request(app.getHttpServer())
        .post('/payments')
        .send(payload)
        .expect(201);

      expect(res2.body.cached).toBe(true);
      expect(res2.body.reference).toBe(res1.body.reference);

      const payments = await prisma.payment.findMany({ where: { idempotencyKey } });
      expect(payments).toHaveLength(1);
    });

    it('should reject concurrent processing with same key', async () => {
      const idempotencyKey = unique('concurrent');
      
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 50000, currency: 'NGN', idempotencyKey })
        .expect(409);
    });
  });

  describe('Failure Modes', () => {
    it('should handle provider timeout gracefully', async () => {
      mockProvider.setFailureMode(MockFailureMode.TIMEOUT, 1);

      const res = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 50000, currency: 'NGN', idempotencyKey: unique('timeout') })
        .expect(201);

      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('PENDING_PROVIDER_CONFIRMATION');

      const payment = await prisma.payment.findUnique({
        where: { reference: res.body.reference },
        include: { events: true },
      });
      
      const timeoutEvent = payment.events.find(e => e.type === 'TIMEOUT');
      expect(timeoutEvent).toBeDefined();
    });

    it('should handle provider error response gracefully', async () => {
      mockProvider.setFailureMode(MockFailureMode.ERROR_RESPONSE, 1);

      const res = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 50000, currency: 'NGN', idempotencyKey: unique('error') })
        .expect(201);

      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('FAILED');

      const payment = await prisma.payment.findUnique({
        where: { reference: res.body.reference },
        include: { events: true },
      });

      const failedEvent = payment.events.find(e => e.type === 'FAILED');
      expect(failedEvent).toBeDefined();
      expect(failedEvent.payload['reason']).toBe('PROVIDER_ERROR');
    });

    it('should handle network failure gracefully and allow retry', async () => {
      mockProvider.setFailureMode(MockFailureMode.NETWORK_FAILURE, 1);
      const idempotencyKey = unique('network');

      const res = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 50000, currency: 'NGN', idempotencyKey })
        .expect(201);

      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('FAILED');
      expect(res.body.message).toContain('Network failure');

      mockProvider.setFailureMode(MockFailureMode.NONE);

      const retryRes = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 50000, currency: 'NGN', idempotencyKey })
        .expect(201);

      expect(retryRes.body.success).toBe(true);
      expect(retryRes.body.status).toBe('COMPLETED');
    });
  });

  describe('Reconciliation', () => {
    it('should identify and auto-heal timeout discrepancies', async () => {
      mockProvider.setFailureMode(MockFailureMode.TIMEOUT, 1);
      const idempotencyKey = unique('recon');

      const paymentRes = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 75000, currency: 'NGN', idempotencyKey })
        .expect(201);

      expect(paymentRes.body.status).toBe('PENDING_PROVIDER_CONFIRMATION');

      const providerRef = `MOCK_RECON_${Date.now()}`;
      mockProvider.getLedger().set(paymentRes.body.reference, {
        reference: paymentRes.body.reference,
        providerRef,
        amount: 75000,
        currency: 'NGN',
        status: 'success',
        processedAt: new Date(),
      });

      const reconRes = await request(app.getHttpServer())
        .post('/reconciliation')
        .send({
          startDate: new Date(Date.now() - 60000).toISOString(),
          endDate: new Date(Date.now() + 60000).toISOString(),
        })
        .expect(201);

      expect(reconRes.body.discrepancies).toHaveLength(1);
      expect(reconRes.body.discrepancies[0].type).toBe('PROVIDER_SUCCESS_INTERNAL_PENDING');

      const healedPayment = await prisma.payment.findUnique({
        where: { reference: paymentRes.body.reference },
        include: { events: true },
      });

      expect(healedPayment.status).toBe('COMPLETED');
      expect(healedPayment.providerRef).toBe(providerRef);

      const reconEvent = healedPayment.events.find(e => e.type === 'RECONCILED');
      expect(reconEvent).toBeDefined();
    });

    it('should detect critical discrepancies', async () => {
      const reference = unique('critical');
      const payment = await prisma.payment.create({
        data: {
          reference,
          amount: 100000,
          currency: 'NGN',
          status: 'FAILED',
          idempotencyKey: unique('critical-key'),
        },
      });

      mockProvider.getLedger().set(reference, {
        reference,
        providerRef: 'MOCK_CRITICAL',
        amount: 100000,
        currency: 'NGN',
        status: 'success',
        processedAt: new Date(),
      });

      const reconRes = await request(app.getHttpServer())
        .post('/reconciliation')
        .send({
          startDate: new Date(Date.now() - 60000).toISOString(),
          endDate: new Date(Date.now() + 60000).toISOString(),
        })
        .expect(201);

      const critical = reconRes.body.discrepancies.find(
        d => d.type === 'PROVIDER_SUCCESS_INTERNAL_FAILED'
      );
      expect(critical).toBeDefined();
      expect(critical.action).toBe('CRITICAL_REQUIRES_MANUAL_REVIEW');
    });
  });

  describe('Audit Trail', () => {
    it('should produce complete event log for a successful payment', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments')
        .send({ amount: 25000, currency: 'NGN', idempotencyKey: unique('audit') })
        .expect(201);

      const payment = await prisma.payment.findUnique({
        where: { reference: res.body.reference },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });

      expect(payment.events).toHaveLength(3);
      expect(payment.events[0].type).toBe('INITIATED');
      expect(payment.events[1].type).toBe('PROVIDER_CALLED');
      expect(payment.events[2].type).toBe('CONFIRMED');
    });
  });
});
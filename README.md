# Payment Reliability Layer

Production-ready Nest.js payment processing module with idempotency, fault tolerance, and reconciliation.

## Features

- **Idempotent Payment Initiation**: Same order never charged twice via idempotency keys
- **Failure Mode Handling**: 
  - Provider Timeout → Marked for reconciliation
  - Provider Error → Immediate failure with audit trail
  - Network Failure → Retry with exponential backoff, then fail gracefully
- **Durable Audit Trail**: Append-only event log for every payment state transition
- **Reconciliation Engine**: Auto-heals timeout discrepancies, flags critical mismatches

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│  Payment     │────▶│ Idempotency│
│             │     │  Controller  │     │   Service   │
└─────────────┘     └──────────────┘     └─────────────┘
                                                  │
                           ┌──────────────────────┘
                           ▼
                    ┌──────────────┐
                    │   Payment    │
                    │   Service    │
                    └──────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌────────────┐ ┌────────────┐ ┌──────────────┐
    │  Provider  │ │  Event     │ │  Reconciliation│
    │  (Mock)    │ │  Logger    │ │  Service       │
    └────────────┘ └────────────┘ └──────────────┘
           │               │               │
           ▼               ▼               ▼
    ┌────────────┐ ┌────────────┐ ┌──────────────┐
    │ Provider   │ │  MongoDB   │ │  MongoDB       │
    │ Ledger     │ │  Events    │ │  Payments      │
    └────────────┘ └────────────┘ └──────────────┘
```

## Prerequisites

- Node.js 18+
- Docker & Docker Compose

## Setup

### 1. Start MongoDB (as a replica set — required by Prisma)

```bash
docker-compose up -d
```

Wait ~15 seconds for the replica set to initialize. You can verify with:

```bash
docker logs payment_mongodb
```

### 2. Install dependencies

```bash
npm install
```

### 3. Setup environment

```bash
cp .env.example .env
```

The `.env` already points to `localhost:27017` with the replica set configured.

### 4. Setup Prisma

```bash
npx prisma generate
npx prisma db push
```

### 5. Run end-to-end tests

```bash
npm run test:e2e
```

### 6. Start development server

```bash
npm run start:dev
```

## API Endpoints

### POST /payments
Initiate a payment. Requires `idempotencyKey` in body or `Idempotency-Key` header.

**Request:**
```json
{
  "amount": 50000,
  "currency": "NGN",
  "idempotencyKey": "unique-key-123",
  "metadata": { "orderId": "ORD-123" }
}
```

**Response (Success):**
```json
{
  "success": true,
  "paymentId": "...",
  "reference": "PAY_...",
  "status": "COMPLETED",
  "providerRef": "MOCK_REF_...",
  "message": "Payment completed successfully"
}
```

**Response (Idempotency Cache Hit):**
```json
{
  "success": true,
  "reference": "PAY_...",
  "status": "COMPLETED",
  "cached": true,
  "message": "Payment retrieved from idempotency cache"
}
```

### GET /payments/:reference
Retrieve payment with full event log.

### POST /reconciliation
Run reconciliation for a date range.

**Request:**
```json
{
  "startDate": "2024-01-01T00:00:00.000Z",
  "endDate": "2024-01-31T23:59:59.000Z"
}
```

**Response:**
```json
{
  "matched": 45,
  "discrepancies": [
    {
      "type": "PROVIDER_SUCCESS_INTERNAL_PENDING",
      "reference": "PAY_...",
      "providerStatus": "success",
      "internalStatus": "PENDING_PROVIDER_CONFIRMATION",
      "action": "UPDATE_INTERNAL_TO_COMPLETED"
    }
  ],
  "summary": "Reconciliation complete: 45 matched, 1 discrepancies found."
}
```

## Failure Mode Handling

| Failure Mode | System Behavior | Client Action | Audit Event |
|-------------|----------------|---------------|-------------|
| **Provider Timeout** | Mark `PENDING_PROVIDER_CONFIRMATION` | Poll or wait for reconciliation | `TIMEOUT` + `RECONCILED` |
| **Provider Error** | Mark `FAILED`, log provider response | Fix issue and retry with new key | `FAILED` (reason: PROVIDER_ERROR) |
| **Network Failure** | Mark `FAILED`, allow retry with same key | Retry with same idempotency key | `NETWORK_ERROR` |

## Idempotency Strategy

1. **Processing**: Returns `409 Conflict` if same key is in-flight
2. **Completed**: Returns cached response without calling provider
3. **Failed**: Clears key, allows retry with same key
4. **TTL**: Keys expire after 24 hours

## Reconciliation Discrepancy Types

- `PROVIDER_SUCCESS_INTERNAL_PENDING`: Auto-healed to COMPLETED
- `PROVIDER_SUCCESS_INTERNAL_FAILED`: Critical, requires manual review
- `INTERNAL_SUCCESS_PROVIDER_MISSING`: Verify provider ledger
- `AMOUNT_MISMATCH`: Critical, requires manual review
- `STATUS_MISMATCH`: Requires manual review

## Troubleshooting

### "Transactions are not supported by this deployment"

This means MongoDB is not running as a replica set. Use the provided `docker-compose.yml` which configures MongoDB with `--replSet rs0` and auto-initiates the replica set via `mongo-init.js`.

### Tests timeout on `beforeEach`

Ensure MongoDB is healthy: `docker-compose ps`. The container needs ~10-15 seconds on first startup to initiate the replica set.

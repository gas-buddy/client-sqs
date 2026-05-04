# @gasbuddy/client-sqs

A configuration-driven SQS client for GasBuddy services (gb-services v23+).

Built on `@aws-sdk/client-sqs` v3 and `sqs-consumer` v6.

---

## Installation

```bash
yarn add @gasbuddy/client-sqs
```

---

## Quick Start

```typescript
import { createSQSClient } from '@gasbuddy/client-sqs';
import type { BaseLogger } from 'pino';

const client = await createSQSClient(
  { logger: pino() },
  {
    endpoints: {
      default: {
        accountId: '123456789',
        config: { region: 'us-east-1' },
      },
    },
    queues: {
      orders: { name: 'orders-queue', deadLetter: 'orders-dlq' },
    },
  },
);
```

---

## Publishing Messages

```typescript
// Basic publish
await client.queues.orders.publish({ orderId: 'abc', amount: 9.99 });

// Publish with CorrelationId for request tracing
// The library does NOT auto-generate CorrelationId — pass it from your context.
await client.queues.orders.publish(
  { orderId: 'abc', amount: 9.99 },
  {
    MessageAttributes: {
      CorrelationId: {
        DataType: 'String',
        StringValue: ctx.correlationId, // from your request context
      },
    },
  },
);
```

---

## Subscribing (Consumer)

```typescript
const consumer = client.queues.orders.createConsumer<{ orderId: string; amount: number }>(
  async (context, message, original) => {
    // message is already parsed from JSON
    // original is the raw SQS Message with MessageAttributes, etc.

    // CorrelationId is available if the publisher included it
    const correlationId = original.MessageAttributes?.CorrelationId?.StringValue;

    await processOrder(message);
  },
);

consumer.start();

// To stop:
consumer.stop();
```

### Consumer options

```typescript
const consumer = client.queues.orders.createConsumer(handler, {
  batchSize: 5,           // messages per poll (default: 1)
  visibilityTimeout: 30,  // seconds
  waitTimeSeconds: 20,    // long poll duration
  messageAttributeNames: ['MyCustomAttr'], // merged with CorrelationId/ErrorDetail
});
```

The library always requests `CorrelationId`, `ErrorDetail`, and all SQS system attributes
(`attributeNames: ['All']`) so consumers always have access to these without extra config.

---

## Dead Letter Queues

Configure a `deadLetter` key on a queue with the **SQS queue name** to enable DLQ routing.
No separate entry in `queues` is needed — the DLQ URL is built automatically using the same
endpoint as the source queue:

```typescript
const client = await createSQSClient(ctx, {
  endpoints: { default: { ... } },
  queues: {
    payments: { name: 'payments-queue', deadLetter: 'payments-dlq' },
    // No separate DLQ entry needed — 'payments-dlq' is the SQS queue name, not a config key
  },
});
```

### Routing a message to the DLQ

**Pattern 1: Use `queue.reject(reason)`** — convenience method:

```typescript
const consumer = client.queues.payments.createConsumer(async (ctx, message, original) => {
  if (!message.amount) {
    // Routes to the configured deadLetter queue with ErrorDetail set to 'Missing amount'
    // Original message is ACKed (deleted from source queue)
    client.queues.payments.reject('Missing amount');
  }
  await processPayment(message);
});
```

**Pattern 2: Throw with `deadLetter: true`** — equivalent to `reject()`:

```typescript
const consumer = client.queues.payments.createConsumer(async (ctx, message) => {
  const err = new Error('Payment validation failed');
  (err as any).deadLetter = true;
  throw err;
});
```

**Pattern 3: Throw with a specific SQS queue name** — override the configured DLQ:

```typescript
const err = new Error('Route to audit queue');
(err as any).deadLetter = 'payments-audit-dlq'; // SQS queue name (not a config key)
throw err;
```

### What happens on DLQ routing

- Original message body is forwarded verbatim (no re-serialisation)
- Original `MessageAttributes` are preserved (including `CorrelationId`)
- `ErrorDetail` attribute is added with the error message string
- Original message is **ACKed** (deleted from source queue)
- If DLQ publish fails: logs error, rethrows (message returns to source queue for retry)
- If no `deadLetter` configured but `error.deadLetter = true`: logs error, rethrows

### Parse failures route to DLQ too

When a consumer receives a message with an unparseable JSON body:

- If `config.deadLetter` **is set**: the raw body is published to the DLQ with
  `ErrorDetail: "Invalid JSON: <reason>"` and the original `MessageAttributes`
  (including any publisher-set `CorrelationId`) are preserved. The source message
  is ACKed.
- If `config.deadLetter` **is not set**: the `SyntaxError` is logged and rethrown
  so `sqs-consumer` leaves the message visible. Any AWS-native `RedrivePolicy`
  on the queue will eventually move the message off the main queue, but the
  redrive path does **not** add `ErrorDetail` — operators should prefer
  configuring `deadLetter` on the queue so every DLQ message carries context.

This means the invariant **every DLQ message has `ErrorDetail`** holds for both
handler-thrown failures and parse failures when `config.deadLetter` is set.

---

## Non-Consumer Receive + Ack

For manual polling (e.g. batch processing):

```typescript
const messages = await client.queues.orders.receive<OrderMessage>({
  MaxNumberOfMessages: 10,
  WaitTimeSeconds: 5,
});

for (const { message, original } of messages) {
  if (message) {
    await processOrder(message);
    await client.queues.orders.ack(original);
  }
}

// Receive raw (no JSON parse):
const rawMessages = await client.queues.orders.receive({ noParse: true });
```

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| JSON parse failure + `deadLetter` configured | Publishes raw body to DLQ with `ErrorDetail: "Invalid JSON: <reason>"` and original `MessageAttributes`; ACKs source |
| JSON parse failure + no `deadLetter` configured | Logs error, **rethrows** (message returns to queue; AWS-native `RedrivePolicy` may take over, but without `ErrorDetail`) |
| JSON parse failure + DLQ publish fails | Logs error, rethrows (source stays visible) |
| Handler throws with `error.deadLetter = true` | Routes to configured DLQ, ACKs original |
| Handler throws with `error.deadLetter = 'queueName'` | Routes to named queue, ACKs original |
| Handler throws normally | Logs error, rethrows (message returns to queue) |
| DLQ not configured but `deadLetter = true` | Logs error, rethrows |
| DLQ publish fails | Logs error, rethrows original error |

---

## Configuration Reference

```typescript
interface SQSClientConfiguration<Q extends string, Endpoints extends 'default'> {
  queues: Record<Q, SQSQueueConfiguration>;
  endpoints?: Record<Endpoints, SQSEndpointConfiguration>;
}

interface SQSQueueConfiguration {
  name?: string;       // SQS queue name (defaults to the config key)
  deadLetter?: string; // SQS queue name of the DLQ (no separate config entry required)
  endpoint?: string;   // named endpoint for this queue (defaults to 'default')
}

interface SQSEndpointConfiguration {
  accountId?: string;    // AWS account ID for URL construction
  requiredRole?: string; // IAM role ARN fragment; verified via STS on startup
  config: SQSClientConfig; // passed directly to @aws-sdk/client-sqs SQSClient
}
```

---

## Local Development / Testing

Unit tests use a Jest manual mock of `@aws-sdk/client-sqs` (see `__mocks__/`) — no
external container required:

```bash
yarn test
```

CI runs the same suite against an ElasticMQ container (replacement for LocalStack).
No auth token needed.

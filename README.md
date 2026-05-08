# @gasbuddy/client-sqs

A configuration-driven SQS client for GasBuddy services (gb-services v23+).

Built on `@aws-sdk/client-sqs` v3 and `sqs-consumer` v6. Node 18+.

**What it adds on top of the AWS SDK:**

- Typed, named queue configuration — refer to queues by alias, not URL
- Auto-detected AWS region / accountId via EC2 instance metadata
- Optional STS `GetCallerIdentity` role check at startup (`requiredRole`)
- Library-managed dead-letter routing for both handler-thrown failures **and**
  JSON parse failures — every DLQ message carries `ErrorDetail`
- `CorrelationId` + `ErrorDetail` message-attribute pass-through (no auto-generation)
- `reject(reason)` convenience for handlers that want to send a poison message
  to the DLQ with a human-readable reason

---

## Installation

```bash
yarn add @gasbuddy/client-sqs
```

---

## Quick Start

```typescript
import { createSQSClient } from '@gasbuddy/client-sqs';
import pino from 'pino';

const client = await createSQSClient(
  { logger: pino() },
  {
    endpoints: {
      default: {
        accountId: '123456789',
        // Optional: verifies the running process has assumed this role via STS at startup.
        requiredRole: 'arn:aws:iam::123456789:role/sqs-consumer',
        config: { region: 'us-east-1' },
      },
    },
    queues: {
      orders: { name: 'orders-queue', deadLetter: 'orders-dlq' },
    },
  },
);
```

If `accountId` or `region` are omitted, the library fetches them from the EC2 instance
metadata service. Outside EC2 (local dev, CI), supply both explicitly.

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

### Consumer error events

The library wires default `error`, `processing_error`, and `timeout_error` listeners that log
through the `context.logger` you supplied to `createSQSClient`. You can attach your own
listeners on top — they fire alongside the library's:

```typescript
consumer.on('error', (err) => metrics.increment('sqs.error'));
consumer.on('processing_error', (err) => alerting.notify(err));
```

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
  } else {
    // Parse failure — `message` is undefined and `original.Body` holds the raw bytes.
    // Caller decides what to do (DLQ-publish manually, ack-and-drop, leave for redrive).
    // Unlike createConsumer(), receive() does NOT auto-route parse failures to config.deadLetter.
  }
}

// Receive raw (no JSON parse — every entry comes back with message: undefined):
const rawMessages = await client.queues.orders.receive({ noParse: true });
```

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `createConsumer`: JSON parse failure + `deadLetter` configured | Publishes raw body to DLQ with `ErrorDetail: "Invalid JSON: <reason>"` and original `MessageAttributes`; ACKs source |
| `createConsumer`: JSON parse failure + no `deadLetter` configured | Logs error, **rethrows** (message returns to queue; AWS-native `RedrivePolicy` may take over, but without `ErrorDetail`) |
| `createConsumer`: JSON parse failure + DLQ publish fails | Logs error, rethrows (source stays visible) |
| `createConsumer`: handler throws with `error.deadLetter = true` | Routes to configured DLQ, ACKs original |
| `createConsumer`: handler throws with `error.deadLetter = 'queueName'` | Routes to named queue, ACKs original |
| `createConsumer`: handler throws normally | Logs error, rethrows (message returns to queue) |
| `createConsumer`: DLQ not configured but `deadLetter = true` | Logs error, rethrows |
| `createConsumer`: DLQ publish fails | Logs error, rethrows original error |
| `receive()`: JSON parse failure | Logs warning, returns `{ message: undefined, original }` — caller decides |
| `receive({ noParse: true })` | Always returns `{ message: undefined, original }` for every result |

---

## Configuration Reference

```typescript
interface SQSClientConfiguration<Q extends string, Endpoints extends 'default' = 'default'> {
  queues: Record<Q, SQSQueueConfiguration>;
  endpoints?: Record<Endpoints, SQSEndpointConfiguration>;
}

interface SQSQueueConfiguration {
  name?: string;       // SQS queue name (defaults to the config key)
  deadLetter?: string; // SQS queue name of the DLQ (no separate config entry required)
  readers?: number;    // Hint consumed by callers that spin up multiple createConsumer()
                       // instances; the library itself does not multiply consumers — it is
                       // a config-level field for orchestration code (e.g. v21 parity)
  endpoint?: string;   // Named endpoint key for this queue (defaults to 'default')
}

interface SQSEndpointConfiguration {
  accountId?: string;    // AWS account ID for URL construction (auto-fetched from EC2 metadata if unset)
  requiredRole?: string; // Substring matched against STS GetCallerIdentity ARN at startup;
                         // throws if the running process is not assuming a matching role
  config: SQSClientConfig; // Passed directly to @aws-sdk/client-sqs SQSClient (region, endpoint, credentials)
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

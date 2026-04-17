# @gasbuddy/client-sqs

A configuration-driven SQS client for GasBuddy services.

> **See also**: [Project Structure](docs/ai-context/project-structure.md) | [Docs Overview](docs/ai-context/docs-overview.md)

---

## Architecture

Thin wrapper around `@aws-sdk/client-sqs` and `sqs-consumer` that provides:
- Named queue configuration with endpoint mapping
- Auto-detected AWS region/accountId via EC2 instance metadata
- IAM role verification before connecting
- JSON publish/consume with full dead-letter routing
- CorrelationId + ErrorDetail attribute pass-through
- Typed TypeScript API with generics for queue names and message shapes

### Entry Point

```ts
import { createSQSClient } from '@gasbuddy/client-sqs';

const client = await createSQSClient(context, config);
// client.queues.<name>.publish(msg, options?)
// client.queues.<name>.createConsumer(handler, options?)
// client.queues.<name>.receive(options)
// client.queues.<name>.ack(message)
// client.queues.<name>.reject(reason)  // DLQ routing convenience
```

### Dead Letter Routing

Set `deadLetter` on a queue config to enable DLQ routing. In handlers, call `queue.reject('reason')` or throw with `error.deadLetter = true`. The library will:
1. Publish the raw message body to the DLQ with `ErrorDetail` + original `MessageAttributes`
2. ACK the original message (delete from source queue)

See `README.md` for full examples.

### CorrelationId

The library always requests `CorrelationId` and `ErrorDetail` from SQS in every consumer (`messageAttributeNames`). Publishers must provide `CorrelationId` in `MessageAttributes` — the library does NOT auto-generate it.

---

## Quick Start

```ts
const client = await createSQSClient({ logger }, {
  endpoints: {
    default: {
      accountId: '123456789',
      config: { region: 'us-east-1', endpoint: 'http://localhost:4566' },
    },
  },
  queues: {
    myQueue: { name: 'actual-queue-name' },
  },
});

await client.queues.myQueue.publish({ event: 'order.created' });
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | `createSQSClient` factory — wires endpoints + queues |
| `src/queue.ts` | `SQSEnhancedQueue` implementation (publish/consume/receive/ack) |
| `src/endpoints.ts` | Endpoint builder — EC2 metadata fetch, STS role verification |
| `src/roles.ts` | `assumeRole` helper (verifies STS caller identity) |
| `src/types/index.ts` | Public types: configs, context, enhanced queue interfaces |
| `src/types/internal.ts` | Internal `RawSqsEndpoint` type |

---

## Build & Test

```bash
yarn build        # tsc → build/
yarn test         # jest (requires localstack on :4566)
yarn lint         # eslint src/
```

Tests connect to a real local SQS endpoint (localstack). Set `SQS_HOST`, `SQS_PORT`, `SQS_ACCOUNT_ID` env vars to override defaults.

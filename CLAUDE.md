# @gasbuddy/client-sqs

A configuration-driven SQS client for GasBuddy services.

---

## Architecture

Thin wrapper around `@aws-sdk/client-sqs` and `sqs-consumer` that provides:
- Named queue configuration with endpoint mapping (each queue picks an endpoint by key; `default` if unspecified)
- Auto-detected AWS region/accountId via EC2 instance metadata when not supplied
- IAM role verification at startup via STS `GetCallerIdentity` (`requiredRole` on the endpoint)
- JSON publish/consume with library-managed dead-letter routing for both handler-thrown failures and JSON parse failures
- `CorrelationId` + `ErrorDetail` message-attribute pass-through; library never auto-generates `CorrelationId`
- Per-queue `reject(reason)` convenience and `receive()` / `ack()` for non-consumer flows
- Typed TypeScript API with generics for queue names, endpoints, and message shapes

### Entry Point

```ts
import { createSQSClient } from '@gasbuddy/client-sqs';

const client = await createSQSClient(context, config);
// client.queues.<name>.publish(msg, options?)
// client.queues.<name>.createConsumer(handler, options?)
// client.queues.<name>.receive(options)        // manual poll; returns { message?, original }[]
// client.queues.<name>.ack(message)            // delete by ReceiptHandle
// client.queues.<name>.reject(reason)          // throws Error w/ deadLetter=true; never returns
```

### Dead Letter Routing

Set `deadLetter` on a queue config (an SQS queue name, not a config key) to enable DLQ
routing. Two triggers send a message to the DLQ via the same `publishToDeadLetter()` helper:

1. **Handler-thrown failure** — `queue.reject('reason')` or throw with `error.deadLetter = true`
   (or `error.deadLetter = 'overrideQueueName'` to route to a different DLQ).
2. **JSON parse failure** — library routes unparseable bodies to the configured DLQ with
   `ErrorDetail: "Invalid JSON: <reason>"`.

In both cases the library:
1. Publishes the raw message body to the DLQ with `ErrorDetail` + original `MessageAttributes`
2. ACKs the original message (deletes from source queue)

Every DLQ message carries `ErrorDetail` — the contract is encoded in a single helper shared
by both paths. When `config.deadLetter` is unset, parse failures rethrow so `sqs-consumer`
leaves the message visible (any AWS-native `RedrivePolicy` may take over, but the AWS redrive
path does not add `ErrorDetail`).

### Receive (non-consumer flow)

`queue.receive({ ... })` issues a single `ReceiveMessageCommand` and returns
`{ message?, original }[]`. Parse failures here are an explicit opt-out: the library logs
the error and returns `message: undefined` with the raw `original` so the caller can
decide what to do. DLQ routing in `receive()` is the **caller's** responsibility — only
`createConsumer()` runs the managed DLQ-publish path. Pass `noParse: true` to skip JSON
parsing entirely and always get `message: undefined`.

### CorrelationId

The library always requests `CorrelationId` and `ErrorDetail` from SQS in every consumer
(`messageAttributeNames`). Caller-supplied `messageAttributeNames` are merged in.
Publishers must provide `CorrelationId` in `MessageAttributes` — the library does NOT
auto-generate it.

---

## Quick Start

```ts
const client = await createSQSClient({ logger }, {
  endpoints: {
    default: {
      accountId: '123456789',
      requiredRole: 'arn:aws:iam::123456789:role/sqs-consumer', // optional STS check
      config: { region: 'us-east-1' },
    },
  },
  queues: {
    myQueue: { name: 'actual-queue-name', deadLetter: 'actual-queue-name-dlq' },
  },
});

await client.queues.myQueue.publish({ event: 'order.created' }, {
  MessageAttributes: {
    CorrelationId: { DataType: 'String', StringValue: ctx.correlationId },
  },
});
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | `createSQSClient` factory — wires endpoints + queues |
| `src/queue.ts` | `SQSEnhancedQueue` impl — publish/createConsumer/receive/ack/reject + `publishToDeadLetter` helper |
| `src/endpoints.ts` | Endpoint builder — EC2 metadata fetch, STS role verification |
| `src/roles.ts` | `assumeRole` helper (verifies STS caller identity) |
| `src/types/index.ts` | Public types: configs, context, enhanced queue interfaces |
| `src/types/internal.ts` | Internal `RawSqsEndpoint` type |
| `__mocks__/@aws-sdk/client-sqs.ts` | Jest manual mock used by `__tests__/index.spec.ts` |
| `__tests__/index.spec.ts` | Unit suite — DLQ routing, parse-failure DLQ, CorrelationId, reject() |

---

## Build & Test

```bash
yarn build        # tsc → build/
yarn test         # jest — uses manual mock of @aws-sdk/client-sqs (__mocks__/)
yarn lint         # eslint src/
```

Unit tests use a Jest manual mock — no external container required. CI runs the same suite
against an ElasticMQ container (replaced LocalStack because LocalStack requires an auth token
post-2026).

# src — Source Modules

## Purpose

All library source code. TypeScript, compiled to `build/` via `tsc`.

---

## Files

### `index.ts` — Public Entry Point
- Exports `createSQSClient` (the only factory consumers call)
- Re-exports all public types from `types/index.ts`
- Orchestrates: `buildEndpoints` → `getQueue` per queue → returns `SQSEnhancedQueueClient`
- **allQueues mutable reference**: declared before `Promise.all`, populated after, passed to each
  `getQueue` call so consumer closures can look up sibling queues for DLQ routing

### `endpoints.ts` — Endpoint Builder
- `buildEndpoints(context, endpointConfig)` → `Record<Endpoints, RawSqsEndpoint>`
- **Auto-detection**: if any endpoint lacks `accountId` or `region`, fetches from EC2 metadata
- **Role guard**: if any endpoint has `requiredRole`, calls STS `GetCallerIdentity` and asserts ARN

### `queue.ts` — Queue Implementation
- `getQueue(context, endpoints, localName, config, allQueues)` → `SQSEnhancedQueue`
- **publish**: `SendMessageCommand` with JSON body; passes through `MessageAttributes` unchanged
  (no CorrelationId auto-generation — caller's responsibility)
- **createConsumer**: wraps `sqs-consumer` `Consumer`
  - Always requests `messageAttributeNames: ['CorrelationId', 'ErrorDetail', ...callerAttrs]`
  - Always requests `attributeNames: ['All']` (system attributes like ApproximateReceiveCount)
  - JSON parse failure: logs + rethrows (message NOT acked)
  - Handler throws `error.deadLetter = true`: routes to `config.deadLetter` queue, ACKs original
  - Handler throws `error.deadLetter = "queueName"`: routes to named queue, ACKs original
  - No DLQ configured: logs error, rethrows
  - DLQ publish failure: logs + rethrows
- **receive**: `ReceiveMessageCommand`; returns parsed messages (or raw if `noParse: true`)
- **ack**: `DeleteMessageCommand` by `ReceiptHandle`
- **reject(reason)**: convenience — creates `Error(reason)` with `deadLetter=true`, throws

### `roles.ts` — Role Helper
- `assumeRole(role?)` — standalone STS identity check
- Superseded by the inline role check in `endpoints.ts`

### `types/index.ts` — Public Types
- `SQSQueueConfiguration` — per-queue options (name override, deadLetter, endpoint)
- `SQSEndpointConfiguration` — per-endpoint options (accountId, requiredRole, SQSClientConfig)
- `SQSClientConfiguration<Q, Endpoints>` — top-level config passed to `createSQSClient`
- `SQSClientContext` — `{ logger: BaseLogger }` (pino)
- `SQSEnhancedQueue<CTX>` — per-queue interface: publish, createConsumer, receive, ack, reject
- `SQSEnhancedQueueClient<Q, Endpoints, CTX>` — returned by `createSQSClient`

### `types/internal.ts` — Internal Types
- `RawSqsEndpoint` — `{ sqs: SQSClient, config, region, accountId }` (not exported)

---

## Patterns

- **DLQ routing**: throw `Object.assign(new Error(msg), { deadLetter: true })` or call `queue.reject(msg)`
- **CorrelationId**: caller provides in `MessageAttributes`; library always requests it from SQS
- **No silent acks**: both parse errors and handler errors rethrow (message returns to queue)
- Consumer errors log then rethrow; `sqs-consumer` does NOT ack the message on throw

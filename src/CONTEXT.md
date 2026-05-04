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
  - JSON parse failure + `config.deadLetter` set: publishes raw body to DLQ with
    `ErrorDetail: "Invalid JSON: <reason>"` and original `MessageAttributes`, ACKs source
  - JSON parse failure + no `config.deadLetter`: logs + rethrows (message NOT acked; AWS-native
    `RedrivePolicy` may take over, but without `ErrorDetail`)
  - Handler throws `error.deadLetter = true`: routes to `config.deadLetter` queue, ACKs original
  - Handler throws `error.deadLetter = "queueName"`: routes to named queue, ACKs original
  - No DLQ configured: logs error, rethrows
  - DLQ publish failure: logs + rethrows (source stays visible)
  - All DLQ publishes go through a single `publishToDeadLetter()` helper so every DLQ
    message carries `ErrorDetail`
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
- **No silent acks**: unparseable messages are either routed to the configured DLQ
  (with `ErrorDetail` + preserved `MessageAttributes`) or rethrown when no DLQ is configured —
  never silently dropped. Handler errors without `deadLetter` rethrow so the source message stays visible.
- Consumer errors log then rethrow; `sqs-consumer` does NOT ack the message on throw
- **Single DLQ publish path**: both parse failures and handler-thrown `deadLetter` errors go
  through `publishToDeadLetter()` so the invariant *every DLQ message has `ErrorDetail`* is
  encoded in one place

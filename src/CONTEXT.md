# src — Source Modules

## Purpose

All library source code. TypeScript, compiled to `build/` via `tsc`.

---

## Files

### `index.ts` — Public Entry Point
- Exports `createSQSClient` (the only factory consumers call)
- Re-exports all public types from `types/index.ts`
- Orchestrates: `buildEndpoints` → `getQueue` per queue → returns `SQSEnhancedQueueClient`

### `endpoints.ts` — Endpoint Builder
- `buildEndpoints(context, endpointConfig)` → `Record<Endpoints, RawSqsEndpoint>`
- **Auto-detection**: if any endpoint lacks `accountId` or `region`, fetches from EC2 metadata (`http://169.254.169.254/...`)
- **Role guard**: if any endpoint has `requiredRole`, calls STS `GetCallerIdentity` and asserts ARN contains the role string
- Instantiates one `SQSClient` per endpoint

### `queue.ts` — Queue Implementation
- `getQueue(context, endpoints, localName, config)` → `SQSEnhancedQueue`
- Constructs queue URL: `{endpoint}/{accountId}/{name}`
- **publish**: `SendMessageCommand` with JSON body
- **createConsumer**: wraps `sqs-consumer` `Consumer`; auto-parses JSON, logs errors, throws to trigger redelivery
- **receive**: `ReceiveMessageCommand`; returns parsed messages (or raw if `noParse: true`)
- **ack**: `DeleteMessageCommand` by `ReceiptHandle`
- Dead-letter: `error.deadLetter` flag detected but routing is TODO

### `roles.ts` — Role Helper
- `assumeRole(role?)` — standalone STS identity check
- Used internally; superseded by the inline role check in `endpoints.ts`

### `types/index.ts` — Public Types
- `SQSQueueConfiguration` — per-queue options (name override, deadLetter, readers, endpoint)
- `SQSEndpointConfiguration` — per-endpoint options (accountId, requiredRole, SQSClientConfig)
- `SQSClientConfiguration<Q, Endpoints>` — top-level config passed to `createSQSClient`
- `SQSClientContext` — `{ logger: BaseLogger }` (pino)
- `SQSEnhancedQueue<CTX>` — per-queue interface with full typed methods
- `SQSEnhancedQueueClient<Q, Endpoints, CTX>` — returned by `createSQSClient`

### `types/internal.ts` — Internal Types
- `RawSqsEndpoint` — `{ sqs: SQSClient, config, region, accountId }` (not exported)

---

## Patterns

- All async operations propagate errors; consumers should wrap in try/catch
- JSON parse errors are logged as `warn`/`error` and the message is skipped (not thrown)
- Consumer errors are logged then rethrown so `sqs-consumer` does NOT ack the message

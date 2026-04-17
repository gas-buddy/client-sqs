# __tests__ — Test Suite

## Purpose

Integration tests for `@gasbuddy/client-sqs`. Requires a running localstack (or real SQS) endpoint.

---

## Setup

| Env Var | Default | Purpose |
|---------|---------|--------|
| `SQS_HOST` | `127.0.0.1` | SQS host (localstack) |
| `SQS_PORT` | `4566` | SQS port |
| `SQS_ACCOUNT_ID` | `000000000000` | AWS account ID for queue URLs |

**Run**: `yarn test` (Jest 29 + ts-jest)

---

## Files

### `index.spec.ts`

Single describe block `'SQS Client'` covering:

1. **Client creation** — `createSQSClient` with explicit endpoint config
2. **Consumer flow** — `createConsumer` + `start()`, publish message, assert delivery
3. **Receive + ack flow** — `receive()` with `MaxNumberOfMessages`/`WaitTimeSeconds`, then `ack()`

**Mocking**: `global.fetch` is mocked in `beforeEach` to return a fake EC2 metadata response (`{"region":"foobar"}`). This prevents the real metadata endpoint from being called.

---

## Patterns

- Tests connect to a real local queue — no mocked SQS client
- Each test uses a unique `Date.now()` payload to tolerate concurrent test runs
- Consumer is always stopped (`consumer.stop()`) before test ends

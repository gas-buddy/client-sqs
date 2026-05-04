# __tests__ — Test Suite

## Purpose

Unit tests for `@gasbuddy/client-sqs`. Uses a Jest manual mock of `@aws-sdk/client-sqs`
(see `__mocks__/@aws-sdk/client-sqs.ts`) — no external container or real SQS endpoint
required. CI runs the same suite against an ElasticMQ container for an additional
end-to-end smoke check.

---

## Setup

**Run**: `yarn test` (Jest 29 + ts-jest)

No env vars required. `jest.mock('@aws-sdk/client-sqs')` at the top of the spec
activates the manual mock, which exposes `mockSend`, `mockSqsSend`, and
`resetSqsMock` helpers for per-test assertion and reset.

---

## Files

### `index.spec.ts`

Unit coverage of `src/queue.ts` via `getQueue(...)`. Describe blocks:

1. **JSON parse error (no DLQ configured)** — rethrows on unparseable body, handler never invoked.
2. **Parse failure DLQ routing** — unparseable body routes to `config.deadLetter` with
   `ErrorDetail: "Invalid JSON: <reason>"` and preserved `MessageAttributes`
   (incl. `CorrelationId`); publish failure on DLQ rethrows.
3. **DLQ routing (payment-serv config pattern)** — handler-thrown `deadLetter=true`
   publishes to DLQ with `ErrorDetail` + `CorrelationId`, ACKs original; `deadLetter`
   string override routes to named queue; missing DLQ config logs + rethrows; DLQ
   publish fail rethrows.
4. **Consumer message attribute names** — `CorrelationId` + `ErrorDetail` always
   requested; caller attrs merged without dropping library defaults.
5. **publish() CorrelationId pass-through** — forwards `CorrelationId` when provided;
   does NOT inject when omitted.
6. **reject()** — throws with `deadLetter=true` and integrates with DLQ routing.

**Internal handle access**: `sqs-consumer` stores `handleMessage` on
`_sqsOptions` / `sqsOptions` / `options` depending on version. Tests use
`getInternalHandle(consumer)` to invoke it directly without starting a poller.

---

## Patterns

- Tests use the Jest manual mock — no real SQS connection, no network, no containers.
- `afterEach` calls `resetSqsMock()` to clear mock state between tests.
- Consumer always stopped (`consumer.stop()`) before test ends to release sqs-consumer internals.
- For DLQ failure-injection tests, swap the mocked `send` via `mockSqsSend(jest.fn().mockRejectedValue(...))`.

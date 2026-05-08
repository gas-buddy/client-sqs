# Gap Analysis: @gasbuddy/client-sqs vs @gasbuddy/configured-sqs-client

## Overview

During the v23 migration, payment-serv moved from `@gasbuddy/configured-sqs-client` (v21) to
`@gasbuddy/client-sqs` (v23). This document compares the two clients, identifies operational gaps
in the new client, and specifies what payment-serv needs to address.

---

## Feature Comparison

| Feature | configured-sqs-client (v21) | client-sqs (v23) | Gap |
|---|---|---|---|
| Publish with message attributes | ✅ Full support | ✅ Full support | None |
| Subscribe / consumer loop | ✅ `subscribe()` | ✅ `createConsumer()` | API change, functionally equivalent |
| CorrelationId propagation | ✅ Auto via `contextFunction` | ⚠️ Synthetic only (app-level) | Partial — see Gap 1 |
| Dead letter queue routing | ✅ Auto-routes on `error.deadLetter` | ❌ TODO in source, not implemented | **Critical — see Gap 2** |
| Failure reason metadata on DLQ | ✅ `ErrorDetail` attribute added | ❌ Not implemented | **Critical — see Gap 3** |
| Explicit nack / reject with reason | ✅ `req.gb.sqs.reject(reason)` | ❌ No method | **Critical — see Gap 4** |
| Message compression | ✅ `compression: true` option | ❌ Not supported | Minor for payment-serv |
| Silent message discard on parse error | ✅ Routes to DLQ | ✅ Routes to `config.deadLetter` with `ErrorDetail` (v1.1.0-beta.2) | Resolved — see Gap 5 |
| Multi-reader concurrency | ✅ `readers` config per queue | ✅ Via `sqs-consumer` options | None |
| IAM role validation at startup | ✅ `assumedRole` | ✅ `requiredRole` | None (renamed) |
| Auto account ID / region discovery | ✅ EC2 metadata | ✅ EC2 metadata | None |
| Multi-endpoint support | ✅ | ✅ | None |

---

## Gap Details

### Gap 1 — CorrelationId not propagated from publisher to handler

**v21 behaviour:**
`configured-sqs-client` used a `contextFunction` config key
(`require:@gasbuddy/gb-services#contextFromQueueMessage`) which extracted the `CorrelationId`
message attribute from the SQS envelope and injected it as `context.headers.correlationid`.
Publishers set `correlationid` in publish options; handlers received the same ID, maintaining
the full distributed trace chain.

**v23 behaviour:**
`client-sqs` does not read or propagate message attributes into context. `sqs-subscriptions.ts`
generates a synthetic ID at consumption time:
```typescript
const correlationId = `sqs-${queueName}-${original.MessageId}`;
```
This breaks the trace chain — a handler processing a message published by an HTTP request has
no link back to that request's correlationId.

**Impact:**
- Logs from async SQS processing cannot be correlated with the originating HTTP request
- Harder to trace a full flow (e.g. "which request triggered this Dwolla webhook to fail?")

**Fix needed in payment-serv:**
When publishing, include the request correlationId as a message attribute:
```typescript
await sqs.queues.payment_dwolla_webhooks.publish(message, {
  MessageAttributes: {
    CorrelationId: {
      DataType: 'String',
      StringValue: req.headers.correlationid as string || crypto.randomUUID(),
    },
  },
});
```
When consuming in `wrapHandler()`, read the attribute and use it as the synthetic request's
correlationId instead of the generated one:
```typescript
const correlationId =
  original.MessageAttributes?.CorrelationId?.StringValue
  ?? `sqs-${queueName}-${original.MessageId}`;
```

---

### Gap 2 — Dead letter queue routing not implemented

**v21 behaviour:**
When a handler threw an error with `error.deadLetter = true`, `configured-sqs-client`
automatically published the original message to the queue's configured `deadLetter` queue,
then deleted the original from the source queue (clean processing). This prevented infinite
retry loops for poison messages.

**v23 behaviour:**
`client-sqs` `queue.js` (line 45–49) detects `error.deadLetter` but does nothing:
```javascript
if (error.deadLetter) {
  if (!config.deadLetter) {
    context.logger.error(error, 'SQS deadLetter error, but no deadLetter queue configured');
  }
  // TODO dead letter handling
}
context.logger.error(error, 'SQS Consumer handler error');
throw error;  // re-throws → message becomes visible again after timeout
```
The `deadLetter` config field exists on all 16 webhook queue pairs in payment-serv's config but
has no effect. Poison messages retry indefinitely until the SQS queue's own redrive policy
(configured at the AWS level) eventually moves them.

**Impact:**
- Unprocessable messages (e.g. misformatted Dwolla webhook, unknown transaction ID) retry
  continuously until AWS redrive kicks in
- No `ErrorDetail` attribute attached — AAs see a message in the DLQ with no context on why
  it was rejected
- Processing throughput degraded by repeated failed re-deliveries

**Fix needed in client-sqs:**
Implement the TODO: when `error.deadLetter` is set and a DLQ queue name is configured,
publish the original message to the DLQ queue (with `ErrorDetail` attribute containing
`error.message`), then return the original message to trigger auto-ack (delete from source).

**Workaround available today in payment-serv:**
Handlers can manually publish to the DLQ and return without throwing:
```typescript
// In a handler that cannot process a message:
if (!canProcess) {
  await req.app.locals.sqs.queues.payment_dwolla_webhooks_unprocessable.publish(message, {
    MessageAttributes: {
      ErrorDetail: { DataType: 'String', StringValue: 'Transaction not found' },
      CorrelationId: { DataType: 'String', StringValue: correlationId },
    },
  });
  return; // auto-acks the original
}
```
This is verbose but functional until `client-sqs` implements the TODO.

---

### Gap 3 — No failure reason metadata on DLQ messages

**v21 behaviour:**
When routing to DLQ, `configured-sqs-client` added an `ErrorDetail` message attribute
containing the error message from the handler that rejected it. This allowed AAs to see in the
SQS console (or via tooling) *why* a message was unprocessable, speeding up triage and
targeted reprocessing.

**v23 behaviour:**
No `ErrorDetail` attribute is added anywhere. DLQ messages are indistinguishable from each
other in terms of failure reason.

**Impact:**
- AAs cannot determine failure reason without parsing the message body and cross-referencing logs
- Reprocessing decisions must be made blind
- Harder to distinguish transient failures (network timeout) from permanent ones (bad data)

**Fix needed in payment-serv (workaround until client-sqs implements Gap 2):**
Use the manual DLQ publish pattern from Gap 2, always including `ErrorDetail` and
`CorrelationId` attributes. Standardise this in a helper:

```typescript
// src/lib/sqs-dead-letter.ts
export async function rejectToDeadLetter(
  app: PaymentServApp,
  deadLetterQueueKey: keyof typeof app.locals.sqs.queues,
  originalMessage: any,
  reason: string,
  correlationId: string,
) {
  await app.locals.sqs!.queues[deadLetterQueueKey].publish(originalMessage, {
    MessageAttributes: {
      ErrorDetail: { DataType: 'String', StringValue: reason },
      CorrelationId: { DataType: 'String', StringValue: correlationId },
    },
  });
}
```

---

### Gap 4 — No explicit nack / reject API

**v21 behaviour:**
`req.gb.sqs.reject(reason)` provided a clean, explicit API for handlers to programmatically
reject a message with a human-readable reason, routing it to the DLQ. This was used in
`handleJobEvent` for unsupported `JobId` values and in webhook handlers for events that
couldn't be matched to known event types.

**v23 behaviour:**
`client-sqs` has no `reject()`, `nack()`, or `fail()` method. Handlers either:
- Return normally → message is **silently acked** (deleted) — unprocessable messages are lost
- Throw an error → message is **requeued** via visibility timeout — no DLQ routing, no reason

**Current payment-serv pattern for "soft" rejections:**
```typescript
// handleJobEvent — unknown JobId
default:
  context.app.locals.logger.warn({ JobId }, `Unsupported JobId: ${JobId}`);
  // falls through — message is acked (silently discarded)
```
This silently discards messages with unknown `JobId` values instead of routing them to the DLQ
for investigation.

**Impact:**
- Messages with unrecognised routing keys are silently lost, not DLQ'd
- No visibility into how many messages were discarded vs. processed
- Harder to detect deployment mismatches where a producer sends a new message type before
  the consumer is updated

**Fix needed in payment-serv:**
All `default:` / unrecognised-key branches should use the manual DLQ helper from Gap 3 rather
than silently returning:
```typescript
// handleJobEvent
default:
  await rejectToDeadLetter(
    context.app,
    'payment_serv_job_unprocessable',
    message,
    `Unsupported JobId: ${JobId}`,
    correlationId,
  );
```

---

### Gap 5 — Silent ack on JSON parse error

**v21 behaviour:**
A message with an invalid JSON body was treated as permanently unprocessable and routed to
the DLQ.

**v23 behaviour (original, pre-v1.1.0):**
`queue.js` (line 33–37):
```javascript
try {
  parsed = JSON.parse(message.Body);
} catch (e) {
  context.logger.error(e, 'Invalid JSON in SQS message');
}
if (parsed) {
  await handler(context, parsed, message);
}
// Returns message regardless → auto-acks (deletes) the bad message
return message;
```
A message with malformed JSON is logged as an error but then **auto-acked and deleted**. The
message is permanently lost — not retried, not DLQ'd.

**Impact:**
- Malformed messages are silently discarded
- No way for AAs to inspect or replay them
- Potential data loss if a producer has a serialisation bug

---

#### Resolution — v1.1.0-beta.1 (partial) and v1.1.0-beta.2 (complete)

**v1.1.0-beta.1** closed the silent-ack regression: parser now throws, `sqs-consumer`
leaves the message visible, and AWS-native `RedrivePolicy` (if configured at the AWS
level) eventually routes the poison message to a DLQ. **However**, that AWS-native
redrive path does not attach the `ErrorDetail` attribute the library otherwise
guarantees. Only messages rejected via `reject(reason)` / `err.deadLetter = true` got
`ErrorDetail`. Parse-failure DLQ messages therefore landed without the context an
operator needs to triage them, breaking the invariant advertised in `README.md` and
`CLAUDE.md`.

**v1.1.0-beta.2** routes parse failures through the same `publishToDeadLetter()` helper
the library already used for handler-thrown `deadLetter` errors. Behaviour now:

- `config.deadLetter` set → publish raw body to DLQ with
  `ErrorDetail: "Invalid JSON: <reason>"` and the original `MessageAttributes` (incl.
  `CorrelationId`); ACK source.
- `config.deadLetter` unset → rethrow (preserves beta.1 behaviour; AWS-native
  `RedrivePolicy` may take over, but without `ErrorDetail`).
- DLQ publish itself fails → rethrow so source stays visible (do not ACK a message we
  failed to archive).

The invariant *every DLQ message has `ErrorDetail`* is now encoded in a single helper
shared by both branches.

See `src/queue.ts` (`publishToDeadLetter` + parse-failure branch in `handleMessage`) and
`__tests__/index.spec.ts` (suite *Parse failure DLQ routing*).

#### End-to-end verification (payment-serv + LocalStack, 2026-05-04)

**Setup:** payment-serv on v23, LocalStack, main queue `payment_dwolla_webhooks` + DLQ
`payment_dwolla_webhooks_unprocessable`, `deadLetter: "payment_dwolla_webhooks_unprocessable"`.

*Scenario A — handler `reject()` (Gap 4 path).* Unknown-topic Dwolla message →
`dwollaNotification` calls `queue.reject('Unhandled Dwolla event: ...')`.

DLQ message:
```json
{
  "Body": "{\"topic\":\"totally_unknown_gap4\",...}",
  "MessageAttributes": {
    "CorrelationId": { "StringValue": "gap4-manual-1777934661", "DataType": "String" },
    "ErrorDetail":   { "StringValue": "Unhandled Dwolla event: totally_unknown_gap4",
                       "DataType": "String" }
  },
  "Attributes": { "ApproximateReceiveCount": "1" }
}
```
✅ `ErrorDetail` + `CorrelationId` preserved; single explicit publish (no redrive).

*Scenario B — malformed JSON (the gap).* Body `not-json-at-all-}{broken` published to main queue.

- **beta.1:** parser throws, `sqs-consumer` leaves the message visible, loops forever
  unless AWS-native redrive is configured. With redrive enabled, the DLQ message has
  `ApproximateReceiveCount=3`, `DeadLetterQueueSourceArn` set, and **no `ErrorDetail`,
  no `CorrelationId`** — invariant broken.
- **beta.2:** library publishes directly:
  ```json
  {
    "Body": "not-json-at-all-}{broken",
    "MessageAttributes": {
      "CorrelationId": { "StringValue": "gap5-parsefail-1777936363", "DataType": "String" },
      "ErrorDetail":   { "StringValue": "Invalid JSON: Unexpected token o in JSON at position 1",
                         "DataType": "String" }
    },
    "Attributes": { "ApproximateReceiveCount": "1" }
  }
  ```
  ✅ `ErrorDetail` + `CorrelationId` preserved; no dependency on AWS-native `RedrivePolicy`.

**payment-serv side:** no consumer code change needed — `sqs-subscriptions.ts`
`wrapHandler()` and handler `reject()` sites are unchanged. Jest coverage in
`__tests__/sqs_reject_paths.spec.ts` + `sqs_wrap_handler.spec.ts` +
`sqs_job_routing.spec.ts` (payment-serv commit `23440295`) locks Scenario A at the
handler level; end-to-end Scenarios A + B verified manually against LocalStack as
recorded above.

---

## Summary: What Needs to Change

### In `@gasbuddy/client-sqs` (framework changes, raise with framework team)

| Priority | Change |
|---|---|
| **High** | Implement DLQ routing when `error.deadLetter` is set (remove the TODO) |
| **High** | Add `ErrorDetail` + `CorrelationId` attributes when routing to DLQ |
| ~~**High**~~ Resolved (v1.1.0-beta.2) | ~~Fix silent ack on JSON parse error — throw or DLQ instead~~ Parse failures now route through `publishToDeadLetter()` with `ErrorDetail: "Invalid JSON: …"` and preserved `MessageAttributes` |
| **Medium** | Add `reject(reason)` / `nack(reason)` method to queue interface |
| **Medium** | Propagate `CorrelationId` message attribute into handler context |

### In `payment-serv` (can be done now, before client-sqs is fixed)

| Priority | Location | Change |
|---|---|---|
| **High** | `src/lib/sqs-subscriptions.ts` `wrapHandler()` | Read `CorrelationId` attribute from message if present, use as correlationId instead of synthetic |
| **High** | All handlers with unrecognised routing keys | Replace silent `return` / log with manual DLQ publish + `ErrorDetail` attribute |
| **High** | `src/lib/sqs-subscriptions.ts` or new `src/lib/sqs-dead-letter.ts` | Add `rejectToDeadLetter()` helper |
| **Medium** | All `sqs.publish()` callsites | Pass current `CorrelationId` as message attribute so consumers can trace back |
| **Low** | `src/lib/sqs-subscriptions.ts` | Add `readers` option to high-volume queues (dwolla webhooks) to match v21 config |

---

## Affected Handlers in payment-serv

Handlers with silent-discard patterns that should route to DLQ instead:

| Handler | File | Silent discard location |
|---|---|---|
| `handleJobEvent` | `sqs-subscriptions.ts` | `default:` case for unknown `JobId` |
| `drivesPermissionChanged` | `queueHandlers/drivesPermissions.ts` | Unknown `Event_Type` |
| `dwollaNotification` | `queueHandlers/dwolla/index.ts` | Unknown event type routing |
| `recordStripeActivity` | `queueHandlers/stripeWebhook.ts` | Unknown event type |
| Any handler that returns early on missing data | Various | Early `return` without DLQ |

# Gap: Parse-Failure Messages Bypass `config.deadLetter` Routing (v1.1.0-beta.1)

> **Status: RESOLVED in v1.1.0-beta.2.** Parse failures now route through the same
> `publishToDeadLetter()` helper as handler-thrown `deadLetter` errors. DLQ messages
> carry `ErrorDetail: "Invalid JSON: <reason>"` and preserve the original
> `MessageAttributes` (including `CorrelationId`). Source message is ACKed on successful
> DLQ publish; on DLQ publish failure, the source stays visible. When `config.deadLetter`
> is unset, behaviour is unchanged from beta.1 (rethrow so sqs-consumer leaves the
> message visible and any AWS-native `RedrivePolicy` takes over).
>
> See `src/queue.ts` (`publishToDeadLetter` helper + parse-failure branch) and
> `__tests__/index.spec.ts` (suite: *Parse failure DLQ routing*).

## Summary

`client-sqs` v1.1.0-beta.1 closes the v23 silent-ack regression (Gap 5 in
`CLIENT_SQS_GAP_ANALYSIS.md`): a message with an unparseable JSON body is no longer auto-acked
and discarded — the parser throws, `sqs-consumer` leaves the message on the queue, and after
`ReceiveCount` exhaustion AWS-native `RedrivePolicy` routes it to the configured DLQ.

However, that AWS-native redrive path **does NOT attach the `ErrorDetail` attribute** the
library otherwise guarantees. Only messages rejected through the explicit `reject(reason)` /
`err.deadLetter = true` code path get `ErrorDetail`. Parse-failure DLQ messages therefore land
without the context an operator needs to triage them.

This document proposes routing parse failures through the same `config.deadLetter` publish path
the library already uses for handler-thrown `deadLetter` errors, so every DLQ message gets
`ErrorDetail` regardless of where the failure originated.

---

## Behaviour today

`src/queue.ts` (createConsumer → handleMessage):

```ts
async handleMessage(message) {
  let parsed: T;
  try {
    parsed = JSON.parse(message.Body!) as T;
  } catch (e) {
    context.logger.error(e, 'Invalid JSON in SQS message');
    throw e;                                    // ← exits here, skips the DLQ branch below
  }
  try {
    await handler(context, parsed, message);
    return message;
  } catch (error) {
    const err = error as any;
    if (err.deadLetter) {                       // ← only reached by handler throws
      // ... publishes to config.deadLetter with ErrorDetail + CorrelationId ...
    }
    throw err;
  }
}
```

The parse-error throw at line 61 escapes before the `err.deadLetter` branch ever runs. The
`SyntaxError` has no `deadLetter` property, so even if the throw were caught by the outer
`try/catch`, it would fall through to the plain rethrow at line 103, not the DLQ publish.

---

## Verified end-to-end against LocalStack (payment-serv, 2026-05-04)

**Setup:** payment-serv on v23 + client-sqs v1.1.0-beta.1, LocalStack, one main queue
(`payment_dwolla_webhooks`) + one DLQ (`payment_dwolla_webhooks_unprocessable`), main queue
config has `deadLetter: "payment_dwolla_webhooks_unprocessable"`.

### Scenario A — handler-thrown `reject()` (Gap 4 path, works as designed)

1. Unknown-topic message published to main queue.
2. `dwollaNotification` handler calls `queue.reject('Unhandled Dwolla event: ...')`.
3. Library catches the `deadLetter` error, publishes to configured DLQ with full attrs.

DLQ message:

```json
{
  "Body": "{\"topic\":\"totally_unknown_gap4\",...}",
  "MessageAttributes": {
    "CorrelationId": { "StringValue": "gap4-manual-1777934661", "DataType": "String" },
    "ErrorDetail":   { "StringValue": "Unhandled Dwolla event: totally_unknown_gap4",
                       "DataType": "String" }
  },
  "Attributes": { "ApproximateReceiveCount": "1" }  // single explicit publish, no redrive
}
```

✅ `ErrorDetail` present. ✅ `CorrelationId` preserved. ✅ `ReceiveCount=1`.

### Scenario B — malformed JSON (parse failure path, the gap)

Same setup plus a native `RedrivePolicy` on the main queue (DLQ ARN, `maxReceiveCount=2`,
`VisibilityTimeout=5`) so AWS eventually moves the poison message off the main queue.

1. Non-JSON body (`not-json-at-all-}{broken`) published to main queue.
2. Library logs `Invalid JSON in SQS message` and throws the `SyntaxError`.
3. `sqs-consumer` does not ack; message stays visible.
4. After two failed receives AWS-native redrive moves the message to the DLQ.

DLQ message:

```json
{
  "Body": "not-json-at-all-}{broken",
  "Attributes": {
    "ApproximateReceiveCount": "3",
    "DeadLetterQueueSourceArn": "arn:aws:sqs:us-east-1:000000000000:payment_dwolla_webhooks"
    // ↑ AWS-native redrive, not a client-sqs-originated publish
  }
  // No MessageAttributes at all — producer didn't set any, and AWS redrive doesn't add
}
```

✅ Message is not silently discarded. ❌ **No `ErrorDetail`.** ❌ No `CorrelationId` (producer
hadn't set one; library can't recover it after AWS redrive). The only attributes are the
system-level `DeadLetterQueueSourceArn` and receive counters.

---

## Why this matters

1. **Operator triage relies on `ErrorDetail`.** On a mixed DLQ where Scenario A and Scenario B
   messages coexist, Scenario B messages are indistinguishable from "someone published to the
   wrong queue." The body alone doesn't say `parse failure`.
2. **`README.md` and `CLAUDE.md` advertise `ErrorDetail` as always present on DLQ'd messages.**
   That invariant is broken for parse failures.
3. **Native `RedrivePolicy` is optional in the deployment.** Services that rely solely on
   `config.deadLetter` (expecting the library to be the DLQ router) will loop a poison message
   forever with no redrive, because parse failures bypass the library's DLQ publish path.
4. **CorrelationId loss is worse than `ErrorDetail` loss.** If the publisher did set a
   `CorrelationId` on the original message, the library had it in hand when parsing failed —
   but the AWS redrive drops the enriched copy the library would have published.

---

## Proposed fix

Treat a parse failure the same way as `err.deadLetter = true`: publish the raw body (and
original `MessageAttributes`) to `config.deadLetter` with an `ErrorDetail` derived from the
`SyntaxError`, then ack the source message. Only fall back to the current "throw and let AWS
redrive handle it" behaviour when `config.deadLetter` is unset.

### Patch sketch (`src/queue.ts`)

```ts
async handleMessage(message) {
  let parsed: T;
  try {
    parsed = JSON.parse(message.Body!) as T;
  } catch (e) {
    context.logger.error(e, 'Invalid JSON in SQS message');
    const dlqName = config.deadLetter;
    if (!dlqName) {
      // Preserve current behaviour: no DLQ configured → rethrow so sqs-consumer
      // leaves the message visible and AWS-native redrive (if any) takes over.
      throw e;
    }
    try {
      const dlqUrl = `${qurl}${qurl.endsWith('/') ? '' : '/'}${ep.accountId}/${dlqName}`;
      await ep.sqs.send(new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body!,
        MessageAttributes: {
          ...message.MessageAttributes,
          ErrorDetail: {
            DataType: 'String',
            StringValue: `Invalid JSON: ${String((e as Error).message ?? e)}`,
          },
        },
      }));
      return message;                           // ack source
    } catch (sqsError) {
      context.logger.error(sqsError, 'Failed to publish parse-failure to configured DLQ');
      throw sqsError;                           // keep message visible on publish failure
    }
  }
  // ...existing handler try/catch unchanged...
}
```

### Why factor the DLQ publish into a helper

The proposed patch duplicates the body that already exists in the `err.deadLetter` branch.
Extract once:

```ts
async function publishToDeadLetter(
  reason: string,
  message: Message,
  dlqName: string,
): Promise<void> {
  const dlqUrl = `${qurl}${qurl.endsWith('/') ? '' : '/'}${ep.accountId}/${dlqName}`;
  await ep.sqs.send(new SendMessageCommand({
    QueueUrl: dlqUrl,
    MessageBody: message.Body!,
    MessageAttributes: {
      ...message.MessageAttributes,
      ErrorDetail: { DataType: 'String', StringValue: reason },
    },
  }));
}
```

Then both branches call `publishToDeadLetter(...)` and the invariant `every DLQ message has
ErrorDetail` is encoded in one place.

---

## Edge cases to cover in the fix PR

1. **Missing `config.deadLetter`.** Keep the current rethrow behaviour — no implicit DLQ.
2. **DLQ publish itself fails.** Must rethrow so sqs-consumer leaves the source message
   visible. Do not ack a message we failed to archive.
3. **Handler-thrown error with `deadLetter = <custom queue name>`.** Existing support for
   `err.deadLetter === 'some_other_dlq'` (string override) should continue to work — parse
   failures would only use the queue's configured `deadLetter`, since there is no handler
   author to override it.
4. **Null body / `undefined` body.** `JSON.parse(undefined!)` throws; the new branch handles
   it. Confirm `MessageBody: message.Body!` accepts the original raw value without double-
   stringification.
5. **Scenario B but `CorrelationId` was set by the publisher.** The library has the attributes
   map at parse time; the proposed spread preserves it, so `CorrelationId` makes it to the
   DLQ (unlike the AWS-redrive path, which drops it).
6. **`receive()` method parallels.** `receive()` at line 136 already logs + returns
   `message: undefined` for parse failures. That is an explicit opt-out contract (caller
   gets the raw `original`). Leave `receive()` alone — the gap is specific to
   `createConsumer`'s managed-loop behaviour.

---

## Tests to add

All under `__tests__/`, using the `ElasticMQ` integration harness already present in the repo
(or jest + mocked `@aws-sdk/client-sqs` if unit-level). Do NOT reintroduce LocalStack.

1. **Parse failure with `config.deadLetter` set →** DLQ receives message with `ErrorDetail`
   matching `Invalid JSON: Unexpected token ...` and original `MessageAttributes` preserved.
2. **Parse failure with no `config.deadLetter` →** source message stays visible (ack skipped),
   parity with current beta.1 behaviour.
3. **Parse failure when DLQ `SendMessage` itself fails →** source message stays visible,
   error logged as `Failed to publish parse-failure to configured DLQ`.
4. **CorrelationId on unparseable message is preserved in DLQ `MessageAttributes`.**
5. **Existing handler-thrown `deadLetter` tests stay green** — the refactor into
   `publishToDeadLetter()` must not regress Scenario A. Include an explicit test asserting
   `ErrorDetail === 'Unhandled ...'` from a handler `reject()` to lock in the contract.

---

## Rollout

1. Cut `v1.1.0-beta.2` with the fix.
2. payment-serv picks up the bump; no payment-serv code change required — the missing
   `ErrorDetail` becomes present automatically on parse failures routed via `config.deadLetter`.
3. Deployment gate: confirm all SQS DLQ dashboards / alerts that filter on
   `MessageAttributes.ErrorDetail` now match parse-failure messages too (previously they
   didn't see them at all).
4. Promote to `1.1.0` once beta soak passes.

---

## Background references

- `docs/CLIENT_SQS_GAP_ANALYSIS.md` — original v21 vs v23 gap list (Gap 5 is the parse-fail
  silent-ack regression; this document extends it).
- payment-serv commit `23440295` — adds jest-level coverage for Scenario A reject paths, but
  does not exercise Scenario B end-to-end because the jest mock stubs `createConsumer`.
  End-to-end parse-failure behaviour was verified only manually against LocalStack (recorded
  above).
- `src/queue.ts` lines 55–104 — the `handleMessage` closure where both branches converge.
- `CLAUDE.md` § *Dead Letter Routing* — advertises
  "publish the raw message body to the DLQ with `ErrorDetail` + original `MessageAttributes`"
  as the contract. Today that holds only for Scenario A.

# __tests__ — Mock internals

Non-obvious bits of the test setup. Everything else (what's covered, run command,
ElasticMQ-in-CI) lives in `CLAUDE.md` and the spec file itself.

## Manual mock of `@aws-sdk/client-sqs`

`jest.mock('@aws-sdk/client-sqs')` at the top of the spec activates the file at
`__mocks__/@aws-sdk/client-sqs.ts`. The mock exposes three helpers re-exported
alongside the real types:

| Helper | Purpose |
|--------|---------|
| `mockSend` | The `jest.fn()` backing every `SQSClient.send()` call — assert on `.mock.calls[].input` |
| `mockSqsSend(fn)` | Swap the underlying send implementation (e.g. inject a rejection for DLQ-publish-fail tests) |
| `resetSqsMock()` | Restore default send + clear call history; called from `afterEach` |

## Reaching `handleMessage` without starting a poller

`sqs-consumer` does not expose `handleMessage` as a public field; the property
name has drifted across versions. Tests use:

```ts
function getInternalHandle(consumer: any) {
  return consumer._sqsOptions?.handleMessage
      ?? consumer.sqsOptions?.handleMessage
      ?? consumer.options?.handleMessage;
}
```

This lets a test invoke the closure directly with a synthetic `Message` instead
of running the polling loop. If a future `sqs-consumer` upgrade renames the
field again, `getInternalHandle` is the single place to fix.

Each test calls `consumer.stop()` after invoking the handle so the internal
poller-promise machinery releases.

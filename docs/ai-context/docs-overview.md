# Documentation Overview — @gasbuddy/client-sqs

## Navigation

| Tier | File | Purpose |
|------|------|---------|
| 1 | [CLAUDE.md](../../CLAUDE.md) | Architecture, quick start, key files |
| 1 | [project-structure.md](project-structure.md) | Tech stack, file tree, design patterns |
| 1 | [docs-overview.md](docs-overview.md) | This file — documentation map |
| 2 | [src/CONTEXT.md](../../src/CONTEXT.md) | Source module details |
| 2 | [__tests__/CONTEXT.md](../../__tests__/CONTEXT.md) | Test patterns and setup |

---

## Tier Mapping

### Tier 1 — Entry Points (root + docs/ai-context/)
High-level architecture, quick start, and project orientation. Read these first.

### Tier 2 — Component Context (src/, __tests__/)
Module-level detail: what each file does, how pieces fit together, patterns to follow.

### Tier 3 — Feature Context
Not applicable — this is a small, single-purpose library without deep feature subdirectories.

---

## Key Concepts

- **`createSQSClient`** — single async factory, returns typed queue client
- **`SQSEnhancedQueue`** — per-queue interface: publish / createConsumer / receive / ack
- **Endpoints** — named SQS connections; `default` is used when no endpoint specified per queue
- **Auto-config** — region + accountId resolved from EC2 metadata if not provided
- **Role guard** — `requiredRole` triggers STS identity check at startup

---

## External References

- [AWS SQS SDK v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/)
- [sqs-consumer](https://github.com/bbc/sqs-consumer)
- [npm: @gasbuddy/client-sqs](https://www.npmjs.com/package/@gasbuddy/client-sqs)

# Project Structure — @gasbuddy/client-sqs

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 4.9 |
| Runtime | Node.js >18 |
| AWS SDK | `@aws-sdk/client-sqs` v3, `@aws-sdk/client-sts` v3 |
| Consumer | `sqs-consumer` v6 |
| Logger interface | `pino` (BaseLogger) |
| Test runner | Jest 29 + ts-jest |
| Linter | ESLint + eslint-config-gasbuddy |
| Formatter | Prettier |
| Package manager | Yarn 3 (PnP disabled) |
| Build | `tsc` → `build/` |

---

## File Tree

```
client-sqs/
├── src/
│   ├── index.ts            # createSQSClient factory (public entry point)
│   ├── queue.ts            # SQSEnhancedQueue: publish/createConsumer/receive/ack/reject
│   ├── endpoints.ts        # buildEndpoints: EC2 metadata + STS role verification
│   ├── roles.ts            # assumeRole helper (STS identity check)
│   └── types/
│       ├── index.ts        # Public types exported by the package
│       └── internal.ts     # RawSqsEndpoint (internal only)
├── __tests__/
│   ├── index.spec.ts       # Integration test (localstack required)
│   └── gap-fixes.spec.ts   # Unit tests for DLQ routing/CorrelationId/reject (no localstack)
├── build/                  # Compiled output (gitignored)
├── docs/
│   └── ai-context/         # AI documentation (project-structure, docs-overview)
├── .github/
│   └── workflows/          # CI: nodejs.yml, npmpublish.yml
├── README.md               # Full usage examples
├── package.json            # @gasbuddy/client-sqs v1.0.1
├── tsconfig.json           # Full tsconfig (with strict mode)
├── tsconfig.build.json     # Build-only tsconfig (excludes tests)
└── CLAUDE.md               # AI entry point
```

---

## Key Design Patterns

- **Configuration-driven**: Queues and endpoints declared as typed config objects; no imperative wiring
- **Auto-detection**: Missing `accountId`/`region` fetched from EC2 instance metadata (`169.254.169.254`)
- **Role verification**: `requiredRole` in endpoint config triggers STS `GetCallerIdentity` check at startup
- **JSON-first**: `publish` serializes to JSON; `createConsumer` auto-parses; parse failure rethrows (no silent ack)
- **Dead-letter routing**: throw `error.deadLetter = true` or call `queue.reject(reason)` to route to configured DLQ
- **CorrelationId**: consumers always request `CorrelationId` + `ErrorDetail` attrs; publishers pass them via `MessageAttributes`
- **Generic types**: Queue names (`Q extends string`) and endpoints (`Endpoints extends 'default'`) are type-safe via generics

---

## Published Package

- **npm**: `@gasbuddy/client-sqs`
- **Main**: `build/index.js`
- **Types**: `build/index.d.ts`
- **Peer assumption**: consumers bring their own `pino`-compatible logger

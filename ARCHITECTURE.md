# Architecture decisions

## 1. Scope and quality goals

This service processes wager transactions from HTTP providers and SQS. Its primary
guarantees are exact monetary arithmetic, persistent idempotency, an auditable
ledger, safe concurrent updates, and recoverable event publication.

The database is the source of truth. SQS FIFO ordering and deduplication are
useful optimizations, but correctness does not depend on them.

## 2. Stack and boundaries

- **Runtime and package manager:** Bun 1.x.
- **Language and framework:** strict TypeScript and NestJS.
- **Persistence:** PostgreSQL 16 with MikroORM 7 for connection management,
  migrations, and transaction boundaries. Repositories use explicit SQL for
  locking, conditional writes, and PostgreSQL-specific constraints.
- **Messaging:** AWS SQS FIFO; LocalStack supplies SQS locally.
- **Local orchestration:** Docker Compose.

The code is divided into:

- `src/domain`: `Money`, wallet and wager aggregates, ledger entries, inbox and
  outbox models, event types, and business rules.
- `src/application`: use cases and ports, including the shared HTTP/SQS
  transaction submission flow.
- `src/infrastructure`: PostgreSQL repositories and migrations, SQS adapters,
  workers, health probes, logging, and metrics.
- `src/interface/http`: NestJS controllers, DTO validation, correlation IDs,
  authentication extension point, and consistent error mapping.

The MikroORM `EntityManager.transactional()` boundary creates one SQL transaction
for each unit of work. All repositories participating in that operation share
the same transaction-bound entity manager.

## 3. Money and domain model

`Money` stores integer cents as `bigint`. It never uses floating-point numbers
for monetary arithmetic and has no dependency on NestJS or ORM types.

External monetary values use `{ "amount": "25.00", "currency": "BRL" }`.
Factories reject malformed, negative, scientific-notation, or over-precision
input. Serialization always returns a decimal string with two fractional
digits. The domain supports three-letter currency codes and rejects operations
between different currencies; the sample setup and challenge flows use BRL.
PostgreSQL persists amounts as `numeric(19,2)`.

Aggregates use private constructors and factories. `rehydrate` reconstructs
persisted state without replaying business transitions. Ledger entries are
immutable values; their factories verify that the before/after balances match
the direction and amount.

### Transaction states

- A new external operation starts as `PENDING`.
- If its referenced operation is not ready, it becomes `PENDING_REFERENCE`.
- `PROCESSED`, `REJECTED`, and `FAILED` are terminal.
- A rule violation is recorded as `REJECTED`, with a stable `failureCode` and a
  corresponding outbox event. Infrastructure errors abort the SQL transaction
  and are retried or returned as transient failures.
- `OPENING` is reserved for the internal system provider. Creating a wallet
  with a positive initial balance records its opening transaction and credit
  ledger entry in the same SQL transaction.

`BET` debits, `WIN` credits, and `LOSS` records an outcome without moving the
balance. `REFUND` credits a previously processed `BET`. `ROLLBACK` reverses a
processed `BET`, `WIN`, or `REFUND`. A reversal must match the referenced
transaction's amount and belong to the same provider, player, wallet, currency,
and round. A reference can be reversed only once by a successfully processed
`REFUND` or `ROLLBACK`. An overdrawn bet and an overdrawn reversal use distinct
failure codes.

## 4. Database invariants and concurrency

The initial, reversible migration encodes important invariants in PostgreSQL,
not only in application code:

- A unique constraint allows at most one wallet per `(player_id, currency)`.
- Wallet balances and ledger amounts are non-negative/positive as applicable;
  transaction kinds, statuses, currency format, required references, and
  terminal failure codes are constrained.
- Unique constraints enforce both `idempotency_key` and
  `(provider_id, external_transaction_id)`.
- A partial unique index permits at most one successfully processed reversal
  for a referenced transaction.
- A unique `(wallet_id, transaction_id)` index prevents duplicate ledger
  entries for the same wallet and transaction. A check constraint validates
  each entry's balance arithmetic.
- A database trigger rejects ledger `UPDATE` and `DELETE`.
- A deferred constraint trigger checks at commit that the wallet's materialized
  balance equals the last ledger balance (or zero when there is no entry).
- A unique inbox key on `(consumer_name, message_id)` makes SQS redelivery
  deduplication persistent.

The unit of concurrency is the wallet row. Financial processing locks it with
`SELECT ... FOR NO KEY UPDATE`; different wallets can proceed independently.
The write also checks the wallet version in its `UPDATE`, then increments the
version only when the balance changes. PostgreSQL uniqueness constraints remain
the final protection against races on idempotency and reversal records.

The unit of work retries the entire transaction up to three times for PostgreSQL
serialization failures, deadlocks, and lock-not-available (`40001`, `40P01`,
`55P03`), using short exponential delay plus jitter. Other recognized
infrastructure failures are translated to retryable application errors; domain
errors are not retried as infrastructure failures.

Pending-reference and outbox workers claim rows with `FOR UPDATE SKIP LOCKED`,
so multiple worker instances can share work without a global lock. The
pending-reference worker handles one transaction per SQL unit of work and
locks only that transaction and its wallet.

## 5. Idempotency and payload identity

The required `Idempotency-Key` header is persisted as the source of truth. The
database also enforces uniqueness of `(providerId, externalTransactionId)`.
Together, these keys protect retries even when requests arrive at different
application instances.

The payload fingerprint is SHA-256 over canonical JSON with recursively sorted
object keys and no insignificant whitespace. It covers:

- `providerId` and `externalTransactionId`;
- `playerId`, `walletId`, `roundId`, and `gameId`;
- transaction `kind`;
- normalized `money` (two decimal places and currency); and
- `referenceExternalTransactionId`, when present.

The idempotency header and transport metadata such as SQS `messageId` and
`occurredAt` are excluded. An identical request returns the persisted original
result, including its originally observed balance. Reusing the key with a
different business payload is an idempotency conflict, not a replay.

## 6. Transaction processing and references

HTTP and SQS call the same `SubmitWagerTransaction` use case. Within one SQL
transaction it:

1. Records an inbox message when the source is SQS.
2. Checks for an existing idempotent result.
3. Locks the wallet and repeats the idempotency check to cover races.
4. Inserts the transaction, applies the domain rules, and writes the ledger and
   materialized balance when required.
5. Writes integration events to the outbox.
6. Marks the inbox message processed for SQS input.

A failure before commit rolls these writes back together. The consumer deletes
the SQS message only after the use case commits successfully.

Missing or not-yet-processed references remain `PENDING_REFERENCE`. The worker
uses exponential backoff with a configurable base/cap, a default maximum of 10
attempts, and a default TTL of 10 minutes. A reference arriving later wakes its
pending dependents for prompt processing. Once the attempt limit or TTL is
reached, the operation is rejected with `REFERENCE_NOT_FOUND` and a rejection
event.

<a id="authentication"></a>

## 7. HTTP API and authentication

The HTTP API exposes wallet creation and lookup, ledger pagination,
reconciliation, transaction submission and lookup, health probes, and Prometheus
metrics. `GET /` is not a user interface route; it returns a normal `Cannot GET
/` response. The service is an API and can be exercised with Postman or HTTP
clients. OpenAPI/Swagger is not currently configured and is not required by the
challenge.

The exception filter maps failures consistently: invalid input to `400`,
missing resources to `404`, idempotency and wallet conflicts to `409`, business
rejections to `422`, and transient infrastructure failures to `503` with
`Retry-After`. Health endpoints remain unauthenticated.

Authentication is intentionally not implemented because the challenge
explicitly makes it optional and awards no points for it. `AuthGuard` and
`ProviderIdentityPort` are explicit extension points; the current provider is
no-op and accepts requests without authenticating them. For a production
deployment, integrate an external OIDC identity provider such as Keycloak or
Zitadel, validate JWT signatures and claims against its JWKS, and verify that
the authenticated provider identity matches the request's `providerId`. Do not
store locally managed password credentials for this challenge.

The SQS queue is treated as an internal trusted channel, as allowed by the
challenge, but its transaction data still passes domain validation.

## 8. SQS, inbox, and shutdown

The consumer reads `wager-transactions.fifo`, processes different message groups
in parallel, and preserves order within a group. `walletId` is the recommended
`MessageGroupId`. Database locking and persistent idempotency remain the
correctness guarantees.

The inbox key is `(consumerName, messageId)`. Inbox receipt, financial writes,
ledger, and outbox changes share the same database transaction. Message
classification is:

- persisted business outcomes: acknowledge;
- malformed/permanently invalid messages: send to the DLQ;
- transient infrastructure errors: retry with exponential visibility delay,
  then send to the DLQ after the configured receive limit (default 5).

The consumer sends a failed message to the DLQ before deleting it from the
source queue. This avoids losing the source message if the DLQ is unavailable.
On shutdown, polling stops, in-flight work is given a grace period, and received
messages that have not started are returned to visibility.

## 9. Transactional outbox and events

Financial state and outbox rows commit atomically. The publisher claims due
rows using `FOR UPDATE SKIP LOCKED`, publishes batches to
`wager-events.fifo`, then records success or schedules exponential retry. Its
default poll interval is 500 ms and default batch size is 50.

Delivery is at-least-once: if SQS accepts an event but the publisher crashes
before its database transaction commits, another publisher can send that event
again. The stable `eventId` is used as the FIFO deduplication ID, but broker
deduplication is only an optimization; downstream consumers must be idempotent
using the event ID. Outbox rows are retained after publication for traceability.

Versioned event types are:

- `WagerTransactionProcessed` for every applied transaction, including `LOSS`;
- `WagerTransactionRejected` for business rejections;
- `WalletBalanceChanged` only when the wallet balance changes; and
- `WagerTransactionPendingReference` when a reference is not ready.

Event envelopes carry `eventId`, `eventType`, `aggregateId`, `correlationId`,
optional `causationId`, ISO-8601 `occurredAt`, version, and event data. Money in
event data is serialized as decimal strings. `MessageGroupId` is the aggregate
ID; FIFO ordering is an optimization, not a substitute for database guarantees.

## 10. Observability and reconciliation

Pino emits structured JSON logs. Logs include relevant identifiers and
processing outcomes; the logger redacts payload, money, balance, and
authorization fields as defense in depth. Correlation IDs are accepted from
`X-Correlation-Id` (up to 128 characters) or generated by the service.

Prometheus metrics include transaction statuses, idempotent duplicates and
conflicts, retries, DLQ messages, lock conflicts, reconciliation divergences,
outbox publication/failures/lag/backlog, pending references, SQS outcomes, and
processing latency. `/health/live` reports process liveness.
`/health/ready` checks PostgreSQL and SQS with short timeouts.

Reconciliation compares the stored wallet balance with the ledger sum using
one SQL statement/snapshot. A mismatch is returned, logged, and counted; it is
never silently repaired.

## 11. Tests and validation

With PostgreSQL and LocalStack running, use:

```bash
bun run typecheck
bun run test
bun run test:integration
bun run test:concurrency
```

The unit suite covers exact money behavior, wallet invariants, wager
transitions, reference rules, ledger balance, and payload hashing. Integration
tests use real PostgreSQL and LocalStack to exercise migrations and constraints,
HTTP contracts, atomicity, inbox/redelivery, outbox publishing, retries, and
DLQ behavior. Concurrency tests exercise parallel duplicate submissions,
competing bets, hot and distinct wallets, multiple processes, concurrent
publishers, out-of-order references, process death, and restart recovery.

The last recorded validation for this repository passed TypeScript typecheck
and 116 tests: 48 unit, 57 integration, and 11 concurrency tests. Re-run the
commands above against the current environment before relying on that result.

<a id="load-test"></a>

## 12. Load-test results

`bun run test:load` starts three local application instances by default and
runs a closed-loop HTTP workload. It reports throughput, p50/p95/p99/max
latency, HTTP status/error rate, lock conflicts, outbox lag/drain time, and
wallet/ledger reconciliation. These are measurements from one development
machine, not service-level objectives or production capacity guarantees.

The checked local result files were produced with Bun 1.4.4, PostgreSQL 16 and
LocalStack in Docker on Windows 10 (build 26100), an Intel Core i7-3770, 8
logical cores, and 16 GiB RAM. Each run lasted 25 seconds at concurrency 48,
with 100 wallets, a 5% duplicate rate, and an 80% BET / 10% WIN / 10% LOSS mix:

| Workload | Requests | Throughput | p50 | p95 | p99 | Errors | Peak outbox lag | Drain | Inconsistent wallets |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| No hot wallet (0% hot share) | 3,537 | 140.3 req/s | 282.6 ms | 714.1 ms | 992.5 ms | 0% | 7.42 s | 7.1 s | 0 |
| Hot wallet (20% hot share) | 3,311 | 128.2 req/s | 62.8 ms | 2,634.1 ms | 5,485.8 ms | 0% | 5.434 s | 2.2 s | 0 |

The hot-wallet run shows the expected tail-latency cost of contention. Results
depend on hardware, Docker resources, database state, and workload; rerun the
test on the target environment before drawing capacity conclusions. Load
results are generated artifacts and are excluded from Git by `.gitignore`.

## 13. Trade-offs and limitations

- Authentication is intentionally a no-op until an external OIDC provider is
  integrated.
- Local development uses LocalStack and test AWS credentials; production AWS
  credentials, queue policies, alarms, retention, and operational procedures
  must be configured for the deployment environment.
- SQS and outbox delivery are at-least-once, so event consumers must deduplicate.
- The challenge's primary examples assume BRL, though the domain models
  currencies and rejects currency mismatches.
- The load-test measurements above are local observations, not performance
  guarantees.
- Swagger/OpenAPI, OpenTelemetry, dashboards, and double-entry bookkeeping are
  not implemented; they are not required for the challenge.

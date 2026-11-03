# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`)
vindas de múltiplos provedores, por **HTTP** e por **SQS**, com idempotência persistente, ledger imutável,
transactional outbox e correção sob concorrência entre múltiplas instâncias.

Stack: Bun 1.x · TypeScript estrito · NestJS · MikroORM 7 · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose.

> As decisões de arquitetura, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

## Setup rápido

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
bun install
docker compose up -d postgres localstack     # PostgreSQL (porta 5432) e LocalStack/SQS (porta 4566)
bun run migration:up                          # aplica as migrations
bun run start                                 # sobe a API na porta 3000 (todos os papéis)
```

Depois de iniciar, acesse a documentação interativa do Swagger em
[`http://localhost:3000/docs`](http://localhost:3000/docs). A especificação OpenAPI em JSON fica disponível em
[`http://localhost:3000/docs-json`](http://localhost:3000/docs-json).

O PostgreSQL fica disponível na porta padrão **5432**; o LocalStack/SQS usa a porta **4566**.
Se a porta padrão já estiver ocupada, altere `POSTGRES_PORT` **e** a porta do `DATABASE_URL` no `.env`.
Por exemplo, use `POSTGRES_PORT=5433` e configure `DATABASE_URL` com `localhost:5433`.

Subindo **várias réplicas** em containers:

```bash
docker compose --profile app up --build --scale app=3   # réplicas em 3000-3010 (migrations rodam uma vez, no serviço "migrate")
```

Ou várias instâncias locais (processos separados):

```bash
PORT=3001 bun run start & PORT=3002 bun run start & PORT=3003 bun run start &
```

### Papéis (`ROLE`)

Cada instância expõe HTTP, health e métricas. `ROLE` escolhe os processos em segundo plano:

| `ROLE` | Efeito |
|---|---|
| `all` (padrão) | consumidor SQS + publisher da outbox + worker de referências pendentes |
| `consumer` | só o consumidor SQS |
| `workers` | publisher da outbox + worker de `PENDING_REFERENCE` |
| `http` | só a API |

Valores podem ser combinados: `ROLE=consumer,workers`.

### Variáveis de ambiente

Ver [.env.example](.env.example). As principais: `DATABASE_URL`, `AWS_ENDPOINT`, `SQS_QUEUE_URL`, `SQS_DLQ_URL`,
`EVENTS_QUEUE_URL`, `SQS_MAX_RECEIVE_COUNT` (5), `PENDING_REF_MAX_ATTEMPTS` (10), `PENDING_REF_TTL_MS` (10 min),
`OUTBOX_BATCH_SIZE`, `OUTBOX_INTERVAL_MS`, `DB_POOL_MAX` (20), `LOG_LEVEL`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run typecheck` | `tsc --noEmit` (TypeScript estrito) |
| `bun run test` | testes de **unidade** (domínio, sem I/O) |
| `bun run test:integration` | integração com **PostgreSQL e LocalStack reais** (schema, atomicidade, inbox, outbox, SQS, HTTP) |
| `bun run test:concurrency` | concorrência com paralelismo real, **múltiplos processos** e reinício com kill -9 |
| `bun run migration:up` / `migration:down` | aplica / reverte migrations |
| `bun run demo` | cria uma wallet de demonstração, envia/reenvia uma aposta e confere transação, ledger e reconciliação |
| `bun run test:load` | teste de carga (sobe 3 instâncias, ver [ARCHITECTURE.md](ARCHITECTURE.md#load-test)) |

Os testes de integração e de concorrência precisam de `docker compose up -d postgres localstack`.
Eles compartilham o mesmo banco (cada teste cria wallets novas) e rodam **em série**.
O workflow do GitHub Actions executa typecheck, testes unitários, integração e concorrência em cada push e pull request.

## Demonstração rápida

Com os serviços, migrations e API em execução, em outro terminal rode:

```powershell
bun run demo
```

O script cria dados únicos em cada execução. Ele cria uma wallet, processa uma aposta de `25.00 BRL`,
envia a mesma operação novamente para demonstrar o replay idempotente, consulta a transação e o ledger
e verifica que o saldo coincide com a reconciliação. Para outra instância da API, configure
`$env:DEMO_API_URL = "http://localhost:3001"` antes de executar.

## Bruno

Importe a pasta [`bruno/`](bruno/) no [Bruno](https://www.usebruno.com/), escolha o ambiente `local` e
execute as requisições na ordem indicada pela numeração. A resposta de criação da wallet salva
automaticamente `walletId` e `playerId`; a submissão salva os identificadores da transação para as consultas.
O Swagger em `/docs` também continua disponível como alternativa interativa no navegador.

## API

Todos os endpoints HTTP — incluindo health checks e métricas — estão documentados e podem ser testados no
[Swagger UI](http://localhost:3000/docs) enquanto a aplicação estiver em execução.

```http
POST /wallets                                         # 201 | 409 wallet duplicada (playerId + currency)
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=...&limit=50    # cursor opaco e estável (keyset por sequência do ledger)
POST /wallets/:walletId/reconciliation                # compara saldo armazenado x ledger; NUNCA corrige
POST /wagering/transactions                           # header Idempotency-Key obrigatório
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
GET  /health/live      GET /health/ready              # abertos; ready checa PostgreSQL e SQS
GET  /metrics                                         # Prometheus
```

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"p-1","walletId":"<id>",
       "roundId":"r1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

### Status HTTP (consistente em todos os endpoints)

| Situação | HTTP | Provedor deve… |
|---|---|---|
| Processada / replay idempotente | `200` | nada |
| Wallet criada | `201` | nada |
| Aceita, processamento pendente (`PENDING_REFERENCE`) | `202` | aguardar; não reenviar |
| Payload inválido (forma, `Money`, `kind`, UUID, cursor, header ausente) | `400` | corrigir e reenviar |
| Wallet/transação inexistente | `404` | corrigir |
| Conflito: mesma key com payload diferente; wallet duplicada | `409` | não reenviar igual |
| Rejeição por regra de negócio (`failureCode` no corpo) | `422` | decidir pelo `failureCode` |
| Falha transitória de infraestrutura (`Retry-After`) | `503` | reenviar a **mesma** requisição (seguro) |

Todo erro tem o formato `{ "error": { "code", "message", "retryable" }, "correlationId" }`.

### Entrada por fila

Filas FIFO `wager-transactions.fifo` (+ `wager-transactions-dlq.fifo`) com o envelope `WagerTransactionRequested`
descrito no desafio; `MessageGroupId` recomendado = `walletId`. Os eventos de integração saem na fila
`wager-events.fifo`. As filas são criadas pelo script [scripts/localstack/init.sh](scripts/localstack/init.sh).

## Estrutura

```
src/
├─ domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, regras de referência
├─ application/     casos de uso + portas (UnitOfWork, repositórios, EventPublisher…)
├─ infrastructure/  MikroORM (UoW, SQL, migrations), SQS (consumer/publisher), métricas, logs, workers
├─ interface/http/  controllers, DTOs, filtro de erros, guard de auth (no-op)
├─ app.module.ts    composição Nest, papéis e shutdown gracioso
└─ main.ts
test/
├─ unit/  integration/  concurrency/  load/  helpers/
```

## Autenticação

Não implementada (decisão aceita pelo desafio, seção 2). O ponto de extensão está explícito:
`AuthGuard` + `ProviderIdentityPort` em [http-support.ts](src/interface/http/http-support.ts) e o desenho
proposto (Keycloak/Zitadel via JWKS) em [ARCHITECTURE.md](ARCHITECTURE.md#authentication).

import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade vivem AQUI,
 * não só no código da aplicação (restrição 9 do desafio).
 */
export class Migration20260101000001_initial_schema extends Migration {
  override name = 'Migration20260101000001_initial_schema';

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   text NOT NULL,
        currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19,2) NOT NULL CONSTRAINT ck_wallet_balance_non_negative CHECK (balance >= 0),
        version     integer NOT NULL CHECK (version >= 1),
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL,
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
      );
    `);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL,
        payload_hash                      text NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets (id),
        player_id                         text NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions (id),
        status                            text NOT NULL,
        failure_code                      text,
        observed_balance                  numeric(19,2),
        pending_attempts                  integer NOT NULL DEFAULT 0,
        next_attempt_at                   timestamptz,
        created_at                        timestamptz NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT ck_tx_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_tx_amount_positive CHECK (amount > 0),
        -- OPENING é interno: só o provider reservado '__system__' pode produzi-lo.
        CONSTRAINT ck_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = '__system__')),
        CONSTRAINT ck_tx_reference_required CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT ck_tx_failure_code CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT ck_tx_processed_at CHECK (
          status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL
        )
      );
    `);
    // Uma transação só pode ser revertida UMA vez (por REFUND ou ROLLBACK): evita crédito/débito duplo.
    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_reference ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX ix_tx_wallet ON wager_transactions (wallet_id, created_at);`);

    // ----------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(19,2) NOT NULL CHECK (amount > 0),
        currency       char(3) NOT NULL,
        balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),
        created_at     timestamptz NOT NULL,
        -- no máximo um lançamento por wallet e transação
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT'  AND balance_before - amount = balance_after)
        )
      );
    `);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);`);

    // Imutabilidade: nenhum UPDATE/DELETE no ledger, nem por acidente.
    this.addSql(`
      CREATE FUNCTION fn_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable();
    `);

    // Saldo materializado == último lançamento do ledger (verificado no COMMIT).
    this.addSql(`
      CREATE FUNCTION fn_wallet_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE expected numeric(19,2);
      BEGIN
        SELECT balance_after INTO expected FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
        IF COALESCE(expected, 0) <> NEW.balance THEN
          RAISE EXCEPTION 'wallet % balance % diverges from ledger %', NEW.id, NEW.balance, COALESCE(expected, 0)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_balance_matches_ledger
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_balance_matches_ledger();
    `);

    // ------------------------------------------------------------------ inbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  text NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ----------------------------------------------------------------- outbox
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    text NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        last_error      text
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_pending ON outbox_messages (next_attempt_at, occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_balance_matches_ledger ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_wallet_balance_matches_ledger();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS fn_ledger_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}

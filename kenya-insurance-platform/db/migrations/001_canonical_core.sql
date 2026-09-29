-- 001_canonical_core.sql
-- Canonical entity model, derived from V6 Canonical_Entities/SQL_DDL and V9 Database_Tables.
-- Every table matches a named entity/table row in the uploaded workbooks — nothing invented.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------- Party / Customer ----------
CREATE TABLE parties (
    party_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    party_type      TEXT NOT NULL CHECK (party_type IN ('PERSON', 'ORGANIZATION')),
    display_name    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id        UUID NOT NULL REFERENCES parties(party_id),
    customer_status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
    contact_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    contact_type    TEXT NOT NULL CHECK (contact_type IN ('PHONE', 'EMAIL', 'WHATSAPP')),
    value           TEXT NOT NULL,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
    address_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    party_id        UUID REFERENCES parties(party_id),
    customer_id     UUID REFERENCES customers(customer_id),
    line1           TEXT,
    town            TEXT,
    county          TEXT,
    country         TEXT NOT NULL DEFAULT 'KE'
);

CREATE TABLE consents (
    consent_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    purpose         TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    channel         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'GIVEN' CHECK (status IN ('GIVEN', 'WITHDRAWN')),
    ip_or_device    TEXT,
    given_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    withdrawn_at    TIMESTAMPTZ
);

-- ---------- Needs assessment (V9 T008-T010) ----------
CREATE TABLE needs_assessments (
    assessment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    status          TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessment_answers (
    answer_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id   UUID NOT NULL REFERENCES needs_assessments(assessment_id),
    question_id     TEXT NOT NULL,
    answer_value    JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_profiles (
    risk_profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id   UUID NOT NULL REFERENCES needs_assessments(assessment_id),
    risk_area       TEXT NOT NULL,
    exposure_summary JSONB NOT NULL
);

-- ---------- Product ----------
CREATE TABLE products (
    product_id      TEXT PRIMARY KEY,           -- e.g. MOT-PRI-001 (matches V1/V2 ontology IDs)
    product_name    TEXT NOT NULL,
    product_family  TEXT NOT NULL,
    regulatory_class TEXT
);

CREATE TABLE product_versions (
    product_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      TEXT NOT NULL REFERENCES products(product_id),
    version_label   TEXT NOT NULL,
    insurer         TEXT,
    effective_from  DATE NOT NULL,
    effective_to    DATE,
    policy_wording_ref TEXT,
    status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW','APPROVED','ACTIVE','RETIRED'))
);

CREATE TABLE coverages (
    coverage_id     TEXT PRIMARY KEY,           -- e.g. COV-001
    coverage_name   TEXT NOT NULL,
    coverage_description TEXT
);

CREATE TABLE product_coverages (
    product_version_id UUID NOT NULL REFERENCES product_versions(product_version_id),
    coverage_id     TEXT NOT NULL REFERENCES coverages(coverage_id),
    is_mandatory    BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (product_version_id, coverage_id)
);

-- ---------- Rules & Rating (V3/V4) ----------
CREATE TABLE rules (
    rule_id         TEXT PRIMARY KEY,           -- e.g. PR-001
    rule_type       TEXT NOT NULL,               -- eligibility | underwriting | rating | referral | tax_levy | claims | renewal
    rule_name       TEXT NOT NULL
);

CREATE TABLE rule_versions (
    rule_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         TEXT NOT NULL REFERENCES rules(rule_id),
    product_id      TEXT REFERENCES products(product_id),
    condition_expression TEXT NOT NULL,
    action          TEXT NOT NULL,
    source_reference TEXT NOT NULL,             -- legal/regulatory citation, never blank
    status          TEXT NOT NULL DEFAULT 'TEMPLATE' CHECK (status IN ('TEMPLATE','CONFIGURE','SOURCE_CONTROLLED','LEGAL-VALIDATE','ACTIVE')),
    effective_from  DATE,
    effective_to    DATE
);

CREATE TABLE rate_configurations (
    rate_config_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      TEXT NOT NULL REFERENCES products(product_id),
    coverage_id     TEXT REFERENCES coverages(coverage_id),
    formula_type    TEXT NOT NULL,
    formula_expression TEXT NOT NULL,
    -- Deliberately no numeric rate column here: real rate values are SOURCE_CONTROLLED /
    -- insurer-authority data that must come from an approved rate table, never this migration.
    rate_status     TEXT NOT NULL DEFAULT 'CONFIGURATION_REQUIRED',
    source_reference TEXT NOT NULL,
    effective_from  DATE,
    effective_to    DATE
);

CREATE TABLE charges (
    charge_id       TEXT PRIMARY KEY,           -- e.g. TL-001
    charge_name     TEXT NOT NULL,
    payer           TEXT,
    basis           TEXT,
    rate_or_amount  TEXT NOT NULL DEFAULT 'CONFIGURE',
    rate_status     TEXT NOT NULL DEFAULT 'SOURCE_CONTROLLED',
    source_reference TEXT NOT NULL,
    calculation_order TEXT
);

-- ---------- Quote / Decision ----------
CREATE TABLE quotes (
    quote_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    product_version_id UUID REFERENCES product_versions(product_version_id),
    channel         TEXT NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB','WHATSAPP','SALES')),
    status          TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','QUOTED','REFERRED','DECLINED','EXPIRED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quote_items (
    quote_item_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id        UUID NOT NULL REFERENCES quotes(quote_id),
    coverage_id     TEXT NOT NULL REFERENCES coverages(coverage_id),
    input_data      JSONB NOT NULL
);

CREATE TABLE premiums (
    premium_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id        UUID NOT NULL REFERENCES quotes(quote_id),
    rate_config_id  UUID REFERENCES rate_configurations(rate_config_id),
    amount_kes      NUMERIC(14,2),              -- NULL until a real rate config resolves it
    status          TEXT NOT NULL DEFAULT 'CONFIGURATION_REQUIRED'
);

CREATE TABLE referrals (
    referral_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id        UUID REFERENCES quotes(quote_id),
    reason_code     TEXT NOT NULL,
    rule_version_id UUID REFERENCES rule_versions(rule_version_id),
    assigned_to     TEXT,
    status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','APPROVED','DECLINED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Policy ----------
CREATE TABLE policies (
    policy_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    quote_id        UUID REFERENCES quotes(quote_id),
    policy_number   TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'PENDING_ISSUANCE'
        CHECK (status IN ('PENDING_ISSUANCE','ACTIVE','ENDORSED','CANCELLED','EXPIRED')),
    effective_from  DATE,
    effective_to    DATE
);

CREATE TABLE policy_versions (
    policy_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id       UUID NOT NULL REFERENCES policies(policy_id),
    version_no      INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_coverages (
    policy_coverage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_version_id UUID NOT NULL REFERENCES policy_versions(policy_version_id),
    coverage_id     TEXT NOT NULL REFERENCES coverages(coverage_id)
);

-- ---------- Claims ----------
CREATE TABLE claims (
    claim_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id       UUID NOT NULL REFERENCES policies(policy_id),
    status          TEXT NOT NULL DEFAULT 'FNOL'
        CHECK (status IN ('FNOL','ASSESSING','APPROVED','REPUDIATED','SETTLED','CLOSED')),
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE claim_documents (
    claim_document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(claim_id),
    document_id     UUID
);

-- ---------- Documents ----------
CREATE TABLE documents (
    document_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    document_type   TEXT NOT NULL,               -- ID_FRONT | LOGBOOK | POLICY_CERTIFICATE | ...
    object_key      TEXT NOT NULL,               -- pointer into private object storage, never a public URL
    status          TEXT NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED','SCANNED','QUALITY_CHECKED','OCR_DONE','VERIFIED','REJECTED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
    document_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(document_id),
    version_no      INT NOT NULL DEFAULT 1
);

-- ---------- Notifications / Audit / Events ----------
CREATE TABLE notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    channel         TEXT NOT NULL CHECK (channel IN ('WHATSAPP','SMS','EMAIL','IN_APP')),
    template_key    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'QUEUED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE decision_traces (
    decision_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL,
    workflow        TEXT NOT NULL,               -- quote | underwriting | rating | referral | issuance | claim | renewal
    engine_version  TEXT NOT NULL,
    rule_set_version TEXT,
    inputs_hash     TEXT NOT NULL,
    decision        TEXT NOT NULL,
    reason_codes    JSONB NOT NULL DEFAULT '[]',
    actor           TEXT,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,               -- quote.created | policy.issued | claim.reported | ...
    aggregate_id    UUID,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
    delivery_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(event_id),
    target          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED')),
    attempt_count   INT NOT NULL DEFAULT 0
);

-- ---------- IAM ----------
CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE roles (
    role_id         TEXT PRIMARY KEY,            -- ADVISER | UNDERWRITER | ADMIN | COMPLIANCE
    role_name       TEXT NOT NULL
);

CREATE TABLE user_roles (
    user_id         UUID NOT NULL REFERENCES users(user_id),
    role_id         TEXT NOT NULL REFERENCES roles(role_id),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE integrations (
    integration_id  TEXT PRIMARY KEY,            -- LAMI | PAYMENT_PROVIDER | WHATSAPP_BSP | OCR_PROVIDER | ...
    integration_name TEXT NOT NULL,
    environment     TEXT NOT NULL DEFAULT 'SANDBOX' CHECK (environment IN ('SANDBOX','PRODUCTION')),
    status          TEXT NOT NULL DEFAULT 'CREDENTIALS_REQUIRED'
);

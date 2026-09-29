-- 002_motor_whatsapp_extension.sql
-- Motor/WhatsApp channel extension tables, derived from V14 V14_DB.
-- These reference the canonical tables in 001_canonical_core.sql — they do NOT duplicate
-- quotes/policies/referrals/documents. See Section F of the build plan for the reasoning.

CREATE TABLE whatsapp_conversations (
    conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_id           TEXT NOT NULL,               -- WhatsApp identifier (phone-based)
    customer_id     UUID REFERENCES customers(customer_id),
    state           TEXT NOT NULL DEFAULT 'NEW',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE motor_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES whatsapp_conversations(conversation_id),
    customer_id     UUID REFERENCES customers(customer_id),
    product_version_id UUID REFERENCES product_versions(product_version_id),
    quote_id        UUID REFERENCES quotes(quote_id),
    state           TEXT NOT NULL DEFAULT 'NEW' CHECK (state IN (
        'NEW','CONSENT_PENDING','IDENTITY_CAPTURE','ID_PENDING','ID_RETRY',
        'LOGBOOK_PENDING','LOGBOOK_RETRY','VEHICLE_CAPTURE','COVER_SELECTION',
        'DURATION_SELECTION','VALUE_CAPTURE','FINANCE_SELECTION','QUOTE_PENDING',
        'QUOTED','REFERRED','DECLINED','PAYMENT_PENDING','PAID','PAYMENT_FAILED',
        'ISSUANCE_PENDING','ISSUED','ISSUANCE_FAILED','ACTIVE','ABANDONED',
        'MANUAL_REVIEW','ERROR'
    )),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE answers (
    answer_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES motor_sessions(session_id),
    field           TEXT NOT NULL,
    value           JSONB NOT NULL,
    source          TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (source IN ('CUSTOMER','OCR','ADVISER')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    vehicle_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_number TEXT UNIQUE,
    chassis_number  TEXT,
    make            TEXT NOT NULL,
    model           TEXT NOT NULL,
    vehicle_category TEXT NOT NULL CHECK (vehicle_category IN (
        'MOTORCYCLE','PRIVATE_CAR','COMMERCIAL_VEHICLE','PSV','HIRE_REWARD','OTHER'
    )),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cover_requests (
    cover_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES motor_sessions(session_id),
    vehicle_id      UUID REFERENCES vehicles(vehicle_id),
    quote_id        UUID REFERENCES quotes(quote_id),
    cover_type      TEXT NOT NULL CHECK (cover_type IN ('THIRD_PARTY','COMPREHENSIVE')),
    duration        TEXT NOT NULL CHECK (duration IN ('WEEKLY','MONTHLY','ANNUAL')),
    vehicle_value_kes NUMERIC(14,2),
    lipa_pole_pole_requested BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_extractions (
    extraction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(document_id),
    field           TEXT NOT NULL,
    value           TEXT,
    confidence      NUMERIC(4,3),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_motor_sessions_state ON motor_sessions(state);
CREATE INDEX idx_whatsapp_conversations_wa_id ON whatsapp_conversations(wa_id);

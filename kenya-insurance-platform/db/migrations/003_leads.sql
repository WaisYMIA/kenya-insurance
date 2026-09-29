-- 003_leads.sql
-- Generic lead capture for every insurance line that isn't yet an automated quote flow
-- (Medical, WIBA, Life, Home, Travel, Pension & Annuities, General/SME). Matches V9 T005/T006
-- and Lami's own "Get a quote" lead form (send details -> an adviser follows up), and the
-- Needs_Questions (Q001-Q012) question set from V8.

CREATE TABLE leads (
    lead_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    product_line    TEXT NOT NULL CHECK (product_line IN (
        'MOTOR','MEDICAL','WIBA','LIFE','HOME','TRAVEL','PENSION_ANNUITIES','GENERAL'
    )),
    contact_name    TEXT NOT NULL,
    contact_phone   TEXT NOT NULL,
    contact_email   TEXT,
    answers         JSONB NOT NULL DEFAULT '{}',   -- keyed by Needs_Questions question_id (Q001-Q012)
    consent_given   BOOLEAN NOT NULL DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','NOTIFIED','IN_REVIEW','CLOSED')),
    source_channel  TEXT NOT NULL DEFAULT 'WEB' CHECK (source_channel IN ('WEB','WHATSAPP')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lead_activities (
    activity_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(lead_id),
    activity_type   TEXT NOT NULL,     -- LEAD_CREATED | OWNER_NOTIFIED_WHATSAPP | OWNER_NOTIFIED_EMAIL | ADVISER_FOLLOWUP
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_leads_product_line ON leads(product_line);
CREATE INDEX idx_leads_status ON leads(status);

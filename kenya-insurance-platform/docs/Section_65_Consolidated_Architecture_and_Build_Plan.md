# SECTION 65 — Pre-Build Deliverable
## Kenya General Insurance Platform: Consolidated Architecture, Gap Analysis & Build Plan

*Compiled from direct review of V1–V14 workbooks + V11 HTML MVP. Canonical source set used: V10 (cumulative snapshot through UX/UI) + V12 (Production/Compliance) + V13 (Hosting/Go-Live) + V14 (Motor WhatsApp), per the Stage_Register embedded in V12/V13. V7 refers to the `_EXCEL_REPAIRED` copy. V1 and the unrepaired V7 are superseded and not used further.*

---

## A. CONSOLIDATED ARCHITECTURE — HOW V2 THROUGH V14 FIT TOGETHER

The 14 stages are not 14 separate designs — they are one architecture built up in layers. Each layer only makes sense read on top of the one below it:

| Layer | Stage(s) | What it defines |
|---|---|---|
| 1. Ontology | V1–V2 | Product taxonomy, coverage components, perils, exclusions, UW questions, rating factors — the *vocabulary* of the business |
| 2. Rules & Rating | V3 | Eligibility, underwriting, rating, excess, referral, tax/levy, mandatory-cover, claims, renewal rules — the *policy logic*, expressed as effective-dated rule rows, never hard values |
| 3. Decision Engine | V4 | Decision tables/nodes/transitions that consume V3 rules to produce Quote/Underwriting/Premium/Referral/Issuance/Claims/Renewal decisions, each with a trace |
| 4. API Contract | V5 | REST resources/endpoints/schemas that expose the decision engine (`/quotes/decide`, `/underwriting/decide`, `/rating/calculate`, `/referrals`, `/policies/issue`, `/claims/decide`, `/renewals/decide`) |
| 5. Canonical Data | V6 | 46 canonical entities (Party→Customer→Product→Quote→Policy→Claim→Reinsurance→Document→Decision Trace→Event) with attributes, ERD, SQL DDL, PII classification, retention |
| 6. Services & Ops | V7 | 20-service catalogue, service boundaries/data ownership, workflows, state machines, security/IAM, environments, CI/CD, IaC, DR, testing, runbooks |
| 7. Consumer/Sales Product | V8 | Consumer journeys (10), consumer screens (12), sales screens (10), needs assessment, CRM, consumer/sales APIs, hosting, analytics funnel |
| 8. Build Spec | V9 | 20 concrete pages, 40 DB tables, 13 platform APIs, 13-workstream build sequence, integrations, NFRs, AI guardrails |
| 9. UX/UI | V10 | Design tokens, component library, wireframes, interaction states, responsive/accessibility rules, prototype-to-code handoff |
| 10. Working MVP | V11 | Static/interactive HTML realization of V8–V10 (Home, Learn, Navigator, Product Explorer, Adviser workspace) — **UX reference, not production code** |
| 11. Production Hardening | V12 | External integrations (identity, payment, SMS, email, WhatsApp, insurer core, e-sign, analytics, regulatory), security controls, privacy/data, DR/BCP, UAT, release gates |
| 12. Hosting/Go-Live | V13 | Environment strategy, hosting architecture, network security, DNS, CI/CD, monitoring, backup/DR, cutover, go/no-go, support model, cost control |
| 13. Motor WhatsApp Channel | V14 | The first commercial journey: WhatsApp-specific user flow, state machine, API surface, Lami adapter contract, document pipeline, Lipa Pole Pole, DB additions, test matrix, go-live gates |

**How they compose at runtime:**

```
CUSTOMER (WhatsApp or Web)
   │
   ▼
CHANNEL ADAPTER  ── WhatsApp/BSP adapter (V14)  |  Web/Next.js frontend (V8–V11)
   │
   ▼
API GATEWAY (SVC-01, V7 API_Gateway_Design)
   │
   ▼
CONVERSATION ORCHESTRATOR (V14 state machine)  ──┐
   │                                              │ shares the same
   ▼                                              │ decision/data services
DOMAIN SERVICES (V7 Service_Catalogue, 20 services):
  Party (SVC-02) → Customer (SVC-03) → Product (SVC-04) → Reference Data (SVC-05)
  → Rules (SVC-06) → Rating (SVC-07) → Decision Orchestrator (SVC-08)
  → Quote (SVC-09) → Referral (SVC-10) → Policy (SVC-11) → Billing (SVC-12)
  → Claims (SVC-13) → Reinsurance (SVC-14) → Document (SVC-15)
  → Decision Trace (SVC-16) → Event Platform (SVC-17) → Reporting (SVC-18)
  → Identity & Access (SVC-19) → Observability (SVC-20)
   │
   ▼
EXTERNAL ADAPTERS: Lami/Insurer Core, Payment Provider, Lipa Pole Pole Provider,
  OCR/Identity Verification, SMS, Email, WhatsApp BSP, Analytics/BI, Regulatory Reporting
```

**The critical architectural fact this confirms:** WhatsApp (V14) and the Web Sales/Consumer Platform (V8–V11) are **two channels in front of the same 20-service backend**, not two separate systems. `Quote`, `Policy`, `Referral`, `Document`, `Decision Trace` are single canonical services (V6/V7/V9). V14's `motor_sessions`, `answers`, `cover_requests` are WhatsApp-specific *session* tables that feed the same canonical `quotes`, `policies`, `referrals`, `documents` tables from V9 — they are not a parallel data model. This is the main de-duplication point for Section F below.

---

## B. IMPLEMENTATION GAP ANALYSIS

| Capability | Already specified | Already prototyped | Needs coding | Needs external integration | Needs business decision | Needs regulatory/compliance | Needs credentials |
|---|---|---|---|---|---|---|---|
| Product ontology & vocab | ✅ V1/V2 (80 products, perils, exclusions) | — | Admin CRUD UI | — | Which products launch first beyond motor | Product filing per insurer | — |
| Rules/rating/UW logic | ✅ V3 (effective-dated, no hard values) | — | Rules engine execution runtime | — | — | Confirm current Levy/PHCF/VAT rates & Gazette refs | — |
| Decision engine | ✅ V4 decision tables/nodes | — | Orchestrator + trace persistence | — | — | — | — |
| API contract (generic) | ✅ V5, V9 (13 endpoints) | — | Actual service implementations | — | — | — | — |
| Canonical data model | ✅ V6 (46 entities, DDL, PII map) | — | Migrations, ORM models | — | — | Data retention periods per entity | — |
| Service architecture | ✅ V7 (20 services, IAM, CI/CD, DR) | — | Actual services, gateway, IaC | Cloud provider account | Cloud provider choice (AWS/Azure/GCP) | Pen test, DR drill evidence | Cloud account |
| Consumer/Sales web product | ✅ V8 journeys/screens | ✅ V11 HTML MVP | Next.js production app from V9/V10 | — | — | Advice-record/disclosure approval | — |
| Build spec (pages/DB/API) | ✅ V9 | — | All 20 pages, 40 tables | — | — | — | — |
| UX/UI system | ✅ V10 tokens/components | ✅ V11 partially reflects it | Component library in code | — | — | Accessibility audit (WCAG) | — |
| Production integrations | ✅ V12 (contracts named, not endpoints) | — | Adapters for each integration | Identity/Payment/SMS/Email/WhatsApp/Insurer/E-sign/Analytics/Regulatory providers | Which providers per category | DPA/privacy approval | **All provider credentials** |
| Hosting/go-live | ✅ V13 (strategy, checklists) | — | Actual infra, DNS, monitoring | Domain registrar, cloud | — | — | Domain, cloud, DNS |
| Motor WhatsApp | ✅ V14 (flow, state machine, DB, tests) | Conceptually via V11 adviser view | WhatsApp adapter, onboarding service, OCR pipeline, Lami adapter | **WhatsApp BSP, OCR/KYC provider, Lami, payment, Lipa Pole Pole provider** | Motorcycle-first product parameters | Consent notice, KYC approach | **BSP creds, Lami sandbox, payment creds** |

**Net assessment:** the specification layer (V1–V10, V12–V14) is complete and internally consistent enough to build against directly — there is no need to re-derive architecture. The gap is entirely in (1) writing the actual services/pages/migrations, (2) obtaining external provider contracts and credentials, and (3) a short list of business/regulatory confirmations (current statutory rates, product launch sequence beyond motorcycle, provider selection). Nothing here blocks starting the build.

---

## C. MOTOR WHATSAPP BUILD PLAN — EXACT SEQUENCE

Merging the master brief's Phase 1–21 with V9's Build_Sequence and V14's Backlog into one ordered plan:

| # | Phase | Deliverable | Source |
|---|---|---|---|
| 1 | Repo + CI/CD + environments | Monorepo skeleton, GitHub Actions, DEV/TEST/UAT envs | V7 CI_CD, V13 Env Strategy |
| 2 | Canonical DB | `parties, customers, products, product_versions, rules, rule_versions, rate_configurations, quotes, policies, referrals, documents, decision_traces, events` (V9 T001–T040) + motor session extension tables (V14 DB) | V6/V9/V14 |
| 3 | Identity/RBAC | Staff auth (OIDC), roles, MFA | V7 IAM_RBAC |
| 4 | WhatsApp adapter | Inbound webhook normalizer `/v1/whatsapp/messages/inbound`, outbound sender, template registry | V14 API, master brief §46 |
| 5 | Conversation orchestrator | State machine executor (15 states, V14 State_Machine) | V14, master brief §22 |
| 6 | Consent | `consents` table + versioned notice serving | V9 T007, V14 |
| 7 | Customer/Party | Party/Customer/Contact services (SVC-02/03) | V6/V7 |
| 8 | Document service | Secure upload, private object storage, malware scan | V14 Document_Pipeline |
| 9 | OCR/verification adapter | Interface + mock/sandbox implementation until provider selected | V14 |
| 10 | Vehicle master data | `vehicles` table, make/model/category controlled lists | V14 DB |
| 11 | Motor product configuration | Product/version/coverage/term/cover-type config for Motorcycle Comprehensive & Third Party | V3, V6 Product_Version |
| 12 | Rules/eligibility | Rules Service executing V3 Eligibility_Rules/Underwriting_Rules | SVC-06 |
| 13 | Rating | Rating Service executing V3 Rate_Logic | SVC-07 |
| 14 | Quote | Quote Service + `/v1/quotes/decide` | SVC-09, V5 API |
| 15 | Lami/insurer adapter | `LamiAdapter` interface (getProducts/getQuote/issuePolicy/etc.) with sandbox stub until contract supplied | V14 Lami_Adapter |
| 16 | Payment | Payment Service, webhook verification, reconciliation | SVC-12, V12 External_Integrations |
| 17 | Lipa Pole Pole | Finance eligibility separated from insurance quote, installment schedule | V14 Lipa_Pole_Pole |
| 18 | Policy issuance | Compliance gates → issuance → certificate | SVC-11, V14 |
| 19 | WhatsApp document delivery | Secure doc push post-issuance | V14 |
| 20 | CRM/adviser workspace | Lead Inbox, Customer 360, Referral Queue reused from V8/V9 sales screens | SCR-S01–S10 |
| 21 | Analytics | Funnel events per V14 Event_Types + V8 Analytics_Funnel | SVC-18 |
| 22 | Security hardening | Pen test, secrets/KMS, webhook signature/replay controls | V12 Security_Controls |
| 23 | UAT | V14 Test_Matrix (T01–T16) executed end-to-end in sandbox | V14, master brief §51–52 |
| 24 | Go-live | V13 GoNoGo + V14 GoLive gates | V13/V14 |
| 25 | Production/hypercare | Monitoring, support model, runbooks live | V13 |

This matches the master brief's Phase 1–25 structure; nothing in it needs to be re-sequenced. Phases 1–13 (repo through rating) can start immediately with zero external credentials — everything from Phase 14 onward needs at least a sandbox contract for one external party (Lami, payment, or WhatsApp BSP) to test against, and can proceed with mock adapters until then.

---

## D. EXTERNAL DEPENDENCIES

| Item | Status |
|---|---|
| WhatsApp Business/BSP credentials + approved templates | **REQUIRED BEFORE UAT** |
| Lami partner API docs + sandbox credentials + product catalogue | **REQUIRED BEFORE UAT** (adapter can be built and tested against mocks without it) |
| Payment provider (M-Pesa/other) sandbox | **REQUIRED BEFORE UAT** |
| Lipa Pole Pole financing provider terms/contract | **REQUIRED BEFORE UAT** (P1 in V14 backlog — not required for first motor quote/issue path) |
| OCR/identity verification provider | **REQUIRED BEFORE UAT** (can stub with manual review meanwhile) |
| SMS provider | **REQUIRED BEFORE PRODUCTION** |
| Email provider | **REQUIRED BEFORE PRODUCTION** |
| Cloud account (AWS/Azure/GCP) | **AVAILABLE NOW or REQUIRED BEFORE UAT** — needed to stand up DEV/TEST |
| Domain + DNS | **REQUIRED BEFORE UAT** (V13 Domain_DNS) |
| Insurer product IDs, policy wording, motor rates, underwriting/referral rules, statutory charges (current Levy/PHCF/VAT figures) | **REQUIRED BEFORE PRODUCTION** — do not hard-code; V3 already marks these `SOURCE_CONTROLLED`/`CONFIGURE` |
| Legal/privacy approval of consent notice and data retention periods | **REQUIRED BEFORE UAT** |
| Penetration test + DR drill evidence | **REQUIRED BEFORE PRODUCTION** |

Nothing on this list blocks Phases 1–13 of the build plan above.

---

## E. REPOSITORY PLAN

```
/apps
  /consumer-web        (V8/V9/V10/V11 → Next.js production build)
  /sales-web           (Sales_Screens SCR-S01–S10)
  /admin-web           (WEB-017–020: Product/Content/Rules/Audit admin)
  /api                 (API gateway / BFF layer)

/services
  /whatsapp            (BSP adapter, V14 API)
  /onboarding           (Motor onboarding orchestrator + state machine)
  /party                (SVC-02)
  /customer             (SVC-03)
  /product              (SVC-04)
  /reference-data       (SVC-05)
  /rules                (SVC-06)
  /rating               (SVC-07)
  /decision-orchestrator(SVC-08)
  /quotes               (SVC-09)
  /referrals            (SVC-10)
  /policy               (SVC-11)
  /billing              (SVC-12)
  /claims               (SVC-13)
  /reinsurance          (SVC-14)
  /documents            (SVC-15, OCR adapter interface)
  /decision-trace       (SVC-16)
  /events               (SVC-17)
  /reporting            (SVC-18)
  /iam                  (SVC-19)
  /notifications        (WhatsApp/SMS/email dispatch)
  /payments             (payment + Lipa Pole Pole adapters)
  /lami-adapter         (LamiAdapter / InsurerAdapter interfaces)

/packages
  /domain               (shared types from V6 Canonical_Entities)
  /api-client
  /ui                   (V10 design tokens + component library)
  /config
  /types

/infrastructure         (Terraform per V13 Hosting_Architecture)
/docs                    (this document + per-service API docs)
/tests                   (V14 Test_Matrix, V12 UAT scripts, contract tests)
```

---

## F. DATABASE PLAN — CANONICAL MODEL → MIGRATIONS

De-duplication rule applied: V14's motor-specific tables are treated as **extensions that reference the canonical V9/V6 tables**, not replacements.

**Canonical core (from V9 T001–T040, owned by their listed service):** `parties, customers, contacts, addresses, leads, lead_activities, consents, needs_assessments, assessment_answers, risk_profiles, products, product_versions, coverages, product_coverages, content_items, content_versions, rules, rule_versions, rate_configurations, recommendations, quotes, quote_items, premiums, charges, referrals, policies, policy_versions, policy_coverages, claims, claim_documents, documents, document_versions, notifications, decision_traces, events, webhook_deliveries, users, roles, user_roles, integrations`.

**Motor-WhatsApp extension (from V14, all FK back to canonical tables above):**

| Table | Extends | Key fields |
|---|---|---|
| `whatsapp_conversations` | — (new, channel-specific) | conversation_id, wa_id, state |
| `motor_sessions` | → `customers.customer_id` | session_id, customer_id, state, product_version_id |
| `answers` | → `motor_sessions.session_id` | field, value, source |
| `vehicles` | — (new master data, referenced by quote_items/policy_coverages) | vehicle_id, registration, chassis, make, model |
| `cover_requests` | → `motor_sessions.session_id`, → `quotes.quote_id` | type, duration, value, finance flag |
| `document_extractions` | → `documents.document_id` | field, value, confidence (OCR output) |

No table in V14 duplicates a canonical table — `quotes`, `policies`, `referrals`, `documents`, `decision_traces`, `payments`(via `charges`/billing) are reused as-is. This means the WhatsApp channel writes into the same tables the web channel writes into, which is exactly the "WhatsApp is not the decision engine" principle from the master brief §2.

**Build order:** canonical core migrations first (Phase 2), motor extension tables second (Phase 10), both before any rules/rating work (Phase 12+).

---

## G. API PLAN

Three API surfaces exist in the specs and must be implemented as one coherent set, not three:

1. **Channel-facing (V14):** `/v1/whatsapp/messages/inbound`, `/v1/motor/sessions`, `/v1/documents`, `/v1/documents/{id}/validate`, `/v1/motor/eligibility`, `/v1/quotes` (create), `/v1/payments`, `/v1/policies/issue`, `/v1/webhooks/payment`, `/v1/webhooks/lami` — these are thin, session-oriented, and call straight into (2).
2. **Domain decision APIs (V5/V9):** `/v1/quotes/decide`, `/v1/underwriting/decide`, `/v1/rating/calculate`, `/v1/referrals`, `/v1/referrals/{id}/decide`, `/v1/policies/issue`, `/v1/claims/decide`, `/v1/renewals/decide`, `/v1/decisions/{decision_id}` — these are the actual decision engine, shared by every channel (WhatsApp, consumer web, sales web).
3. **Consumer/Sales web APIs (V9):** `/api/v1/needs/assessments`, `/api/v1/recommendations/decide`, `/api/v1/quotes`, `/api/v1/referrals`, `/api/v1/policies/issue`, `/api/v1/payments/initiate`, `/api/v1/claims/fnol`, `/api/v1/customers/{id}/dashboard` — same backend, browser-facing shape.

All three surfaces must carry: idempotency keys (mandatory per master brief §28), a `decision_trace_id` on every response that touches a rule/rating/underwriting outcome, and signature-verified/idempotent webhook handling for `{provider}` (payment, Lami, insurer core).

---

## H. WHATSAPP CONVERSATION DESIGN — FULL STATE TABLE

From V14 State_Machine, cross-checked against the master brief's 26-state list (the brief's list is the superset; V14's is the implemented core path):

| State | Valid next states | Trigger |
|---|---|---|
| NEW | CONSENT_PENDING | Inbound "Hi"/start |
| CONSENT_PENDING | IDENTITY_CAPTURE, ABANDONED | Consent response |
| IDENTITY_CAPTURE | ID_PENDING | Name/phone captured |
| ID_PENDING | LOGBOOK_PENDING, ID_RETRY, MANUAL_REVIEW | ID validated |
| LOGBOOK_PENDING | VEHICLE_CAPTURE, LOGBOOK_RETRY, MANUAL_REVIEW | Logbook received |
| VEHICLE_CAPTURE | COVER_SELECTION, MANUAL_REVIEW | Vehicle data normalized |
| COVER_SELECTION | DURATION_SELECTION, MANUAL_REVIEW | Cover selected |
| DURATION_SELECTION | VALUE_CAPTURE, FINANCE_SELECTION | Duration selected |
| VALUE_CAPTURE | FINANCE_SELECTION, MANUAL_REVIEW | Value validated (comprehensive only) |
| FINANCE_SELECTION | QUOTE_PENDING | Lipa Pole Pole choice captured |
| QUOTE_PENDING | QUOTED, REFERRED, DECLINED, RETRY | Decision response from Quote/Underwriting/Rating |
| QUOTED | PAYMENT_PENDING, ABANDONED | Customer accepts |
| PAYMENT_PENDING | PAID, PAYMENT_FAILED | Verified payment webhook (never customer say-so) |
| PAID | ISSUANCE_PENDING | Payment reconciled |
| ISSUANCE_PENDING | ISSUED, ISSUANCE_FAILED, MANUAL_REVIEW | Insurer/Lami response |

Two states in the master brief's list are not yet in V14's implemented table and should be added explicitly when the orchestrator is built: `ACTIVE` (post-ISSUED, policy in force) and `ERROR` (catch-all transition target for unhandled adapter failures, with resumption back into the last valid state on retry). `RESUMABLE` behavior (master brief §23) is not a separate state — it's the orchestrator re-entering whatever state the session was last persisted in when `NEW` is triggered again for a `wa_id` with an existing incomplete `motor_sessions` row.

**Human handoff:** "Talk to an adviser" is a transition available from *every* state above (not modeled as its own state) — it creates a `referrals` row (V14 Referral aggregate: OPEN → IN_REVIEW → APPROVED/DECLINED) carrying the full session snapshot, and the session state itself does not need to change until the adviser resolves it.

---

## Sources referenced in this document
V1/V2 Ontology_Products · V3 Product_Rules/Rate_Logic/Taxes_Levies/Excess_Deductibles/Referral_Rules/Mandatory_Covers · V6 Canonical_Entities/SQL_DDL · V7 Service_Catalogue/State_Machines/IAM_RBAC/CI_CD_Pipeline · V9 Database_Tables/Page_Specification/API_Specification/Build_Sequence/Implementation_Backlog · V8 Consumer_Journeys/Consumer_Screens/Sales_Screens/MVP_Backlog · V5 API_Endpoints/Event_Types · V12 External_Integrations/Stage_Register · V13 Stage_Register · V14 (all 15 sheets) · V11 HTML MVP (structure only).

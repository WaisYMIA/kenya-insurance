# Kenya General Insurance Platform — Monorepo (Build Increment 1)

This is the first working increment of the platform described in the Master Build Brief and
`Section_65_Consolidated_Architecture_and_Build_Plan.md`. It implements **Phases 1–3 and the start
of Phase 5/11** (Increment 2 update: motor covers ALL vehicle categories; every other line has a guided enquiry that alerts the owner) of the build plan: repo scaffold, canonical database schema, a backend API
skeleton with real (not mocked-away) request handling, and the first three consumer web pages.

## What's real vs what's a placeholder

- The database schema (`db/migrations/*.sql`) is real DDL for the canonical model in Section F
  of the build plan, plus the motor-WhatsApp extension tables from V14.
- The backend (`services/api`) is a genuine, dependency-free TypeScript HTTP server (Node's
  built-in `http` module — no Express/NestJS, because this sandbox has no network access to
  install packages). It runs and responds to real HTTP requests today.
- Its data layer is an **in-memory repository behind a `Repository` interface**
  (`services/api/src/repositories`). This is a deliberate, swappable seam: in your own networked
  environment, implement the same interface against Postgres (e.g. with `pg` or Prisma) and
  nothing above the repository layer changes. This mirrors the LamiAdapter/InsurerAdapter pattern
  already used elsewhere in the spec — code against an interface, swap the implementation once
  credentials/infrastructure exist.
- No insurance numbers are invented anywhere. Rate/rule lookups that aren't in the uploaded
  workbooks return `CONFIGURATION_REQUIRED` with a reason code, exactly as the master brief
  requires, instead of a fabricated premium.
- The frontend (`apps/consumer-web`) is static HTML/CSS/vanilla JS rather than Next.js, for the
  same offline-sandbox reason. `V10_Frontend_Architecture` (FE01) specifies Next.js/React as the
  target — once you have package-manager access, this can be ported page-for-page; the page
  structure, component boundaries and API contracts are already built to match it.

## Run it

```bash
# Backend (no install needed — zero external dependencies)
cd services/api
npx tsc --noEmit   # optional type-check
node --experimental-strip-types src/server.ts
# API now listening on http://localhost:4000

# Frontend (any static file server)
cd apps/consumer-web/public
python3 -m http.server 8080
# open http://localhost:8080 — set window.API_BASE if the API isn't on localhost:4000
```

## What remains (see Section 65 build plan for full sequence)

Phases 4, 6–10, 12–25: WhatsApp adapter, conversation orchestrator, consent capture, document/OCR
pipeline, vehicle master data, real rules/rating execution against configured rate tables, Lami
adapter, payment/Lipa Pole Pole, policy issuance, CRM/adviser workspace, admin panels, security
hardening, analytics, and everything requiring external credentials (see
`Section_65_Consolidated_Architecture_and_Build_Plan.md`, Section D).

## Increment 2 — scope corrections
- **Motor = one line, all vehicle categories** (motorcycle, private car, commercial, PSV, hire/reward, other). Category is a quote
  input, not a separate product (`MOT-TP-001`, `MOT-COMP-001`). Private-use categories proceed to rating; commercial/PSV/hire-reward/other
  are referred (mirrors V3 PR-002). Actual routing rules remain CONFIGURATION for the insurer to confirm.
- **Other lines** (Medical, WIBA, Life, Home, Travel, Pension & Annuities, General/SME): `apps/consumer-web/public/enquire.html`
  walks the client through key questions (V8 Needs_Questions), records a lead (`POST /v1/leads`, consent required) and alerts the owner
  by WhatsApp + email via `NotificationAdapter`. Without credentials (`.env.example`) alerts are written to the outbox log instead of sent.
- **Security gap to close before any real deployment:** `GET /v1/leads` is unauthenticated (staff RBAC/OIDC is Phase 3, not built yet).

## Increment 3 — staff login, persistence, WhatsApp conversation
- **Staff auth/RBAC:** `POST /v1/auth/login` (scrypt hashes, signed expiring tokens, rate limited, audited). ADMIN / ADVISER roles. `GET /v1/leads`, lead detail/notes/status and decision traces now require login. Inbox UI: `apps/consumer-web/public/staff.html`.
- **Persistence:** SQLite (`node:sqlite`, built in) via `SqliteRepository` — leads, quotes, decision traces, staff, WhatsApp sessions/messages, documents, webhook events, audit log survive restarts. Postgres schema remains in `/db` for scale-up.
- **WhatsApp:** `/v1/whatsapp/webhook` (Cloud API format, signature-verified, idempotent) drives an explicit state machine (`services/api/src/whatsapp/engine.ts`): consent -> name -> cover -> guided questions (all lines) or full motor journey (all categories) -> documents -> Lipa Pole Pole request -> lead + owner alert. Resume, adviser handoff, duplicate-safe.
- **Owner alerts** to 0724888057 (WhatsApp) and your email: implemented; live once credentials are set (see `.env.example`). Until then they are written to the outbox log.
- **Adapters, not fakes:** Lami / payment / Lipa Pole Pole / OCR return `CONTRACT REQUIRED` (501).
See `docs/OPERATIONS_AND_GO_LIVE.md`.

## Increment 4 — full product catalogue, class-specific intake, claims, renewals, analytics, admin approval
- **79 products loaded** from the ontology workbook via `scripts/extract-catalogue.py` -> `services/api/src/data/catalogue.json`. Re-run the script if the workbook changes.
- **Every class has its own guided intake** (`/v1/flows`), not just motor and the original 7 lines. General-class products (Engineering, Aviation, Marine, Theft, Personal Accident, Fire Industrial, Liability, Miscellaneous) get class -> product -> product-specific questions (built from that product's own rating factors).
- **Claims**: `claim.html` (web) + WhatsApp "Report a claim" path. First-notice-of-loss only — recorded and routed to you, never a coverage decision. Injuries flag URGENT + a safety message.
- **Renewals**: `staff.html` -> Renewals tab. Manual add or CSV import; automatic owner reminders at 30/14/7/0 days before expiry (customer reminders need an approved WhatsApp template).
- **Learn pages**: `learn.html`, one card per class.
- **Analytics**: `staff.html` -> Analytics tab + `GET /v1/analytics/funnel`. Real counts: WhatsApp stage drop-off, web funnel, leads, claims, renewals, motor-by-category.
- **Admin approval workflow**: `staff.html` -> Admin tab (ADMIN role only). Draft -> submit -> approve (by a *different* admin, enforced server-side) -> active, with full version history and rollback. Motor's referral-category rule is the first thing wired to it.
- See `docs/PROGRESS_UPDATE.md` for the standing status table to share/check against going forward.

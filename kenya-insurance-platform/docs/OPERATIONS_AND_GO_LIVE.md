# Operations & go-live checklist (Increment 3)

## Run
    cd services/api && cp ../../.env.example .env   # edit, then export the vars
    node --experimental-strip-types --no-warnings src/server.ts
    (cd ../../apps/consumer-web/public && python3 -m http.server 8080)
Staff inbox: http://localhost:8080/staff.html. First admin is created on first start (password printed once if ADMIN_PASSWORD unset).
Tests: `node --experimental-strip-types --no-warnings --test tests/api.test.ts` (16 tests).

## Connect WhatsApp (you)
1. Meta Business -> WhatsApp Cloud API: get the access token + phone number ID for your business number.
2. Webhook URL: `https://<your-api-host>/v1/whatsapp/webhook`; verify token = WHATSAPP_VERIFY_TOKEN; subscribe to `messages`. Set WHATSAPP_APP_SECRET.
3. Create + get approved a template for owner alerts (one body variable) -> WA_TEMPLATE_OWNER_ALERT. Without it, alerts to 0724888057 only arrive if you messaged the business number in the last 24h.
4. The business number cannot also be logged into the regular WhatsApp app once on the Cloud API — use a dedicated number or migrate deliberately.

## Before real customers
- [ ] HTTPS + reverse proxy (TLS, WAF), CORS_ORIGIN set, AUTH_SECRET set
- [ ] Legal-approved privacy notice URL + CONSENT_VERSION (Kenya Data Protection Act)
- [ ] Staff MFA (NOT built), password reset (NOT built), Postgres migration for scale (schema in /db)
- [ ] Encrypted backups of /data (SQLite file) + restore drill
- [ ] Document download/malware scan/OCR (needs WhatsApp media access + provider) — documents are currently recorded by reference only
- [ ] Rate tables / product rules loaded (otherwise every motor request is referred to you, by design)

## Known limits
Single-process rate limiting and conversation locks (fine for one instance; use Redis if you scale out). Kiswahili not built.
Lami, payments, Lipa Pole Pole, policy issuance: adapter interfaces only -> return 501 "CONTRACT REQUIRED".

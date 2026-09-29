# Kenya Insurance Platform — Progress Update
*Last updated: increment 4 build. Share this file as the standing status check.*

## What's live now
| Area | Status |
|---|---|
| Products | **79 of 79** ontology products loaded (all 13 classes), pulled from the workbook, not hand-typed |
| Client intake — Motor | Built. All vehicle categories. No premiums shown until rates are configured (by design) |
| Client intake — other 12 classes | Built. Each product gets its own questions, generated from its own rating factors |
| Claims (first notice of loss) | Built. Web + WhatsApp. Injury -> flagged URGENT + safety message. Never decides the claim |
| Renewals | Built. Manual entry + CSV import. Automatic reminders to you at 30/14/7/0 days; customer reminders need an approved WhatsApp template |
| Learn pages | Built. One page per class |
| Analytics funnel | Built. WhatsApp drop-off, web funnel, leads, claims, renewals, motor — real counts only |
| Admin approval workflow | Built. Every rule/flow/product/template change is draft -> submit -> approve by a **different** admin -> active. Full version history |
| Staff login, adviser inbox, persistence, WhatsApp conversation | Built (increment 3) |

## Pending — needs your input, not more building
| Item | What's needed |
|---|---|
| WhatsApp Business Cloud API | Access token, phone number ID, app secret, verify token |
| Approved WhatsApp templates | One for owner alerts, one for customer renewal reminders |
| Email | Your address + SMTP credentials |
| Rates, rules, statutory charges | Approved figures per product — until then every motor quote is honestly referred to you |
| Insurer / Lami | Partner API docs + sandbox credentials |
| Payment provider + Lipa Pole Pole | Provider selection + credentials |
| OCR / identity verification | Provider selection |
| Privacy notice | Legal sign-off + hosted URL |
| Hosting | Domain, cloud account, HTTPS |

## Not yet built (no external blocker — can build on request)
- Document download, malware scan, OCR execution (code path exists, waiting on WhatsApp media access + provider)
- Policy issuance, payment processing (adapters exist, return "contract required" honestly)
- Staff MFA, password reset, Kiswahili
- Multi-instance scaling (current rate limiting/locks assume one server)
- Postgres migration (schema ready in /db, currently running on SQLite)

## How to check progress yourself
- Run the test suite: `node --experimental-strip-types --no-warnings --test tests/*.test.ts` (30 tests, all passing as of this update)
- Staff inbox: `staff.html` → tabs for Inbox, Claims, Renewals, Analytics, Admin
- Re-run `scripts/extract-catalogue.py` if the product ontology workbook changes

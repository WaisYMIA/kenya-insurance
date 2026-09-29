import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcp, type Server } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kip4-"));
const PORT = 4600 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_SECRET = "test-app-secret-4";
const ADMIN = { email: "admin4@test.local", password: "correct-horse-battery" };
const OUTBOX = join(dir, "outbox.log");
let server: ChildProcess;
let smtp: Server;
let smtpMail = "";
let smtpPort = 0;

async function startServer(extra: Record<string, string> = {}) {
  server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "services/api/src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dir, "app.db"), AUTH_SECRET: "s4", ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      WHATSAPP_APP_SECRET: APP_SECRET, NOTIFICATION_OUTBOX_PATH: OUTBOX, OWNER_EMAIL: "owner4@test.local",
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false", SMTP_FROM: "alerts@test.local", LOGIN_RATE_MAX: "1000", ...extra } as NodeJS.ProcessEnv,
    cwd: join(import.meta.dirname, ".."), stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
}
before(async () => {
  smtp = createTcp((sock) => {
    sock.write("220 fake\r\n"); let data = false;
    sock.on("data", (b) => { for (const line of b.toString().split("\r\n")) {
      if (data) { smtpMail += line + "\n"; if (line === ".") { data = false; sock.write("250 ok\r\n"); } continue; }
      if (/^EHLO/.test(line)) sock.write("250 hi\r\n"); else if (/^MAIL|^RCPT/.test(line)) sock.write("250 ok\r\n");
      else if (line === "DATA") { data = true; sock.write("354 go\r\n"); } else if (line === "QUIT") { sock.write("221 bye\r\n"); sock.end(); } } });
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  smtpPort = (smtp.address() as any).port;
  await startServer();
});
after(() => { server.kill(); smtp.close(); });

const j = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
  fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: "Bearer " + init.token } : {}), ...(init.headers as any) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
async function login() { const r = await j("/v1/auth/login", { method: "POST", json: ADMIN }); return ((await r.json()) as any).token as string; }

let mid = 0;
async function waSend(from: string, msg: { text?: string; media?: { id: string; mime: string }; id?: string }) {
  const m: any = { from, id: msg.id ?? `wamid4.${++mid}.${Math.random()}`, timestamp: "1" };
  if (msg.media) { m.type = "image"; m.image = { id: msg.media.id, mime_type: msg.media.mime }; } else { m.type = "text"; m.text = { body: msg.text }; }
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [m] } }] }] });
  const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  return fetch(BASE + "/v1/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: raw });
}
const lastReplyTo = (waId: string) => { const lines = readFileSync(OUTBOX, "utf8").split("\n").filter((l) => l.includes(`WHATSAPP -> ${waId}:`)); return lines[lines.length - 1] ?? ""; };

// ======================================================================= CATALOGUE / PRODUCTS
test("all 79 ontology products are loaded, across all 13 classes, with coverages where the ontology defines them", async () => {
  const r = (await (await j("/v1/products")).json()) as any;
  assert.equal(r.products.length, 79);
  assert.equal(new Set(r.products.map((p: any) => p.class)).size, 13);
  assert.equal(r.classes.length, 13);
  const withCover = r.products.filter((p: any) => p.coverages.length > 0);
  assert.ok(withCover.length >= 30, `expected coverage mappings on many products, got ${withCover.length}`);
  for (const p of r.products) assert.ok(p.product_id && p.name && p.class, JSON.stringify(p));
});

test("class-specific intake flows exist for every ontology class, not just motor", async () => {
  const flows = (await (await j("/v1/flows")).json()) as any;
  for (const k of ["HOME", "LIFE", "MEDICAL", "PENSION_ANNUITIES", "TRAVEL", "WIBA"]) assert.ok(k in flows.lines, k);
  const generalClassNames = flows.general.classes.map((c: any) => c.name);
  for (const cls of ["Engineering", "Aviation", "Marine & Transit", "Theft", "Personal Accident", "Fire Industrial/Commercial", "Liability", "Miscellaneous"]) {
    assert.ok(generalClassNames.includes(cls), `missing class: ${cls}`);
  }
  // Each product in each general class gets its OWN questions (built from its own rating factors) — not a shared generic set.
  const eng = flows.general.classes.find((c: any) => c.name === "Engineering");
  assert.ok(eng.products.length >= 1);
  const q1 = eng.products[0].questions, q2 = eng.products[1]?.questions;
  assert.ok(q1.length >= 3);
  if (q2) assert.notDeepEqual(q1.map((q: any) => q.text), q2.map((q: any) => q.text), "different products should get different questions");
});

test("web enquiry for a General-class product (e.g. Engineering) reaches the owner with the product recorded", async () => {
  const flows = (await (await j("/v1/flows")).json()) as any;
  const eng = flows.general.classes.find((c: any) => c.name === "Engineering");
  const product = eng.products[0];
  const answers: Record<string, unknown> = { product_id: product.product_id };
  for (const q of product.questions) answers[q.id] = q.type === "choice" ? q.options[0] : "test answer";
  const r = await j("/v1/leads", { method: "POST", json: { product_line: "GENERAL", contact_name: "Eng Client", contact_phone: "0700333444", consent_given: true, answers } });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 250));
  assert.match(smtpMail, /Eng Client/);
  const token = await login();
  const lead = ((await (await j("/v1/leads?line=GENERAL", { token })).json()) as any).leads.find((l: any) => l.contact_name === "Eng Client");
  assert.equal(lead.answers.product_id, product.product_id);
  assert.equal(lead.answers.product_class, "Engineering");
});

test("WhatsApp: General class path (class -> product -> product-specific questions) creates a correctly tagged lead", async () => {
  const me = "254722000010"; const token = await login();
  await waSend(me, { text: "Hi" }); await waSend(me, { text: "I agree" }); await waSend(me, { text: "Mary Wambui" });
  await waSend(me, { text: "Business & general insurance" });
  assert.match(lastReplyTo(me), /What kind of cover are you looking for/);
  await waSend(me, { text: "Theft" });
  assert.match(lastReplyTo(me), /Which Theft cover are you interested in/);
  const flows = (await (await j("/v1/flows")).json()) as any;
  const theftProduct = flows.general.classes.find((c: any) => c.name === "Theft").products[0];
  await waSend(me, { text: theftProduct.name });
  for (const q of theftProduct.questions) await waSend(me, { text: q.type === "choice" ? q.options[0] : "test answer" });
  assert.match(lastReplyTo(me), /sent to an adviser/);
  const lead = ((await (await j("/v1/leads?line=GENERAL", { token })).json()) as any).leads.find((l: any) => l.contact_phone === me);
  assert.equal(lead.answers.product_id, theftProduct.product_id);
  assert.equal(lead.answers.product_class, "Theft");
});

// ======================================================================= CLAIMS
test("claims: web FNOL is recorded, alerts the owner, gives evidence checklist, and status lookup works", async () => {
  const r = await j("/v1/claims", { method: "POST", json: { contact_name: "Otieno K", contact_phone: "0700555666", consent_given: true,
    answers: { "Q-C1": "Motor", "Q-C2": "POL-123", "Q-C3": "2026-09-20", "Q-C4": "Thika Road", "Q-C5": "Rear-ended at the lights", "Q-C6": "No", "Q-C7": "OB/45/2026" } } });
  assert.equal(r.status, 201);
  const body = (await r.json()) as any;
  assert.match(body.claim_ref, /^CL-[A-Z0-9]{6}$/);
  assert.ok(body.evidence.length > 0);
  await new Promise((res) => setTimeout(res, 250));
  assert.match(smtpMail, /NEW CLAIM NOTICE/); assert.match(smtpMail, /Thika Road/);
  const status = (await (await j(`/v1/claims/status?ref=${body.claim_ref}&phone=0700555666`)).json()) as any;
  assert.match(status.status, /Received/);
  assert.equal((await j(`/v1/claims/status?ref=${body.claim_ref}&phone=0799999999`)).status, 404); // wrong phone
});

test("claims: injury is flagged URGENT and triggers a safety message on WhatsApp; staff can update status", async () => {
  const token = await login();
  const r = await j("/v1/claims", { method: "POST", json: { contact_name: "Urgent Case", contact_phone: "0700777888", consent_given: true,
    answers: { "Q-C1": "Motor", "Q-C6": "Yes", "Q-C5": "Collision with injuries" } } });
  const { claim_ref } = (await r.json()) as any;
  const claims = ((await (await j("/v1/claims", { token })).json()) as any).claims;
  const claim = claims.find((c: any) => c.claim_ref === claim_ref);
  assert.equal(claim.priority, "URGENT");
  const upd = await j(`/v1/claims/${claim.claim_id}`, { method: "PATCH", token, json: { status: "ACKNOWLEDGED", assigned_to: "Adviser Two" } });
  assert.equal(((await upd.json()) as any).status, "ACKNOWLEDGED");
  assert.equal((await j(`/v1/claims/${claim.claim_id}`, { method: "PATCH", token, json: { status: "BOGUS" } })).status, 400);
  assert.equal((await j("/v1/claims", { method: "POST", json: {} })).status, 400); // consent/fields enforced
});

test("WhatsApp: full claim journey with injury shows a safety message and evidence list, never decides the claim", async () => {
  const me = "254733222111";
  await waSend(me, { text: "Hi" }); await waSend(me, { text: "I agree" }); await waSend(me, { text: "Sam Kiptoo" }); await waSend(me, { text: "Report a claim" });
  for (const a of ["Motor", "POL-999", "2026-09-25", "Nyeri", "Hit a pothole", "Yes", "none"]) await waSend(me, { text: a });
  const lines = readFileSync(OUTBOX, "utf8").split("\n").filter((l) => l.includes(`WHATSAPP -> ${me}:`)).slice(-3).join("\n");
  assert.match(lines, /claim notice is recorded/);
  assert.match(lines, /emergency services/);
  assert.doesNotMatch(lines, /approved|covered|liable|we will pay/i);
});

// ======================================================================= RENEWALS
test("renewals: validation, CSV import, filtering, and update", async () => {
  const token = await login();
  assert.equal((await j("/v1/renewals", { method: "POST", token, json: { customer_name: "X", customer_phone: "0700", product_name: "P", expiry_date: "bad-date" } })).status, 400);
  const csv = "customer_name,customer_phone,product_name,expiry_date,reminders_consent\nAlice W,0711000111,Home Comprehensive,2026-10-10,true\nBob M,0722000222,Motor Private,2026-09-29,false\nBad Row,,,,";
  const imp = (await (await j("/v1/renewals/import", { method: "POST", token, headers: { "Content-Type": "text/csv" }, body: csv })).json()) as any;
  assert.equal(imp.created, 2); assert.equal(imp.errors.length, 1);
  const all = ((await (await j("/v1/renewals", { token })).json()) as any).renewals;
  const alice = all.find((r: any) => r.customer_name === "Alice W");
  assert.equal(alice.reminders_consent, true); assert.equal(alice.source, "CSV");
  const upd = await j(`/v1/renewals/${alice.renewal_id}`, { method: "PATCH", token, json: { status: "RENEWED" } });
  assert.equal(((await upd.json()) as any).status, "RENEWED");
  const active = ((await (await j("/v1/renewals?status=ACTIVE", { token })).json()) as any).renewals;
  assert.ok(!active.some((r: any) => r.renewal_id === alice.renewal_id));
});

test("renewal reminders: due items alert the owner once per threshold (no repeats on immediate re-run)", async () => {
  const token = await login();
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await j("/v1/renewals", { method: "POST", token, json: { customer_name: "Due Soon", customer_phone: "0700999000", product_name: "WIBA Cover", expiry_date: soon } });
  smtpMail = "";
  const run1 = (await (await j("/v1/renewals/run-reminders", { method: "POST", token })).json()) as any;
  assert.ok(run1.reminders.some((r: any) => r.customer === "Due Soon"));
  await new Promise((res) => setTimeout(res, 250));
  assert.match(smtpMail, /RENEWALS DUE/); assert.match(smtpMail, /Due Soon/);
  smtpMail = "";
  const run2 = (await (await j("/v1/renewals/run-reminders", { method: "POST", token })).json()) as any;
  assert.ok(!run2.reminders.some((r: any) => r.customer === "Due Soon"), "should not re-alert for the same threshold");
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(smtpMail, "");
});

test("renewals endpoints require staff auth", async () => {
  assert.equal((await j("/v1/renewals")).status, 401);
  assert.equal((await j("/v1/renewals", { method: "POST", json: {} })).status, 401);
});

// ======================================================================= ANALYTICS
test("analytics funnel: reflects real WhatsApp progress, leads, claims and renewals — no invented numbers", async () => {
  const token = await login();
  const me = "254744111222";
  await waSend(me, { text: "Hi" }); // STARTED
  await waSend(me, { text: "I agree" }); // CONSENTED
  await waSend(me, { text: "Funnel Test" }); // NAMED
  await waSend(me, { text: "Life insurance" }); // LINE_CHOSEN
  await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-TP-001", vehicle_category: "MOTORCYCLE", usage_type: "private", cover_type: "THIRD_PARTY", duration: "ANNUAL" } });
  const funnel = (await (await j("/v1/analytics/funnel?days=7", { token })).json()) as any;
  const byKey = Object.fromEntries(funnel.whatsapp.stages.map((s: any) => [s.key, s.count]));
  assert.ok(byKey.STARTED >= 1); assert.ok(byKey.CONSENTED >= 1); assert.ok(byKey.NAMED >= 1); assert.ok(byKey.LINE_CHOSEN >= 1);
  assert.ok(byKey.COMPLETED <= byKey.LINE_CHOSEN, "funnel must be monotonically non-increasing");
  assert.ok(funnel.leads.total >= 1);
  assert.ok(funnel.claims.total >= 1);
  assert.ok(funnel.renewals.active >= 1);
  assert.ok(funnel.motor.quote_requests >= 1);
  assert.equal(funnel.period_days, 7);
});

test("analytics requires staff auth", async () => { assert.equal((await j("/v1/analytics/funnel")).status, 401); });

// ======================================================================= APPROVAL-CONTROLLED CONFIG
test("config: invalid values rejected; maker != checker enforced; approved rule changes motor referral behaviour; rollback works", async () => {
  const token = await login();
  const badKind = await j("/v1/admin/config", { method: "POST", token, json: { kind: "nope", key: "x", value: {} } });
  assert.equal(badKind.status, 400);
  const badVal = await j("/v1/admin/config", { method: "POST", token, json: { kind: "rule", key: "motor.referral_categories", value: { categories: ["NOT_A_CATEGORY"] } } });
  assert.equal(badVal.status, 400);

  // Baseline: PRIVATE_CAR normally proceeds to rating (not referred for category reasons).
  const before = (await (await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-TP-001", vehicle_category: "PRIVATE_CAR", usage_type: "private", cover_type: "THIRD_PARTY", duration: "ANNUAL" } })).json()) as any;
  assert.equal(before.quote.status, "REFERRED"); // referred anyway (no rate configured) — but NOT for a category reason
  const beforeTrace = (await (await j(`/v1/decisions/${before.decision_trace_id}`, { token })).json()) as any;
  assert.deepEqual(beforeTrace.reason_codes, ["RATE_CONFIGURATION_REQUIRED"]);

  const draft = (await (await j("/v1/admin/config", { method: "POST", token, json: { kind: "rule", key: "motor.referral_categories", value: { categories: ["PRIVATE_CAR"] }, note: "test: force private car review" } })).json()) as any;
  assert.equal(draft.status, "DRAFT");
  await j(`/v1/admin/config/${draft.id}/submit`, { method: "POST", token });
  const selfApprove = await j(`/v1/admin/config/${draft.id}/approve`, { method: "POST", token });
  assert.equal(selfApprove.status, 403); // maker-checker: same admin cannot approve their own change

  // A second admin approves.
  await j("/v1/admin/users", { method: "POST", token, json: { email: "checker@test.local", name: "Checker", role: "ADMIN", password: "checker-long-password" } });
  const checkerToken = await (async () => ((await (await j("/v1/auth/login", { method: "POST", json: { email: "checker@test.local", password: "checker-long-password" } })).json()) as any).token)();
  const approved = await j(`/v1/admin/config/${draft.id}/approve`, { method: "POST", token: checkerToken });
  assert.equal(approved.status, 200);

  const after = (await (await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-TP-001", vehicle_category: "PRIVATE_CAR", usage_type: "private", cover_type: "THIRD_PARTY", duration: "ANNUAL" } })).json()) as any;
  const afterTrace = (await (await j(`/v1/decisions/${after.decision_trace_id}`, { token })).json()) as any;
  assert.deepEqual(afterTrace.reason_codes, ["CATEGORY_REQUIRES_UNDERWRITING_REVIEW"]); // rule change took effect

  // Rollback drafts a new version copying the pre-change value; it needs its own approval before it applies.
  const rollbackResp = await j(`/v1/admin/config/${draft.id}/rollback`, { method: "POST", token: checkerToken });
  assert.equal(rollbackResp.status, 201);
  const rollbackDraft = (await rollbackResp.json()) as any;
  assert.equal(rollbackDraft.status, "DRAFT");
  assert.equal(rollbackDraft.rollback_of, draft.version);
  const stillAfter = (await (await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-TP-001", vehicle_category: "PRIVATE_CAR", usage_type: "private", cover_type: "THIRD_PARTY", duration: "ANNUAL" } })).json()) as any;
  const stillTrace = (await (await j(`/v1/decisions/${stillAfter.decision_trace_id}`, { token })).json()) as any;
  assert.deepEqual(stillTrace.reason_codes, ["CATEGORY_REQUIRES_UNDERWRITING_REVIEW"], "unapproved rollback draft must not take effect yet");
});

test("config version history is visible and audited", async () => {
  const token = await login();
  const versions = ((await (await j("/v1/admin/config?kind=rule&key=motor.referral_categories", { token })).json()) as any).versions;
  assert.ok(versions.length >= 2);
  const audit = ((await (await j("/v1/admin/audit", { token })).json()) as any).audit.map((a: any) => a.action);
  for (const a of ["CONFIG_DRAFTED", "CONFIG_SUBMITTED", "CONFIG_APPROVED"]) assert.ok(audit.includes(a), a);
});

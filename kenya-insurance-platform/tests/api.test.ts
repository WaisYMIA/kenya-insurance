import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcp, type Server } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kip-"));
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const APP_SECRET = "test-app-secret";
const PAY_SECRET = "test-pay-secret";
const ADMIN = { email: "admin@test.local", password: "correct-horse-battery" };
const OUTBOX = join(dir, "outbox.log");
let server: ChildProcess;
let smtp: Server;
let smtpMail = "";
let smtpPort = 0;

function env(extra: Record<string, string> = {}) {
  return { ...process.env, PORT: String(PORT), DB_PATH: join(dir, "app.db"), AUTH_SECRET: "test-auth-secret", ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: "verify-me", PAYMENT_WEBHOOK_SECRET: PAY_SECRET, NOTIFICATION_OUTBOX_PATH: OUTBOX,
    LOGIN_RATE_MAX: "1000", OWNER_EMAIL: "owner@test.local", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false", SMTP_FROM: "alerts@test.local", ...extra } as NodeJS.ProcessEnv;
}
async function startServer(extra: Record<string, string> = {}) {
  server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "services/api/src/server.ts"], { env: env(extra), cwd: join(import.meta.dirname, ".."), stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
}
async function stopServer() { server.kill(); await new Promise((r) => setTimeout(r, 200)); }

before(async () => {
  smtp = createTcp((sock) => { // minimal fake SMTP server
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
after(async () => { await stopServer(); smtp.close(); });

const j = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
  fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: "Bearer " + init.token } : {}), ...(init.headers as any) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
async function login(email = ADMIN.email, password = ADMIN.password) {
  const r = await j("/v1/auth/login", { method: "POST", json: { email, password } });
  return { status: r.status, body: (await r.json()) as any };
}

// ---------- WhatsApp helpers ----------
let mid = 0;
async function waSend(from: string, msg: { text?: string; media?: { id: string; mime: string }; id?: string }, opts: { sign?: boolean; sig?: string } = {}) {
  const m: any = { from, id: msg.id ?? `wamid.${++mid}.${Math.random()}`, timestamp: "1" };
  if (msg.media) { m.type = "image"; m.image = { id: msg.media.id, mime_type: msg.media.mime }; } else { m.type = "text"; m.text = { body: msg.text }; }
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [m] } }] }] });
  const sig = opts.sig ?? "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  return fetch(BASE + "/v1/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", ...(opts.sign === false ? {} : { "X-Hub-Signature-256": sig }) }, body: raw });
}
const lastReplyTo = (waId: string) => { const lines = readFileSync(OUTBOX, "utf8").split("\n").filter((l) => l.includes(`WHATSAPP -> ${waId}:`)); return lines[lines.length - 1] ?? ""; };
async function leads(token: string) { return ((await (await j("/v1/leads", { token })).json()) as any).leads as any[]; }

// ======================================================================= AUTH / RBAC
test("health is public", async () => { assert.equal((await j("/health")).status, 200); });

test("lead inbox requires authentication", async () => {
  assert.equal((await j("/v1/leads")).status, 401);
  assert.equal((await j("/v1/leads", { token: "garbage.token" })).status, 401);
  assert.equal((await j("/v1/decisions/abc")).status, 401);
});

test("bad credentials rejected, good credentials return a working token", async () => {
  assert.equal((await login(ADMIN.email, "wrong-password")).status, 401);
  assert.equal((await login("nobody@test.local", "whatever-long-pass")).status, 401);
  const ok = await login();
  assert.equal(ok.status, 200);
  assert.equal((await j("/v1/leads", { token: ok.body.token })).status, 200);
});

test("advisers cannot use admin endpoints; admins can create advisers", async () => {
  const admin = (await login()).body.token;
  assert.equal((await j("/v1/admin/users", { method: "POST", token: admin, json: { email: "a@test.local", name: "A", role: "ADVISER", password: "short" } })).status, 400);
  assert.equal((await j("/v1/admin/users", { method: "POST", token: admin, json: { email: "adviser@test.local", name: "Adv", role: "ADVISER", password: "a-long-adviser-pass" } })).status, 201);
  const adv = await login("adviser@test.local", "a-long-adviser-pass");
  assert.equal(adv.status, 200);
  assert.equal((await j("/v1/admin/users", { token: adv.body.token })).status, 403);
  assert.equal((await j("/v1/admin/audit", { token: adv.body.token })).status, 403);
  assert.equal((await j("/v1/leads", { token: adv.body.token })).status, 200);
});

// ======================================================================= LEADS + ALERTS + PERSISTENCE
test("web lead: consent enforced, stored, emailed to owner, visible in inbox", async () => {
  const bad = await j("/v1/leads", { method: "POST", json: { product_line: "HOME", contact_name: "x", contact_phone: "0711", consent_given: false } });
  assert.equal(bad.status, 400);
  const r = await j("/v1/leads", { method: "POST", json: { product_line: "MEDICAL", contact_name: "Wanjiru", contact_phone: "0722000111", consent_given: true, answers: { "Q-007": "Just me" } } });
  assert.equal(r.status, 201);
  const body = (await r.json()) as any;
  assert.match(body.owner_notification.whatsapp, /CREDENTIALS_REQUIRED/); // honest: WhatsApp isn't connected yet
  await new Promise((res) => setTimeout(res, 300));
  assert.match(smtpMail, /NEW MEDICAL LEAD/);   // email really delivered to the (fake) SMTP server
  assert.match(smtpMail, /wa\.me\/254722000111/);
  const admin = (await login()).body.token;
  const all = await leads(admin);
  const lead = all.find((l) => l.lead_id === body.lead_id);
  assert.equal(lead.status, "NOTIFIED");
  assert.equal(lead.answers._consent.channel, "WEB");
});

test("staff can update status, assign and add notes; everything is audited", async () => {
  const admin = (await login()).body.token;
  const lead = (await leads(admin))[0];
  const p = await j(`/v1/leads/${lead.lead_id}`, { method: "PATCH", token: admin, json: { status: "IN_REVIEW", assigned_to: "Adviser One" } });
  assert.equal(((await p.json()) as any).status, "IN_REVIEW");
  assert.equal((await j(`/v1/leads/${lead.lead_id}`, { method: "PATCH", token: admin, json: { status: "BOGUS" } })).status, 400);
  assert.equal((await j(`/v1/leads/${lead.lead_id}/notes`, { method: "POST", token: admin, json: { text: "Called, will follow up" } })).status, 201);
  const detail = (await (await j(`/v1/leads/${lead.lead_id}`, { token: admin })).json()) as any;
  assert.equal(detail.notes.length, 1);
  const audit = ((await (await j("/v1/admin/audit", { token: admin })).json()) as any).audit.map((a: any) => a.action);
  for (const a of ["LOGIN_OK", "LEAD_CREATED", "LEAD_UPDATED", "LEAD_NOTE_ADDED"]) assert.ok(audit.includes(a), a);
});

test("data survives a server restart", async () => {
  const before = (await leads((await login()).body.token)).length;
  assert.ok(before >= 1);
  await stopServer(); await startServer();
  const token = (await login()).body.token;
  assert.equal((await leads(token)).length, before);
});

// ======================================================================= MOTOR — ALL CATEGORIES
test("motor quote: every vehicle category is accepted; commercial/PSV/hire/other are referred with a reason; referrals reach the inbox", async () => {
  const admin = (await login()).body.token;
  const expectations: Record<string, string> = { MOTORCYCLE: "RATE_CONFIGURATION_REQUIRED", PRIVATE_CAR: "RATE_CONFIGURATION_REQUIRED", COMMERCIAL_VEHICLE: "CATEGORY_REQUIRES_UNDERWRITING_REVIEW", PSV: "CATEGORY_REQUIRES_UNDERWRITING_REVIEW", HIRE_REWARD: "CATEGORY_REQUIRES_UNDERWRITING_REVIEW", OTHER: "VEHICLE_CATEGORY_UNSUPPORTED" };
  for (const [cat, reason] of Object.entries(expectations)) {
    const r = (await (await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-TP-001", vehicle_category: cat, usage_type: "private", cover_type: "THIRD_PARTY", duration: "ANNUAL", contact_name: "T " + cat, contact_phone: "0700000000", consent_given: true } })).json()) as any;
    assert.equal(r.quote.status, "REFERRED", cat);
    assert.equal(r.quote.premium_kes, null, "no invented premium");
    const trace = (await (await j(`/v1/decisions/${r.decision_trace_id}`, { token: admin })).json()) as any;
    assert.deepEqual(trace.reason_codes, [reason], cat);
  }
  const motor = (await leads(admin)).filter((l) => l.product_line === "MOTOR");
  assert.ok(motor.length >= 6);
  const noValue = (await (await j("/v1/quotes/decide", { method: "POST", json: { product_id: "MOT-COMP-001", vehicle_category: "PRIVATE_CAR", usage_type: "private", cover_type: "COMPREHENSIVE", duration: "ANNUAL" } })).json()) as any;
  assert.equal(noValue.quote.status, "DRAFT"); // comprehensive requires value
});

// ======================================================================= WHATSAPP
test("webhook rejects unsigned and badly-signed requests; handshake works", async () => {
  assert.equal((await waSend("254700000001", { text: "Hi" }, { sign: false })).status, 401);
  assert.equal((await waSend("254700000001", { text: "Hi" }, { sig: "sha256=" + "0".repeat(64) })).status, 401);
  assert.equal((await fetch(`${BASE}/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`)).status, 200);
  assert.equal((await fetch(`${BASE}/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123`)).status, 403);
});

test("WhatsApp: full medical journey creates ONE lead, consent recorded, duplicates ignored", async () => {
  const me = "254711000001"; const admin = (await login()).body.token;
  const before = (await leads(admin)).length;
  await waSend(me, { text: "Hi" });
  assert.match(lastReplyTo(me), /privacy notice/);
  await waSend(me, { text: "I agree" });
  assert.match(lastReplyTo(me), /full name/);
  await waSend(me, { text: "Grace Achieng" });
  assert.match(lastReplyTo(me), /What would you like cover for/);
  await waSend(me, { text: "Medical insurance" });
  assert.match(lastReplyTo(me), /Which cover are you interested in/); // product picker, built from the ontology
  await waSend(me, { text: "Not sure yet" });
  assert.match(lastReplyTo(me), /Who needs cover/);
  await waSend(me, { text: "banana" }); // invalid input -> re-asked, not advanced
  assert.match(lastReplyTo(me), /Who needs cover/);
  for (const a of ["Just me", "1", "No", "No", "Lowest price"]) await waSend(me, { text: a });
  const dupId = "wamid.DUPLICATE-1";
  await waSend(me, { text: "Immediately", id: dupId });
  await waSend(me, { text: "Immediately", id: dupId }); // provider retry / duplicate delivery
  assert.match(lastReplyTo(me), /sent to an adviser/);
  const after = await leads(admin);
  assert.equal(after.length, before + 1, "exactly one lead");
  const lead = after.find((l) => l.contact_phone === me);
  assert.equal(lead.source_channel, "WHATSAPP"); assert.equal(lead.contact_name, "Grace Achieng");
  assert.equal(lead.answers["Q-011"], "Immediately");
  assert.equal(lead.answers._consent.channel, "WHATSAPP"); assert.ok(lead.answers._consent.version);
});

test("WhatsApp: motor journey (all categories flow) with documents and Lipa Pole Pole request", async () => {
  const me = "254711000002"; const admin = (await login()).body.token;
  const say = (t: string) => waSend(me, { text: t });
  for (const t of ["hello", "I agree", "John Kamau", "Motor insurance", "Commercial vehicle", "Commercial / business", "Comprehensive", "Annual"]) await say(t);
  assert.match(lastReplyTo(me), /current value/);
  await say("KES 250,000"); await say("kdd 456z"); await say("Isuzu NPR");
  assert.match(lastReplyTo(me), /photo of the front of your ID/);
  await waSend(me, { media: { id: "media-1", mime: "application/x-msdownload" } }); // wrong file type
  const lastTwo = readFileSync(OUTBOX, "utf8").split("\n").filter((l) => l.includes(`WHATSAPP -> ${me}:`)).slice(-2).join("\n");
  assert.match(lastTwo, /JPG\/PNG photo or a PDF/); // re-prompt explains, then repeats the question
  await waSend(me, { media: { id: "media-1", mime: "image/jpeg" } });
  assert.match(lastReplyTo(me), /logbook/);
  await waSend(me, { media: { id: "media-2", mime: "application/pdf" } });
  assert.match(lastReplyTo(me), /Lipa Pole Pole/);
  await say("Yes");
  const replies = readFileSync(OUTBOX, "utf8").split("\n").filter((l) => l.includes(`WHATSAPP -> ${me}:`)).slice(-2).join("\n");
  assert.match(replies, /quick review before we can provide a final quote/);
  assert.match(replies, /assessed separately/);
  const lead = (await leads(admin)).find((l) => l.contact_phone === me);
  assert.equal(lead.product_line, "MOTOR");
  assert.equal(lead.answers.motor.vehicle_category, "COMMERCIAL_VEHICLE");
  assert.equal(lead.answers.motor.registration_number, "KDD 456Z");
  assert.equal(lead.answers.motor.vehicle_value_kes, 250000);
  assert.equal(lead.answers.motor.lipa_pole_pole_requested, true);
  assert.equal(lead.answers.quote_status, "REFERRED");
  assert.equal(lead.answers.documents.length, 2);
  const detail = (await (await j(`/v1/leads/${lead.lead_id}`, { token: admin })).json()) as any;
  assert.equal(detail.documents.length, 2); // adviser sees the received documents
});

test("WhatsApp: resume unfinished application, then talk to adviser", async () => {
  const me = "254711000003"; const admin = (await login()).body.token;
  for (const t of ["Hi", "I agree", "Peter Otieno", "Home insurance", "Not sure yet", "House I own"]) await waSend(me, { text: t });
  assert.match(lastReplyTo(me), /Approximate value/);
  await waSend(me, { text: "Hi" }); // customer disappears and returns
  assert.match(lastReplyTo(me), /Welcome back/);
  await waSend(me, { text: "Continue" });
  assert.match(lastReplyTo(me), /Approximate value/);
  await waSend(me, { text: "adviser" });
  assert.match(lastReplyTo(me), /passed your details to an adviser/);
  const lead = (await leads(admin)).find((l) => l.contact_phone === me);
  assert.equal(lead.answers.handoff_reason, "CUSTOMER_REQUESTED_ADVISER");
  assert.equal(lead.answers["Q-003"], "House I own"); // adviser doesn't have to re-ask
});

test("WhatsApp: handoff or decline before consent stores nothing", async () => {
  const admin = (await login()).body.token; const before = (await leads(admin)).length;
  await waSend("254711000004", { text: "Hi" }); await waSend("254711000004", { text: "adviser" });
  assert.match(lastReplyTo("254711000004"), /wa\.me\/254724888057/);
  await waSend("254711000005", { text: "Hi" }); await waSend("254711000005", { text: "No" });
  assert.equal((await leads(admin)).length, before);
});

// ======================================================================= INTEGRATION HONESTY + WEBHOOKS
test("payments / policy issuance / Lami are honestly unavailable, never faked", async () => {
  const admin = (await login()).body.token;
  for (const p of ["/v1/payments", "/v1/policies/issue"]) {
    const r = await j(p, { method: "POST", token: admin, json: {} });
    assert.equal(r.status, 501); assert.match(JSON.stringify(await r.json()), /CONTRACT REQUIRED/);
  }
  assert.equal((await j("/v1/payments", { method: "POST", json: {} })).status, 401);
  assert.equal((await j("/v1/webhooks/lami", { method: "POST", json: {} })).status, 501);
});

test("payment webhook: signature required, idempotent", async () => {
  const raw = JSON.stringify({ event_id: "evt-1", status: "SUCCESS" });
  const good = createHmac("sha256", PAY_SECRET).update(raw).digest("hex");
  assert.equal((await fetch(BASE + "/v1/webhooks/payment", { method: "POST", body: raw, headers: { "x-signature": "00" } })).status, 401);
  const first = (await (await fetch(BASE + "/v1/webhooks/payment", { method: "POST", body: raw, headers: { "x-signature": good } })).json()) as any;
  const second = (await (await fetch(BASE + "/v1/webhooks/payment", { method: "POST", body: raw, headers: { "x-signature": good } })).json()) as any;
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
});

test("login is rate limited", async () => {
  await stopServer(); await startServer({ LOGIN_RATE_MAX: "5" });
  let last = 0;
  for (let i = 0; i < 14; i++) last = (await login(ADMIN.email, "wrong-wrong-wrong")).status;
  assert.equal(last, 429);
});

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import type { NotificationAdapter } from "./adapters/notification-adapter.ts";
import { CloudWhatsAppAdapter } from "./adapters/whatsapp-adapter.ts";
import { lamiAdapter, paymentAdapter, NotConfiguredError } from "./adapters/insurer-adapter.ts";
import { runQuote } from "./rules/quote-service.ts";
import { submitLead } from "./lead-service.ts";
import { LEAD_LINES } from "./flows.ts";
import { config } from "./config.ts";
import { hashPassword, verifyPassword, signToken, verifyToken, rateLimited, type TokenClaims, type Role } from "./auth.ts";
import { getFlows, effectiveProducts, validateConfig, activeConfig, KINDS } from "./config-admin.ts";
import { createClaim, claimStatusFor, CLAIM_STATUSES } from "./claims-service.ts";
import { addRenewal, validateRenewal, parseCsv, runRenewalReminders, RENEWAL_STATUSES, type Renewal } from "./renewals.ts";
import { computeFunnel } from "./analytics.ts";
import { catalogue } from "./catalogue.ts";
import { randomUUID } from "node:crypto";
import { handleInbound } from "./whatsapp/engine.ts";
import { parseCloudWebhook, verifyCloudSignature } from "./whatsapp/webhook.ts";
import type { QuoteRequestInput, LeadInput, ProductLine } from "./domain/types.ts";

const PRODUCT_LINES: ProductLine[] = ["MOTOR", "MEDICAL", "WIBA", "LIFE", "HOME", "TRAVEL", "PENSION_ANNUITIES", "GENERAL"];
const MAX_BODY = 1_000_000;
const DUMMY_HASH = hashPassword("not-a-real-password"); // equalises login timing for unknown emails

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message?: string) { super(message ?? code); this.status = status; this.code = code; }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
const parseJson = (raw: Buffer) => { if (!raw.length) return {}; try { return JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "INVALID_JSON"); } };

function clientIp(req: IncomingMessage) { return (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.socket.remoteAddress || "unknown"; }

function requireAuth(req: IncomingMessage, roles: Role[] = ["ADMIN", "ADVISER"]): TokenClaims {
  const h = req.headers.authorization ?? "";
  const claims = h.startsWith("Bearer ") ? verifyToken(h.slice(7)) : null;
  if (!claims) throw new HttpError(401, "UNAUTHENTICATED");
  if (!roles.includes(claims.role)) throw new HttpError(403, "FORBIDDEN");
  return claims;
}

export function createHandler(repo: SqliteRepository, notifier: NotificationAdapter) {
  const wa = new CloudWhatsAppAdapter();

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const ip = clientIp(req);

    if (method === "OPTIONS") return send(res, 204, {});

    // ---------------- public ----------------
    if (path === "/health" && method === "GET") return send(res, 200, { status: "ok", service: "kenya-insurance-api", time: new Date().toISOString() });
    if (path === "/v1/products" && method === "GET") {
      const cls = url.searchParams.get("class");
      let products = effectiveProducts(repo).filter((p) => p.enquiry_enabled);
      if (cls) products = products.filter((p) => p.class === cls);
      return send(res, 200, { products, classes: catalogue.classes.map((c) => c.name), generated_from: catalogue.source });
    }
    if (path === "/v1/flows" && method === "GET") return send(res, 200, getFlows(repo));
    if (path === "/v1/learn" && method === "GET") {
      const cfg = activeConfig(repo);
      return send(res, 200, { classes: catalogue.classes.map((c) => ({ name: c.name, product_count: c.product_ids.length, intro: cfg.get(`content:learn.${c.name}`)?.value.intro ?? null })) });
    }
    if (path === "/v1/config/public" && method === "GET") return send(res, 200, { owner_whatsapp: config.ownerWhatsApp });

    // Lightweight funnel events from the web client (no auth: pure counters, no PII, rate limited).
    if (path === "/v1/events" && method === "POST") {
      if (rateLimited(`event:${ip}`, 120, 60_000)) throw new HttpError(429, "RATE_LIMITED");
      const b = parseJson(await readRaw(req));
      const allowed = ["WEB_ENQUIRY_STARTED", "WEB_CONTACT_STEP"];
      if (!allowed.includes(b.type) || typeof b.attempt !== "string") throw new HttpError(400, "INVALID_EVENT");
      await repo.recordEvent({ type: b.type, channel: "WEB", line: typeof b.line === "string" ? b.line.slice(0, 40) : undefined, attempt: b.attempt.slice(0, 80) });
      return send(res, 202, { ok: true });
    }

    // ---------------- claims (first notice of loss — recording only, never a coverage decision) ----------------
    if (path === "/v1/claims" && method === "POST") {
      if (rateLimited(`claim:${ip}`, 10, 60_000)) throw new HttpError(429, "RATE_LIMITED");
      const b = parseJson(await readRaw(req));
      if (!b.contact_name || !b.contact_phone || !b.answers || b.consent_given !== true) throw new HttpError(400, "MISSING_REQUIRED_FIELD", "required: contact_name, contact_phone, answers, consent_given");
      const consent = { version: config.consentVersion, at: new Date().toISOString(), channel: "WEB", purpose: "claim notification follow-up", ip_hint: ip };
      const { claim, evidence, whatsapp, email } = await createClaim(repo, notifier, { contact_name: b.contact_name, contact_phone: b.contact_phone, contact_email: b.contact_email, answers: b.answers, source_channel: "WEB", consent });
      return send(res, 201, { claim_ref: claim.claim_ref, evidence, owner_notification: { whatsapp: whatsapp.detail, email: email.detail } });
    }
    if (path === "/v1/claims/status" && method === "GET") {
      const ref = url.searchParams.get("ref"), phone = url.searchParams.get("phone");
      if (!ref || !phone) throw new HttpError(400, "REF_AND_PHONE_REQUIRED");
      const st = claimStatusFor(repo, ref, phone);
      if (!st) throw new HttpError(404, "CLAIM_NOT_FOUND");
      return send(res, 200, st);
    }
    if (path === "/v1/claims" && method === "GET") {
      requireAuth(req);
      let claims = repo.listDocs<any>("claim").sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const st = url.searchParams.get("status"); if (st) claims = claims.filter((c) => c.status === st);
      return send(res, 200, { claims });
    }
    const claimMatch = path.match(/^\/v1\/claims\/([^/]+)$/);
    if (claimMatch && claimMatch[1] !== "status" && method === "PATCH") {
      const c = requireAuth(req);
      const claim = repo.getDoc<any>("claim", claimMatch[1]); if (!claim) throw new HttpError(404, "CLAIM_NOT_FOUND");
      const b = parseJson(await readRaw(req));
      if (b.status !== undefined) { if (!CLAIM_STATUSES.includes(b.status)) throw new HttpError(400, "INVALID_STATUS"); claim.status = b.status; }
      if (b.assigned_to !== undefined) claim.assigned_to = b.assigned_to;
      repo.putDoc("claim", claim.claim_id, claim);
      await repo.audit(c.email, "CLAIM_UPDATED", claim.claim_id, b);
      return send(res, 200, claim);
    }

    // ---------------- renewals ----------------
    if (path === "/v1/renewals" && method === "GET") {
      requireAuth(req);
      let rs = repo.listDocs<Renewal>("renewal").sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : 1));
      const st = url.searchParams.get("status"); if (st) rs = rs.filter((r) => r.status === st);
      return send(res, 200, { renewals: rs });
    }
    if (path === "/v1/renewals" && method === "POST") {
      const c = requireAuth(req);
      const b = parseJson(await readRaw(req));
      const err = validateRenewal(b); if (err) throw new HttpError(400, "INVALID_RENEWAL", err);
      const r = addRenewal(repo, b, c.email, "MANUAL");
      await repo.audit(c.email, "RENEWAL_ADDED", r.renewal_id, { customer: r.customer_name, expiry: r.expiry_date });
      return send(res, 201, r);
    }
    if (path === "/v1/renewals/import" && method === "POST") {
      const c = requireAuth(req, ["ADMIN", "ADVISER"]);
      const raw = await readRaw(req);
      const rows = parseCsv(raw.toString("utf8"));
      if (!rows.length) throw new HttpError(400, "EMPTY_OR_INVALID_CSV", "Expected a header row: customer_name,customer_phone,customer_email,product_name,insurer,policy_number,expiry_date,premium_kes,reminders_consent,notes");
      const created: string[] = []; const errors: { row: number; error: string }[] = [];
      rows.forEach((row, i) => { const err = validateRenewal(row); if (err) errors.push({ row: i + 2, error: err }); else created.push(addRenewal(repo, row, c.email, "CSV").renewal_id); });
      await repo.audit(c.email, "RENEWAL_CSV_IMPORTED", undefined, { created: created.length, errors: errors.length });
      return send(res, 200, { created: created.length, errors });
    }
    const renewalMatch = path.match(/^\/v1\/renewals\/([^/]+)$/);
    if (renewalMatch && method === "PATCH") {
      const c = requireAuth(req);
      const r = repo.getDoc<Renewal>("renewal", renewalMatch[1]); if (!r) throw new HttpError(404, "RENEWAL_NOT_FOUND");
      const b = parseJson(await readRaw(req));
      if (b.status !== undefined) { if (!RENEWAL_STATUSES.includes(b.status)) throw new HttpError(400, "INVALID_STATUS"); r.status = b.status; }
      if (b.notes !== undefined) r.notes = b.notes;
      if (b.expiry_date !== undefined) r.expiry_date = b.expiry_date;
      repo.putDoc("renewal", r.renewal_id, r);
      await repo.audit(c.email, "RENEWAL_UPDATED", r.renewal_id, b);
      return send(res, 200, r);
    }
    if (path === "/v1/renewals/run-reminders" && method === "POST") {
      const secretOk = config.renewalCronSecret && req.headers["x-cron-secret"] === config.renewalCronSecret;
      const claims = secretOk ? null : requireAuth(req, ["ADMIN"]);
      const result = await runRenewalReminders(repo, notifier, wa);
      await repo.audit(claims?.email ?? "cron", "RENEWAL_REMINDERS_RUN", undefined, { checked: result.checked, reminders: result.reminders.length });
      return send(res, 200, result);
    }

    // ---------------- analytics ----------------
    if (path === "/v1/analytics/funnel" && method === "GET") {
      requireAuth(req);
      const days = Math.min(180, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
      return send(res, 200, await computeFunnel(repo, days));
    }

    // ---------------- admin: approval-controlled configuration (products/flows/rules/templates/content) ----------------
    if (path === "/v1/admin/config" && method === "GET") {
      requireAuth(req, ["ADMIN"]);
      return send(res, 200, { versions: repo.cfgList(url.searchParams.get("kind") || undefined, url.searchParams.get("key") || undefined) });
    }
    if (path === "/v1/admin/config" && method === "POST") {
      const c = requireAuth(req, ["ADMIN"]);
      const b = parseJson(await readRaw(req));
      if (!b.kind || !b.key) throw new HttpError(400, "KIND_AND_KEY_REQUIRED", `kind must be one of ${KINDS.join(", ")}`);
      const err = validateConfig(b.kind, b.key, b.value); if (err) throw new HttpError(400, "INVALID_CONFIG", err);
      const v = repo.cfgInsert({ kind: b.kind, key: b.key, value: b.value, effective_from: b.effective_from ?? null, note: b.note, created_by: c.email });
      await repo.audit(c.email, "CONFIG_DRAFTED", v.id, { kind: v.kind, key: v.key, version: v.version });
      return send(res, 201, v);
    }
    const cfgMatch = path.match(/^\/v1\/admin\/config\/([^/]+)\/(submit|approve|reject|rollback)$/);
    if (cfgMatch && method === "POST") {
      const c = requireAuth(req, ["ADMIN"]);
      const v = repo.cfgGet(cfgMatch[1]); if (!v) throw new HttpError(404, "CONFIG_VERSION_NOT_FOUND");
      const action = cfgMatch[2];
      if (action === "submit") {
        if (v.status !== "DRAFT") throw new HttpError(409, "NOT_DRAFT");
        const updated = repo.cfgUpdate(v.id, { status: "SUBMITTED", submitted_at: new Date().toISOString() });
        await repo.audit(c.email, "CONFIG_SUBMITTED", v.id); return send(res, 200, updated);
      }
      if (action === "approve") {
        if (v.status !== "SUBMITTED") throw new HttpError(409, "NOT_SUBMITTED");
        if (v.created_by === c.email) throw new HttpError(403, "MAKER_CHECKER_VIOLATION", "A different admin must approve this change.");
        const updated = repo.cfgUpdate(v.id, { status: "APPROVED", decided_by: c.email, decided_at: new Date().toISOString() });
        await repo.audit(c.email, "CONFIG_APPROVED", v.id, { kind: v.kind, key: v.key, version: v.version });
        return send(res, 200, updated);
      }
      if (action === "reject") {
        if (v.status !== "SUBMITTED") throw new HttpError(409, "NOT_SUBMITTED");
        const b = parseJson(await readRaw(req));
        const updated = repo.cfgUpdate(v.id, { status: "REJECTED", decided_by: c.email, decided_at: new Date().toISOString(), decision_note: b.note ?? null });
        await repo.audit(c.email, "CONFIG_REJECTED", v.id, { note: b.note }); return send(res, 200, updated);
      }
      if (action === "rollback") {
        if (v.status !== "APPROVED") throw new HttpError(409, "NOT_APPROVED", "Can only roll back to a previously approved version.");
        const nv = repo.cfgInsert({ kind: v.kind, key: v.key, value: v.value, note: `Rollback to v${v.version}`, created_by: c.email, rollback_of: v.version });
        await repo.audit(c.email, "CONFIG_ROLLBACK_DRAFTED", nv.id, { rollback_of: v.version });
        return send(res, 201, nv);
      }
    }

    if (path === "/api/v1/needs/assessments" && method === "POST") {
      if (rateLimited(`assess:${ip}`, 30, 60_000)) throw new HttpError(429, "RATE_LIMITED");
      return send(res, 201, await repo.createNeedsAssessment());
    }
    const answerMatch = path.match(/^\/api\/v1\/needs\/assessments\/([^/]+)\/answers$/);
    if (answerMatch && method === "POST") {
      const body = parseJson(await readRaw(req));
      try { return send(res, 200, await repo.saveAssessmentAnswer(answerMatch[1], String(body.question_id), body.value)); }
      catch { throw new HttpError(404, "ASSESSMENT_NOT_FOUND"); }
    }

    if (path === "/v1/quotes/decide" && method === "POST") {
      if (rateLimited(`quote:${ip}`, 20, 60_000)) throw new HttpError(429, "RATE_LIMITED");
      const body = parseJson(await readRaw(req)) as Partial<QuoteRequestInput> & { contact_name?: string; contact_phone?: string; consent_given?: boolean };
      if (!body.product_id || !body.vehicle_category || !body.cover_type || !body.duration) {
        throw new HttpError(400, "MISSING_REQUIRED_FIELD", "required: product_id, vehicle_category, usage_type, cover_type, duration");
      }
      const { quote, trace } = await runQuote(repo, body as QuoteRequestInput, "WEB");
      let owner_notification: unknown;
      if (quote.status === "REFERRED" && body.contact_name && body.contact_phone && body.consent_given === true) {
        // Every referral becomes a MOTOR lead in the adviser inbox and alerts the owner.
        const { whatsapp, email } = await submitLead(repo, notifier, {
          product_line: "MOTOR", contact_name: body.contact_name, contact_phone: body.contact_phone, consent_given: true, source_channel: "WEB",
          answers: { quote_id: quote.quote_id, decision_id: trace.decision_id, reasons: trace.reason_codes, request: { product_id: body.product_id, vehicle_category: body.vehicle_category, usage_type: body.usage_type, cover_type: body.cover_type, duration: body.duration, vehicle_value_kes: body.vehicle_value_kes },
            _consent: { version: config.consentVersion, at: new Date().toISOString(), channel: "WEB", purpose: "insurance quotation follow-up" } },
        });
        owner_notification = { whatsapp: whatsapp.detail, email: email.detail };
      }
      return send(res, 200, { quote, decision_trace_id: trace.decision_id, owner_notification });
    }

    if (path === "/v1/leads" && method === "POST") {
      if (rateLimited(`lead:${ip}`, 10, 60_000)) throw new HttpError(429, "RATE_LIMITED");
      const body = parseJson(await readRaw(req)) as Partial<LeadInput>;
      if (!body.product_line || !PRODUCT_LINES.includes(body.product_line) || !body.contact_name || !body.contact_phone) {
        throw new HttpError(400, "MISSING_REQUIRED_FIELD", "required: product_line, contact_name, contact_phone, consent_given");
      }
      if (body.consent_given !== true) throw new HttpError(400, "CONSENT_REQUIRED", "Consent is required before we can record and forward your details.");
      const answers = { ...(body.answers ?? {}), _consent: { version: config.consentVersion, at: new Date().toISOString(), channel: "WEB", purpose: "insurance enquiry follow-up", ip_hint: ip } };
      const { lead, whatsapp, email } = await submitLead(repo, notifier, { ...(body as LeadInput), answers, source_channel: "WEB" });
      return send(res, 201, { lead_id: lead.lead_id, owner_notification: { whatsapp: whatsapp.detail, email: email.detail } });
    }

    // ---------------- auth ----------------
    if (path === "/v1/auth/login" && method === "POST") {
      if (rateLimited(`login:${ip}`, config.loginRateMax, 15 * 60_000)) throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
      const { email, password } = parseJson(await readRaw(req));
      const user = typeof email === "string" ? await repo.getStaffByEmail(email) : null;
      const ok = verifyPassword(String(password ?? ""), user?.password_hash ?? DUMMY_HASH) && !!user && user.active;
      await repo.audit(String(email ?? "unknown"), ok ? "LOGIN_OK" : "LOGIN_FAILED", undefined, { ip });
      if (!ok || !user) throw new HttpError(401, "INVALID_CREDENTIALS");
      return send(res, 200, { token: signToken({ sub: user.user_id, email: user.email, role: user.role }), user: { email: user.email, name: user.name, role: user.role }, expires_in: config.tokenTtlSeconds });
    }
    if (path === "/v1/auth/me" && method === "GET") { const c = requireAuth(req); return send(res, 200, { email: c.email, role: c.role }); }

    // ---------------- staff: lead inbox ----------------
    if (path === "/v1/leads" && method === "GET") {
      requireAuth(req);
      let leads = await repo.listLeads();
      const st = url.searchParams.get("status"), line = url.searchParams.get("line");
      if (st) leads = leads.filter((l) => l.status === st);
      if (line) leads = leads.filter((l) => l.product_line === line);
      return send(res, 200, { leads });
    }
    const leadMatch = path.match(/^\/v1\/leads\/([^/]+)(\/notes)?$/);
    if (leadMatch) {
      const c = requireAuth(req);
      const lead = await repo.getLead(leadMatch[1]);
      if (!lead) throw new HttpError(404, "LEAD_NOT_FOUND");
      if (!leadMatch[2] && method === "GET") {
        await repo.audit(c.email, "LEAD_VIEWED", lead.lead_id);
        return send(res, 200, { lead, notes: await repo.listLeadNotes(lead.lead_id), documents: await repo.listDocumentsFor(lead.contact_phone.replace(/\D/g, "").replace(/^0/, "254")) });
      }
      if (!leadMatch[2] && method === "PATCH") {
        const b = parseJson(await readRaw(req));
        const patch: any = {};
        if (b.status !== undefined) { if (!["NEW", "NOTIFIED", "IN_REVIEW", "CLOSED"].includes(b.status)) throw new HttpError(400, "INVALID_STATUS"); patch.status = b.status; }
        if (b.assigned_to !== undefined) patch.assigned_to = b.assigned_to === null ? null : String(b.assigned_to).slice(0, 120);
        const updated = await repo.updateLead(lead.lead_id, patch);
        await repo.audit(c.email, "LEAD_UPDATED", lead.lead_id, patch);
        if (patch.status) await repo.recordEvent({ type: "LEAD_STATUS_CHANGED", ref: lead.lead_id, detail: { status: patch.status, by: c.email } });
        return send(res, 200, updated);
      }
      if (leadMatch[2] && method === "POST") {
        const b = parseJson(await readRaw(req));
        if (!b.text || typeof b.text !== "string") throw new HttpError(400, "TEXT_REQUIRED");
        const note = await repo.addLeadNote(lead.lead_id, c.email, b.text.slice(0, 2000));
        await repo.audit(c.email, "LEAD_NOTE_ADDED", lead.lead_id);
        return send(res, 201, note);
      }
    }
    const decisionMatch = path.match(/^\/v1\/decisions\/([^/]+)$/);
    if (decisionMatch && method === "GET") {
      requireAuth(req);
      const t = await repo.getDecisionTrace(decisionMatch[1]);
      if (!t) throw new HttpError(404, "DECISION_NOT_FOUND");
      return send(res, 200, t);
    }

    // ---------------- admin ----------------
    if (path === "/v1/admin/users" && method === "GET") { requireAuth(req, ["ADMIN"]); return send(res, 200, { users: await repo.listStaff() }); }
    if (path === "/v1/admin/users" && method === "POST") {
      const c = requireAuth(req, ["ADMIN"]);
      const b = parseJson(await readRaw(req));
      if (!b.email || !b.name || typeof b.password !== "string" || b.password.length < 12) throw new HttpError(400, "INVALID_USER", "email, name and a password of at least 12 characters are required");
      if (!["ADMIN", "ADVISER"].includes(b.role)) throw new HttpError(400, "INVALID_ROLE");
      if (await repo.getStaffByEmail(b.email)) throw new HttpError(409, "EMAIL_EXISTS");
      const u = await repo.createStaff({ email: b.email, name: b.name, role: b.role, password_hash: hashPassword(b.password) });
      await repo.audit(c.email, "STAFF_CREATED", u.user_id, { email: u.email, role: u.role });
      return send(res, 201, { user_id: u.user_id, email: u.email, role: u.role });
    }
    if (path === "/v1/admin/audit" && method === "GET") { requireAuth(req, ["ADMIN"]); return send(res, 200, { audit: await repo.listAudit(200) }); }

    // ---------------- WhatsApp ----------------
    if ((path === "/v1/whatsapp/webhook" || path === "/v1/whatsapp/messages/inbound") && method === "GET") {
      // Meta subscription handshake
      const ok = url.searchParams.get("hub.mode") === "subscribe" && config.wa.verifyToken && url.searchParams.get("hub.verify_token") === config.wa.verifyToken;
      if (!ok) throw new HttpError(403, "VERIFY_FAILED");
      res.writeHead(200, { "Content-Type": "text/plain" }); return void res.end(url.searchParams.get("hub.challenge") ?? "");
    }
    if ((path === "/v1/whatsapp/webhook" || path === "/v1/whatsapp/messages/inbound") && method === "POST") {
      const raw = await readRaw(req);
      if (config.wa.appSecret) {
        if (!verifyCloudSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, config.wa.appSecret)) throw new HttpError(401, "BAD_SIGNATURE");
      } else if (!config.allowUnsignedWebhooks) {
        throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED", "Set WHATSAPP_APP_SECRET (signature verification is mandatory).");
      }
      const inbound = parseCloudWebhook(parseJson(raw));
      for (const m of inbound) {
        try {
          const replies = await handleInbound({ repo, notifier }, m);
          for (const r of replies) { await repo.recordOutbound(m.waId, r.text); await wa.send(m.waId, r); }
        } catch (e) { await repo.audit("system", "WEBHOOK_MESSAGE_ERROR", m.messageId, { error: (e as Error).message }); }
      }
      return send(res, 200, { received: inbound.length }); // always 2xx once authenticated, so the provider doesn't retry-storm
    }

    // ---------------- integrations that need external contracts ----------------
    if ((path === "/v1/payments" || path === "/v1/policies/issue") && method === "POST") {
      requireAuth(req);
      try { if (path === "/v1/payments") await paymentAdapter.initiate(parseJson(await readRaw(req))); else await lamiAdapter.issuePolicy({}); }
      catch (e) { if (e instanceof NotConfiguredError) throw new HttpError(501, "NOT_CONFIGURED", e.message); throw e; }
    }
    if (path === "/v1/webhooks/payment" && method === "POST") {
      const raw = await readRaw(req);
      if (!config.paymentWebhookSecret) throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED", "EXTERNAL PROVIDER CONTRACT REQUIRED: set PAYMENT_WEBHOOK_SECRET once a payment provider is chosen.");
      const given = Buffer.from(String(req.headers["x-signature"] ?? ""), "hex");
      const expected = createHmac("sha256", config.paymentWebhookSecret).update(raw).digest();
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, "BAD_SIGNATURE");
      const body = parseJson(raw);
      const eventId = String(body.event_id ?? body.id ?? "");
      if (!eventId) throw new HttpError(400, "EVENT_ID_REQUIRED");
      const fresh = await repo.recordWebhookOnce(eventId, "payment", raw.toString("utf8"));
      return send(res, 200, { received: true, duplicate: !fresh, note: "Recorded only. Reconciliation/issuance are not wired until the provider contract exists." });
    }
    if ((path === "/v1/webhooks/lami" || path === "/v1/webhooks/insurer") && method === "POST") {
      throw new HttpError(501, "NOT_CONFIGURED", "LAMI CONTRACT REQUIRED: webhook schema and signature scheme not yet supplied.");
    }

    throw new HttpError(404, "NOT_FOUND", path);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    try { await route(req, res); }
    catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message === e.code ? undefined : e.message });
      console.error("Unhandled error:", e);
      return send(res, 500, { error: "INTERNAL_ERROR" });
    }
  };
}

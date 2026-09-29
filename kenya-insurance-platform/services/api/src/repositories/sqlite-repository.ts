import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { InMemoryRepository } from "./repository.ts";
import type { Lead, LeadInput, LeadNote, NeedsAssessment, Quote, QuoteRequestInput, DecisionTrace, StaffUser } from "../domain/types.ts";

export interface WaSession { wa_id: string; state: string; data: Record<string, any>; updated_at: string }

/**
 * Persistent repository on Node's built-in SQLite (no external dependency; works offline).
 * Product/rate/charge reference data still comes from the seed in InMemoryRepository.
 * Production target remains PostgreSQL (db/migrations/*.sql): implement the same methods there.
 * Records are stored as JSON documents keyed by kind+id so nothing is lost on restart.
 */
export class SqliteRepository extends InMemoryRepository {
  db: DatabaseSync;

  constructor(path: string) {
    super();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS staff_users (user_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lead_notes (note_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wa_messages (message_id TEXT PRIMARY KEY, wa_id TEXT NOT NULL, direction TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wa_sessions (wa_id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (document_id TEXT PRIMARY KEY, wa_id TEXT, doc_type TEXT NOT NULL, provider_media_id TEXT, mime TEXT, status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, channel TEXT, line TEXT, attempt TEXT, state TEXT, ref TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);
      CREATE TABLE IF NOT EXISTS config_versions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL,
        effective_from TEXT, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT, rollback_of INTEGER,
        UNIQUE(kind, key, version));
      CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL);
    `);
  }

  private put(kind: string, id: string, obj: unknown) {
    this.db.prepare("INSERT INTO docs (kind,id,json,created_at) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json").run(kind, id, JSON.stringify(obj), new Date().toISOString());
  }
  private get<T>(kind: string, id: string): T | null {
    const row = this.db.prepare("SELECT json FROM docs WHERE kind=? AND id=?").get(kind, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  // ---- needs assessments ----
  override async createNeedsAssessment() {
    const a = await super.createNeedsAssessment();
    this.put("assessment", a.assessment_id, a);
    return a;
  }
  override async saveAssessmentAnswer(id: string, q: string, value: unknown) {
    const a = this.get<NeedsAssessment>("assessment", id);
    if (!a) throw new Error("NOT_FOUND");
    a.answers[q] = value;
    this.put("assessment", id, a);
    return a;
  }

  // ---- quotes & decision traces ----
  override async createQuote(input: QuoteRequestInput) {
    const q = await super.createQuote(input);
    this.put("quote", q.quote_id, q);
    return q;
  }
  override async getQuote(id: string) { return this.get<Quote>("quote", id); }
  override async updateQuote(q: Quote) { this.put("quote", q.quote_id, q); }
  override async saveDecisionTrace(t: Omit<DecisionTrace, "decision_id" | "executed_at">) {
    const full = await super.saveDecisionTrace(t);
    this.put("trace", full.decision_id, full);
    return full;
  }
  override async getDecisionTrace(id: string) { return this.get<DecisionTrace>("trace", id); }

  // ---- leads ----
  override async createLead(input: LeadInput) {
    const lead = await super.createLead(input);
    this.put("lead", lead.lead_id, lead);
    return lead;
  }
  override async markLeadNotified(id: string) {
    const l = this.get<Lead>("lead", id);
    if (l && l.status === "NEW") { l.status = "NOTIFIED"; this.put("lead", id, l); }
  }
  override async listLeads() {
    const rows = this.db.prepare("SELECT json FROM docs WHERE kind='lead'").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Lead).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  async getLead(id: string) { return this.get<Lead>("lead", id); }
  async updateLead(id: string, patch: Partial<Pick<Lead, "status" | "assigned_to">>) {
    const l = this.get<Lead>("lead", id);
    if (!l) return null;
    Object.assign(l, patch);
    this.put("lead", id, l);
    return l;
  }
  async addLeadNote(lead_id: string, author: string, text: string): Promise<LeadNote> {
    const n: LeadNote = { note_id: randomUUID(), lead_id, author, text, created_at: new Date().toISOString() };
    this.db.prepare("INSERT INTO lead_notes VALUES (?,?,?,?,?)").run(n.note_id, lead_id, author, text, n.created_at);
    return n;
  }
  async listLeadNotes(lead_id: string) {
    return this.db.prepare("SELECT * FROM lead_notes WHERE lead_id=? ORDER BY created_at").all(lead_id) as unknown as LeadNote[];
  }

  // ---- staff users ----
  async countStaff() { return (this.db.prepare("SELECT COUNT(*) c FROM staff_users").get() as { c: number }).c; }
  async createStaff(u: Omit<StaffUser, "user_id" | "created_at" | "active">) {
    const user: StaffUser = { ...u, user_id: randomUUID(), active: true, created_at: new Date().toISOString() };
    this.db.prepare("INSERT INTO staff_users VALUES (?,?,?,?,?,?,?)").run(user.user_id, user.email.toLowerCase(), user.name, user.role, user.password_hash, 1, user.created_at);
    return user;
  }
  async getStaffByEmail(email: string) {
    const r = this.db.prepare("SELECT * FROM staff_users WHERE email=?").get(email.toLowerCase()) as any;
    return r ? ({ ...r, active: !!r.active } as StaffUser) : null;
  }
  async listStaff() {
    return (this.db.prepare("SELECT user_id,email,name,role,active,created_at FROM staff_users").all() as any[]).map((r) => ({ ...r, active: !!r.active }));
  }

  // ---- WhatsApp: dedupe, sessions, documents ----
  /** Returns true if the message id is new (and records it); false if it was already processed. */
  async recordInboundOnce(messageId: string, waId: string, body: string) {
    const r = this.db.prepare("INSERT OR IGNORE INTO wa_messages VALUES (?,?,?,?,?)").run(messageId, waId, "IN", body, new Date().toISOString());
    return Number(r.changes) === 1;
  }
  async recordOutbound(waId: string, body: string) {
    this.db.prepare("INSERT INTO wa_messages VALUES (?,?,?,?,?)").run("out-" + randomUUID(), waId, "OUT", body, new Date().toISOString());
  }
  async getSession(waId: string): Promise<WaSession | null> {
    const r = this.db.prepare("SELECT * FROM wa_sessions WHERE wa_id=?").get(waId) as any;
    return r ? { wa_id: r.wa_id, state: r.state, data: JSON.parse(r.data), updated_at: r.updated_at } : null;
  }
  async saveSession(s: { wa_id: string; state: string; data: Record<string, any> }) {
    this.db.prepare("INSERT INTO wa_sessions VALUES (?,?,?,?) ON CONFLICT(wa_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at")
      .run(s.wa_id, s.state, JSON.stringify(s.data), new Date().toISOString());
  }
  async saveDocument(d: { wa_id: string; doc_type: string; provider_media_id?: string; mime?: string; status: string; note?: string }) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)").run(id, d.wa_id, d.doc_type, d.provider_media_id ?? null, d.mime ?? null, d.status, d.note ?? null, new Date().toISOString());
    return id;
  }
  async listDocumentsFor(waId: string) {
    return this.db.prepare("SELECT * FROM documents WHERE wa_id=? ORDER BY created_at").all(waId) as any[];
  }

  // ---- webhooks (idempotent) & audit ----
  async recordWebhookOnce(eventId: string, source: string, payload: string) {
    const r = this.db.prepare("INSERT OR IGNORE INTO webhook_events VALUES (?,?,?,?)").run(eventId, source, payload, new Date().toISOString());
    return Number(r.changes) === 1;
  }
  async audit(actor: string, action: string, target?: string, detail?: unknown) {
    this.db.prepare("INSERT INTO audit_log VALUES (?,?,?,?,?,?)").run(randomUUID(), actor, action, target ?? null, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }
  async listAudit(limit = 100) {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?").all(limit) as any[];
  }

  // ---- generic document helpers (claims, renewals, reminders) ----
  putDoc(kind: string, id: string, obj: unknown) { this.put(kind, id, obj); }
  getDoc<T>(kind: string, id: string): T | null { return this.get<T>(kind, id); }
  listDocs<T>(kind: string): T[] {
    return (this.db.prepare("SELECT json FROM docs WHERE kind=?").all(kind) as { json: string }[]).map((r) => JSON.parse(r.json) as T);
  }

  // ---- analytics events (no PII: attempts are random ids) ----
  async recordEvent(e: { type: string; channel?: string; line?: string; attempt?: string; state?: string; ref?: string; detail?: unknown; at?: string }) {
    this.db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), e.at ?? new Date().toISOString(), e.type, e.channel ?? null, e.line ?? null, e.attempt ?? null, e.state ?? null, e.ref ?? null, e.detail ? JSON.stringify(e.detail) : null);
  }
  async listEvents(sinceIso: string) {
    return this.db.prepare("SELECT * FROM events WHERE at >= ? ORDER BY at").all(sinceIso) as any[];
  }

  // ---- versioned, approval-controlled configuration ----
  cfgInsert(c: { kind: string; key: string; value: unknown; effective_from?: string | null; note?: string; created_by: string; rollback_of?: number }) {
    const next = ((this.db.prepare("SELECT MAX(version) v FROM config_versions WHERE kind=? AND key=?").get(c.kind, c.key) as any).v ?? 0) + 1;
    const id = randomUUID();
    this.db.prepare("INSERT INTO config_versions (id,kind,key,version,value,status,effective_from,note,created_by,created_at,rollback_of) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, c.kind, c.key, next, JSON.stringify(c.value), "DRAFT", c.effective_from ?? null, c.note ?? null, c.created_by, new Date().toISOString(), c.rollback_of ?? null);
    return this.cfgGet(id)!;
  }
  cfgGet(id: string) { const r = this.db.prepare("SELECT * FROM config_versions WHERE id=?").get(id) as any; return r ? { ...r, value: JSON.parse(r.value) } : null; }
  cfgList(kind?: string, key?: string) {
    const rows = this.db.prepare("SELECT * FROM config_versions WHERE (? IS NULL OR kind=?) AND (? IS NULL OR key=?) ORDER BY created_at DESC").all(kind ?? null, kind ?? null, key ?? null, key ?? null) as any[];
    return rows.map((r) => ({ ...r, value: JSON.parse(r.value) }));
  }
  cfgUpdate(id: string, patch: Record<string, unknown>) {
    const cols = Object.keys(patch);
    this.db.prepare(`UPDATE config_versions SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`).run(...cols.map((c) => (c === "value" ? JSON.stringify(patch[c]) : (patch[c] as any))), id);
    return this.cfgGet(id)!;
  }
  /** Active = highest APPROVED version whose effective_from has passed (or is unset). */
  cfgActive(nowIso = new Date().toISOString()) {
    const rows = this.db.prepare("SELECT * FROM config_versions WHERE status='APPROVED' AND (effective_from IS NULL OR effective_from <= ?) ORDER BY version").all(nowIso) as any[];
    const map = new Map<string, any>();
    for (const r of rows) map.set(`${r.kind}:${r.key}`, { ...r, value: JSON.parse(r.value) });
    return map;
  }
}

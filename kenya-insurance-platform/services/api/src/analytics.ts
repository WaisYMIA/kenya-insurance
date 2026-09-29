import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import type { Claim } from "./claims-service.ts";
import type { Renewal } from "./renewals.ts";
import { nairobiToday, daysUntil } from "./renewals.ts";

const WA_STAGES = [
  { key: "STARTED", label: "Started a conversation", states: ["CONSENT_PENDING"] },
  { key: "CONSENTED", label: "Gave consent", states: ["NAME_PENDING"] },
  { key: "NAMED", label: "Gave their name", states: ["LINE_SELECTION"] },
  { key: "LINE_CHOSEN", label: "Chose a cover / claim", states: ["Q_ASKING", "MOTOR_CATEGORY", "CLASS_SELECT"] },
  { key: "COMPLETED", label: "Completed and sent to an adviser", states: ["SUBMITTED"] },
];
const TERMINAL = ["SUBMITTED", "MANUAL_REVIEW", "ABANDONED", "ERROR"];
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Raw counts only — nothing is smoothed, hidden or estimated. Small numbers are small numbers. */
export async function computeFunnel(repo: SqliteRepository, days = 30, abandonHours = 24, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const events = await repo.listEvents(since);

  // ---- WhatsApp: distinct attempts reaching each stage
  const wa = events.filter((e) => e.type === "WA_STATE" && e.attempt);
  const attemptsByState = new Map<string, Set<string>>();
  const lastByAttempt = new Map<string, { state: string; at: string; line?: string }>();
  for (const e of wa) {
    if (!attemptsByState.has(e.state)) attemptsByState.set(e.state, new Set());
    attemptsByState.get(e.state)!.add(e.attempt);
    lastByAttempt.set(e.attempt, { state: e.state, at: e.at, line: e.line });
  }
  const reached = (states: string[]) => { const set = new Set<string>(); for (const st of states) for (const a of attemptsByState.get(st) ?? []) set.add(a); return set; };
  const stages = WA_STAGES.map((s) => ({ key: s.key, label: s.label, count: reached(s.states).size, pct_of_previous: null as number | null, pct_of_start: null as number | null }));
  stages.forEach((s, i) => { s.pct_of_previous = i ? pct(s.count, stages[i - 1].count) : null; s.pct_of_start = pct(s.count, stages[0].count); });
  const cutoff = now.getTime() - abandonHours * 3_600_000;
  let abandoned = 0, inProgress = 0;
  for (const l of lastByAttempt.values()) { if (TERMINAL.includes(l.state)) continue; if (Date.parse(l.at) < cutoff) abandoned++; else inProgress++; }
  const byState = [...attemptsByState.entries()].map(([state, set]) => ({ state, attempts: set.size })).sort((a, b) => b.attempts - a.attempts);
  const handoffs = attemptsByState.get("MANUAL_REVIEW")?.size ?? 0;
  const byLine: Record<string, { started: number; completed: number }> = {};
  for (const [a, l] of lastByAttempt) { /* line per attempt = latest seen line */ }
  const lineOf = new Map<string, string>(); for (const e of wa) if (e.line) lineOf.set(e.attempt, e.line);
  for (const a of attemptsByState.get("SUBMITTED") ?? []) { const l = lineOf.get(a) ?? "UNKNOWN"; (byLine[l] ??= { started: 0, completed: 0 }).completed++; }
  for (const a of reached(["Q_ASKING", "MOTOR_CATEGORY", "CLASS_SELECT"])) { const l = lineOf.get(a) ?? "UNKNOWN"; (byLine[l] ??= { started: 0, completed: 0 }).started++; }

  // ---- Web
  const webStarted = new Set(events.filter((e) => e.type === "WEB_ENQUIRY_STARTED").map((e) => e.attempt));
  const webContact = new Set(events.filter((e) => e.type === "WEB_CONTACT_STEP").map((e) => e.attempt));
  const webSubmitted = events.filter((e) => e.type === "LEAD_SUBMITTED" && e.channel === "WEB").length;

  // ---- Leads
  const leads = (await repo.listLeads()).filter((l) => l.created_at >= since);
  const tally = (f: (l: any) => string) => leads.reduce((m: Record<string, number>, l) => ((m[f(l)] = (m[f(l)] ?? 0) + 1), m), {});
  const firstTouch: number[] = [];
  const changes = events.filter((e) => e.type === "LEAD_STATUS_CHANGED");
  for (const l of leads) { const c = changes.find((e) => e.ref === l.lead_id); if (c) firstTouch.push(Math.max(0, Math.round((Date.parse(c.at) - Date.parse(l.created_at)) / 60000))); }

  // ---- Claims, renewals, motor
  const claims = repo.listDocs<Claim>("claim").filter((c) => c.created_at >= since);
  const today = nairobiToday(now);
  const renewals = repo.listDocs<Renewal>("renewal").filter((r) => r.status === "ACTIVE");
  const dd = renewals.map((r) => daysUntil(r.expiry_date, today));
  const mq = events.filter((e) => e.type === "MOTOR_QUOTE_REQUESTED");
  const motorByCat: Record<string, number> = {};
  for (const e of mq) { const c = (e.detail ? JSON.parse(e.detail).vehicle_category : "UNKNOWN") ?? "UNKNOWN"; motorByCat[c] = (motorByCat[c] ?? 0) + 1; }

  return {
    period_days: days, since, generated_at: now.toISOString(),
    whatsapp: { stages, in_progress: inProgress, abandoned: abandoned, abandon_after_hours: abandonHours, adviser_handoffs: handoffs, by_line: byLine, drop_off_by_state: byState },
    web: { enquiries_started: webStarted.size, reached_contact_step: webContact.size, submitted: webSubmitted, note: "Web submitted counts all web leads in the period; it is not a strict cohort of the started sessions." },
    leads: { total: leads.length, by_line: tally((l) => l.product_line), by_status: tally((l) => l.status), by_channel: tally((l) => l.source_channel), median_minutes_to_first_action: median(firstTouch), with_first_action: firstTouch.length },
    claims: { total: claims.length, urgent: claims.filter((c) => c.priority === "URGENT").length, by_status: claims.reduce((m: Record<string, number>, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {}) },
    renewals: { active: renewals.length, overdue: dd.filter((d) => d < 0).length, due_within_30_days: dd.filter((d) => d >= 0 && d <= 30).length },
    motor: { quote_requests: mq.length, by_vehicle_category: motorByCat, referred: events.filter((e) => e.type === "MOTOR_QUOTE_REFERRED").length },
  };
}

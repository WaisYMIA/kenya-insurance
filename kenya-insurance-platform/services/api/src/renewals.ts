import { randomUUID } from "node:crypto";
import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import type { NotificationAdapter } from "./adapters/notification-adapter.ts";
import type { WhatsAppAdapter } from "./adapters/whatsapp-adapter.ts";
import { activeTemplateName } from "./config-admin.ts";
import { normalizeKenyanNumber } from "./config.ts";

/**
 * Renewal register + reminders. Policies are not issued through this platform yet, so the register is fed by
 * advisers (single entry or CSV import of their existing book). Reminders go to the OWNER as a digest with tap-to-chat links.
 * A reminder goes to the customer ONLY if (a) the record says they consented to renewal reminders AND (b) an approved
 * WhatsApp template has been configured (Admin -> template 'renewal_reminder'). Renewal terms are never auto-quoted:
 * V3 REN-001 requires re-rating and adviser referral, so the reminder tells you to request renewal terms.
 */
export interface Renewal {
  renewal_id: string; customer_name: string; customer_phone: string; customer_email?: string; product_name: string; product_id?: string;
  insurer?: string; policy_number?: string; expiry_date: string; premium_kes?: number; reminders_consent: boolean;
  status: "ACTIVE" | "RENEWED" | "LAPSED" | "CANCELLED"; notes?: string; source: "MANUAL" | "CSV"; created_by: string; created_at: string;
}
export const RENEWAL_STATUSES = ["ACTIVE", "RENEWED", "LAPSED", "CANCELLED"];
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

/** CONFIGURATION: reminder thresholds in days before expiry (env RENEWAL_REMINDER_DAYS). 0 = expiry day / overdue is always included. */
export function reminderDays(): number[] {
  const d = (process.env.RENEWAL_REMINDER_DAYS ?? "30,14,7").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set([...d, 0])].sort((a, b) => a - b);
}
export const nairobiToday = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
export const daysUntil = (expiry: string, today: string) => Math.round((Date.parse(expiry + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);

export function validateRenewal(r: any): string | null {
  if (!r.customer_name || typeof r.customer_name !== "string") return "customer_name required";
  if (!r.customer_phone || normalizeKenyanNumber(String(r.customer_phone)).length < 11) return "valid customer_phone required";
  if (!r.product_name) return "product_name required";
  if (!r.expiry_date || !isDate(String(r.expiry_date))) return "expiry_date must be YYYY-MM-DD";
  if (r.premium_kes !== undefined && r.premium_kes !== "" && !(Number(r.premium_kes) >= 0)) return "premium_kes must be a number";
  return null;
}

export function addRenewal(repo: SqliteRepository, input: any, createdBy: string, source: "MANUAL" | "CSV"): Renewal {
  const r: Renewal = {
    renewal_id: randomUUID(), customer_name: String(input.customer_name).trim(), customer_phone: String(input.customer_phone).trim(),
    customer_email: input.customer_email || undefined, product_name: String(input.product_name).trim(), product_id: input.product_id || undefined,
    insurer: input.insurer || undefined, policy_number: input.policy_number || undefined, expiry_date: String(input.expiry_date),
    premium_kes: input.premium_kes === undefined || input.premium_kes === "" ? undefined : Number(input.premium_kes),
    reminders_consent: input.reminders_consent === true || /^(true|yes|y|1)$/i.test(String(input.reminders_consent ?? "")),
    status: "ACTIVE", notes: input.notes || undefined, source, created_by: createdBy, created_at: new Date().toISOString(),
  };
  repo.putDoc("renewal", r.renewal_id, r);
  return r;
}

/** Minimal CSV parser (quoted fields supported). Header row required. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export async function runRenewalReminders(repo: SqliteRepository, notifier: NotificationAdapter, wa: WhatsAppAdapter, asOf = nairobiToday()) {
  const thresholds = reminderDays();
  const renewals = repo.listDocs<Renewal>("renewal").filter((r) => r.status === "ACTIVE");
  const due: { r: Renewal; days: number; t: number }[] = [];
  for (const r of renewals) {
    const days = daysUntil(r.expiry_date, asOf);
    const t = thresholds.find((th) => days <= th); // smallest threshold already reached
    if (t === undefined) continue;
    if (repo.getDoc("renewal_reminder", `${r.renewal_id}:${t}`)) continue;
    due.push({ r, days, t });
  }
  due.sort((a, b) => a.days - b.days);
  let customerSent = 0;
  const tpl = activeTemplateName(repo, "renewal_reminder");
  for (const { r, days, t } of due) {
    let toCustomer = false;
    if (r.reminders_consent && tpl && wa.sendTemplate) {
      const res = await wa.sendTemplate(normalizeKenyanNumber(r.customer_phone), tpl, [r.customer_name, r.product_name, r.expiry_date]);
      toCustomer = res.sent; if (toCustomer) customerSent++;
    }
    for (const th of thresholds.filter((x) => x >= t)) repo.putDoc("renewal_reminder", `${r.renewal_id}:${th}`, { sent_at: new Date().toISOString(), days, to_customer: toCustomer });
    await repo.recordEvent({ type: "RENEWAL_REMINDER", ref: r.renewal_id, detail: { days, threshold: t, to_customer: toCustomer } });
  }
  if (due.length) {
    const lines = due.map(({ r, days }) => `- ${r.customer_name} | ${r.product_name}${r.policy_number ? " #" + r.policy_number : ""} | ${days < 0 ? `OVERDUE ${-days}d` : days === 0 ? "expires TODAY" : `expires in ${days}d`} (${r.expiry_date}) | https://wa.me/${normalizeKenyanNumber(r.customer_phone)}`);
    const msg = `RENEWALS DUE (${due.length})\n${lines.join("\n")}\nRequest renewal terms from the insurer — renewals must be re-rated, not auto-renewed.`;
    await Promise.all([notifier.notifyOwnerWhatsApp(msg), notifier.notifyOwnerEmail(`Renewals due (${due.length})`, msg)]);
  }
  return { as_of: asOf, checked: renewals.length, reminders: due.map(({ r, days, t }) => ({ renewal_id: r.renewal_id, customer: r.customer_name, days, threshold: t })), customer_messages_sent: customerSent, customer_template_configured: !!tpl };
}

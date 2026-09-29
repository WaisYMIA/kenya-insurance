import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import type { NotificationAdapter } from "./adapters/notification-adapter.ts";
import type { LeadInput, Lead } from "./domain/types.ts";
import { normalizeKenyanNumber } from "./config.ts";
import { effectiveProducts } from "./config-admin.ts";
import { LINE_PRODUCTS, productById } from "./catalogue.ts";

/** Resolve the ontology product the customer said they were interested in (adds product_id / product_class to answers). */
export function enrichAnswers(repo: SqliteRepository, line: string, answers: Record<string, unknown>) {
  const named = answers["Q-PRODUCT"];
  if (typeof named === "string" && LINE_PRODUCTS[line]) {
    const hit = effectiveProducts(repo).find((p) => LINE_PRODUCTS[line].includes(p.product_id) && p.name === named);
    if (hit) return { ...answers, product_id: hit.product_id, product_class: hit.class };
  }
  const pid = answers.product_id;
  if (typeof pid === "string" && productById.has(pid) && !answers.product_class) return { ...answers, product_class: productById.get(pid)!.class };
  return answers;
}

export function formatLeadMessage(lead: Lead) {
  const answerLines = Object.entries(lead.answers)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  const consent = (lead.answers as any)._consent;
  return `NEW ${lead.product_line} LEAD (${lead.lead_id.slice(0, 8)})\nName: ${lead.contact_name}\nPhone: ${lead.contact_phone}\nEmail: ${lead.contact_email ?? "n/a"}\nChannel: ${lead.source_channel ?? "WEB"}\nChat: https://wa.me/${normalizeKenyanNumber(lead.contact_phone)}\n${(lead.answers as any).product_id ? `Product interest: ${(lead.answers as any).product_id} (${(lead.answers as any).product_class})\n` : ""}${answerLines}${consent ? `\nConsent: ${consent.version} @ ${consent.at}` : ""}`;
}

/** Creates a lead, alerts the owner on WhatsApp + email, and marks NOTIFIED only if an alert was really delivered. */
export async function submitLead(repo: SqliteRepository, notifier: NotificationAdapter, input: LeadInput) {
  const lead = await repo.createLead({ ...input, answers: enrichAnswers(repo, input.product_line, input.answers) });
  await repo.audit("system", "LEAD_CREATED", lead.lead_id, { line: lead.product_line, channel: lead.source_channel });
  await repo.recordEvent({ type: "LEAD_SUBMITTED", channel: lead.source_channel, line: lead.product_line, ref: lead.lead_id });
  const msg = formatLeadMessage(lead);
  const [w, e] = await Promise.all([
    notifier.notifyOwnerWhatsApp(msg),
    notifier.notifyOwnerEmail(`New ${lead.product_line} lead: ${lead.contact_name}`, msg),
  ]);
  if (w.sent || e.sent) await repo.markLeadNotified(lead.lead_id);
  return { lead, whatsapp: w, email: e };
}

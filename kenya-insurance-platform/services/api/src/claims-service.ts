import { randomUUID, randomInt } from "node:crypto";
import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import type { NotificationAdapter } from "./adapters/notification-adapter.ts";
import { claimEvidenceFor } from "./catalogue.ts";
import { normalizeKenyanNumber } from "./config.ts";

/**
 * Claim FIRST NOTICE OF LOSS intake. This records what the customer reports and alerts a human.
 * It never decides cover or liability (master brief §34/§60): status is only NEW / ACKNOWLEDGED / IN_REVIEW / CLOSED.
 */
export interface Claim {
  claim_id: string; claim_ref: string; status: "NEW" | "ACKNOWLEDGED" | "IN_REVIEW" | "CLOSED"; priority: "URGENT" | "NORMAL";
  contact_name: string; contact_phone: string; contact_email?: string;
  cover_area: string; policy_number: string; incident_date: string; location: string; description: string; injuries: boolean; police_ref: string;
  answers: Record<string, unknown>; source_channel: "WEB" | "WHATSAPP"; assigned_to?: string | null; created_at: string;
}
export const CLAIM_STATUSES = ["NEW", "ACKNOWLEDGED", "IN_REVIEW", "CLOSED"];

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no look-alike characters
const newRef = () => "CL-" + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

export function formatClaimMessage(c: Claim) {
  return `${c.priority === "URGENT" ? "⚠️ URGENT — INJURY REPORTED\n" : ""}NEW CLAIM NOTICE ${c.claim_ref}\nName: ${c.contact_name}\nPhone: ${c.contact_phone}\nChat: https://wa.me/${normalizeKenyanNumber(c.contact_phone)}\nArea: ${c.cover_area}\nPolicy no: ${c.policy_number}\nWhen: ${c.incident_date}\nWhere: ${c.location}\nWhat happened: ${c.description}\nInjuries: ${c.injuries ? "YES" : "No"}\nPolice/OB: ${c.police_ref}\nChannel: ${c.source_channel}`;
}

export async function createClaim(repo: SqliteRepository, notifier: NotificationAdapter, input: {
  contact_name: string; contact_phone: string; contact_email?: string; answers: Record<string, any>; source_channel: "WEB" | "WHATSAPP"; consent: unknown;
}) {
  const a = input.answers;
  let ref = newRef();
  while (repo.listDocs<Claim>("claim").some((c) => c.claim_ref === ref)) ref = newRef();
  const injuries = /^y/i.test(String(a["Q-C6"] ?? ""));
  const claim: Claim = {
    claim_id: randomUUID(), claim_ref: ref, status: "NEW", priority: injuries ? "URGENT" : "NORMAL",
    contact_name: input.contact_name, contact_phone: input.contact_phone, contact_email: input.contact_email,
    cover_area: String(a["Q-C1"] ?? "Other"), policy_number: String(a["Q-C2"] ?? "unknown"), incident_date: String(a["Q-C3"] ?? ""),
    location: String(a["Q-C4"] ?? ""), description: String(a["Q-C5"] ?? ""), injuries, police_ref: String(a["Q-C7"] ?? "none"),
    answers: { ...a, _consent: input.consent }, source_channel: input.source_channel, created_at: new Date().toISOString(),
  };
  repo.putDoc("claim", claim.claim_id, claim);
  await repo.audit("system", "CLAIM_REPORTED", claim.claim_id, { ref, priority: claim.priority, channel: claim.source_channel });
  await repo.recordEvent({ type: "CLAIM_REPORTED", channel: claim.source_channel, line: claim.cover_area, ref: claim.claim_id });
  const msg = formatClaimMessage(claim);
  const [whatsapp, email] = await Promise.all([notifier.notifyOwnerWhatsApp(msg), notifier.notifyOwnerEmail(`${claim.priority === "URGENT" ? "URGENT " : ""}Claim notice ${claim.claim_ref}: ${claim.contact_name}`, msg)]);
  return { claim, evidence: claimEvidenceFor(claim.cover_area), whatsapp, email };
}

export function claimStatusFor(repo: SqliteRepository, ref: string, phone: string) {
  const c = repo.listDocs<Claim>("claim").find((x) => x.claim_ref === ref.trim().toUpperCase() && normalizeKenyanNumber(x.contact_phone) === normalizeKenyanNumber(phone));
  if (!c) return null;
  const label: Record<string, string> = { NEW: "Received — an adviser will contact you", ACKNOWLEDGED: "Acknowledged by our team", IN_REVIEW: "Being handled by an adviser", CLOSED: "Closed" };
  return { claim_ref: c.claim_ref, status: label[c.status], reported_at: c.created_at };
}

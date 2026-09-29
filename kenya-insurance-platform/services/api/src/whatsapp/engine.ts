import type { SqliteRepository, WaSession } from "../repositories/sqlite-repository.ts";
import type { NotificationAdapter } from "../adapters/notification-adapter.ts";
import type { OutboundMessage } from "../adapters/whatsapp-adapter.ts";
import { ocrAdapter } from "../adapters/insurer-adapter.ts";
import { runQuote } from "../rules/quote-service.ts";
import { getFlows } from "../config-admin.ts";
import { createClaim } from "../claims-service.ts";
import { claimEvidenceFor } from "../catalogue.ts";
import { randomUUID } from "node:crypto";
import { submitLead } from "../lead-service.ts";
import { config } from "../config.ts";
import { LEAD_LINES, CLAIM_FLOW, MOTOR_CATEGORIES, MOTOR_USAGE, MOTOR_COVER, MOTOR_DURATION } from "../flows.ts";
import type { LeadInput, QuoteRequestInput } from "../domain/types.ts";

export interface Inbound {
  waId: string;
  messageId: string;
  type: "text" | "choice" | "media" | "other";
  text?: string;
  mediaId?: string;
  mime?: string;
}
export interface EngineDeps { repo: SqliteRepository; notifier: NotificationAdapter }

/** Explicit state machine (master brief §22). Any move not listed here is rejected. */
export const TRANSITIONS: Record<string, string[]> = {
  NEW: ["CONSENT_PENDING"],
  CONSENT_PENDING: ["NAME_PENDING", "ABANDONED"],
  NAME_PENDING: ["LINE_SELECTION"],
  LINE_SELECTION: ["Q_ASKING", "MOTOR_CATEGORY", "CLASS_SELECT"],
  CLASS_SELECT: ["PRODUCT_SELECT"],
  PRODUCT_SELECT: ["Q_ASKING"],
  Q_ASKING: ["Q_ASKING", "SUBMITTED"],
  MOTOR_CATEGORY: ["MOTOR_USAGE"],
  MOTOR_USAGE: ["MOTOR_COVER"],
  MOTOR_COVER: ["MOTOR_DURATION"],
  MOTOR_DURATION: ["MOTOR_VALUE", "MOTOR_REG"],
  MOTOR_VALUE: ["MOTOR_REG"],
  MOTOR_REG: ["MOTOR_MAKE"],
  MOTOR_MAKE: ["DOC_ID"],
  DOC_ID: ["DOC_LOGBOOK"],
  DOC_LOGBOOK: ["FINANCE"],
  FINANCE: ["SUBMITTED", "MANUAL_REVIEW"],
  RESUME_PENDING: ["CONSENT_PENDING", "NAME_PENDING", "LINE_SELECTION", "CLASS_SELECT", "PRODUCT_SELECT", "Q_ASKING", "MOTOR_CATEGORY", "MOTOR_USAGE", "MOTOR_COVER", "MOTOR_DURATION", "MOTOR_VALUE", "MOTOR_REG", "MOTOR_MAKE", "DOC_ID", "DOC_LOGBOOK", "FINANCE", "NEW"],
  SUBMITTED: ["NEW"],
  MANUAL_REVIEW: ["NEW"],
  ABANDONED: ["NEW"],
  ERROR: ["NEW"],
};
const TERMINAL = ["SUBMITTED", "MANUAL_REVIEW", "ABANDONED", "ERROR"];
// Handoff to an adviser is allowed from every active state.
const HANDOFF_FROM = (s: string) => !TERMINAL.includes(s) && s !== "NEW";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

class InvalidTransition extends Error {}

function move(s: WaSession, to: string) {
  if (s.state === to && to === "Q_ASKING") return;
  const allowed = TRANSITIONS[s.state] ?? [];
  if (!allowed.includes(to)) throw new InvalidTransition(`${s.state} -> ${to}`);
  s.state = to;
}

const yes = (t = "") => /^(yes|y|ndio|agree|i agree|ok|okay)\b/i.test(t.trim());
const no = (t = "") => /^(no|n|hapana|decline)\b/i.test(t.trim());
// WhatsApp truncates button titles to 20 chars and list rows to 24 (with an ellipsis), and replies with the
// TRUNCATED title, so matching must accept the truncated form as well as the full option text.
const tr = (o: string, n: number) => (o.length > n ? o.slice(0, n - 1) + "…" : o);
function pick(text: string | undefined, options: string[]): string | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  const exact = options.find((o) => o.toLowerCase() === t || tr(o, 24).toLowerCase() === t || tr(o, 20).toLowerCase() === t);
  if (exact) return exact;
  return options.find((o) => o.toLowerCase().startsWith(t) && t.length >= 3) ?? null;
}

const LINE_MENU = ["Motor insurance", ...Object.values(LEAD_LINES).map((l) => l.label), CLAIM_FLOW.label];
const lineKeys = Object.keys(LEAD_LINES);
const ownerChat = () => `https://wa.me/${config.ownerWhatsApp}`;

// ------------------------------------------------------------------ prompts
function prompt(s: WaSession): OutboundMessage[] {
  const d = s.data;
  switch (s.state) {
    case "CONSENT_PENDING":
      return [{ text: `Before we start, please review our privacy notice (${config.privacyNoticeUrl}). Do you agree that we may use the information you share to prepare quotations and let an adviser contact you?`, options: ["I agree", "No"] }];
    case "NAME_PENDING": return [{ text: "What is your full name?" }];
    case "LINE_SELECTION": return [{ text: "What would you like cover for?", options: LINE_MENU }];
    case "CLASS_SELECT": return [{ text: "What kind of cover are you looking for?", options: d.classNames }];
    case "PRODUCT_SELECT": return [{ text: `Which ${d.className} cover are you interested in?`, options: [...d.productChoices.map((p: any) => p.name), "Not sure yet"] }];
    case "Q_ASKING": {
      const q = d.qs[d.qIndex];
      return [{ text: `(${d.qIndex + 1}/${d.qs.length}) ${q.text}`, options: q.type === "choice" ? q.options : undefined }];
    }
    case "MOTOR_CATEGORY": return [{ text: "What type of vehicle are you insuring?", options: Object.keys(MOTOR_CATEGORIES) }];
    case "MOTOR_USAGE": return [{ text: "How is it used?", options: Object.keys(MOTOR_USAGE) }];
    case "MOTOR_COVER": return [{ text: "Which cover would you like?", options: Object.keys(MOTOR_COVER) }];
    case "MOTOR_DURATION": return [{ text: "How long would you like the cover?", options: Object.keys(MOTOR_DURATION) }];
    case "MOTOR_VALUE": return [{ text: "What is the current value of the vehicle in KES? (e.g. 150000)" }];
    case "MOTOR_REG": return [{ text: "What is the registration number? (e.g. KXX 123X)" }];
    case "MOTOR_MAKE": return [{ text: "What is the make and model? (e.g. Bajaj Boxer 150)" }];
    case "DOC_ID": return [{ text: "Please send a clear photo of the front of your ID. (Type SKIP if you'd rather give it to the adviser later.)" }];
    case "DOC_LOGBOOK": return [{ text: "Now please send a clear photo or PDF of the vehicle logbook. (Type SKIP to do this later.)" }];
    case "FINANCE": return [{ text: "Would you like to request a Lipa Pole Pole payment option? (Financing is assessed separately from your insurance quote.)", options: ["Yes", "No"] }];
    case "RESUME_PENDING": return [{ text: "Welcome back. You have an unfinished application. Would you like to continue?", options: ["Continue", "Start again", "Talk to adviser"] }];
    default: return [{ text: "Hi! I can help you with insurance. Reply START to begin, or ADVISER to talk to a person.", options: ["Start", "Talk to adviser"] }];
  }
}
const reprompt = (s: WaSession, why: string): OutboundMessage[] => [{ text: why }, ...prompt(s)];


// ------------------------------------------------------------------ completion
async function finishLead(deps: EngineDeps, s: WaSession, reason?: string): Promise<OutboundMessage[]> {
  const d = s.data;
  const answers: Record<string, unknown> = { ...(d.answers ?? {}), _consent: d.consent };
  if (reason) answers.handoff_reason = reason;
  answers.conversation_state_at_submit = s.state;
  if (d.motor) answers.motor = d.motor;
  if (d.docs) answers.documents = d.docs;
  if (d.docsSkipped) answers.documents_skipped = d.docsSkipped;
  const line = d.line === "MOTOR" ? "MOTOR" : d.line ?? "GENERAL";
  let customerMsg: OutboundMessage[];

  if (d.line === "CLAIM") {
    // Claim first-notice: recorded and routed to a human. Never decides cover or liability.
    const { claim, evidence } = await createClaim(deps.repo, deps.notifier, { contact_name: d.name ?? "WhatsApp customer", contact_phone: s.wa_id, answers: d.answers ?? {}, source_channel: "WHATSAPP", consent: d.consent });
    const list = evidence.slice(0, 6).map((e) => `• ${e.evidence}`).join("\n");
    const out: OutboundMessage[] = [{ text: `Your claim notice is recorded. Reference: ${claim.claim_ref}. An adviser will contact you shortly — this is not a decision on your claim.` }];
    if (claim.priority === "URGENT") out.push({ text: "If anyone needs urgent medical help, please call emergency services now (999 / 112)." });
    if (list) out.push({ text: `Please have these ready:\n${list}` });
    return out;
  }

  if (line === "MOTOR" && d.motor && !reason) {
    const m = d.motor;
    const input: QuoteRequestInput & { contact_name?: string } = {
      product_id: m.cover_type === "COMPREHENSIVE" ? "MOT-COMP-001" : "MOT-TP-001",
      vehicle_category: m.vehicle_category, usage_type: m.usage_type, cover_type: m.cover_type,
      duration: m.duration, vehicle_value_kes: m.vehicle_value_kes,
    };
    const { quote, trace } = await runQuote(deps.repo, input, "WHATSAPP");
    Object.assign(answers, { motor: m, quote_id: quote.quote_id, quote_status: quote.status, decision_id: trace.decision_id, decision_reasons: trace.reason_codes, documents_review_required: !!d.docsReview });
    customerMsg = quote.status === "QUOTED" && quote.premium_kes != null
      ? [{ text: `Your quote is ready. Premium: KES ${quote.premium_kes}. An adviser will confirm the total payable, charges and next steps.` }]
      : [{ text: "Thank you. Your application needs a quick review before we can provide a final quote. An adviser will assist you shortly." }];
  } else {
    customerMsg = [{ text: reason ? "No problem — I've passed your details to an adviser who will contact you shortly." : "Thank you! Your details have been sent to an adviser, who will contact you shortly." }];
  }

  const input: LeadInput = { product_line: line as LeadInput["product_line"], contact_name: d.name ?? "WhatsApp customer", contact_phone: s.wa_id, answers, consent_given: true, source_channel: "WHATSAPP" };
  await submitLead(deps.repo, deps.notifier, input);
  return customerMsg;
}

async function handoff(deps: EngineDeps, s: WaSession, reason: string): Promise<OutboundMessage[]> {
  if (!s.data.consent) {
    // No consent captured yet: store nothing, give the customer a direct line instead.
    return [{ text: `You can chat with an adviser directly here: ${ownerChat()}` }];
  }
  const msgs = await finishLead(deps, s, reason);
  s.state = "MANUAL_REVIEW"; // adviser handoff is legal from every active state (HANDOFF_FROM)
  return msgs;
}

// ------------------------------------------------------------------ main entry
const locks = new Map<string, Promise<unknown>>();

/** Serialises processing per customer so rapid/duplicate messages can't interleave. */
export function handleInbound(deps: EngineDeps, msg: Inbound): Promise<OutboundMessage[]> {
  const prev = locks.get(msg.waId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => process(deps, msg));
  locks.set(msg.waId, run);
  return run.finally(() => { if (locks.get(msg.waId) === run) locks.delete(msg.waId); });
}

async function process(deps: EngineDeps, msg: Inbound): Promise<OutboundMessage[]> {
  const { repo } = deps;
  const fresh = await repo.recordInboundOnce(msg.messageId, msg.waId, msg.text ?? `[${msg.type}]`);
  if (!fresh) return []; // duplicate delivery: never create a second lead/quote/document

  let s = (await repo.getSession(msg.waId)) ?? { wa_id: msg.waId, state: "NEW", data: {}, updated_at: "" };
  const prevState = s.state;
  try {
    const out = await step(deps, s, msg);
    if (s.state !== prevState && s.state !== "RESUME_PENDING" && s.data.attemptId) {
      await repo.recordEvent({ type: "WA_STATE", channel: "WHATSAPP", line: s.data.line, attempt: s.data.attemptId, state: s.state });
    }
    await repo.saveSession(s);
    return out;
  } catch (e) {
    // Never leave the customer stuck or bombard them: log, hand to an adviser, keep the session recoverable.
    await repo.audit("system", "CONVERSATION_ERROR", msg.waId, { error: (e as Error).message, state: s.state });
    s = (await repo.getSession(msg.waId)) ?? s;
    return [{ text: `Sorry, something went wrong on our side. An adviser can help you directly: ${ownerChat()}` }];
  }
}

async function step(deps: EngineDeps, s: WaSession, m: Inbound): Promise<OutboundMessage[]> {
  const d = s.data;
  const text = (m.text ?? "").trim();

  // ---- global commands
  if (/^(adviser|advisor|agent|human|talk to (an? )?(adviser|advisor|agent))\b/i.test(text)) {
    if (HANDOFF_FROM(s.state)) return handoff(deps, s, "CUSTOMER_REQUESTED_ADVISER");
    return [{ text: `You can chat with an adviser directly here: ${ownerChat()}` }];
  }
  if (/^(restart|start again|menu)$/i.test(text) && s.state !== "RESUME_PENDING") {
    s.data = {}; s.state = "NEW"; // explicit customer command: abandon the draft and begin again
    return begin(s);
  }

  const greeting = /^(hi|hello|hey|habari|jambo|start|good (morning|afternoon|evening))\b/i.test(text);

  // ---- returning customer with an unfinished application (master brief §23)
  if (greeting && s.state !== "NEW" && !TERMINAL.includes(s.state) && s.state !== "RESUME_PENDING") {
    d.resumeState = s.state; s.state = "RESUME_PENDING"; // pseudo-state: remembers where to continue
    return prompt(s);
  }

  // ---- NEW / terminal states
  if (s.state === "NEW" || TERMINAL.includes(s.state)) {
    if (s.state === "SUBMITTED" || s.state === "MANUAL_REVIEW") {
      if (!greeting) return [{ text: `Your request has been passed to an adviser and they'll contact you. To start another application, type HI. Or chat directly: ${ownerChat()}` }];
    }
    if (s.state !== "NEW") move(s, "NEW");
    return begin(s);
  }

  // ---- resume
  if (s.state === "RESUME_PENDING") {
    const c = pick(text, ["Continue", "Start again", "Talk to adviser"]);
    if (c === "Continue") { move(s, d.resumeState); delete d.resumeState; return prompt(s); }
    if (c === "Start again") { s.data = {}; s.state = "NEW"; return begin(s); }
    if (c === "Talk to adviser") { s.state = d.resumeState; return handoff(deps, s, "CUSTOMER_REQUESTED_ADVISER"); }
    return reprompt(s, "Please choose Continue, Start again or Talk to adviser.");
  }

  switch (s.state) {
    case "CONSENT_PENDING": {
      if (yes(text) || /^i agree/i.test(text)) {
        d.consent = { version: config.consentVersion, at: new Date().toISOString(), channel: "WHATSAPP", message_id: m.messageId, purpose: "insurance onboarding and quotation" };
        await deps.repo.audit(s.wa_id, "CONSENT_GIVEN", s.wa_id, d.consent);
        move(s, "NAME_PENDING"); return prompt(s);
      }
      if (no(text)) { move(s, "ABANDONED"); return [{ text: `No problem — we haven't stored anything. You can chat with an adviser here: ${ownerChat()}` }]; }
      return reprompt(s, "Please reply I agree or No.");
    }
    case "NAME_PENDING": {
      if (text.length < 3 || /^\d+$/.test(text)) return reprompt(s, "Please type your full name.");
      d.name = text.slice(0, 120); move(s, "LINE_SELECTION"); return prompt(s);
    }
    case "LINE_SELECTION": {
      const c = pick(text, LINE_MENU);
      if (!c) return reprompt(s, "Please choose one of the options.");
      const flows = getFlows(deps.repo);
      d.answers = {};
      if (c === "Motor insurance") { d.line = "MOTOR"; d.motor = {}; move(s, "MOTOR_CATEGORY"); return prompt(s); }
      if (c === CLAIM_FLOW.label) { d.line = "CLAIM"; d.qs = flows.claim.qs; d.qIndex = 0; move(s, "Q_ASKING"); return prompt(s); }
      d.line = lineKeys.find((k) => LEAD_LINES[k].label === c)!;
      if (d.line === "GENERAL") { d.classNames = flows.general.classes.map((x) => x.name); move(s, "CLASS_SELECT"); return prompt(s); }
      d.qs = flows.lines[d.line].qs; d.qIndex = 0; move(s, "Q_ASKING"); return prompt(s);
    }
    case "CLASS_SELECT": {
      const c = pick(text, d.classNames); if (!c) return reprompt(s, "Please choose one of the options.");
      const cls = getFlows(deps.repo).general.classes.find((x) => x.name === c);
      d.className = c; d.productChoices = (cls?.products ?? []).slice(0, 9).map((p) => ({ product_id: p.product_id, name: p.name }));
      d.answers["product_class"] = c; move(s, "PRODUCT_SELECT"); return prompt(s);
    }
    case "PRODUCT_SELECT": {
      const names = [...d.productChoices.map((p: any) => p.name), "Not sure yet"];
      const c = pick(text, names); if (!c) return reprompt(s, "Please choose one of the options.");
      const flows2 = getFlows(deps.repo).general;
      const chosen = d.productChoices.find((p: any) => p.name === c);
      if (chosen) {
        d.answers["Q-PRODUCT"] = c; d.answers["product_id"] = chosen.product_id;
        d.qs = flows2.classes.find((x) => x.name === d.className)!.products.find((p) => p.product_id === chosen.product_id)!.questions;
      } else { d.answers["Q-PRODUCT"] = "Not sure yet"; d.qs = flows2.fallback_questions; }
      d.qIndex = 0; move(s, "Q_ASKING"); return prompt(s);
    }
    case "Q_ASKING": {
      const q = d.qs[d.qIndex];
      let val: string | null = text;
      if (q.type === "choice") { val = pick(text, q.options!); if (!val) return reprompt(s, "Please choose one of the options."); }
      else if (!text) return reprompt(s, "Please type your answer.");
      d.answers[q.id] = val.slice(0, 500); d.qIndex++;
      if (d.qIndex >= d.qs.length) {
        const out = await finishLead(deps, s); move(s, "SUBMITTED"); return out;
      }
      move(s, "Q_ASKING"); return prompt(s);
    }
    case "MOTOR_CATEGORY": {
      const c = pick(text, Object.keys(MOTOR_CATEGORIES)); if (!c) return reprompt(s, "Please choose one of the options.");
      d.motor.vehicle_category = MOTOR_CATEGORIES[c]; move(s, "MOTOR_USAGE"); return prompt(s);
    }
    case "MOTOR_USAGE": {
      const c = pick(text, Object.keys(MOTOR_USAGE)); if (!c) return reprompt(s, "Please choose one of the options.");
      d.motor.usage_type = MOTOR_USAGE[c]; move(s, "MOTOR_COVER"); return prompt(s);
    }
    case "MOTOR_COVER": {
      const c = pick(text, Object.keys(MOTOR_COVER)); if (!c) return reprompt(s, "Please choose one of the options.");
      d.motor.cover_type = MOTOR_COVER[c]; move(s, "MOTOR_DURATION"); return prompt(s);
    }
    case "MOTOR_DURATION": {
      const c = pick(text, Object.keys(MOTOR_DURATION)); if (!c) return reprompt(s, "Please choose one of the options.");
      d.motor.duration = MOTOR_DURATION[c];
      move(s, d.motor.cover_type === "COMPREHENSIVE" ? "MOTOR_VALUE" : "MOTOR_REG"); return prompt(s);
    }
    case "MOTOR_VALUE": {
      const n = Number(text.replace(/kes|ksh|[,\s]/gi, ""));
      if (!Number.isFinite(n) || n <= 0) return reprompt(s, "Please enter the value as a number, e.g. 150000.");
      d.motor.vehicle_value_kes = n; d.motor.value_source = "CUSTOMER_DECLARED"; d.motor.value_declared_at = new Date().toISOString();
      move(s, "MOTOR_REG"); return prompt(s);
    }
    case "MOTOR_REG": {
      const reg = text.toUpperCase().replace(/\s+/g, " ");
      if (reg.length < 5 || reg.length > 12) return reprompt(s, "Please type the registration number, e.g. KXX 123X.");
      d.motor.registration_number = reg; move(s, "MOTOR_MAKE"); return prompt(s);
    }
    case "MOTOR_MAKE": {
      if (text.length < 2) return reprompt(s, "Please type the make and model.");
      d.motor.make_model = text.slice(0, 80); move(s, "DOC_ID"); return prompt(s);
    }
    case "DOC_ID":
    case "DOC_LOGBOOK": {
      const docType = s.state === "DOC_ID" ? "ID_FRONT" : "LOGBOOK";
      const next = s.state === "DOC_ID" ? "DOC_LOGBOOK" : "FINANCE";
      if (m.type === "media") {
        if (!m.mime || !ALLOWED_MIME.includes(m.mime)) return reprompt(s, "Please send a JPG/PNG photo or a PDF.");
        const id = await deps.repo.saveDocument({ wa_id: s.wa_id, doc_type: docType, provider_media_id: m.mediaId, mime: m.mime, status: "RECEIVED",
          note: "Media reference stored. Secure download, malware scan and quality check run when the WhatsApp provider is connected; routed to manual review." });
        const ocr = await ocrAdapter.extract(id, docType);
        if (ocr.status !== "OK") d.docsReview = true;
        (d.docs ??= []).push({ document_id: id, type: docType });
        move(s, next);
        return [{ text: "Received, thank you. Our team will check it." }, ...prompt(s)];
      }
      if (/^skip\b|^later\b/i.test(text)) { (d.docsSkipped ??= []).push(docType); d.docsReview = true; move(s, next); return prompt(s); }
      return reprompt(s, "Please send the photo/PDF here, or type SKIP.");
    }
    case "FINANCE": {
      if (yes(text)) d.motor.lipa_pole_pole_requested = true;
      else if (no(text)) d.motor.lipa_pole_pole_requested = false;
      else return reprompt(s, "Please reply Yes or No.");
      const out = await finishLead(deps, s);
      move(s, "SUBMITTED");
      if (d.motor.lipa_pole_pole_requested) out.push({ text: "We've noted your Lipa Pole Pole request. Financing eligibility is assessed separately by the provider." });
      return out;
    }
  }
  return prompt(s);
}

function begin(s: WaSession): OutboundMessage[] {
  const d = s.data;
  if (s.state !== "NEW") return prompt(s);
  s.data = { attemptId: randomUUID() }; move(s, "CONSENT_PENDING");
  return [{ text: "Welcome! I can help you with insurance — quotes for motor, and guidance for medical, home, travel, life, WIBA, pension and business cover. You can type ADVISER at any time to talk to a person." }, ...prompt(s)];
}

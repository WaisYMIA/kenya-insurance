import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.ts";

export interface OutboundMessage { text: string; options?: string[] }
export interface SendResult { sent: boolean; detail: string }

export interface WhatsAppAdapter {
  send(toWaId: string, msg: OutboundMessage): Promise<SendResult>;
  sendOwnerAlert(text: string): Promise<SendResult>;
  /** Template message (required for business-initiated messages outside the 24h window). Params fill the template body variables in order. */
  sendTemplate?(toWaId: string, templateName: string, params: string[]): Promise<SendResult>;
}

async function logToOutbox(line: string) {
  await mkdir(dirname(config.outboxPath), { recursive: true }).catch(() => {});
  await appendFile(config.outboxPath, line + "\n").catch(() => {});
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Builds the WhatsApp Cloud API payload: <=3 options -> reply buttons, 4-10 -> list, else plain text. */
export function buildCloudPayload(to: string, msg: OutboundMessage) {
  const opts = msg.options ?? [];
  const base = { messaging_product: "whatsapp", to };
  if (opts.length >= 1 && opts.length <= 3) {
    return { ...base, type: "interactive", interactive: { type: "button", body: { text: trunc(msg.text, 1024) },
      action: { buttons: opts.map((o, i) => ({ type: "reply", reply: { id: `opt_${i}`, title: trunc(o, 20) } })) } } };
  }
  if (opts.length > 3 && opts.length <= 10) {
    return { ...base, type: "interactive", interactive: { type: "list", body: { text: trunc(msg.text, 1024) },
      action: { button: "Choose", sections: [{ title: "Options", rows: opts.map((o, i) => ({ id: `opt_${i}`, title: trunc(o, 24) })) }] } } };
  }
  return { ...base, type: "text", text: { body: trunc(msg.text, 4096) } };
}

/**
 * WhatsApp Business Cloud API adapter. Not live until WHATSAPP_ACCESS_TOKEN and
 * WHATSAPP_PHONE_NUMBER_ID are supplied (BSP CONTRACT REQUIRED if you use a BSP whose
 * schema differs — swap this class, the engine only depends on WhatsAppAdapter).
 * With no credentials it writes to the outbox log so flows can be exercised safely.
 */
export class CloudWhatsAppAdapter implements WhatsAppAdapter {
  /** Set by the server so an approved Admin config ('template' / owner_alert) overrides the env default. */
  ownerTemplateResolver?: () => string | undefined;
  private configured() { return Boolean(config.wa.accessToken && config.wa.phoneNumberId); }

  private async post(payload: unknown): Promise<SendResult> {
    let lastErr = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${config.wa.graphBase}/${config.wa.phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.wa.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return { sent: true, detail: "Sent via WhatsApp Cloud API." };
        lastErr = `HTTP ${res.status}`;
        if (res.status < 500) break; // client errors won't succeed on retry
      } catch (e) { lastErr = (e as Error).message; }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    return { sent: false, detail: `WhatsApp send failed (${lastErr}). Logged to outbox.` };
  }

  async send(to: string, msg: OutboundMessage): Promise<SendResult> {
    await logToOutbox(`[${new Date().toISOString()}] WHATSAPP -> ${to}: ${msg.text}${msg.options ? "  [" + msg.options.join(" | ") + "]" : ""}`);
    if (!this.configured()) return { sent: false, detail: "CREDENTIALS_REQUIRED: set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID. Logged to outbox instead." };
    return this.post(buildCloudPayload(to, msg));
  }

  async sendOwnerAlert(text: string): Promise<SendResult> {
    await logToOutbox(`[${new Date().toISOString()}] WHATSAPP -> OWNER ${config.ownerWhatsApp}: ${text}`);
    if (!this.configured()) return { sent: false, detail: "CREDENTIALS_REQUIRED: set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID. Logged to outbox instead." };
    // Business-initiated messages outside the 24h customer-service window must be an approved template.
    const tpl = this.ownerTemplateResolver?.() || config.wa.ownerAlertTemplate;
    if (tpl) return this.sendTemplate(config.ownerWhatsApp, tpl, [text.replace(/\s*\n\s*/g, " | ")]);
    return this.post(buildCloudPayload(config.ownerWhatsApp, { text }));
  }

  async sendTemplate(to: string, templateName: string, params: string[]): Promise<SendResult> {
    await logToOutbox(`[${new Date().toISOString()}] WHATSAPP TEMPLATE ${templateName} -> ${to}: ${params.join(" | ")}`);
    if (!this.configured()) return { sent: false, detail: "CREDENTIALS_REQUIRED: set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID. Logged to outbox instead." };
    return this.post({ messaging_product: "whatsapp", to, type: "template",
      template: { name: templateName, language: { code: "en" }, components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: trunc(p, 1000) })) }] } });
  }
}

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { CloudWhatsAppAdapter, type WhatsAppAdapter } from "./whatsapp-adapter.ts";
import { smtpSend } from "./email-adapter.ts";

/**
 * Sends the business owner (not the customer) an alert on WhatsApp and email whenever a lead or
 * referral is created. Every attempt is also written to the outbox log as an audit trail.
 */
export interface NotificationAdapter {
  notifyOwnerWhatsApp(message: string): Promise<{ sent: boolean; detail: string }>;
  notifyOwnerEmail(subject: string, body: string): Promise<{ sent: boolean; detail: string }>;
}

export class OwnerNotifier implements NotificationAdapter {
  private wa: WhatsAppAdapter;
  constructor(wa?: WhatsAppAdapter) { this.wa = wa ?? new CloudWhatsAppAdapter(); }

  notifyOwnerWhatsApp(message: string) { return this.wa.sendOwnerAlert(message); }

  async notifyOwnerEmail(subject: string, body: string) {
    await mkdir(dirname(config.outboxPath), { recursive: true }).catch(() => {});
    await appendFile(config.outboxPath, `[${new Date().toISOString()}] EMAIL -> ${config.ownerEmail || "(OWNER_EMAIL unset)"}: ${subject}\n${body}\n`).catch(() => {});
    const { host, from } = config.smtp;
    if (!host || !from || !config.ownerEmail) {
      return { sent: false, detail: "CREDENTIALS_REQUIRED: set SMTP_HOST, SMTP_FROM and OWNER_EMAIL (plus SMTP_USER/SMTP_PASS if your provider needs auth). Logged to outbox instead." };
    }
    try {
      await smtpSend({ to: config.ownerEmail, subject, body });
      return { sent: true, detail: "Email sent." };
    } catch (e) {
      return { sent: false, detail: `Email failed (${(e as Error).message}). Logged to outbox.` };
    }
  }
}

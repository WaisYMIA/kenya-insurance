// Central configuration. Everything environment-specific comes from env vars (see /.env.example).
export function normalizeKenyanNumber(n: string): string {
  const d = n.replace(/[^\d]/g, "");
  if (d.startsWith("254")) return d;
  if (d.startsWith("0")) return "254" + d.slice(1);
  if (d.length === 9) return "254" + d;
  return d;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: process.env.DB_PATH ?? "./data/app.db",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // Business owner who receives lead/referral alerts. 0724888057 -> 254724888057
  ownerWhatsApp: normalizeKenyanNumber(process.env.OWNER_WHATSAPP_NUMBER ?? "0724888057"),
  ownerEmail: process.env.OWNER_EMAIL ?? "",
  authSecret: process.env.AUTH_SECRET ?? "",
  loginRateMax: Number(process.env.LOGIN_RATE_MAX ?? 10), // failed+successful attempts per IP per 15 min
  tokenTtlSeconds: Number(process.env.TOKEN_TTL_SECONDS ?? 8 * 3600),
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@example.invalid",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  wa: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    ownerAlertTemplate: process.env.WA_TEMPLATE_OWNER_ALERT ?? "",
    graphBase: process.env.WHATSAPP_GRAPH_BASE ?? "https://graph.facebook.com/v20.0",
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: (process.env.SMTP_SECURE ?? "true") === "true",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
  },
  privacyNoticeUrl: process.env.PRIVACY_NOTICE_URL ?? "PRIVACY_NOTICE_URL_REQUIRED",
  consentVersion: process.env.CONSENT_VERSION ?? "v0-DRAFT-legal-approval-required",
  allowUnsignedWebhooks: process.env.ALLOW_UNSIGNED_WEBHOOKS === "true", // dev/test only
  renewalCronSecret: process.env.RENEWAL_CRON_SECRET ?? "",
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? "",
  outboxPath: process.env.NOTIFICATION_OUTBOX_PATH ?? "./data/notification-outbox.log",
};

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Inbound } from "./engine.ts";

/** Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex>") over the RAW request body. */
export function verifyCloudSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  let given: Buffer;
  try { given = Buffer.from(header.slice(7), "hex"); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Normalises the WhatsApp Cloud API webhook payload into engine inputs. Status callbacks are ignored. */
export function parseCloudWebhook(body: any): Inbound[] {
  const out: Inbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const base = { waId: String(m.from), messageId: String(m.id) };
        if (m.type === "text") out.push({ ...base, type: "text", text: m.text?.body ?? "" });
        else if (m.type === "interactive") {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          out.push({ ...base, type: "choice", text: r?.title ?? "" });
        } else if (m.type === "image" || m.type === "document") {
          const media = m[m.type];
          out.push({ ...base, type: "media", mediaId: media?.id, mime: media?.mime_type });
        } else out.push({ ...base, type: "other", text: "" });
      }
    }
  }
  return out;
}

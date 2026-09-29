import type { SqliteRepository } from "../repositories/sqlite-repository.ts";
import type { QuoteRequestInput } from "../domain/types.ts";
import { decideQuote } from "./quote-decision.ts";
import { motorReferralCategories } from "../config-admin.ts";

/** Runs the quote decision with the approved referral-category rule, persists the result and records analytics events. */
export async function runQuote(repo: SqliteRepository, input: QuoteRequestInput, channel: "WEB" | "WHATSAPP") {
  const { quote, trace } = await decideQuote(repo, input, { referralCategories: motorReferralCategories(repo) });
  await repo.updateQuote(quote);
  await repo.recordEvent({ type: "MOTOR_QUOTE_REQUESTED", channel, line: "MOTOR", ref: quote.quote_id, detail: { vehicle_category: input.vehicle_category, cover_type: input.cover_type } });
  if (quote.status === "REFERRED") await repo.recordEvent({ type: "MOTOR_QUOTE_REFERRED", channel, line: "MOTOR", ref: quote.quote_id, detail: { reasons: trace.reason_codes } });
  return { quote, trace };
}

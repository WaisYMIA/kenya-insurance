import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "../repositories/repository.ts";
import type { QuoteRequestInput, Quote, DecisionTrace } from "../domain/types.ts";

/**
 * Executes the Quote decision workflow (V4 Quote_Decision / V5 /v1/quotes/decide).
 *
 * Deliberately does NOT compute a premium from an invented rate. Per the master brief §4 and
 * the V3 Rate_Logic sheet, a rate config that is still `CONFIGURATION_REQUIRED` must surface
 * that fact to the caller, never a fabricated number. Once the business supplies an approved
 * `technical_rate` (via the rate_configurations table / an insurer/Lami rate feed), this
 * function's ELIGIBLE branch is where the real formula from `formula_expression` gets evaluated.
 */
export async function decideQuote(
  repo: Repository,
  input: QuoteRequestInput,
  opts: { referralCategories?: string[] } = {}
): Promise<{ quote: Quote; trace: DecisionTrace }> {
  const inputsHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const transactionId = randomUUID();

  const quote = await repo.createQuote(input);

  // Eligibility by vehicle category (mirrors V3 PR-002: commercial/hire-reward/PSV use -> REFER,
  // regardless of vehicle type — a motorcycle used for boda boda hire is treated the same as a
  // commercial car or PSV matatu here, per the master brief §11's "do not assume every category
  // is eligible for every product" and V3's product_rules pattern).
  if ((opts.referralCategories ?? ["COMMERCIAL_VEHICLE", "PSV", "HIRE_REWARD"]).includes(input.vehicle_category)) {
    const trace = await repo.saveDecisionTrace({
      transaction_id: transactionId,
      workflow: "quote",
      engine_version: "v1-dev",
      inputs_hash: inputsHash,
      decision: "REFERRED",
      reason_codes: ["CATEGORY_REQUIRES_UNDERWRITING_REVIEW"],
    });
    quote.status = "REFERRED";
    return { quote, trace };
  }

  if (input.vehicle_category === "OTHER") {
    const trace = await repo.saveDecisionTrace({
      transaction_id: transactionId,
      workflow: "quote",
      engine_version: "v1-dev",
      inputs_hash: inputsHash,
      decision: "REFERRED",
      reason_codes: ["VEHICLE_CATEGORY_UNSUPPORTED"],
    });
    quote.status = "REFERRED";
    return { quote, trace };
  }

  // Eligibility (mirrors V3 Eligibility_Rules / PR-MOT-003)
  if (input.cover_type === "COMPREHENSIVE" && !input.vehicle_value_kes) {
    const trace = await repo.saveDecisionTrace({
      transaction_id: transactionId,
      workflow: "quote",
      engine_version: "v1-dev",
      inputs_hash: inputsHash,
      decision: "BLOCKED",
      reason_codes: ["VALUE_REQUIRED"],
    });
    quote.status = "DRAFT";
    return { quote, trace };
  }

  const rateConfig = await repo.getRateConfiguration(input.product_id);
  const charges = await repo.listCharges();

  if (!rateConfig || rateConfig.rate_status !== "ACTIVE") {
    // This is the honest, correct outcome today: no approved rate is configured yet.
    const trace = await repo.saveDecisionTrace({
      transaction_id: transactionId,
      workflow: "quote",
      engine_version: "v1-dev",
      inputs_hash: inputsHash,
      decision: "REFERRED",
      reason_codes: ["RATE_CONFIGURATION_REQUIRED"],
    });
    quote.status = "REFERRED";
    quote.premium_kes = null;
    quote.charges = charges.map((c) => ({
      charge_id: c.charge_id,
      status: c.rate_status,
      rate_or_amount: c.rate_or_amount,
    }));
    return { quote, trace };
  }

  // --- Real rating would execute here once rateConfig.rate_status === 'ACTIVE' ---
  // e.g. premium = input.vehicle_value_kes * approvedTechnicalRate, using rateConfig.formula_expression
  // as the audited formula reference, not a hard-coded literal.

  const trace = await repo.saveDecisionTrace({
    transaction_id: transactionId,
    workflow: "quote",
    engine_version: "v1-dev",
    inputs_hash: inputsHash,
    decision: "QUOTED",
    reason_codes: [],
  });
  quote.status = "QUOTED";
  return { quote, trace };
}

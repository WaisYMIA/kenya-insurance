import { randomUUID } from "node:crypto";
import type {
  Product,
  ProductVersion,
  RateConfiguration,
  Charge,
  NeedsAssessment,
  Quote,
  QuoteRequestInput,
  DecisionTrace,
  Lead,
  LeadInput,
} from "../domain/types.ts";

/**
 * Repository interface. Implement this same interface against Postgres in your own
 * environment (e.g. `services/api/src/repositories/postgres-repository.ts` using `pg`) and
 * nothing in routes/rules needs to change. This mirrors the LamiAdapter/InsurerAdapter pattern:
 * code the seam once, swap the implementation when infrastructure/credentials exist.
 */
export interface Repository {
  listActiveProductVersions(): Promise<Array<Product & { version: ProductVersion }>>;
  getRateConfiguration(productId: string): Promise<RateConfiguration | null>;
  listCharges(): Promise<Charge[]>;
  createNeedsAssessment(): Promise<NeedsAssessment>;
  saveAssessmentAnswer(assessmentId: string, questionId: string, value: unknown): Promise<NeedsAssessment>;
  createQuote(input: QuoteRequestInput): Promise<Quote>;
  getQuote(quoteId: string): Promise<Quote | null>;
  updateQuote(quote: Quote): Promise<void>;
  saveDecisionTrace(trace: Omit<DecisionTrace, "decision_id" | "executed_at">): Promise<DecisionTrace>;
  getDecisionTrace(decisionId: string): Promise<DecisionTrace | null>;
  createLead(input: LeadInput): Promise<Lead>;
  markLeadNotified(leadId: string): Promise<void>;
  listLeads(): Promise<Lead[]>;
}

// ---- In-memory seed data, mirroring db/seed/001_motorcycle_pilot_product.sql exactly ----

// Motor is ONE line covering every vehicle category (motorcycle, private car, commercial
// vehicle, PSV, hire/reward) — category is a quote input, not a separate product. This mirrors
// Lami's own single "Motor insurance" line (lami.world/individual-motor-insurance.html).
const products: Product[] = [
  { product_id: "MOT-TP-001", product_name: "Motor Third Party", product_family: "Motor", regulatory_class: "Motor - Third Party" },
  { product_id: "MOT-COMP-001", product_name: "Motor Comprehensive", product_family: "Motor", regulatory_class: "Motor - Comprehensive" },
];

const productVersions: ProductVersion[] = [
  { product_version_id: randomUUID(), product_id: "MOT-TP-001", version_label: "2026.PILOT.1", effective_from: "2026-01-01", status: "DRAFT" },
  { product_version_id: randomUUID(), product_id: "MOT-COMP-001", version_label: "2026.PILOT.1", effective_from: "2026-01-01", status: "DRAFT" },
];

const rateConfigurations: RateConfiguration[] = [
  {
    rate_config_id: randomUUID(),
    product_id: "MOT-COMP-001",
    coverage_id: "COV-001",
    formula_type: "rate_on_vehicle_value",
    formula_expression: "premium = vehicle_value * technical_rate (rate may vary by vehicle_category)",
    rate_status: "CONFIGURATION_REQUIRED",
    source_reference: "Approved motor product/rating basis — insurer to supply technical_rate",
  },
  {
    rate_config_id: randomUUID(),
    product_id: "MOT-TP-001",
    coverage_id: "COV-002",
    formula_type: "flat_or_statutory",
    formula_expression: "premium = statutory_or_insurer_schedule (may vary by vehicle_category)",
    rate_status: "CONFIGURATION_REQUIRED",
    source_reference: "Insurance (Motor Vehicle Third Party Risks) Act Cap.405 — insurer/statutory schedule required",
  },
];

const charges: Charge[] = [
  { charge_id: "TL-001", charge_name: "Insurance Premium Levy", payer: "insurer / as prescribed", basis: "gross direct premium / prescribed basis", rate_or_amount: "CONFIGURE", rate_status: "SOURCE_CONTROLLED", source_reference: "Insurance Act s.197A and current order", calculation_order: "after_base_premium" },
  { charge_id: "TL-002", charge_name: "Insurance Training Levy", payer: "policyholder via insurer", basis: "gross direct premiums written / prescribed basis", rate_or_amount: "CONFIGURE", rate_status: "SOURCE_CONTROLLED", source_reference: "Insurance Act s.197B and current order", calculation_order: "after_base_premium" },
  { charge_id: "TL-003", charge_name: "Policyholders' Compensation Fund contribution", payer: "insurer + policyholder", basis: "premium / applicable policy", rate_or_amount: "0.25% each party", rate_status: "SOURCE_DATED_2010_RULE", source_reference: "Insurance (Policyholders' Compensation Fund) Regulations, 2010, reg.9", calculation_order: "after_base_premium" },
];

export class InMemoryRepository implements Repository {
  private assessments = new Map<string, NeedsAssessment>();
  private quotes = new Map<string, Quote>();
  private traces = new Map<string, DecisionTrace>();
  private leads = new Map<string, Lead>();

  async listActiveProductVersions() {
    return productVersions.map((version) => {
      const product = products.find((p) => p.product_id === version.product_id)!;
      return { ...product, version };
    });
  }

  async getRateConfiguration(productId: string) {
    return rateConfigurations.find((r) => r.product_id === productId) ?? null;
  }

  async listCharges() {
    return charges;
  }

  async createNeedsAssessment() {
    const assessment: NeedsAssessment = {
      assessment_id: randomUUID(),
      status: "IN_PROGRESS",
      answers: {},
      created_at: new Date().toISOString(),
    };
    this.assessments.set(assessment.assessment_id, assessment);
    return assessment;
  }

  async saveAssessmentAnswer(assessmentId: string, questionId: string, value: unknown) {
    const assessment = this.assessments.get(assessmentId);
    if (!assessment) throw new Error("NOT_FOUND");
    assessment.answers[questionId] = value;
    return assessment;
  }

  async createQuote(input: QuoteRequestInput) {
    const quote: Quote = {
      quote_id: randomUUID(),
      customer_id: input.customer_id,
      product_id: input.product_id,
      status: "DRAFT",
      premium_kes: null,
      charges: [],
      created_at: new Date().toISOString(),
    };
    this.quotes.set(quote.quote_id, quote);
    return quote;
  }

  async getQuote(quoteId: string) {
    return this.quotes.get(quoteId) ?? null;
  }

  async saveDecisionTrace(trace: Omit<DecisionTrace, "decision_id" | "executed_at">) {
    const full: DecisionTrace = {
      ...trace,
      decision_id: randomUUID(),
      executed_at: new Date().toISOString(),
    };
    this.traces.set(full.decision_id, full);
    return full;
  }

  async getDecisionTrace(decisionId: string) {
    return this.traces.get(decisionId) ?? null;
  }

  /** Test/dev helper only — lets routes update a quote after rating. */
  async updateQuote(quote: Quote) {
    this.quotes.set(quote.quote_id, quote);
  }

  async createLead(input: LeadInput) {
    const lead: Lead = {
      ...input,
      lead_id: randomUUID(),
      status: "NEW",
      created_at: new Date().toISOString(),
    };
    this.leads.set(lead.lead_id, lead);
    return lead;
  }

  async markLeadNotified(leadId: string) {
    const lead = this.leads.get(leadId);
    if (lead) lead.status = "NOTIFIED";
  }

  async listLeads() {
    return [...this.leads.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
}

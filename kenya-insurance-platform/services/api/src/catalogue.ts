import { readFileSync } from "node:fs";
import type { Question } from "./flows.ts";

// Product catalogue loaded from the ontology workbook (scripts/extract-catalogue.py -> data/catalogue.json).
// These are *market product descriptions*, not approved products for sale: policy wording, insurer,
// rates and eligibility are separate, controlled configuration (see the Admin approval workflow).
export interface CatalogueProduct {
  product_id: string; class: string; name: string; target_segment: string; insured_risk: string;
  basis_of_sum_insured: string; rating_factors: string[]; coverages: { id: string; name: string; definition: string }[];
}
export interface Catalogue {
  source: string; generated_at: string;
  classes: { name: string; ontology_code: string; product_ids: string[] }[];
  products: CatalogueProduct[];
  coverage_components: { id: string; name: string; definition: string }[];
  exclusions: { id: string; name: string; definition: string }[];
  perils: { id: string; name: string }[];
  bundles: { id: string; name: string; components: string }[];
  claims_evidence: { id: string; domain: string; evidence: string; purpose: string }[];
  underwriting_questions: { id: string; domain: string; topic: string; question: string }[];
  claim_domains: Record<string, string[]>;
}

export const catalogue: Catalogue = JSON.parse(readFileSync(new URL("./data/catalogue.json", import.meta.url), "utf8"));
export const productById = new Map(catalogue.products.map((p) => [p.product_id, p]));
export const productsInClass = (cls: string) => catalogue.products.filter((p) => p.class === cls);

const WIBA_CLASS = "Workmen's Compensation / Employer's Liability";
/** Guided-line -> the ontology products a customer can say they're interested in. */
export const LINE_PRODUCTS: Record<string, string[]> = {
  MEDICAL: productsInClass("Medical").map((p) => p.product_id),
  WIBA: productsInClass(WIBA_CLASS).map((p) => p.product_id),
  HOME: productsInClass("Fire Domestic").map((p) => p.product_id),
  TRAVEL: ["MED-009", "MISC-010"],
};
/** Classes reachable from the "Business & general" entry (the rest have their own guided line). */
export const GENERAL_CLASSES = ["Fire Industrial/Commercial", "Engineering", "Liability", "Marine & Transit", "Aviation", "Theft", "Personal Accident", "Miscellaneous"];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const YN = ["Yes", "No"];
const TIMING = ["Immediately", "Within a month", "In 1–3 months", "Just exploring"];

/** Class/product-specific intake: the product's own rating factors (from the ontology) become the questions. */
export function generatedQuestions(p: CatalogueProduct): Question[] {
  const qs: Question[] = p.rating_factors.slice(0, 4).map((f, i) => ({
    id: `RF-${i + 1}`, text: `Please tell us about: ${cap(f)}`, type: "text" as const, placeholder: "Type your answer, or 'not sure'",
  }));
  qs.push({ id: "Q-004", text: `Roughly what is the ${p.basis_of_sum_insured.toLowerCase()} (KES)?`, type: "text", placeholder: "e.g. 5,000,000 or 'not sure'" });
  qs.push({ id: "Q-008", text: "Any claims or losses in the past 3 years?", type: "choice", options: YN });
  qs.push({ id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING });
  return qs;
}

/** Evidence a customer should have ready for a claim in a given area (Claims_Evidence sheet). */
export function claimEvidenceFor(area: string) {
  const domains = catalogue.claim_domains[area] ?? ["All"];
  return catalogue.claims_evidence.filter((e) => domains.includes(e.domain)).map((e) => ({ evidence: e.evidence, purpose: e.purpose }));
}

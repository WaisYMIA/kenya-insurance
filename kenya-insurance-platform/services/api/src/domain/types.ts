// Canonical domain types — mirrors V6 Canonical_Entities / V9 Database_Tables.
// Kept dependency-free (no ORM types) so this file can be shared with a future Postgres
// repository implementation without changes.

export type ID = string;

export interface Product {
  product_id: string;
  product_name: string;
  product_family: string;
  regulatory_class?: string;
}

export interface ProductVersion {
  product_version_id: ID;
  product_id: string;
  version_label: string;
  insurer?: string | null;
  effective_from: string;
  effective_to?: string | null;
  status: "DRAFT" | "REVIEW" | "APPROVED" | "ACTIVE" | "RETIRED";
}

export interface RateConfiguration {
  rate_config_id: ID;
  product_id: string;
  coverage_id?: string;
  formula_type: string;
  formula_expression: string;
  rate_status: "CONFIGURATION_REQUIRED" | "SOURCE_CONTROLLED" | "ACTIVE";
  source_reference: string;
}

export interface Charge {
  charge_id: string;
  charge_name: string;
  payer?: string;
  basis?: string;
  rate_or_amount: string;
  rate_status: string;
  source_reference: string;
  calculation_order?: string;
}

export interface NeedsAssessment {
  assessment_id: ID;
  customer_id?: ID | null;
  status: "IN_PROGRESS" | "COMPLETE";
  answers: Record<string, unknown>;
  created_at: string;
}

export type CoverType = "THIRD_PARTY" | "COMPREHENSIVE";
export type Duration = "WEEKLY" | "MONTHLY" | "ANNUAL";
export type VehicleCategory =
  | "MOTORCYCLE"
  | "PRIVATE_CAR"
  | "COMMERCIAL_VEHICLE"
  | "PSV"
  | "HIRE_REWARD"
  | "OTHER";

export interface QuoteRequestInput {
  customer_id?: ID;
  product_id: string; // MOT-TP-001 (Third Party) or MOT-COMP-001 (Comprehensive) — one product per cover type, ALL vehicle categories
  vehicle_category: VehicleCategory;
  usage_type: string; // private | social_domestic_pleasure | commercial | hire_reward | PSV
  cover_type: CoverType;
  duration: Duration;
  vehicle_value_kes?: number;
}

// ---- Non-motor lead capture (Medical, WIBA, Life, Home, Travel, Pension & Annuities, General/SME) ----
// Mirrors Lami's own lead-capture pattern (lami.world "Get a quote": name/contact + insurance
// line, routed to a human adviser) plus V8 Needs_Questions Q001-Q012.

export type ProductLine =
  | "MOTOR"
  | "MEDICAL"
  | "WIBA"
  | "LIFE"
  | "HOME"
  | "TRAVEL"
  | "PENSION_ANNUITIES"
  | "GENERAL";

export interface LeadInput {
  product_line: ProductLine;
  contact_name: string;
  contact_phone: string;
  contact_email?: string;
  answers: Record<string, unknown>; // keyed by Needs_Questions question_id, e.g. Q002, Q003...
  consent_given: boolean;
  source_channel?: "WEB" | "WHATSAPP";
}

export interface Lead extends LeadInput {
  lead_id: ID;
  status: "NEW" | "NOTIFIED" | "IN_REVIEW" | "CLOSED";
  assigned_to?: string | null;
  created_at: string;
}

export interface LeadNote { note_id: string; lead_id: string; author: string; text: string; created_at: string }
export interface StaffUser { user_id: string; email: string; name: string; role: "ADMIN" | "ADVISER"; password_hash: string; active: boolean; created_at: string }

export type QuoteStatus = "DRAFT" | "QUOTED" | "REFERRED" | "DECLINED" | "EXPIRED";

export interface Quote {
  quote_id: ID;
  customer_id?: ID;
  product_id: string;
  status: QuoteStatus;
  premium_kes: number | null;
  charges: Array<{ charge_id: string; status: string; rate_or_amount: string }>;
  created_at: string;
}

export interface DecisionTrace {
  decision_id: ID;
  transaction_id: ID;
  workflow: string;
  engine_version: string;
  inputs_hash: string;
  decision: string;
  reason_codes: string[];
  executed_at: string;
}

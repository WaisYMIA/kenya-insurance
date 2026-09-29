import type { SqliteRepository } from "./repositories/sqlite-repository.ts";
import { LEAD_LINES, CLAIM_FLOW, type Question, type LineFlow } from "./flows.ts";
import { catalogue, productById, LINE_PRODUCTS, GENERAL_CLASSES, generatedQuestions, productsInClass } from "./catalogue.ts";

/**
 * Approval-controlled configuration (maker/checker). Nothing that changes what customers see or how
 * requests are routed is edited in place: a change is a new numbered VERSION that goes
 * DRAFT -> SUBMITTED -> APPROVED (by a different admin) and only then becomes active. Older versions are kept;
 * rollback = a new version copying an old value (which itself needs approval). Every step is audited.
 */
export const KINDS = ["product", "flow", "rule", "template", "content"] as const;
export type Kind = (typeof KINDS)[number];
const VEHICLE_CATEGORIES = ["MOTORCYCLE", "PRIVATE_CAR", "COMMERCIAL_VEHICLE", "PSV", "HIRE_REWARD", "OTHER"];
export const DEFAULT_REFERRAL_CATEGORIES = ["COMMERCIAL_VEHICLE", "PSV", "HIRE_REWARD"];
const FLOW_KEYS = [...Object.keys(LEAD_LINES), "CLAIM"];
const TEMPLATE_KEYS = ["owner_alert", "renewal_reminder", "claim_ack"];
const PRODUCT_STATUS = ["DRAFT", "ACTIVE", "RETIRED"];

function validateQuestions(qs: any): string | null {
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 15) return "qs must be 1–15 questions";
  for (const q of qs) {
    if (!q || typeof q.id !== "string" || typeof q.text !== "string" || !q.text.trim()) return "each question needs id and text";
    if (q.type !== "choice" && q.type !== "text") return `question ${q.id}: type must be choice or text`;
    if (q.type === "choice" && (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10 || q.options.some((o: any) => typeof o !== "string" || !o.trim())))
      return `question ${q.id}: choice needs 2–10 text options (WhatsApp list limit)`;
  }
  return null;
}

/** Returns an error string, or null when the value is acceptable for that kind/key. */
export function validateConfig(kind: string, key: string, value: any): string | null {
  if (!KINDS.includes(kind as Kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (!value || typeof value !== "object") return "value must be an object";
  switch (kind) {
    case "product":
      if (!productById.has(key)) return "unknown product_id";
      if (value.status !== undefined && !PRODUCT_STATUS.includes(value.status)) return `status must be ${PRODUCT_STATUS.join("/")}`;
      if (value.enquiry_enabled !== undefined && typeof value.enquiry_enabled !== "boolean") return "enquiry_enabled must be true/false";
      for (const f of ["display_name", "insurer", "note"]) if (value[f] !== undefined && typeof value[f] !== "string") return `${f} must be text`;
      return null;
    case "flow":
      if (!FLOW_KEYS.includes(key)) return `flow key must be one of ${FLOW_KEYS.join(", ")}`;
      return validateQuestions(value.qs);
    case "rule":
      if (key !== "motor.referral_categories") return "only rule key 'motor.referral_categories' is supported";
      if (!Array.isArray(value.categories) || value.categories.some((c: string) => !VEHICLE_CATEGORIES.includes(c))) return `categories must be a list of ${VEHICLE_CATEGORIES.join(", ")}`;
      return null;
    case "template":
      if (!TEMPLATE_KEYS.includes(key)) return `template key must be one of ${TEMPLATE_KEYS.join(", ")}`;
      if (typeof value.provider_template_name !== "string" || !/^[a-z0-9_]{1,512}$/.test(value.provider_template_name)) return "provider_template_name must be the approved template's name (lowercase letters, digits, underscores)";
      return null;
    case "content":
      if (!key.startsWith("learn.")) return "content key must look like learn.<class name>";
      if (typeof value.intro !== "string" || value.intro.length > 1500) return "intro must be text up to 1500 characters";
      return null;
  }
  return null;
}

export type ActiveConfig = Map<string, any>;
export const activeConfig = (repo: SqliteRepository, nowIso?: string): ActiveConfig => repo.cfgActive(nowIso);

export function motorReferralCategories(repo: SqliteRepository): string[] {
  const c = activeConfig(repo).get("rule:motor.referral_categories");
  return c ? c.value.categories : DEFAULT_REFERRAL_CATEGORIES;
}
export function activeTemplateName(repo: SqliteRepository, key: string): string | undefined {
  return activeConfig(repo).get(`template:${key}`)?.value.provider_template_name;
}

export interface PublicProduct { product_id: string; class: string; name: string; target_segment: string; insured_risk: string; basis_of_sum_insured: string; coverages: any[]; insurer?: string; status: string; enquiry_enabled: boolean }

export function effectiveProducts(repo: SqliteRepository): PublicProduct[] {
  const cfg = activeConfig(repo);
  return catalogue.products.map((p) => {
    const o = cfg.get(`product:${p.product_id}`)?.value ?? {};
    return { product_id: p.product_id, class: p.class, name: o.display_name || p.name, target_segment: p.target_segment, insured_risk: p.insured_risk,
      basis_of_sum_insured: p.basis_of_sum_insured, coverages: p.coverages, insurer: o.insurer, status: o.status ?? "CATALOGUE", enquiry_enabled: o.enquiry_enabled !== false && o.status !== "RETIRED" };
  });
}

/** Every intake flow the web and WhatsApp channels use, with approved overrides applied. */
export function getFlows(repo: SqliteRepository) {
  const cfg = activeConfig(repo);
  const products = effectiveProducts(repo);
  const enabled = (id: string) => products.find((p) => p.product_id === id)?.enquiry_enabled !== false;
  const nameOf = (id: string) => products.find((p) => p.product_id === id)!.name;

  const lines: Record<string, LineFlow & { product_names?: Record<string, string> }> = {};
  for (const [line, f] of Object.entries(LEAD_LINES)) {
    let qs: Question[] = f.qs;
    const override = cfg.get(`flow:${line}`)?.value.qs as Question[] | undefined;
    const ids = (LINE_PRODUCTS[line] ?? []).filter(enabled);
    const names: Record<string, string> = {};
    if (override) qs = override;
    else if (ids.length) {
      ids.forEach((id) => (names[nameOf(id)] = id));
      qs = [{ id: "Q-PRODUCT", text: "Which cover are you interested in?", type: "choice", options: [...ids.map(nameOf), "Not sure yet"] }, ...f.qs];
    }
    if (line !== "GENERAL" && override === undefined && !ids.length) qs = f.qs;
    lines[line] = { ...f, qs, product_names: names };
  }
  const general = {
    classes: GENERAL_CLASSES.map((cls) => ({
      name: cls,
      intro: cfg.get(`content:learn.${cls}`)?.value.intro,
      products: productsInClass(cls).filter((p) => enabled(p.product_id)).map((p) => ({ product_id: p.product_id, name: nameOf(p.product_id), questions: generatedQuestions(p) })),
    })).filter((c) => c.products.length),
    fallback_questions: LEAD_LINES.GENERAL.qs,
  };
  const claim = { ...CLAIM_FLOW, qs: (cfg.get("flow:CLAIM")?.value.qs as Question[]) ?? CLAIM_FLOW.qs };
  return { lines, general, claim };
}

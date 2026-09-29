// Single source of truth for the guided question sets, used by the WhatsApp engine AND served to the
// web enquiry page via GET /v1/flows. Question ids reference V8 Needs_Questions (Q-003 asset, Q-004 value,
// Q-006 location, Q-007 people, Q-008 history, Q-009 existing cover, Q-010 priority, Q-011 timing).
// Wording is plain-language UX only — no insurance rule, rate or eligibility is encoded here.
export interface Question { id: string; text: string; type: "choice" | "text"; options?: string[]; placeholder?: string }
export interface LineFlow { label: string; icon: string; qs: Question[] }

const YN = ["Yes", "No"];
const PRIORITY = ["Lowest price", "Widest cover", "High limits", "Service & claims", "Convenience"];
const TIMING = ["Immediately", "Within a month", "In 1–3 months", "Just exploring"];

export const LEAD_LINES: Record<string, LineFlow> = {
  MEDICAL: { label: "Medical insurance", icon: "🩺", qs: [
    { id: "Q-007", text: "Who needs cover?", type: "choice", options: ["Just me", "Me and spouse", "Family with children", "A group / employees"] },
    { id: "Q-007b", text: "How many people in total?", type: "text", placeholder: "e.g. 4" },
    { id: "Q-008", text: "Does anyone have an existing medical condition?", type: "choice", options: YN },
    { id: "Q-009", text: "Do you already have medical cover?", type: "choice", options: YN },
    { id: "Q-010", text: "What matters most?", type: "choice", options: PRIORITY },
    { id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING } ] },
  WIBA: { label: "WIBA (work injury benefits)", icon: "👷", qs: [
    { id: "Q-003", text: "What does your business do?", type: "text", placeholder: "e.g. construction, retail, farming" },
    { id: "Q-007", text: "How many employees?", type: "text", placeholder: "e.g. 12" },
    { id: "Q-008", text: "Any work injury claims in the past 3 years?", type: "choice", options: YN },
    { id: "Q-009", text: "Do you already have WIBA cover?", type: "choice", options: YN },
    { id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING } ] },
  LIFE: { label: "Life insurance", icon: "🛡️", qs: [
    { id: "Q-007", text: "Who depends on your income?", type: "choice", options: ["Spouse", "Children", "Parents / relatives", "No one yet"] },
    { id: "Q-004", text: "Roughly how much cover would you like (KES)?", type: "text", placeholder: "e.g. 5,000,000 or 'not sure'" },
    { id: "Q-009", text: "Do you already have life cover?", type: "choice", options: YN },
    { id: "Q-010", text: "What matters most?", type: "choice", options: PRIORITY },
    { id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING } ] },
  HOME: { label: "Home insurance", icon: "🏠", qs: [
    { id: "Q-003", text: "What are you insuring?", type: "choice", options: ["House I own", "Rental (contents only)", "Apartment I own", "Other"] },
    { id: "Q-004", text: "Approximate value of the building / contents (KES)?", type: "text", placeholder: "e.g. 8,000,000" },
    { id: "Q-006", text: "Where is the property (town / estate)?", type: "text", placeholder: "e.g. Kilimani, Nairobi" },
    { id: "Q-008", text: "Any theft, fire or damage incidents before?", type: "choice", options: YN },
    { id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING } ] },
  TRAVEL: { label: "Travel insurance", icon: "✈️", qs: [
    { id: "Q-003", text: "Where are you travelling to?", type: "text", placeholder: "Country / countries" },
    { id: "Q-007", text: "How many travellers?", type: "text", placeholder: "e.g. 2" },
    { id: "Q-011", text: "Travel date?", type: "text", placeholder: "e.g. 15 Nov 2026" },
    { id: "Q-010", text: "What matters most?", type: "choice", options: ["Medical cover", "Trip cancellation", "Baggage", "Lowest price"] } ] },
  PENSION_ANNUITIES: { label: "Pension & annuities", icon: "🌅", qs: [
    { id: "Q-003", text: "What are you planning for?", type: "choice", options: ["Saving for retirement", "Income from a lump sum", "Not sure yet"] },
    { id: "Q-004", text: "Roughly how much can you put in (KES)?", type: "text", placeholder: "monthly or lump sum" },
    { id: "Q-009", text: "Do you already have a pension?", type: "choice", options: YN },
    { id: "Q-011", text: "When do you want to start?", type: "choice", options: TIMING } ] },
  GENERAL: { label: "Business & general insurance", icon: "🏢", qs: [
    { id: "Q-003", text: "What would you like to protect?", type: "choice", options: ["Business premises & stock", "Liability", "Goods in transit", "Agriculture", "Something else"] },
    { id: "Q-004", text: "Approximate value or exposure (KES)?", type: "text", placeholder: "e.g. 20,000,000" },
    { id: "Q-006", text: "Where is the business / risk located?", type: "text", placeholder: "Town / county" },
    { id: "Q-008", text: "Any claims or losses in the past 3 years?", type: "choice", options: YN },
    { id: "Q-011", text: "When do you need cover?", type: "choice", options: TIMING } ] },
};

// Claim first-notice-of-loss intake. Collects facts only — it never decides liability or cover.
export const CLAIM_AREAS = ["Motor", "Medical", "Home / property", "Theft / burglary", "Business / liability", "Personal accident / work injury", "Travel", "Other"];
export const CLAIM_FLOW: LineFlow = { label: "Report a claim", icon: "🧾", qs: [
  { id: "Q-C1", text: "What is the claim about?", type: "choice", options: CLAIM_AREAS },
  { id: "Q-C2", text: "What is your policy number?", type: "text", placeholder: "or type 'don't know'" },
  { id: "Q-C3", text: "When did it happen?", type: "text", placeholder: "e.g. 25 Sep 2026" },
  { id: "Q-C4", text: "Where did it happen?", type: "text", placeholder: "Town / road / place" },
  { id: "Q-C5", text: "Briefly, what happened?", type: "text", placeholder: "A few sentences" },
  { id: "Q-C6", text: "Was anyone injured?", type: "choice", options: ["Yes", "No"] },
  { id: "Q-C7", text: "Police / OB number, if reported?", type: "text", placeholder: "or type 'none'" },
] };

export const MOTOR_CATEGORIES: Record<string, string> = {
  "Motorcycle": "MOTORCYCLE", "Private car": "PRIVATE_CAR", "Commercial vehicle": "COMMERCIAL_VEHICLE",
  "PSV (matatu/bus)": "PSV", "Hire / reward": "HIRE_REWARD", "Other": "OTHER",
};
export const MOTOR_USAGE: Record<string, string> = { "Private / personal": "private", "Commercial / business": "commercial", "Hire or reward": "hire_reward" };
export const MOTOR_COVER: Record<string, "THIRD_PARTY" | "COMPREHENSIVE"> = { "Third Party": "THIRD_PARTY", "Comprehensive": "COMPREHENSIVE" };
export const MOTOR_DURATION: Record<string, "WEEKLY" | "MONTHLY" | "ANNUAL"> = { "Weekly": "WEEKLY", "Monthly": "MONTHLY", "Annual": "ANNUAL" };

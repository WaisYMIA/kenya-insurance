/**
 * Insurer / Lami / payment / OCR adapter contracts (master brief §31, §32, §19, §34).
 * NOTHING here is faked: until the provider contract, credentials and schemas exist, every method
 * throws NotConfiguredError with the exact thing that is missing. The rest of the platform codes
 * against these interfaces so a real implementation can be dropped in without touching callers.
 */
export class NotConfiguredError extends Error {
  code = "NOT_CONFIGURED";
  constructor(what: string) { super(what); }
}

export interface InsurerAdapter {
  quote(input: unknown): Promise<unknown>;
  issue(input: unknown): Promise<unknown>;
  endorse(input: unknown): Promise<unknown>;
  renew(input: unknown): Promise<unknown>;
  fnol(input: unknown): Promise<unknown>;
  claimStatus(claimRef: string): Promise<unknown>;
  documents(policyRef: string): Promise<unknown>;
  cancel(policyRef: string): Promise<unknown>;
}

export interface LamiAdapter extends InsurerAdapter {
  getProducts(): Promise<unknown>;
  getMotorProducts(): Promise<unknown>;
  getPolicy(ref: string): Promise<unknown>;
  issuePolicy(input: unknown): Promise<unknown>;
  getPolicyDocument(ref: string): Promise<unknown>;
  getRenewal(ref: string): Promise<unknown>;
  submitClaim(input: unknown): Promise<unknown>;
  getClaimStatus(ref: string): Promise<unknown>;
}

const LAMI = "LAMI CONTRACT REQUIRED: partner API docs, sandbox credentials, endpoint/auth/request/response/error/webhook schemas and product mapping are not yet supplied.";
const nc = () => { throw new NotConfiguredError(LAMI); };

export const lamiAdapter: LamiAdapter = {
  quote: nc, issue: nc, endorse: nc, renew: nc, fnol: nc, claimStatus: nc, documents: nc, cancel: nc,
  getProducts: nc, getMotorProducts: nc, getPolicy: nc, issuePolicy: nc, getPolicyDocument: nc, getRenewal: nc, submitClaim: nc, getClaimStatus: nc,
};

export interface PaymentAdapter {
  initiate(input: { quote_id: string; amount: number; currency: string; msisdn?: string }): Promise<unknown>;
}
export const paymentAdapter: PaymentAdapter = {
  initiate: () => { throw new NotConfiguredError("EXTERNAL PROVIDER CONTRACT REQUIRED: payment provider (e.g. M-Pesa/aggregator) and Lipa Pole Pole financing provider are not yet selected."); },
};

export interface OcrAdapter {
  extract(documentId: string, docType: "ID_FRONT" | "LOGBOOK"): Promise<{ status: "UNAVAILABLE" | "OK"; fields?: Record<string, string>; confidence?: number }>;
}
/** No OCR provider selected: documents are stored and routed to human review; AI never makes decisions. */
export const ocrAdapter: OcrAdapter = { extract: async () => ({ status: "UNAVAILABLE" }) };

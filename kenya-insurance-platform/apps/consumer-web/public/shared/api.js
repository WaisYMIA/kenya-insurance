// Thin API client. Set window.API_BASE before this script loads to point elsewhere.
window.API_BASE = window.API_BASE || "http://localhost:4000";

async function apiRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(window.API_BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

const Api = {
  health: () => apiRequest("/health"),
  listProducts: () => apiRequest("/v1/products"),
  createAssessment: () => apiRequest("/api/v1/needs/assessments", { method: "POST" }),
  saveAnswer: (assessmentId, question_id, value) =>
    apiRequest(`/api/v1/needs/assessments/${assessmentId}/answers`, { method: "POST", body: { question_id, value } }),
  decideQuote: (input) => apiRequest("/v1/quotes/decide", { method: "POST", body: input }),
  getFlows: () => apiRequest("/v1/flows"),
  getLearn: () => apiRequest("/v1/learn"),
  createClaim: (input) => apiRequest("/v1/claims", { method: "POST", body: input }),
  getClaimStatus: (ref, phone) => apiRequest(`/v1/claims/status?ref=${encodeURIComponent(ref)}&phone=${encodeURIComponent(phone)}`),
  recordEvent: (type, extra) => apiRequest("/v1/events", { method: "POST", body: { type, attempt: (window._attemptId ??= (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()))), ...extra } }).catch(() => {}),
  createLead: (input) => apiRequest("/v1/leads", { method: "POST", body: input }),
  getDecisionTrace: (id) => apiRequest(`/v1/decisions/${id}`),
};

// Floating "Chat on WhatsApp" button (click-to-chat; works with no API credentials).
(function () {
  const number = window.OWNER_WA || "254724888057";
  const link = document.createElement("a");
  link.href = "https://wa.me/" + number + "?text=" + encodeURIComponent("Hi, I'd like help with insurance.");
  link.target = "_blank"; link.rel = "noopener";
  link.textContent = "💬 Chat on WhatsApp";
  link.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:50;background:#25D366;color:#073b1a;font-weight:700;padding:12px 16px;border-radius:99px;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.2);font-family:system-ui,sans-serif;font-size:14px";
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(link));
})();

// Extends staff.html: Claims, Renewals, Analytics and Admin (approval-controlled config) tabs.
// Reuses call()/token/me/$/waLink/esc defined in staff.html's inline script (shared classic-script scope).
const TABS = ["Inbox", "Claims", "Renewals", "Analytics", "Admin"];

function showTab(name) {
  for (const t of TABS) { const el = document.getElementById("tab" + t); if (el) el.hidden = t !== name; const nav = document.getElementById("nav" + t); if (nav) nav.classList.toggle("active", t === name); }
  if (name === "Claims") loadClaims();
  if (name === "Renewals") loadRenewals();
  if (name === "Analytics") loadAnalytics();
  if (name === "Admin") loadAdminConfig();
}
document.addEventListener("DOMContentLoaded", () => {
  for (const t of TABS) { const nav = document.getElementById("nav" + t); if (nav) nav.addEventListener("click", (e) => { e.preventDefault(); showTab(t); }); }
});

const origStart = window.start;
window.start = async function () {
  await origStart();
  for (const t of ["Claims", "Renewals", "Analytics"]) document.getElementById("nav" + t).hidden = false;
  document.getElementById("navAdmin").hidden = me.role !== "ADMIN";
};

// ---------------- Claims ----------------
async function loadClaims() {
  const el = document.getElementById("tabClaims");
  const { claims } = await call("/v1/claims");
  el.innerHTML = `<h2>Claims (${claims.length})</h2>` + (claims.length ? `<table class="simple"><tr><th>Ref</th><th>Name</th><th>Area</th><th>Status</th><th>Reported</th><th></th></tr>${claims.map((c) => `
    <tr><td>${esc(c.claim_ref)} ${c.priority === "URGENT" ? '<span class="tag URGENT">URGENT</span>' : ""}</td>
      <td><a target="_blank" rel="noopener" href="${esc(waLink(c.contact_phone))}">${esc(c.contact_name)}</a></td>
      <td>${esc(c.cover_area)}</td>
      <td><select data-id="${esc(c.claim_id)}" class="claimStatus">${["NEW", "ACKNOWLEDGED", "IN_REVIEW", "CLOSED"].map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
      <td>${new Date(c.created_at).toLocaleDateString()}</td>
      <td><button class="btn btn-ghost claimShow" data-id="${esc(c.claim_id)}">Details</button></td></tr>`).join("")}</table>` : "<p>No claims yet.</p>") + `<div id="claimDetail"></div>`;
  el.querySelectorAll(".claimStatus").forEach((s) => s.addEventListener("change", async () => { await call("/v1/claims/" + s.dataset.id, { method: "PATCH", body: { status: s.value } }); }));
  el.querySelectorAll(".claimShow").forEach((b) => b.addEventListener("click", () => {
    const c = claims.find((x) => x.claim_id === b.dataset.id);
    document.getElementById("claimDetail").innerHTML = `<div class="card" style="margin-top:12px"><h3>${esc(c.claim_ref)}</h3>
      <p><strong>Policy:</strong> ${esc(c.policy_number)} · <strong>When:</strong> ${esc(c.incident_date)} · <strong>Where:</strong> ${esc(c.location)}</p>
      <p><strong>What happened:</strong> ${esc(c.description)}</p>
      <p><strong>Injuries:</strong> ${c.injuries ? "Yes" : "No"} · <strong>Police/OB:</strong> ${esc(c.police_ref)}</p></div>`;
  }));
}

// ---------------- Renewals ----------------
async function loadRenewals() {
  const el = document.getElementById("tabRenewals");
  el.innerHTML = `<div class="row"><h2 style="flex:1;margin:0">Renewals</h2>
      <select id="rStatus" style="width:auto"><option value="">All</option><option>ACTIVE</option><option>RENEWED</option><option>LAPSED</option><option>CANCELLED</option></select>
      <button class="btn btn-ghost" id="rRun">Run reminders now</button></div>
    <form id="rForm" class="row" style="flex-wrap:wrap">
      <input id="rName" placeholder="Customer name" required style="flex:1;min-width:140px">
      <input id="rPhone" placeholder="Phone" required style="flex:1;min-width:120px">
      <input id="rProduct" placeholder="Product / policy name" required style="flex:1;min-width:160px">
      <input id="rExpiry" type="date" required style="width:auto">
      <input id="rPremium" placeholder="Premium KES" style="width:120px">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="rConsent" style="width:auto">Reminders OK</label>
      <button class="btn btn-primary">Add</button></form>
    <div class="row"><input type="file" id="rCsv" accept=".csv"><button class="btn btn-ghost" id="rImport">Import CSV</button>
      <small style="color:var(--color-muted)">columns: customer_name,customer_phone,product_name,expiry_date,insurer,policy_number,premium_kes,reminders_consent,notes</small></div>
    <div id="rMsg" style="font-size:14px"></div>
    <div id="rTable"></div>`;
  $("rStatus").addEventListener("change", refreshRenewals);
  document.getElementById("rForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await call("/v1/renewals", { method: "POST", body: { customer_name: $("rName").value, customer_phone: $("rPhone").value, product_name: $("rProduct").value, expiry_date: $("rExpiry").value, premium_kes: $("rPremium").value || undefined, reminders_consent: $("rConsent").checked } });
      e.target.reset(); refreshRenewals(); } catch (err) { $("rMsg").textContent = err.data?.message || err.message; }
  });
  document.getElementById("rImport").addEventListener("click", async () => {
    const f = document.getElementById("rCsv").files[0]; if (!f) return;
    const text = await f.text();
    const res = await fetch(window.API_BASE + "/v1/renewals/import", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "text/csv" }, body: text });
    const data = await res.json(); $("rMsg").textContent = `Imported ${data.created}, ${data.errors?.length || 0} error(s).`; refreshRenewals();
  });
  document.getElementById("rRun").addEventListener("click", async () => { const r = await call("/v1/renewals/run-reminders", { method: "POST" }); $("rMsg").textContent = `Checked ${r.checked}, ${r.reminders.length} reminder(s) sent to owner.`; refreshRenewals(); });
  refreshRenewals();
}
async function refreshRenewals() {
  const q = $("rStatus").value ? `?status=${$("rStatus").value}` : "";
  const { renewals } = await call("/v1/renewals" + q);
  document.getElementById("rTable").innerHTML = renewals.length ? `<table class="simple"><tr><th>Customer</th><th>Product</th><th>Expiry</th><th>Status</th><th></th></tr>${renewals.map((r) => `
    <tr><td><a target="_blank" rel="noopener" href="${esc(waLink(r.customer_phone))}">${esc(r.customer_name)}</a></td><td>${esc(r.product_name)}</td><td>${esc(r.expiry_date)}</td>
      <td><select data-id="${esc(r.renewal_id)}" class="renStatus">${["ACTIVE", "RENEWED", "LAPSED", "CANCELLED"].map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select></td><td></td></tr>`).join("")}</table>` : "<p>No renewals.</p>";
  document.querySelectorAll(".renStatus").forEach((s) => s.addEventListener("change", async () => { await call("/v1/renewals/" + s.dataset.id, { method: "PATCH", body: { status: s.value } }); }));
}

// ---------------- Analytics ----------------
async function loadAnalytics() {
  const el = document.getElementById("tabAnalytics");
  const f = await call("/v1/analytics/funnel?days=30");
  const stageRow = (s) => `<tr><td>${esc(s.label)}</td><td>${s.count}</td><td>${s.pct_of_previous ?? "—"}%</td><td>${s.pct_of_start ?? "—"}%</td></tr>`;
  el.innerHTML = `<h2>Funnel — last ${f.period_days} days</h2>
    <h3>WhatsApp</h3><table class="simple"><tr><th>Stage</th><th>Count</th><th>% of previous</th><th>% of start</th></tr>${f.whatsapp.stages.map(stageRow).join("")}</table>
    <p style="font-size:14px;color:var(--color-muted)">In progress: ${f.whatsapp.in_progress} · Abandoned (&gt;${f.whatsapp.abandon_after_hours}h idle): ${f.whatsapp.abandoned} · Adviser handoffs: ${f.whatsapp.adviser_handoffs}</p>
    <h3>Web</h3><p>Started: ${f.web.enquiries_started} · Reached contact step: ${f.web.reached_contact_step} · Submitted: ${f.web.submitted}</p>
    <h3>Leads (${f.leads.total})</h3><p>By line: ${Object.entries(f.leads.by_line).map(([k, v]) => `${esc(k)}: ${v}`).join(", ") || "—"}<br>By status: ${Object.entries(f.leads.by_status).map(([k, v]) => `${esc(k)}: ${v}`).join(", ") || "—"}<br>Median minutes to first staff action: ${f.leads.median_minutes_to_first_action ?? "—"} (n=${f.leads.with_first_action})</p>
    <h3>Claims (${f.claims.total})</h3><p>Urgent: ${f.claims.urgent} · ${Object.entries(f.claims.by_status).map(([k, v]) => `${esc(k)}: ${v}`).join(", ") || "—"}</p>
    <h3>Renewals</h3><p>Active: ${f.renewals.active} · Overdue: ${f.renewals.overdue} · Due within 30 days: ${f.renewals.due_within_30_days}</p>
    <h3>Motor</h3><p>Quote requests: ${f.motor.quote_requests} · Referred: ${f.motor.referred}<br>By category: ${Object.entries(f.motor.by_vehicle_category).map(([k, v]) => `${esc(k)}: ${v}`).join(", ") || "—"}</p>`;
}

// ---------------- Admin: approval-controlled config ----------------
async function loadAdminConfig() {
  const el = document.getElementById("tabAdmin");
  if (me.role !== "ADMIN") { el.innerHTML = "<p>Admins only.</p>"; return; }
  el.innerHTML = `
    <h2>Approval-controlled configuration</h2>
    <p style="font-size:14px;color:var(--color-muted)">Every change is drafted, then approved by a <em>different</em> admin before it takes effect. Nothing here edits what customers see in place.</p>
    <div class="card">
      <h3>Motor: which vehicle categories get referred for review?</h3>
      <div class="row">${["MOTORCYCLE", "PRIVATE_CAR", "COMMERCIAL_VEHICLE", "PSV", "HIRE_REWARD", "OTHER"].map((c) => `<label style="display:flex;gap:6px"><input type="checkbox" class="catBox" value="${c}" ${["COMMERCIAL_VEHICLE", "PSV", "HIRE_REWARD"].includes(c) ? "checked" : ""}> ${c}</label>`).join("")}</div>
      <button class="btn btn-primary" id="draftCats">Draft change</button>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Add a new admin</h3>
      <form id="userForm" class="row">
        <input type="text" id="uName" placeholder="Name" required style="flex:1;min-width:140px">
        <input type="text" id="uEmail" placeholder="Email" required style="flex:1;min-width:180px">
        <input type="password" id="uPw" placeholder="Password (12+ chars)" required style="flex:1;min-width:180px;padding:12px 14px;border-radius:12px;border:1px solid var(--color-line);background:var(--color-surface);color:var(--color-text)">
        <select id="uRole" style="width:auto"><option>ADVISER</option><option>ADMIN</option></select>
        <button class="btn btn-primary">Create</button>
      </form>
      <div id="userMsg" style="font-size:14px"></div>
    </div>
    <h3 style="margin-top:16px">Pending your approval</h3><div id="pending"></div>
    <h3>Version history</h3><div id="history"></div>`;
  document.getElementById("draftCats").addEventListener("click", async () => {
    const categories = [...document.querySelectorAll(".catBox:checked")].map((c) => c.value);
    const v = await call("/v1/admin/config", { method: "POST", body: { kind: "rule", key: "motor.referral_categories", value: { categories }, note: "Changed from staff inbox" } });
    await call(`/v1/admin/config/${v.id}/submit`, { method: "POST" });
    refreshConfigLists();
  });
  document.getElementById("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { const r = await call("/v1/admin/users", { method: "POST", body: { name: $("uName").value, email: $("uEmail").value, password: $("uPw").value, role: $("uRole").value } }); $("userMsg").textContent = "Created " + r.email; e.target.reset(); }
    catch (err) { $("userMsg").textContent = "Couldn't create user: " + (err.data?.message || err.message); }
  });
  refreshConfigLists();
}
async function refreshConfigLists() {
  const { versions } = await call("/v1/admin/config");
  const pending = versions.filter((v) => v.status === "SUBMITTED");
  document.getElementById("pending").innerHTML = pending.length ? pending.map((v) => `
    <div class="lead-row"><strong>${esc(v.kind)}:${esc(v.key)}</strong> v${v.version} by ${esc(v.created_by)} ${v.note ? "— " + esc(v.note) : ""}<br>
      <pre style="white-space:pre-wrap;font-size:12px;background:var(--color-surface-2);padding:6px;border-radius:6px">${esc(JSON.stringify(v.value))}</pre>
      <button class="btn btn-primary approveBtn" data-id="${esc(v.id)}" ${v.created_by === me.email ? "disabled title='You drafted this — a different admin must approve it'" : ""}>Approve</button>
      <button class="btn btn-ghost rejectBtn" data-id="${esc(v.id)}">Reject</button></div>`).join("") : "<p style='color:var(--color-muted)'>Nothing pending.</p>";
  document.querySelectorAll(".approveBtn").forEach((b) => b.addEventListener("click", async () => { try { await call(`/v1/admin/config/${b.dataset.id}/approve`, { method: "POST" }); refreshConfigLists(); } catch (e) { alert(e.data?.message || e.message); } }));
  document.querySelectorAll(".rejectBtn").forEach((b) => b.addEventListener("click", async () => { await call(`/v1/admin/config/${b.dataset.id}/reject`, { method: "POST" }); refreshConfigLists(); }));
  document.getElementById("history").innerHTML = `<table class="simple"><tr><th>Kind:Key</th><th>v</th><th>Status</th><th>By</th><th>When</th></tr>${versions.slice(0, 20).map((v) => `<tr><td>${esc(v.kind)}:${esc(v.key)}</td><td>${v.version}</td><td>${esc(v.status)}</td><td>${esc(v.created_by)}</td><td>${new Date(v.created_at).toLocaleString()}</td></tr>`).join("")}</table>`;
}

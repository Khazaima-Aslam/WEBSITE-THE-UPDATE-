/* CKA BuildStruct — admin-operations.js
   Staff/admin operations workspace over CKABackend.
   Authorization remains enforced in PostgreSQL/RLS/RPCs. */
(function (global) {
  "use strict";

  const api = global.CKABackend;
  const client = global.CKAStore && global.CKAStore.supabase;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  const fmtDate = (value) => value ? new Intl.DateTimeFormat("en-PK", {
    dateStyle: "medium", timeStyle: "short"
  }).format(new Date(value)) : "—";
  const pkr = (value) => `PKR ${Number(value || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
  const shortId = (value) => value ? `${String(value).slice(0, 8)}…` : "—";

  if (!api || !client) {
    global.location.replace("admin-login.html");
    return;
  }

  const QUOTE_TRANSITIONS = {
    draft: ["submitted", "cancelled"],
    submitted: ["bidding", "quoted", "confirmed", "cancelled"],
    bidding: ["quoted", "confirmed", "cancelled"],
    quoted: ["bidding", "confirmed", "cancelled"],
    confirmed: ["delivered", "cancelled"],
    delivered: [],
    cancelled: []
  };

  const PROJECT_TRANSITIONS = {
    received: ["under_review", "estimating", "quoted", "archived"],
    under_review: ["estimating", "quoted", "archived"],
    estimating: ["under_review", "quoted", "archived"],
    quoted: ["estimating", "awarded", "archived"],
    awarded: ["in_progress", "archived"],
    in_progress: ["completed", "archived"],
    completed: ["archived"],
    archived: []
  };

  const state = {
    profile: null,
    summary: {},
    health: {},
    quotes: [],
    projects: [],
    inquiries: [],
    applications: [],
    suppliers: [],
    notifications: [],
    outbox: [],
    outboxSummary: {},
    audit: [],
    people: [],
    staff: [],
    refreshTimer: null,
    subscriptions: [],
    currentDrawer: null
  };

  function toast(message, kind) {
    const box = $("#toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast" + (kind === "warn" || kind === "error" ? " toast--warn" : "");
    el.innerHTML = `<span>${esc(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 300);
    }, 3600);
  }

  function personName(id) {
    if (!id) return "Unassigned";
    const p = state.people.find((x) => String(x.id) === String(id));
    return p?.full_name || p?.email || shortId(id);
  }

  function statusTone(status) {
    const s = String(status || "").toLowerCase();
    if (["approved", "verified", "delivered", "completed", "sent", "handled", "confirmed"].includes(s)) return "good";
    if (["cancelled", "rejected", "failed", "out_of_stock"].includes(s)) return "bad";
    if (["submitted", "received", "pending", "under_review", "quoted", "bidding", "estimating", "processing"].includes(s)) return "warn";
    if (["awarded", "in_progress"].includes(s)) return "info";
    return "muted";
  }

  function statusChip(status) {
    const label = String(status || "unknown").replace(/_/g, " ");
    return `<span class="ops__status" data-tone="${statusTone(status)}">${esc(label)}</span>`;
  }

  function detail(label, value) {
    return `<div class="ops__detail"><span>${esc(label)}</span><strong>${esc(value || "—")}</strong></div>`;
  }

  function detailText(label, value) {
    return `<div class="ops__detail"><span>${esc(label)}</span><p>${esc(value || "—")}</p></div>`;
  }

  function staffOptions(selected) {
    const options = ['<option value="">Unassigned</option>'];
    state.staff.forEach((p) => {
      const label = p.full_name || p.email || shortId(p.id);
      options.push(`<option value="${esc(p.id)}" ${String(p.id) === String(selected || "") ? "selected" : ""}>${esc(label)} · ${esc(p.role)}</option>`);
    });
    return options.join("");
  }

  function transitionOptions(current, map) {
    const allowed = map[current] || [];
    return [current, ...allowed].filter(Boolean).map((value) =>
      `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(value.replace(/_/g, " "))}</option>`
    ).join("");
  }

  function kpi(label, value, note, icon, kind) {
    return `<article class="ops__kpi ${kind ? `is-${kind}` : ""}">
      <div class="ops__kpi-top"><span class="ops__kpi-label">${esc(label)}</span><svg class="ic"><use href="#${esc(icon)}"/></svg></div>
      <strong>${esc(value)}</strong><small>${esc(note || "")}</small>
    </article>`;
  }

  function queueList(items, renderItem, emptyText) {
    if (!items.length) return `<p class="ops__empty-mini">${esc(emptyText)}</p>`;
    return `<ul class="ops__queue-list">${items.slice(0, 5).map(renderItem).join("")}</ul>`;
  }

  function setView(view) {
    $$(".adm__navlink[data-view]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === view));
    $$(".adm__view").forEach((section) => section.classList.toggle("is-active", section.dataset.view === view));
    global.scrollTo(0, 0);
  }

  async function loadPeople(limit) {
    let query = client.from("profiles").select("id,role,full_name,email,phone");
    if (Number.isInteger(limit) && limit > 0) query = query.limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function safe(name, promise, fallback) {
    try {
      return await promise;
    } catch (err) {
      console.error(`CKA OPS: ${name} load failed`, err);
      toast(`${name} could not be loaded.`, "warn");
      return fallback;
    }
  }

  async function loadAll(options) {
    const opts = options || {};
    const refresh = $("#ops-refresh");
    if (refresh) refresh.disabled = true;
    $("#ops-sync").textContent = "Syncing live data…";

    const [summary, health, quotes, projects, inquiries, applications, suppliers, notifications, outboxSummary, outbox, audit, people] = await Promise.all([
      safe("Dashboard summary", api.staff.summary(), {}),
      safe("Backend health", api.staff.health(), {}),
      safe("Quotations", api.staff.quotes.list(200), []),
      safe("Projects", api.staff.projects.list(200), []),
      safe("Inquiries", api.staff.inquiries.list(200), []),
      safe("Supplier applications", api.staff.supplierApplications.list(200), []),
      safe("Suppliers", api.staff.suppliers.list(500), []),
      safe("Notifications", api.notifications.list(200), []),
      safe("Outbox summary", api.staff.outbox.summary(), {}),
      safe("Notification outbox", api.staff.outbox.list(200), []),
      safe("Audit trail", api.staff.audit.list(200), []),
      safe("Profiles", loadPeople(1000), [])
    ]);

    Object.assign(state, { summary, health, quotes, projects, inquiries, applications, suppliers, notifications, outboxSummary, outbox, audit, people });
    state.staff = people.filter((p) => ["admin", "staff"].includes(p.role));

    renderAll();
    const now = new Date();
    $("#ops-sync").textContent = `Synced ${now.toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}`;
    if (refresh) refresh.disabled = false;
    if (!opts.silent) toast("Operations data refreshed.");
  }

  function renderAll() {
    renderNav();
    renderOverview();
    renderQuotes();
    renderProjects();
    renderInquiries();
    renderApplications();
    renderSuppliers();
    renderNotifications();
    renderSystem();
  }

  function renderNav() {
    const openQuotes = state.quotes.filter((q) => !["delivered", "cancelled"].includes(q.status)).length;
    const openProjects = state.projects.filter((p) => !["completed", "archived"].includes(p.status)).length;
    const openInquiries = state.inquiries.filter((i) => !i.is_handled).length;
    const openApps = state.applications.filter((a) => ["received", "under_review"].includes(a.status)).length;
    const unread = state.notifications.filter((n) => !n.read_at).length;
    $("#nav-quotes").textContent = openQuotes || "";
    $("#nav-projects").textContent = openProjects || "";
    $("#nav-inquiries").textContent = openInquiries || "";
    $("#nav-applications").textContent = openApps || "";
    $("#nav-notifications").textContent = unread || "";
  }

  function renderOverview() {
    const s = state.summary || {};
    const h = state.health || {};
    const outboxProblems = Number(h.outbox_failed || 0) + Number(h.outbox_pending || 0);
    $("#ops-kpis").innerHTML = [
      kpi("Quotations needing action", Number(s.quotes_submitted || 0) + Number(s.quotes_bidding || 0), `${s.quotes_submitted || 0} submitted · ${s.quotes_bidding || 0} bidding`, "i-file", Number(s.quotes_submitted || 0) ? "alert" : ""),
      kpi("Open projects", s.projects_open || 0, "Excludes completed and archived", "i-briefcase"),
      kpi("Open inquiries", s.inquiries_open || 0, "Customer follow-up queue", "i-inbox", Number(s.inquiries_open || 0) ? "alert" : ""),
      kpi("Supplier applications", s.supplier_applications_open || 0, `${s.suppliers_verified || 0} suppliers verified`, "i-users"),
      kpi("Active catalogue", s.products_active || 0, "Publicly active products", "i-box", "good"),
      kpi("Verified suppliers", s.suppliers_verified || 0, `${state.suppliers.length} supplier records`, "i-truck", "good"),
      kpi("Newsletter audience", s.newsletter_active || 0, "Active subscribers", "i-bell"),
      kpi("Delivery outbox", outboxProblems, `${h.outbox_failed || 0} failed · ${h.outbox_pending || 0} pending`, "i-activity", Number(h.outbox_failed || 0) ? "alert" : "")
    ].join("");

    const quoteQueue = state.quotes.filter((q) => !["delivered", "cancelled"].includes(q.status));
    $("#overview-quotes").innerHTML = queueList(quoteQueue, (q) => `<li><button data-open-quote="${esc(q.id)}"><strong>${esc(q.reference)}</strong><small>${esc(q.contact_name || "Customer")} · ${esc(q.delivery_city || "No city")}</small></button>${statusChip(q.status)}</li>`, "No active quotations yet.");

    const projectQueue = state.projects.filter((p) => !["completed", "archived"].includes(p.status));
    $("#overview-projects").innerHTML = queueList(projectQueue, (p) => `<li><button data-open-project="${esc(p.id)}"><strong>${esc(p.reference)} · ${esc(p.project_name || p.project_type || "Project")}</strong><small>${esc(p.client_name || "Client")} · ${esc(p.progress_pct || 0)}% complete</small></button>${statusChip(p.status)}</li>`, "No active projects yet.");

    const inquiryQueue = state.inquiries.filter((i) => !i.is_handled);
    $("#overview-inquiries").innerHTML = queueList(inquiryQueue, (i) => `<li><button data-open-view="inquiries"><strong>${esc(i.name || "Inquiry")}</strong><small>${esc(i.subject || "General inquiry")} · ${fmtDate(i.created_at)}</small></button>${statusChip("received")}</li>`, "No unresolved inquiries.");

    const appQueue = state.applications.filter((a) => ["received", "under_review"].includes(a.status));
    $("#overview-applications").innerHTML = queueList(appQueue, (a) => `<li><button data-open-application="${esc(a.id)}"><strong>${esc(a.business_name)}</strong><small>${esc(a.city)} · ${esc(a.category)}</small></button>${statusChip(a.status)}</li>`, "No supplier applications waiting.");

    $("#overview-health").innerHTML = [
      ["Outbox pending", h.outbox_pending || 0],
      ["Outbox failed", h.outbox_failed || 0],
      ["Unhandled inquiries", h.unhandled_inquiries || 0],
      ["Pending applications", h.pending_supplier_applications || 0],
      ["Last audit activity", h.last_audit_at ? fmtDate(h.last_audit_at) : "No activity yet"]
    ].map(([label, value]) => `<article class="adm__card"><h3>${esc(label)}</h3><strong>${esc(value)}</strong></article>`).join("");
  }

  function renderQuotes() {
    const q = $("#quote-search").value.trim().toLowerCase();
    const status = $("#quote-status").value;
    const list = state.quotes.filter((row) => {
      if (status && row.status !== status) return false;
      if (!q) return true;
      return [row.reference, row.contact_name, row.contact_phone, row.contact_email, row.delivery_city].join(" ").toLowerCase().includes(q);
    });
    $("#quote-empty").hidden = list.length > 0;
    $("#quote-rows").innerHTML = list.map((row) => `<tr data-open="quote" data-id="${esc(row.id)}">
      <td class="ops__cell-main"><strong>${esc(row.reference)}</strong><small>${fmtDate(row.submitted_at)}</small></td>
      <td class="ops__cell-main"><strong>${esc(row.contact_name || "—")}</strong><small>${esc(row.contact_phone || row.contact_email || "No contact")}</small></td>
      <td>${esc(row.delivery_city || "—")}<small>${esc(row.delivery_address || "")}</small></td>
      <td class="num"><strong>${pkr(row.subtotal)}</strong></td>
      <td>${statusChip(row.status)}</td>
      <td>${esc(personName(row.assigned_to))}</td>
      <td><button class="ops__row-btn" data-open-quote="${esc(row.id)}">Open<svg class="ic"><use href="#i-chevron"/></svg></button></td>
    </tr>`).join("");
  }

  function renderProjects() {
    const q = $("#project-search").value.trim().toLowerCase();
    const status = $("#project-status").value;
    const list = state.projects.filter((row) => {
      if (status && row.status !== status) return false;
      if (!q) return true;
      return [row.reference, row.client_name, row.company, row.project_name, row.project_type, row.location].join(" ").toLowerCase().includes(q);
    });
    $("#project-empty").hidden = list.length > 0;
    $("#project-rows").innerHTML = list.map((row) => `<tr data-open="project" data-id="${esc(row.id)}">
      <td class="ops__cell-main"><strong>${esc(row.reference)}</strong><small>${fmtDate(row.created_at)}</small></td>
      <td class="ops__cell-main"><strong>${esc(row.project_name || row.project_type || "Project")}</strong><small>${esc(row.location || "No location")}</small></td>
      <td>${esc(row.client_name || "—")}<small>${esc(row.phone || row.email || "")}</small></td>
      <td><div class="ops__progress"><div class="ops__progress-bar"><i style="width:${Math.max(0, Math.min(100, Number(row.progress_pct || 0)))}%"></i></div><small>${esc(row.progress_pct || 0)}%</small></div></td>
      <td>${statusChip(row.status)}</td>
      <td>${esc(personName(row.assigned_to))}</td>
      <td><button class="ops__row-btn" data-open-project="${esc(row.id)}">Open<svg class="ic"><use href="#i-chevron"/></svg></button></td>
    </tr>`).join("");
  }

  function renderInquiries() {
    const q = $("#inquiry-search").value.trim().toLowerCase();
    const status = $("#inquiry-status").value;
    const list = state.inquiries.filter((row) => {
      if (status === "open" && row.is_handled) return false;
      if (status === "handled" && !row.is_handled) return false;
      if (!q) return true;
      return [row.name, row.email, row.phone, row.subject, row.message].join(" ").toLowerCase().includes(q);
    });
    $("#inquiry-empty").hidden = list.length > 0;
    $("#inquiry-rows").innerHTML = list.map((row) => `<tr>
      <td class="ops__cell-main"><strong>${esc(row.name || "—")}</strong><small>${esc(row.email || row.phone || "No contact")}</small></td>
      <td class="ops__cell-main"><strong>${esc(row.subject || "General inquiry")}</strong><small>${esc((row.message || "").slice(0, 90))}</small></td>
      <td>${esc(row.source || "website")}</td>
      <td>${fmtDate(row.created_at)}</td>
      <td>${statusChip(row.is_handled ? "handled" : "received")}</td>
      <td><button class="btn btn--ghost btn--sm" data-toggle-inquiry="${esc(row.id)}" data-handled="${row.is_handled ? "1" : "0"}">${row.is_handled ? "Reopen" : "Mark handled"}</button></td>
    </tr>`).join("");
  }

  function renderApplications() {
    const q = $("#application-search").value.trim().toLowerCase();
    const status = $("#application-status").value;
    const list = state.applications.filter((row) => {
      if (status && row.status !== status) return false;
      if (!q) return true;
      return [row.reference, row.business_name, row.contact_person, row.city, row.category, row.phone, row.email].join(" ").toLowerCase().includes(q);
    });
    $("#application-empty").hidden = list.length > 0;
    $("#application-rows").innerHTML = list.map((row) => `<tr data-open="application" data-id="${esc(row.id)}">
      <td class="ops__cell-main"><strong>${esc(row.reference)}</strong><small>${esc(row.contact_person || "")}</small></td>
      <td class="ops__cell-main"><strong>${esc(row.business_name)}</strong><small>${esc(row.phone || row.email || "")}</small></td>
      <td>${esc(row.category || "—")}</td><td>${esc(row.city || "—")}</td><td>${statusChip(row.status)}</td><td>${fmtDate(row.submitted_at)}</td>
      <td><button class="ops__row-btn" data-open-application="${esc(row.id)}">Review<svg class="ic"><use href="#i-chevron"/></svg></button></td>
    </tr>`).join("");
  }

  function renderSuppliers() {
    const q = $("#supplier-search").value.trim().toLowerCase();
    const status = $("#supplier-status").value;
    const list = state.suppliers.filter((row) => {
      if (status === "verified" && !row.is_verified) return false;
      if (status === "unverified" && row.is_verified) return false;
      if (status === "linked" && !row.profile_id) return false;
      if (status === "unlinked" && row.profile_id) return false;
      if (!q) return true;
      return [row.company_name, row.contact_person, row.city, row.email, row.phone].join(" ").toLowerCase().includes(q);
    });
    $("#supplier-empty").hidden = list.length > 0;
    $("#supplier-rows").innerHTML = list.map((row) => `<tr data-open="supplier" data-id="${esc(row.id)}">
      <td class="ops__cell-main"><strong>${esc(row.company_name)}</strong><small>${esc(row.email || row.phone || "")}</small></td>
      <td>${esc(row.contact_person || "—")}</td><td>${esc(row.city || "—")}</td><td>${row.reliability_pct == null ? "—" : `${esc(row.reliability_pct)}%`}</td>
      <td>${statusChip(row.is_verified ? "verified" : "unverified")}</td>
      <td>${row.profile_id ? '<span class="ops__badge">Login linked</span>' : '<span class="ops__badge">No login</span>'}</td>
      <td><button class="ops__row-btn" data-open-supplier="${esc(row.id)}">Manage<svg class="ic"><use href="#i-chevron"/></svg></button></td>
    </tr>`).join("");
  }

  function renderNotifications() {
    $("#notification-empty").hidden = state.notifications.length > 0;
    $("#notification-rows").innerHTML = state.notifications.map((row) => `<tr class="${row.read_at ? "" : "ops__unread"}">
      <td><strong>${esc(row.title || row.kind || "Notification")}</strong><small>${esc(row.kind || "")}</small></td>
      <td class="ops__notification-message">${esc(row.body || "—")}</td>
      <td>${esc(personName(row.user_id))}</td><td>${fmtDate(row.created_at)}</td><td>${statusChip(row.read_at ? "read" : "pending")}</td>
      <td>${row.read_at ? "" : `<button class="btn btn--ghost btn--sm" data-read-notification="${esc(row.id)}">Mark read</button>`}</td>
    </tr>`).join("");
  }

  function renderSystem() {
    const h = state.health || {};
    $("#system-health").innerHTML = [
      kpi("Active products", h.active_products || 0, "Catalogue", "i-box", "good"),
      kpi("Open quotes", h.open_quotes || 0, "Commercial workflow", "i-file"),
      kpi("Open projects", h.open_projects || 0, "Delivery workflow", "i-briefcase"),
      kpi("Outbox failures", h.outbox_failed || 0, h.oldest_pending_outbox ? `Oldest pending ${fmtDate(h.oldest_pending_outbox)}` : "No delayed queue", "i-alert", Number(h.outbox_failed || 0) ? "alert" : "")
    ].join("");

    const os = state.outboxSummary || {};
    $("#outbox-summary").innerHTML = `<div class="ops__summary-pills"><span>${esc(os.pending || 0)} pending</span><span>${esc(os.processing || 0)} processing</span><span>${esc(os.failed || 0)} failed</span><span>${esc(os.sent || 0)} sent</span></div>`;
    $("#outbox-rows").innerHTML = state.outbox.length ? state.outbox.map((row) => {
      const recipient = row.recipient_email || row.recipient_phone || personName(row.recipient_user_id);
      return `<tr><td>${esc(row.payload?.channel || row.event_key?.split(":")[0] || "event")}</td><td>${esc(recipient)}</td><td>${esc(row.event_key || "—")}</td><td>${statusChip(row.status)}</td><td>${esc(row.attempts || 0)}</td><td>${fmtDate(row.created_at)}</td></tr>`;
    }).join("") : '<tr><td colspan="6"><p class="ops__empty-mini">The delivery outbox is empty.</p></td></tr>';

    $("#audit-rows").innerHTML = state.audit.length ? state.audit.map((row) => `<tr><td>${fmtDate(row.created_at)}</td><td>${esc(personName(row.actor_id))}</td><td>${esc(row.action || "—")}</td><td>${esc(row.entity_type || "—")}</td><td><code>${esc(shortId(row.entity_id))}</code></td></tr>`).join("") : '<tr><td colspan="5"><p class="ops__empty-mini">No audit activity yet.</p></td></tr>';
  }

  function openDrawer(eyebrow, title) {
    $("#ops-drawer-eyebrow").textContent = eyebrow;
    $("#ops-drawer-title").textContent = title;
    $("#ops-drawer-body").innerHTML = '<div class="ops__drawer-loading">Loading live details…</div>';
    $("#ops-drawer-foot").innerHTML = '';
    $("#ops-drawer").classList.add("is-open");
    $("#ops-drawer").setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    state.currentDrawer = null;
    $("#ops-drawer").classList.remove("is-open");
    $("#ops-drawer").setAttribute("aria-hidden", "true");
  }

  async function openQuote(id) {
    const row = state.quotes.find((x) => String(x.id) === String(id));
    if (!row) return;
    state.currentDrawer = { type: "quote", id };
    openDrawer("Quotation", row.reference);

    try {
      const [items, bids] = await Promise.all([
        api.staff.quotes.items(id),
        api.staff.bids.listForQuote(id)
      ]);
      const itemHtml = items.length ? `<ul class="ops__lineitems">${items.map((item) => `<li><div><strong>${esc(item.name_snapshot)}</strong><small>${esc(item.quantity)} ${esc(item.unit_snapshot)} × ${pkr(item.unit_price)}</small></div><b>${pkr(item.line_total)}</b></li>`).join("")}</ul>` : '<p class="ops__muted">No line items are attached to this quotation.</p>';
      const bidHtml = bids.length ? bids.map((bid) => `<article class="ops__bid ${bid.is_awarded ? "is-awarded" : ""}"><div class="ops__bid-head"><div><strong>${pkr(bid.rate)}</strong><div class="ops__bid-meta">${bid.delivery_days == null ? "Delivery not stated" : `${esc(bid.delivery_days)} days`} · Supplier ${esc(shortId(bid.supplier_id))}</div></div>${bid.is_awarded ? statusChip("awarded") : `<button class="btn btn--ghost btn--sm" data-award-bid="${esc(bid.id)}">Award bid</button>`}</div>${bid.terms ? `<p class="ops__bid-terms">${esc(bid.terms)}</p>` : ""}</article>`).join("") : '<p class="ops__muted">No supplier bids have been submitted.</p>';

      $("#ops-drawer-body").innerHTML = `
        <div class="ops__detail-grid">
          ${detail("Customer", row.contact_name)}${detail("Phone", row.contact_phone)}${detail("Email", row.contact_email)}${detail("Submitted", fmtDate(row.submitted_at))}
          ${detail("Delivery city", row.delivery_city)}${detailText("Delivery address", row.delivery_address)}${detail("Payment preference", row.payment_pref)}${detail("Subtotal", pkr(row.subtotal))}
        </div>
        <section class="ops__section"><h3>Workflow control</h3><div class="ops__form-grid">
          <label class="field"><span>Status</span><select class="select" id="drawer-quote-status">${transitionOptions(row.status, QUOTE_TRANSITIONS)}</select></label>
          <label class="field"><span>Assigned staff</span><select class="select" id="drawer-quote-assignee">${staffOptions(row.assigned_to)}</select></label>
          <label class="field field--wide"><span>Internal notes</span><textarea class="input" id="drawer-quote-notes" rows="3" placeholder="Internal staff notes">${esc(row.internal_notes || "")}</textarea></label>
        </div></section>
        <section class="ops__section"><div class="ops__section-head"><h3>Line items</h3><strong>${pkr(row.subtotal)}</strong></div>${itemHtml}</section>
        <section class="ops__section"><div class="ops__section-head"><h3>Supplier bids</h3><span class="ops__muted">${bids.length} bid${bids.length === 1 ? "" : "s"}</span></div>${bidHtml}</section>
        ${row.notes ? `<section class="ops__section"><h3>Customer notes</h3><p class="ops__muted">${esc(row.notes)}</p></section>` : ""}`;
      $("#ops-drawer-foot").innerHTML = '<button class="btn btn--ghost" data-close-ops-drawer>Close</button><button class="btn btn--brand" data-save-quote>Save workflow changes</button>';
    } catch (err) {
      console.error("CKA OPS quote detail failed", err);
      $("#ops-drawer-body").innerHTML = `<div class="ops__drawer-error">${esc(err.message || "Could not load quotation details.")}</div>`;
    }
  }

  async function openProject(id) {
    const row = state.projects.find((x) => String(x.id) === String(id));
    if (!row) return;
    state.currentDrawer = { type: "project", id };
    openDrawer("Project", row.reference);
    try {
      const files = await api.staff.projects.files(id);
      const filesHtml = files.length ? `<ul class="ops__lineitems">${files.map((file) => `<li><div><strong>${esc(file.original_name || file.kind || "File")}</strong><small>${esc(file.kind || "document")} · ${file.size_bytes ? `${Math.round(Number(file.size_bytes) / 1024)} KB` : "size unavailable"}</small></div><b>${fmtDate(file.uploaded_at)}</b></li>`).join("")}</ul>` : '<p class="ops__muted">No project files are attached.</p>';
      $("#ops-drawer-body").innerHTML = `
        <div class="ops__detail-grid">${detail("Client", row.client_name)}${detail("Company", row.company)}${detail("Phone", row.phone)}${detail("Email", row.email)}${detail("Project", row.project_name || row.project_type)}${detail("Location", row.location)}${detail("Budget minimum", row.budget_min == null ? "—" : pkr(row.budget_min))}${detail("Budget maximum", row.budget_max == null ? "—" : pkr(row.budget_max))}</div>
        <section class="ops__section"><h3>Workflow control</h3><div class="ops__form-grid">
          <label class="field"><span>Status</span><select class="select" id="drawer-project-status">${transitionOptions(row.status, PROJECT_TRANSITIONS)}</select></label>
          <label class="field"><span>Progress %</span><input class="input" id="drawer-project-progress" type="number" min="0" max="100" value="${esc(row.progress_pct || 0)}" /></label>
          <label class="field"><span>Assigned staff</span><select class="select" id="drawer-project-assignee">${staffOptions(row.assigned_to)}</select></label>
          <label class="field"><span>Expected completion</span><input class="input" value="${esc(row.expected_completion || "")}" disabled /></label>
          <label class="field field--wide"><span>Project notes</span><textarea class="input" id="drawer-project-notes" rows="3">${esc(row.notes || "")}</textarea></label>
        </div></section>
        ${row.scope ? `<section class="ops__section"><h3>Scope</h3><p class="ops__muted">${esc(row.scope)}</p></section>` : ""}
        <section class="ops__section"><div class="ops__section-head"><h3>Project files</h3><span class="ops__muted">${files.length} file${files.length === 1 ? "" : "s"}</span></div>${filesHtml}</section>`;
      $("#ops-drawer-foot").innerHTML = '<button class="btn btn--ghost" data-close-ops-drawer>Close</button><button class="btn btn--brand" data-save-project>Save project changes</button>';
    } catch (err) {
      console.error("CKA OPS project detail failed", err);
      $("#ops-drawer-body").innerHTML = `<div class="ops__drawer-error">${esc(err.message || "Could not load project details.")}</div>`;
    }
  }

  function openApplication(id) {
    const row = state.applications.find((x) => String(x.id) === String(id));
    if (!row) return;
    state.currentDrawer = { type: "application", id };
    openDrawer("Supplier application", row.reference);
    $("#ops-drawer-body").innerHTML = `
      <div class="ops__detail-grid">${detail("Business", row.business_name)}${detail("Contact", row.contact_person)}${detail("Phone", row.phone)}${detail("Email", row.email)}${detail("City", row.city)}${detail("Category", row.category)}${detail("Submitted", fmtDate(row.submitted_at))}${detail("Current status", row.status)}</div>
      ${row.business_details ? `<section class="ops__section"><h3>Business details</h3><p class="ops__muted">${esc(row.business_details)}</p></section>` : ""}
      <section class="ops__section"><h3>Review decision</h3><div class="ops__form-grid"><label class="field"><span>Decision</span><select class="select" id="drawer-application-decision"><option value="under_review" ${row.status === "under_review" ? "selected" : ""}>Under review</option><option value="approved" ${row.status === "approved" ? "selected" : ""}>Approve</option><option value="rejected" ${row.status === "rejected" ? "selected" : ""}>Reject</option></select></label><div></div><label class="field field--wide"><span>Review notes</span><textarea class="input" id="drawer-application-notes" rows="4">${esc(row.review_notes || "")}</textarea></label></div></section>
      ${row.supplier_id ? `<section class="ops__section"><p class="ops__muted">Approved supplier record: <code>${esc(row.supplier_id)}</code></p></section>` : ""}`;
    $("#ops-drawer-foot").innerHTML = '<button class="btn btn--ghost" data-close-ops-drawer>Close</button><button class="btn btn--brand" data-save-application>Save review</button>';
  }

  function openSupplier(id) {
    const row = state.suppliers.find((x) => String(x.id) === String(id));
    if (!row) return;
    state.currentDrawer = { type: "supplier", id };
    openDrawer("Supplier", row.company_name);
    $("#ops-drawer-body").innerHTML = `
      <div class="ops__detail-grid">${detail("Contact", row.contact_person)}${detail("Phone", row.phone)}${detail("Email", row.email)}${detail("City", row.city)}${detail("Rating", row.rating == null ? "—" : row.rating)}${detail("Created", fmtDate(row.created_at))}${detail("Login account", row.profile_id ? personName(row.profile_id) : "Not linked")}${detail("Verified at", fmtDate(row.verified_at))}</div>
      <section class="ops__section"><h3>Trust controls</h3><div class="ops__form-grid"><label class="field"><span>Verification</span><select class="select" id="drawer-supplier-verified"><option value="1" ${row.is_verified ? "selected" : ""}>Verified</option><option value="0" ${!row.is_verified ? "selected" : ""}>Not verified</option></select></label><label class="field"><span>Reliability %</span><input class="input" id="drawer-supplier-reliability" type="number" min="0" max="100" value="${esc(row.reliability_pct == null ? "" : row.reliability_pct)}" /></label><label class="field field--wide"><span>Internal notes</span><textarea class="input" id="drawer-supplier-notes" rows="4">${esc(row.notes || "")}</textarea></label></div></section>
      <section class="ops__section"><h3>Account link</h3><p class="ops__muted">${row.profile_id ? `This supplier is linked to ${esc(personName(row.profile_id))}.` : "No supplier login is linked. Account linking requires a dedicated non-staff profile and remains administrator-controlled."}</p>${row.profile_id && state.profile?.role === "admin" ? '<div class="ops__inline-actions"><button class="btn btn--ghost btn--sm" data-unlink-supplier>Unlink supplier login</button></div>' : ""}</section>`;
    $("#ops-drawer-foot").innerHTML = '<button class="btn btn--ghost" data-close-ops-drawer>Close</button><button class="btn btn--brand" data-save-supplier>Save supplier controls</button>';
  }

  async function saveQuote() {
    const current = state.currentDrawer;
    const row = state.quotes.find((x) => String(x.id) === String(current?.id));
    if (!row) return;
    const status = $("#drawer-quote-status").value;
    const assignee = $("#drawer-quote-assignee").value || null;
    const notes = $("#drawer-quote-notes").value.trim();
    try {
      if (String(assignee || "") !== String(row.assigned_to || "")) await api.staff.quotes.assign(row.id, assignee);
      if (status !== row.status || notes) await api.staff.quotes.update(row.id, { status: status !== row.status ? status : null, internalNotes: notes || null });
      toast("Quotation workflow updated.");
      closeDrawer();
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS quote save failed", err);
      toast(err.message || "Could not update quotation.", "error");
    }
  }

  async function saveProject() {
    const current = state.currentDrawer;
    const row = state.projects.find((x) => String(x.id) === String(current?.id));
    if (!row) return;
    const status = $("#drawer-project-status").value;
    const progress = Number($("#drawer-project-progress").value);
    const assignee = $("#drawer-project-assignee").value || null;
    const notes = $("#drawer-project-notes").value.trim();
    try {
      if (String(assignee || "") !== String(row.assigned_to || "")) await api.staff.projects.assign(row.id, assignee);
      await api.staff.projects.update(row.id, {
        status: status !== row.status ? status : null,
        progressPct: progress !== Number(row.progress_pct || 0) ? progress : null,
        notes: notes || null
      });
      toast("Project workflow updated.");
      closeDrawer();
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS project save failed", err);
      toast(err.message || "Could not update project.", "error");
    }
  }

  async function saveApplication() {
    const current = state.currentDrawer;
    if (!current) return;
    try {
      await api.staff.supplierApplications.review(current.id, $("#drawer-application-decision").value, $("#drawer-application-notes").value.trim() || null);
      toast("Supplier application review saved.");
      closeDrawer();
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS application review failed", err);
      toast(err.message || "Could not save application review.", "error");
    }
  }

  async function saveSupplier() {
    const current = state.currentDrawer;
    if (!current) return;
    const reliabilityRaw = $("#drawer-supplier-reliability").value;
    try {
      await api.staff.suppliers.setVerification(
        current.id,
        $("#drawer-supplier-verified").value === "1",
        reliabilityRaw === "" ? null : Number(reliabilityRaw),
        $("#drawer-supplier-notes").value.trim() || null
      );
      toast("Supplier controls updated.");
      closeDrawer();
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS supplier save failed", err);
      toast(err.message || "Could not update supplier.", "error");
    }
  }

  async function awardBid(id) {
    if (!global.confirm("Award this supplier bid? This will confirm the quotation and mark this as the only awarded bid.")) return;
    try {
      await api.staff.bids.award(id);
      toast("Supplier bid awarded.");
      const quoteId = state.currentDrawer?.type === "quote" ? state.currentDrawer.id : null;
      await loadAll({ silent: true });
      if (quoteId) await openQuote(quoteId);
    } catch (err) {
      console.error("CKA OPS bid award failed", err);
      toast(err.message || "Could not award bid.", "error");
    }
  }

  async function toggleInquiry(id, handled) {
    try {
      await api.staff.inquiries.setHandled(id, !handled);
      toast(handled ? "Inquiry reopened." : "Inquiry marked handled.");
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS inquiry update failed", err);
      toast(err.message || "Could not update inquiry.", "error");
    }
  }

  async function markNotification(id) {
    try {
      await api.notifications.markRead(id);
      const row = state.notifications.find((n) => String(n.id) === String(id));
      if (row) row.read_at = new Date().toISOString();
      renderNotifications(); renderNav();
    } catch (err) {
      console.error("CKA OPS notification update failed", err);
      toast(err.message || "Could not mark notification read.", "error");
    }
  }

  async function unlinkSupplier() {
    const current = state.currentDrawer;
    if (!current || state.profile?.role !== "admin") return;
    if (!global.confirm("Unlink this supplier login? The supplier record remains intact and the login is returned to customer role.")) return;
    try {
      await api.staff.suppliers.unlinkAccount(current.id);
      toast("Supplier login unlinked.");
      closeDrawer();
      await loadAll({ silent: true });
    } catch (err) {
      console.error("CKA OPS supplier unlink failed", err);
      toast(err.message || "Could not unlink supplier login.", "error");
    }
  }

  function scheduleRealtimeRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => loadAll({ silent: true }).catch(console.error), 700);
  }

  function installRealtime() {
    state.subscriptions.forEach((unsubscribe) => { try { unsubscribe(); } catch (_) {} });
    state.subscriptions = [
      api.staff.quotes.subscribe(scheduleRealtimeRefresh),
      api.staff.projects.subscribe(scheduleRealtimeRefresh),
      api.staff.bids.subscribe(scheduleRealtimeRefresh),
      api.notifications.subscribe(scheduleRealtimeRefresh)
    ];
  }

  function installEvents() {
    $$(".adm__navlink[data-view]").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
    $$('[data-open-view]').forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.openView)));
    ["quote-search", "quote-status"].forEach((id) => $("#" + id).addEventListener("input", renderQuotes));
    ["project-search", "project-status"].forEach((id) => $("#" + id).addEventListener("input", renderProjects));
    ["inquiry-search", "inquiry-status"].forEach((id) => $("#" + id).addEventListener("input", renderInquiries));
    ["application-search", "application-status"].forEach((id) => $("#" + id).addEventListener("input", renderApplications));
    ["supplier-search", "supplier-status"].forEach((id) => $("#" + id).addEventListener("input", renderSuppliers));

    document.addEventListener("click", async (event) => {
      const q = event.target.closest("[data-open-quote]"); if (q) return openQuote(q.dataset.openQuote);
      const p = event.target.closest("[data-open-project]"); if (p) return openProject(p.dataset.openProject);
      const a = event.target.closest("[data-open-application]"); if (a) return openApplication(a.dataset.openApplication);
      const s = event.target.closest("[data-open-supplier]"); if (s) return openSupplier(s.dataset.openSupplier);
      const close = event.target.closest("[data-close-ops-drawer]"); if (close) return closeDrawer();
      const saveQ = event.target.closest("[data-save-quote]"); if (saveQ) return saveQuote();
      const saveP = event.target.closest("[data-save-project]"); if (saveP) return saveProject();
      const saveA = event.target.closest("[data-save-application]"); if (saveA) return saveApplication();
      const saveS = event.target.closest("[data-save-supplier]"); if (saveS) return saveSupplier();
      const bid = event.target.closest("[data-award-bid]"); if (bid) return awardBid(bid.dataset.awardBid);
      const inquiry = event.target.closest("[data-toggle-inquiry]"); if (inquiry) return toggleInquiry(inquiry.dataset.toggleInquiry, inquiry.dataset.handled === "1");
      const note = event.target.closest("[data-read-notification]"); if (note) return markNotification(note.dataset.readNotification);
      const unlink = event.target.closest("[data-unlink-supplier]"); if (unlink) return unlinkSupplier();
    });

    $("#ops-refresh").addEventListener("click", () => loadAll());
    $("#ops-signout").addEventListener("click", async () => {
      await client.auth.signOut();
      global.location.replace("admin-login.html");
    });
    $("#mark-all-visible-read").addEventListener("click", async () => {
      const unread = state.notifications.filter((n) => !n.read_at);
      if (!unread.length) return toast("No unread notifications.");
      for (const row of unread.slice(0, 50)) await api.notifications.markRead(row.id);
      await loadAll({ silent: true });
      toast("Visible notifications marked read.");
    });
    $("#run-maintenance").addEventListener("click", async () => {
      if (!global.confirm("Run safe backend maintenance now? This only removes expired telemetry/idempotency data and stale outbox locks; business records and audit history are preserved.")) return;
      try {
        const result = await api.staff.runMaintenance();
        toast("Safe maintenance completed.");
        console.log("CKA OPS maintenance result", result);
        await loadAll({ silent: true });
      } catch (err) {
        console.error("CKA OPS maintenance failed", err);
        toast(err.message || "Maintenance failed.", "error");
      }
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
  }

  async function boot() {
    try {
      state.profile = await api.auth.profile();
      if (!state.profile || !["admin", "staff"].includes(state.profile.role)) {
        await client.auth.signOut();
        global.location.replace("admin-login.html");
        return;
      }

      $("#ops-user-name").textContent = state.profile.full_name || state.profile.email || "CKA Operations";
      $("#ops-user-role").textContent = `${state.profile.role === "admin" ? "Administrator" : "Staff"} · live production access`;
      installEvents();
      document.body.style.visibility = "visible";
      await loadAll({ silent: true });
      installRealtime();
      console.log("CKA OPS: operations console ready");
    } catch (err) {
      console.error("CKA OPS BOOT FAILED", err);
      document.body.style.visibility = "visible";
      global.alert("The operations console could not start safely. Please sign in again or check the browser console.");
    }
  }

  global.addEventListener("beforeunload", () => {
    state.subscriptions.forEach((unsubscribe) => { try { unsubscribe(); } catch (_) {} });
  });

  boot();
})(window);

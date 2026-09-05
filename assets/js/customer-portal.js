/* CKA BuildStruct — customer-portal.js */
(function (global) {
  "use strict";
  const api = global.CKABackend;
  const client = global.CKAStore && global.CKAStore.supabase;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const date = (v) => v ? new Intl.DateTimeFormat("en-PK", { dateStyle:"medium", timeStyle:"short" }).format(new Date(v)) : "—";
  const pkr = (v) => `PKR ${Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits:2 })}`;
  const state = { profile:null, summary:{}, quotes:[], projects:[], notifications:[], unsub:[] };

  if (!api || !client) return global.location.replace("account.html");

  function toast(text, error) {
    const box = $("#portal-toasts");
    const el = document.createElement("div");
    el.className = `portal__toast${error ? " is-error" : ""}`;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
  function tone(s) {
    if (["delivered","completed","confirmed","awarded"].includes(s)) return "good";
    if (["cancelled","archived"].includes(s)) return "bad";
    if (["submitted","received","under_review","estimating","quoted","bidding"].includes(s)) return "warn";
    if (["in_progress"].includes(s)) return "info";
    return "";
  }
  function chip(s) { return `<span class="portal__status" data-tone="${tone(s)}">${esc(String(s || "unknown").replace(/_/g," "))}</span>`; }
  function setView(view) {
    $$(".portal__nav [data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
    $$(".portal__view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === view));
    global.scrollTo(0,0);
  }

  async function load() {
    const [summary, quotes, projects, notifications] = await Promise.all([
      api.customer.summary(), api.customer.quotes(200), api.customer.projects(200), api.notifications.list(200)
    ]);
    Object.assign(state, { summary:summary || {}, quotes:quotes || [], projects:projects || [], notifications:notifications || [] });
    render();
  }

  function render() {
    const s = state.summary;
    $("#customer-kpis").innerHTML = [
      ["Total quotations",s.quotes_total || 0,"Requests linked to your account"],
      ["Open quotations",s.quotes_open || 0,"Awaiting completion or delivery"],
      ["Total projects",s.projects_total || 0,"Project requests linked"],
      ["Open projects",s.projects_open || 0,"Active delivery workflow"]
    ].map(([a,b,c]) => `<article class="portal__kpi"><span>${esc(a)}</span><strong>${esc(b)}</strong><small>${esc(c)}</small></article>`).join("");

    const q5 = state.quotes.slice(0,5);
    $("#customer-recent-quotes").innerHTML = q5.length ? `<ul class="portal__list">${q5.map((q) => `<li><button class="portal__btn" style="width:100%;text-align:left" data-open-quote="${esc(q.id)}"><strong>${esc(q.reference)} · ${esc(q.delivery_city || "Delivery pending")}</strong><small>${date(q.submitted_at)} · ${esc(q.status)}</small></button></li>`).join("")}</ul>` : '<p class="portal__meta">No quotations yet.</p>';
    const p5 = state.projects.slice(0,5);
    $("#customer-recent-projects").innerHTML = p5.length ? `<ul class="portal__list">${p5.map((p) => `<li><button class="portal__btn" style="width:100%;text-align:left" data-open-project="${esc(p.id)}"><strong>${esc(p.reference)} · ${esc(p.project_name || p.project_type || "Project")}</strong><small>${esc(p.progress_pct || 0)}% · ${esc(p.status)}</small></button></li>`).join("")}</ul>` : '<p class="portal__meta">No projects yet.</p>';

    $("#customer-quotes-empty").hidden = state.quotes.length > 0;
    $("#customer-quote-rows").innerHTML = state.quotes.map((q) => `<tr><td><strong>${esc(q.reference)}</strong><small>${date(q.submitted_at)}</small></td><td>${esc(q.delivery_city || "—")}</td><td>${date(q.submitted_at)}</td><td class="num">${pkr(q.subtotal)}</td><td>${chip(q.status)}</td><td><button class="portal__btn" data-open-quote="${esc(q.id)}">Details</button></td></tr>`).join("");

    $("#customer-projects-empty").hidden = state.projects.length > 0;
    $("#customer-project-rows").innerHTML = state.projects.map((p) => `<tr><td><strong>${esc(p.reference)}</strong><small>${date(p.created_at)}</small></td><td>${esc(p.project_name || p.project_type || "Project")}</td><td>${esc(p.location || "—")}</td><td>${esc(p.progress_pct || 0)}%</td><td>${chip(p.status)}</td><td><button class="portal__btn" data-open-project="${esc(p.id)}">Details</button></td></tr>`).join("");

    const unread = state.notifications.filter((n) => !n.read_at).length;
    $("#customer-unread").textContent = unread ? `(${unread})` : "";
    $("#customer-notifications-empty").hidden = state.notifications.length > 0;
    $("#customer-notifications").innerHTML = state.notifications.map((n) => `<li><strong>${esc(n.title || n.kind)}</strong><small>${esc(n.body || "")} · ${date(n.created_at)}</small>${n.read_at ? "" : `<button class="portal__btn" data-read-notification="${esc(n.id)}" style="margin-top:7px">Mark read</button>`}</li>`).join("");
  }

  function openDrawer(type, title) {
    $("#customer-drawer-type").textContent = type;
    $("#customer-drawer-title").textContent = title;
    $("#customer-drawer-body").innerHTML = '<p class="portal__meta">Loading live details…</p>';
    $("#customer-drawer").classList.add("is-open");
    $("#customer-drawer").setAttribute("aria-hidden","false");
  }
  function closeDrawer() {
    $("#customer-drawer").classList.remove("is-open");
    $("#customer-drawer").setAttribute("aria-hidden","true");
  }

  async function openQuote(id) {
    const q = state.quotes.find((x) => String(x.id) === String(id));
    if (!q) return;
    openDrawer("Quotation", q.reference);
    try {
      const items = await api.customer.quoteItems(id);
      $("#customer-drawer-body").innerHTML = `
        <div class="portal__grid"><article class="portal__card"><span class="portal__meta">Status</span><h3>${chip(q.status)}</h3></article><article class="portal__card"><span class="portal__meta">Current subtotal</span><h3>${pkr(q.subtotal)}</h3></article></div>
        <article class="portal__card" style="margin-top:14px"><h3>Delivery</h3><p>${esc(q.delivery_city || "—")}${q.delivery_address ? `<br>${esc(q.delivery_address)}` : ""}</p></article>
        <article class="portal__card" style="margin-top:14px"><h3>Requested materials</h3>${items.length ? `<ul class="portal__list">${items.map((i) => `<li><strong>${esc(i.name_snapshot)}</strong><small>${esc(i.quantity)} ${esc(i.unit_snapshot)} × ${pkr(i.unit_price)} = ${pkr(i.line_total)}</small></li>`).join("")}</ul>` : '<p>No line items.</p>'}</article>
        ${q.notes ? `<article class="portal__card" style="margin-top:14px"><h3>Your notes</h3><p>${esc(q.notes)}</p></article>` : ""}`;
    } catch (err) { $("#customer-drawer-body").innerHTML = `<div class="portal__notice portal__notice--bad">${esc(err.message || "Could not load quotation.")}</div>`; }
  }

  async function signedFileButton(file) {
    try {
      const { data, error } = await client.storage.from(file.storage_bucket).createSignedUrl(file.storage_path, 300);
      if (error) throw error;
      return `<a class="portal__btn" href="${esc(data.signedUrl)}" target="_blank" rel="noopener">Open file</a>`;
    } catch (_) { return '<span class="portal__meta">File access unavailable</span>'; }
  }

  async function openProject(id) {
    const p = state.projects.find((x) => String(x.id) === String(id));
    if (!p) return;
    openDrawer("Project", p.reference);
    try {
      const files = await api.customer.projectFiles(id);
      const fileRows = [];
      for (const f of files) fileRows.push(`<li><strong>${esc(f.original_name)}</strong><small>${esc(f.kind)} · ${f.size_bytes ? `${Math.round(Number(f.size_bytes)/1024)} KB` : ""}</small><div style="margin-top:7px">${await signedFileButton(f)}</div></li>`);
      $("#customer-drawer-body").innerHTML = `
        <div class="portal__grid"><article class="portal__card"><span class="portal__meta">Status</span><h3>${chip(p.status)}</h3></article><article class="portal__card"><span class="portal__meta">Progress</span><h3>${esc(p.progress_pct || 0)}%</h3></article></div>
        <article class="portal__card" style="margin-top:14px"><h3>${esc(p.project_name || p.project_type || "Project")}</h3><p>${esc(p.location || "Location not provided")}</p>${p.scope ? `<p>${esc(p.scope)}</p>` : ""}</article>
        <article class="portal__card" style="margin-top:14px"><h3>Project files</h3>${fileRows.length ? `<ul class="portal__list">${fileRows.join("")}</ul>` : '<p>No files attached.</p>'}</article>`;
    } catch (err) { $("#customer-drawer-body").innerHTML = `<div class="portal__notice portal__notice--bad">${esc(err.message || "Could not load project.")}</div>`; }
  }

  async function claim(kind, form) {
    if (!form.checkValidity()) return form.reportValidity();
    const box = $("#claim-message");
    box.textContent = "Claiming securely…";
    try {
      if (kind === "quote") await api.customer.claimQuote(form.reference.value.trim(), form.phone.value.trim());
      else await api.customer.claimProject(form.reference.value.trim(), form.phone.value.trim());
      box.style.color = "#2f7440";
      box.textContent = `${kind === "quote" ? "Quotation" : "Project"} successfully linked to this account.`;
      form.reset(); await load();
    } catch (err) { box.style.color="#9a3f37"; box.textContent=err.message || "Claim failed."; }
  }

  function installRealtime() {
    const refresh = () => load().catch(console.error);
    state.unsub.push(api.customer.subscribeQuotes(refresh), api.customer.subscribeProjects(refresh), api.notifications.subscribe(refresh));
  }

  async function boot() {
    try {
      state.profile = await api.auth.profile();
      if (!state.profile) return global.location.replace("account.html");
      if (["admin","staff"].includes(state.profile.role)) return global.location.replace("admin-operations.html");
      if (state.profile.role === "supplier") return global.location.replace("supplier-portal.html");
      $("#customer-name").textContent = state.profile.full_name || state.profile.email || "Customer";
      $("#customer-meta").textContent = `${state.profile.email || "Customer account"} · secure live access`;
      $$(".portal__nav [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
      document.addEventListener("click", async (e) => {
        const q=e.target.closest("[data-open-quote]"); if(q) return openQuote(q.dataset.openQuote);
        const p=e.target.closest("[data-open-project]"); if(p) return openProject(p.dataset.openProject);
        if(e.target.closest("[data-close-drawer]")) return closeDrawer();
        const n=e.target.closest("[data-read-notification]"); if(n){await api.notifications.markRead(n.dataset.readNotification);await load();}
      });
      $("#claim-quote-form").addEventListener("submit", (e) => {e.preventDefault();claim("quote",e.currentTarget);});
      $("#claim-project-form").addEventListener("submit", (e) => {e.preventDefault();claim("project",e.currentTarget);});
      $("#customer-mark-read").addEventListener("click", async () => {for(const n of state.notifications.filter((x)=>!x.read_at).slice(0,50)) await api.notifications.markRead(n.id); await load();});
      $("#customer-refresh").addEventListener("click", async () => {await load();toast("Customer data refreshed.");});
      $("#customer-signout").addEventListener("click", async () => {await api.auth.signOut();global.location.replace("account.html");});
      document.addEventListener("keydown", (e) => {if(e.key==="Escape")closeDrawer();});
      document.body.style.visibility="visible";
      await load(); installRealtime();
    } catch (err) {
      console.error("CKA CUSTOMER PORTAL BOOT FAILED",err);
      document.body.style.visibility="visible";
      global.alert("Customer portal could not start safely. Please sign in again.");
    }
  }
  global.addEventListener("beforeunload",()=>state.unsub.forEach((fn)=>{try{fn();}catch(_){}}));
  boot();
})(window);

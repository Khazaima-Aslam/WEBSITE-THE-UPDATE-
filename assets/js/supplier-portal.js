/* CKA BuildStruct — supplier-portal.js */
(function (global) {
  "use strict";
  const api = global.CKABackend;
  const client = global.CKAStore && global.CKAStore.supabase;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const date = (v) => v ? new Intl.DateTimeFormat("en-PK", { dateStyle:"medium", timeStyle:"short" }).format(new Date(v)) : "—";
  const pkr = (v) => `PKR ${Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits:2 })}`;
  const state = { profile:null, supplier:null, tenders:[], bids:[], notifications:[], activeTender:null, unsub:[], pollTimer:null };

  if (!api || !client) return global.location.replace("account.html");

  function toast(text, error) {
    const el = document.createElement("div");
    el.className = `portal__toast${error ? " is-error" : ""}`;
    el.textContent = text;
    $("#portal-toasts").appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
  function tone(s) {
    if (["awarded","verified"].includes(s)) return "good";
    if (["withdrawn","rejected"].includes(s)) return "bad";
    if (["submitted"].includes(s)) return "warn";
    return "";
  }
  function chip(s) { return `<span class="portal__status" data-tone="${tone(s)}">${esc(String(s || "unknown").replace(/_/g," "))}</span>`; }
  function setView(view) {
    $$(".portal__nav [data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
    $$(".portal__view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === view));
    global.scrollTo(0,0);
  }
  function timeLeft(value) {
    const ms = new Date(value).getTime() - Date.now();
    if (ms <= 0) return "Closed";
    const hours = Math.floor(ms / 3600000);
    const days = Math.floor(hours / 24);
    return days ? `${days}d ${hours % 24}h remaining` : `${hours}h ${Math.floor((ms % 3600000)/60000)}m remaining`;
  }
  function toLocalInput(dateValue) {
    const d = new Date(dateValue);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0,16);
  }
  function benchmark(t) {
    if (t.best_current_total == null) return '<div class="portal__notice">No valid supplier benchmark yet. Your offer can establish the first market position.</div>';
    const lead = t.best_is_own ? "Your latest submitted offer currently leads." : "Anonymous market benchmark to beat.";
    const delivery = t.best_delivery_days == null ? "delivery not stated" : `${esc(t.best_delivery_days)} days delivery`;
    return `<div class="portal__notice ${t.best_is_own ? "portal__notice--good" : ""}"><strong>${esc(lead)}</strong><br>Best current total ${pkr(t.best_current_total)} · ${delivery}. Competing supplier identity remains private.</div>`;
  }

  async function history() {
    const { data, error } = await client.rpc("supplier_bid_history", { p_limit:200 });
    if (error) throw error;
    return data || [];
  }

  async function load() {
    const [supplier, tenders, bids, notifications] = await Promise.all([
      api.supplier.profile(), api.supplier.tenders(), history(), api.notifications.list(200)
    ]);
    Object.assign(state, { supplier, tenders:tenders || [], bids:bids || [], notifications:notifications || [] });
    render();
  }

  function render() {
    const submitted = state.bids.filter((b) => b.bid_status === "submitted").length;
    const awarded = state.bids.filter((b) => b.is_awarded).length;
    const leading = state.tenders.filter((t) => t.best_is_own).length;
    $("#supplier-kpis").innerHTML = [
      ["Open tenders",state.tenders.length,"Available now"],
      ["Currently leading",leading,"Anonymous best-price benchmark"],
      ["Bid revisions",state.bids.length,"All revisions retained"],
      ["Awards",awarded,"Successful CKA awards"]
    ].map(([a,b,c]) => `<article class="portal__kpi"><span>${esc(a)}</span><strong>${esc(b)}</strong><small>${esc(c)}</small></article>`).join("");

    $("#supplier-tender-count").textContent = state.tenders.length ? `(${state.tenders.length})` : "";
    $("#supplier-tenders-empty").hidden = state.tenders.length > 0;
    $("#supplier-tenders").innerHTML = state.tenders.map((t) => `<article class="portal__card"><div style="display:flex;justify-content:space-between;gap:12px"><div><h3>${esc(t.reference)}</h3><p>${esc(t.delivery_city || "Delivery city not stated")} · ${(t.items || []).length} line item${(t.items || []).length===1?"":"s"} · ${esc(t.supplier_count || 0)} supplier${Number(t.supplier_count||0)===1?"":"s"} participating</p></div>${chip("submitted")}</div><div class="portal__notice"><strong class="portal__countdown">${esc(timeLeft(t.bidding_closes_at))}</strong><br>Closes ${date(t.bidding_closes_at)} · Minimum validity ${esc(t.min_bid_validity_days)} day(s) beyond closing.</div><div style="margin-top:8px">${benchmark(t)}</div>${t.own_latest_bid ? `<p class="portal__meta">Your latest: revision ${esc(t.own_latest_bid.revision_no)} · ${pkr(t.own_latest_bid.total_amount)} · ${esc(t.own_latest_bid.status)}</p>` : '<p class="portal__meta">You have not bid on this tender yet.</p>'}<button class="portal__btn portal__btn--primary" data-open-tender="${esc(t.quote_id)}">${t.own_latest_bid ? "Submit new revision" : "Prepare bid"}</button></article>`).join("");

    const deadlines = state.tenders.slice().sort((a,b)=>new Date(a.bidding_closes_at)-new Date(b.bidding_closes_at)).slice(0,5);
    $("#supplier-deadlines").innerHTML = deadlines.length ? `<ul class="portal__list">${deadlines.map((t)=>`<li><strong>${esc(t.reference)}</strong><small>${esc(timeLeft(t.bidding_closes_at))} · ${date(t.bidding_closes_at)}${t.best_current_total!=null?` · best ${pkr(t.best_current_total)}`:""}</small></li>`).join("")}</ul>` : '<p class="portal__meta">No active tender deadlines.</p>';
    const recent = state.bids.slice(0,5);
    $("#supplier-recent-bids").innerHTML = recent.length ? `<ul class="portal__list">${recent.map((b)=>`<li><button class="portal__btn" data-open-bid="${esc(b.bid_id)}" style="width:100%;text-align:left"><strong>${esc(b.reference)} · Rev ${esc(b.revision_no)}</strong><small>${pkr(b.total_amount)} · ${esc(b.bid_status)}</small></button></li>`).join("")}</ul>` : '<p class="portal__meta">No bid activity yet.</p>';

    $("#supplier-bids-empty").hidden = state.bids.length > 0;
    $("#supplier-bid-rows").innerHTML = state.bids.map((b)=>`<tr><td>${date(b.placed_at)}<small>${esc(b.reference)}</small></td><td>Rev ${esc(b.revision_no)}</td><td class="num">${pkr(b.total_amount)}</td><td>${b.delivery_days==null?"—":`${esc(b.delivery_days)} days`}</td><td>${date(b.valid_until)}</td><td>${chip(b.bid_status)}</td><td><button class="portal__btn" data-open-bid="${esc(b.bid_id)}">Details</button></td></tr>`).join("");

    const unread = state.notifications.filter((n)=>!n.read_at).length;
    $("#supplier-unread").textContent = unread ? `(${unread})` : "";
    $("#supplier-notifications-empty").hidden = state.notifications.length > 0;
    $("#supplier-notifications").innerHTML = state.notifications.map((n)=>`<li><strong>${esc(n.title || n.kind)}</strong><small>${esc(n.body || "")} · ${date(n.created_at)}</small>${n.read_at?"":`<button class="portal__btn" data-read-notification="${esc(n.id)}" style="margin-top:7px">Mark read</button>`}</li>`).join("");

    const s = state.supplier || {};
    $("#supplier-profile-grid").innerHTML = [
      ["Company",s.company_name || "—"],["Contact",s.contact_person || "—"],["City",s.city || "—"],["Email",s.email || "—"],
      ["Phone",s.phone || "—"],["Verification",s.is_verified ? "Verified" : "Not verified"],["Reliability",s.reliability_pct == null ? "Not scored" : `${s.reliability_pct}%`],["Rating",s.rating == null ? "Not rated" : s.rating]
    ].map(([a,b])=>`<article class="portal__card"><span class="portal__meta">${esc(a)}</span><h3>${esc(b)}</h3></article>`).join("");
  }

  function openDrawer(title) {
    $("#supplier-drawer-title").textContent = title;
    $("#supplier-drawer-body").innerHTML = '<p class="portal__meta">Loading procurement details…</p>';
    $("#supplier-drawer-foot").innerHTML = '<button class="portal__btn" data-close-drawer>Close</button>';
    $("#supplier-drawer").classList.add("is-open");
    $("#supplier-drawer").setAttribute("aria-hidden","false");
  }
  function closeDrawer() {
    state.activeTender = null;
    $("#supplier-drawer").classList.remove("is-open");
    $("#supplier-drawer").setAttribute("aria-hidden","true");
  }

  function recalcTenderTotal() {
    let total = 0;
    $$("[data-bid-line]", $("#supplier-drawer-body")).forEach((line) => {
      const qty = Number(line.dataset.quantity || 0);
      const rate = Number($("[data-unit-rate]",line)?.value || 0);
      total += qty * rate;
      const out = $("[data-line-total]",line); if(out) out.textContent = pkr(qty * rate);
    });
    const totalEl = $("#supplier-bid-total"); if(totalEl) totalEl.textContent = pkr(total);
  }

  async function openTender(id) {
    const t = state.tenders.find((x)=>String(x.quote_id)===String(id));
    if (!t) return;
    state.activeTender = t;
    openDrawer(t.reference);
    const minValid = new Date(new Date(t.bidding_closes_at).getTime() + Number(t.min_bid_validity_days || 3)*86400000);
    const latest = t.own_latest_bid;
    $("#supplier-drawer-body").innerHTML = `
      <div class="portal__notice"><strong>${esc(timeLeft(t.bidding_closes_at))}</strong><br>Closing ${date(t.bidding_closes_at)} · ${t.allow_partial_bids ? "Partial bids permitted" : "All lines must be priced"}.</div>
      <div style="margin-top:8px">${benchmark(t)}</div>
      ${latest ? `<article class="portal__card" style="margin-top:12px"><h3>Your latest revision</h3><p>Revision ${esc(latest.revision_no)} · ${pkr(latest.total_amount)} · ${esc(latest.status)} · valid until ${date(latest.valid_until)}</p>${latest.status === "submitted" ? `<button class="portal__btn portal__btn--danger" data-withdraw-bid="${esc(latest.bid_id)}">Withdraw latest revision</button>` : ""}</article>` : ""}
      <form id="supplier-bid-form" style="margin-top:14px">
        <article class="portal__card"><h3>Itemized commercial offer</h3>${(t.items || []).map((item)=>`<div class="portal__line" data-bid-line data-item-id="${esc(item.item_id)}" data-quantity="${esc(item.quantity)}"><div class="portal__line-name"><strong>${esc(item.name)}</strong><small>${esc(item.quantity)} ${esc(item.unit)}</small></div><label class="portal__field"><span>Unit rate (PKR)</span><input class="portal__input" data-unit-rate type="number" min="0.01" step="0.01" ${t.allow_partial_bids?"":"required"}></label><label class="portal__field"><span>Brand / make</span><input class="portal__input" data-brand maxlength="160"></label><label class="portal__field"><span>Availability</span><input class="portal__input" data-availability maxlength="500" placeholder="e.g. immediate"><small data-line-total>${pkr(0)}</small></label></div>`).join("")}<div class="portal__bidtotal"><span>Computed offer total</span><strong id="supplier-bid-total">${pkr(0)}</strong></div></article>
        <article class="portal__card" style="margin-top:12px"><h3>Commercial terms</h3><div class="portal__formgrid"><label class="portal__field"><span>Delivery days</span><input class="portal__input" name="delivery_days" type="number" min="0" max="365" step="1"></label><label class="portal__field"><span>Valid until</span><input class="portal__input" name="valid_until" type="datetime-local" value="${esc(toLocalInput(minValid))}" required></label><label class="portal__check"><input type="checkbox" name="freight_included"> Freight included</label><label class="portal__check"><input type="checkbox" name="tax_included"> Tax included</label><label class="portal__field portal__wide"><span>Commercial terms</span><textarea class="portal__textarea" name="terms" rows="4" maxlength="5000" placeholder="Payment, lead time, warranty or other commercial notes"></textarea></label></div></article>
      </form>`;
    $("#supplier-drawer-foot").innerHTML = '<button class="portal__btn" data-close-drawer>Cancel</button><button class="portal__btn portal__btn--primary" data-submit-bid>Submit bid revision</button>';
    $$("[data-unit-rate]",$("#supplier-drawer-body")).forEach((input)=>input.addEventListener("input",recalcTenderTotal));
  }

  function openBid(id) {
    const b = state.bids.find((x)=>String(x.bid_id)===String(id));
    if (!b) return;
    openDrawer(`${b.reference} · Revision ${b.revision_no}`);
    $("#supplier-drawer-body").innerHTML = `<div class="portal__grid"><article class="portal__card"><span class="portal__meta">Status</span><h3>${chip(b.bid_status)}</h3></article><article class="portal__card"><span class="portal__meta">Total</span><h3>${pkr(b.total_amount)}</h3></article><article class="portal__card"><span class="portal__meta">Delivery</span><h3>${b.delivery_days==null?"—":`${esc(b.delivery_days)} days`}</h3></article><article class="portal__card"><span class="portal__meta">Valid until</span><h3>${date(b.valid_until)}</h3></article></div><article class="portal__card" style="margin-top:12px"><h3>Line items</h3><ul class="portal__list">${(b.line_items || []).map((i)=>`<li><strong>${esc(i.name)} · ${esc(i.quantity)} ${esc(i.unit)}</strong><small>${pkr(i.unit_rate)} each · ${pkr(i.line_total)}${i.offered_brand?` · ${esc(i.offered_brand)}`:""}${i.availability_note?` · ${esc(i.availability_note)}`:""}</small></li>`).join("")}</ul></article>${b.terms?`<article class="portal__card" style="margin-top:12px"><h3>Terms</h3><p>${esc(b.terms)}</p></article>`:""}`;
  }

  async function submitBid() {
    const t = state.activeTender;
    const form = $("#supplier-bid-form");
    if (!t || !form) return;
    const items = [];
    for (const line of $$('[data-bid-line]',form)) {
      const rateRaw = $("[data-unit-rate]",line).value;
      if (!rateRaw) {
        if (t.allow_partial_bids) continue;
        return toast("Every tender line must have a unit rate.",true);
      }
      const rate = Number(rateRaw);
      if (!(rate > 0)) return toast("Every submitted unit rate must be greater than zero.",true);
      items.push({ quote_item_id:line.dataset.itemId, unit_rate:rate, offered_brand:$("[data-brand]",line).value.trim() || null, availability_note:$("[data-availability]",line).value.trim() || null });
    }
    if (!items.length) return toast("Price at least one tender line.",true);
    const button=$("[data-submit-bid]"); button.disabled=true;
    try {
      await api.supplier.submitBid(t.quote_id,items,{
        deliveryDays:form.delivery_days.value,
        validUntil:new Date(form.valid_until.value).toISOString(),
        freightIncluded:form.freight_included.checked,
        taxIncluded:form.tax_included.checked,
        terms:form.terms.value.trim()
      });
      toast("Bid revision submitted to CKA."); closeDrawer(); await load();
    } catch(err){console.error("CKA SUPPLIER BID FAILED",err);toast(err.message || "Bid submission failed.",true);button.disabled=false;}
  }

  async function withdrawBid(id) {
    if (!global.confirm("Withdraw this bid revision? Previous revisions remain in audit history, but CKA will treat the withdrawn revision as inactive.")) return;
    try { await api.supplier.withdrawBid(id); toast("Bid revision withdrawn."); closeDrawer(); await load(); }
    catch(err){toast(err.message || "Could not withdraw bid.",true);}
  }

  function installRealtime() {
    const refresh=()=>load().catch(console.error);
    state.unsub.push(api.supplier.subscribeBids(refresh),api.supplier.subscribeBidItems(refresh),api.notifications.subscribe(refresh));
    state.pollTimer=global.setInterval(()=>load().catch(console.error),20000);
  }

  async function boot() {
    try {
      state.profile=await api.auth.profile();
      if(!state.profile)return global.location.replace("account.html");
      if(["admin","staff"].includes(state.profile.role))return global.location.replace("admin-operations.html");
      if(state.profile.role!=="supplier")return global.location.replace("customer-portal.html");
      state.supplier=await api.supplier.profile();
      if(!state.supplier || !state.supplier.is_verified)return global.location.replace("account.html");
      $("#supplier-name").textContent=state.supplier.company_name || state.profile.full_name || "Supplier";
      $("#supplier-meta").textContent=`Verified supplier · ${state.supplier.reliability_pct==null?"reliability not scored":`${state.supplier.reliability_pct}% reliability`}`;
      $$(".portal__nav [data-view]").forEach((b)=>b.addEventListener("click",()=>setView(b.dataset.view)));
      document.addEventListener("click",async(e)=>{
        const t=e.target.closest("[data-open-tender]");if(t)return openTender(t.dataset.openTender);
        const b=e.target.closest("[data-open-bid]");if(b)return openBid(b.dataset.openBid);
        if(e.target.closest("[data-close-drawer]"))return closeDrawer();
        if(e.target.closest("[data-submit-bid]"))return submitBid();
        const w=e.target.closest("[data-withdraw-bid]");if(w)return withdrawBid(w.dataset.withdrawBid);
        const n=e.target.closest("[data-read-notification]");if(n){await api.notifications.markRead(n.dataset.readNotification);await load();}
      });
      $("#supplier-mark-read").addEventListener("click",async()=>{for(const n of state.notifications.filter((x)=>!x.read_at).slice(0,50))await api.notifications.markRead(n.id);await load();});
      $("#supplier-refresh").addEventListener("click",async()=>{await load();toast("Tender data refreshed.");});
      $("#supplier-signout").addEventListener("click",async()=>{await api.auth.signOut();global.location.replace("account.html");});
      document.addEventListener("keydown",(e)=>{if(e.key==="Escape")closeDrawer();});
      document.body.style.visibility="visible";
      await load();installRealtime();
    } catch(err){console.error("CKA SUPPLIER PORTAL BOOT FAILED",err);document.body.style.visibility="visible";global.alert("Supplier portal could not start safely. Please sign in again.");}
  }
  global.addEventListener("beforeunload",()=>{if(state.pollTimer)global.clearInterval(state.pollTimer);state.unsub.forEach((fn)=>{try{fn();}catch(_){}});});
  boot();
})(window);

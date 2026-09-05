/* CKA BuildStruct — admin-bidding.js
   Procurement controls layered onto admin-operations.js without rewriting it. */
(function (global) {
  "use strict";
  const api = global.CKABackend;
  const client = global.CKAStore && global.CKAStore.supabase;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pkr = (v) => `PKR ${Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits:2 })}`;
  const date = (v) => v ? new Intl.DateTimeFormat("en-PK", { dateStyle:"medium", timeStyle:"short" }).format(new Date(v)) : "—";
  let currentQuoteId = null;
  let enhancing = false;

  if (!api || !client) return;

  if (!document.querySelector('link[href*="assets/css/portal.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "assets/css/portal.css?v=1";
    document.head.appendChild(css);
  }
  if (!document.querySelector('script[src*="admin-supplier-accounts.js"]')) {
    const supplierAccounts = document.createElement("script");
    supplierAccounts.src = "assets/js/admin-supplier-accounts.js?v=1";
    supplierAccounts.async = true;
    document.head.appendChild(supplierAccounts);
  }

  function toLocalInput(value) {
    const d = value ? new Date(value) : new Date(Date.now() + 48 * 3600000);
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0,16);
  }
  function statusChip(status) {
    const good=["awarded"]; const bad=["withdrawn","rejected"];
    const tone=good.includes(status)?"good":bad.includes(status)?"bad":"warn";
    return `<span class="ops__status" data-tone="${tone}">${esc(String(status || "unknown").replace(/_/g," "))}</span>`;
  }
  function toast(text, error) {
    const box=document.getElementById("toasts"); if(!box)return;
    const el=document.createElement("div"); el.className=`toast${error?" toast--warn":""}`; el.textContent=text; box.appendChild(el);
    setTimeout(()=>el.remove(),3400);
  }

  async function getQuote(id) {
    const { data, error } = await client.from("quotes")
      .select("id,reference,status,bidding_opened_at,bidding_closes_at,allow_partial_bids,min_bid_validity_days,awarded_bid_id")
      .eq("id",id).single();
    if(error) throw error; return data;
  }

  function comparisonHtml(rows, quote) {
    if(!rows.length) return '<p class="ops__muted">No supplier revisions are available for comparison yet.</p>';
    return rows.map((b)=>`<article class="portal__supplier-card ${b.is_awarded?"is-awarded":""}" style="margin-top:10px">
      <div class="portal__supplier-head"><div><strong>${esc(b.supplier_name)}</strong><div class="portal__supplier-meta">Reliability ${b.supplier_reliability==null?"not scored":`${esc(b.supplier_reliability)}%`} · Revision ${esc(b.revision_no)} · ${esc(b.line_count)}/${esc(b.tender_line_count)} lines</div></div><div style="text-align:right"><strong>${pkr(b.total_amount)}</strong><div>${statusChip(b.bid_status)}</div></div></div>
      <div class="portal__supplier-meta" style="margin-top:8px">Delivery ${b.delivery_days==null?"not stated":`${esc(b.delivery_days)} days`} · Valid until ${date(b.valid_until)} · Freight ${b.freight_included?"included":"excluded"} · Tax ${b.tax_included?"included":"excluded"}</div>
      <div class="portal__comparison-lines">${(b.line_items||[]).map((i)=>`<div><span>${esc(i.name)}${i.offered_brand?` · ${esc(i.offered_brand)}`:""}</span><span>${pkr(i.unit_rate)}/${esc(i.unit)}</span><strong>${pkr(i.line_total)}</strong></div>`).join("")}</div>
      ${b.terms?`<p class="ops__muted" style="margin-top:8px">${esc(b.terms)}</p>`:""}
      ${b.bid_status==="submitted" && !b.is_awarded && ["bidding","quoted"].includes(quote.status)?`<button class="btn btn--brand btn--sm" style="margin-top:9px" data-proc-award="${esc(b.bid_id)}">Award latest revision</button>`:""}
    </article>`).join("");
  }

  async function enhanceQuoteDrawer() {
    if(enhancing || !currentQuoteId) return;
    const body=document.getElementById("ops-drawer-body");
    const workflow=document.getElementById("drawer-quote-status")?.closest(".ops__section");
    if(!body || !workflow || document.getElementById("ops-procurement-controls")) return;
    enhancing=true;
    try {
      const [quote, comparison] = await Promise.all([getQuote(currentQuoteId),api.staff.bids.comparison(currentQuoteId)]);

      const statusSelect=document.getElementById("drawer-quote-status");
      if(statusSelect && quote.status !== "bidding") {
        const unsafe=statusSelect.querySelector('option[value="bidding"]');
        if(unsafe) unsafe.remove();
      }

      Array.from(body.querySelectorAll(".ops__section")).forEach((section)=>{
        const heading=section.querySelector("h3");
        if(heading && heading.textContent.trim()==="Supplier bids") section.hidden=true;
      });

      let controls="";
      if(["submitted","quoted"].includes(quote.status)) {
        controls=`<div class="portal__notice">Opening bidding publishes a sanitized tender to verified supplier accounts. Customer identity and exact address stay private.</div><div class="ops__form-grid" style="margin-top:10px"><label class="field"><span>Bidding closes</span><input class="input" id="proc-close-at" type="datetime-local" value="${esc(toLocalInput())}"></label><label class="field"><span>Minimum bid validity</span><select class="select" id="proc-validity"><option value="3">3 days</option><option value="5">5 days</option><option value="7">7 days</option><option value="14">14 days</option></select></label><label class="portal__check field--wide"><input type="checkbox" id="proc-partial"> Allow suppliers to price only selected lines</label></div><button class="btn btn--brand btn--sm" style="margin-top:10px" data-proc-open>Open supplier bidding</button>`;
      } else if(quote.status==="bidding") {
        controls=`<div class="portal__notice"><strong>Tender open</strong><br>Opened ${date(quote.bidding_opened_at)} · closes ${date(quote.bidding_closes_at)} · ${quote.allow_partial_bids?"partial bids allowed":"full-line coverage required"} · minimum validity ${esc(quote.min_bid_validity_days)} day(s).</div><button class="btn btn--ghost btn--sm" style="margin-top:10px" data-proc-close>Close bidding now</button>`;
      } else if(quote.awarded_bid_id) {
        controls='<div class="portal__notice portal__notice--good"><strong>Procurement award recorded.</strong><br>The awarded supplier revision is locked to this quotation and the quotation is confirmed.</div>';
      } else {
        controls=`<div class="portal__notice">Bidding controls are unavailable while this quotation is <strong>${esc(quote.status)}</strong>.</div>`;
      }

      const section=document.createElement("section");
      section.className="ops__section";
      section.id="ops-procurement-controls";
      section.innerHTML=`<div class="ops__section-head"><h3>Supplier procurement</h3><span class="ops__muted">Itemized, revision-controlled bidding</span></div>${controls}<div style="margin-top:14px"><h4 style="margin:0 0 8px">Latest supplier comparison</h4>${comparisonHtml(comparison||[],quote)}</div>`;
      workflow.insertAdjacentElement("afterend",section);
    } catch(err) {
      console.error("CKA PROCUREMENT DRAWER ENHANCEMENT FAILED",err);
      toast(err.message || "Could not load procurement controls.",true);
    } finally { enhancing=false; }
  }

  async function openBidding() {
    const close=document.getElementById("proc-close-at")?.value;
    if(!close) return toast("Choose a bidding deadline.",true);
    const closesAt=new Date(close);
    if(Number.isNaN(closesAt.getTime())) return toast("Choose a valid bidding deadline.",true);
    try {
      await api.staff.quotes.openBidding(currentQuoteId,closesAt.toISOString(),document.getElementById("proc-partial")?.checked,Number(document.getElementById("proc-validity")?.value || 3));
      toast("Supplier bidding opened with controlled deadline.");
      global.location.reload();
    } catch(err){toast(err.message || "Could not open bidding.",true);}
  }
  async function closeBidding() {
    if(!global.confirm("Close supplier bidding now? Suppliers will no longer be able to submit or withdraw revisions.")) return;
    try {await api.staff.quotes.closeBidding(currentQuoteId);toast("Supplier bidding closed.");global.location.reload();}
    catch(err){toast(err.message || "Could not close bidding.",true);}
  }
  async function award(id) {
    if(!global.confirm("Award this supplier's latest valid revision? Other submitted supplier bids will be rejected and the quotation will be confirmed.")) return;
    try {await api.staff.bids.award(id);toast("Supplier bid awarded and quotation confirmed.");global.location.reload();}
    catch(err){toast(err.message || "Could not award supplier revision.",true);}
  }

  document.addEventListener("click",(event)=>{
    const open=event.target.closest("[data-open-quote]");
    if(open){currentQuoteId=open.dataset.openQuote;setTimeout(enhanceQuoteDrawer,80);setTimeout(enhanceQuoteDrawer,350);}
    if(event.target.closest("[data-proc-open]")){event.preventDefault();openBidding();}
    if(event.target.closest("[data-proc-close]")){event.preventDefault();closeBidding();}
    const awardBtn=event.target.closest("[data-proc-award]");if(awardBtn){event.preventDefault();award(awardBtn.dataset.procAward);}
    if(event.target.closest("[data-close-ops-drawer]")) currentQuoteId=null;
  },true);

  const body=document.getElementById("ops-drawer-body");
  if(body) new MutationObserver(()=>{if(currentQuoteId)setTimeout(enhanceQuoteDrawer,20);}).observe(body,{childList:true,subtree:true});
})(window);

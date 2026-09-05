/* CKA BuildStruct — customer-payments.js
   Customer-owned payment proof submission and status tracking. */
(function (global) {
  "use strict";
  const client = global.CKAStore && global.CKAStore.supabase;
  if (!client) return;
  const $ = (s,r)=>(r||document).querySelector(s);
  const $$ = (s,r)=>Array.from((r||document).querySelectorAll(s));
  const esc = (v)=>String(v==null?"":v).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pkr = (v)=>`PKR ${Number(v||0).toLocaleString("en-PK",{maximumFractionDigits:2})}`;
  const date = (v)=>v?new Intl.DateTimeFormat("en-PK",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"—";
  let rows=[];

  function toast(text,error){const box=$("#portal-toasts");if(!box)return;const el=document.createElement("div");el.className=`portal__toast${error?" is-error":""}`;el.textContent=text;box.appendChild(el);setTimeout(()=>el.remove(),3600);}
  function methodLabel(v){return({bank_transfer:"Bank Transfer",jazzcash:"JazzCash",easypaisa:"EasyPaisa",cod:"Cash on Delivery",credit_terms:"Credit Terms"})[v]||String(v||"").replace(/_/g," ");}
  function statusChip(v){const tone=v==="verified"?"good":v==="rejected"?"bad":"warn";return `<span class="portal__status" data-tone="${tone}">${esc(v)}</span>`;}
  function safeName(name){return String(name||"proof").replace(/[^a-zA-Z0-9._-]/g,"-").replace(/-+/g,"-").slice(0,160)||"proof";}

  function installShell(){
    const nav=$(".portal__nav"); const main=$(".portal__main"); if(!nav||!main||$("[data-payment-view]"))return;
    const btn=document.createElement("button");btn.type="button";btn.dataset.paymentView="1";btn.dataset.view="payments";btn.textContent="Payments";
    const claim=nav.querySelector('[data-view="claim"]'); if(claim) nav.insertBefore(btn,claim); else nav.appendChild(btn);
    const section=document.createElement("section");section.className="portal__view";section.dataset.view="payments";section.innerHTML='<div class="portal__head"><div><h1>Payments & verification</h1><p>Submit bank or wallet payment proof only after a quotation is confirmed. CKA staff verifies every proof before it counts as paid.</p></div><button class="portal__btn" id="payment-refresh">Refresh</button></div><div id="payment-content"><div class="portal__card"><p class="portal__meta">Loading payment records…</p></div></div>';
    const notif=main.querySelector('.portal__view[data-view="notifications"]'); if(notif) main.insertBefore(section,notif); else main.appendChild(section);
    btn.addEventListener("click",()=>{ $$(".portal__nav [data-view]").forEach((b)=>b.classList.toggle("is-active",b===btn)); $$(".portal__view").forEach((v)=>v.classList.toggle("is-active",v===section)); global.scrollTo(0,0); load().catch((e)=>toast(e.message||"Could not load payments.",true)); });
    $("#payment-refresh").addEventListener("click",()=>load().then(()=>toast("Payment records refreshed.")).catch((e)=>toast(e.message||"Refresh failed.",true)));
  }

  async function rpc(name,args){const {data,error}=await client.rpc(name,args||{});if(error)throw error;return data;}
  async function load(){rows=await rpc("customer_payment_overview");render();}

  function paymentRows(payments){
    if(!Array.isArray(payments)||!payments.length)return '<p class="portal__meta">No payment proofs submitted yet.</p>';
    return `<ul class="portal__list">${payments.map((p)=>`<li><strong>${pkr(p.amount)} · ${esc(methodLabel(p.method))}</strong><small>${esc(p.transaction_reference)} · submitted ${date(p.submitted_at)} · ${statusChip(p.status)}</small>${p.review_notes?`<div class="portal__notice ${p.status==="rejected"?"portal__notice--bad":""}" style="margin-top:8px">${esc(p.review_notes)}</div>`:""}<div style="margin-top:8px"><button class="portal__btn" data-payment-proof="${esc(p.proof_path)}">Open proof</button></div></li>`).join("")}</ul>`;
  }

  function formHtml(r){
    const remaining=Number(r.remaining_amount||0); const pending=Number(r.submitted_amount||0);
    if(remaining<=0){return pending>0?'<div class="portal__notice">The remaining balance is already covered by proof(s) awaiting verification.</div>':'<div class="portal__notice portal__notice--good">No additional payment proof is currently required.</div>';}
    const preferred=["bank_transfer","jazzcash","easypaisa"].includes(r.payment_pref)?r.payment_pref:"bank_transfer";
    return `<form class="portal__card payment-submit-form" data-quote-id="${esc(r.quote_id)}" style="margin-top:12px"><h3>Submit payment proof</h3><div class="portal__grid"><label class="portal__field"><span>Method</span><select class="portal__select" name="method" required><option value="bank_transfer" ${preferred==="bank_transfer"?"selected":""}>Bank Transfer</option><option value="jazzcash" ${preferred==="jazzcash"?"selected":""}>JazzCash</option><option value="easypaisa" ${preferred==="easypaisa"?"selected":""}>EasyPaisa</option></select></label><label class="portal__field"><span>Amount</span><input class="portal__input" name="amount" type="number" min="1" step="0.01" max="${esc(remaining)}" value="${esc(remaining)}" required /></label><label class="portal__field"><span>Transaction / reference number</span><input class="portal__input" name="reference" minlength="4" maxlength="120" required /></label><label class="portal__field"><span>Payment proof</span><input class="portal__input" name="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required /></label></div><p class="portal__meta" style="margin-top:10px">Private upload. JPG, PNG, WebP or PDF, maximum 10 MB. Do not upload card PINs, passwords or unrelated bank information.</p><button class="portal__btn portal__btn--primary" type="submit">Submit for verification</button></form>`;
  }

  function render(){
    const box=$("#payment-content");if(!box)return;
    if(!rows.length){box.innerHTML='<div class="portal__card"><h3>No payment-ready quotations</h3><p class="portal__meta">Payment proof becomes available after CKA confirms a quotation.</p></div>';return;}
    box.innerHTML=rows.map((r)=>`<article class="portal__card" style="margin-bottom:14px"><div class="portal__head" style="margin-bottom:10px"><div><h3 style="margin:0">${esc(r.reference)}</h3><p>${esc(String(r.quote_status||"").replace(/_/g," "))} · preferred ${esc(methodLabel(r.payment_pref))}</p></div></div><div class="portal__grid"><div class="portal__kpi"><span>Confirmed payable</span><strong>${pkr(r.required_amount)}</strong></div><div class="portal__kpi"><span>Verified</span><strong>${pkr(r.verified_amount)}</strong></div><div class="portal__kpi"><span>Awaiting review</span><strong>${pkr(r.submitted_amount)}</strong></div><div class="portal__kpi"><span>Available to submit</span><strong>${pkr(r.remaining_amount)}</strong></div></div><div style="margin-top:12px"><h3>Payment history</h3>${paymentRows(r.payments)}</div>${formHtml(r)}</article>`).join("");
  }

  async function openProof(path){try{const {data,error}=await client.storage.from("payment-proofs").createSignedUrl(path,300);if(error)throw error;global.open(data.signedUrl,"_blank","noopener");}catch(err){toast(err.message||"Could not open payment proof.",true);}}
  async function submit(form){
    if(!form.checkValidity())return form.reportValidity();
    const fd=new FormData(form);const file=fd.get("proof");const quoteId=form.dataset.quoteId;
    if(!file||!file.size)return toast("Choose a payment proof file.",true);
    if(file.size>10*1024*1024)return toast("Payment proof must be 10 MB or smaller.",true);
    if(!["image/jpeg","image/png","image/webp","application/pdf"].includes(file.type))return toast("Use JPG, PNG, WebP or PDF payment proof.",true);
    const {data:auth,error:authErr}=await client.auth.getUser();if(authErr||!auth?.user)return toast("Please sign in again.",true);
    const path=`${auth.user.id}/${quoteId}/${global.crypto?.randomUUID?.()||Date.now()}-${safeName(file.name)}`;
    const button=form.querySelector('button[type="submit"]');const original=button.textContent;button.disabled=true;button.textContent="Uploading proof…";
    let uploaded=false;
    try{
      const up=await client.storage.from("payment-proofs").upload(path,file,{cacheControl:"3600",upsert:false,contentType:file.type});if(up.error)throw up.error;uploaded=true;
      button.textContent="Submitting verification…";
      await rpc("customer_submit_payment",{p_quote_id:quoteId,p_method:String(fd.get("method")),p_amount:Number(fd.get("amount")),p_transaction_reference:String(fd.get("reference")||"").trim(),p_proof_path:path});
      toast("Payment proof submitted for CKA verification.");form.reset();await load();
    }catch(err){if(uploaded){try{await client.storage.from("payment-proofs").remove([path]);}catch(_){}}toast(err.message||"Could not submit payment proof.",true);}finally{button.disabled=false;button.textContent=original;}
  }

  document.addEventListener("click",(e)=>{const p=e.target.closest("[data-payment-proof]");if(p){e.preventDefault();openProof(p.dataset.paymentProof);}});
  document.addEventListener("submit",(e)=>{const f=e.target.closest(".payment-submit-form");if(!f)return;e.preventDefault();submit(f);});

  installShell();
  load().catch((err)=>console.warn("CKA CUSTOMER PAYMENTS INITIAL LOAD",err));
  const channel=client.channel(`cka-customer-payments-${Math.random().toString(36).slice(2)}`).on("postgres_changes",{event:"*",schema:"public",table:"quote_payments"},()=>load().catch(()=>{})).subscribe();
  global.addEventListener("beforeunload",()=>client.removeChannel(channel));
})(window);

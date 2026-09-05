/* CKA BuildStruct — admin-payments.js
   Staff payment verification panel layered into quotation drawer. */
(function (global) {
  "use strict";
  const client = global.CKAStore && global.CKAStore.supabase;
  if (!client) return;
  const esc=(v)=>String(v==null?"":v).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pkr=(v)=>`PKR ${Number(v||0).toLocaleString("en-PK",{maximumFractionDigits:2})}`;
  const date=(v)=>v?new Intl.DateTimeFormat("en-PK",{dateStyle:"medium",timeStyle:"short"}).format(new Date(v)):"—";
  let currentQuoteId=null;
  let loading=false;

  if(!document.querySelector('link[href*="assets/css/portal.css"]')){const css=document.createElement("link");css.rel="stylesheet";css.href="assets/css/portal.css?v=1";document.head.appendChild(css);}
  function toast(text,error){const box=document.getElementById("toasts");if(!box)return;const el=document.createElement("div");el.className=`toast${error?" toast--warn":""}`;el.textContent=text;box.appendChild(el);setTimeout(()=>el.remove(),3400);}
  function methodLabel(v){return({bank_transfer:"Bank Transfer",jazzcash:"JazzCash",easypaisa:"EasyPaisa",cod:"Cash on Delivery",credit_terms:"Credit Terms"})[v]||String(v||"").replace(/_/g," ");}
  function statusChip(v){const tone=v==="verified"?"good":v==="rejected"?"bad":"warn";return `<span class="ops__status" data-tone="${tone}">${esc(v)}</span>`;}
  async function rpc(name,args){const {data,error}=await client.rpc(name,args||{});if(error)throw error;return data;}

  function paymentHtml(p){return `<article class="portal__supplier-card" style="margin-top:10px"><div class="portal__supplier-head"><div><strong>${pkr(p.amount)} · ${esc(methodLabel(p.method))}</strong><div class="portal__supplier-meta">Reference ${esc(p.transaction_reference)} · submitted ${date(p.submitted_at)}</div></div><div>${statusChip(p.status)}</div></div>${p.review_notes?`<div class="portal__notice ${p.status==="rejected"?"portal__notice--bad":""}" style="margin-top:8px">${esc(p.review_notes)}</div>`:""}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:9px"><button class="btn btn--ghost btn--sm" data-admin-payment-proof="${esc(p.proof_path)}">Open private proof</button>${p.status==="submitted"?`<input class="input" style="max-width:310px" data-payment-note="${esc(p.id)}" placeholder="Review note (optional)" /><button class="btn btn--brand btn--sm" data-payment-review="${esc(p.id)}" data-decision="verified">Verify</button><button class="btn btn--ghost btn--sm" data-payment-review="${esc(p.id)}" data-decision="rejected">Reject</button>`:""}</div></article>`;}

  async function enhance(){
    if(!currentQuoteId||loading)return;
    const body=document.getElementById("ops-drawer-body");if(!body)return;
    loading=true;
    try{
      const data=await rpc("staff_quote_payment_overview",{p_quote_id:currentQuoteId});
      let section=document.getElementById("ops-payment-verification");if(section)section.remove();
      section=document.createElement("section");section.className="ops__section";section.id="ops-payment-verification";
      const required=Number(data.required_amount||0),verified=Number(data.verified_amount||0),pending=Number(data.submitted_amount||0),remaining=Number(data.remaining_amount||0);
      const fullyPaid=required>0&&verified>=required;
      section.innerHTML=`<div class="ops__section-head"><h3>Payment verification</h3><span class="ops__muted">Private proof + staff approval</span></div><div class="portal__grid"><div class="portal__kpi"><span>Payable</span><strong>${pkr(required)}</strong></div><div class="portal__kpi"><span>Verified</span><strong>${pkr(verified)}</strong></div><div class="portal__kpi"><span>Pending review</span><strong>${pkr(pending)}</strong></div><div class="portal__kpi"><span>Unverified balance</span><strong>${pkr(remaining)}</strong></div></div>${fullyPaid?'<div class="portal__notice portal__notice--good" style="margin-top:10px"><strong>Payment fully verified.</strong></div>':data.quote_status==="confirmed"||data.quote_status==="delivered"?'<div class="portal__notice" style="margin-top:10px">Customer may submit bank/JazzCash/EasyPaisa proof from the Customer Portal. COD and credit terms do not use this proof workflow.</div>':'<div class="portal__notice" style="margin-top:10px">Payment proof becomes active after the quotation is confirmed.</div>'}<div style="margin-top:12px"><h4 style="margin:0 0 8px">Submitted proofs</h4>${Array.isArray(data.payments)&&data.payments.length?data.payments.map(paymentHtml).join(""):'<p class="ops__muted">No payment proofs submitted.</p>'}</div>`;
      const procurement=document.getElementById("ops-procurement-controls");
      if(procurement)procurement.insertAdjacentElement("afterend",section);else body.appendChild(section);
    }catch(err){console.error("CKA PAYMENT DRAWER ENHANCEMENT FAILED",err);toast(err.message||"Could not load payment verification.",true);}finally{loading=false;}
  }

  async function openProof(path){try{const {data,error}=await client.storage.from("payment-proofs").createSignedUrl(path,300);if(error)throw error;global.open(data.signedUrl,"_blank","noopener");}catch(err){toast(err.message||"Could not open payment proof.",true);}}
  async function review(id,decision){
    const input=document.querySelector(`[data-payment-note="${CSS.escape(id)}"]`);const notes=input?.value?.trim()||null;
    if(decision==="verified"&&!global.confirm("Verify this payment proof? The amount will count toward the quotation's verified payment total."))return;
    if(decision==="rejected"&&!global.confirm("Reject this payment proof? The customer will be able to submit a corrected proof."))return;
    try{await rpc("staff_review_payment",{p_payment_id:id,p_decision:decision,p_review_notes:notes});toast(`Payment ${decision}.`);await enhance();}catch(err){toast(err.message||"Could not review payment.",true);}
  }

  document.addEventListener("click",(event)=>{
    const open=event.target.closest("[data-open-quote]");if(open){currentQuoteId=open.dataset.openQuote;setTimeout(enhance,120);setTimeout(enhance,420);}
    const proof=event.target.closest("[data-admin-payment-proof]");if(proof){event.preventDefault();openProof(proof.dataset.adminPaymentProof);}
    const reviewBtn=event.target.closest("[data-payment-review]");if(reviewBtn){event.preventDefault();review(reviewBtn.dataset.paymentReview,reviewBtn.dataset.decision);}
    if(event.target.closest("[data-close-ops-drawer]"))currentQuoteId=null;
  },true);
  const body=document.getElementById("ops-drawer-body");if(body)new MutationObserver(()=>{if(currentQuoteId)setTimeout(enhance,40);}).observe(body,{childList:true,subtree:true});
})(window);

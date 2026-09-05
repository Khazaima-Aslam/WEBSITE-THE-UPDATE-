/* CKA BuildStruct — product-detail.js */
(function (global) {
  "use strict";
  const client = global.CKAStore && global.CKAStore.supabase;
  const root = document.getElementById("product-root");
  const CART_KEY = "cka-basket-v1";
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pkr = (v) => `PKR ${Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits:2 })}`;

  function stableUiId(uuid) {
    const hex = String(uuid || "").replace(/-/g, "").slice(0, 12);
    const value = Number.parseInt(hex, 16);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid product identifier.");
    return value;
  }
  function humanStock(value) {
    return ({in_stock:"In stock",low_stock:"Low stock",on_order:"On order",out_of_stock:"Out of stock",rate_on_request:"Rate on request"})[value] || value || "Availability on request";
  }
  function range(min,max) {
    if (min == null || max == null) return "Rate on request";
    return `PKR ${Number(min).toLocaleString("en-PK")} – ${Number(max).toLocaleString("en-PK")}`;
  }
  function toast(text) {
    const box = document.getElementById("pd-toastbox");
    const el = document.createElement("div"); el.className="pd-toast"; el.textContent=text; box.appendChild(el);
    setTimeout(()=>el.remove(),3000);
  }
  function readCart() { try { const x=JSON.parse(localStorage.getItem(CART_KEY)); return Array.isArray(x)?x:[]; } catch (_) { return []; } }
  function addToCart(product) {
    const id = stableUiId(product.id);
    const cart = readCart();
    const line = cart.find((x)=>Number(x.id)===id);
    if (line) line.qty += 1; else cart.push({id,qty:1});
    localStorage.setItem(CART_KEY,JSON.stringify(cart));
    toast(`${product.name} added to quotation basket.`);
    const btn=document.getElementById("pd-add"); if(btn){btn.textContent="Added — open basket";btn.onclick=()=>global.location.href="materials.html?basket=1";}
  }
  function specsObject(row) {
    const s = row.specifications && typeof row.specifications === "object" ? {...row.specifications} : {};
    if (row.quality && !s.Quality) s.Quality=row.quality;
    if (row.unit && !s.Unit) s.Unit=row.unit;
    return s;
  }
  function render(row) {
    const galleryRaw = Array.isArray(row.images) ? row.images.map((x)=>x&&x.url).filter(Boolean) : [];
    const main = row.main_image || galleryRaw[0] || "assets/img/cement-bags.webp";
    const gallery = [main,...galleryRaw.filter((u)=>u!==main)];
    const specs = specsObject(row);
    document.title = `${row.name} — CKA BuildStruct`;
    root.innerHTML = `
      <div class="pd-breadcrumb"><a href="materials.html">Materials</a> / ${row.parent_category?`${esc(row.parent_category)} / `:""}<strong>${esc(row.category_name||"")}</strong></div>
      <section class="pd-shell">
        <article class="pd-gallery"><div class="pd-main-image"><img id="pd-main-img" src="${esc(main)}" alt="${esc(row.name)}" /></div><div class="pd-thumbs">${gallery.map((url,i)=>`<button class="pd-thumb ${i===0?"is-active":""}" data-img="${esc(url)}" aria-label="View image ${i+1}"><img src="${esc(url)}" alt="" /></button>`).join("")}</div></article>
        <article class="pd-info"><div class="pd-kicker">${esc(row.parent_category||"Materials")} · ${esc(row.category_name||"")}</div><h1 class="pd-title">${esc(row.name)}</h1><div class="pd-meta"><span>${esc(row.brand||"CKA sourced")}</span><span>Supplier: ${esc(row.supplier_name||"Verified supplier")}</span><span>Class ${esc(row.quality||"A")}</span>${row.rating!=null?`<span>★ ${esc(row.rating)}</span>`:""}</div><div class="pd-price">${row.old_price?`<s>${pkr(row.old_price)}</s>`:""}<strong>${pkr(row.price)}</strong><span>${esc(row.unit||"")}</span></div><div class="pd-range">Market range: ${esc(range(row.price_min,row.price_max))}</div><div class="pd-status">${esc(humanStock(row.stock))}</div><p class="pd-description">${esc(row.description||"Verified construction material available through CKA BuildStruct quotation and procurement workflow.")}</p><div class="pd-actions"><button class="pd-button" id="pd-add">Add to quotation</button><a class="pd-button pd-button--light" href="materials.html">Continue browsing</a></div></article>
      </section>
      <section class="pd-grid"><article class="pd-panel"><h2>Product specifications</h2>${Object.keys(specs).length?`<dl class="pd-specs">${Object.entries(specs).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`:'<p>No additional specifications are published yet.</p>'}</article><article class="pd-panel"><h2>Procurement information</h2><dl class="pd-specs"><dt>SKU</dt><dd>${esc(row.sku||"—")}</dd><dt>Category</dt><dd>${esc(row.category_name||"—")}</dd><dt>Availability</dt><dd>${esc(humanStock(row.stock))}</dd><dt>Supplier status</dt><dd>${row.supplier_verified?"Verified supplier":"CKA sourcing"}</dd></dl>${Array.isArray(row.tags)&&row.tags.length?`<div class="pd-tags" style="margin-top:14px">${row.tags.map((t)=>`<span class="pd-tag">${esc(t)}</span>`).join("")}</div>`:""}</article></section>`;
    document.getElementById("pd-add").addEventListener("click",()=>addToCart(row));
    root.addEventListener("click",(e)=>{const b=e.target.closest("[data-img]");if(!b)return;document.getElementById("pd-main-img").src=b.dataset.img;root.querySelectorAll(".pd-thumb").forEach((x)=>x.classList.toggle("is-active",x===b));});
  }
  async function boot() {
    if (!client) { root.innerHTML='<div class="pd-error">Material service is unavailable. Return to the marketplace and try again.</div>'; return; }
    const qs = new URLSearchParams(global.location.search);
    const id = qs.get("id"), sku = qs.get("sku");
    try {
      let q = client.from("v_catalogue").select("*");
      if (id) q = q.eq("id",id); else if (sku) q=q.eq("sku",sku); else throw new Error("No material was selected.");
      const {data,error}=await q.limit(1).maybeSingle();
      if(error) throw error; if(!data) throw new Error("This material is no longer available.");
      render(data);
    } catch(err) {
      root.innerHTML=`<div class="pd-error"><h2>Material unavailable</h2><p>${esc(err.message||"Could not load this material.")}</p><p><a class="pd-link" href="materials.html">Return to materials</a></p></div>`;
    }
  }
  boot();
})(window);

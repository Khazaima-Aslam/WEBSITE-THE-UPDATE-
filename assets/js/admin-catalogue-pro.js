/* CKA BuildStruct — admin-catalogue-pro.js
   Production catalogue manager backed by atomic Supabase RPCs. */
(function (global) {
  "use strict";
  const client = global.CKAStore && global.CKAStore.supabase;
  const runtime = global.CKAAdminRuntime;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pkr = (v) => `PKR ${Number(v || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
  const state = { products:[], categories:[], suppliers:[], gallery:[], originalGallery:[], currentProduct:null, currentCategory:null, saving:false };
  const STOCK_LABELS = { in_stock:"In stock", low_stock:"Low stock", on_order:"On order", out_of_stock:"Out of stock", rate_on_request:"Rate on request" };

  if (!client || !runtime) return;

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) throw error;
    return data;
  }
  function toast(message, warn) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = `toast${warn ? " toast--warn" : ""}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => { el.classList.add("is-leaving"); setTimeout(() => el.remove(), 250); }, 3500);
  }
  function setView(view) {
    $$(".adm__navlink[data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
    $$(".adm__view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === view));
    global.scrollTo(0,0);
  }
  function roots(activeOnly) { return state.categories.filter((c) => !c.parent_id && (!activeOnly || c.is_active)); }
  function children(parentId, activeOnly) { return state.categories.filter((c) => String(c.parent_id || "") === String(parentId || "") && (!activeOnly || c.is_active)); }
  function categoryById(id) { return state.categories.find((c) => String(c.id) === String(id)); }
  function supplierById(id) { return state.suppliers.find((s) => String(s.id) === String(id)); }
  function productById(id) { return state.products.find((p) => String(p.id) === String(id)); }
  function specsText(specs) {
    if (!specs || typeof specs !== "object" || Array.isArray(specs)) return "";
    return Object.entries(specs).filter(([k]) => !["grade","size","badge"].includes(k)).map(([k,v]) => `${k}: ${v}`).join("; ");
  }
  function parseSpecs(text) {
    const out = {};
    String(text || "").split(";").map((x)=>x.trim()).filter(Boolean).forEach((part) => {
      const i = part.indexOf(":");
      if (i > 0) {
        const k = part.slice(0,i).trim();
        const v = part.slice(i+1).trim();
        if (k && v) out[k] = v;
      }
    });
    return out;
  }
  function normalGallery(images, imageUrl, name) {
    const seen = new Set();
    const rows = Array.isArray(images) ? images.slice() : [];
    if (imageUrl && !rows.some((x) => x && x.url === imageUrl)) rows.unshift({ url:imageUrl, alt:name || "", position:0 });
    return rows
      .map((x) => typeof x === "string" ? {url:x,alt:name || ""} : {url:x?.url || "",alt:x?.alt || name || ""})
      .filter((x) => x.url && !seen.has(x.url) && seen.add(x.url))
      .slice(0,12);
  }

  async function loadAll() {
    const [products, categories, suppliers] = await Promise.all([
      rpc("staff_catalogue_products"),
      rpc("staff_catalogue_categories"),
      client.from("suppliers").select("id,company_name,is_verified,city").order("company_name", { ascending:true })
    ]);
    if (suppliers.error) throw suppliers.error;
    state.products = products || [];
    state.categories = categories || [];
    state.suppliers = suppliers.data || [];
    renderEverything();
  }

  function renderEverything() {
    populateFilters();
    populateSupplierOptions();
    renderProducts();
    renderCategories();
    renderInsights();
  }
  function populateFilters() {
    const rootSelect = $("#adm-root");
    const selected = rootSelect.value;
    rootSelect.innerHTML = '<option value="">All root categories</option>' + roots(false).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.is_active ? "" : " (inactive)"}</option>`).join("");
    if ([...rootSelect.options].some((o)=>o.value===selected)) rootSelect.value = selected;
  }
  function populateSupplierOptions() {
    const select = $("#ed-supplier");
    select.innerHTML = '<option value="">No supplier</option>' + state.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.company_name)}${s.is_verified ? " ✓" : ""}</option>`).join("");
  }
  function filteredProducts() {
    const q = $("#adm-search").value.trim().toLowerCase();
    const root = $("#adm-root").value;
    const stock = $("#adm-stock").value;
    const active = $("#adm-active").value;
    return state.products.filter((p) => {
      if (root && String(p.parent_category_id) !== root) return false;
      if (stock && p.stock !== stock) return false;
      if (active === "active" && !p.is_active) return false;
      if (active === "inactive" && p.is_active) return false;
      if (q) {
        const hay = [p.name,p.sku,p.brand,p.category_name,p.parent_category_name,p.supplier_name,...(p.tags || [])].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function renderProducts() {
    const list = filteredProducts();
    const activeCount = state.products.filter((p)=>p.is_active).length;
    $("#cat-summary").textContent = `${activeCount} active · ${state.products.length} total · ${state.categories.filter((c)=>c.parent_id && c.is_active).length} active subcategories`;
    $("#adm-empty").hidden = list.length > 0;
    $("#adm-rows").innerHTML = list.map((p) => {
      const image = p.image_url || (Array.isArray(p.images) && p.images[0]?.url) || "";
      return `<tr class="${p.is_active ? "" : "pro-row-inactive"}">
        <td>${image ? `<img class="pro-thumb" src="${esc(image)}" alt="" loading="lazy">` : '<span class="pro-noimg"></span>'}</td>
        <td><strong>${esc(p.name)}</strong><small>${esc(p.sku || "No SKU")} · ${esc(p.brand || "No brand")}</small></td>
        <td><strong>${esc(p.category_name)}</strong><small>${esc(p.parent_category_name || "")}</small></td>
        <td>${esc(p.supplier_name || "—")}</td>
        <td class="num"><strong>${pkr(p.price)}</strong>${p.old_price ? `<small><s>${pkr(p.old_price)}</s></small>` : ""}</td>
        <td>${esc(p.unit)}</td>
        <td>${esc(STOCK_LABELS[p.stock] || p.stock || "—")}</td>
        <td><span class="pro-status ${p.is_active ? "is-active" : "is-inactive"}">${p.is_active ? "Active" : "Inactive"}</span></td>
        <td><div class="pro-inline"><button class="pro-mini" type="button" data-edit-product="${esc(p.id)}">Edit</button><button class="pro-mini ${p.is_active ? "is-danger" : ""}" type="button" data-toggle-product="${esc(p.id)}">${p.is_active ? "Deactivate" : "Reactivate"}</button></div></td>
      </tr>`;
    }).join("");
  }

  function populateProductHierarchy(rootId, categoryId) {
    const rootSelect = $("#ed-root");
    rootSelect.innerHTML = roots(true).map((r)=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    if (rootId && [...rootSelect.options].some((o)=>o.value===String(rootId))) rootSelect.value = String(rootId);
    const chosenRoot = rootSelect.value;
    const sub = $("#ed-subcategory");
    sub.innerHTML = children(chosenRoot,true).map((c)=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
    if (categoryId && [...sub.options].some((o)=>o.value===String(categoryId))) sub.value = String(categoryId);
  }

  function openProduct(product) {
    state.currentProduct = product || null;
    const form = $("#editor-form");
    form.reset();
    $("#editor-title").textContent = product ? product.name : "New product";
    $("#editor-mode").textContent = product ? `Product UUID ${product.id}` : "Create live product";
    const p = product || { quality:"A",stock:"in_stock",is_active:true,is_featured:false,display_order:0 };
    const values = {
      id:p.id || "", name:p.name || "", sku:p.sku || "", brand:p.brand || "", supplier_id:p.supplier_id || "", unit:p.unit || "",
      stock:p.stock || "in_stock", price:p.price ?? "", old_price:p.old_price ?? "", price_min:p.price_min ?? "", price_max:p.price_max ?? "",
      quality:p.quality || "A", grade:p.specifications?.grade || "", size:p.specifications?.size || "", badge:p.specifications?.badge || "",
      display_order:p.display_order ?? 0, rating:p.rating ?? "", description:p.description || "", specs:specsText(p.specifications), tags:(p.tags || []).join(", ")
    };
    Object.entries(values).forEach(([k,v]) => { if (form.elements[k]) form.elements[k].value = v; });
    form.elements.is_featured.checked = !!p.is_featured;
    form.elements.is_active.checked = p.is_active !== false;
    populateProductHierarchy(p.parent_category_id || roots(true)[0]?.id || "", p.category_id || "");
    form.elements.supplier_id.value = p.supplier_id || "";
    state.gallery = normalGallery(p.images,p.image_url,p.name);
    state.originalGallery = state.gallery.map((x)=>({...x}));
    renderGallery();
    $("#save-state").textContent = "";
    $("#editor").classList.add("is-open");
    $("#editor").setAttribute("aria-hidden","false");
  }
  function closeProduct() {
    if (state.saving) return;
    $("#editor").classList.remove("is-open");
    $("#editor").setAttribute("aria-hidden","true");
    state.currentProduct = null;
  }
  function renderGallery() {
    $("#gallery-list").innerHTML = state.gallery.length ? state.gallery.map((img,i)=>`<article class="pro-gallery-card ${i===0?"is-main":""}" data-gallery-index="${i}">
      <img src="${esc(img.url)}" alt="${esc(img.alt || "")}" loading="lazy">
      <div class="pro-gallery-card__body">${i===0?'<span class="pro-main-badge">Main image</span>':""}<input class="input" data-gallery-alt value="${esc(img.alt || "")}" placeholder="Image alt text"><small>${esc(img.url)}</small><div class="pro-gallery-card__actions">${i>0?'<button class="pro-mini" type="button" data-gallery-main>Set main</button>':""}${i>0?'<button class="pro-mini" type="button" data-gallery-up>←</button>':""}${i<state.gallery.length-1?'<button class="pro-mini" type="button" data-gallery-down>→</button>':""}<button class="pro-mini is-danger" type="button" data-gallery-remove>Remove</button></div></div>
    </article>`).join("") : '<p class="pro-muted">No images yet. Upload one or add a URL.</p>';
  }

  async function uploadImages(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (state.gallery.length + list.length > 12) return toast("A product can have at most 12 images.", true);
    const input = $("#product-image-upload");
    input.disabled = true;
    try {
      for (const file of list) {
        const uploaded = await runtime.uploadProductImage(file);
        state.gallery.push({ url:uploaded.url, alt:$("#editor-form").elements.name.value.trim() || file.name });
      }
      renderGallery();
      toast(`${list.length} image${list.length===1?"":"s"} uploaded. Save the product to attach them.`);
    } catch (err) {
      console.error(err); toast(err.message || "Image upload failed.", true);
    } finally { input.disabled = false; input.value = ""; }
  }

  function buildProductPayload(product, overrides) {
    if (overrides) return { product:{...overrides}, images:overrides.images || [] };
    const form = $("#editor-form");
    const specs = parseSpecs(form.elements.specs.value);
    const grade = form.elements.grade.value.trim(); const size = form.elements.size.value.trim(); const badge = form.elements.badge.value.trim();
    if (grade) specs.grade=grade; if (size) specs.size=size; if (badge) specs.badge=badge;
    const productPayload = {
      id:form.elements.id.value || null,
      sku:form.elements.sku.value.trim() || null,
      category_id:form.elements.category_id.value,
      supplier_id:form.elements.supplier_id.value || null,
      name:form.elements.name.value.trim(), brand:form.elements.brand.value.trim() || null,
      description:form.elements.description.value.trim() || null, unit:form.elements.unit.value.trim(),
      price:form.elements.price.value, old_price:form.elements.old_price.value || null,
      price_min:form.elements.price_min.value || null, price_max:form.elements.price_max.value || null,
      stock:form.elements.stock.value, quality:form.elements.quality.value, specifications:specs,
      tags:form.elements.tags.value.split(",").map((x)=>x.trim()).filter(Boolean),
      is_featured:form.elements.is_featured.checked, is_active:form.elements.is_active.checked,
      display_order:form.elements.display_order.value || 0, rating:form.elements.rating.value || null
    };
    return { product:productPayload, images:state.gallery.map((x)=>({url:x.url,alt:x.alt || productPayload.name})) };
  }

  async function fetchFreshProducts() {
    state.products = await rpc("staff_catalogue_products") || [];
    renderProducts(); renderInsights();
    return state.products;
  }
  function verifySaved(fresh, payload) {
    const p = payload.product;
    const imageUrls = (fresh.images || []).map((x)=>x.url);
    const expectedUrls = payload.images.map((x)=>x.url);
    const checks = [
      fresh.name === p.name,
      fresh.unit === p.unit,
      Number(fresh.price) === Number(p.price),
      String(fresh.category_id) === String(p.category_id),
      String(fresh.supplier_id || "") === String(p.supplier_id || ""),
      fresh.stock === p.stock,
      fresh.quality === p.quality,
      fresh.is_active === !!p.is_active,
      fresh.is_featured === !!p.is_featured,
      imageUrls.length === expectedUrls.length,
      expectedUrls.every((u,i)=>imageUrls[i]===u)
    ];
    if (!checks.every(Boolean)) throw new Error("The database save completed but verification did not match every edited field. The editor has not been closed.");
  }

  async function saveProduct() {
    if (state.saving) return;
    const form = $("#editor-form");
    const invalid = $$('input,select,textarea',form).find((el)=>el.willValidate && !el.checkValidity());
    if (invalid) { invalid.reportValidity(); invalid.focus(); return; }
    if (!form.elements.category_id.value) return toast("Choose a subcategory.", true);
    const payload = buildProductPayload();
    if (payload.product.price_min && payload.product.price_max && Number(payload.product.price_min)>Number(payload.product.price_max)) return toast("Market minimum cannot exceed market maximum.",true);
    const button = $("#save-product");
    state.saving = true; button.disabled = true; document.body.classList.add("pro-saving"); $("#save-state").textContent = "Saving to Supabase…";
    try {
      const id = await rpc("staff_save_catalogue_product", { p_product:payload.product, p_images:payload.images });
      $("#save-state").textContent = "Verifying persisted row…";
      await fetchFreshProducts();
      const fresh = productById(id);
      if (!fresh) throw new Error("Saved product could not be reloaded from the staff catalogue.");
      verifySaved(fresh,payload);
      const removed = state.originalGallery.map((x)=>x.url).filter((u)=>!payload.images.some((x)=>x.url===u));
      for (const url of removed) {
        try { await runtime.deleteImageIfUnreferenced(url); } catch (err) { console.warn("Image cleanup skipped",url,err); }
      }
      $("#save-state").textContent = "Saved and verified.";
      toast("Product saved and verified in Supabase.");
      setTimeout(closeProduct,180);
    } catch (err) {
      console.error("CKA PRODUCT SAVE FAILED",err);
      $("#save-state").textContent = "Save failed — nothing was confirmed.";
      toast(err.message || "Product save failed.",true);
    } finally {
      state.saving=false; button.disabled=false; document.body.classList.remove("pro-saving");
    }
  }

  async function toggleProduct(product) {
    const payload = {
      id:product.id, sku:product.sku, category_id:product.category_id, supplier_id:product.supplier_id,
      name:product.name, brand:product.brand, description:product.description, unit:product.unit, price:product.price,
      old_price:product.old_price, price_min:product.price_min, price_max:product.price_max, stock:product.stock,
      quality:product.quality, specifications:product.specifications || {}, tags:product.tags || [], is_featured:product.is_featured,
      display_order:product.display_order, rating:product.rating, is_active:!product.is_active
    };
    if (!global.confirm(`${product.is_active ? "Deactivate" : "Reactivate"} “${product.name}”?`)) return;
    try {
      await rpc("staff_save_catalogue_product", { p_product:payload, p_images:normalGallery(product.images,product.image_url,product.name) });
      await fetchFreshProducts(); toast(`Product ${product.is_active ? "deactivated" : "reactivated"}.`);
    } catch (err) { toast(err.message || "Status change failed.",true); }
  }

  function renderCategories() {
    const rootRows = roots(false);
    $("#cat-cards").innerHTML = rootRows.map((root) => {
      const kids = children(root.id,false);
      return `<article class="pro-category-card"><header class="pro-category-card__head"><div><h3>${esc(root.name)}</h3><small>${kids.length} subcategories · order ${esc(root.display_order)}</small></div><div class="pro-category-actions"><span class="pro-status ${root.is_active?"is-active":"is-inactive"}">${root.is_active?"Active":"Inactive"}</span><button class="pro-mini" data-edit-category="${esc(root.id)}" type="button">Edit</button><button class="pro-mini" data-new-subcategory="${esc(root.id)}" type="button">+ Subcategory</button></div></header><ul class="pro-category-list">${kids.map((c)=>`<li><div><strong>${esc(c.name)}</strong><small>${esc(c.product_count)} products · /${esc(c.slug)} · order ${esc(c.display_order)}</small></div><div class="pro-category-actions"><span class="pro-status ${c.is_active?"is-active":"is-inactive"}">${c.is_active?"Active":"Inactive"}</span><button class="pro-mini" data-edit-category="${esc(c.id)}" type="button">Edit</button></div></li>`).join("") || '<li><span class="pro-muted">No subcategories yet.</span></li>'}</ul></article>`;
    }).join("");
  }

  function openCategory(category, parentId) {
    state.currentCategory = category || null;
    const form = $("#category-form"); form.reset();
    form.elements.id.value = category?.id || "";
    form.elements.name.value = category?.name || "";
    form.elements.slug.value = category?.slug || "";
    form.elements.description.value = category?.description || "";
    form.elements.display_order.value = category?.display_order ?? 0;
    form.elements.is_active.checked = category ? !!category.is_active : true;
    const parentSelect = $("#category-parent");
    parentSelect.innerHTML = '<option value="">Root category</option>' + roots(true).filter((r)=>!category || r.id!==category.id).map((r)=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    parentSelect.value = category?.parent_id || parentId || "";
    $("#category-editor-title").textContent = category ? `Edit ${category.name}` : (parentId ? "New subcategory" : "New root category");
    $("#category-meta").textContent = category ? `${category.product_count} products · ${category.child_count} child categories` : "New category. Slug will be generated automatically if left blank.";
    $("#delete-category").hidden = !category;
    $("#category-editor").classList.add("is-open"); $("#category-editor").setAttribute("aria-hidden","false");
  }
  function closeCategory() { $("#category-editor").classList.remove("is-open"); $("#category-editor").setAttribute("aria-hidden","true"); state.currentCategory=null; }
  async function saveCategory() {
    const form=$("#category-form"); const invalid=$$('input,select,textarea',form).find((el)=>el.willValidate&&!el.checkValidity()); if(invalid){invalid.reportValidity();return;}
    const button=$("#save-category"); button.disabled=true;
    try {
      await rpc("staff_save_category", {
        p_id:form.elements.id.value || null, p_parent_id:form.elements.parent_id.value || null,
        p_name:form.elements.name.value.trim(), p_slug:form.elements.slug.value.trim() || null,
        p_description:form.elements.description.value.trim() || null,
        p_display_order:Number(form.elements.display_order.value || 0), p_is_active:form.elements.is_active.checked
      });
      state.categories = await rpc("staff_catalogue_categories") || [];
      renderCategories(); populateFilters(); closeCategory(); toast("Category saved.");
    } catch(err){toast(err.message || "Category save failed.",true);} finally{button.disabled=false;}
  }
  async function deleteCategory() {
    const c=state.currentCategory; if(!c)return;
    if(!global.confirm(`Permanently delete “${c.name}”? This is only allowed when it has no products or subcategories.`))return;
    try{await rpc("staff_delete_category",{p_id:c.id});state.categories=await rpc("staff_catalogue_categories")||[];renderCategories();populateFilters();closeCategory();toast("Unused category deleted.");}
    catch(err){toast(err.message || "Category deletion was blocked.",true);}
  }

  function renderInsights() {
    const active=state.products.filter((p)=>p.is_active); const inactive=state.products.length-active.length;
    const missingImage=active.filter((p)=>!(p.image_url || p.images?.length)).length;
    const noSupplier=active.filter((p)=>!p.supplier_id).length;
    const withGallery=active.filter((p)=>(p.images||[]).length>1).length;
    const priced=active.filter((p)=>Number(p.price)>0); const avg=priced.length?priced.reduce((s,p)=>s+Number(p.price),0)/priced.length:0;
    $("#adm-stats").innerHTML=[["Active products",active.length],["Inactive products",inactive],["Active subcategories",state.categories.filter((c)=>c.parent_id&&c.is_active).length],["Multi-image products",withGallery],["Missing images",missingImage],["No supplier",noSupplier],["Average price",pkr(avg)]].map(([a,b])=>`<div class="adm__stat"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join("");
    const byRoot={}; active.forEach((p)=>{byRoot[p.parent_category_name||"Other"]=(byRoot[p.parent_category_name||"Other"]||0)+1;});
    $("#adm-breakdown").innerHTML=`<article class="adm__card adm__card--wide"><h3>Active products by root category</h3><ul class="adm__catlist">${Object.entries(byRoot).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<li><span>${esc(k)}</span><b>${v}</b></li>`).join("")}</ul></article>`;
  }

  const EXPORT_COLUMNS = ["Product UUID","SKU","Root Category","Subcategory","Product Name","Brand","Supplier","Unit","Current Price","Old Price","Market Min","Market Max","Availability","Quality","Grade","Size","Badge","Featured","Active","Display Order","Rating","Description","Specifications","Tags","Gallery URLs"];
  function exportRow(p) {
    const specs={...(p.specifications||{})}; const grade=specs.grade||"";const size=specs.size||"";const badge=specs.badge||"";delete specs.grade;delete specs.size;delete specs.badge;
    return {"Product UUID":p.id,"SKU":p.sku||"","Root Category":p.parent_category_name||"","Subcategory":p.category_name||"","Product Name":p.name,"Brand":p.brand||"","Supplier":p.supplier_name||"","Unit":p.unit,"Current Price":p.price,"Old Price":p.old_price??"","Market Min":p.price_min??"","Market Max":p.price_max??"","Availability":p.stock,"Quality":p.quality,"Grade":grade,"Size":size,"Badge":badge,"Featured":p.is_featured?"Yes":"No","Active":p.is_active?"Yes":"No","Display Order":p.display_order,"Rating":p.rating??"","Description":p.description||"","Specifications":Object.entries(specs).map(([k,v])=>`${k}: ${v}`).join("; "),"Tags":(p.tags||[]).join(", "),"Gallery URLs":normalGallery(p.images,p.image_url,p.name).map((x)=>x.url).join(" | ")};
  }
  function exportExcel() {
    if (!global.XLSX) return toast("Excel library is unavailable.",true);
    const ws=global.XLSX.utils.json_to_sheet(state.products.map(exportRow),{header:EXPORT_COLUMNS});
    ws["!cols"]=EXPORT_COLUMNS.map((h)=>({wch:Math.min(42,Math.max(14,h.length+3))}));
    const wb=global.XLSX.utils.book_new();global.XLSX.utils.book_append_sheet(wb,ws,"Products");global.XLSX.writeFile(wb,`CKA-catalogue-${new Date().toISOString().slice(0,10)}.xlsx`);toast("Catalogue exported.");
  }
  function findSubcategory(rootName,subName){const root=roots(false).find((r)=>r.name.toLowerCase()===String(rootName||"").trim().toLowerCase());if(!root)return null;return children(root.id,false).find((c)=>c.name.toLowerCase()===String(subName||"").trim().toLowerCase())||null;}
  function findSupplier(name){const n=String(name||"").trim().toLowerCase();if(!n)return null;const matches=state.suppliers.filter((s)=>s.company_name.toLowerCase()===n);return matches.length===1?matches[0]:null;}
  function importPayloadFromRow(r,line){
    const errors=[];const cat=findSubcategory(r["Root Category"],r["Subcategory"]);if(!cat)errors.push("Root Category/Subcategory does not resolve uniquely");
    const name=String(r["Product Name"]||"").trim();const unit=String(r["Unit"]||"").trim();const price=Number(r["Current Price"]);if(!name)errors.push("Product Name is required");if(!unit)errors.push("Unit is required");if(!Number.isFinite(price)||price<0)errors.push("Current Price must be zero or above");
    const supplierName=String(r["Supplier"]||"").trim();const supplier=findSupplier(supplierName);if(supplierName&&!supplier)errors.push("Supplier name is missing or duplicated");
    const specs=parseSpecs(r["Specifications"]);if(r["Grade"])specs.grade=String(r["Grade"]);if(r["Size"])specs.size=String(r["Size"]);if(r["Badge"])specs.badge=String(r["Badge"]);
    const urls=String(r["Gallery URLs"]||"").split("|").map((x)=>x.trim()).filter(Boolean).slice(0,12);
    return { line, errors, row:{ product:{id:String(r["Product UUID"]||"").trim()||null,sku:String(r["SKU"]||"").trim()||null,category_id:cat?.id||null,supplier_id:supplier?.id||null,name,brand:String(r["Brand"]||"").trim()||null,description:String(r["Description"]||"").trim()||null,unit,price,old_price:r["Old Price"]===""||r["Old Price"]==null?null:Number(r["Old Price"]),price_min:r["Market Min"]===""||r["Market Min"]==null?null:Number(r["Market Min"]),price_max:r["Market Max"]===""||r["Market Max"]==null?null:Number(r["Market Max"]),stock:String(r["Availability"]||"in_stock").trim(),quality:String(r["Quality"]||"A").trim(),specifications:specs,tags:String(r["Tags"]||"").split(",").map((x)=>x.trim()).filter(Boolean),is_featured:/^y/i.test(String(r["Featured"]||"")),is_active:!/^n/i.test(String(r["Active"]||"Yes")),display_order:Number(r["Display Order"]||0),rating:r["Rating"]===""||r["Rating"]==null?null:Number(r["Rating"])},images:urls.map((url)=>({url,alt:name})) } };
  }
  async function handleImport(file) {
    if(!global.XLSX)return toast("Excel library is unavailable.",true);
    const buf=await file.arrayBuffer();const wb=global.XLSX.read(buf,{type:"array"});const ws=wb.Sheets["Products"]||wb.Sheets[wb.SheetNames[0]];const rows=global.XLSX.utils.sheet_to_json(ws,{defval:""});
    const parsed=rows.map((r,i)=>importPayloadFromRow(r,i+2));const bad=parsed.filter((x)=>x.errors.length);const box=$("#import-report");box.hidden=false;
    if(bad.length){box.innerHTML=`<div class="pro-report"><h3>Import blocked</h3><p>${bad.length} row(s) need correction. No database writes were attempted.</p><ul class="bad">${bad.slice(0,30).map((x)=>`<li>Row ${x.line}: ${esc(x.errors.join("; "))}</li>`).join("")}</ul></div>`;return;}
    box.innerHTML=`<div class="pro-report"><h3>Import ready</h3><p>${parsed.length} validated row(s). The entire import will run in one database transaction.</p><button class="btn btn--brand" id="apply-import" type="button">Apply atomic import</button></div>`;
    $("#apply-import").addEventListener("click",async()=>{if(!global.confirm(`Apply ${parsed.length} catalogue rows? Any database error will roll back the whole import.`))return;const b=$("#apply-import");b.disabled=true;try{await rpc("staff_import_catalogue_products",{p_rows:parsed.map((x)=>x.row)});await fetchFreshProducts();box.innerHTML=`<div class="pro-report ok"><h3>Import complete</h3><p>${parsed.length} rows saved atomically and catalogue reloaded.</p></div>`;toast("Atomic catalogue import completed.");}catch(err){box.innerHTML=`<div class="pro-report bad"><h3>Import rolled back</h3><p>${esc(err.message||"Import failed")}</p></div>`;toast("Import failed; database transaction was rolled back.",true);}finally{b.disabled=false;}});
  }

  function installEvents() {
    $$(".adm__navlink[data-view]").forEach((b)=>b.addEventListener("click",()=>setView(b.dataset.view)));
    ["adm-search","adm-root","adm-stock","adm-active"].forEach((id)=>$("#"+id).addEventListener("input",renderProducts));
    $("#new-product").addEventListener("click",()=>openProduct(null));
    $("#ed-root").addEventListener("change",()=>populateProductHierarchy($("#ed-root").value,""));
    $$("[data-close-editor]").forEach((b)=>b.addEventListener("click",closeProduct));
    $("#save-product").addEventListener("click",saveProduct);
    $("#product-image-upload").addEventListener("change",(e)=>uploadImages(e.target.files));
    $("#add-gallery-url").addEventListener("click",()=>{const input=$("#gallery-url");const url=input.value.trim();if(!/^https:\/\//i.test(url))return toast("Enter a valid HTTPS image URL.",true);if(state.gallery.length>=12)return toast("A product can have at most 12 images.",true);if(!state.gallery.some((x)=>x.url===url))state.gallery.push({url,alt:$("#editor-form").elements.name.value.trim()});input.value="";renderGallery();});
    $("#gallery-list").addEventListener("input",(e)=>{const card=e.target.closest("[data-gallery-index]");if(card&&e.target.matches("[data-gallery-alt]"))state.gallery[Number(card.dataset.galleryIndex)].alt=e.target.value;});
    $("#gallery-list").addEventListener("click",(e)=>{const card=e.target.closest("[data-gallery-index]");if(!card)return;const i=Number(card.dataset.galleryIndex);if(e.target.closest("[data-gallery-main]")){const [x]=state.gallery.splice(i,1);state.gallery.unshift(x);}else if(e.target.closest("[data-gallery-up]")&&i>0){[state.gallery[i-1],state.gallery[i]]=[state.gallery[i],state.gallery[i-1]];}else if(e.target.closest("[data-gallery-down]")&&i<state.gallery.length-1){[state.gallery[i+1],state.gallery[i]]=[state.gallery[i],state.gallery[i+1]];}else if(e.target.closest("[data-gallery-remove]")){state.gallery.splice(i,1);}else{return;}renderGallery();});
    $("#adm-rows").addEventListener("click",(e)=>{const edit=e.target.closest("[data-edit-product]");if(edit)return openProduct(productById(edit.dataset.editProduct));const toggle=e.target.closest("[data-toggle-product]");if(toggle)return toggleProduct(productById(toggle.dataset.toggleProduct));});
    $("#new-root-category").addEventListener("click",()=>openCategory(null,null));
    $("#cat-cards").addEventListener("click",(e)=>{const edit=e.target.closest("[data-edit-category]");if(edit)return openCategory(categoryById(edit.dataset.editCategory));const add=e.target.closest("[data-new-subcategory]");if(add)return openCategory(null,add.dataset.newSubcategory);});
    $$("[data-close-category]").forEach((b)=>b.addEventListener("click",closeCategory));
    $("#save-category").addEventListener("click",saveCategory);$("#delete-category").addEventListener("click",deleteCategory);
    $("#export-xlsx").addEventListener("click",exportExcel);$("#import-xlsx").addEventListener("change",async(e)=>{const f=e.target.files?.[0];e.target.value="";if(!f)return;try{await handleImport(f);}catch(err){toast(err.message||"Workbook could not be read.",true);}});
    $("#admin-signout").addEventListener("click",async()=>{await client.auth.signOut();global.location.replace("admin-login.html");});
    document.addEventListener("keydown",(e)=>{if(e.key==="Escape"){if($("#category-editor").classList.contains("is-open"))closeCategory();else closeProduct();}});
  }

  async function boot() {
    try { installEvents(); await loadAll(); console.log("CKA CATALOGUE ADMIN: atomic console ready"); }
    catch (err) { console.error("CKA CATALOGUE ADMIN LOAD FAILED",err); toast(err.message || "Catalogue could not load.",true); }
  }
  boot();
})(window);

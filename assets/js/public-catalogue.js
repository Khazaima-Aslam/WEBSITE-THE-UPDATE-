/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — public-catalogue.js

   Production bootstrap for the materials marketplace.
   - Loads v_catalogue before the existing app starts.
   - Keeps data.js as an emergency catalogue fallback.
   - Bridges Supabase UUIDs to stable numeric IDs for the legacy cart UI.
   - Persists checkout through the validated submit_quote RPC before
     allowing the existing success UI to run.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const MIN_EXPECTED_PRODUCTS = 1;
  const CART_KEY = "cka-basket-v1";

  function stableUiId(uuid) {
    const hex = String(uuid || "").replace(/-/g, "").slice(0, 12);
    const value = Number.parseInt(hex, 16);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Invalid live product UUID");
    }
    return value;
  }

  function humanStock(value) {
    return ({
      in_stock: "In stock",
      low_stock: "Low stock",
      on_order: "On order",
      out_of_stock: "Out of stock",
      rate_on_request: "Rate on request"
    })[value] || value || "";
  }

  function rangeText(min, max) {
    if (min == null || max == null) return "Rate on request";
    const format = (value) => Number(value).toLocaleString("en-PK");
    return `PKR ${format(min)} – ${format(max)}`;
  }

  function toProduct(row) {
    const specs = row.specifications && typeof row.specifications === "object"
      ? row.specifications
      : {};
    const gallery = Array.isArray(row.images)
      ? row.images.map((item) => item && item.url).filter(Boolean)
      : [];
    const mainImage = row.main_image || gallery[0] || "assets/img/cement-bags.webp";
    const images = [mainImage, ...gallery.filter((url) => url !== mainImage)];

    return {
      id: stableUiId(row.id),
      dbId: row.id,
      sku: row.sku || "",
      title: row.name || "",
      category: row.category_name || "",
      subcategory: row.parent_category ? row.category_name || "" : "",
      quality: row.quality || "A",
      price: Number(row.price) || 0,
      oldPrice: Number(row.old_price) || 0,
      unit: row.unit || "",
      range: rangeText(row.price_min, row.price_max),
      badge: specs.badge || specs.grade || specs.size || row.quality || "",
      grade: specs.grade || "",
      size: specs.size || "",
      brand: row.brand || "",
      supplier: row.supplier_name || "Verified supplier",
      rating: Number(row.rating) || 0,
      deals: row.order_count == null ? 0 : Number(row.order_count),
      stock: humanStock(row.stock),
      featured: !!row.is_featured,
      order: Number(row.display_order) || 0,
      tags: Array.isArray(row.tags) ? row.tags : [],
      description: row.description || "",
      img: mainImage,
      images
    };
  }

  function paymentValue(label) {
    return ({
      "Bank Transfer": "bank_transfer",
      "JazzCash": "jazzcash",
      "EasyPaisa": "easypaisa",
      "Cash on Delivery": "cod"
    })[label] || null;
  }

  function readCart() {
    try {
      const value = JSON.parse(localStorage.getItem(CART_KEY));
      return Array.isArray(value) ? value : [];
    } catch (err) {
      return [];
    }
  }

  function quoteItemsFromCart(cart) {
    return cart.map((line) => {
      const product = PRODUCTS.find((p) => Number(p.id) === Number(line.id));
      if (!product) throw new Error("A basket item is no longer available.");

      const quantity = Number(line.qty);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("A basket item has an invalid quantity.");
      }

      if (product.dbId) {
        return { product_id: product.dbId, variant_id: null, quantity };
      }

      return {
        name: product.title,
        unit: product.unit,
        unit_price: Number(product.price) || 0,
        quantity
      };
    });
  }

  function showCheckoutError(message) {
    console.error("CKA QUOTE SUBMIT:", message);
    global.alert(message || "Could not submit the quotation request. Please try again.");
  }

  function installRealCheckout(client) {
    const button = document.getElementById("checkout-next");
    const checkoutView = document.getElementById("drawer-checkout-view");
    const form = document.getElementById("checkout-form");
    if (!button || !checkoutView || !form || !client) return;

    let allowExistingSuccessHandler = false;
    let submitting = false;

    button.addEventListener("click", async function (event) {
      if (allowExistingSuccessHandler || checkoutView.hidden) return;
      if (!form.checkValidity()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (submitting) return;

      const cart = readCart();
      if (!cart.length) {
        showCheckoutError("Your basket is empty. Add at least one material first.");
        return;
      }

      submitting = true;
      const originalHtml = button.innerHTML;
      button.disabled = true;
      button.textContent = "Submitting quotation…";

      try {
        const fd = new FormData(form);
        const items = quoteItemsFromCart(cart);
        const pay = paymentValue(String(fd.get("pay") || ""));
        if (!pay) throw new Error("Choose a valid payment method.");

        const { data: reference, error } = await client.rpc("submit_quote", {
          p_contact_name: String(fd.get("name") || "").trim(),
          p_contact_phone: String(fd.get("phone") || "").trim(),
          p_items: items,
          p_contact_email: null,
          p_delivery_city: String(fd.get("city") || "").trim() || null,
          p_delivery_address: String(fd.get("address") || "").trim() || null,
          p_payment_pref: pay,
          p_notes: String(fd.get("note") || "").trim() || null
        });

        if (error) throw error;
        if (!reference) throw new Error("Server did not return a quotation reference.");

        button.disabled = false;
        button.innerHTML = originalHtml;
        allowExistingSuccessHandler = true;
        button.click();
        allowExistingSuccessHandler = false;

        const refEl = document.getElementById("quote-ref");
        if (refEl) refEl.textContent = String(reference);
        console.log("CKA QUOTE SUBMITTED:", reference);
      } catch (err) {
        console.error("CKA QUOTE SUBMIT FAILED:", err);
        button.disabled = false;
        button.innerHTML = originalHtml;
        showCheckoutError(err && err.message ? err.message : "Could not submit the quotation request. Please try again or contact CKA on WhatsApp.");
      } finally {
        submitting = false;
        allowExistingSuccessHandler = false;
      }
    }, true);
  }

  function loadMaterialDetailLinks() {
    if (!document.getElementById("product-grid") || document.querySelector('script[src*="material-card-links.js"]')) return;
    const details = document.createElement("script");
    details.src = "assets/js/material-card-links.js?v=1";
    details.async = true;
    details.onerror = () => console.warn("CKA PUBLIC: material detail navigation failed to load");
    document.body.appendChild(details);
  }

  function startApplication(client) {
    const script = document.createElement("script");
    script.src = "assets/js/app.js?v=27";
    script.defer = false;
    script.onerror = function () { console.error("CKA PUBLIC: app.js failed to load"); };
    script.onload = function () {
      installRealCheckout(client);
      loadMaterialDetailLinks();
    };
    document.body.appendChild(script);
  }

  async function boot() {
    const client = global.CKAStore && global.CKAStore.supabase;

    try {
      if (!client || typeof PRODUCTS === "undefined" || !Array.isArray(PRODUCTS)) {
        throw new Error("Supabase store or seed catalogue is unavailable");
      }

      const { data, error } = await client
        .from("v_catalogue")
        .select("*")
        .order("display_order", { ascending: true });

      if (error) throw error;
      if (!Array.isArray(data) || data.length < MIN_EXPECTED_PRODUCTS) {
        throw new Error("Live catalogue returned no usable products");
      }

      const live = data.map(toProduct).filter((product) => product.dbId && product.title && product.category);
      if (live.length < MIN_EXPECTED_PRODUCTS) throw new Error("Live catalogue rows failed validation");

      const ids = new Set();
      for (const product of live) {
        if (ids.has(product.id)) throw new Error("Live catalogue UI ID collision detected");
        ids.add(product.id);
      }

      PRODUCTS.splice(0, PRODUCTS.length, ...live);
      console.log(`CKA PUBLIC: loaded ${live.length} products from Supabase`);
    } catch (err) {
      console.warn("CKA PUBLIC: using static catalogue fallback", err);
    } finally {
      startApplication(client);
    }
  }

  boot();
})(window);

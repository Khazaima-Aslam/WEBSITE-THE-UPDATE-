/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — public-catalogue.js

   Loads the public materials catalogue from Supabase before app.js starts.
   The shipped PRODUCTS array in data.js remains a read-only emergency
   fallback: if Supabase is unavailable or returns an invalid catalogue,
   this bootstrap leaves the seed data untouched and still starts the site.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const MIN_EXPECTED_PRODUCTS = 1;

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
      id: row.id,
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
      deals: row.order_count == null ? 0 : row.order_count,
      stock: humanStock(row.stock),
      featured: !!row.is_featured,
      order: Number(row.display_order) || 0,
      tags: Array.isArray(row.tags) ? row.tags : [],
      description: row.description || "",
      img: mainImage,
      images
    };
  }

  function startApplication() {
    const script = document.createElement("script");
    script.src = "assets/js/app.js?v=27";
    script.defer = false;
    script.onerror = function () {
      console.error("CKA PUBLIC: app.js failed to load");
    };
    document.body.appendChild(script);
  }

  async function boot() {
    try {
      const client = global.CKAStore && global.CKAStore.supabase;
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

      const live = data
        .map(toProduct)
        .filter((product) => product.id && product.title && product.category);

      if (live.length < MIN_EXPECTED_PRODUCTS) {
        throw new Error("Live catalogue rows failed validation");
      }

      // PRODUCTS is declared as const in data.js, but its array contents are
      // intentionally mutable. This preserves every existing app.js call site.
      PRODUCTS.splice(0, PRODUCTS.length, ...live);
      console.log(`CKA PUBLIC: loaded ${live.length} products from Supabase`);
    } catch (err) {
      console.warn("CKA PUBLIC: using static catalogue fallback", err);
    } finally {
      startApplication();
    }
  }

  boot();
})(window);

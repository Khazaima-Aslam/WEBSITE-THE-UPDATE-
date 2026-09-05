/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — admin-runtime.js
   Production guard around the existing admin console.

   Responsibilities:
   - Reuse the one Supabase client created by store.js.
   - Verify admin/staff auth before admin.js is allowed to run.
   - Normalise stock labels between the UI and PostgreSQL enum values.
   - Refuse product-image deletion while any database reference exists.
   - Replace the legacy destructive-delete warning with a live DB warning.

   This file deliberately does not create a second Supabase client.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const STORE = global.CKAStore;
  const CONFIG = global.CKA_CONFIG || {};
  const client = STORE && STORE.supabase;
  const bucket = CONFIG.storageBucket || "project-uploads";

  if (!STORE || !client) {
    console.error("CKA ADMIN: Supabase store/client is unavailable.");
    global.location.replace("admin-login.html");
    return;
  }

  const STOCK_TO_DB = {
    "In stock": "in_stock",
    "Low stock": "low_stock",
    "On order": "on_order",
    "Out of stock": "out_of_stock",
    "Rate on request": "rate_on_request"
  };

  const STOCK_TO_UI = {
    in_stock: "In stock",
    low_stock: "Low stock",
    on_order: "On order",
    out_of_stock: "Out of stock",
    rate_on_request: "Rate on request"
  };

  function installStockNormalisation() {
    const rawList = STORE.products.list.bind(STORE.products);
    const rawSave = STORE.products.save.bind(STORE.products);

    STORE.products.list = async function () {
      const rows = await rawList();
      return (rows || []).map((p) => ({
        ...p,
        stock: STOCK_TO_UI[p.stock] || p.stock || ""
      }));
    };

    STORE.products.save = async function (product) {
      const p = {
        ...product,
        stock: STOCK_TO_DB[product.stock] || product.stock || "in_stock"
      };
      return rawSave(p);
    };
  }

  function publicUrlForPath(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    const { data } = client.storage.from(bucket).getPublicUrl(path);
    return data && data.publicUrl ? data.publicUrl : "";
  }

  async function findImageReferences(path) {
    const url = publicUrlForPath(path);
    if (!url) return { safe: false, reason: "missing-public-url", references: [] };

    const references = [];

    // The live project currently uses products.image_url.
    const productsCheck = await client
      .from("products")
      .select("id,name,image_url")
      .eq("image_url", url)
      .limit(5);

    if (productsCheck.error) {
      console.warn("CKA IMAGE SAFETY: products.image_url check failed; deletion blocked.", productsCheck.error);
      return { safe: false, reason: "products-reference-check-failed", references };
    }

    (productsCheck.data || []).forEach((row) => references.push({
      source: "products.image_url",
      productId: row.id,
      productName: row.name || ""
    }));

    // The repository schema also contains product_images. During migration,
    // either model may still contain a valid reference, so both must be checked.
    const galleryCheck = await client
      .from("product_images")
      .select("product_id,url")
      .eq("url", url)
      .limit(5);

    if (galleryCheck.error) {
      console.warn("CKA IMAGE SAFETY: product_images check failed; deletion blocked.", galleryCheck.error);
      return { safe: false, reason: "product-images-reference-check-failed", references };
    }

    (galleryCheck.data || []).forEach((row) => references.push({
      source: "product_images.url",
      productId: row.product_id
    }));

    return {
      safe: references.length === 0,
      reason: references.length ? "image-still-referenced" : "unreferenced",
      references,
      url
    };
  }

  function installStorageSafety() {
    if (!STORE.files || typeof STORE.files.remove !== "function") return;

    const rawRemove = STORE.files.remove.bind(STORE.files);

    STORE.files.remove = async function (path) {
      if (!path) return [];

      // Apply the reference gate to product images. Other project files keep
      // their existing lifecycle until their own management UI is implemented.
      if (!String(path).startsWith("product-images/")) {
        return rawRemove(path);
      }

      const check = await findImageReferences(path);
      console.log("CKA IMAGE DELETE SAFETY CHECK:", { path, ...check });

      if (!check.safe) {
        console.warn("CKA IMAGE DELETE SKIPPED:", path, check.reason, check.references);
        return {
          skipped: true,
          reason: check.reason,
          references: check.references
        };
      }

      return rawRemove(path);
    };

    STORE.files.findImageReferences = findImageReferences;
  }

  async function requireAdminAuth() {
    const { data, error } = await client.auth.getUser();

    if (error || !data || !data.user) {
      global.location.replace("admin-login.html");
      return null;
    }

    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (
      profileError ||
      !profile ||
      !["admin", "staff"].includes(profile.role)
    ) {
      await client.auth.signOut();
      global.location.replace("admin-login.html");
      return null;
    }

    console.log("CKA ADMIN AUTH VERIFIED:", data.user.email);
    return data.user;
  }

  function installLiveDeleteGuard() {
    const rows = document.getElementById("adm-rows");
    if (!rows) return;

    // Capture phase runs before the legacy delegated delete handler in admin.js.
    rows.addEventListener("click", async function (event) {
      const button = event.target.closest("[data-del]");
      if (!button) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const id = button.dataset.del;
      const row = button.closest("tr");
      const title = row && row.querySelector("td:nth-child(2) strong")
        ? row.querySelector("td:nth-child(2) strong").textContent.trim()
        : "this product";

      const ok = global.confirm(
        `Deactivate \"${title}\"?\n\n` +
        "This updates the live Supabase catalogue immediately. " +
        "The product is soft-deleted (is_active = false); its Storage images are not deleted automatically."
      );

      if (!ok) return;

      try {
        await STORE.products.remove(id);
        global.location.reload();
      } catch (err) {
        console.error("CKA ADMIN: product deactivation failed", err);
        global.alert("Could not deactivate the product. No Storage image was removed.");
      }
    }, true);
  }

  function loadAdminScript() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "assets/js/admin.js?v=26";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load admin.js"));
      document.body.appendChild(script);
    });
  }

  async function boot() {
    try {
      const user = await requireAdminAuth();
      if (!user) return;

      installStockNormalisation();
      installStorageSafety();

      document.body.style.visibility = "visible";
      await loadAdminScript();
      installLiveDeleteGuard();

      global.CKAAdminRuntime = {
        user,
        findImageReferences,
        stockToDb: STOCK_TO_DB,
        stockToUi: STOCK_TO_UI
      };

      console.log("CKA ADMIN: production runtime ready");
    } catch (err) {
      console.error("CKA ADMIN BOOT FAILED:", err);
      document.body.style.visibility = "visible";
      global.alert("The admin console could not start safely. Check the browser console.");
    }
  }

  boot();
})(window);

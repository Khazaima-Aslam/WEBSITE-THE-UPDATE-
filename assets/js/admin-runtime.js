/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — admin-runtime.js
   Production guard around the existing admin console.

   Responsibilities:
   - Reuse the one Supabase client created by store.js.
   - Verify admin/staff auth before admin.js is allowed to run.
   - Normalise stock labels between the UI and PostgreSQL enum values.
   - Refuse product-image deletion while any database reference exists.
   - Clean up newly uploaded product images that are abandoned before save.
   - Persist extended editor fields only when the live schema supports them.
   - Replace the legacy destructive-delete warning with a live DB warning.

   This file deliberately does not create a second Supabase client.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const STORE = global.CKAStore;
  const CONFIG = global.CKA_CONFIG || {};
  const client = STORE && STORE.supabase;
  const bucket = CONFIG.storageBucket || "project-uploads";
  const pendingUploads = new Map(); // public URL -> storage path
  let extendedProductFields = false;

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

  function ensureLegacyHooks() {
    const banner = document.getElementById("draft-banner");
    if (!banner) return;

    if (!document.getElementById("draft-count")) {
      const count = document.createElement("span");
      count.id = "draft-count";
      count.hidden = true;
      banner.appendChild(count);
    }

    if (!document.getElementById("go-publish")) {
      const go = document.createElement("button");
      go.id = "go-publish";
      go.type = "button";
      go.hidden = true;
      banner.appendChild(go);
    }

    if (!document.getElementById("discard-draft")) {
      const discard = document.createElement("button");
      discard.id = "discard-draft";
      discard.type = "button";
      discard.hidden = true;
      banner.appendChild(discard);
    }
  }

  function parseSpecs(value) {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value;

    return String(value)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .reduce((out, part) => {
        const idx = part.indexOf(":");
        if (idx === -1) return out;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) out[key] = val;
        return out;
      }, {});
  }

  function parseRange(value) {
    const nums = String(value || "")
      .replace(/,/g, "")
      .match(/\d+(?:\.\d+)?/g);

    if (!nums || nums.length < 2) return { price_min: null, price_max: null };

    const a = Number(nums[0]);
    const b = Number(nums[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { price_min: null, price_max: null };

    return { price_min: Math.min(a, b), price_max: Math.max(a, b) };
  }

  async function detectExtendedProductFields() {
    const { error } = await client
      .from("products")
      .select("id,grade,size,badge,rating,specifications,price_min,price_max")
      .limit(1);

    extendedProductFields = !error;

    if (error) {
      console.warn(
        "CKA ADMIN: extended product columns are not available yet; " +
        "base product saving remains enabled until the reconciliation migration is applied.",
        error
      );
    } else {
      console.log("CKA ADMIN: extended product fields detected");
    }

    return extendedProductFields;
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

    const productsCheck = await client
      .from("products")
      .select("id,name,image_url")
      .eq("image_url", url)
      .limit(10);

    if (productsCheck.error) {
      console.warn("CKA IMAGE SAFETY: products.image_url check failed; deletion blocked.", productsCheck.error);
      return { safe: false, reason: "products-reference-check-failed", references };
    }

    (productsCheck.data || []).forEach((row) => references.push({
      source: "products.image_url",
      productId: row.id,
      productName: row.name || ""
    }));

    const galleryCheck = await client
      .from("product_images")
      .select("product_id,url")
      .eq("url", url)
      .limit(10);

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

      if (!String(path).startsWith("product-images/")) {
        return rawRemove(path);
      }

      const check = await findImageReferences(path);
      console.log("CKA IMAGE DELETE SAFETY CHECK:", { path, ...check });

      if (!check.safe) {
        const err = new Error(`Product image deletion blocked: ${check.reason}`);
        err.code = "CKA_IMAGE_DELETE_BLOCKED";
        err.references = check.references;
        console.warn("CKA IMAGE DELETE BLOCKED:", path, check.reason, check.references);
        throw err;
      }

      return rawRemove(path);
    };

    STORE.files.findImageReferences = findImageReferences;
  }

  function installUploadTracking() {
    if (!STORE.storage || typeof STORE.storage.from !== "function") return;

    const rawFrom = STORE.storage.from.bind(STORE.storage);

    STORE.storage.from = function (bucketName) {
      const api = rawFrom(bucketName);
      if (bucketName !== bucket) return api;

      return new Proxy(api, {
        get(target, prop) {
          if (prop === "upload") {
            return async function (path, file, options) {
              const result = await target.upload(path, file, options);
              if (!result.error && String(path).startsWith("product-images/")) {
                const { data } = target.getPublicUrl(path);
                if (data && data.publicUrl) {
                  pendingUploads.set(data.publicUrl, path);
                  console.log("CKA IMAGE PENDING SAVE:", path);
                }
              }
              return result;
            };
          }

          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
  }

  async function cleanupPendingUploads(keepUrl) {
    const entries = Array.from(pendingUploads.entries());

    for (const [url, path] of entries) {
      if (keepUrl && url === keepUrl) {
        pendingUploads.delete(url);
        continue;
      }

      try {
        await STORE.files.remove(path);
        pendingUploads.delete(url);
        console.log("CKA ORPHAN IMAGE REMOVED:", path);
      } catch (err) {
        console.warn("CKA ORPHAN IMAGE CLEANUP SKIPPED:", path, err);
      }
    }
  }

  function installProductPersistence() {
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

      const saved = await rawSave(p);
      const savedId = saved?.id || product.id;

      if (extendedProductFields && savedId) {
        const range = parseRange(product.range);
        const { error } = await client
          .from("products")
          .update({
            grade: product.grade || null,
            size: product.size || null,
            badge: product.badge || null,
            rating: Number(product.rating) || null,
            specifications: parseSpecs(product.specs),
            price_min: range.price_min,
            price_max: range.price_max
          })
          .eq("id", savedId);

        if (error) {
          console.error("CKA ADMIN: extended product field save failed", error);
          throw error;
        }
      }

      const savedImage = Array.isArray(product.images) ? product.images[0] || "" : "";
      await cleanupPendingUploads(savedImage);
      return saved;
    };
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

    if (profileError || !profile || !["admin", "staff"].includes(profile.role)) {
      await client.auth.signOut();
      global.location.replace("admin-login.html");
      return null;
    }

    console.log("CKA ADMIN AUTH VERIFIED:", data.user.email);
    return data.user;
  }

  function installEditorCleanup() {
    document.querySelectorAll("[data-close-editor]").forEach((button) => {
      button.addEventListener("click", function () {
        cleanupPendingUploads("").catch((err) => {
          console.warn("CKA EDITOR CLEANUP FAILED:", err);
        });
      }, true);
    });
  }

  function installLiveDeleteGuard() {
    const rows = document.getElementById("adm-rows");
    if (!rows) return;

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

      ensureLegacyHooks();
      installStorageSafety();
      installUploadTracking();
      await detectExtendedProductFields();
      installProductPersistence();

      document.body.style.visibility = "visible";
      await loadAdminScript();
      installEditorCleanup();
      installLiveDeleteGuard();

      global.CKAAdminRuntime = {
        user,
        findImageReferences,
        cleanupPendingUploads,
        pendingUploads,
        extendedProductFields,
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

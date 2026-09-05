/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — admin-runtime.js
   Production guard around the existing admin console.

   This layer keeps the legacy admin UI operational while enforcing
   the live Supabase architecture:
   - one shared Supabase client
   - auth before admin.js loads
   - PostgreSQL stock enum normalisation
   - products.image_url as canonical main image
   - product-images bucket for public catalogue media
   - project-uploads kept for private project/BOQ files
   - safe image replacement/deletion with live DB reference checks
   - extended editor data persisted into existing schema fields
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const STORE = global.CKAStore;
  const CONFIG = global.CKA_CONFIG || {};
  const client = STORE && STORE.supabase;
  const projectBucket = CONFIG.storageBucket || "project-uploads";
  const productImageBucket = CONFIG.productImageBucket || "product-images";
  const pendingUploads = new Map(); // public URL -> canonical storage key

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

    ["draft-count", "go-publish", "discard-draft"].forEach((id) => {
      if (document.getElementById(id)) return;
      const el = document.createElement(id === "draft-count" ? "span" : "button");
      el.id = id;
      el.hidden = true;
      if (el.tagName === "BUTTON") el.type = "button";
      banner.appendChild(el);
    });
  }

  function parseSpecs(value) {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return { ...value };

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

  function specsToText(specs) {
    if (!specs || typeof specs !== "object") return "";
    return Object.entries(specs)
      .filter(([key]) => !["grade", "size", "badge", "quality", "source_catalogue_id"].includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
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

  function productImageRelativePath(path) {
    const value = String(path || "");
    if (!value) return "";
    if (value.startsWith("product-images/")) return value.slice("product-images/".length);

    const marker = `/storage/v1/object/public/${productImageBucket}/`;
    if (value.includes(marker)) return value.split(marker)[1].split("?")[0];
    return "";
  }

  function productImagePublicUrl(path) {
    const relative = productImageRelativePath(path) || String(path || "");
    if (!relative || /^https?:\/\//i.test(relative)) return /^https?:\/\//i.test(relative) ? relative : "";
    const { data } = client.storage.from(productImageBucket).getPublicUrl(relative);
    return data && data.publicUrl ? data.publicUrl : "";
  }

  async function findImageReferences(path) {
    const original = String(path || "");
    const url = /^https?:\/\//i.test(original) ? original : productImagePublicUrl(original);
    if (!url) return { safe: false, reason: "not-a-managed-product-image", references: [] };

    const references = [];

    const productsCheck = await client
      .from("products")
      .select("id,name,image_url")
      .eq("image_url", url)
      .limit(20);

    if (productsCheck.error) {
      return { safe: false, reason: "products-reference-check-failed", references, error: productsCheck.error };
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
      .limit(20);

    if (galleryCheck.error) {
      return { safe: false, reason: "product-images-reference-check-failed", references, error: galleryCheck.error };
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

    const rawProjectRemove = STORE.files.remove.bind(STORE.files);

    STORE.files.remove = async function (path) {
      const value = String(path || "");
      if (!value) return [];

      const productRelative = productImageRelativePath(value);
      if (!productRelative) {
        // Never pass arbitrary external URLs to Storage.remove().
        if (/^https?:\/\//i.test(value)) {
          console.log("CKA IMAGE DELETE SKIPPED: external/non-managed URL", value);
          return { skipped: true, reason: "external-image" };
        }
        return rawProjectRemove(value);
      }

      const canonicalKey = `product-images/${productRelative}`;
      const check = await findImageReferences(canonicalKey);
      console.log("CKA IMAGE DELETE SAFETY CHECK:", { path: canonicalKey, ...check });

      if (!check.safe) {
        const err = new Error(`Product image deletion blocked: ${check.reason}`);
        err.code = "CKA_IMAGE_DELETE_BLOCKED";
        err.references = check.references;
        throw err;
      }

      const { data, error } = await client.storage
        .from(productImageBucket)
        .remove([productRelative]);

      if (error) throw error;
      return data;
    };

    STORE.files.findImageReferences = findImageReferences;
  }

  function installUploadRouting() {
    if (!STORE.storage || typeof STORE.storage.from !== "function") return;

    const rawFrom = STORE.storage.from.bind(STORE.storage);

    STORE.storage.from = function (bucketName) {
      const projectApi = rawFrom(bucketName);
      if (bucketName !== projectBucket) return projectApi;

      return new Proxy(projectApi, {
        get(target, prop) {
          if (prop === "upload") {
            return async function (path, file, options) {
              const value = String(path || "");
              if (!value.startsWith("product-images/")) {
                return target.upload(path, file, options);
              }

              const relative = value.slice("product-images/".length);
              const imageApi = rawFrom(productImageBucket);
              const result = await imageApi.upload(relative, file, options);

              if (!result.error) {
                const { data } = imageApi.getPublicUrl(relative);
                if (data && data.publicUrl) {
                  pendingUploads.set(data.publicUrl, `product-images/${relative}`);
                  console.log("CKA IMAGE PENDING SAVE:", relative);
                }
              }
              return result;
            };
          }

          if (prop === "getPublicUrl") {
            return function (path) {
              const value = String(path || "");
              if (!value.startsWith("product-images/")) return target.getPublicUrl(path);
              const relative = value.slice("product-images/".length);
              return rawFrom(productImageBucket).getPublicUrl(relative);
            };
          }

          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
  }

  async function cleanupPendingUploads(keepUrl) {
    for (const [url, path] of Array.from(pendingUploads.entries())) {
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

  async function loadProductMetadata(ids) {
    if (!ids.length) return new Map();

    const { data, error } = await client
      .from("products")
      .select("id,specifications,price_min,price_max,rating,supplier_id")
      .in("id", ids);

    if (error) throw error;
    return new Map((data || []).map((row) => [String(row.id), row]));
  }

  function installProductPersistence() {
    const rawList = STORE.products.list.bind(STORE.products);
    const rawSave = STORE.products.save.bind(STORE.products);

    STORE.products.list = async function () {
      const rows = await rawList();
      const ids = (rows || []).map((p) => p.id).filter(Boolean);
      const meta = await loadProductMetadata(ids);

      return (rows || []).map((p) => {
        const m = meta.get(String(p.id)) || {};
        const specs = m.specifications && typeof m.specifications === "object" ? m.specifications : {};
        return {
          ...p,
          supplier_id: m.supplier_id || p.supplier_id || null,
          stock: STOCK_TO_UI[p.stock] || p.stock || "",
          grade: specs.grade || p.grade || "",
          size: specs.size || p.size || "",
          badge: specs.badge || p.badge || "",
          specs: specsToText(specs),
          rating: Number(m.rating ?? p.rating ?? 0),
          range: (m.price_min != null && m.price_max != null)
            ? `PKR ${Number(m.price_min).toLocaleString("en-PK")} – ${Number(m.price_max).toLocaleString("en-PK")}`
            : (p.range || "")
        };
      });
    };

    STORE.products.save = async function (product) {
      const p = {
        ...product,
        stock: STOCK_TO_DB[product.stock] || product.stock || "in_stock"
      };

      const saved = await rawSave(p);
      const savedId = saved && saved.id ? saved.id : product.id;
      if (!savedId) throw new Error("Product save completed without an ID.");

      const { data: current, error: currentError } = await client
        .from("products")
        .select("specifications,supplier_id")
        .eq("id", savedId)
        .single();
      if (currentError) throw currentError;

      const existingSpecs = current?.specifications && typeof current.specifications === "object"
        ? current.specifications
        : {};
      const userSpecs = parseSpecs(product.specs);
      const mergedSpecs = {
        ...existingSpecs,
        ...userSpecs,
        grade: product.grade || null,
        size: product.size || null,
        badge: product.badge || null
      };

      Object.keys(mergedSpecs).forEach((key) => {
        if (mergedSpecs[key] == null || mergedSpecs[key] === "") delete mergedSpecs[key];
      });

      const range = parseRange(product.range);
      const updatePayload = {
        specifications: mergedSpecs,
        rating: product.rating === "" || product.rating == null ? null : Number(product.rating),
        price_min: range.price_min,
        price_max: range.price_max
      };

      // Supplier names in the current seed are not unique. Only change the
      // relationship when the entered company name resolves unambiguously.
      const supplierName = String(product.supplier || "").trim();
      if (!supplierName) {
        updatePayload.supplier_id = null;
      } else {
        const { data: matches, error: supplierError } = await client
          .from("suppliers")
          .select("id,company_name")
          .eq("company_name", supplierName)
          .limit(3);
        if (supplierError) throw supplierError;

        if ((matches || []).length === 1) {
          updatePayload.supplier_id = matches[0].id;
        } else if ((matches || []).length > 1) {
          updatePayload.supplier_id = current?.supplier_id || null;
          console.warn("CKA ADMIN: supplier name is duplicated; existing supplier relationship preserved.", supplierName);
        }
      }

      const { error: updateError } = await client
        .from("products")
        .update(updatePayload)
        .eq("id", savedId);
      if (updateError) throw updateError;

      const savedImage = Array.isArray(product.images) ? product.images[0] || "" : "";
      await cleanupPendingUploads(savedImage);
      return saved;
    };
  }

  async function requireAdminAuth() {
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) {
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
      button.addEventListener("click", () => {
        cleanupPendingUploads("").catch((err) => console.warn("CKA EDITOR CLEANUP FAILED:", err));
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
      const title = row?.querySelector("td:nth-child(2) strong")?.textContent.trim() || "this product";
      const ok = global.confirm(
        `Deactivate \"${title}\"?\n\n` +
        "This updates the live Supabase catalogue immediately. " +
        "The product is soft-deleted (is_active = false); Storage images are retained."
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
      script.src = "assets/js/admin.js?v=27";
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
      installUploadRouting();
      installProductPersistence();

      document.body.style.visibility = "visible";
      await loadAdminScript();
      installEditorCleanup();
      installLiveDeleteGuard();

      global.CKAAdminRuntime = {
        user,
        projectBucket,
        productImageBucket,
        findImageReferences,
        cleanupPendingUploads,
        pendingUploads,
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

/* ═══════════════════════════════════════════════════════════════
   CKA BuildStruct — store.js
   Single data-access layer for public pages and the admin console.

   Production rules:
   - one Supabase client per page
   - public catalogue reads through v_catalogue
   - product mutations go through RLS-protected tables
   - anonymous contact/project submissions use hardened RPCs
   - project files stay in private project-uploads
   - catalogue images use the public product-images bucket
   - static data remains a fallback if Supabase is unavailable
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const DRAFT_KEY = "cka-catalogue-draft-v1";
  const PROJECT_KEY = "cka-projects-v1";

  global.CKA_CONFIG = global.CKA_CONFIG || {
    supabaseUrl: "https://qrjglihvjhhemqoegqmt.supabase.co",
    supabaseAnonKey: "sb_publishable_8dwB_hn54sbrDsLgZR_7HQ_GEB9yHs4",
    storageBucket: "project-uploads",
    productImageBucket: "product-images"
  };

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function specsToText(specs) {
    if (!specs || typeof specs !== "object" || Array.isArray(specs)) return "";
    return Object.entries(specs)
      .filter(([key]) => !["grade", "size", "badge", "quality", "source_catalogue_id"].includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
  }

  function normalise(p) {
    const images = safeArray(p.images).length
      ? safeArray(p.images).slice()
      : (p.img ? [p.img] : []);

    return {
      id: p.id,
      sku: p.sku || (p.id == null ? "" : String(p.id)),
      category_id: p.category_id || null,
      supplier_id: p.supplier_id || null,
      title: p.title || p.name || "",
      category: p.category || "",
      subcategory: p.subcategory || "",
      brand: p.brand || "",
      description: p.description || "",
      unit: p.unit || "",
      quality: p.quality || "A",
      grade: p.grade || "",
      size: p.size || "",
      badge: p.badge || "",
      supplier: p.supplier || "",
      price: Number(p.price) || 0,
      oldPrice: Number(p.oldPrice) || 0,
      range: p.range || "",
      stock: p.stock || "",
      img: p.img || images[0] || "",
      images,
      featured: !!p.featured,
      order: Number(p.order) || 0,
      specs: p.specs || "",
      tags: Array.isArray(p.tags) ? p.tags.slice() : (p.tags ? String(p.tags).split(/\s*,\s*/).filter(Boolean) : []),
      rating: Number(p.rating) || 0,
      deals: p.deals == null ? 0 : p.deals,
      active: p.active !== false
    };
  }

  function fromCatalogueRow(row) {
    const specs = row.specifications && typeof row.specifications === "object" ? row.specifications : {};
    const gallery = safeArray(row.images).map((item) => item && item.url).filter(Boolean);
    const main = row.main_image || gallery[0] || "";
    const images = [main, ...gallery.filter((url) => url && url !== main)].filter(Boolean);

    return normalise({
      id: row.id,
      sku: row.sku,
      title: row.name,
      category: row.category_name,
      subcategory: row.parent_category ? row.category_name : "",
      brand: row.brand,
      quality: row.quality,
      description: row.description,
      unit: row.unit,
      price: row.price,
      oldPrice: row.old_price,
      range: row.price_min != null && row.price_max != null
        ? `PKR ${Number(row.price_min).toLocaleString("en-PK")} – ${Number(row.price_max).toLocaleString("en-PK")}`
        : "",
      stock: row.stock,
      supplier: row.supplier_name,
      rating: row.rating,
      deals: row.order_count,
      featured: row.is_featured,
      order: row.display_order,
      tags: row.tags,
      img: main,
      images,
      grade: specs.grade || "",
      size: specs.size || "",
      badge: specs.badge || "",
      specs: specsToText(specs)
    });
  }

  function safeFileName(name) {
    return String(name || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 180) || "file";
  }

  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* ── Static fallback ───────────────────────────────────────── */
  const LocalStore = {
    name: "local",
    readonly: false,
    products: {
      async list() {
        let draft = null;
        try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (err) {}
        const seed = (typeof PRODUCTS !== "undefined" && Array.isArray(PRODUCTS)) ? PRODUCTS : [];
        return (draft || seed).map(normalise);
      },
      async save(product) {
        const list = await LocalStore.products.list();
        const p = normalise(product);
        if (!p.id) p.id = Math.max(0, ...list.map((x) => Number(x.id) || 0)) + 1;
        const index = list.findIndex((x) => String(x.id) === String(p.id));
        if (index >= 0) list[index] = p; else list.push(p);
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list)); } catch (err) {}
        return p;
      },
      async remove(id) {
        const list = (await LocalStore.products.list()).filter((p) => String(p.id) !== String(id));
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list)); } catch (err) {}
      },
      async replaceAll(list) {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list.map(normalise))); } catch (err) {}
      },
      async discardDraft() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (err) {}
      },
      hasDraft() {
        try { return !!localStorage.getItem(DRAFT_KEY); } catch (err) { return false; }
      }
    },
    categories: {
      async list() {
        const groups = (typeof GROUPS !== "undefined" && GROUPS) || {};
        return Object.entries(groups).map(([slug, def], index) => ({
          slug,
          name: def.label,
          order: index,
          children: safeArray(def.categories).slice()
        }));
      }
    },
    files: {
      async upload(file) {
        return {
          path: `local://${safeFileName(file.name)}`,
          url: URL.createObjectURL(file),
          size: file.size,
          name: file.name,
          type: file.type,
          persisted: false
        };
      },
      async remove() {}
    },
    projects: {
      async create(p) {
        const row = {
          id: randomId(),
          reference: `CKA-P-${Date.now()}`,
          created_at: new Date().toISOString(),
          persisted: false,
          ...p
        };
        let list = [];
        try { list = JSON.parse(localStorage.getItem(PROJECT_KEY)) || []; } catch (err) {}
        list.unshift(row);
        try { localStorage.setItem(PROJECT_KEY, JSON.stringify(list)); } catch (err) {}
        return row;
      },
      async list() {
        try { return JSON.parse(localStorage.getItem(PROJECT_KEY)) || []; } catch (err) { return []; }
      }
    },
    inquiries: {
      async create(i) { return { ...i, persisted: false }; }
    }
  };

  function createSupabaseStore(client, projectBucket) {
    const B = projectBucket || "project-uploads";

    async function categoryIdFor(product) {
      if (product.category_id) return product.category_id;
      const name = String(product.category || "").trim();
      if (!name) throw new Error("A product category is required.");

      const { data, error } = await client
        .from("categories")
        .select("id,name")
        .eq("name", name)
        .limit(2);
      if (error) throw error;
      if (!data || data.length !== 1) throw new Error(`Category could not be resolved uniquely: ${name}`);
      return data[0].id;
    }

    return {
      name: "supabase",
      readonly: false,
      products: {
        async list() {
          const { data, error } = await client
            .from("v_catalogue")
            .select("*")
            .order("display_order", { ascending: true });
          if (error) throw error;

          const products = safeArray(data).map(fromCatalogueRow);
          const { data: categories, error: categoryError } = await client
            .from("categories")
            .select("id,name")
            .eq("is_active", true);
          if (!categoryError && categories) {
            const categoryMap = new Map(categories.map((row) => [row.name, row.id]));
            products.forEach((product) => {
              product.category_id = categoryMap.get(product.category) || null;
            });
          }
          return products;
        },

        async save(product) {
          const p = normalise(product);
          const categoryId = await categoryIdFor(product);
          const payload = {
            sku: p.sku || null,
            name: p.title,
            category_id: categoryId,
            image_url: p.images[0] || p.img || null,
            brand: p.brand || null,
            quality: p.quality || null,
            description: p.description || null,
            unit: p.unit,
            price: p.price,
            old_price: p.oldPrice || null,
            stock: p.stock || "in_stock",
            tags: p.tags,
            is_featured: p.featured,
            display_order: p.order,
            is_active: p.active !== false
          };
          if (p.id) payload.id = p.id;

          const { data, error } = await client
            .from("products")
            .upsert(payload)
            .select("id")
            .single();
          if (error) throw error;

          const { data: viewRow, error: viewError } = await client
            .from("v_catalogue")
            .select("*")
            .eq("id", data.id)
            .single();
          if (viewError) throw viewError;
          const saved = fromCatalogueRow(viewRow);
          saved.category_id = categoryId;
          return saved;
        },

        async remove(id) {
          const { error } = await client.from("products").update({ is_active: false }).eq("id", id);
          if (error) throw error;
        },
        async replaceAll() {
          throw new Error("Full catalogue replacement is disabled on production. Use reviewed merge imports.");
        },
        async discardDraft() {},
        hasDraft() { return false; }
      },

      categories: {
        async list() {
          const { data, error } = await client
            .from("categories")
            .select("id,parent_id,slug,name,display_order,is_active")
            .eq("is_active", true)
            .order("display_order", { ascending: true });
          if (error) throw error;
          const rows = safeArray(data);
          return rows.filter((row) => !row.parent_id).map((parent, index) => ({
            id: parent.id,
            slug: parent.slug,
            name: parent.name,
            order: parent.display_order == null ? index : parent.display_order,
            children: rows
              .filter((child) => child.parent_id === parent.id)
              .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
              .map((child) => child.name)
          }));
        }
      },

      files: {
        async upload(file, meta) {
          const folder = String(meta?.folder || "misc").replace(/[^a-zA-Z0-9_-]/g, "-");
          const path = `${folder}/${randomId()}-${safeFileName(file.name)}`;
          const { error } = await client.storage.from(B).upload(path, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined
          });
          if (error) throw error;
          return {
            path,
            url: null,
            size: file.size,
            name: file.name,
            type: file.type || "application/octet-stream",
            persisted: true,
            bucket: B
          };
        },
        async remove(path) {
          if (!path) return [];
          const { data, error } = await client.storage.from(B).remove([path]);
          if (error) throw error;
          return data;
        }
      },

      projects: {
        async create(p) {
          const scope = [
            p.material ? `Requirement: ${p.material}` : null,
            p.qty ? `Quantity: ${p.qty}` : null,
            p.message ? String(p.message) : null
          ].filter(Boolean).join("\n");

          const file = p.file && p.file.persisted ? p.file : null;
          const { data: reference, error } = await client.rpc("submit_project_with_file", {
            p_client_name: String(p.name || "").trim(),
            p_phone: String(p.phone || "").trim(),
            p_email: p.email || null,
            p_company: p.company || null,
            p_project_name: p.material || null,
            p_project_type: p.ptype || null,
            p_location: p.city || null,
            p_budget_min: p.budgetMin ?? null,
            p_budget_max: p.budgetMax ?? null,
            p_expected_completion: p.expectedCompletion || null,
            p_scope: scope || null,
            p_file_path: file?.path || null,
            p_file_name: file?.name || null,
            p_file_mime: file?.type || null,
            p_file_size: file?.size || null
          });
          if (error) throw error;
          return { reference, persisted: true };
        },
        async list() {
          const { data, error } = await client.from("projects").select("*").order("created_at", { ascending: false });
          if (error) throw error;
          return data || [];
        }
      },

      inquiries: {
        async create(i) {
          const { data, error } = await client.rpc("submit_inquiry", {
            p_name: String(i.name || "").trim(),
            p_message: String(i.message || "").trim(),
            p_email: i.email || null,
            p_phone: i.phone || null,
            p_subject: i.topic || null,
            p_source: i.source || "contact_form"
          });
          if (error) throw error;
          return { persisted: !!data };
        }
      },

      quotes: {
        async create(payload) {
          const { data, error } = await client.rpc("submit_quote", payload);
          if (error) throw error;
          return { reference: data, persisted: true };
        }
      }
    };
  }

  let active = LocalStore;
  let sb = null;
  if (global.supabase && typeof global.supabase.createClient === "function") {
    sb = global.supabase.createClient(
      global.CKA_CONFIG.supabaseUrl,
      global.CKA_CONFIG.supabaseAnonKey
    );
    active = createSupabaseStore(sb, global.CKA_CONFIG.storageBucket);
    active.storage = sb.storage;
    active.supabase = sb;
  }

  active.normalise = normalise;
  active.LocalStore = LocalStore;
  active.createSupabaseStore = createSupabaseStore;
  global.CKAStore = active;
})(window);

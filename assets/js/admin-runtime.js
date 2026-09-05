/* CKA BuildStruct — admin-runtime.js v2
   Auth guard + safe product media helpers for the atomic catalogue console. */
(function (global) {
  "use strict";
  const STORE = global.CKAStore;
  const client = STORE && STORE.supabase;
  const bucket = (global.CKA_CONFIG && global.CKA_CONFIG.productImageBucket) || "product-images";

  if (!STORE || !client) {
    global.location.replace("admin-login.html");
    return;
  }

  function safeFileName(name) {
    return String(name || "image")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 150) || "image";
  }

  function randomId() {
    return global.crypto && typeof global.crypto.randomUUID === "function"
      ? global.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function managedPath(url) {
    const value = String(url || "");
    const marker = `/storage/v1/object/public/${bucket}/`;
    if (!value.includes(marker)) return "";
    return value.split(marker)[1].split("?")[0];
  }

  async function findImageReferences(url) {
    const value = String(url || "");
    if (!value) return [];
    const [products, gallery] = await Promise.all([
      client.from("products").select("id,name").eq("image_url", value).limit(20),
      client.from("product_images").select("product_id").eq("url", value).limit(20)
    ]);
    if (products.error) throw products.error;
    if (gallery.error) throw gallery.error;
    return [
      ...(products.data || []).map((x) => ({ source: "products.image_url", id: x.id, name: x.name })),
      ...(gallery.data || []).map((x) => ({ source: "product_images.url", id: x.product_id }))
    ];
  }

  async function deleteImageIfUnreferenced(url) {
    const path = managedPath(url);
    if (!path) return { skipped: true, reason: "external-or-unmanaged" };
    const refs = await findImageReferences(url);
    if (refs.length) return { skipped: true, reason: "still-referenced", refs };
    const { data, error } = await client.storage.from(bucket).remove([path]);
    if (error) throw error;
    return { removed: true, data };
  }

  async function uploadProductImage(file) {
    if (!file) throw new Error("No image selected.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Only JPG, PNG and WebP product images are supported.");
    }
    if (file.size > 10 * 1024 * 1024) throw new Error("Product images must be 10 MB or smaller.");
    const path = `catalogue/${new Date().toISOString().slice(0,10)}/${randomId()}-${safeFileName(file.name)}`;
    const { error } = await client.storage.from(bucket).upload(path, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type
    });
    if (error) throw error;
    const { data } = client.storage.from(bucket).getPublicUrl(path);
    if (!data || !data.publicUrl) throw new Error("Image uploaded but no public URL was returned.");
    return { path, url: data.publicUrl };
  }

  async function requireAdminAuth() {
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) {
      global.location.replace("admin-login.html");
      return null;
    }
    const { data: profile, error: profileError } = await client.from("profiles").select("role").eq("id", data.user.id).single();
    if (profileError || !profile || !["admin", "staff"].includes(profile.role)) {
      await client.auth.signOut();
      global.location.replace("admin-login.html");
      return null;
    }
    return { user: data.user, role: profile.role };
  }

  async function boot() {
    try {
      const auth = await requireAdminAuth();
      if (!auth) return;
      global.CKAAdminRuntime = {
        user: auth.user,
        role: auth.role,
        bucket,
        managedPath,
        findImageReferences,
        deleteImageIfUnreferenced,
        uploadProductImage
      };
      document.body.style.visibility = "visible";
      const script = document.createElement("script");
      script.src = "assets/js/admin-catalogue-pro.js?v=1";
      script.onerror = () => global.alert("Catalogue admin script failed to load.");
      document.body.appendChild(script);
    } catch (err) {
      console.error("CKA ADMIN BOOT FAILED", err);
      document.body.style.visibility = "visible";
      global.alert("The catalogue console could not start safely. Please sign in again.");
    }
  }

  boot();
})(window);

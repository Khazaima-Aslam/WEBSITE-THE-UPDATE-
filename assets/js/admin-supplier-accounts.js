/* CKA BuildStruct — admin-supplier-accounts.js
   Admin-only portal email reservation and exact-account linking. */
(function (global) {
  "use strict";
  const api = global.CKABackend;
  const client = global.CKAStore && global.CKAStore.supabase;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let currentSupplierId = null;
  let profile = null;
  let enhancing = false;

  if (!api || !client) return;

  function toast(text, error) {
    const box = document.getElementById("toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `toast${error ? " toast--warn" : ""}`;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  async function supplierRow(id) {
    const { data, error } = await client.from("suppliers")
      .select("id,company_name,is_verified,profile_id,email,portal_email")
      .eq("id", id).single();
    if (error) throw error;
    return data;
  }

  async function enhanceSupplierDrawer() {
    if (enhancing || !currentSupplierId) return;
    const body = document.getElementById("ops-drawer-body");
    if (!body || document.getElementById("ops-supplier-portal-access")) return;
    const trust = Array.from(body.querySelectorAll(".ops__section")).find((section) => section.querySelector("h3")?.textContent.trim() === "Trust controls");
    if (!trust) return;

    enhancing = true;
    try {
      profile = profile || await api.auth.profile();
      const row = await supplierRow(currentSupplierId);
      const section = document.createElement("section");
      section.className = "ops__section";
      section.id = "ops-supplier-portal-access";

      let content = "";
      if (profile?.role !== "admin") {
        content = '<div class="portal__notice">Supplier portal activation is administrator-controlled. Staff can review verification and reliability, but cannot link login identities.</div>';
      } else if (!row.is_verified) {
        content = '<div class="portal__notice">Verify this supplier first. Portal access cannot be prepared for an unverified supplier.</div>';
      } else if (row.profile_id) {
        content = `<div class="portal__notice portal__notice--good"><strong>Supplier portal active.</strong><br>This supplier is linked to a dedicated login.${row.portal_email ? ` Approved portal email: ${esc(row.portal_email)}.` : ""}</div>`;
      } else {
        const email = row.portal_email || row.email || "";
        content = `<div class="portal__notice"><strong>Controlled activation</strong><br>1. Reserve the exact approved supplier portal email below. 2. Ask the supplier to create a normal account at <code>account.html</code> using that exact email. 3. Link the matching account. No profile IDs are entered manually.</div>
          <div class="ops__form-grid" style="margin-top:10px">
            <label class="field field--wide"><span>Approved supplier portal email</span><input class="input" id="supplier-portal-email" type="email" maxlength="160" value="${esc(email)}" placeholder="procurement@supplier.com"></label>
          </div>
          <div class="ops__inline-actions" style="margin-top:10px">
            <button class="btn btn--ghost btn--sm" data-save-supplier-portal-email>Save approved email</button>
            <button class="btn btn--brand btn--sm" data-link-matching-supplier-account ${row.portal_email ? "" : "disabled"}>Link matching account</button>
          </div>
          <p class="ops__muted" style="margin-top:8px">If no customer account exists with the approved email, linking is refused. Admin/staff accounts can never be converted into supplier accounts.</p>`;
      }

      section.innerHTML = `<div class="ops__section-head"><h3>Supplier portal access</h3><span class="ops__muted">Verified identity activation</span></div>${content}`;
      trust.insertAdjacentElement("afterend", section);
    } catch (err) {
      console.error("CKA SUPPLIER ACCOUNT DRAWER FAILED", err);
      toast(err.message || "Could not load supplier portal controls.", true);
    } finally {
      enhancing = false;
    }
  }

  async function savePortalEmail() {
    if (!currentSupplierId || profile?.role !== "admin") return;
    const input = document.getElementById("supplier-portal-email");
    if (!input || !input.checkValidity()) return input?.reportValidity();
    const email = input.value.trim();
    if (!email) return toast("Enter the approved supplier portal email.", true);
    try {
      const { error } = await client.rpc("admin_set_supplier_portal_email", { p_supplier_id: currentSupplierId, p_email: email });
      if (error) throw error;
      toast("Approved supplier portal email saved.");
      const link = document.querySelector("[data-link-matching-supplier-account]");
      if (link) link.disabled = false;
    } catch (err) {
      toast(err.message || "Could not save the supplier portal email.", true);
    }
  }

  async function linkMatchingAccount() {
    if (!currentSupplierId || profile?.role !== "admin") return;
    if (!global.confirm("Link the customer account whose email exactly matches this supplier's approved portal email? The account will become a supplier account and gain verified tender access.")) return;
    try {
      const { error } = await client.rpc("admin_link_supplier_matching_account", { p_supplier_id: currentSupplierId });
      if (error) throw error;
      toast("Supplier portal account linked successfully.");
      global.location.reload();
    } catch (err) {
      toast(err.message || "Could not link the supplier account.", true);
    }
  }

  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-supplier]");
    if (open) {
      currentSupplierId = open.dataset.openSupplier;
      setTimeout(enhanceSupplierDrawer, 80);
      setTimeout(enhanceSupplierDrawer, 350);
    }
    if (event.target.closest("[data-save-supplier-portal-email]")) {
      event.preventDefault();
      savePortalEmail();
    }
    if (event.target.closest("[data-link-matching-supplier-account]")) {
      event.preventDefault();
      linkMatchingAccount();
    }
    if (event.target.closest("[data-close-ops-drawer]")) currentSupplierId = null;
  }, true);

  const body = document.getElementById("ops-drawer-body");
  if (body) new MutationObserver(() => {
    if (currentSupplierId) setTimeout(enhanceSupplierDrawer, 20);
  }).observe(body, { childList:true, subtree:true });
})(window);

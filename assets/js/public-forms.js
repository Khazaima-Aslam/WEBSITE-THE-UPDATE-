/* CKA BuildStruct — public-forms.js
   Replaces legacy simulated success for supplier registration and
   rate-list subscription with verified Supabase RPC submissions. */
(function (global) {
  "use strict";

  const client = global.CKAStore && global.CKAStore.supabase;
  if (!client) return;

  function statusBox(form) {
    let box = form.querySelector("[data-server-status]");
    if (!box) {
      box = document.createElement("p");
      box.dataset.serverStatus = "";
      box.setAttribute("role", "status");
      box.style.marginTop = "12px";
      box.style.fontSize = "0.9rem";
      form.appendChild(box);
    }
    return box;
  }

  function setStatus(form, message, ok) {
    const box = statusBox(form);
    box.textContent = message;
    box.style.color = ok ? "inherit" : "#b42318";
  }

  function submitButton(form) {
    return form.querySelector('button[type="submit"], input[type="submit"]');
  }

  function installSupplierForm() {
    const form = document.getElementById("supplier-form");
    if (!form) return;

    let sending = false;
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (sending || !form.checkValidity()) {
        if (!form.checkValidity()) form.reportValidity();
        return;
      }

      const button = submitButton(form);
      const original = button ? button.textContent : "";
      sending = true;
      if (button) {
        button.disabled = true;
        button.textContent = "Submitting registration…";
      }
      setStatus(form, "", true);

      try {
        const fd = new FormData(form);
        const { data: reference, error } = await client.rpc("submit_supplier_application", {
          p_business_name: String(fd.get("business") || "").trim(),
          p_contact_person: String(fd.get("person") || "").trim(),
          p_phone: String(fd.get("phone") || "").trim(),
          p_email: String(fd.get("email") || "").trim() || null,
          p_city: String(fd.get("city") || "").trim(),
          p_category: String(fd.get("category") || "").trim(),
          p_business_details: String(fd.get("ntn") || "").trim() || null
        });
        if (error) throw error;
        if (!reference) throw new Error("Registration reference was not returned.");

        form.reset();
        setStatus(
          form,
          `Registration received — reference ${reference}. CKA will review the application before supplier approval.`,
          true
        );
        console.log("CKA SUPPLIER APPLICATION:", reference);
      } catch (err) {
        console.error("CKA SUPPLIER APPLICATION FAILED:", err);
        setStatus(form, err?.message || "Could not submit the supplier registration. Please try again.", false);
      } finally {
        sending = false;
        if (button) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    }, true);
  }

  function installNewsletterForms() {
    document.querySelectorAll(".news-form").forEach((form) => {
      let sending = false;
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (sending || !form.checkValidity()) {
          if (!form.checkValidity()) form.reportValidity();
          return;
        }

        const input = form.querySelector('input[type="email"]');
        const button = submitButton(form);
        sending = true;
        if (button) button.disabled = true;

        try {
          const { data, error } = await client.rpc("subscribe_rate_list", {
            p_email: String(input?.value || "").trim()
          });
          if (error) throw error;
          if (!data) throw new Error("Subscription was not confirmed.");

          form.reset();
          setStatus(form, "Subscribed — your email is registered for CKA rate-list updates.", true);
        } catch (err) {
          console.error("CKA RATE LIST SUBSCRIPTION FAILED:", err);
          setStatus(form, err?.message || "Could not subscribe this email. Please try again.", false);
        } finally {
          sending = false;
          if (button) button.disabled = false;
        }
      }, true);
    });
  }

  installSupplierForm();
  installNewsletterForms();
})(window);

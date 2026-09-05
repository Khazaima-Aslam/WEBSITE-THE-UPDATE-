/* CKA BuildStruct — account.js */
(function (global) {
  "use strict";
  const client = global.CKAStore && global.CKAStore.supabase;
  const api = global.CKABackend;
  const message = document.getElementById("account-message");
  if (!client || !api) {
    message.textContent = "Account services are unavailable. Please reload the page.";
    return;
  }

  function setMessage(text, ok) {
    message.textContent = text || "";
    message.style.color = ok ? "#2f7440" : "#9a3f37";
  }

  async function routeByProfile() {
    const profile = await api.auth.profile();
    if (!profile) return false;
    if (["admin", "staff"].includes(profile.role)) global.location.replace("admin-operations.html");
    else if (profile.role === "supplier") global.location.replace("supplier-portal.html");
    else global.location.replace("customer-portal.html");
    return true;
  }

  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.authTab;
      document.querySelectorAll("[data-auth-tab]").forEach((b) => b.classList.toggle("is-active", b === button));
      document.querySelectorAll(".portal__authform").forEach((form) => form.classList.toggle("is-active", form.id === `${target}-form`));
      setMessage("");
    });
  });

  document.getElementById("signin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    setMessage("");
    try {
      const { error } = await client.auth.signInWithPassword({
        email: form.email.value.trim(),
        password: form.password.value
      });
      if (error) throw error;
      setMessage("Signed in. Opening your workspace…", true);
      await routeByProfile();
    } catch (err) {
      setMessage(err.message || "Sign in failed.");
      button.disabled = false;
    }
  });

  document.getElementById("register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) return form.reportValidity();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    setMessage("");
    try {
      const fullName = form.full_name.value.trim();
      const phone = form.phone.value.trim();
      const { data, error } = await client.auth.signUp({
        email: form.email.value.trim(),
        password: form.password.value,
        options: { data: { full_name: fullName, phone: phone || null } }
      });
      if (error) throw error;
      if (data.session) {
        setMessage("Customer account created. Opening your portal…", true);
        await routeByProfile();
        return;
      }
      setMessage("Account created. Check your email to confirm the account, then sign in.", true);
      form.reset();
      button.disabled = false;
    } catch (err) {
      setMessage(err.message || "Account creation failed.");
      button.disabled = false;
    }
  });

  (async () => {
    try {
      const { data } = await client.auth.getUser();
      if (data?.user) await routeByProfile();
    } catch (_) {}
  })();
})(window);

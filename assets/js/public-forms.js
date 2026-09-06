/* CKA BuildStruct — public-forms.js
   Replaces legacy simulated success for supplier registration and
   rate list subscription with verified Supabase RPC submissions. */
(function (global) {
  "use strict";

  const client = global.CKAStore && global.CKAStore.supabase;

  function setText(selector, value) {
    const el = document.querySelector(selector);
    if (el) el.textContent = value;
  }

  function installHomepagePolish() {
    const title = document.querySelector(".hero h1");
    if (title) title.textContent = "Build with confidence.";

    setText(
      ".hero .lead",
      "CKA BuildStruct is Pakistan's managed construction procurement platform, connecting project owners, builders and contractors with verified suppliers through live market rates, BOQ based quotations and professional design support."
    );
    setText(
      ".hero__trust",
      "Rated 4.9/5 by 2,300+ project owners in Rawalpindi, Islamabad and Lahore"
    );
    setText(
      "#showcase .sec-head h2",
      "Drawings, materials and live sites in one place."
    );
    setText(
      "#showcase .sec-head__note",
      "A snapshot of what CKA BuildStruct manages for you: field verified drawings, sourced materials and design previews, alongside every live project site."
    );
    setText(
      ".home-cta__text h3",
      "Wherever you are in your project"
    );

    document.querySelectorAll(".cta__in p").forEach((el) => {
      if (/Cement, steel, bricks and sand rates every morning/i.test(el.textContent || "")) {
        el.textContent = "Cement, steel, bricks and sand rates every morning, plus quotation support for your BOQ.";
      }
    });

    document.querySelectorAll(".pay-methods small").forEach((el) => {
      if (/IBFT\s*\/\s*RTGS/i.test(el.textContent || "")) {
        el.textContent = "IBFT / RTGS. Details shared with quotation";
      }
    });
  }

  function installBoqCarousel() {
    const tile = document.querySelector(".showcase-tile--boq");
    const carousel = tile && tile.querySelector(".boq-carousel");
    const slides = carousel ? Array.from(carousel.querySelectorAll(".boq-slide")) : [];
    if (!tile || !carousel || slides.length < 2) return;

    const hdSlides = [
      "assets/img/boq-carousel-hd-4.svg",
      "assets/img/boq-carousel-hd-5.svg",
      "assets/img/boq-carousel-hd-6.svg"
    ];
    hdSlides.forEach((src, index) => {
      const slide = slides[index + 3];
      if (slide) slide.src = src;
    });

    carousel.style.position = "absolute";
    carousel.style.inset = "0";
    carousel.style.overflow = "hidden";
    carousel.style.background = "#f3f1ec";

    slides.forEach((slide) => {
      slide.style.position = "absolute";
      slide.style.left = "0";
      slide.style.top = "0";
      slide.style.width = "100%";
      slide.style.height = "auto";
      slide.style.maxWidth = "none";
      slide.style.objectFit = "contain";
      slide.style.opacity = "0";
      slide.style.transform = "translateY(0) scale(1.02)";
      slide.style.transformOrigin = "top center";
      slide.style.willChange = "transform, opacity";
    });

    const reducedMotion = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      slides[0].style.opacity = "1";
      slides[0].style.transform = "translateY(-8%) scale(1.02)";
      return;
    }

    let current = -1;
    let timer = null;

    function showSlide(next) {
      if (current >= 0) {
        const previous = slides[current];
        previous.style.transition = "opacity .55s ease";
        previous.style.opacity = "0";
      }

      const slide = slides[next];
      slide.style.transition = "none";
      slide.style.opacity = "0";
      slide.style.transform = "translateY(0) scale(1.02)";
      void slide.offsetHeight;

      requestAnimationFrame(() => {
        slide.style.transition = "opacity .65s ease, transform 4.4s linear";
        slide.style.opacity = "1";
        slide.style.transform = "translateY(-42%) scale(1.04)";
      });

      current = next;
    }

    showSlide(0);
    timer = global.setInterval(() => showSlide((current + 1) % slides.length), 5000);

    tile.addEventListener("mouseenter", () => {
      if (timer) {
        global.clearInterval(timer);
        timer = null;
      }
    });

    tile.addEventListener("mouseleave", () => {
      if (!timer) timer = global.setInterval(() => showSlide((current + 1) % slides.length), 5000);
    });
  }

  installHomepagePolish();
  installBoqCarousel();
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
          `Registration received. Reference ${reference}. CKA will review the application before supplier approval.`,
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
          setStatus(form, "Subscribed. Your email is registered for CKA rate list updates.", true);
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

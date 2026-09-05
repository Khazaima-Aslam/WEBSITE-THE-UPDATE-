/* CKA BuildStruct — material-card-links.js
   Makes every marketplace material card open its dedicated detail page without
   interfering with image zoom or Add-to-quotation controls. */
(function (global) {
  "use strict";
  const grid = document.getElementById("product-grid");
  if (!grid || !Array.isArray(global.PRODUCTS)) return;

  function productForCard(card) {
    return global.PRODUCTS.find((p) => String(p.id) === String(card && card.dataset.id));
  }
  function productUrl(product) {
    if (!product) return "";
    if (product.dbId) return `product.html?id=${encodeURIComponent(product.dbId)}`;
    if (product.sku) return `product.html?sku=${encodeURIComponent(product.sku)}`;
    return `product.html?ui=${encodeURIComponent(product.id)}`;
  }
  function decorate() {
    grid.querySelectorAll(".p-card").forEach((card) => {
      if (card.dataset.detailReady) return;
      card.dataset.detailReady = "1";
      card.tabIndex = 0;
      card.setAttribute("role", "link");
      const p = productForCard(card);
      if (p) card.setAttribute("aria-label", `View details for ${p.title}`);
    });
  }
  function isControl(target) {
    return !!target.closest("button,a,input,select,textarea,[data-add],[data-zoom]");
  }
  function openCard(card) {
    const url = productUrl(productForCard(card));
    if (url) global.location.href = url;
  }

  grid.addEventListener("click", (event) => {
    if (isControl(event.target)) return;
    const card = event.target.closest(".p-card");
    if (card) openCard(card);
  });
  grid.addEventListener("keydown", (event) => {
    if (!['Enter',' '].includes(event.key) || isControl(event.target)) return;
    const card = event.target.closest(".p-card");
    if (!card) return;
    event.preventDefault();
    openCard(card);
  });
  new MutationObserver(decorate).observe(grid, { childList:true, subtree:true });
  decorate();

  if (new URLSearchParams(global.location.search).get("basket") === "1") {
    setTimeout(() => document.getElementById("cart-open")?.click(), 120);
  }
})(window);

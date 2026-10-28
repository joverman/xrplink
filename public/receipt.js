/**
 * Receipt actions: share (Web Share or clipboard) and print-to-PDF.
 * Kept as same-origin JS so CSP stays script-src 'self' without inline handlers.
 */
(function () {
  const shareBtn = document.getElementById("shareReceipt");
  const pdfBtn = document.getElementById("downloadPdf");
  const status = document.getElementById("shareStatus");

  function themedShareUrl() {
    if (shareBtn && shareBtn.getAttribute("data-share-url")) {
      return shareBtn.getAttribute("data-share-url");
    }
    const u = new URL(window.location.href);
    u.searchParams.delete("print");
    u.searchParams.delete("format");
    u.pathname = u.pathname.replace(/\/print\/?$/, "");
    return u.toString();
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  function flashCopied() {
    if (status) {
      status.hidden = false;
      status.textContent = "Link copied";
    }
    if (shareBtn) shareBtn.textContent = "Link copied";
    setTimeout(function () {
      if (status) status.hidden = true;
      if (shareBtn) shareBtn.textContent = "Share Receipt";
    }, 2000);
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", async function () {
      const url = themedShareUrl();
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: document.title,
            text: "Verified XRP payment receipt",
            url: url,
          });
          return;
        } catch (err) {
          if (err && err.name === "AbortError") return;
        }
      }
      try {
        await copyText(url);
        flashCopied();
      } catch {
        if (status) {
          status.hidden = false;
          status.textContent = "Copy this link: " + url;
        }
      }
    });
  }

  if (pdfBtn) {
    pdfBtn.addEventListener("click", function () {
      window.print();
    });
  }
})();

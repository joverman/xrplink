/**
 * Shared logged-in nav for every public page.
 * Uses the httpOnly session cookie (credentials: include) and falls back to
 * a Bearer token in localStorage so existing sessions still show as logged in.
 */
(function () {
  const TOKEN_KEY = "xrplink_token";
  const API_KEY_KEY = "xrplink_api_key";

  function authHeaders() {
    const headers = {};
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers["Authorization"] = "Bearer " + token;
    return headers;
  }

  async function loadSession() {
    try {
      const r = await fetch("/auth/session", { credentials: "include", headers: authHeaders() });
      if (!r.ok) return { user: null };
      return await r.json();
    } catch {
      return { user: null };
    }
  }

  function renderNav(user) {
    const el = document.getElementById("authNav");
    if (!el) return;
    if (user) {
      el.innerHTML =
        '<a href="/dashboard">Dashboard</a>' +
        '<span class="auth-email">' +
        escapeHtml(user.email) +
        "</span>" +
        '<a href="/auth/logout" class="auth-logout">Log out</a>';
      const logout = el.querySelector(".auth-logout");
      if (logout) logout.addEventListener("click", onLogout);
    } else {
      el.innerHTML =
        '<a href="/login">Log in</a>' +
        '<a href="/signup" class="btn btn-primary auth-signup">Sign up</a>';
    }
  }

  function renderPricing(user) {
    const freeBtn = document.querySelector("[data-pricing-cta=free]");
    const paidBtn = document.querySelector("[data-pricing-cta=paid]");
    const proBtn = document.querySelector("[data-pricing-cta=pro]");
    if (!user) return;

    if (freeBtn) {
      if (user.tier === "free") {
        markCurrent(freeBtn, "Current plan");
      } else {
        freeBtn.textContent = "Go to dashboard";
        freeBtn.setAttribute("href", "/dashboard");
      }
    }

    if (paidBtn) {
      if (user.tier === "paid") {
        markCurrent(paidBtn, "Current plan");
      } else if (user.tier === "pro") {
        paidBtn.textContent = "Included in Pro";
        paidBtn.setAttribute("href", "/dashboard");
      } else {
        paidBtn.textContent = "Upgrade — $29/mo";
        paidBtn.setAttribute("href", "#");
        paidBtn.addEventListener("click", function (e) {
          e.preventDefault();
          subscribe("paid");
        });
      }
    }

    if (proBtn) {
      if (user.tier === "pro") {
        markCurrent(proBtn, "Current plan");
      } else {
        proBtn.textContent = "Upgrade — $99/mo";
        proBtn.setAttribute("href", "#");
        proBtn.addEventListener("click", function (e) {
          e.preventDefault();
          subscribe("pro");
        });
      }
    }
  }

  function markCurrent(el, label) {
    el.textContent = label;
    el.removeAttribute("href");
    el.setAttribute("aria-current", "true");
    el.style.pointerEvents = "none";
    el.style.opacity = "0.75";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function onLogout(e) {
    e.preventDefault();
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(API_KEY_KEY);
    window.location.href = "/";
  }

  async function subscribe(tier) {
    try {
      const headers = { "Content-Type": "application/json", ...authHeaders() };
      const r = await fetch("/billing/subscribe", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ tier }),
      });
      const d = await r.json();
      if (r.ok && d.url) {
        window.location.href = d.url;
        return;
      }
      alert(d.message || "Could not start checkout. Check that Stripe is configured.");
    } catch {
      alert("Could not start checkout.");
    }
  }

  loadSession().then(function (data) {
    renderNav(data.user);
    renderPricing(data.user);
  });
})();

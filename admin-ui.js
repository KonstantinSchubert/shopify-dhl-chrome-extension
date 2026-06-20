// Content script in the TOP admin.shopify.com frame.
//
// admin.shopify.com is clickable by browser automation (unlike the DHL
// iframe), so this injects a floating button there. Clicking it asks the
// background worker to relay a "createLabel" message into the DHL frame.
//
// admin.shopify.com is a single-page app, so we watch route changes and only
// show the button on a "...createlabel..." URL.

(() => {
  "use strict";
  if (window.__dhlExtAdminInjected) return;
  window.__dhlExtAdminInjected = true;

  const onCreateLabelPage = () => /createlabel/i.test(location.href);

  // --- floating button + status toast -----------------------------------
  const btn = document.createElement("button");
  btn.textContent = "🤖 Auto-create DHL label";
  btn.title = "Click to auto-select product + create label.\nShift-click to dump a diagnostic to the console.";
  btn.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "padding:10px 14px",
    "border:0",
    "border-radius:10px",
    "background:#1a73e8",
    "color:#fff",
    "font:600 13px/1 -apple-system,Segoe UI,Roboto,sans-serif",
    "box-shadow:0 4px 14px rgba(0,0,0,.25)",
    "cursor:pointer",
  ].join(";");

  const toast = document.createElement("div");
  toast.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:60px",
    "z-index:2147483647",
    "max-width:420px",
    "padding:8px 12px",
    "border-radius:8px",
    "font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
    "box-shadow:0 4px 14px rgba(0,0,0,.25)",
    "display:none",
    "white-space:pre-wrap",
  ].join(";");

  function setStatus(text, kind) {
    toast.style.display = "block";
    toast.style.background =
      kind === "error" ? "#b71c1c" : kind === "ok" ? "#1b5e20" : "#263238";
    toast.style.color = "#fff";
    toast.textContent = text;
  }

  function describe(detail) {
    if (!detail) return "Done.";
    const bits = [detail.order, detail.fulfillment, detail.country, detail.product].filter(
      Boolean
    );
    return "Created: " + bits.join(" · ");
  }

  btn.addEventListener("click", async (e) => {
    const action = e.shiftKey ? "diagnose" : "createLabel";
    btn.disabled = true;
    setStatus(action === "diagnose" ? "Running diagnostic…" : "Working… do not navigate.", "info");
    try {
      const res = await chrome.runtime.sendMessage({ from: "admin-ui", action });
      if (!res) setStatus("❌ No response from background.", "error");
      else if (res.error) setStatus("❌ " + res.error, "error");
      else if (res.diagnostic) setStatus("🔍 Diagnostic logged to the console (DevTools → the dhlshipping.app frame).", "info");
      else setStatus("✅ " + describe(res.detail) + (res.note ? "\n⚠️ " + res.note : ""), "ok");
    } catch (err) {
      setStatus("❌ " + (err?.message || String(err)), "error");
    } finally {
      btn.disabled = false;
    }
  });

  // --- mount + SPA route watching ---------------------------------------
  function mount() {
    if (!btn.isConnected) {
      document.body.appendChild(btn);
      document.body.appendChild(toast);
    }
    const show = onCreateLabelPage();
    btn.style.display = show ? "block" : "none";
    if (!show) toast.style.display = "none";
  }

  // Patch history methods to emit a single "locationchange" event.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event("locationchange"));
      return ret;
    };
  }
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("locationchange")));
  window.addEventListener("locationchange", mount);

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
})();

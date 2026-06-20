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

  // --- floating button + status toast -----------------------------------
  const btn = document.createElement("button");
  btn.textContent = "🤖 Auto-create DHL label";
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
    if (!detail) return "(no detail)";
    return [
      detail.order,
      detail.fulfillment,
      detail.country,
      detail.product,
      detail.option && "opt: " + detail.option,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Diagnostic panel rendered in the admin frame, so it can be read or
  // screenshot directly (no DevTools console-frame switching). The <pre> has a
  // stable id so automation can scrape it via the DOM.
  let diagPanel = null;
  function renderDiagnostic(d) {
    console.log("[DHL-EXT admin] diagnostic", d);
    const json = JSON.stringify(d, null, 2);
    if (!diagPanel) {
      diagPanel = document.createElement("div");
      diagPanel.style.cssText = [
        "position:fixed", "left:12px", "bottom:12px", "z-index:2147483647",
        "width:min(560px,46vw)", "max-height:44vh", "overflow:auto",
        "background:#0d1117", "color:#c9d1d9", "border:1px solid #30363d",
        "border-radius:8px", "box-shadow:0 6px 20px rgba(0,0,0,.35)",
        "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
      ].join(";");
      const bar = document.createElement("div");
      bar.style.cssText =
        "position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#161b22;border-bottom:1px solid #30363d";
      const title = document.createElement("span");
      title.textContent = "DHL-EXT diagnostic";
      title.style.cssText = "font-weight:600;color:#e6edf3";
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "Copy";
      copyBtn.style.cssText = "margin-right:6px;cursor:pointer";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "✕";
      closeBtn.style.cssText = "cursor:pointer";
      closeBtn.addEventListener("click", () => (diagPanel.style.display = "none"));
      const grp = document.createElement("span");
      grp.append(copyBtn, closeBtn);
      bar.append(title, grp);
      const pre = document.createElement("pre");
      pre.id = "dhl-ext-diag-json";
      pre.style.cssText = "margin:0;padding:10px;white-space:pre-wrap;word-break:break-word";
      copyBtn.addEventListener("click", () => navigator.clipboard?.writeText(pre.textContent || ""));
      diagPanel.append(bar, pre);
      diagPanel.__pre = pre;
      document.body.appendChild(diagPanel);
    }
    diagPanel.style.display = "block";
    diagPanel.__pre.textContent = json;
  }

  // Diagnostics pushed automatically by the DHL frame on each load.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.from === "background" && msg.action === "diagnostic") {
      renderDiagnostic(msg.diagnostic);
    }
  });

  let running = false;
  async function run(action) {
    if (running) return;
    running = true;
    btn.disabled = true;
    setStatus(
      action === "diagnose"
        ? "Running diagnostic…"
        : action === "dryRun"
        ? "Dry run — verifying (will NOT buy a label)…"
        : "Working… do not navigate.",
      "info"
    );
    try {
      const res = await chrome.runtime.sendMessage({ from: "admin-ui", action });
      if (!res) setStatus("❌ No response from background.", "error");
      else if (res.error) setStatus("❌ " + res.error, "error");
      else if (res.diagnostic) {
        renderDiagnostic(res.diagnostic);
        setStatus("🔍 Diagnostic rendered (panel, bottom-left) and logged to console.", "info");
      }
      else if (res.dryRun) setStatus("🧪 DRY RUN — " + describe(res.detail) + (res.note ? "\n" + res.note : ""), "info");
      else setStatus("✅ Created: " + describe(res.detail) + (res.note ? "\n⚠️ " + res.note : ""), "ok");
    } catch (err) {
      setStatus("❌ " + (err?.message || String(err)), "error");
    } finally {
      btn.disabled = false;
      running = false;
    }
  }

  // Plain click = create label · Alt/Option-click = dry run · Shift-click = diagnose
  btn.title =
    "Click: auto-select product + create label.\n" +
    "Alt/Option-click: DRY RUN (verify only, does NOT buy).\n" +
    "Shift-click: dump a diagnostic.";
  btn.addEventListener("click", (e) =>
    run(e.shiftKey ? "diagnose" : e.altKey ? "dryRun" : "createLabel")
  );

  // Automation-accessible triggers. These travel through the shared DOM, so
  // browser automation can fire them via synthetic input / page evaluation
  // (a manifest `commands` shortcut is handled by the browser above the page
  // and is NOT reachable that way):
  //   • Keyboard: Cmd/Ctrl + Shift + Y  (dispatch a keydown to the page)
  //   • Event:    document.dispatchEvent(new CustomEvent('dhl-ext:create-label'))
  //               document.dispatchEvent(new CustomEvent('dhl-ext:diagnose'))
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "y" || e.key === "Y")) {
        if (!onCreateLabelPage()) return;
        e.preventDefault();
        run("createLabel");
      }
    },
    true
  );
  document.addEventListener("dhl-ext:create-label", () => run("createLabel"));
  document.addEventListener("dhl-ext:dry-run", () => run("dryRun"));
  document.addEventListener("dhl-ext:diagnose", () => run("diagnose"));

  // --- mount + SPA route watching ---------------------------------------
  const onCreateLabelPage = () => /createlabel/i.test(location.href);

  function mount() {
    if (!document.body) return;
    if (!btn.isConnected) {
      document.body.appendChild(btn);
      document.body.appendChild(toast);
    }
    const show = onCreateLabelPage();
    btn.style.display = show ? "block" : "none";
    if (!show) toast.style.display = "none";
  }

  // admin.shopify.com is a single-page app. A content script lives in an
  // isolated world, so patching history.pushState here would NOT see the
  // page's own route changes. Poll location.href instead — cheap and reliable,
  // and it also re-attaches the button if React detaches it.
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount);
  setInterval(mount, 1000);
})();

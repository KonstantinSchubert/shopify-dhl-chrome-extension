// Content script injected INTO the dhlshipping.app iframe (all_frames: true).
//
// Because it runs inside the frame's own origin, it has full DOM access that
// page-level / cross-origin JS does not. It selects the shipping product,
// ticks the required option, waits for the rate, clicks "Create label" and
// then "Download" — deterministically, via the controls' own handlers rather
// than synthetic pixel clicks.
//
// Selectors here are intentionally text/label driven and DEFENSIVE. The exact
// DOM was never inspectable cross-origin, so run the Phase-1 diagnostic
// (shift-click the floating button, or read the [DHL-EXT] console dump on
// load) and tighten the CONFIG regexes below from real output if needed.

(() => {
  "use strict";

  const PREFIX = "[DHL-EXT]";
  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
  const errlog = (...a) => console.error(PREFIX, ...a);

  // ------------------------------------------------------------------ CONFIG
  const CONFIG = {
    // Country classification, evaluated in order; first match wins.
    // Anything that matches neither DE nor US is treated as INTL.
    // Classify by searching the whole Destination card text for name variants.
    // First match wins; anything that matches neither is treated as INTL.
    countryRules: [
      { category: "DE", test: /\b(germany|deutschland|allemagne|alemania|germania|duitsland)\b/i },
      {
        category: "US",
        test: /\b(united states(?: of america)?|u\.?\s?s\.?\s?a\.?|usa|vereinigte staaten|états[- ]?unis|estados unidos)\b/i,
      },
    ],

    // Per §3 of the spec. Match by visible label text and, where known, by
    // product code. `option` is the required checkbox (or null).
    products: {
      DE: {
        name: "Kleinpaket",
        labels: [/kleinpaket/i],
        codes: [],
        option: null,
      },
      US: {
        name: "DHL Paket",
        labels: [/dhl\s*paket\b/i],
        codes: [],
        option: {
          name: "Postal Delivery Duty Paid (DDP)",
          ids: ["postalDeliveryDutyPaidCheckbox"], // observed stable id
          labels: [/postal delivery duty paid/i, /\bDDP\b/, /duty paid/i],
          desired: true,
        },
      },
      INTL: {
        name: "Warenpost International",
        labels: [/warenpost international/i],
        codes: [/V66WPI/i],
        option: {
          name: "Premium",
          ids: ["premiumCheckbox"], // observed stable id
          labels: [/\bpremium\b/i],
          desired: true,
        },
      },
    },

    readyTimeoutMs: 20_000, // wait for rate / Create-label enabled
    downloadTimeoutMs: 20_000, // wait for Download control after create
  };

  // --------------------------------------------------------------- utilities
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Collect the visible text associated with a control: aria-label, its
  // <label>(s), and up to `climb` ancestor rows. Bounded to avoid pulling in
  // half the page.
  function visibleTextFor(el, climb = 3) {
    const parts = [];
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) parts.push(forLabel.textContent);
    }
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const labelAncestor = el.closest && el.closest("label");
    if (labelAncestor) parts.push(labelAncestor.textContent);
    let node = el;
    for (let i = 0; i < climb && node; i++) {
      node = node.parentElement;
      if (node) parts.push(node.textContent);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // Polaris ResourceList rows keep the radio's <label> text EMPTY and render
  // the visible content (product name, fulfillment #) in a separate column of
  // the same row. So for matching we read the whole enclosing row, not just the
  // control's own label.
  function rowContainerFor(el) {
    return (
      el.closest(
        'li, tr, fieldset, [role="listitem"], [class*="ResourceItem__ListItem"], [class*="ResourceItem"]'
      ) || null
    );
  }
  function rowTextFor(el) {
    const row = rowContainerFor(el);
    let t = row ? (row.textContent || "").replace(/\s+/g, " ").trim() : "";
    if (t) return t;
    // No recognizable row container — climb to the nearest non-empty ancestor.
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const x = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (x) return x;
    }
    return visibleTextFor(el, 5);
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Wait until `predicate()` is truthy, via MutationObserver + polling.
  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      if (predicate()) return resolve(true);
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(iv);
        clearTimeout(to);
        resolve(val);
      };
      const obs = new MutationObserver(() => {
        if (predicate()) finish(true);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const iv = setInterval(() => predicate() && finish(true), 250);
      const to = setTimeout(() => finish(false), timeoutMs);
    });
  }

  // Set a checkbox/radio's `checked` through React's native setter so the
  // framework's onChange actually fires.
  function nativeSetChecked(input, value) {
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "checked"
    );
    if (desc?.set) desc.set.call(input, value);
    else input.checked = value;
  }

  function readChecked(el) {
    if (el.tagName === "INPUT" && el.type === "checkbox") return el.checked;
    if (el.tagName === "INPUT" && el.type === "radio") return el.checked;
    return el.getAttribute("aria-checked") === "true";
  }

  // -------------------------------------------------------- destination card
  function readDestinationCountry() {
    // The destination card is `[data-testid^="toAddress"]`. The most reliable
    // country signal is the flag image (…/flags/4x3/<iso2>.svg).
    const card = document.querySelector('[data-testid^="toAddress" i]');
    if (!card) {
      return {
        ok: false,
        error: "Destination card ([data-testid^=toAddress]) not found.",
      };
    }
    const text = (card.innerText || card.textContent || "").replace(/\s+/g, " ").trim();

    // Classify by searching the WHOLE card text for country-name variants —
    // robust to where the country renders. Neither match ⇒ INTL.
    let category = "INTL";
    for (const rule of CONFIG.countryRules) {
      if (rule.test.test(text)) {
        category = rule.category;
        break;
      }
    }

    // Display-only country name: flag iso2 if present, else last non-email line.
    let code = null;
    const flag = card.querySelector('img[src*="/flags/"]');
    if (flag) {
      const m = (flag.getAttribute("src") || "").match(/\/flags\/[^/]+\/([a-z]{2})\.svg/i);
      if (m) code = m[1].toUpperCase();
    }
    const lines = (card.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => !/@/.test(l) && l.toLowerCase() !== "destination");
    const countryName = lines.length ? lines[lines.length - 1] : code || "";

    return { ok: true, category, code, country: countryName, raw: text.slice(0, 300) };
  }

  // ------------------------------------------------------------ order/fulfilment
  function readOrderInfo() {
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    // Prefer the fulfillment token (e.g. "#2071-F2", "#2072-FO1") over a bare
    // order number that may appear first elsewhere on the page.
    const ful = body.match(/#(\d{2,})-(F[O0]?\d+)/i);
    const ord = body.match(/#(\d{2,})/);
    const orderNumber = (ful && ful[1]) || (ord && ord[1]) || null;
    return {
      orderName: orderNumber ? `#${orderNumber}` : null,
      fulfillmentName: ful ? `${ful[1]}-${ful[2]}` : null, // for the downloaded filename
    };
  }

  // ----------------------------------------------------------- product radios
  function radioCandidates() {
    const els = [
      ...document.querySelectorAll('input[type="radio"], [role="radio"]'),
    ];
    return els.map((el) => ({ el, text: rowTextFor(el) }));
  }

  function findProductInput(rule) {
    const candidates = radioCandidates();
    // Code match is most specific.
    for (const code of rule.codes) {
      const hit = candidates.find((c) => code.test(c.text));
      if (hit) return hit;
    }
    for (const label of rule.labels) {
      const hit = candidates.find((c) => label.test(c.text));
      if (hit) return hit;
    }
    return null;
  }

  // Select a radio reliably, then verify it stuck.
  async function selectRadio(el) {
    if (readChecked(el)) return true;

    // 1) the control's own click handler
    el.click();
    await delay(40);
    if (readChecked(el)) return true;

    // 2) native setter + synthetic events (React workaround)
    if (el.tagName === "INPUT") {
      nativeSetChecked(el, true);
      el.dispatchEvent(new Event("click", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(60);
      if (readChecked(el)) return true;
    }

    // 3) click the enclosing label/row that may carry the real handler
    const row = (el.closest && el.closest("label")) || el.parentElement;
    if (row) {
      row.click();
      await delay(60);
    }
    return readChecked(el) === true;
  }

  // -------------------------------------------------------------- option box
  function findCheckboxFor(option) {
    // Prefer stable ids when known, fall back to visible-text matching.
    for (const id of option.ids || []) {
      const el = document.getElementById(id);
      if (el) return { el, text: visibleTextFor(el, 2) };
    }
    const boxes = [
      ...document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]'),
    ].map((el) => ({ el, text: rowTextFor(el) }));
    for (const label of option.labels || []) {
      const hit = boxes.find((c) => label.test(c.text));
      if (hit) return hit;
    }
    return null;
  }

  async function ensureOption(option) {
    const found = findCheckboxFor(option);
    if (!found) {
      return {
        ok: false,
        error: `Required option not found: "${option.name}".`,
      };
    }
    const el = found.el;
    if (readChecked(el) === option.desired) return { ok: true }; // already correct (idempotent)

    el.click();
    await delay(60);
    if (readChecked(el) !== option.desired && el.tagName === "INPUT") {
      nativeSetChecked(el, option.desired);
      el.dispatchEvent(new Event("click", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(60);
    }
    if (readChecked(el) !== option.desired) {
      return {
        ok: false,
        error: `Could not set option "${option.name}" to ${option.desired}.`,
      };
    }
    return { ok: true };
  }

  // ----------------------------------------------------- create / download
  function findCreateLabelButton() {
    const byId = document.getElementById("createLabel"); // observed stable id
    if (byId) return byId;
    const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
    return (
      btns.find((b) => /create\s*label/i.test(b.textContent || b.value || "") && isVisible(b)) ||
      null
    );
  }

  const DOWNLOAD_RE = /download|herunterladen|\.pdf\b|\bpdf\b/i;
  function findDownloadControl() {
    // The per-label PDF control is an <a download href=…> with a stable id
    // like "download-pdf-<productId>". Prefer those exact signals.
    const direct = document.querySelector(
      'a[download], [id^="download-pdf"], a[href*="/label/"][href*="shipment"]'
    );
    if (direct && isVisible(direct)) return direct;

    const els = [
      ...document.querySelectorAll('button, a, [role="button"], [role="link"], [download]'),
    ];
    return (
      els.find((el) => {
        if (!isVisible(el)) return false;
        if (el.id === "createLabel" || /create\s*label/i.test(el.textContent || "")) return false;
        const t = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${
          el.getAttribute("title") || ""
        } ${el.getAttribute("href") || ""} ${el.id}`;
        return el.hasAttribute("download") || DOWNLOAD_RE.test(t);
      }) || null
    );
  }

  function isEnabled(btn) {
    return (
      btn &&
      !btn.disabled &&
      btn.getAttribute("aria-disabled") !== "true" &&
      !btn.classList.contains("disabled")
    );
  }

  // --------------------------------------------------------------- main flow
  async function createLabel(opts = {}) {
    const dryRun = !!opts.dryRun;
    hidePanel();
    const dest = readDestinationCountry();
    if (!dest.ok) return { error: dest.error };
    log("destination:", dest.category, dest.country);

    const rule = CONFIG.products[dest.category];
    if (!rule) return { error: `No product rule for category ${dest.category}.` };

    // 1–2: find + select product
    const product = findProductInput(rule);
    if (!product) {
      const seen = radioCandidates()
        .map((c) => `"${(c.text || "").slice(0, 70)}"`)
        .join(" | ");
      return {
        error: `Shipping product "${rule.name}" not found for ${dest.country}. Aborting (won't guess). Radios seen: [ ${seen} ]`,
      };
    }
    log("product candidate:", product.text.slice(0, 80));
    const selected = await selectRadio(product.el);
    if (!selected) {
      return { error: `Selecting "${rule.name}" did not stick. Aborting.` };
    }

    // 3: ensure option checkbox
    if (rule.option) {
      const opt = await ensureOption(rule.option);
      if (!opt.ok) return { error: opt.error };
      log("option ensured:", rule.option.name);
    }

    // 4: wait for the rate / Create-label button to be ready
    const ready = await waitFor(
      () => isEnabled(findCreateLabelButton()),
      CONFIG.readyTimeoutMs
    );
    if (!ready) {
      return {
        error: "Rate did not become ready in time — aborting before Create label.",
      };
    }

    const order = readOrderInfo();
    const detail = {
      order: order.orderName,
      fulfillment: order.fulfillmentName,
      country: dest.country,
      category: dest.category,
      product: (product.text || "").slice(0, 80),
      option: rule.option ? rule.option.name : "(none)",
    };

    // Dry run: everything verified, but DO NOT buy the label.
    if (dryRun) {
      log("DRY RUN — stopping before Create label");
      return {
        ok: true,
        dryRun: true,
        detail,
        note: "DRY RUN — product + option verified; Create label was NOT clicked.",
      };
    }

    // optional: pre-name the download
    if (order.fulfillmentName) {
      try {
        await chrome.runtime.sendMessage({
          from: "dhl-frame",
          action: "expectDownload",
          filename: `${order.fulfillmentName}.pdf`,
        });
      } catch (e) {
        warn("could not register filename:", e?.message || e);
      }
    }

    // 5: create the label
    const createBtn = findCreateLabelButton();
    if (!isEnabled(createBtn)) return { error: "Create label button vanished/disabled at click time." };
    log("clicking Create label");
    createBtn.click();

    // 6: wait for Download control, then click it
    const dlReady = await waitFor(() => !!findDownloadControl(), CONFIG.downloadTimeoutMs);
    if (!dlReady) {
      return {
        ok: true,
        detail,
        note: "Label created, but Download control not found — download manually.",
      };
    }
    log("clicking Download");
    findDownloadControl().click();
    return { ok: true, detail };
  }

  // ------------------------------------------------------- Phase-1 diagnostic
  function describeControl(el) {
    const r = el.getBoundingClientRect();
    const row = rowContainerFor(el) || el.parentElement;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || el.getAttribute("role") || "",
      name: el.getAttribute("name") || "",
      value: el.getAttribute("value") || "",
      id: el.id || "",
      checked: readChecked(el),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text: rowTextFor(el).slice(0, 160),
      rowHtml: (row?.outerHTML || "").slice(0, 1500),
    };
  }

  function diagnose() {
    const radios = [
      ...document.querySelectorAll('input[type="radio"], [role="radio"]'),
    ].map(describeControl);
    const checks = [
      ...document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]'),
    ].map(describeControl);

    const dest = readDestinationCountry();
    const order = readOrderInfo();
    const createBtn = findCreateLabelButton();
    const dlCtl = findDownloadControl();

    // Every button/link, so a download/print control reveals itself.
    const clickables = [
      ...document.querySelectorAll('button, a, [role="button"], [role="link"], [download]'),
    ]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        aria: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        href: el.getAttribute("href") || "",
        download: el.hasAttribute("download"),
        visible: isVisible(el),
      }))
      .filter((c) => c.text || c.aria || c.title || c.href || c.id || c.download);

    const result = {
      href: location.href,
      origin: location.origin,
      radios,
      checkboxes: checks,
      destination: dest,
      order,
      createLabelButton: createBtn
        ? { text: (createBtn.textContent || "").trim().slice(0, 60), enabled: isEnabled(createBtn) }
        : null,
      downloadControl: dlCtl
        ? { text: (dlCtl.textContent || dlCtl.getAttribute("aria-label") || "").trim().slice(0, 60) }
        : null,
      clickables,
    };

    // Include a truncated product-container HTML so selectors can be worked
    // out from the admin frame without switching console contexts.
    const firstControl = document.querySelector('input[type="radio"], [role="radio"]');
    if (firstControl) {
      const container =
        firstControl.closest('[class*="list"], ul, table, fieldset, section') ||
        firstControl.parentElement;
      result.productContainerHtml = (container?.outerHTML || "").slice(0, 6000);
    }

    log("===== Phase-1 diagnostic =====");
    log("URL:", result.href);
    log("radios (" + radios.length + "):", radios);
    log("checkboxes (" + checks.length + "):", checks);
    log("destination:", dest);
    log("order:", order);
    log("create label button:", result.createLabelButton);
    log("download control:", result.downloadControl);
    // Single copy-pasteable blob (console object trees are collapsed/lossy).
    log("JSON (copy everything between the <<< >>> markers):");
    console.log("<<<DHL-EXT-JSON\n" + JSON.stringify(result, null, 2) + "\nDHL-EXT-JSON>>>");
    log("==============================");
    return result;
  }

  // ----------------------------------------------------------------- panel UI
  let panelEl = null;
  function showPanel(kind, text) {
    if (!panelEl) {
      panelEl = document.createElement("div");
      panelEl.style.cssText = [
        "position:fixed",
        "bottom:12px",
        "left:12px",
        "z-index:2147483647",
        "max-width:420px",
        "padding:10px 12px",
        "border-radius:8px",
        "font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
        "box-shadow:0 4px 16px rgba(0,0,0,.25)",
        "white-space:pre-wrap",
      ].join(";");
      document.documentElement.appendChild(panelEl);
    }
    const bg = kind === "error" ? "#b71c1c" : kind === "ok" ? "#1b5e20" : "#263238";
    panelEl.style.background = bg;
    panelEl.style.color = "#fff";
    panelEl.textContent = `${PREFIX} ${text}`;
  }
  function hidePanel() {
    if (panelEl) panelEl.remove();
    panelEl = null;
  }

  // ----------------------------------------------------------- message wiring
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;

    if (msg.action === "createLabel" || msg.action === "dryRun") {
      const dryRun = msg.action === "dryRun";
      createLabel({ dryRun })
        .then((res) => {
          if (res.error) {
            errlog(res.error);
            showPanel("error", res.error);
          } else {
            showPanel(res.dryRun ? "info" : "ok", (res.dryRun ? "DRY RUN ok: " : "Label flow done: ") + JSON.stringify(res.detail));
          }
          sendResponse(res);
        })
        .catch((e) => {
          const m = String(e?.stack || e);
          errlog(m);
          showPanel("error", m);
          sendResponse({ error: m });
        });
      return true; // async
    }

    if (msg.action === "diagnose") {
      try {
        const d = diagnose();
        showPanel("info", "Diagnostic logged to console (" + d.radios.length + " radios, " + d.checkboxes.length + " checkboxes).");
        sendResponse({ ok: true, diagnostic: d });
      } catch (e) {
        sendResponse({ error: String(e?.stack || e) });
      }
      return true;
    }

    return false;
  });

  // Push a diagnostic to the admin (top) frame via the background worker, so it
  // can be read/screenshot there without switching console contexts.
  function pushDiagnostic(d) {
    try {
      chrome.runtime.sendMessage({ from: "dhl-frame", action: "diagnostic", diagnostic: d });
    } catch (e) {
      warn("could not push diagnostic:", e?.message || e);
    }
  }

  // On load: announce presence and dump a Phase-1 diagnostic to the console
  // (logging only — no actions taken), and forward it to the admin frame.
  log("frame script loaded on", location.origin, "frame:", location.href);
  // Defer so the app's UI has settled.
  setTimeout(() => {
    try {
      pushDiagnostic(diagnose());
    } catch (e) {
      warn("auto-diagnose failed:", e?.message || e);
    }
  }, 1500);
})();

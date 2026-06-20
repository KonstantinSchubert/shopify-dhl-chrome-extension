# Post & DHL Shipping — Label Auto-Selector

A small Manifest V3 Chrome extension that operates the shipping-product
controls **inside the Post & DHL Shipping app's cross-origin iframe** in
Shopify Admin — the one thing pixel-level browser automation cannot do
reliably.

The extension owns **only** the cross-origin gap on an open *Create Label*
page once a fulfillment row is selected:

1. read the destination country,
2. select the correct shipping product,
3. ensure the correct option checkbox,
4. wait for the rate, then click **Create label**,
5. click **Download** (optionally pre-naming the file `<order>-F<n>.pdf`).

Everything else (which order, splitting, filing, printing, reporting) stays in
the outer orchestration. See the build spec for full context.

## Layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, matches, permissions, `Cmd/Ctrl+Shift+L` command |
| `dhl-frame.js` | Content script **inside** the `dhlshipping.app` iframe — all DOM logic + diagnostics |
| `admin-ui.js` | Floating **"🤖 Auto-create DHL label"** button in the top admin frame |
| `background.js` | Relays admin-frame → DHL-frame messages; optional download-filename control |

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Reload after any edit.

## Business rules (§3 of the spec)

| Destination | Product | Required option |
|---|---|---|
| Germany | Kleinpaket | — |
| Any non-US foreign country | Warenpost International (`V66WPI`) | Premium ✅ |
| United States | DHL Paket | Postal Delivery Duty Paid (DDP) ✅ |

Matching is by **visible label text** (and product code where known), never by
list position. If the required product isn't present, the extension **aborts**
rather than guessing — it never buys a wrong label.

## Phase 1 — capture the real selectors first

The DHL frame's DOM was never inspectable cross-origin, so the selectors in
`dhl-frame.js` are defensive guesses. Before trusting the action flow:

1. Open a real **Create Label** page and select a fulfillment row.
2. The frame script auto-dumps a `[DHL-EXT]` diagnostic to the console on load.
   You can also **shift-click** the floating button to re-dump on demand.
3. In DevTools, select the **`dhlshipping.app` frame** as the console context
   (the frame dropdown at the top of the Console). Read the dump: every radio /
   checkbox with its `name`/`value`/`id`/`checked`/`disabled`/rect/nearest text,
   the product-container HTML, the detected destination, and the Create/Download
   controls.
4. Tighten the `CONFIG` regexes in `dhl-frame.js` from that real output if the
   defaults don't match.

## Phase 2 — run it

- Click **🤖 Auto-create DHL label** (or press `Cmd/Ctrl+Shift+L`).
- Watch the toast / the in-frame panel for `✅` success or a `❌` abort reason.
- Every step is **idempotent and verified** — re-running on an already-correct
  page is safe and won't create duplicate labels.

## Safety

Buying a label is a real charge and emails the customer. The flow **aborts
before Create label** if the product isn't found, a selection won't stick, the
rate never readies, or an option won't toggle. It only ever operates on the
currently-selected fulfillment.

## Test matrix

- **Non-US foreign** (e.g. Netherlands) → Warenpost International + Premium
- **Germany** → Kleinpaket
- **United States** → DHL Paket + DDP
- Re-click to confirm idempotency; confirm abort paths surface a clear error.

## Open items (resolve during Phase 1)

- Exact `dhlshipping.app` host(s) and createlabel frame URL pattern.
- Why the product radio ignored synthetic clicks (custom widget vs hidden input).
- Exact label/code for Kleinpaket and DHL Paket in this account.
- Where Premium / DDP checkboxes render and their selectors.

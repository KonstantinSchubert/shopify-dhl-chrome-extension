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
| `manifest.json` | MV3 manifest, matches, permissions |
| `dhl-frame.js` | Content script **inside** the `dhlshipping.app` iframe — all DOM logic + diagnostics |
| `admin-ui.js` | Floating button + keyboard/event triggers in the top admin frame |
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
2. On load, the DHL frame auto-runs a diagnostic and **pushes it up to the admin
   frame**, where it renders in a **dark panel (bottom-left)** and is logged to
   the admin-frame console. The panel's `<pre id="dhl-ext-diag-json">` is plain
   JSON — readable/screenshot-able by automation, no DevTools needed. You can
   also **shift-click** the floating button (or fire `dhl-ext:diagnose`) to
   re-dump on demand.
3. The dump contains every radio / checkbox (`name`/`value`/`id`/`checked`/
   `disabled`/rect/nearest text), a truncated product-container HTML, the
   detected destination, order, and the Create/Download controls. (The same
   `[DHL-EXT]` data is also in the `dhlshipping.app` frame console if you prefer.)
4. Tighten the `CONFIG` regexes in `dhl-frame.js` from that real output if the
   defaults don't match.

## Phase 2 — run it

Three equivalent ways to trigger the flow (all funnel through one guarded
handler, so they can't double-fire):

- **Button:** click **🤖 Auto-create DHL label** (bottom-right).
  - **Alt/Option-click** = **dry run**: selects the product + option and waits
    for the rate, but does **NOT** click Create label (no charge). Use this to
    verify a new product mapping before buying for real.
  - **Shift-click** = dump a diagnostic.
- **Keyboard:** press **`Cmd/Ctrl+Shift+Y`** (a DOM `keydown` listener, so
  browser automation can fire it with synthetic input).
- **Event (most automation-friendly):** evaluate in the page —
  ```js
  document.dispatchEvent(new CustomEvent('dhl-ext:create-label')); // create for real
  document.dispatchEvent(new CustomEvent('dhl-ext:dry-run'));      // verify only, no charge
  document.dispatchEvent(new CustomEvent('dhl-ext:diagnose'));     // dump diagnostics
  ```

Then:

- Watch the toast / the in-frame panel for `✅` success or a `❌` abort reason.
- Every step is **idempotent and verified** — re-running on an already-correct
  page is safe and won't create duplicate labels.

> The keyboard shortcut is one line in `admin-ui.js` (the `keydown` listener) —
> change `e.key === "y"` if `Cmd/Ctrl+Shift+Y` ever collides with something.

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

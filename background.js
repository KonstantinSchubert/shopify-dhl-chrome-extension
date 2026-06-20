// Background service worker.
//
// Content scripts living in different frames cannot message each other
// directly, so this worker relays messages from the admin-frame button
// (admin-ui.js) to the DHL app frame (dhl-frame.js), targeting the correct
// frameId. It also (optionally) controls the downloaded label's filename.

const DHL_HOST_RE = /(^|\.)dhlshipping\.app$/i;

function log(...args) {
  console.log("[DHL-EXT bg]", ...args);
}

// Locate the frameId of the dhlshipping.app iframe inside a given tab.
async function findDhlFrameId(tabId) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (e) {
    return { error: "webNavigation.getAllFrames failed: " + (e?.message || e) };
  }
  if (!frames) return { error: "No frames reported for this tab." };
  const match = frames.find((f) => {
    try {
      return DHL_HOST_RE.test(new URL(f.url).hostname);
    } catch {
      return false;
    }
  });
  if (!match) {
    return {
      error:
        "DHL app frame not found in this tab. Open a 'Create Label' page first.",
    };
  }
  return { frameId: match.frameId };
}

// Forward an action to the DHL frame and return its reply.
async function relayToDhlFrame(tabId, action) {
  if (tabId == null) return { error: "No tab id." };
  const found = await findDhlFrameId(tabId);
  if (found.error) return { error: found.error };
  try {
    const reply = await chrome.tabs.sendMessage(
      tabId,
      { action },
      { frameId: found.frameId }
    );
    return reply ?? { error: "No reply from DHL frame." };
  } catch (e) {
    return {
      error:
        "Could not reach DHL frame (is the content script loaded?): " +
        (e?.message || e),
    };
  }
}

// --- Optional filename control (§6) -------------------------------------
// dhl-frame.js tells us the intended filename just before it clicks Download.
let pendingFilename = null;
let pendingFilenameAt = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  // From admin-ui.js floating button.
  if (msg.from === "admin-ui" && (msg.action === "createLabel" || msg.action === "diagnose")) {
    relayToDhlFrame(sender.tab?.id, msg.action).then(sendResponse);
    return true; // async
  }

  // From dhl-frame.js: forward a diagnostic up to the admin top frame so it can
  // be read/screenshot there (the dhl frame is a separate console context).
  if (msg.from === "dhl-frame" && msg.action === "diagnostic") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.tabs
        .sendMessage(
          tabId,
          { from: "background", action: "diagnostic", diagnostic: msg.diagnostic },
          { frameId: 0 }
        )
        .catch(() => {});
    }
    return false;
  }

  // From dhl-frame.js: remember the next download's filename.
  if (msg.from === "dhl-frame" && msg.action === "expectDownload") {
    pendingFilename = typeof msg.filename === "string" ? msg.filename : null;
    pendingFilenameAt = Date.now();
    log("expecting download as", pendingFilename);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

if (chrome.downloads?.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Only apply if a filename was requested in the last 60s.
    if (pendingFilename && Date.now() - pendingFilenameAt < 60_000) {
      const name = pendingFilename;
      pendingFilename = null;
      log("renaming download", item.filename, "->", name);
      suggest({ filename: name, conflictAction: "uniquify" });
    } else {
      pendingFilename = null;
      suggest();
    }
  });
}

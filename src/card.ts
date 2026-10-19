import { cpscDeathMention } from "./sources/cpsc.js";
import { spokenDate, stripListNumber } from "./text.js";
import type { Recall, Source } from "./types.js";

// The visual recall card, served as an MCP Apps UI resource. The extension is
// io.modelcontextprotocol/ui: a ui:// resource with the text/html;profile=mcp-app
// media type, linked to a tool through the tool's _meta.ui.resourceUri field.
// The document is small and self-contained: inline CSS only, no network scripts,
// no external fonts and no tracking. A host that does not support MCP Apps still
// reads the spoken text answer and the structured result.

export const CARD_URI = "ui://recall-radar/card";
export const CARD_MIME = "text/html;profile=mcp-app";
export const CARD_NAME = "Recall card";

const SOURCE_LABELS: Record<Source, string> = {
  nhtsa: "NHTSA",
  cpsc: "CPSC",
  "fda-food": "FDA",
  "fda-drug": "FDA",
};

export function sourceLabel(source: Source): string {
  return SOURCE_LABELS[source] ?? "Recall source";
}

export function severityLabel(severity?: Recall["severity"]): string {
  if (severity === "high") return "High severity";
  if (severity === "medium") return "Medium severity";
  if (severity === "low") return "Low severity";
  return "Severity not stated";
}

/** The severity to show. A CPSC recall that mentions death or a fatal outcome counts as high, the same rule the watch list ranking uses. */
export function effectiveSeverity(recall: Recall): Recall["severity"] {
  return recall.severity ?? (cpscDeathMention(recall) ? "high" : undefined);
}

/** Escape every character that could break out of HTML text or an attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only an http or https link is kept, so a javascript URL can never become a clickable link. */
function safeLink(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

/** The card markup for one recall, built from structured data. Every value is escaped. */
export function renderRecallCard(recall: Recall): string {
  const link = safeLink(recall.url);
  const linkRow = link
    ? `<a class="rr-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">View the official recall</a>`
    : "";
  return [
    `<article class="rr-card">`,
    `<header class="rr-head"><span class="rr-source">${escapeHtml(sourceLabel(recall.source))}</span><span class="rr-severity">${escapeHtml(severityLabel(effectiveSeverity(recall)))}</span></header>`,
    `<h2 class="rr-title">${escapeHtml(stripListNumber(recall.title))}</h2>`,
    `<p class="rr-date">${escapeHtml(spokenDate(recall.date))}</p>`,
    `<p class="rr-field"><span class="rr-field-name">Hazard</span><span class="rr-field-value">${escapeHtml(recall.hazard)}</span></p>`,
    `<p class="rr-field"><span class="rr-field-name">Remedy</span><span class="rr-field-value">${escapeHtml(recall.remedy)}</span></p>`,
    linkRow,
    `</article>`,
  ].join("");
}

const CARD_STYLE = `:root{color-scheme:light dark}
body{margin:0;padding:12px;background:transparent;color:light-dark(#1a1a1a,#f2f2f2);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.rr-empty{margin:0;font-size:14px;opacity:.7}
.rr-card{max-width:420px;padding:16px;border:1px solid light-dark(#d9d9d9,#3a3a3a);border-radius:14px;background:light-dark(#ffffff,#1e1e1e);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.rr-head{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.rr-source{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:light-dark(#0b5cad,#79b8ff)}
.rr-severity{margin-left:auto;font-size:12px;padding:2px 8px;border-radius:999px;background:light-dark(#eef1f5,#2a2f36)}
.rr-title{margin:0 0 4px;font-size:18px;line-height:1.25}
.rr-date{margin:0 0 10px;font-size:13px;opacity:.7}
.rr-field{margin:0 0 8px;font-size:14px;line-height:1.4}
.rr-field-name{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.6}
.rr-link{display:inline-block;margin-top:6px;font-size:14px;font-weight:600;color:light-dark(#0b5cad,#79b8ff)}`;

/**
 * The full self-contained card document. When a recall is given it is rendered server side, so a
 * screen that does not run scripts still shows a card. In an MCP Apps host the newest recall
 * arrives as a tool result and the small inline script rebuilds the card from the structured
 * result. The script writes every value with textContent, so no value can become markup.
 */
export function cardDocument(initial?: Recall): string {
  const body = initial ? renderRecallCard(initial) : `<p class="rr-empty">Checking the newest recall.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(CARD_NAME)}</title>
<style>${CARD_STYLE}</style>
</head>
<body>
<main id="rr-root" class="rr-root">${body}</main>
<script>
(function () {
  var root = document.getElementById("rr-root");
  var initId = 1;
  var initialized = false;
  function text(tag, cls, value) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = value === undefined || value === null ? "" : String(value);
    return el;
  }
  function sourceName(source) {
    return source === "nhtsa" ? "NHTSA" : source === "cpsc" ? "CPSC" : (source === "fda-food" || source === "fda-drug") ? "FDA" : "Recall source";
  }
  var DEATH_MENTION = /\\b(?:death|deaths|died|fatal(?:it(?:y|ies))?)\\b/i;
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function spokenDate(value) {
    var text = String(value === undefined || value === null ? "" : value).trim();
    var match = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(text);
    if (!match) return text;
    var month = MONTHS[Number(match[2]) - 1];
    return month ? Number(match[3]) + " " + month + " " + match[1] : text;
  }
  function stripListNumber(value) {
    var out = String(value === undefined || value === null ? "" : value);
    for (var i = 0; i < 3; i++) {
      var next = out.replace(/^\\s*\\d+\\.\\s+/, "");
      if (next === out) break;
      out = next;
    }
    return out;
  }
  function severityName(recall) {
    var severity = recall ? recall.severity : undefined;
    if (!severity && recall && recall.source === "cpsc" && (DEATH_MENTION.test(String(recall.title || "")) || DEATH_MENTION.test(String(recall.hazard || "")))) severity = "high";
    return severity === "high" ? "High severity" : severity === "medium" ? "Medium severity" : severity === "low" ? "Low severity" : "Severity not stated";
  }
  function httpOnly(url) {
    var value = String(url === undefined || url === null ? "" : url).trim();
    return /^https?:\\/\\//i.test(value) ? value : "";
  }
  function field(name, value) {
    var p = document.createElement("p");
    p.className = "rr-field";
    p.appendChild(text("span", "rr-field-name", name));
    p.appendChild(text("span", "rr-field-value", value));
    return p;
  }
  function newestRecall(structured) {
    if (!structured || typeof structured !== "object") return null;
    if (structured.recall && typeof structured.recall === "object") return structured.recall;
    var list = Array.isArray(structured.recalls) ? structured.recalls.slice() : [];
    if (Array.isArray(structured.results)) {
      for (var i = 0; i < structured.results.length; i++) {
        if (Array.isArray(structured.results[i].recalls)) list = list.concat(structured.results[i].recalls);
      }
    }
    list.sort(function (a, b) { return String((b && b.date) || "").localeCompare(String((a && a.date) || "")); });
    return list[0] || null;
  }
  function render(recall) {
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!recall) { root.appendChild(text("p", "rr-empty", "No recall to show.")); return; }
    var card = document.createElement("article");
    card.className = "rr-card";
    var head = document.createElement("header");
    head.className = "rr-head";
    head.appendChild(text("span", "rr-source", sourceName(recall.source)));
    head.appendChild(text("span", "rr-severity", severityName(recall)));
    card.appendChild(head);
    card.appendChild(text("h2", "rr-title", stripListNumber(recall.title || "Recall")));
    card.appendChild(text("p", "rr-date", spokenDate(recall.date)));
    if (recall.hazard) card.appendChild(field("Hazard", recall.hazard));
    if (recall.remedy) card.appendChild(field("Remedy", recall.remedy));
    var href = httpOnly(recall.url);
    if (href) {
      var a = document.createElement("a");
      a.className = "rr-link";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "View the official recall";
      card.appendChild(a);
    }
    root.appendChild(card);
  }
  function markInitialized() {
    if (initialized) return;
    initialized = true;
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.id === initId && data.result) { markInitialized(); return; }
    if (data.method === "ui/notifications/tool-result") {
      render(newestRecall(data.params && data.params.structuredContent));
    }
  });
  window.parent.postMessage({ jsonrpc: "2.0", id: initId, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appCapabilities: {}, clientInfo: { name: "recall-radar-card", version: "1.0.0" } } }, "*");
})();
</script>
</body>
</html>`;
}

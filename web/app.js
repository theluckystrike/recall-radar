(function () {
  "use strict";

  var MCP_PROTOCOL_VERSION = "2025-11-25";
  var EXAMPLES = [
    "Is my 2018 Honda Accord recalled?",
    "Any recalls on my 2021 Ford F-150?",
    "Is the Graco pack and play recalled?",
    "Any recalls on peanut butter?",
    "Was my ibuprofen recalled?"
  ];
  var MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  var ringEl, transcriptEl, inputFormEl, textInputEl, micButtonEl,
    chipsEl, resultsEl, logEntriesEl;

  var sessionId = null;
  var initialized = false;
  var nextRequestId = 1;
  var ringState = "idle";
  var busy = false;
  var recognition = null;
  var listening = false;
  var voicesCache = [];

  function $(id) {
    return document.getElementById(id);
  }

  function setRing(state) {
    ringState = state;
    ringEl.classList.remove(
      "ring--idle", "ring--listening", "ring--speaking", "ring--thinking"
    );
    ringEl.classList.add("ring--" + state);
    ringEl.setAttribute("data-state", state);
  }

  function resetSpeakingRing() {
    if (ringState === "speaking") setRing("idle");
  }

  function setTranscript(text) {
    transcriptEl.textContent = text;
  }

  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    var voices = window.speechSynthesis.getVoices();
    if (voices.length) voicesCache = voices;
    else if (!voicesCache.length) return null;
    var en = voicesCache.filter(function (v) {
      return v.lang && v.lang.toLowerCase().indexOf("en") === 0;
    });
    var us = en.filter(function (v) {
      return v.lang.toLowerCase().indexOf("en-us") === 0;
    });
    return us[0] || en[0] || null;
  }

  function speak(text) {
    if (!("speechSynthesis" in window) || !text) return false;
    try {
      window.speechSynthesis.cancel();
      var utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      var voice = pickVoice();
      if (voice) utterance.voice = voice;
      utterance.onend = resetSpeakingRing;
      utterance.onerror = resetSpeakingRing;
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      return false;
    }
  }

  function addLog(method, ms) {
    var entry = document.createElement("div");
    entry.className = "log-entry";

    var name = document.createElement("span");
    name.className = "log-method";
    name.textContent = method;

    var time = document.createElement("span");
    time.className = "log-time";
    time.textContent = typeof ms === "number" ? ms + " ms" : "";

    entry.appendChild(name);
    entry.appendChild(time);
    logEntriesEl.appendChild(entry);
    logEntriesEl.scrollTop = logEntriesEl.scrollHeight;
  }

  function parseSse(text) {
    var messages = [];
    var blocks = String(text).split(/\r?\n\r?\n/);
    for (var i = 0; i < blocks.length; i++) {
      var dataLines = [];
      var lines = blocks[i].split(/\r?\n/);
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("data:") === 0) {
          dataLines.push(lines[j].slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length === 0) continue;
      var parsed = null;
      try {
        parsed = JSON.parse(dataLines.join("\n"));
      } catch (err) {
        parsed = null;
      }
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  function parseMcpResponse(bodyText, contentType, id) {
    if (contentType.indexOf("text/event-stream") !== -1) {
      var messages = parseSse(bodyText);
      for (var i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].id === id) return messages[i];
      }
      return messages.length ? messages[messages.length - 1] : null;
    }
    try {
      return JSON.parse(bodyText);
    } catch (err) {
      throw new Error("The MCP server returned a non-JSON response.");
    }
  }

  function mcpRequest(method, params, logLabel) {
    var started = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    var isNotification = method.indexOf("notifications/") === 0;
    var payload = { jsonrpc: "2.0", method: method };
    if (!isNotification) payload.id = nextRequestId++;
    if (params !== undefined) payload.params = params;

    var headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    return fetch("/mcp", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function (response) {
      var newSession = response.headers.get("Mcp-Session-Id");
      if (newSession) sessionId = newSession;
      var elapsed = Math.round((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - started);
      if (isNotification) {
        if (!response.ok && response.status !== 202) {
          throw new Error("MCP notification failed: HTTP " + response.status);
        }
        addLog(logLabel || method, elapsed);
        return null;
      }
      var contentType = response.headers.get("content-type") || "";
      return response.text().then(function (bodyText) {
        if (!response.ok) {
          throw new Error("MCP error: HTTP " + response.status);
        }
        var message = parseMcpResponse(bodyText, contentType, payload.id);
        addLog(logLabel || method, elapsed);
        if (message && message.error) {
          throw new Error(message.error.message || ("MCP error " + message.error.code));
        }
        return message ? message.result : null;
      });
    });
  }

  function ensureInitialized() {
    if (initialized) return Promise.resolve();
    return mcpRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "recall-radar-simulator", version: "1.0.0" }
    }, "initialize").then(function () {
      initialized = true;
      return mcpRequest("notifications/initialized", {}, "notifications/initialized");
    });
  }

  function routeText(utterance) {
    return fetch("/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ utterance: utterance, pending: pendingVehicle })
    }).then(function (response) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Router error: HTTP " + response.status);
      return response.json().then(function (data) {
        return data;
      }, function () {
        throw new Error("The router returned a non-JSON response.");
      });
    });
  }

  function callTool(tool, args) {
    return ensureInitialized().then(function () {
      return mcpRequest("tools/call", {
        name: tool,
        arguments: args || {}
      }, "tools/call " + tool);
    });
  }

  function isSearchResult(value) {
    return value && typeof value === "object" && Array.isArray(value.recalls);
  }

  function extractResults(structuredContent) {
    if (!structuredContent || typeof structuredContent !== "object") return [];
    if (Array.isArray(structuredContent.results)) {
      return structuredContent.results.filter(isSearchResult);
    }
    if (Array.isArray(structuredContent.recalls)) {
      return [structuredContent];
    }
    return [];
  }

  function extractText(result) {
    var content = result && result.content;
    if (!Array.isArray(content)) return "";
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var item = content[i];
      if (item && item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    return parts.join(" ").trim();
  }

  function sourceLabel(source) {
    switch (source) {
      case "nhtsa": return "NHTSA";
      case "cpsc": return "CPSC";
      case "fda-food": return "FDA Food";
      case "fda-drug": return "FDA Drug";
      default: return source || "Recall";
    }
  }

  function severityLabel(severity) {
    switch (severity) {
      case "high": return "High severity";
      case "medium": return "Medium";
      case "low": return "Low";
      default: return "";
    }
  }

  function formatDate(value) {
    if (typeof value !== "string") return "";
    var s = value.trim();
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      return formatParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    }
    var compact = s.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compact) {
      return formatParts(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    }
    return s;
  }

  function formatParts(year, month, day) {
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return "";
    }
    return MONTHS[month - 1] + " " + day + ", " + year;
  }

  function isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value.trim());
  }

  function textNode(text) {
    return document.createTextNode(text);
  }

  function fieldParagraph(label, text) {
    var p = document.createElement("p");
    p.className = "card-field";
    var strong = document.createElement("strong");
    strong.textContent = label;
    p.appendChild(strong);
    p.appendChild(textNode(text));
    return p;
  }

  function buildCard(recall) {
    var card = document.createElement("article");
    card.className = "card";

    var head = document.createElement("header");
    head.className = "card-head";

    var title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = recall.title || "Recall";

    var badge = document.createElement("span");
    badge.className = "card-badge card-badge--" + (recall.severity || "none");
    badge.textContent = severityLabel(recall.severity);

    head.appendChild(title);
    head.appendChild(badge);

    var meta = document.createElement("div");
    meta.className = "card-meta";
    var source = document.createElement("span");
    source.className = "card-source";
    source.textContent = sourceLabel(recall.source);
    var date = document.createElement("span");
    date.className = "card-date";
    date.textContent = formatDate(recall.date);
    meta.appendChild(source);
    meta.appendChild(date);

    card.appendChild(head);
    card.appendChild(meta);

    if (recall.hazard) card.appendChild(fieldParagraph("Hazard: ", recall.hazard));
    if (recall.remedy) card.appendChild(fieldParagraph("Remedy: ", recall.remedy));

    if (isHttpUrl(recall.url)) {
      var link = document.createElement("a");
      link.className = "card-link";
      link.href = recall.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "View official recall";
      card.appendChild(link);
    }

    return card;
  }

  function buildNotice(text) {
    var notice = document.createElement("p");
    notice.className = "empty-state";
    notice.textContent = text;
    return notice;
  }

  function renderCards(results) {
    resultsEl.textContent = "";
    var count = 0;
    for (var i = 0; i < results.length; i++) {
      var recalls = results[i].recalls || [];
      for (var j = 0; j < recalls.length; j++) {
        resultsEl.appendChild(buildCard(recalls[j]));
        count++;
      }
    }
    if (count === 0) {
      resultsEl.appendChild(buildNotice("No recalls found. Remember: no recall found is not a promise of safety."));
    }
  }

  // Conversation state for "more" and for a vehicle question that is missing its year or model.
  var followUps = [];
  var followIndex = 0;
  var pendingVehicle = null;

  function collectFollowUps(structured) {
    var list = [];
    if (structured && Array.isArray(structured.followUps)) list = structured.followUps.slice();
    if (structured && Array.isArray(structured.results)) {
      structured.results.forEach(function (r) { if (Array.isArray(r.followUps)) list = list.concat(r.followUps); });
    }
    return list.filter(function (x) { return typeof x === "string" && x; });
  }

  function say(text) {
    setTranscript(text);
    setRing("speaking");
    if (!speak(text)) setTimeout(resetSpeakingRing, 1500);
  }

  function readMore() {
    if (followIndex >= followUps.length) { say("There is nothing more to read for that question."); return; }
    var next = followUps.slice(followIndex, followIndex + 2);
    followIndex += next.length;
    var tail = followIndex < followUps.length ? " Say more for the next ones." : "";
    say(next.join(" ") + tail);
  }

  function titleCase(text) {
    return String(text || "").replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); });
  }

  function askVehicle(args) {
    pendingVehicle = { make: args.make, model: args.model };
    args = { make: titleCase(args.make), model: titleCase(args.model), missing: args.missing };
    say(args.missing === "model" ? "Which " + args.make + " model is it?" : "Which model year is your " + args.make + " " + args.model + "?");
  }

  /** Completes a pending vehicle question from the next answer, such as "2018" or "accord". */
  function completeVehicle(text) {
    if (!pendingVehicle) return null;
    var year = (text.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[0];
    var p = pendingVehicle;
    if (!p.model) {
      var model = text.replace(/\b(19[5-9]\d|20[0-4]\d)\b/, "").replace(/[^a-z0-9 \-]/gi, " ").trim().toLowerCase();
      if (!model) return null;
      p.model = model;
      if (!year) { askVehicle({ make: p.make, model: p.model, missing: "year" }); return "asked"; }
    }
    if (!year) return null;
    pendingVehicle = null;
    return { tool: "check_vehicle_recalls", args: { year: Number(year), make: p.make, model: p.model } };
  }

  function renderToolResult(result) {
    var text = extractText(result) || "No answer returned.";
    if (result && result.isError) {
      // An error is not a "no recalls" answer: say it plainly, show no cards, and forget the previous follow-ups.
      followUps = []; followIndex = 0;
      showError(text);
      speak(text);
      return;
    }
    followUps = collectFollowUps(result.structuredContent);
    followIndex = 0;
    setTranscript(text);
    renderCards(extractResults(result.structuredContent));
    setRing("speaking");
    if (!speak(text)) {
      setTimeout(resetSpeakingRing, 1500);
    }
  }

  function showError(message) {
    setTranscript(message);
    var notice = document.createElement("p");
    notice.className = "empty-state empty-state--error";
    notice.textContent = message;
    resultsEl.textContent = "";
    resultsEl.appendChild(notice);
    setRing("idle");
  }

  function handleUtterance(utterance) {
    var text = String(utterance || "").trim();
    if (!text) return Promise.resolve();
    setRing("thinking");
    setTranscript("");
    resultsEl.textContent = "";
    // The model sees any open vehicle question; whatever it decides, the open question ends here unless it asks again.
    return routeText(text).then(function (routeResult) {
      if (routeResult && routeResult.tool === "more") { readMore(); return null; }
      if (routeResult && routeResult.tool === "ask_vehicle") { askVehicle(routeResult.args); return null; }
      pendingVehicle = null;
      if (routeResult) addLog("route (" + (routeResult.by === "model" ? "language model" : "rules") + "): " + routeResult.tool);
      if (!routeResult) {
        var msg = "I couldn't work out what to check. Try a vehicle, a product, a food, or a medicine.";
        setTranscript(msg);
        setRing("speaking");
        if (!speak(msg)) setTimeout(resetSpeakingRing, 1500);
        return null;
      }
      return callTool(routeResult.tool, routeResult.args).then(function (result) {
        renderToolResult(result);
      });
    }).catch(function (err) {
      var message = err && err.message ? err.message : String(err);
      showError("Something went wrong: " + message);
      speak("Something went wrong: " + message);
    });
  }

  function submitUtterance(text) {
    if (busy) return;
    busy = true;
    handleUtterance(text).then(function () {
      busy = false;
    }, function () {
      busy = false;
    });
  }

  function buildChips() {
    for (var i = 0; i < EXAMPLES.length; i++) {
      (function (example) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = example;
        chip.setAttribute("aria-label", "Example: " + example);
        chip.addEventListener("click", function () {
          textInputEl.value = example;
          submitUtterance(example);
        });
        chipsEl.appendChild(chip);
      })(EXAMPLES[i]);
    }
  }

  function initSpeechRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micButtonEl.disabled = true;
      micButtonEl.setAttribute("aria-label", "Microphone unavailable in this browser");
      micButtonEl.title = "Voice input is not supported in this browser";
      return;
    }
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = function (event) {
      var result = event.results && event.results[0] && event.results[0][0];
      if (!result) return;
      var text = result.transcript || "";
      textInputEl.value = text;
      submitUtterance(text);
    };
    recognition.onerror = function (event) {
      if (event.error && event.error !== "aborted" && event.error !== "no-speech") {
        setTranscript("Voice input failed: " + event.error);
      }
    };
    recognition.onend = function () {
      listening = false;
      micButtonEl.setAttribute("aria-label", "Start listening");
      micButtonEl.classList.remove("icon-button--active");
      if (ringState === "listening") setRing("idle");
    };

    micButtonEl.addEventListener("click", function () {
      if (listening) {
        try { recognition.stop(); } catch (err) { listening = false; }
        return;
      }
      try {
        setRing("listening");
        recognition.start();
        listening = true;
        micButtonEl.setAttribute("aria-label", "Stop listening");
        micButtonEl.classList.add("icon-button--active");
      } catch (err) {
        listening = false;
        setRing("idle");
      }
    });
  }

  function init() {
    ringEl = $("ring");
    transcriptEl = $("transcript");
    inputFormEl = $("inputForm");
    textInputEl = $("textInput");
    micButtonEl = $("micButton");
    chipsEl = $("chips");
    resultsEl = $("results");
    logEntriesEl = $("logEntries");

    buildChips();
    initSpeechRecognition();

    inputFormEl.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = textInputEl.value.trim();
      if (!text) return;
      textInputEl.value = "";
      submitUtterance(text);
    });

    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = function () {
        voicesCache = window.speechSynthesis.getVoices();
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

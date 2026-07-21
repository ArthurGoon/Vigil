(() => {
  if (window.__vigilContentLoaded) {
    // allow reinjection after extension reload
    window.__vigilContentReset?.();
  }
  window.__vigilContentLoaded = true;

  const PEN_COLOR = "#e11d2e";
  const MIN_POINTS = 8;
  const MIN_PATH_LEN = 36;
  const PRICE_RE =
    /(?:r\$\s*)?\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s*%|\s*off)?|(?:r\$\s*)?\d+(?:[.,]\d{2})/i;

  let penActive = false;
  let drawing = false;
  let points = [];
  let canvas = null;
  let ctx = null;
  let toastEl = null;
  let highlightEl = null;
  let confirmBar = null;
  let pendingLocal = null;
  let highlightTimer = null;
  let messageListener = null;

  window.__vigilContentReset = () => {
    teardownCanvas();
    clearHighlight();
    hideConfirmBar();
    toastEl?.remove();
    toastEl = null;
    if (messageListener) {
      chrome.runtime.onMessage.removeListener(messageListener);
      messageListener = null;
    }
  };

  messageListener = (message, _sender, sendResponse) => {
    if (message?.type === "VIGIL_TOGGLE_PEN") {
      setPenActive(Boolean(message.active));
      sendResponse({ ok: true, active: penActive });
      return true;
    }
    if (message?.type === "VIGIL_PEN_STATUS") {
      sendResponse({ ok: true, active: penActive });
      return true;
    }
    if (message?.type === "VIGIL_CLEAR_HIGHLIGHT") {
      pendingLocal = null;
      clearHighlight();
      hideConfirmBar();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(messageListener);

  function setPenActive(on) {
    penActive = on;
    document.documentElement.classList.toggle("vigil-pen-on", on);
    if (on) {
      pendingLocal = null;
      clearHighlight();
      hideConfirmBar();
      ensureCanvas();
      showToast("Caneta vermelha — circule bem rente ao preço/texto/imagem");
    } else {
      teardownCanvas();
    }
  }

  function ensureCanvas() {
    if (canvas) {
      resizeCanvas();
      return;
    }
    canvas = document.createElement("canvas");
    canvas.className = "vigil-pen-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerUp, { passive: false });
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("scroll", onScrollWhilePen, true);
  }

  function teardownCanvas() {
    if (!canvas) return;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("resize", resizeCanvas);
    window.removeEventListener("scroll", onScrollWhilePen, true);
    canvas.remove();
    canvas = null;
    ctx = null;
    drawing = false;
    points = [];
  }

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    redrawStroke();
  }

  function onScrollWhilePen() {
    if (drawing || !highlightEl || !pendingLocal) return;
    const el = pendingLocal.element;
    if (el?.isConnected) {
      const box =
        computeHighlightRect(el, pendingLocal.textHits, pendingLocal.targetText) ||
        el.getBoundingClientRect();
      placeHighlight(box);
    }
  }

  function onPointerDown(e) {
    if (!penActive || e.button !== 0) return;
    e.preventDefault();
    drawing = true;
    points = [{ x: e.clientX, y: e.clientY }];
    canvas.setPointerCapture(e.pointerId);
    clearCanvas();
    hideConfirmBar();
    clearHighlight();
    pendingLocal = null;
  }

  function onPointerMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY };
    const last = points[points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
    points.push(p);
    redrawStroke();
  }

  function onPointerUp(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }

    const pathLen = pathLength(points);
    if (points.length < MIN_POINTS || pathLen < MIN_PATH_LEN) {
      clearCanvas();
      showToast("Circule com um traço maior, bem rente ao alvo");
      return;
    }

    // Hide canvas so hit-testing sees the real page
    canvas.style.visibility = "hidden";
    const hit = resolveTarget(points);
    canvas.style.visibility = "visible";
    clearCanvas();

    if (!hit) {
      showToast("Não achei bem o que você circulou — tente um traço mais rente");
      return;
    }

    const payload = buildPayload(hit);
    if (!payload.targetText || payload.targetText.length < 2 || /^[,.\-–—/%\sR$]+$/i.test(payload.targetText)) {
      showToast("Seleção incompleta — circule o texto/preço inteiro");
      return;
    }

    pendingLocal = { ...payload, element: hit.el, textHits: hit.textHits || [] };
    const box =
      hit.highlightRect ||
      computeHighlightRect(hit.el, hit.textHits, payload.targetText) ||
      hit.el.getBoundingClientRect();
    placeHighlight(box);
    showConfirmBar(payload);
    showToast(`Peguei: ${payload.targetText.slice(0, 48)}`);

    chrome.runtime.sendMessage({ type: "VIGIL_SELECTION", payload }, () => {
      setPenActive(false);
      // some sumir o vermelho sozinho depois da animação
      scheduleHighlightClear(2200);
    });
  }

  function scheduleHighlightClear(ms) {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      if (highlightEl) highlightEl.classList.add("vigil-fade-out");
      setTimeout(() => {
        clearHighlight();
        hideConfirmBar();
        pendingLocal = null;
      }, 320);
    }, ms);
  }

  function clearCanvas() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function redrawStroke() {
    if (!ctx || !canvas || points.length < 2) return;
    clearCanvas();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = PEN_COLOR;
    ctx.lineWidth = 3.2;
    ctx.shadowColor = "rgba(225, 29, 46, 0.45)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return len;
  }

  function pathBounds(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function isOverlay(el) {
    return Boolean(
      el?.classList?.contains("vigil-pen-canvas") ||
        el?.classList?.contains("vigil-highlight") ||
        el?.closest?.(".vigil-pen-canvas, .vigil-highlight, .vigil-confirm, .vigil-toast")
    );
  }

  function rectArea(r) {
    return Math.max(0, r.width) * Math.max(0, r.height);
  }

  function ownText(el) {
    let t = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) t += node.textContent || "";
    }
    return cleanText(t);
  }

  function visibleText(el) {
    return cleanText(el.innerText || el.textContent || "");
  }

  function cleanText(t) {
    return String(t || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPriceLike(text) {
    if (!text) return false;
    const t = cleanText(text);
    if (t.length > 48) return false;
    if (isFragmentText(t)) return false;
    if (/r\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?/i.test(t)) return true;
    if (/\d{1,3}(?:\.\d{3})+,\d{2}/.test(t)) return true;
    if (/^\d{1,6}[.,]\d{2}$/.test(t)) return true;
    if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) return true; // 1.234
    return false;
  }

  function isCompletePrice(text) {
    const t = cleanText(text);
    if (!t || t.length < 4 || t.length > 40) return false;
    if (isFragmentText(t)) return false;
    // R$ 365,90 | 365,90 | 1.234,56
    return (
      /r\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?/i.test(t) ||
      /^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(t) ||
      /^\d+[.,]\d{2}$/.test(t)
    );
  }

  function isFragmentText(text) {
    const t = cleanText(text);
    if (!t) return true;
    if (t.length === 1) return true;
    if (/^[,.\-–—/%\s]+$/.test(t)) return true;
    if (/^(r\$|us\$|€|£)$/i.test(t)) return true;
    if (/^(off|%|x)$/i.test(t)) return true;
    // lone cents separator leftovers
    if (/^,\d{2}$/.test(t) && t.length <= 3) return true;
    return false;
  }

  function isMoneyShell(el) {
    if (!(el instanceof Element)) return false;
    const cls = typeof el.className === "string" ? el.className : el.getAttribute?.("class") || "";
    if (/money-amount|andes-money|price-tag|ui-pdp-price|product-price|a-price/i.test(cls)) {
      return true;
    }
    if (el.getAttribute?.("itemprop") === "price") return true;
    return false;
  }

  function fontSizePx(el) {
    try {
      return parseFloat(getComputedStyle(el).fontSize) || 0;
    } catch {
      return 0;
    }
  }

  function isStruck(el) {
    try {
      const s = getComputedStyle(el);
      if ((s.textDecorationLine || "").includes("line-through")) return true;
      if (el.closest("s, del, strike")) return true;
      const cls = typeof el.className === "string" ? el.className : "";
      if (/strik|original|was-price|old-price|ui-pdp-price__original/i.test(cls)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function maxAllowedArea(stroke) {
    const viewport = window.innerWidth * window.innerHeight;
    const strokeArea = Math.max(400, stroke.w * stroke.h);
    // prices are small; allow a bit more for money-amount wrappers
    return Math.min(viewport * 0.06, strokeArea * 4.5, 90_000);
  }

  /** Climb from comma/"365"/"R$" up to the full money unit. */
  function expandToMeaningful(el, maxArea) {
    if (!(el instanceof Element)) return el;
    if (kindOf(el) === "image") return el;

    let cur = el;

    // Always leave pure fragments
    for (let i = 0; i < 8 && cur?.parentElement; i++) {
      const t = visibleText(cur);
      if (!isFragmentText(t) && (isCompletePrice(t) || !isPricePiece(cur))) break;
      if (isFragmentText(t) || isPricePiece(cur)) {
        cur = cur.parentElement;
        continue;
      }
      break;
    }

    // Prefer known money containers
    const shell =
      cur.closest?.(
        '[class*="money-amount"], [class*="andes-money"], [class*="price-tag"], [class*="ui-pdp-price"], [itemprop="price"]'
      ) || null;
    if (shell instanceof Element) {
      const a = rectArea(shell.getBoundingClientRect());
      const t = visibleText(shell);
      if (a <= maxArea && t.length <= 48 && (isCompletePrice(t) || isPriceLike(t))) {
        // If shell is a big block with many prices, pick best money child
        const bestChild = bestMoneyChild(shell, maxArea);
        return bestChild || shell;
      }
    }

    // Keep climbing while parent still looks like one price
    for (let i = 0; i < 6 && cur?.parentElement; i++) {
      const parent = cur.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      const pa = rectArea(parent.getBoundingClientRect());
      if (pa > maxArea) break;
      const pt = visibleText(parent);
      const ct = visibleText(cur);
      if (pt.length > 48) break;
      if (isCompletePrice(pt)) {
        cur = parent;
        break;
      }
      if (isPriceLike(pt) && pt.length <= ct.length + 12) {
        cur = parent;
        continue;
      }
      if (isFragmentText(ct) && !isFragmentText(pt)) {
        cur = parent;
        continue;
      }
      break;
    }

    // If still a fragment, refuse (caller may skip)
    return cur;
  }

  function isPricePiece(el) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (/money-amount__(fraction|cents|currency|separator)|andes-money|price-tag|a-price/i.test(cls)) {
      return true;
    }
    const t = visibleText(el);
    if (isFragmentText(t)) return true;
    if (/^\d{1,6}$/.test(t)) return true; // "365" alone
    return false;
  }

  function bestMoneyChild(root, maxArea) {
    const nodes = [
      root,
      ...root.querySelectorAll(
        '[class*="money-amount"], [class*="andes-money"], [class*="price-tag"], [itemprop="price"]'
      ),
    ];
    let best = null;
    let bestScore = -Infinity;
    for (const el of nodes) {
      if (!(el instanceof Element)) continue;
      const t = visibleText(el);
      if (!isCompletePrice(t) && !isPriceLike(t)) continue;
      if (t.length > 40) continue;
      const r = el.getBoundingClientRect();
      const a = rectArea(r);
      if (a < 8 || a > maxArea) continue;
      let score = fontSizePx(el) * 20;
      if (isCompletePrice(t)) score += 500;
      if (isStruck(el)) score -= 800;
      if (/install|parcel|cuota|12x|sem juros/i.test(t)) score -= 400;
      // prefer compact single-price nodes
      score += 8000 / Math.sqrt(a + 16);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function shrinkToPoint(startEl, x, y, maxArea) {
    // Find deepest element under point, then expand to meaningful price unit
    let deepest = startEl;
    const walk = (el, depth) => {
      if (depth > 14) return;
      for (const child of el.children) {
        if (!(child instanceof Element) || isOverlay(child)) continue;
        const r = child.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        deepest = child;
        walk(child, depth + 1);
      }
    };
    walk(startEl, 0);
    return expandToMeaningful(deepest, maxArea);
  }

  function elementAt(x, y, maxArea) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (!(el instanceof Element) || isOverlay(el)) continue;
      if (el === document.documentElement || el === document.body) continue;
      return shrinkToPoint(el, x, y, maxArea);
    }
    return null;
  }

  function refineInsideCircle(el, pts, maxArea) {
    // From seed, look for the best complete price inside the circle (not tiniest fragment)
    const root = expandToMeaningful(el, maxArea) || el;
    let searchRoot = root;
    // widen slightly to price block parent if needed
    if (root.parentElement && isMoneyShell(root.parentElement)) {
      const a = rectArea(root.parentElement.getBoundingClientRect());
      if (a <= maxArea * 1.2) searchRoot = root.parentElement;
    }

    const candidates = new Set();
    candidates.add(expandToMeaningful(root, maxArea));
    for (const node of searchRoot.querySelectorAll("*")) {
      if (!(node instanceof Element)) continue;
      const r = node.getBoundingClientRect();
      if (rectArea(r) > maxArea) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (!pointInPolygon(cx, cy, pts) && rectOverlapStroke(r, pts) < 0.35) continue;
      const text = visibleText(node);
      if (isCompletePrice(text) || isMoneyShell(node)) {
        candidates.add(expandToMeaningful(node, maxArea));
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (!c) continue;
      const s = scoreCandidate(c, pts, maxArea);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (!best) best = root;
    return {
      el: best,
      rect: best.getBoundingClientRect(),
      kind: kindOf(best),
      score: bestScore,
    };
  }

  function rectOverlapStroke(r, pts) {
    const b = pathBounds(pts);
    const x1 = Math.max(r.left, b.minX);
    const y1 = Math.max(r.top, b.minY);
    const x2 = Math.min(r.right, b.maxX);
    const y2 = Math.min(r.bottom, b.maxY);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const a = rectArea(r);
    return a ? inter / a : 0;
  }

  function scoreCandidate(el, pts, maxArea) {
    if (!(el instanceof Element) || isOverlay(el)) return -Infinity;
    const r = el.getBoundingClientRect();
    const a = rectArea(r);
    if (a < 8 || a > maxArea) return -Infinity;

    const text = visibleText(el);
    if (isFragmentText(text)) return -Infinity;
    if (text.length === 1) return -Infinity;

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const centerIn = pointInPolygon(cx, cy, pts);
    const overlap = rectOverlapStroke(r, pts);
    if (!centerIn && overlap < 0.2) return -Infinity;

    const kind = kindOf(el);
    const fs = fontSizePx(el);

    let score = 0;
    score += (centerIn ? 500 : 0) + overlap * 400;
    // Prefer readable price blocks, not microscopic fragments
    if (isCompletePrice(text)) score += 4000 + fs * 35;
    else if (isPriceLike(text)) score += 1200 + fs * 15;
    else if (kind === "image") score += 900;
    else if (text.length >= 2 && text.length <= 40) score += 200 + fs * 5;
    else score -= 300;

    if (isStruck(el)) score -= 1200;
    if (/^\d+x\b|parcel|sem juros|install/i.test(text)) score -= 600;
    if (text.length > 80) score -= 1000;
    if (text.length > 160) score -= 2000;

    // Mild preference for compact nodes, but NOT extreme (avoids ",")
    score += 3000 / Math.sqrt(a + 64);
    return score;
  }

  function kindOf(el) {
    if (el.tagName === "IMG" || el.closest?.("picture")) return "image";
    if (el.tagName === "VIDEO" || el.tagName === "SVG") return "media";
    return "text";
  }

  function rectCoverageInPolygon(r, pts) {
    const w = r.width;
    const h = r.height;
    if (w < 1 || h < 1) return 0;
    let inside = 0;
    let total = 0;
    const nx = Math.min(6, Math.max(2, Math.ceil(w / 12)));
    const ny = Math.min(6, Math.max(2, Math.ceil(h / 12)));
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const x = r.left + (w * ix) / nx;
        const y = r.top + (h * iy) / ny;
        total += 1;
        if (pointInPolygon(x, y, pts)) inside += 1;
      }
    }
    return total ? inside / total : 0;
  }

  function inflateBounds(b, pad) {
    return {
      minX: b.minX - pad,
      minY: b.minY - pad,
      maxX: b.maxX + pad,
      maxY: b.maxY + pad,
      w: b.w + pad * 2,
      h: b.h + pad * 2,
    };
  }

  function rectsIntersectBounds(r, b) {
    return !(r.right < b.minX || r.left > b.maxX || r.bottom < b.minY || r.top > b.maxY);
  }

  function lcaElements(elements) {
    if (!elements.length) return null;
    let path = [];
    for (let n = elements[0]; n; n = n.parentElement) path.push(n);
    for (let i = 1; i < elements.length; i++) {
      const set = new Set();
      for (let n = elements[i]; n; n = n.parentElement) set.add(n);
      path = path.filter((n) => set.has(n));
      if (!path.length) return null;
    }
    return path[0] || null;
  }

  /** Collect exact text/images that sit inside the drawn circle. */
  function harvestInside(pts, maxArea) {
    const b = inflateBounds(pathBounds(pts), 10);
    const textHits = [];
    const imageHits = [];

    // Images first
    for (const img of document.querySelectorAll("img")) {
      if (!(img instanceof Element) || isOverlay(img)) continue;
      const r = img.getBoundingClientRect();
      const a = rectArea(r);
      if (a < 80 || a > maxArea * 2) continue;
      if (!rectsIntersectBounds(r, b)) continue;
      const cov = rectCoverageInPolygon(r, pts);
      if (cov < 0.35) continue;
      imageHits.push({ el: img, rect: r, coverage: cov, area: a });
    }

    // Text nodes via Range client rects (precise)
    const startEl = document.elementFromPoint((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    let root = startEl?.closest?.("main, article, [role='main'], #root, #app, body") || document.body;
    if (!(root instanceof Element)) root = document.body;

    // Limit walk to nodes near bounds for performance
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.textContent || "";
        if (!t.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isOverlay(parent)) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let guard = 0;
    while (walker.nextNode() && guard++ < 8000) {
      const node = walker.currentNode;
      let range;
      try {
        range = document.createRange();
        range.selectNodeContents(node);
      } catch {
        continue;
      }
      const rects = [...range.getClientRects()];
      if (!rects.length) continue;

      let bestCov = 0;
      let bestRect = null;
      let coveredArea = 0;
      let totalArea = 0;
      for (const r of rects) {
        const a = rectArea(r);
        if (a < 1) continue;
        if (!rectsIntersectBounds(r, b)) continue;
        totalArea += a;
        const cov = rectCoverageInPolygon(r, pts);
        if (cov > 0.4) {
          coveredArea += a * cov;
          if (cov > bestCov) {
            bestCov = cov;
            bestRect = r;
          }
        }
      }
      if (!bestRect || bestCov < 0.4) continue;

      const raw = String(node.textContent || "");
      // If only part of a long text node is circled, still take the node text —
      // parent expansion will decide the unit. Prefer parent element's full line later.
      textHits.push({
        node,
        parent: node.parentElement,
        text: raw,
        rect: bestRect,
        coverage: bestCov,
        coveredRatio: totalArea ? coveredArea / totalArea : bestCov,
      });
    }

    // Also include nearby siblings on same line that almost touch the circle
    // (fixes R$ + 365 + , + 90 split across spans)
    const expanded = expandHarvestWithLineSiblings(textHits, pts, b);
    return { textHits: expanded, imageHits };
  }

  function expandHarvestWithLineSiblings(textHits, pts, b) {
    if (!textHits.length) return textHits;
    const out = [...textHits];
    const seen = new Set(textHits.map((h) => h.node));
    const parents = new Set(textHits.map((h) => h.parent).filter(Boolean));

    for (const parent of parents) {
      const lineY = textHits
        .filter((h) => h.parent === parent || parent.contains?.(h.parent))
        .map((h) => h.rect.top + h.rect.height / 2);
      if (!lineY.length) continue;
      const avgY = lineY.reduce((a, c) => a + c, 0) / lineY.length;

      for (const child of parent.querySelectorAll("*")) {
        if (!(child instanceof Element)) continue;
        for (const node of child.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || seen.has(node)) continue;
          const t = String(node.textContent || "");
          if (!t.trim()) continue;
          let range;
          try {
            range = document.createRange();
            range.selectNodeContents(node);
          } catch {
            continue;
          }
          const rects = [...range.getClientRects()];
          for (const r of rects) {
            if (!rectsIntersectBounds(r, inflateBounds(b, 18))) continue;
            const cy = r.top + r.height / 2;
            if (Math.abs(cy - avgY) > Math.max(14, r.height * 1.2)) continue;
            // near the circle horizontally
            const near =
              rectCoverageInPolygon(r, pts) > 0.15 ||
              (r.left < b.maxX + 20 && r.right > b.minX - 20);
            if (!near) continue;
            seen.add(node);
            out.push({
              node,
              parent: node.parentElement,
              text: t,
              rect: r,
              coverage: Math.max(0.5, rectCoverageInPolygon(r, pts)),
              coveredRatio: 1,
              glued: true,
            });
          }
        }
      }
    }
    return out;
  }

  function circledTextFromHits(textHits) {
    // Preserve visual order
    const sorted = [...textHits].sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > 6) return dy;
      return a.rect.left - b.rect.left;
    });
    let text = "";
    for (const h of sorted) {
      const piece = h.text.replace(/\s+/g, " ");
      if (!piece.trim()) continue;
      // avoid duplicating if already included
      if (text && text.includes(cleanText(piece)) && cleanText(piece).length > 8) continue;
      const needsSpace =
        text &&
        !/[\s([{/]$/.test(text) &&
        !/^[\s),.\];:!?%°]/.test(piece);
      text += (needsSpace ? " " : "") + piece.trim();
    }
    return cleanText(text);
  }

  function pickContainerForHits(textHits, pts, maxArea) {
    const parents = textHits.map((h) => h.parent).filter((el) => el instanceof Element);
    if (!parents.length) return null;

    let lca = lcaElements(parents);
    if (!lca) lca = parents[0];

    // Climb while parent still mostly matches circled content / stays compact
    const circled = circledTextFromHits(textHits);
    let best = expandToMeaningful(lca, maxArea) || lca;

    // Prefer ancestor that fully contains circled text and is still small
    let cur = best;
    for (let i = 0; i < 8 && cur; i++) {
      const t = visibleText(cur);
      const r = cur.getBoundingClientRect();
      const a = rectArea(r);
      if (a > maxArea) break;
      if (t.length > 280) break;
      const cov = rectCoverageInPolygon(r, pts);
      // good container: contains circled text, not huge extra, decent coverage
      if (circled && t.includes(circled.slice(0, Math.min(24, circled.length)))) {
        const extra = Math.max(0, t.length - circled.length);
        if (extra <= Math.max(24, circled.length * 0.5) || isCompletePrice(t) || isMoneyShell(cur)) {
          best = cur;
        }
      }
      // stop if coverage of parent drops a lot (too big vs circle)
      if (cov < 0.12 && a > pathBounds(pts).w * pathBounds(pts).h * 2) break;
      cur = cur.parentElement;
    }

    // If money shell nearby, snap to best money child
    const money = bestMoneyChild(best, maxArea);
    if (money) {
      const mt = visibleText(money);
      if (isCompletePrice(mt) || isPriceLike(mt)) {
        const mCov = rectCoverageInPolygon(money.getBoundingClientRect(), pts);
        if (mCov > 0.25) return money;
      }
    }

    // Among candidates (lca, best, money shells under lca), pick by IoU-ish score
    const candidates = new Set([best, lca, expandToMeaningful(lca, maxArea)]);
    for (const p of parents.slice(0, 20)) {
      candidates.add(expandToMeaningful(p, maxArea));
    }

    let winner = best;
    let winnerScore = -Infinity;
    for (const el of candidates) {
      if (!(el instanceof Element)) continue;
      const s = scoreHarvestContainer(el, circled, pts, maxArea);
      if (s > winnerScore) {
        winnerScore = s;
        winner = el;
      }
    }
    return winner;
  }

  function scoreHarvestContainer(el, circled, pts, maxArea) {
    const r = el.getBoundingClientRect();
    const a = rectArea(r);
    if (a < 8 || a > maxArea) return -Infinity;
    const t = visibleText(el);
    if (isFragmentText(t)) return -Infinity;
    const cov = rectCoverageInPolygon(r, pts);
    if (cov < 0.1) return -Infinity;

    let score = cov * 2000;
    score += 2500 / Math.sqrt(a + 64);

    if (circled) {
      if (t === circled) score += 3000;
      else if (t.includes(circled)) {
        score += 1800;
        const extra = t.length - circled.length;
        score -= Math.min(1500, extra * 8);
      } else if (circled.includes(t) && t.length >= 4) {
        score += 600; // container text is subset — partial
        score -= (circled.length - t.length) * 10;
      } else {
        // similarity: shared prefix/ratio
        const shared = longestOverlap(circled, t);
        score += shared * 15;
        score -= 400;
      }
    }

    if (isCompletePrice(t)) score += 2200 + fontSizePx(el) * 25;
    else if (isPriceLike(t)) score += 800;
    if (isStruck(el)) score -= 1000;
    if (t.length > 200) score -= 800;
    return score;
  }

  function longestOverlap(a, b) {
    const x = cleanText(a).toLowerCase();
    const y = cleanText(b).toLowerCase();
    if (!x || !y) return 0;
    if (x.includes(y)) return y.length;
    if (y.includes(x)) return x.length;
    let best = 0;
    for (let len = Math.min(x.length, y.length); len >= 3; len--) {
      for (let i = 0; i <= x.length - len; i++) {
        if (y.includes(x.slice(i, i + len))) return len;
      }
    }
    return best;
  }

  function resolveTarget(pts) {
    const b = pathBounds(pts);
    if (b.w < 6 || b.h < 6) return null;
    const maxArea = maxAllowedArea(b);

    const { textHits, imageHits } = harvestInside(pts, maxArea);
    const circled = circledTextFromHits(textHits);

    // Prefer image if circle is mostly on an image and little text
    const bestImg = [...imageHits].sort((a, b) => b.coverage * b.area - a.coverage * a.area)[0];
    const textLen = cleanText(circled).length;
    if (bestImg && bestImg.coverage > 0.45 && textLen < 8) {
      return {
        el: bestImg.el,
        rect: bestImg.rect,
        highlightRect: copyRect(bestImg.rect),
        kind: "image",
        score: bestImg.coverage * 1000,
        circledText: "",
        textHits: [],
      };
    }

    if (textHits.length) {
      let container = pickContainerForHits(textHits, pts, maxArea);
      if (container) {
        container = expandToMeaningful(container, maxArea) || container;
        // If circled text is a complete price fragment assembly, snap money shell
        const assembled = cleanText(circled);
        if (isCompletePrice(assembled) || isPriceLike(assembled)) {
          const money = bestMoneyChild(container, maxArea) || expandToMeaningful(container, maxArea);
          if (money && (isCompletePrice(visibleText(money)) || isPriceLike(visibleText(money)))) {
            container = money;
          }
        }

        const finalText = preferFullText(assembled, visibleText(container));
        const highlightRect = computeHighlightRect(container, textHits, finalText);
        return {
          el: container,
          rect: highlightRect || container.getBoundingClientRect(),
          highlightRect,
          kind: kindOf(container),
          score: scoreHarvestContainer(container, finalText, pts, maxArea),
          circledText: finalText,
          textHits,
        };
      }
    }

    // Fallback: previous sampling approach (sparse)
    return resolveTargetFallback(pts, maxArea);
  }

  function preferFullText(circled, containerText) {
    const c = cleanText(circled);
    const t = cleanText(containerText);
    if (!c) return t.slice(0, 2000);
    if (!t) return c.slice(0, 2000);
    if (isFragmentText(c) && !isFragmentText(t)) return t.slice(0, 2000);
    // If container is basically the circled phrase (+ small extras), use container
    if (t.includes(c) && t.length <= Math.max(c.length + 30, c.length * 1.35)) return t.slice(0, 2000);
    // If circled already complete price, keep it
    if (isCompletePrice(c)) return c;
    // If container is complete price and circled is partial pieces of it
    if (isCompletePrice(t) && t.replace(/\s/g, "").includes(c.replace(/\s/g, ""))) return t;
    // If circled is clearly longer meaningful selection, keep circled
    if (c.length >= 8 && c.length >= t.length * 0.6) return c.slice(0, 2000);
    if (t.length <= 120 && longestOverlap(c, t) >= Math.min(c.length, 10)) return t.slice(0, 2000);
    return c.slice(0, 2000);
  }

  function resolveTargetFallback(pts, maxArea) {
    const b = pathBounds(pts);
    const samples = [];
    const step = Math.max(6, Math.min(16, Math.floor(Math.min(b.w, b.h) / 8) || 8));
    for (let y = b.minY; y <= b.maxY; y += step) {
      for (let x = b.minX; x <= b.maxX; x += step) {
        if (pointInPolygon(x, y, pts)) samples.push({ x, y });
      }
    }
    samples.push({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

    const tallies = new Map();
    for (const s of samples) {
      const el = elementAt(s.x, s.y, maxArea);
      if (!el) continue;
      const refined = refineInsideCircle(el, pts, maxArea);
      if (!refined || refined.score === -Infinity) continue;
      if (isFragmentText(visibleText(refined.el))) continue;
      const key = refined.el;
      const prev = tallies.get(key) || { ...refined, hits: 0 };
      prev.hits += 1;
      prev.score = Math.max(prev.score, refined.score);
      tallies.set(key, prev);
    }

    let best = null;
    for (const c of tallies.values()) {
      const finalScore = c.score + c.hits * 40;
      if (!best || finalScore > best.finalScore) {
        best = {
          ...c,
          finalScore,
          rect: c.el.getBoundingClientRect(),
          kind: kindOf(c.el),
          circledText: visibleText(c.el),
        };
      }
    }
    return best;
  }

  function buildPayload(hit) {
    const el = hit.el;
    const kind = hit.kind;
    let targetText = "";
    let label = "";

    if (kind === "image" || el.tagName === "IMG") {
      const img = el.tagName === "IMG" ? el : el.querySelector("img") || el;
      const alt = cleanText(img.getAttribute?.("alt") || "");
      const src = img.currentSrc || img.src || "";
      targetText = alt || `IMG:${shortUrl(src)}`;
      label = alt ? `Imagem: ${alt}` : `Imagem (${shortUrl(src)})`;
    } else {
      const unit = expandToMeaningful(el, 90_000) || el;
      hit.el = unit;
      const assembled = cleanText(hit.circledText || "");
      const all = visibleText(unit);
      targetText = preferFullText(assembled, all);
      if (isFragmentText(targetText) && !isFragmentText(all)) targetText = all;
      if (isCompletePrice(all) && !isCompletePrice(targetText)) {
        const m = all.match(
          /r\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2}/i
        );
        if (m) targetText = cleanText(m[0]);
      }
      label = targetText;
    }

    return {
      url: location.href,
      title: document.title || "",
      targetText: cleanText(targetText).slice(0, 2000),
      cssSelector: cssPath(hit.el),
      kind,
      label: cleanText(label).slice(0, 200),
      capturedAt: new Date().toISOString(),
    };
  }

  function findShortChildText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let best = "";
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!(n instanceof Element) || n.children.length > 0) continue;
      const t = cleanText(n.textContent || "");
      if (t.length >= 1 && t.length <= 40) {
        if (isPriceLike(t)) return t;
        if (t.length > best.length) best = t;
      }
    }
    return best;
  }

  function shortUrl(src) {
    try {
      const u = new URL(src, location.href);
      return (u.pathname.split("/").filter(Boolean).pop() || u.hostname).slice(0, 80);
    } catch {
      return String(src).slice(0, 80);
    }
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList?.length) {
        const cls = [...cur.classList]
          .filter((c) => c && !c.startsWith("vigil-"))
          .slice(0, 2)
          .map((c) => CSS.escape(c))
          .join(".");
        if (cls) part += `.${cls}`;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      if (cur?.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
    }
    return parts.join(" > ");
  }

  function copyRect(r) {
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      x: r.x ?? r.left,
      y: r.y ?? r.top,
    };
  }

  function unionRects(rects) {
    const list = (rects || []).filter((r) => r && r.width > 0 && r.height > 0);
    if (!list.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of list) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      x: left,
      y: top,
    };
  }

  /** Caixa visual = união de todos os pedaços de texto/imagem selecionados. */
  function computeHighlightRect(el, textHits, targetText) {
    const rects = [];

    if (textHits?.length) {
      for (const h of textHits) {
        if (h.rect) rects.push(h.rect);
      }
    }

    if (el instanceof Element) {
      // Rects reais do texto dentro do elemento (melhor que getBoundingClientRect em layouts quebrados)
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        for (const r of range.getClientRects()) {
          if (r.width > 1 && r.height > 1) rects.push(r);
        }
      } catch {
        /* ignore */
      }

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = 0;
      while (walker.nextNode() && n++ < 200) {
        const node = walker.currentNode;
        const raw = String(node.textContent || "");
        if (!raw.trim()) continue;
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) {
            if (r.width > 0 && r.height > 0) rects.push(r);
          }
        } catch {
          /* ignore */
        }
      }

      const br = el.getBoundingClientRect();
      if (br.width > 1 && br.height > 1) rects.push(br);

      // Se o targetText for maior que o texto do el, sobe um pouco e pega rects do pai
      const tip = cleanText(targetText || "");
      const own = visibleText(el);
      if (tip && own && tip.length > own.length + 2 && el.parentElement) {
        let parent = el.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const pt = visibleText(parent);
          if (pt && (pt.includes(tip.slice(0, Math.min(20, tip.length))) || tip.includes(pt.slice(0, 20)))) {
            try {
              const range = document.createRange();
              range.selectNodeContents(parent);
              for (const r of range.getClientRects()) {
                if (r.width > 1 && r.height > 1) rects.push(r);
              }
            } catch {
              /* ignore */
            }
            rects.push(parent.getBoundingClientRect());
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    const united = unionRects(rects);
    if (!united) return null;

    // Evita caixa gigante: se união ficou absurda vs hits, usa só os hits
    if (textHits?.length) {
      const hitsOnly = unionRects(textHits.map((h) => h.rect));
      if (hitsOnly) {
        const hitsArea = hitsOnly.width * hitsOnly.height;
        const unionArea = united.width * united.height;
        if (hitsArea > 40 && unionArea > hitsArea * 8) return hitsOnly;
        // Prefer the larger of hits vs element text rects when both are reasonable
        if (hitsOnly.width >= united.width * 0.85 && hitsOnly.height >= united.height * 0.85) {
          return unionRects([united, hitsOnly]);
        }
        return unionRects([united, hitsOnly]);
      }
    }
    return united;
  }

  function placeHighlight(rect) {
    clearHighlight(false);
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    highlightEl = document.createElement("div");
    highlightEl.className = "vigil-highlight";
    highlightEl.innerHTML = `<div class="vigil-highlight-ring"></div><div class="vigil-highlight-glow"></div>`;
    document.documentElement.appendChild(highlightEl);
    const pad = 5;
    Object.assign(highlightEl.style, {
      left: `${Math.max(0, rect.left - pad)}px`,
      top: `${Math.max(0, rect.top - pad)}px`,
      width: `${Math.max(10, rect.width + pad * 2)}px`,
      height: `${Math.max(10, rect.height + pad * 2)}px`,
    });
  }

  function clearHighlight(cancelTimer = true) {
    if (cancelTimer) clearTimeout(highlightTimer);
    highlightEl?.remove();
    highlightEl = null;
  }

  function showConfirmBar(payload) {
    hideConfirmBar();
    confirmBar = document.createElement("div");
    confirmBar.className = "vigil-confirm";
    confirmBar.innerHTML = `
      <div class="vigil-confirm-inner">
        <div class="vigil-confirm-label">${escapeHtml(payload.label || payload.targetText)}</div>
        <div class="vigil-confirm-meta">${payload.kind === "image" ? "Imagem" : "Texto"} · confirme no painel Vigil</div>
      </div>
    `;
    document.documentElement.appendChild(confirmBar);
    requestAnimationFrame(() => confirmBar.classList.add("show"));
  }

  function hideConfirmBar() {
    confirmBar?.remove();
    confirmBar = null;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "vigil-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl?.classList.remove("show"), 2600);
  }
})();

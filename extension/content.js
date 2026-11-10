// Vigil pen: injected on demand (toolbar, Alt+Shift+V or context menu).
// The user circles part of the page; we work out which element they meant,
// ask the local server whether it can see the same thing, and save the watch.
(() => {
  const previous = window.__vigilPen;
  if (previous) {
    if (previous.alive()) return;
    previous.destroy(); // left behind by an extension reload
  }

  const MODES = {
    text_changed: { label: "mudar", hint: "Compara o trecho a cada checagem e mostra o que mudou." },
    text_appears: { label: "aparecer", hint: "Procura o texto na página inteira e avisa quando ele aparecer." },
    text_disappears: { label: "sumir", hint: "Procura o texto na página inteira e avisa quando ele sumir." },
  };
  const INTERVALS = [
    [5, "5 min"],
    [15, "15 min"],
    [30, "30 min"],
    [60, "1 hora"],
    [360, "6 horas"],
    [1440, "1 dia"],
  ];
  const TAG_NAMES = {
    P: "parágrafo", LI: "item de lista", UL: "lista", OL: "lista", DL: "lista", TABLE: "tabela", TR: "linha da tabela",
    TD: "célula", TH: "célula", H1: "título", H2: "título", H3: "título", H4: "título", H5: "título", H6: "título",
    A: "link", BUTTON: "botão", IMG: "imagem", PICTURE: "imagem", SPAN: "texto", B: "texto", STRONG: "texto",
    EM: "texto", SMALL: "texto", LABEL: "texto", TIME: "data", ARTICLE: "bloco", SECTION: "seção", ASIDE: "bloco",
    MAIN: "conteúdo principal", HEADER: "cabeçalho", FOOTER: "rodapé", NAV: "menu", FORM: "formulário",
    FIGURE: "figura", BLOCKQUOTE: "citação", PRE: "bloco de código", CODE: "código",
  };

  // State

  let host = null;
  let root = null;
  let ui = {};
  let penOn = false;
  let drawing = false;
  let points = [];
  let target = null; // { el, captured, original, history: [] }
  let mode = "text_changed";
  let interval = 60;
  let probeState = { status: "idle" };
  let probeSeq = 0;
  let saving = false;
  let followRaf = 0;

  // Small helpers

  const clean = (s) => String(s || "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  const squash = (s) => clean(s).toLowerCase().replace(/\s+/g, "");
  const textOf = (el) => clean(el.innerText ?? el.textContent ?? "");
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, offline: true, error: "Extensão recarregada. Recarregue a página." });
          else resolve(res || { ok: false, error: "Sem resposta" });
        });
      } catch {
        resolve({ ok: false, error: "Extensão recarregada. Recarregue a página." });
      }
    });
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  };

  // Geometry

  function bounds(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX, height: maxY - minY };
  }

  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y + 1e-9) + a.x) inside = !inside;
    }
    return inside;
  }

  const intersects = (r, b) => r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom;

  /** Share of a rect inside the stroke, sampled on a 4x3 grid. */
  function coverage(r, poly) {
    let hit = 0, total = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        total++;
        if (inPoly(r.left + (r.width * (i + 0.5)) / 4, r.top + (r.height * (j + 0.5)) / 3, poly)) hit++;
      }
    }
    return hit / total;
  }

  /**
   * A loop is used as drawn. An open stroke (an underline, a slash, a loop
   * that did not close) becomes its bounding box, slightly padded.
   */
  function shapeOf(pts) {
    const b = bounds(pts);
    const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
    const closed = gap < Math.max(48, Math.hypot(b.width, b.height) * 0.45) && b.width > 14 && b.height > 10;
    if (closed) return { poly: pts, box: b };
    const pad = 8;
    const box = { left: b.left - pad, top: b.top - pad, right: b.right + pad, bottom: b.bottom + pad };
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    const poly = [
      { x: box.left, y: box.top }, { x: box.right, y: box.top },
      { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom },
    ];
    return { poly, box };
  }

  // Target detection

  function isOurs(node) {
    return host && (node === host || host.contains(node));
  }

  function isHidden(el) {
    const s = getComputedStyle(el);
    return s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0;
  }

  /** Text pieces (whole nodes or runs of words) whose boxes fall inside the stroke, in document order. */
  function textHits(shape) {
    const { poly, box } = shape;
    const hits = [];
    const parentHit = new Map();
    const range = document.createRange();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isOurs(parent)) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|OPTION)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        let near = parentHit.get(parent);
        if (near === undefined) {
          const r = parent.getBoundingClientRect();
          // Parents can be smaller than their text (overflow), so compare loosely.
          near = r.width === 0 && r.height === 0 ? true : intersects(r, { left: box.left - 400, right: box.right + 400, top: box.top - 200, bottom: box.bottom + 200 });
          parentHit.set(parent, near);
        }
        return near ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.some((r) => intersects(r, box))) continue;
      if (isHidden(node.parentElement)) continue;
      if (rects.every((r) => coverage(r, poly) >= 0.5)) {
        hits.push({ node, start: 0, end: node.data.length });
        continue;
      }
      // Partly inside: keep the run of words whose centers are inside. A loop
      // drawn by hand cuts corners, so a node that is mostly inside counts whole.
      const re = /\S+/g;
      let m, start = -1, end = -1, inside = 0, total = 0;
      while ((m = re.exec(node.data))) {
        total++;
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (r.width && inPoly(r.left + r.width / 2, r.top + r.height / 2, poly)) {
          inside++;
          if (start < 0) start = m.index;
          end = m.index + m[0].length;
        }
      }
      if (start < 0) continue;
      if (inside / total >= 0.6) hits.push({ node, start: 0, end: node.data.length });
      else hits.push({ node, start, end });
    }
    range.detach?.();
    return hits;
  }

  function mediaHits(shape) {
    const out = [];
    for (const el of document.querySelectorAll("img, svg, video, canvas, picture")) {
      if (isOurs(el) || el.parentElement?.closest("svg")) continue;
      const r = el.getBoundingClientRect();
      if (area(r) < 120 || !intersects(r, shape.box)) continue;
      if (coverage(r, shape.poly) >= 0.5) out.push(el);
    }
    return out;
  }

  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    const chain = [];
    for (let n = nodes[0]; n; n = n.parentNode) chain.push(n);
    let best = 0;
    for (const node of nodes.slice(1)) {
      let n = node;
      while (n && !chain.includes(n)) n = n.parentNode;
      best = Math.max(best, chain.indexOf(n));
    }
    let lca = chain[best];
    if (lca && lca.nodeType !== 1) lca = lca.parentElement;
    return lca;
  }

  /**
   * Wrappers that add (almost) nothing to the text are the same target; a
   * fragment like "365" inside "R$ 365,90" is not. Climb while the parent's
   * text is essentially ours and it is not much bigger on screen.
   */
  function settle(el, shape) {
    const strokeArea = Math.max(area(shape.box), 400);
    while (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) {
      const parent = el.parentElement;
      const ct = squash(textOf(el)).length;
      const pt = squash(textOf(parent)).length;
      const nearlySame = pt <= ct * 1.15 + 2;
      const smallFragment = ct < 24 && pt <= ct + 12;
      const pr = parent.getBoundingClientRect();
      const fits = area(pr) <= Math.max(area(el.getBoundingClientRect()) * 3, strokeArea * 3);
      if ((nearlySame || smallFragment) && fits) el = parent;
      else break;
    }
    return el;
  }

  function capturedFrom(hits) {
    return clean(hits.map((x) => x.node.data.slice(x.start, x.end)).join(" "));
  }

  function mediaText(el) {
    const img = el.matches("img") ? el : el.querySelector("img");
    return clean(img?.alt || el.getAttribute("aria-label") || el.getAttribute("title") || "");
  }

  function resolve(pts) {
    const shape = shapeOf(pts);
    const hits = textHits(shape);
    const media = hits.length ? [] : mediaHits(shape);
    let el = commonAncestor([...hits.map((x) => x.node), ...media]);
    let captured = hits.length ? capturedFrom(hits) : media.length ? mediaText(el || media[0]) : "";

    if (!el) {
      const cx = shape.box.left + shape.box.width / 2;
      const cy = shape.box.top + shape.box.height / 2;
      const under = document.elementsFromPoint(cx, cy).find((x) => !isOurs(x));
      if (!under || under === document.body || under === document.documentElement) return null;
      el = under;
      captured = textOf(el).slice(0, 300) || mediaText(el);
    }
    if (el === document.body || el === document.documentElement) return null;
    el = settle(el, shape);
    // Circled most of the element: take its whole text, in the order the page shows it.
    const full = textOf(el);
    if (full && squash(captured).length >= squash(full).length * 0.5) captured = full.slice(0, 600);
    if (!captured) captured = full.slice(0, 300) || mediaText(el);
    if (!captured || squash(captured).length < 2) return null;
    return { el, captured, original: el, history: [] };
  }

  // Selectors

  const STATE_CLASS = /^(active|selected|current|open|opened|closed|show|shown|hidden|visible|hover|focus|focused|disabled|loading|loaded|expanded|collapsed|is-.*|has-.*)$/i;

  function stableToken(s) {
    if (!s || s.length > 40) return false;
    if (/^\d/.test(s) || s.startsWith(":")) return false;
    if (/\d{4,}/.test(s)) return false;
    if (/^(css|sc|jsx|svelte|emotion|chakra|mui|tw|styled)-/i.test(s)) return false;
    if (/[_-][a-z0-9]{5,}$/i.test(s) && /\d/.test(s.slice(-6)) ) return false; // CSS modules hash: button_x3k2a
    if (!/-|_/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return false; // aB3dE
    if (!/-|_/.test(s) && s.length <= 6 && /[a-z][A-Z]/.test(s)) return false; // generated short ids: mwAg (Wikipedia)
    return /^[a-zA-Z_][\w-]*$/.test(s);
  }

  const esc = (s) => CSS.escape(s);
  const attrValue = (v) => `"${v.replace(/["\\]/g, "\\$&")}"`;

  function uniqueFor(sel, el, scope = document) {
    try {
      const found = scope.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  }

  function goodClasses(el) {
    return [...el.classList].filter((c) => stableToken(c) && !STATE_CLASS.test(c)).slice(0, 3);
  }

  /** The strongest way to name this one element on its own, or null. */
  function anchorOf(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && stableToken(el.id)) {
      const sel = `#${esc(el.id)}`;
      if (uniqueFor(sel, el)) return sel;
    }
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy", "itemprop", "data-id", "name", "aria-label"]) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 60 || /\d{5,}/.test(v)) continue;
      const sel = `${tag}[${attr}=${attrValue(v)}]`;
      if (uniqueFor(sel, el)) return sel;
    }
    const classes = goodClasses(el);
    if (classes.length) {
      const sel = `${tag}${classes.map((c) => `.${esc(c)}`).join("")}`;
      if (uniqueFor(sel, el)) return sel;
    }
    return null;
  }

  function stepOf(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    const classes = goodClasses(el).slice(0, 2);
    const base = `${tag}${classes.map((c) => `.${esc(c)}`).join("")}`;
    if (!parent) return base;
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    if (same.length === 1) return tag;
    const sameBase = [...parent.children].filter((c) => {
      try {
        return c.matches(base);
      } catch {
        return false;
      }
    });
    if (classes.length && sameBase.length === 1) return base;
    return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
  }

  /** Path of child steps from the closest ancestor that has an anchor (or body). */
  function anchoredPath(el, maxDepth = 12) {
    const steps = [];
    let cur = el;
    for (let depth = 0; cur && depth < maxDepth; depth++) {
      if (cur === document.body) return ["body", ...steps].join(" > ");
      const anchor = depth > 0 ? anchorOf(cur) : null;
      if (anchor) return [anchor, ...steps].join(" > ");
      steps.unshift(stepOf(cur));
      cur = cur.parentElement;
    }
    return null;
  }

  /** Full nth-of-type path from body: works on the live page, breaks first when the layout changes. */
  function fullPath(el) {
    const steps = [];
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      const parent = cur.parentElement;
      if (!parent) return null;
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      const tag = cur.tagName.toLowerCase();
      steps.unshift(same.length === 1 ? tag : `${tag}:nth-of-type(${same.indexOf(cur) + 1})`);
    }
    return ["body", ...steps].join(" > ");
  }

  /** Candidates from most to least robust; the server keeps the first one that works on its copy of the page. */
  function selectorsFor(el) {
    const out = [];
    const add = (sel) => {
      if (sel && !out.includes(sel) && uniqueFor(sel, el)) out.push(sel);
    };
    add(anchorOf(el));
    add(anchoredPath(el));
    add(fullPath(el));
    return out.slice(0, 5);
  }

  // Scope (maior / menor)

  function biggerOf(el) {
    const p = el.parentElement;
    if (!p || p === document.body || p === document.documentElement) return null;
    // Skip wrappers that look exactly the same.
    let cur = p;
    while (cur.parentElement && cur.parentElement !== document.body && squash(textOf(cur.parentElement)) === squash(textOf(cur)) && area(cur.parentElement.getBoundingClientRect()) <= area(cur.getBoundingClientRect()) * 1.05) {
      cur = cur.parentElement;
    }
    return squash(textOf(cur)) === squash(textOf(el)) ? cur : p;
  }

  function smallerOf(el, captured) {
    const want = squash(captured);
    const kids = [...el.children].filter((c) => !isOurs(c) && squash(textOf(c)).length >= 2 && area(c.getBoundingClientRect()) > 0);
    if (!kids.length) return null;
    // The child that holds what was circled, else the one with most text.
    const holding = kids.find((c) => want && squash(textOf(c)).includes(want.slice(0, 40)));
    let pick = holding || kids.sort((a, b) => textOf(b).length - textOf(a).length)[0];
    // Skip wrappers with the same text, so "menor" always changes something.
    while (pick && squash(textOf(pick)) === squash(textOf(el))) {
      const inner = [...pick.children].filter((c) => squash(textOf(c)).length >= 2);
      if (!inner.length) return null;
      pick = inner.find((c) => want && squash(textOf(c)).includes(want.slice(0, 40))) || inner[0];
    }
    return pick || null;
  }

  // UI

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font-family: "Vigil Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --bg: #ffffff; --bg-2: #f6f5f2; --bg-3: #efede8; --line: #e7e4dd; --line-2: #d9d5cc;
      --text: #18191b; --text-2: #5c5e63; --text-3: #8d8f94;
      --red: #c6382c; --red-ink: #b8261c; --red-soft: #fdeceb;
      --ok: #16794a; --ok-soft: #e6f4ec; --warn: #9a5b06; --warn-soft: #fcf1df;
      --shadow: 0 1px 2px rgba(20,20,20,.06), 0 12px 32px -8px rgba(20,20,20,.22), 0 0 0 1px rgba(20,20,20,.06);
      color: var(--text); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
    @media (prefers-color-scheme: dark) {
      .layer { --bg: #1c1c1f; --bg-2: #242428; --bg-3: #2c2c31; --line: #313136; --line-2: #3d3d43;
        --text: #ededef; --text-2: #a7a7ad; --text-3: #7c7c83; --red: #ff5b4f; --red-ink: #ff8a80; --red-soft: #3a1f1d;
        --ok: #4cc38a; --ok-soft: #17301f; --warn: #f0b155; --warn-soft: #33270f;
        --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px -8px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.07); }
    }
    canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: auto; touch-action: none;
      cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath d='M4 24l3.5-1 14-14-2.5-2.5-14 14z' fill='%23e5372b' stroke='white' stroke-width='1.5' stroke-linejoin='round'/%3E%3Cpath d='M19 6.5l2.5 2.5 2-2a1.77 1.77 0 0 0-2.5-2.5z' fill='%2318191b' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") 3 25, crosshair; }
    .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 8px 8px 8px 14px; border-radius: 999px; background: #18191b; color: #fff; font-size: 13px; font-weight: 500;
      box-shadow: 0 8px 24px -6px rgba(0,0,0,.35); pointer-events: auto; animation: drop .18s ease-out; white-space: nowrap; }
    .hint .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); box-shadow: 0 0 0 3px rgba(229,55,43,.25); }
    .hint button { all: unset; cursor: pointer; font-size: 12px; color: #d4d4d8; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.1); }
    .hint button:hover { background: rgba(255,255,255,.18); color: #fff; }
    .hint.warn { background: var(--red-ink); }
    .hl { position: fixed; border-radius: 6px; border: 2px solid var(--red); background: rgba(229,55,43,.07);
      box-shadow: 0 0 0 4px rgba(229,55,43,.14); transition: all .16s ease; }
    .hl.saved { border-color: var(--ok); background: rgba(22,121,74,.08); box-shadow: 0 0 0 4px rgba(22,121,74,.16); }
    .hl .tag { position: absolute; top: -24px; left: -2px; background: var(--red); color: #fff; font-size: 11px; font-weight: 600;
      padding: 3px 8px; border-radius: 6px 6px 6px 0; white-space: nowrap; }
    .hl.saved .tag { background: var(--ok); }
    .hl.below .tag { top: auto; bottom: -24px; border-radius: 0 6px 6px 6px; }
    .card { position: fixed; top: 16px; right: 16px; width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; pointer-events: auto;
      background: var(--bg); border-radius: 18px; box-shadow: var(--shadow); animation: pop .2s cubic-bezier(.2,.9,.3,1.2); }
    @media (max-width: 720px) { .card { top: auto; bottom: 12px; left: 12px !important; right: 12px !important; width: auto; } }
    :focus-visible { outline: 3px solid var(--red); outline-offset: 3px; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    .head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 0 16px; }
    .head .title { font-weight: 650; font-size: 14px; letter-spacing: -.01em; flex: 1; }
    .icon-btn { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--text-3); }
    .icon-btn:hover { background: var(--bg-3); color: var(--text); }
    .body { padding: 12px 16px 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .preview { background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    .preview .text { font-size: 13px; color: var(--text); max-height: 7.4em; overflow: hidden; position: relative; word-break: break-word;
      -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
    .preview .text.short { -webkit-mask-image: none; mask-image: none; }
    .preview mark { background: rgba(229,55,43,.16); color: inherit; border-radius: 3px; padding: 0 1px; }
    .scope { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    .scope .what { flex: 1; color: var(--text-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip-btn { all: unset; cursor: pointer; font-size: 12px; font-weight: 550; color: var(--text-2); padding: 3px 9px; border-radius: 7px;
      border: 1px solid var(--line-2); background: var(--bg); display: inline-flex; align-items: center; gap: 4px; }
    .chip-btn:hover:not([disabled]) { color: var(--text); border-color: var(--text-3); }
    .chip-btn[disabled] { opacity: .4; cursor: default; }
    .status { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; color: var(--text-2); }
    .status svg { flex: none; margin-top: 1px; }
    .status.ok { color: var(--ok); } .status.warn { color: var(--warn); } .status.bad { color: var(--red-ink); }
    .status code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--bg-3); padding: 1px 5px; border-radius: 5px; color: var(--text); }
    .status button { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .spin { animation: spin .8s linear infinite; }
    .field { display: grid; gap: 6px; }
    .label { font-size: 12px; font-weight: 600; color: var(--text-2); }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); background: var(--bg-3); padding: 3px; border-radius: 10px; gap: 2px; }
    .seg button { all: unset; cursor: pointer; text-align: center; font-size: 13px; font-weight: 550; color: var(--text-2); padding: 6px 0; border-radius: 8px; }
    .seg button:hover { color: var(--text); }
    .seg button[aria-pressed="true"] { background: var(--bg); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 0 0 1px var(--line); }
    .help { font-size: 12px; color: var(--text-3); }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    input, select { all: unset; box-sizing: border-box; width: 100%; font-size: 13px; color: var(--text); background: var(--bg);
      border: 1px solid var(--line-2); border-radius: 8px; padding: 7px 10px; }
    select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238d8f94' stroke-width='1.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; padding-right: 26px; cursor: pointer; }
    input:focus, select:focus { border-color: var(--red); box-shadow: 0 0 0 3px rgba(229,55,43,.15); }
    .actions { display: flex; gap: 8px; align-items: center; }
    .btn { all: unset; cursor: pointer; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 9px; text-align: center; }
    .btn.primary { background: var(--red); color: #fff; flex: 1; box-shadow: inset 0 -1px 0 rgba(0,0,0,.12); }
    .btn.primary:hover:not([disabled]) { filter: brightness(1.06); }
    .btn.primary[disabled] { opacity: .45; cursor: default; }
    .btn.ghost { color: var(--text-2); }
    .btn.ghost:hover { background: var(--bg-3); color: var(--text); }
    .redo { all: unset; cursor: pointer; font-size: 12px; color: var(--text-3); text-decoration: underline; text-underline-offset: 2px; }
    .redo:hover { color: var(--text); }
    .done { padding: 22px 18px 18px; display: grid; gap: 6px; justify-items: start; }
    .done .badge { width: 36px; height: 36px; border-radius: 50%; background: var(--ok-soft); color: var(--ok); display: grid; place-items: center; margin-bottom: 4px; }
    .done h3 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .done p { margin: 0; color: var(--text-2); }
    .done .actions { margin-top: 10px; width: 100%; }
    .err { font-size: 12.5px; color: var(--red-ink); background: var(--red-soft); padding: 8px 10px; border-radius: 8px; }
    @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.98); } }
    @keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  const ICONS = {
    logo: `<svg width="22" height="22" viewBox="0 0 32 32" fill="none"><path d="M5.5 17.5c-1.6-6.3 4-11.6 11.2-11.4 7 .2 11.6 4.6 10.4 10.4-1.2 6-7.6 9.4-13.6 8.6C8 24.4 4.4 20.6 6 15.2" stroke="#e5372b" stroke-width="2.6" stroke-linecap="round"/><circle cx="16.4" cy="15.6" r="3.4" fill="currentColor"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    ok: `<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warn: `<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15"/><path d="M8 4.5v4.2M8 11.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    spin: `<svg class="spin" width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="2"/><path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    check: `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M4 9.5l3.2 3L14 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    minus: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    plus: `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6M5 2v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  };

  function mount() {
    if (host?.isConnected) return;
    host = document.createElement("vigil-ui");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    const layer = h("div", { class: "layer" });
    root.append(style, layer);
    ui = { layer };
    document.documentElement.append(host);
    loadFont();
  }

  let fontLoaded = false;
  function loadFont() {
    if (fontLoaded) return;
    fontLoaded = true;
    try {
      const face = new FontFace("Vigil Inter", `url(${chrome.runtime.getURL("fonts/inter.woff2")}) format("woff2")`, { weight: "100 900" });
      face.load().then((f) => document.fonts.add(f)).catch(() => {});
    } catch {
      /* system font is fine */
    }
  }

  function showHint(text, { warn = false, button } = {}) {
    ui.hint?.remove();
    ui.hint = h("div", { class: `hint${warn ? " warn" : ""}` }, h("span", { class: "dot" }), h("span", {}, text), button);
    ui.layer.append(ui.hint);
  }

  function hideHint() {
    ui.hint?.remove();
    ui.hint = null;
  }

  // Pen

  function startPen() {
    mount();
    closeCard();
    penOn = true;
    const canvas = h("canvas");
    ui.canvas = canvas;
    ui.layer.append(canvas);
    sizeCanvas();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", sizeCanvas);
    showHint("Circule o que você quer vigiar", { button: h("button", { onclick: stopPen }, "Esc para sair") });
  }

  function stopPen() {
    penOn = false;
    drawing = false;
    ui.canvas?.remove();
    ui.canvas = null;
    window.removeEventListener("resize", sizeCanvas);
    hideHint();
  }

  function sizeCanvas() {
    if (!ui.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ui.canvas.width = innerWidth * dpr;
    ui.canvas.height = innerHeight * dpr;
    const ctx = ui.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawStroke(alpha = 1) {
    const ctx = ui.canvas?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (points.length < 2) return;
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#e5372b";
    ctx.lineWidth = 3.5;
    ctx.shadowColor = "rgba(229,55,43,.35)";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    drawing = true;
    points = [{ x: e.clientX, y: e.clientY }];
    ui.canvas.setPointerCapture?.(e.pointerId);
  }

  function onMove(e) {
    if (!drawing) return;
    const last = points[points.length - 1];
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 2) return;
    points.push({ x: e.clientX, y: e.clientY });
    drawStroke();
  }

  function onUp(e) {
    if (!drawing) return;
    drawing = false;
    try {
      ui.canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (points.length < 4 || length < 30) {
      points = [];
      drawStroke();
      showHint("Faça um círculo em volta do trecho", { warn: true, button: h("button", { onclick: stopPen }, "Esc para sair") });
      return;
    }
    const found = resolve(points);
    if (!found) {
      points = [];
      drawStroke();
      showHint("Não achei texto aí dentro. Tente de novo", { warn: true, button: h("button", { onclick: stopPen }, "Esc para sair") });
      return;
    }
    fadeStroke();
    stopPen();
    target = found;
    mode = "text_changed";
    openCard();
  }

  function fadeStroke() {
    // Leave a ghost of the stroke for a moment, on a canvas that is not interactive.
    const ghost = h("canvas", { style: "pointer-events:none;transition:opacity .45s ease" });
    ghost.width = ui.canvas.width;
    ghost.height = ui.canvas.height;
    ghost.getContext("2d").drawImage(ui.canvas, 0, 0);
    ui.layer.append(ghost);
    requestAnimationFrame(() => (ghost.style.opacity = "0"));
    setTimeout(() => ghost.remove(), 500);
  }

  // Highlight that follows the element on scroll

  function placeHighlight() {
    if (!target || !ui.hl) return;
    const r = target.el.getBoundingClientRect();
    const pad = 4;
    Object.assign(ui.hl.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
    ui.hl.classList.toggle("below", r.top < 30);
  }

  function follow() {
    cancelAnimationFrame(followRaf);
    const loop = () => {
      placeHighlight();
      followRaf = requestAnimationFrame(loop);
    };
    followRaf = requestAnimationFrame(loop);
  }

  function describe(el) {
    const name = TAG_NAMES[el.tagName] || "bloco";
    const n = textOf(el).length;
    return `${name} · ${n.toLocaleString("pt-BR")} ${n === 1 ? "caractere" : "caracteres"}`;
  }

  // Card

  function pageLabel() {
    const t = clean(document.title).slice(0, 90) || location.hostname.replace(/^www\./, "");
    if (mode === "text_changed" || !target) return t;
    // Two alerts on the same page should not get the same name.
    const what = presenceText();
    return `“${what.length > 40 ? `${what.slice(0, 38)}...` : what}” em ${t}`;
  }

  function pageUrl() {
    return location.href.replace(/#.*$/, "");
  }

  function presenceText() {
    return clean(ui.textInput?.value || target.captured);
  }

  function openCard() {
    mount();
    closeCard({ keepTarget: true });
    ui.hl = h("div", { class: "hl" }, h("span", { class: "tag" }, "vigiar isto"));
    ui.layer.append(ui.hl);
    follow();

    ui.card = h("div", { class: "card", role: "dialog", "aria-label": "Vigiar este trecho" });
    ui.layer.append(ui.card);
    renderForm();
    placeCard();
    runProbe();
    document.addEventListener("keydown", onKey, true);
  }

  /** Puts the card in the corner that covers the least of the chosen element. */
  function placeCard() {
    if (innerWidth <= 720) return; // bottom sheet, see CSS
    const r = target.el.getBoundingClientRect();
    const hl = { left: r.left - 8, right: r.right + 8, top: r.top - 30, bottom: r.bottom + 8 };
    const w = 360;
    const ht = Math.min(ui.card.getBoundingClientRect().height || 480, innerHeight - 32);
    const spots = [
      { css: { right: "16px", top: "16px" }, box: { left: innerWidth - 16 - w, right: innerWidth - 16, top: 16, bottom: 16 + ht } },
      { css: { left: "16px", top: "16px" }, box: { left: 16, right: 16 + w, top: 16, bottom: 16 + ht } },
      { css: { right: "16px", bottom: "16px", top: "auto" }, box: { left: innerWidth - 16 - w, right: innerWidth - 16, top: innerHeight - 16 - ht, bottom: innerHeight - 16 } },
      { css: { left: "16px", bottom: "16px", top: "auto" }, box: { left: 16, right: 16 + w, top: innerHeight - 16 - ht, bottom: innerHeight - 16 } },
    ];
    const overlap = (a) => Math.max(0, Math.min(a.right, hl.right) - Math.max(a.left, hl.left)) * Math.max(0, Math.min(a.bottom, hl.bottom) - Math.max(a.top, hl.top));
    let best = spots[0];
    for (const spot of spots) if (overlap(spot.box) < overlap(best.box) - 1) best = spot;
    Object.assign(ui.card.style, { left: "auto", right: "auto", top: "auto", bottom: "auto", ...best.css });
  }

  function closeCard({ keepTarget = false } = {}) {
    cancelAnimationFrame(followRaf);
    ui.hl?.remove();
    ui.card?.remove();
    ui.hl = ui.card = ui.textInput = ui.label = null;
    ui.labelEdited = false;
    document.removeEventListener("keydown", onKey, true);
    if (!keepTarget) target = null;
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeCard();
    } else if (e.key === "Enter" && ui.card && !e.isComposing && root.activeElement?.tagName !== "SELECT") {
      if (root.activeElement && ui.card.contains(root.activeElement)) {
        e.preventDefault();
        save();
      }
    }
  }

  function previewNode() {
    const full = textOf(target.el) || target.captured;
    const text = h("div", { class: `text${full.length < 220 ? " short" : ""}` });
    const shown = full.slice(0, 700);
    const idx = target.captured && target.captured.length < full.length * 0.9 ? shown.toLowerCase().indexOf(target.captured.toLowerCase()) : -1;
    if (idx >= 0) {
      text.append(shown.slice(0, idx), h("mark", {}, shown.slice(idx, idx + target.captured.length)), shown.slice(idx + target.captured.length));
    } else {
      text.append(shown);
    }
    return text;
  }

  function renderForm() {
    const card = ui.card;
    card.replaceChildren();
    const bigger = biggerOf(target.el);
    const smaller = smallerOf(target.el, target.captured);

    const head = h("div", { class: "head" },
      h("span", { html: ICONS.logo, style: "display:grid;color:var(--text)" }),
      h("span", { class: "title" }, "Vigiar este trecho"),
      h("button", { class: "icon-btn", title: "Fechar", "aria-label": "Fechar", onclick: () => closeCard(), html: ICONS.close })
    );

    const presence = mode !== "text_changed";
    const preview = presence
      ? h("div", { class: "field" },
          h("label", { class: "label", for: "vigil-text" }, mode === "text_appears" ? "Texto que deve aparecer" : "Texto que deve sumir"),
          (ui.textInput = h("input", { id: "vigil-text", value: ui.textInput?.value ?? target.captured, oninput: debounceProbe })))
      : h("div", { class: "preview" },
          previewNode(),
          h("div", { class: "scope" },
            h("span", { class: "what", title: "O que será comparado" }, describe(target.el)),
            h("button", { class: "chip-btn", disabled: !smaller, title: "Pegar um elemento menor", onclick: () => rescope(smaller) }, h("span", { html: ICONS.minus }), "Menor"),
            h("button", { class: "chip-btn", disabled: !bigger, title: "Pegar o elemento em volta", onclick: () => rescope(bigger) }, h("span", { html: ICONS.plus }), "Maior")
          ));
    if (!presence) ui.textInput = null;

    ui.status = h("div", { class: "status" });
    renderStatus();

    const seg = h("div", { class: "seg", role: "group", "aria-label": "Avisar quando" },
      Object.entries(MODES).map(([key, m]) =>
        h("button", { "aria-pressed": String(key === mode), onclick: () => setMode(key) }, m.label)));

    const keepLabel = ui.label && ui.labelEdited;
    ui.label = h("input", { value: keepLabel ? ui.label.value : pageLabel(), maxlength: "200", "aria-label": "Nome", oninput: () => (ui.labelEdited = true) });
    ui.interval = h("select", { "aria-label": "Checar a cada", onchange: (e) => (interval = Number(e.target.value)) },
      INTERVALS.map(([v, text]) => h("option", { value: String(v), selected: v === interval }, text)));

    ui.saveBtn = h("button", { class: "btn primary", onclick: save }, "Vigiar");
    ui.error = h("div", { class: "err", style: "display:none" });

    card.append(head, h("div", { class: "body" },
      preview,
      ui.status,
      h("div", { class: "field" }, h("span", { class: "label" }, "Avisar quando o trecho"), seg, h("span", { class: "help" }, MODES[mode].hint)),
      h("div", { class: "row" },
        h("div", { class: "field" }, h("span", { class: "label" }, "Nome"), ui.label),
        h("div", { class: "field" }, h("span", { class: "label" }, "Checar a cada"), ui.interval)),
      ui.error,
      h("div", { class: "actions" },
        ui.saveBtn,
        h("button", { class: "btn ghost", onclick: () => { closeCard(); startPen(); } }, "Circular de novo"))
    ));
    updateSave();
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    renderForm();
    runProbe();
  }

  function rescope(el) {
    if (!el) return;
    const before = textOf(target.el);
    target.history.push(target.el);
    target.el = el;
    // Keep what was circled if the new element still holds it, else the element's own text.
    if (!squash(textOf(el)).includes(squash(target.captured))) target.captured = textOf(el).slice(0, 300);
    else if (squash(before) === squash(target.captured)) target.captured = textOf(el).slice(0, 300);
    renderForm();
    runProbe();
  }

  let probeTimer = 0;
  function debounceProbe() {
    clearTimeout(probeTimer);
    probeTimer = setTimeout(runProbe, 450);
  }

  async function runProbe() {
    const seq = ++probeSeq;
    target.selectors = selectorsFor(target.el);
    probeState = { status: "loading" };
    renderStatus();
    const text = mode === "text_changed" ? target.captured : presenceText();
    const res = await send({ type: "vigil:probe", url: pageUrl(), selectors: mode === "text_changed" ? target.selectors : [], text });
    if (seq !== probeSeq || !ui.card) return;
    if (!res.ok) probeState = { status: res.offline ? "offline" : "fetch-error", error: res.error };
    else probeState = { status: "done", result: res.data };
    renderStatus();
  }

  /** Decides what the card says about the server's view and whether saving makes sense. */
  function verdict() {
    const s = probeState;
    if (s.status === "loading" || s.status === "idle") return { cls: "", icon: ICONS.spin, text: "Conferindo se o Vigil enxerga isso na página...", canSave: false };
    if (s.status === "offline") {
      return { cls: "bad", icon: ICONS.warn, html: `O Vigil não está rodando. Abra a pasta do projeto e rode <code>npm start</code>. <button data-retry>Tentar de novo</button>`, canSave: false };
    }
    if (s.status === "fetch-error") {
      return { cls: "warn", icon: ICONS.warn, text: `O Vigil não conseguiu abrir esta página: ${s.error}. Dá para salvar, mas os checks vão falhar.`, canSave: true, label: "Vigiar mesmo assim" };
    }
    const r = s.result;
    if (mode === "text_changed") {
      if (r.selector) return { cls: "ok", icon: ICONS.ok, text: "O Vigil enxerga este trecho na página.", canSave: true };
      if (r.textFound) return { cls: "warn", icon: ICONS.warn, text: "A estrutura da página muda depois de carregar. Vou achar o trecho pelo texto.", canSave: true };
      return { cls: "bad", icon: ICONS.warn, text: "Este trecho não vem no HTML da página (é montado por JavaScript), então o Vigil não consegue ler. Tente um trecho maior ou outro ponto.", canSave: false };
    }
    if (mode === "text_appears") {
      if (presenceText().length < 2) return { cls: "bad", icon: ICONS.warn, text: "Escreva o texto que você espera ver.", canSave: false };
      if (r.textFound) return { cls: "warn", icon: ICONS.warn, text: "Esse texto já está na página. Só aviso se ele sumir e depois voltar.", canSave: true };
      return { cls: "ok", icon: ICONS.ok, text: "Hoje esse texto não está na página. Aviso quando aparecer.", canSave: true };
    }
    if (presenceText().length < 2) return { cls: "bad", icon: ICONS.warn, text: "Escreva o texto que deve sumir.", canSave: false };
    if (r.textFound) return { cls: "ok", icon: ICONS.ok, text: "O Vigil acha esse texto na página. Aviso quando ele sumir.", canSave: true };
    return { cls: "bad", icon: ICONS.warn, text: "O Vigil não acha esse texto no HTML da página, então não teria como ver ele sumir.", canSave: false };
  }

  function renderStatus() {
    if (!ui.status) return;
    const v = verdict();
    ui.status.className = `status ${v.cls}`;
    ui.status.replaceChildren(h("span", { html: v.icon, style: "display:grid" }), h("span", v.html ? { html: v.html } : {}, v.html ? null : v.text));
    ui.status.querySelector("[data-retry]")?.addEventListener("click", runProbe);
    updateSave(v);
  }

  function updateSave(v = verdict()) {
    if (!ui.saveBtn) return;
    ui.saveBtn.disabled = saving || !v.canSave;
    ui.saveBtn.textContent = saving ? "Salvando..." : v.label || "Vigiar";
  }

  async function save() {
    const v = verdict();
    if (saving || !v.canSave) return;
    saving = true;
    updateSave(v);
    ui.error.style.display = "none";
    const result = probeState.result;
    const presence = mode !== "text_changed";
    const watch = {
      url: pageUrl(),
      label: clean(ui.label.value) || pageLabel(),
      monitorMode: mode,
      targetText: presence ? presenceText() : target.captured.slice(0, 2000),
      cssSelector: presence ? null : result?.selector ?? null,
      intervalMinutes: interval,
    };
    const res = await send({ type: "vigil:save", watch });
    saving = false;
    if (!ui.card) return;
    if (!res.ok) {
      ui.error.textContent = res.offline ? "O Vigil parou de responder. Ele ainda está rodando?" : res.error;
      ui.error.style.display = "";
      updateSave();
      return;
    }
    showDone(res.data);
  }

  function showDone(data) {
    ui.hl?.classList.add("saved");
    ui.hl?.querySelector(".tag")?.replaceChildren("vigiando");
    const check = data.check;
    const failed = check?.status === "error";
    const msg = failed
      ? `Salvei, mas a primeira leitura falhou: ${check.error}`
      : `Primeira leitura feita. Checo a cada ${INTERVALS.find(([v]) => v === interval)?.[1] ?? `${interval} min`} e aviso aqui no navegador quando ${mode === "text_changed" ? "mudar" : mode === "text_appears" ? "aparecer" : "sumir"}.`;
    ui.card.replaceChildren(
      h("div", { class: "done" },
        h("div", { class: "badge", html: failed ? ICONS.warn : ICONS.check }),
        h("h3", {}, failed ? "Salvo, com um problema" : "Pronto, estou de olho"),
        h("p", {}, msg),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", onclick: () => send({ type: "vigil:open-panel", watchId: data.watch.id }) }, "Ver no painel"),
          h("button", { class: "btn ghost", onclick: () => closeCard() }, "Fechar"))));
    clearTimeout(ui.doneTimer);
    ui.doneTimer = setTimeout(() => closeCard(), 9000);
  }

  // Wiring

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === "vigil:pen") {
      if (msg.on) startPen();
      else stopPen();
      sendResponse({ ok: true });
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function onGlobalKey(e) {
    if (e.key === "Escape" && penOn) {
      e.stopPropagation();
      stopPen();
    }
  }
  window.addEventListener("keydown", onGlobalKey, true);

  window.__vigilPen = {
    alive: () => {
      try {
        return Boolean(chrome.runtime?.id);
      } catch {
        return false;
      }
    },
    destroy: () => {
      stopPen();
      closeCard();
      host?.remove();
      window.removeEventListener("keydown", onGlobalKey, true);
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* runtime gone */
      }
    },
    // For the end-to-end script: what the pen resolved and which selectors it built.
    debug: () => target && { captured: target.captured, tag: target.el.tagName, text: textOf(target.el).slice(0, 200), selectors: selectorsFor(target.el), probe: probeState },
  };
})();

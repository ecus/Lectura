// Análisis del PDF para el modo "texto adaptado":
// extrae líneas con pdf.js, quita encabezados/pies repetidos y números de página,
// rearma párrafos, detecta títulos (para el índice automático) y luego
// reparte el texto en páginas del tamaño de la pantalla.

export const EXTRACT_VERSION = 1;

const HEADING_WORDS = /^(cap[ií]tulo|parte|libro|secci[oó]n|lecci[oó]n|unidad|tema|pr[oó]logo|ep[ií]logo|introducci[oó]n|prefacio|pre[aá]mbulo|ap[eé]ndice|anexo|conclusi[oó]n|conclusiones|agradecimientos|bibliograf[ií]a|referencias|glosario|chapter|part|book|section|prologue|epilogue|introduction|preface|foreword|appendix|conclusions?|acknowledge?ments|references)\b/i;
const MAJOR_WORDS = /^(cap[ií]tulo|parte|libro|chapter|part|book)\b/i;
const END_PUNCT = /[.!?:;…»"”')\]]$/;
const LIST_START = /^([•·▪●◦■□➢►\-–—*]|\d{1,3}[.)]|[a-z][.)])\s/;
const PAGE_NUM = /^[\s\-–—|·•]*(p[áa]g(ina)?\.?\s*|page\s*)?(\d{1,4}|[ivxlcdm]{1,7})([\s\-–—|·•]*(de|of|\/)\s*\d+)?[\s\-–—|·•]*$/i;

function buildLines(items) {
  const lines = [];
  let cur = null;
  const close = () => {
    if (cur) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      if (cur.text) lines.push(cur);
    }
    cur = null;
  };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > Math.abs(a) + 0.01) { // texto girado (márgenes, sellos): se ignora
      if (it.hasEOL) close();
      continue;
    }
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    if (it.str.length) {
      if (cur && (Math.abs(f - cur.y) > Math.max(size, cur.size) * 0.6 || e < cur.xEnd - cur.size * 3)) close();
      if (!cur) cur = { x: e, y: f, xEnd: e, size: it.str.trim() ? size : 0, text: '' };
      else if (e - cur.xEnd > size * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += it.str;
      cur.xEnd = Math.max(cur.xEnd, e + (it.width || 0));
      cur.x = Math.min(cur.x, e);
      if (it.str.trim()) cur.size = Math.max(cur.size, size);
    }
    if (it.hasEOL) close();
  }
  close();
  return lines.filter(l => l.size > 0);
}

/** Extrae el texto de todas las páginas. `ops` = pdfjsLib.OPS (para detectar páginas con imágenes). */
export async function extractDocument(doc, ops, onProgress) {
  const imgOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject].filter(v => v != null));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [x0, y0, x1, y1] = page.view;
    const tc = await page.getTextContent();
    const lines = buildLines(tc.items);
    const chars = lines.reduce((s, l) => s + l.text.length, 0);
    let graphic = false;
    if (chars < 40) {
      try {
        const ol = await page.getOperatorList();
        graphic = ol.fnArray.some(fn => imgOps.has(fn)) || ol.fnArray.length > 60;
      } catch {}
    }
    pages.push({ y0, h: y1 - y0, w: x1 - x0, lines, chars, graphic });
    page.cleanup();
    if (onProgress && (i % 4 === 0 || i === doc.numPages)) onProgress(i / doc.numPages);
  }
  return analyze(pages);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function joinText(a, b) {
  if (/[a-záéíóúñüàèìòùç]-$/i.test(a) && /^[a-záéíóúñüàèìòùç]/.test(b)) return a.slice(0, -1) + b;
  if (/­$/.test(a)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}
function detectLang(sample) {
  const t = ' ' + sample.toLowerCase() + ' ';
  const count = words => words.reduce((s, w) => s + (t.split(` ${w} `).length - 1), 0);
  const es = count(['de', 'la', 'que', 'el', 'en', 'los', 'del', 'las', 'por', 'una']);
  const en = count(['the', 'and', 'of', 'to', 'is', 'that', 'for', 'with', 'was', 'this']);
  const pt = count(['não', 'uma', 'com', 'para', 'os', 'das', 'dos', 'é']);
  const fr = count(['le', 'les', 'et', 'des', 'est', 'une', 'pour', 'dans']);
  const best = [['es', es], ['en', en], ['pt', pt], ['fr', fr]].sort((a, b) => b[1] - a[1])[0];
  return best[1] > 5 ? best[0] : 'es';
}

function analyze(pages) {
  const n = pages.length;
  const relY = (pg, l) => (l.y - pg.y0) / (pg.h || 1);
  const norm = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

  // 1) Encabezados/pies que se repiten en muchas páginas y números de página
  const zone = new Map();
  for (const pg of pages) {
    const seen = new Set();
    for (const l of pg.lines) {
      const ry = relY(pg, l);
      if (ry > 0.9 || ry < 0.1) {
        const k = norm(l.text);
        if (!seen.has(k)) { seen.add(k); zone.set(k, (zone.get(k) || 0) + 1); }
      }
    }
  }
  const repeated = new Set([...zone].filter(([, c]) => c >= 3 && c >= n * 0.2).map(([k]) => k));
  for (const pg of pages) {
    pg.lines = pg.lines.filter(l => {
      const ry = relY(pg, l);
      if (ry > 0.88 || ry < 0.12) {
        if (PAGE_NUM.test(l.text)) return false;
        if (repeated.has(norm(l.text))) return false;
      }
      return true;
    });
  }

  // 2) Tamaño de letra del cuerpo: el más usado
  const bySize = new Map();
  let totalChars = 0;
  for (const pg of pages) for (const l of pg.lines) {
    const k = Math.round(l.size * 2) / 2;
    bySize.set(k, (bySize.get(k) || 0) + l.text.length);
    totalChars += l.text.length;
  }
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  // 3) Bloques: títulos, párrafos e imágenes
  const blocks = [];
  let para = null;
  const flush = () => { if (para) { blocks.push(para); para = null; } };

  const headingLevel = (l, gapBefore, lineGap) => {
    const t = l.text;
    if (t.length > 160 || t.length < 2 || !/[A-Za-zÀ-ÿ]/.test(t)) return 0;
    const r = l.size / body;
    const isolated = gapBefore > lineGap * 1.4;
    if (r >= 1.55) return 1;
    if (r >= 1.18 && t.length < 120) return MAJOR_WORDS.test(t) ? 1 : 2;
    if (t.length <= 80 && HEADING_WORDS.test(t) && isolated && !/[,;]$/.test(t) && !/\s(de|del|la|el|y|en|of|the|and)$/i.test(t)) {
      return MAJOR_WORDS.test(t) ? 1 : 2;
    }
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (t.length <= 70 && letters.length >= 4 && letters === letters.toUpperCase() && isolated && !/[,]$/.test(t)) return 3;
    return 0;
  };

  pages.forEach((pg, pi) => {
    const L = pg.lines;
    const chars = L.reduce((s, l) => s + l.text.length, 0);
    if (chars < 40) {
      if (pg.graphic) { flush(); blocks.push({ t: 'img', p: pi, ar: pg.w / pg.h }); }
      else if (chars === 0) return;
    }
    const bodyLines = L.filter(l => Math.abs(l.size - body) <= body * 0.15);
    const left = percentile(bodyLines.map(l => l.x), 0.1) ?? Math.min(...L.map(l => l.x));
    const right = percentile(bodyLines.map(l => l.xEnd), 0.9) ?? Math.max(...L.map(l => l.xEnd));
    const gaps = [];
    for (let i = 1; i < L.length; i++) {
      const g = L[i - 1].y - L[i].y;
      if (g > 0 && g < body * 3) gaps.push(g);
    }
    const lineGap = median(gaps) || body * 1.2;

    let prev = null;
    L.forEach((l, i) => {
      const gap = prev ? prev.y - l.y : Infinity;
      const level = headingLevel(l, i === 0 ? Infinity : gap, lineGap);
      if (level) {
        const last = blocks[blocks.length - 1];
        if (!para && last && last.t === 'h' && last.l === level && last.p === pi && prev &&
            gap > 0 && gap < l.size * 2.2 && last.x.length < 120) {
          last.x += ' ' + l.text; // título en varias líneas
        } else {
          flush();
          blocks.push({ t: 'h', l: level, x: l.text, p: pi });
        }
        prev = l;
        return;
      }
      const list = LIST_START.test(l.text);
      const indented = l.x > left + body * 0.9 && l.x < left + body * 8;
      let start;
      if (!para) start = true;
      else if (!prev || prev === null) start = END_PUNCT.test(para.x) || indented || list; // inicio de página
      else if (gap < 0 || gap > body * 6) start = END_PUNCT.test(para.x) || list; // cambio de columna
      else {
        const prevShort = prev.xEnd < right - body * 3 && END_PUNCT.test(prev.text);
        const sameIndent = Math.abs(prev.x - l.x) < body * 0.5;
        start = gap > lineGap * 1.5 || list || (indented && !sameIndent) || prevShort;
      }
      if (start) { flush(); para = { t: 'p', x: l.text, p: pi }; }
      else para.x = joinText(para.x, l.text);
      prev = l;
    });
  });
  flush();

  for (const b of blocks) if (b.x) b.x = b.x.replace(/\s+/g, ' ').trim();
  const sample = blocks.filter(b => b.t === 'p').slice(0, 60).map(b => b.x).join(' ');
  return {
    version: EXTRACT_VERSION,
    blocks: blocks.filter(b => b.t === 'img' || b.x),
    chars: totalChars,
    pages: n,
    lang: detectLang(sample),
  };
}

/** Índice automático a partir de los títulos detectados. */
export function detectedHeadings(text) {
  const out = [];
  text.blocks.forEach((b, i) => {
    if (b.t === 'h') out.push({ title: b.x.length > 110 ? b.x.slice(0, 108) + '…' : b.x, page: b.p, b: i, lvl: b.l - 1 });
  });
  return out;
}

/**
 * Reparte los bloques en páginas de `width`×`height` px midiendo con el DOM
 * (usa las mismas clases CSS que las páginas reales).
 */
export async function paginate(blocks, { host, width, height, firstBlock = 0, onProgress }) {
  const pageEl = document.createElement('div');
  pageEl.className = 'page tpage';
  pageEl.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;width:${width}px;height:${height}px`;
  pageEl.innerHTML = '<div class="thead">&nbsp;</div><div class="tbody"></div><div class="tfoot">0</div>';
  host.appendChild(pageEl);
  const bodyEl = pageEl.querySelector('.tbody');
  const fits = () => bodyEl.scrollHeight <= bodyEl.clientHeight + 1;
  const probe = document.createElement('p');
  probe.textContent = 'x';
  bodyEl.appendChild(probe);
  const lineH = probe.offsetHeight || 24;
  bodyEl.innerHTML = '';
  const used = () => {
    const last = bodyEl.lastElementChild;
    return last ? last.offsetTop + last.offsetHeight : 0;
  };

  const pages = [];
  let start = { b: firstBlock, o: 0 };
  let src = null;
  let chapter = '';
  let pageHead = '';
  const flush = (b, o) => {
    if (bodyEl.childNodes.length) {
      pages.push({
        html: bodyEl.innerHTML,
        start,
        src,
        head: bodyEl.querySelector('.h1') ? null : pageHead, // sin encabezado en el inicio de capítulo
      });
    }
    bodyEl.innerHTML = '';
    start = { b, o };
    src = null;
    pageHead = chapter;
  };

  let lastYield = performance.now();
  let afterMajor = false;
  for (let b = firstBlock; b < blocks.length; b++) {
    const blk = blocks[b];
    if (performance.now() - lastYield > 40) {
      onProgress?.((b - firstBlock) / Math.max(1, blocks.length - firstBlock));
      await new Promise(r => setTimeout(r, 0));
      lastYield = performance.now();
    }

    if (blk.t === 'h') {
      if (blk.l === 1 && bodyEl.childNodes.length) flush(b, 0);
      const el = document.createElement('h3');
      el.className = 'h' + blk.l;
      el.textContent = blk.x;
      bodyEl.appendChild(el);
      // no dejar un título solo al final de la página
      if (!fits() || (bodyEl.childNodes.length > 1 && bodyEl.clientHeight - used() < lineH * 2.5)) {
        el.remove();
        flush(b, 0);
        bodyEl.appendChild(el);
      }
      if (src == null) src = blk.p;
      if (blk.l <= 2) chapter = blk.x.length > 60 ? blk.x.slice(0, 58) + '…' : blk.x;
      afterMajor = blk.l === 1;
      continue;
    }

    if (blk.t === 'img') {
      const el = document.createElement('figure');
      el.className = 'timg';
      el.dataset.pdf = blk.p;
      const bw = bodyEl.clientWidth;
      const bh = bodyEl.clientHeight;
      let w = bw;
      let h = w / (blk.ar || 0.7);
      if (h > bh) { h = bh; w = h * (blk.ar || 0.7); }
      el.style.width = Math.floor(w) + 'px';
      el.style.height = Math.floor(h) + 'px';
      bodyEl.appendChild(el);
      if (!fits() && bodyEl.childNodes.length > 1) {
        el.remove();
        flush(b, 0);
        bodyEl.appendChild(el);
      }
      if (src == null) src = blk.p;
      afterMajor = false;
      continue;
    }

    const words = blk.x.split(' ');
    let o = 0;
    while (o < words.length) {
      const el = document.createElement('p');
      if (o > 0) el.className = 'cont';
      else if (afterMajor) el.className = 'first';
      el.textContent = o ? words.slice(o).join(' ') : blk.x;
      bodyEl.appendChild(el);
      if (src == null) src = blk.p;
      if (fits()) break;
      let lo = 0;
      let hi = words.length - o;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        el.textContent = words.slice(o, o + mid).join(' ');
        if (fits()) lo = mid; else hi = mid;
      }
      if (lo === 0) {
        if (bodyEl.childNodes.length === 1) lo = 1; // palabra enorme en página vacía
        else { el.remove(); flush(b, o); continue; }
      }
      el.textContent = words.slice(o, o + lo).join(' ');
      el.classList.add('split');
      o += lo;
      flush(b, o);
    }
    afterMajor = false;
  }
  flush(blocks.length, 0);
  pageEl.remove();
  onProgress?.(1);
  return pages;
}

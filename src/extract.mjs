// Warstwowy ekstraktor ceny. Kolejnosc warstw nie jest przypadkowa - schodzimy
// od najbardziej ustrukturyzowanego zrodla do najbardziej zgadywanego, i kazda
// zwrocona cena niesie ze soba `method`, zeby w raporcie bylo widac, na czym
// dokladnie bot sie oparl. Cena z warstwy "text" jest z definicji podejrzana.

export const LAYERS = ["jsonld", "microdata", "meta", "text"];

// "5 688,26 zl" -> 5688.26 · "6 289,00" -> 6289 · "1.234,50" -> 1234.5 · "1234.50" -> 1234.5
export function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (!s) return null;

  // Usun wszystko poza cyframi, przecinkiem, kropka i minusem. Spacje twarde
  // (U+00A0) i waskie (U+202F) sa w polskich sklepach separatorem tysiecy i
  // przechodza przez zwykly \s w innych implementacjach - stad jawna klasa.
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Separatorem dziesietnym jest ten, ktory stoi blizej konca.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // Przecinek z dokladnie 1-2 cyframi po nim to grosze; inaczej separator tysiecy.
    const after = s.length - lastComma - 1;
    s = after >= 1 && after <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1) {
    const after = s.length - lastDot - 1;
    if (after === 3 && (s.match(/\./g) || []).length >= 1 && s.length > 4) {
      // "1.234" -> tysiace, nie 1,234 zl. Agregat za 1,23 zl nie istnieje.
      s = s.replace(/\./g, "");
    }
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Nazwa -> token porownawczy: "KS 8100iE ATSR" i "ks-8100ie-atsr" daja to samo.
export function normToken(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function stripTags(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

// --- warstwa 1: JSON-LD -----------------------------------------------------

export function parseJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Sklepy potrafia wstawic nieprawidlowy JSON (koncowy przecinek, komentarz).
      // Jeden zepsuty blok nie moze zabic pozostalych - stad cichy catch.
      try {
        out.push(JSON.parse(raw.replace(/,\s*([}\]])/g, "$1")));
      } catch { /* blok nie do uratowania */ }
    }
  }
  return out;
}

// Rozwija @graph, tablice i zagniezdzenia w plaska liste wezlow.
export function flattenNodes(input, acc = []) {
  if (input == null) return acc;
  if (Array.isArray(input)) { for (const x of input) flattenNodes(x, acc); return acc; }
  if (typeof input !== "object") return acc;
  acc.push(input);
  if (input["@graph"]) flattenNodes(input["@graph"], acc);
  for (const k of ["offers", "hasVariant", "isSimilarTo", "itemOffered"]) {
    if (input[k]) flattenNodes(input[k], acc);
  }
  return acc;
}

function typeOf(node) {
  const t = node && node["@type"];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x).toLowerCase());
}

function offerPrice(node) {
  if (!node) return null;
  const cands = [node.price, node.lowPrice, node.highPrice];
  if (node.priceSpecification) {
    const ps = Array.isArray(node.priceSpecification) ? node.priceSpecification : [node.priceSpecification];
    for (const p of ps) cands.push(p && p.price);
  }
  for (const c of cands) {
    const v = parsePrice(c);
    if (v != null && v > 0) return v;
  }
  return null;
}

function availabilityOf(node) {
  const a = node && node.availability;
  if (!a) return null;
  const s = String(a).toLowerCase();
  if (s.includes("outofstock")) return "brak";
  if (s.includes("preorder") || s.includes("backorder")) return "na zamowienie";
  if (s.includes("instock") || s.includes("limitedavailability")) return "dostepny";
  return null;
}

// Zwraca {price, currency, availability, name} albo null.
// `expectTokens` steruje wyborem, gdy strona opisuje wiecej niz jeden produkt
// (sekcje "podobne", "kupowane razem") - bez tego bot brał cene akcesorium.
export function fromJsonLd(html, expectTokens = []) {
  const nodes = flattenNodes(parseJsonLdBlocks(html));
  const products = nodes.filter((n) => typeOf(n).includes("product"));
  if (!products.length) return null;

  const wanted = expectTokens.map(normToken).filter(Boolean);
  const scored = products.map((p) => {
    const nameTok = normToken(p.name) + normToken(p.sku) + normToken(p.mpn) + normToken(p.gtin13);
    const hit = wanted.length ? wanted.some((w) => nameTok.includes(w)) : false;
    return { p, hit };
  });

  const ordered = [...scored.filter((s) => s.hit), ...scored.filter((s) => !s.hit)];
  if (wanted.length && !scored.some((s) => s.hit) && products.length > 1) {
    // Kilka produktow i zaden nie pasuje do oczekiwanego - nie zgadujemy.
    return null;
  }

  for (const { p, hit } of ordered) {
    const offers = flattenNodes(p.offers).filter((n) => {
      const t = typeOf(n);
      return t.includes("offer") || t.includes("aggregateoffer") || n.price != null || n.lowPrice != null;
    });
    for (const o of offers) {
      const price = offerPrice(o);
      if (price != null) {
        return {
          price,
          currency: o.priceCurrency || p.priceCurrency || "PLN",
          availability: availabilityOf(o),
          name: p.name ? String(p.name) : null,
          gtin: p.gtin13 || p.gtin || p.ean || null,
          matchedExpected: hit,
        };
      }
    }
  }
  return null;
}

// --- warstwa 2: microdata / RDFa --------------------------------------------

export function fromMicrodata(html) {
  const re = /<[^>]+itemprop\s*=\s*["']price["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    const v = parsePrice(content ? content[1] : null);
    if (v != null && v > 0) {
      const cur = /itemprop\s*=\s*["']priceCurrency["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html);
      return { price: v, currency: cur ? cur[1] : "PLN", availability: null, name: null };
    }
  }
  return null;
}

// --- warstwa 3: meta / og ---------------------------------------------------

const META_KEYS = [
  "product:price:amount",
  "og:price:amount",
  "twitter:data1",
  "product:sale_price:amount",
];

export function fromMeta(html) {
  for (const key of META_KEYS) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key.replace(/[:]/g, "\\:")}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      "i"
    );
    const m = re.exec(html);
    const v = parsePrice(m ? m[1] : null);
    if (v != null && v > 0) return { price: v, currency: "PLN", availability: null, name: null };
  }
  return null;
}

// --- warstwa 4: atrybuty z "price" w nazwie ---------------------------------

// Sklepy na PrestaShop/WooCommerce/IdoSell czesto nie wystawiaja ani JSON-LD,
// ani microdata, ale cena prawie zawsze siedzi w elemencie, ktory ma "price"
// w klasie, id albo atrybucie data-*. Sama ta heurystyka bylaby niebezpieczna
// (rata leasingu, cena przekreslona, koszt dostawy), dlatego dziala WYLACZNIE
// z widelkami: wartosc poza zakresem wyliczonym z ceny bazowej jest odrzucana.
// Bez widelek ta warstwa wpuscilaby do historii pierwsza lepsza liczbe.
export function fromPriceAttrs(html, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  // Najpierw atrybuty niosace wartosc wprost - te sa najpewniejsze.
  const attrRe = /(?:data-(?:product-)?price(?:-amount)?|content)\s*=\s*["']([\d\s.,]{3,15})["'][^>]{0,120}?(?:class|id)\s*=\s*["'][^"']*price/gi;
  const revRe = /(?:class|id)\s*=\s*["'][^"']*price[^"']*["'][^>]{0,200}?(?:data-(?:product-)?price(?:-amount)?|content)\s*=\s*["']([\d\s.,]{3,15})["']/gi;
  for (const re of [attrRe, revRe]) {
    let m;
    while ((m = re.exec(html))) {
      const v = parsePrice(m[1]);
      if (v != null && v >= min && v <= max) {
        return { price: v, currency: "PLN", availability: null, name: null };
      }
    }
  }

  // Potem tekst tuz za znacznikiem z "price" w nazwie.
  const tagRe = /<([a-z]+)\b[^>]*(?:class|id|itemprop)\s*=\s*["'][^"']*price[^"']*["'][^>]*>([\s\S]{0,160}?)<\/\1>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const txt = stripTags(m[2]);
    const num = /(\d[\d\s\u00a0\u202f.,]{2,14})/.exec(txt);
    const v = num ? parsePrice(num[1]) : null;
    if (v != null && v >= min && v <= max) {
      return { price: v, currency: "PLN", availability: null, name: null };
    }
  }
  return null;
}

// --- warstwa 5: regex po tekscie (ostatnia deska ratunku) -------------------

// Wymaga jawnego wzorca z konfiguracji sklepu. Bez niego NIE zgadujemy -
// pierwsza liczba ze slowem "zl" na stronie to rownie czesto rata leasingu,
// cena przekreslona albo koszt dostawy.
export function fromText(html, pattern) {
  if (!pattern) return null;
  const re = new RegExp(pattern, "i");
  const m = re.exec(html) || re.exec(stripTags(html));
  if (!m) return null;
  const v = parsePrice(m[1] != null ? m[1] : m[0]);
  return v != null && v > 0 ? { price: v, currency: "PLN", availability: null, name: null } : null;
}

// --- orkiestracja -----------------------------------------------------------

// Widelki wiarygodnosci liczone z ceny bazowej. Sklep moze byc o polowe tanszy
// albo o 150% drozszy - ale cena 49 zl przy agregacie za 5 000 to akcesorium,
// a 90 000 to literowka albo zlepek dwoch liczb. Zakres jest szeroki celowo:
// ma odsiewac bzdury, nie prawdziwe promocje.
export function priceBounds(baseline) {
  if (!Number.isFinite(baseline) || baseline <= 0) return { min: null, max: null };
  return { min: Math.round(baseline * 0.45), max: Math.round(baseline * 2.5) };
}

export function extractPrice(html, { expectTokens = [], textPattern = null, min = null, max = null } = {}) {
  if (!html || typeof html !== "string") return { price: null, method: null, reason: "brak HTML" };

  const inRange = (v) =>
    (min == null || v >= min) && (max == null || v <= max);

  const attempts = [
    ["jsonld", () => fromJsonLd(html, expectTokens)],
    ["microdata", () => fromMicrodata(html)],
    ["meta", () => fromMeta(html)],
    ["priceattr", () => fromPriceAttrs(html, min, max)],
    ["text", () => fromText(html, textPattern)],
  ];

  const rejected = [];
  for (const [method, fn] of attempts) {
    let r = null;
    try { r = fn(); } catch { r = null; }
    if (!r || r.price == null) continue;
    if (!inRange(r.price)) { rejected.push(`${method}=${r.price}`); continue; }
    return { ...r, method, reason: null };
  }
  const why = rejected.length
    ? `cena poza widelkami ${min}-${max} (${rejected.join(", ")})`
    : "zadna warstwa nie znalazla ceny";
  return { price: null, method: null, reason: why };
}

// Czy strona w ogole dotyczy tego produktu. Uzywane, gdy sklep podmieni URL
// albo przekieruje na kategorie - wtedy cena jest poprawna, ale nie ta.
export function pageMatchesProduct(html, product) {
  const hay = normToken(stripTags(html).slice(0, 20000)) + normToken(html.slice(0, 4000));
  if (product.ean && hay.includes(normToken(product.ean))) return { ok: true, by: "ean" };
  for (const t of product.matchTokens || []) {
    if (hay.includes(normToken(t))) {
      for (const r of product.rejectTokens || []) {
        // Token odrzucajacy wygrywa tylko wtedy, gdy oczekiwanego NIE ma osobno.
        if (hay.includes(normToken(r)) && !hay.includes(normToken(t))) return { ok: false, by: r };
      }
      return { ok: true, by: t };
    }
  }
  return { ok: false, by: null };
}

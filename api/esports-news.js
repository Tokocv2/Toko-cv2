
import dns from "node:dns/promises";
import net from "node:net";

const FEEDS = [
  ["Mobile Legends", "https://news.google.com/rss/search?q=Mobile+Legends+esports&hl=id&gl=ID&ceid=ID:id"],
  ["Mobile Legends", "https://news.google.com/rss/search?q=Mobile+Legends+esports+tournament&hl=en-US&gl=US&ceid=US:en"],
  ["PUBG Mobile", "https://news.google.com/rss/search?q=PUBG+Mobile+esports&hl=id&gl=ID&ceid=ID:id"],
  ["PUBG Mobile", "https://news.google.com/rss/search?q=PUBG+Mobile+esports+tournament&hl=en-US&gl=US&ceid=US:en"],
  ["Valorant", "https://news.google.com/rss/search?q=Valorant+esports&hl=en-US&gl=US&ceid=US:en"],
  ["Valorant", "https://news.google.com/rss/search?q=Valorant+tournament&hl=en-US&gl=US&ceid=US:en"],
  ["Football Esports", "https://news.google.com/rss/search?q=football+esports+gaming&hl=en-US&gl=US&ceid=US:en"],
  ["Esports Lainnya", "https://news.google.com/rss/search?q=esports+gaming+tournament&hl=id&gl=ID&ceid=ID:id"],
  ["Esports Lainnya", "https://news.google.com/rss/search?q=esports+news&hl=en-US&gl=US&ceid=US:en"]
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

const MAX_NEWS = 30;
const MAX_FEED_SIZE = 5 * 1024 * 1024;
const MAX_ARTICLE_SIZE = 3 * 1024 * 1024;
const FEED_TIMEOUT = 9000;
const ARTICLE_TIMEOUT = 3000;
const IMAGE_LOOKUP_LIMIT = 6;
const IMAGE_WORKERS = 3;
const MAX_REDIRECTS = 4;

/* =====================================
   VALIDASI ALAMAT INTERNET
===================================== */

function isPublicIP(address) {
  const version = net.isIP(address);

  if (version === 4) {
    const p = address.split(".").map(Number);

    if (p.length !== 4) return false;

    const [a, b] = p;

    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    ) {
      return false;
    }

    return true;
  }

  if (version === 6) {
    const ip = address.toLowerCase();

    if (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip) ||
      ip.startsWith("ff") ||
      ip.startsWith("2001:db8:")
    ) {
      return false;
    }

    // IPv4-mapped IPv6
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);

    if (mapped) {
      return isPublicIP(mapped[1]);
    }

    return true;
  }

  return false;
}

async function validatePublicUrl(value, baseUrl) {
  let parsed;

  try {
    parsed = new URL(value, baseUrl);
  } catch {
    throw new Error("URL tidak valid");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Protokol URL tidak diizinkan");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URL dengan kredensial tidak diizinkan");
  }

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/\.$/, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Host tujuan tidak diizinkan");
  }

  const ipVersion = net.isIP(hostname);

  if (ipVersion) {
    if (!isPublicIP(hostname)) {
      throw new Error("Alamat IP tujuan tidak diizinkan");
    }
  } else {
    const records = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });

    if (
      !records.length ||
      records.some(record => !isPublicIP(record.address))
    ) {
      throw new Error("Alamat host tujuan tidak diizinkan");
    }
  }

  return parsed;
}

/* =====================================
   TEXT DAN XML
===================================== */

function decodeEntities(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    });
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTag(block, tag) {
  const escaped = escapeRegex(tag);

  const match = block.match(
    new RegExp(
      `<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`,
      "i"
    )
  );

  return match ? decodeEntities(match[1].trim()) : "";
}

function getAttributes(tag) {
  const attrs = {};

  const regex =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] =
      decodeEntities(match[2] ?? match[3] ?? "");
  }

  return attrs;
}

/* =====================================
   VALIDASI GAMBAR
===================================== */

function validImage(url, baseUrl) {
  if (!url || typeof url !== "string") return null;

  try {
    const parsed = new URL(
      decodeEntities(url).trim(),
      baseUrl
    );

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    const blockedHosts = [
      "news.google.com",
      "google.com",
      "gstatic.com",
      "googleusercontent.com"
    ];

    if (
      blockedHosts.some(
        domain => host === domain || host.endsWith("." + domain)
      )
    ) {
      return null;
    }

    if (
      /logo|favicon|avatar|placeholder|default-image|no-image|sprite|tracking|pixel|blank/.test(path)
    ) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

/* =====================================
   MEMBACA RESPONS DENGAN BATAS UKURAN
===================================== */

async function readLimited(response, maxSize) {
  const contentLength = Number(
    response.headers.get("content-length") || 0
  );

  if (contentLength > maxSize) {
    await response.body?.cancel();
    throw new Error("Respons terlalu besar");
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > maxSize) {
        await reader.cancel();
        throw new Error("Respons melewati batas ukuran");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(combined);
}

/* =====================================
   FETCH AMAN DENGAN TIMEOUT DAN REDIRECT
===================================== */

async function fetchTextWithTimeout(
  url,
  timeout = 7000,
  maxSize = MAX_ARTICLE_SIZE
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    let currentUrl = url;

    for (let redirectCount = 0; ; redirectCount++) {
      const parsed = await validatePublicUrl(currentUrl);

      const response = await fetch(parsed.href, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"
        }
      });

      if (
        [301, 302, 303, 307, 308].includes(response.status)
      ) {
        const location = response.headers.get("location");

        await response.body?.cancel();

        if (!location || redirectCount >= MAX_REDIRECTS) {
          throw new Error("Redirect tidak valid atau terlalu banyak");
        }

        currentUrl = new URL(location, parsed.href).href;
        continue;
      }

      const text = await readLimited(response, maxSize);

      return {
        ok: response.ok,
        status: response.status,
        url: parsed.href,
        contentType:
          response.headers.get("content-type") || "",
        text
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/* =====================================
   EKSTRAK GAMBAR HTML
===================================== */

function extractImageFromHTML(html, baseUrl) {
  if (!html) return null;

  const candidates = [];

  function addCandidate(url, score) {
    const image = validImage(url, baseUrl);

    if (!image) return;

    const existing = candidates.find(
      item => item.url === image
    );

    if (existing) {
      existing.score = Math.max(existing.score, score);
    } else {
      candidates.push({ url: image, score });
    }
  }

  // Open Graph dan Twitter
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ""
    ).toLowerCase();

    if (key === "og:image" || key === "og:image:url") {
      addCandidate(attrs.content, 110);
    }

    if (
      key === "twitter:image" ||
      key === "twitter:image:src"
    ) {
      addCandidate(attrs.content, 100);
    }

    if (key === "image") {
      addCandidate(attrs.content, 80);
    }
  }

  // JSON-LD
  const scripts = html.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function scanJsonImage(value, depth = 0) {
    if (!value || depth > 10) return;

    if (typeof value === "string") {
      addCandidate(value, 90);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        scanJsonImage(item, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") return;

    for (const key of [
      "url",
      "contentUrl",
      "thumbnailUrl",
      "@id"
    ]) {
      if (value[key] && typeof value[key] === "string") {
        addCandidate(value[key], 90);
      }
    }

    for (const key of [
      "image",
      "thumbnail",
      "@graph",
      "mainEntity",
      "mainEntityOfPage",
      "article",
      "item"
    ]) {
      if (value[key]) {
        scanJsonImage(value[key], depth + 1);
      }
    }
  }

  for (const script of scripts) {
    try {
      const jsonText = script
        .replace(/^<script\b[^>]*>/i, "")
        .replace(/<\/script>$/i, "");

      scanJsonImage(JSON.parse(jsonText));
    } catch {
      // Lewati JSON tidak valid
    }
  }

  // Gambar HTML
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const description = [
      attrs.alt,
      attrs.title,
      attrs.class,
      attrs.id
    ].join(" ").toLowerCase();

    if (
      /logo|avatar|icon|sprite|placeholder|blank|pixel|advertisement/.test(description)
    ) {
      continue;
    }

    const imageUrl =
      attrs["data-src"] ||
      attrs["data-lazy-src"] ||
      attrs["data-original"] ||
      attrs.src;

    addCandidate(imageUrl, 50);

    if (attrs.srcset) {
      for (const item of attrs.srcset.split(",")) {
        const src = item.trim().split(/\s+/)[0];
        addCandidate(src, 45);
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0]?.url || null;
}

/* =====================================
   EKSTRAK GAMBAR RSS
===================================== */

function extractRssImage(block) {
  const mediaTags = block.match(
    /<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi
  ) || [];

  for (const tag of mediaTags) {
    const attrs = getAttributes(tag);

    const image = validImage(
      attrs.url || attrs.href,
      "https://news.google.com"
    );

    if (image) return image;
  }

  const html = [
    getTag(block, "description"),
    getTag(block, "content:encoded")
  ].join(" ");

  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const image = validImage(
      attrs.src ||
      attrs["data-src"] ||
      attrs["data-original"],
      "https://news.google.com"
    );

    if (image) return image;
  }

  return null;
}

/* =====================================
   PARSE RSS
===================================== */

function parseFeed(xml, category) {
  const blocks = xml.match(
    /<item\b[\s\S]*?<\/item>/gi
  ) || [];

  const results = [];

  for (const block of blocks) {
    const title = cleanText(getTag(block, "title"));
    const link = cleanText(getTag(block, "link"));
    const description = getTag(block, "description");
    const source = cleanText(getTag(block, "source"));
    const pubDate = cleanText(getTag(block, "pubDate"));

    if (!title || !link) continue;

    try {
      const parsed = new URL(link);

      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) {
        continue;
      }

      results.push({
        category,
        title,
        link: parsed.href,
        description,
        source,
        pubDate,
        imageUrl: extractRssImage(block)
      });
    } catch {
      continue;
    }
  }

  return results;
}

/* =====================================
   GOOGLE NEWS DAN LINK PENERBIT
===================================== */

function isGoogleNews(url) {
  try {
    return new URL(url).hostname.toLowerCase() ===
      "news.google.com";
  } catch {
    return false;
  }
}

function findPublisherLink(html, baseUrl, title = "") {
  const links = html.match(
    /<a\b[^>]*>[\s\S]*?<\/a>/gi
  ) || [];

  const titleWords = cleanText(title)
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 3);

  const candidates = [];

  for (const tag of links) {
    const openingTag =
      tag.match(/^<a\b[^>]*>/i)?.[0] || "";

    const attrs = getAttributes(openingTag);

    if (!attrs.href) continue;

    try {
      const parsed = new URL(attrs.href, baseUrl);
      const host = parsed.hostname.toLowerCase();

      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        host === "news.google.com" ||
        host === "google.com" ||
        host.endsWith(".google.com") ||
        host.endsWith(".googleusercontent.com") ||
        host.endsWith(".gstatic.com")
      ) {
        continue;
      }

      if (parsed.pathname === "/" && !parsed.search) {
        continue;
      }

      const anchorText = cleanText(tag).toLowerCase();

      let score = 0;

      for (const word of titleWords) {
        if (anchorText.includes(word)) score++;
      }

      // Jangan mengambil link sembarang jika tidak ada
      // kecocokan dengan judul berita.
      if (score > 0) {
        candidates.push({
          url: parsed.href,
          score
        });
      }
    } catch {
      // Lewati URL tidak valid
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0]?.url || null;
}

/* =====================================
   AMBIL GAMBAR ARTIKEL
===================================== */

async function getArticleImage(articleUrl, title) {
  try {
    const googlePage = await fetchTextWithTimeout(
      articleUrl,
      ARTICLE_TIMEOUT,
      MAX_ARTICLE_SIZE
    );

    if (!googlePage.ok) return null;

    let finalUrl = googlePage.url;
    let html = googlePage.text;

    if (!isGoogleNews(finalUrl)) {
      if (
        !googlePage.contentType.toLowerCase().includes("text/html")
      ) {
        return null;
      }

      const image = extractImageFromHTML(html, finalUrl);

      if (image) return image;
    } else {
      const publisherLink = findPublisherLink(
        html,
        finalUrl,
        title
      );

      if (!publisherLink) return null;

      finalUrl = publisherLink;
    }

    const articlePage = await fetchTextWithTimeout(
      finalUrl,
      ARTICLE_TIMEOUT,
      MAX_ARTICLE_SIZE
    );

    if (
      !articlePage.ok ||
      !articlePage.contentType.toLowerCase().includes("text/html")
    ) {
      return null;
    }

    return extractImageFromHTML(
      articlePage.text,
      articlePage.url
    );
  } catch {
    return null;
  }
}

/* =====================================
   ISI GAMBAR KOSONG
===================================== */

async function fillMissingImages(items) {
  const targets = items
    .filter(item => !item.imageUrl)
    .slice(0, IMAGE_LOOKUP_LIMIT);

  let index = 0;

  async function worker() {
    while (index < targets.length) {
      const current = index++;
      const item = targets[current];

      item.imageUrl = await getArticleImage(
        item.link,
        item.title
      );
    }
  }

  const workers = Array.from(
    {
      length: Math.min(IMAGE_WORKERS, targets.length)
    },
    () => worker()
  );

  await Promise.all(workers);

  return items;
}

/* =====================================
   API HANDLER VERCEL
===================================== */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const feedResults = await Promise.all(
      FEEDS.map(async ([category, feedUrl]) => {
        try {
          const result = await fetchTextWithTimeout(
            feedUrl,
            FEED_TIMEOUT,
            MAX_FEED_SIZE
          );

          if (
            !result.ok ||
            !result.contentType.toLowerCase().includes("xml") &&
            !result.contentType.toLowerCase().includes("rss") &&
            !result.contentType.toLowerCase().includes("text/")
          ) {
            return [];
          }

          return parseFeed(result.text, category);
        } catch (error) {
          console.error(
            "RSS_FEED_ERROR:",
            category,
            error.message
          );

          return [];
        }
      })
    );

    // Gabungkan berita dan hilangkan duplikat
    const unique = new Map();

    for (const item of feedResults.flat()) {
      if (!unique.has(item.link)) {
        unique.set(item.link, item);
      }
    }

    const items = [...unique.values()]
      .sort((a, b) => {
        const dateA = Date.parse(a.pubDate) || 0;
        const dateB = Date.parse(b.pubDate) || 0;

        return dateB - dateA;
      })
      .slice(0, MAX_NEWS);

    await fillMissingImages(items);

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      total: items.length,
      items
    });

  } catch (error) {
    console.error(
      "ESPORTS_NEWS_API_ERROR:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil berita esports"
    });
  }
}

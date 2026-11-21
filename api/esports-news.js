const FEEDS = [
  [
    'Mobile Legends',
    'https://news.google.com/rss/search?q=Mobile+Legends+esports&hl=id&gl=ID&ceid=ID:id'
  ],
  [
    'Mobile Legends',
    'https://news.google.com/rss/search?q=Mobile+Legends+esports+tournament&hl=en-US&gl=US&ceid=US:en'
  ],
  [
    'PUBG Mobile',
    'https://news.google.com/rss/search?q=PUBG+Mobile+esports&hl=id&gl=ID&ceid=ID:id'
  ],
  [
    'PUBG Mobile',
    'https://news.google.com/rss/search?q=PUBG+Mobile+esports+tournament&hl=en-US&gl=US&ceid=US:en'
  ],
  [
    'Valorant',
    'https://news.google.com/rss/search?q=Valorant+esports&hl=en-US&gl=US&ceid=US:en'
  ],
  [
    'Valorant',
    'https://news.google.com/rss/search?q=Valorant+tournament&hl=en-US&gl=US&ceid=US:en'
  ],
  [
    'Football Esports',
    'https://news.google.com/rss/search?q=football+esports+gaming&hl=en-US&gl=US&ceid=US:en'
  ],
  [
    'Esports Lainnya',
    'https://news.google.com/rss/search?q=esports+gaming+tournament&hl=id&gl=ID&ceid=ID:id'
  ],
  [
    'Esports Lainnya',
    'https://news.google.com/rss/search?q=esports+news&hl=en-US&gl=US&ceid=US:en'
  ]
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

const MAX_NEWS = 30;
const FEED_TIMEOUT = 10000;
const ARTICLE_TIMEOUT = 8000;
const IMAGE_WORKERS = 3;

/* =====================================
   TEXT DAN XML
===================================== */

function decodeEntities(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return '';
      }
    });
}

function cleanText(value = '') {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTag(block, tag) {
  const escaped = escapeRegex(tag);

  const match = block.match(
    new RegExp(
      `<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`,
      'i'
    )
  );

  return match ? decodeEntities(match[1].trim()) : '';
}

function getAttributes(tag) {
  const attrs = {};

  const regex =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] =
      decodeEntities(match[2] ?? match[3] ?? '');
  }

  return attrs;
}

/* =====================================
   VALIDASI GAMBAR
===================================== */

function validImage(url, baseUrl) {
  if (!url || typeof url !== 'string') return null;

  try {
    const clean = decodeEntities(url)
      .trim()
      .replace(/&amp;/g, '&');

    if (
      !clean ||
      /^(data:|blob:|javascript:)/i.test(clean)
    ) {
      return null;
    }

    const absolute = new URL(clean, baseUrl);

    if (!['http:', 'https:'].includes(absolute.protocol)) {
      return null;
    }

    const host = absolute.hostname.toLowerCase();
    const path = absolute.pathname.toLowerCase();

    // Hindari gambar generik Google News
    if (
      host === 'news.google.com' ||
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'gstatic.com' ||
      host.endsWith('.gstatic.com') ||
      host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com')
    ) {
      return null;
    }

    if (
      /logo|favicon|avatar|placeholder|default-image|no-image|sprite|tracking|pixel/.test(
        path
      )
    ) {
      return null;
    }

    return absolute.href;
  } catch {
    return null;
  }
}

/* =====================================
   EKSTRAK GAMBAR DARI HTML ARTIKEL
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
      candidates.push({
        url: image,
        score
      });
    }
  }

  // 1. Open Graph dan Twitter Card
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = getAttributes(tag);

    const key = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ''
    ).toLowerCase();

    if (key === 'og:image' || key === 'og:image:url') {
      addCandidate(attrs.content, 100);
    }

    if (
      key === 'twitter:image' ||
      key === 'twitter:image:src'
    ) {
      addCandidate(attrs.content, 90);
    }

    if (key === 'image') {
      addCandidate(attrs.content, 70);
    }
  }

  // 2. JSON-LD
  const scripts =
    html.match(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
    ) || [];

  function scanJsonImage(value, depth = 0) {
    if (!value || depth > 8) return;

    if (typeof value === 'string') {
      addCandidate(value, 80);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        scanJsonImage(item, depth + 1);
      }
      return;
    }

    if (typeof value !== 'object') return;

    for (const key of [
      'image',
      'thumbnailUrl',
      'thumbnail',
      'contentUrl'
    ]) {
      if (value[key]) {
        scanJsonImage(value[key], depth + 1);
      }
    }

    for (const key of [
      '@graph',
      'mainEntity',
      'mainEntityOfPage',
      'article',
      'item'
    ]) {
      if (value[key]) {
        scanJsonImage(value[key], depth + 1);
      }
    }
  }

  for (const script of scripts) {
    try {
      const jsonText = script
        .replace(/^<script\b[^>]*>/i, '')
        .replace(/<\/script>$/i, '');

      scanJsonImage(JSON.parse(jsonText));
    } catch {
      // Lewati JSON yang rusak
    }
  }

  // 3. Gambar artikel dan lazy loading
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const description = [
      attrs.alt,
      attrs.title,
      attrs.class,
      attrs.id
    ]
      .join(' ')
      .toLowerCase();

    if (
      /logo|avatar|icon|sprite|placeholder|blank|pixel|advertisement/.test(
        description
      )
    ) {
      continue;
    }

    const imageUrl =
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'] ||
      attrs.src;

    addCandidate(imageUrl, 50);
  }

  // Pilih gambar dengan prioritas tertinggi
  candidates.sort((a, b) => b.score - a.score);

  return candidates[0]?.url || null;
}

/* =====================================
   EKSTRAK GAMBAR DARI RSS
===================================== */

function extractRssImage(block) {
  const mediaTags =
    block.match(
      /<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi
    ) || [];

  for (const tag of mediaTags) {
    const attrs = getAttributes(tag);

    const image = validImage(
      attrs.url || attrs.href,
      'https://news.google.com'
    );

    if (image) return image;
  }

  const description = [
    getTag(block, 'description'),
    getTag(block, 'content:encoded')
  ].join(' ');

  const imageTags =
    description.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const image = validImage(
      attrs.src ||
      attrs['data-src'] ||
      attrs['data-original'],
      'https://news.google.com'
    );

    if (image) return image;
  }

  return null;
}

/* =====================================
   PARSE RSS GOOGLE NEWS
===================================== */

function parseFeed(xml, category) {
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  const results = [];

  for (const block of blocks) {
    const title = cleanText(getTag(block, 'title'));
    const link = cleanText(getTag(block, 'link'));
    const description = getTag(block, 'description');
    const source = cleanText(getTag(block, 'source'));
    const pubDate = cleanText(getTag(block, 'pubDate'));

    if (!title || !link) continue;

    let safeLink;

    try {
      const parsed = new URL(link);

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        continue;
      }

      safeLink = parsed.href;
    } catch {
      continue;
    }

    results.push({
      category,
      title,
      link: safeLink,
      description,
      source,
      pubDate,
      imageUrl: extractRssImage(block)
    });
  }

  return results;
}

/* =====================================
   FETCH DENGAN TIMEOUT
===================================== */

async function fetchTextWithTimeout(url, timeout = 7000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':
          'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType:
        response.headers.get('content-type') || '',
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

/* =====================================
   GOOGLE NEWS DAN LINK PENERBIT
===================================== */

function isGoogleNews(url) {
  try {
    return new URL(url).hostname === 'news.google.com';
  } catch {
    return false;
  }
}

function findPublisherLink(html, baseUrl) {
  const links = html.match(/<a\b[^>]*>/gi) || [];

  for (const tag of links) {
    const attrs = getAttributes(tag);
    const href = attrs.href;

    if (!href) continue;

    try {
      const parsed = new URL(href, baseUrl);
      const host = parsed.hostname.toLowerCase();

      if (
        ['http:', 'https:'].includes(parsed.protocol) &&
        host !== 'news.google.com' &&
        host !== 'google.com' &&
        !host.endsWith('.google.com') &&
        !host.endsWith('.googleusercontent.com')
      ) {
        return parsed.href;
      }
    } catch {
      // Lewati link yang tidak valid
    }
  }

  return null;
}

/* =====================================
   AMBIL GAMBAR ARTIKEL ASLI
===================================== */

async function getArticleImage(articleUrl) {
  try {
    const googlePage = await fetchTextWithTimeout(
      articleUrl,
      ARTICLE_TIMEOUT
    );

    if (!googlePage.ok) return null;

    let finalUrl = googlePage.url;
    let html = googlePage.text;

    // Jika masih Google News, cari link penerbit
    if (isGoogleNews(finalUrl)) {
      const publisherLink = findPublisherLink(
        html,
        finalUrl
      );

      if (!publisherLink) return null;

      finalUrl = publisherLink;
    } else {
      // Jika sudah diarahkan ke penerbit, gunakan HTML ini
      const directImage = extractImageFromHTML(
        html,
        finalUrl
      );

      if (directImage) return directImage;
    }

    // Ambil halaman penerbit
    const articlePage = await fetchTextWithTimeout(
      finalUrl,
      ARTICLE_TIMEOUT
    );

    if (!articlePage.ok) return null;

    if (
      !articlePage.contentType.toLowerCase().includes(
        'text/html'
      )
    ) {
      return null;
    }

    return extractImageFromHTML(
      articlePage.text,
      articlePage.url || finalUrl
    );
  } catch {
    return null;
  }
}

/* =====================================
   ISI GAMBAR YANG MASIH KOSONG
===================================== */

async function fillMissingImages(items) {
  const targets = items.filter(
    item => !item.imageUrl
  );

  let index = 0;

  async function worker() {
    while (index < targets.length) {
      const current = index++;
      const item = targets[current];

      item.imageUrl = await getArticleImage(
        item.link
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
  // CORS
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  res.setHeader(
    'Cache-Control',
    'public, s-maxage=300, stale-while-revalidate=600'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  try {
    // Ambil semua RSS secara bersamaan
    const feedResults = await Promise.all(
      FEEDS.map(async ([category, feedUrl]) => {
        try {
          const result = await fetchTextWithTimeout(
            feedUrl,
            FEED_TIMEOUT
          );

          if (!result.ok) return [];

          return parseFeed(
            result.text,
            category
          );
        } catch (error) {
          console.error(
            'RSS feed error:',
            category,
            error.message
          );

          return [];
        }
      })
    );

    // Gabungkan dan hilangkan duplikat
    const unique = new Map();

    for (const item of feedResults.flat()) {
      const key = item.link;

      if (!unique.has(key)) {
        unique.set(key, item);
      }
    }

    // Urutkan berita terbaru
    const items = [...unique.values()]
      .sort((a, b) => {
        const dateA = Date.parse(a.pubDate) || 0;
        const dateB = Date.parse(b.pubDate) || 0;

        return dateB - dateA;
      })
      .slice(0, MAX_NEWS);

    // Cari gambar untuk berita yang belum punya gambar
    await fillMissingImages(items);

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      total: items.length,
      items
    });
  } catch (error) {
    console.error(
      'Esports news API error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil berita esports'
    });
  }
}

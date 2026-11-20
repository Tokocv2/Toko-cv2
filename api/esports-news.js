
const FEEDS = [
  ['Mobile Legends', 'https://news.google.com/rss/search?q=Mobile+Legends+esports&hl=id&gl=ID&ceid=ID:id'],
  ['Mobile Legends', 'https://news.google.com/rss/search?q=Mobile+Legends+esports+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['PUBG Mobile', 'https://news.google.com/rss/search?q=PUBG+Mobile+esports&hl=id&gl=ID&ceid=ID:id'],
  ['PUBG Mobile', 'https://news.google.com/rss/search?q=PUBG+Mobile+esports+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['Valorant', 'https://news.google.com/rss/search?q=Valorant+esports&hl=en-US&gl=US&ceid=US:en'],
  ['Valorant', 'https://news.google.com/rss/search?q=Valorant+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['Football Esports', 'https://news.google.com/rss/search?q=football+esports+gaming&hl=en-US&gl=US&ceid=US:en'],
  ['Esports Lainnya', 'https://news.google.com/rss/search?q=esports+gaming+tournament&hl=id&gl=ID&ceid=ID:id'],
  ['Esports Lainnya', 'https://news.google.com/rss/search?q=esports+news&hl=en-US&gl=US&ceid=US:en']
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

function decodeEntities(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function cleanText(value = '') {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(
    new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i')
  );
  return match ? decodeEntities(match[1].trim()) : '';
}

function getAttributes(tag) {
  const attrs = {};
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g;
  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2]);
  }

  return attrs;
}

function validImage(url, baseUrl) {
  if (!url) return null;

  try {
    const clean = decodeEntities(url).trim();
    if (!clean || /^(data:|blob:|javascript:)/i.test(clean)) return null;

    const absolute = new URL(clean, baseUrl).href;

    if (!/^https?:\/\//i.test(absolute)) return null;
    if (/google\.com\/(images|logos)/i.test(absolute)) return null;

    return absolute;
  } catch {
    return null;
  }
}

function extractImageFromHTML(html, baseUrl) {
  if (!html) return null;

  // 1. Open Graph dan Twitter Card
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = getAttributes(tag);
    const key = (attrs.property || attrs.name || '').toLowerCase();

    if (
      [
        'og:image',
        'og:image:url',
        'twitter:image',
        'twitter:image:src'
      ].includes(key)
    ) {
      const image = validImage(
        attrs.content || attrs['data-src'],
        baseUrl
      );

      if (image) return image;
    }
  }

  // 2. JSON-LD
  const scripts =
    html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];

  function findJsonImage(value) {
    if (!value) return null;

    if (typeof value === 'string') {
      return validImage(value, baseUrl);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findJsonImage(item);
        if (found) return found;
      }
    }

    if (typeof value === 'object') {
      for (const key of ['image', 'thumbnailUrl', 'thumbnail']) {
        if (value[key]) {
          const found = findJsonImage(value[key]);
          if (found) return found;
        }
      }

      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
        if (value[key]) {
          const found = findJsonImage(value[key]);
          if (found) return found;
        }
      }
    }

    return null;
  }

  for (const script of scripts) {
    try {
      const json = script
        .replace(/^<script\b[^>]*>/i, '')
        .replace(/<\/script>$/i, '');

      const found = findJsonImage(JSON.parse(decodeEntities(json)));
      if (found) return found;
    } catch {}
  }

  // 3. Gambar artikel biasa dan lazy-loaded
  const images = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of images) {
    const attrs = getAttributes(tag);

    const candidate =
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'] ||
      attrs.src;

    if (!candidate) continue;

    const description = [
      attrs.alt,
      attrs.class,
      attrs.id,
      candidate
    ].join(' ').toLowerCase();

    if (
      /logo|avatar|icon|sprite|placeholder|blank|tracking|pixel/.test(description)
    ) {
      continue;
    }

    const image = validImage(candidate, baseUrl);
    if (image) return image;
  }

  return null;
}

function extractRssImage(block) {
  const mediaTags =
    block.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi) || [];

  for (const tag of mediaTags) {
    const attrs = getAttributes(tag);
    const image = validImage(
      attrs.url || attrs.href,
      'https://news.google.com'
    );

    if (image) return image;
  }

  const html = [
    getTag(block, 'description'),
    getTag(block, 'content:encoded')
  ].join(' ');

  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);
    const image = validImage(
      attrs.src || attrs['data-src'] || attrs['data-original'],
      'https://news.google.com'
    );

    if (image) return image;
  }

  return null;
}

function parseFeed(xml, category) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items.map(block => {
    const title = cleanText(getTag(block, 'title'));
    const link = cleanText(getTag(block, 'link'));
    const description = getTag(block, 'description');
    const source = cleanText(getTag(block, 'source'));
    const pubDate = cleanText(getTag(block, 'pubDate'));

    return {
      category,
      title,
      link,
      description,
      source,
      pubDate,
      imageUrl: extractRssImage(block)
    };
  }).filter(item => item.title && item.link);
}

async function fetchWithTimeout(url, timeout = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function isGoogleNews(url) {
  try {
    return new URL(url).hostname.endsWith('news.google.com');
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
      const absolute = new URL(href, baseUrl);

      if (
        /^https?:$/.test(absolute.protocol) &&
        !absolute.hostname.endsWith('google.com') &&
        !absolute.hostname.endsWith('googleusercontent.com')
      ) {
        return absolute.href;
      }
    } catch {}
  }

  return null;
}

async function getArticleImage(googleNewsUrl) {
  try {
    // Langkah 1: ikuti pengalihan Google News
    const googleResponse = await fetchWithTimeout(googleNewsUrl, 7000);

    if (!googleResponse.ok) return null;

    const googleHtml = await googleResponse.text();
    let articleUrl = googleResponse.url || googleNewsUrl;

    // Langkah 2: jika masih di Google News, cari tautan penerbit
    if (isGoogleNews(articleUrl)) {
      const publisherLink = findPublisherLink(
        googleHtml,
        articleUrl
      );

      if (publisherLink) {
        articleUrl = publisherLink;
      } else {
        return extractImageFromHTML(googleHtml, articleUrl);
      }
    }

    // Langkah 3: ambil halaman artikel asli
    const articleResponse = await fetchWithTimeout(articleUrl, 7000);

    if (!articleResponse.ok) return null;

    const contentType =
      articleResponse.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) return null;

    const articleHtml = await articleResponse.text();
    const finalUrl = articleResponse.url || articleUrl;

    return extractImageFromHTML(articleHtml, finalUrl);
  } catch (error) {
    return null;
  }
}

async function fillMissingImages(items) {
  const targets = items.filter(item => !item.imageUrl);
  let index = 0;

  const workers = Array.from({ length: 5 }, async () => {
    while (index < targets.length) {
      const item = targets[index++];

      item.imageUrl = await getArticleImage(item.link);
    }
  });

  await Promise.all(workers);
  return items;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Cache-Control',
    'public, s-maxage=300, stale-while-revalidate=600'
  );

  try {
    const results = await Promise.all(
      FEEDS.map(async ([category, url]) => {
        try {
          const response = await fetchWithTimeout(url, 8000);

          if (!response.ok) return [];

          const xml = await response.text();
          return parseFeed(xml, category);
        } catch {
          return [];
        }
      })
    );

    const unique = new Map();

    for (const item of results.flat()) {
      const key = item.link;

      if (!unique.has(key)) {
        unique.set(key, item);
      }
    }

    const items = [...unique.values()]
      .sort((a, b) => {
        return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
      })
      .slice(0, 30);

    await fillMissingImages(items);

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      total: items.length,
      items
    });
  } catch (error) {
    console.error('Esports news error:', error);

    return res.status(500).json({
      success: false,
      message: 'Gagal mengambil berita esports'
    });
  }
    }
        

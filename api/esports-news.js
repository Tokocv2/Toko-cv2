
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
  if (!url || typeof url !== 'string') return null;

  try {
    const clean = decodeEntities(url).trim();

    if (
      !clean ||
      /^(data:|blob:|javascript:)/i.test(clean) ||
      /^(#|\/\/$)/.test(clean)
    ) {
      return null;
    }

    const absolute = new URL(clean, baseUrl);

    if (!['http:', 'https:'].includes(absolute.protocol)) return null;

    const fullUrl = absolute.href;
    const hostname = absolute.hostname.toLowerCase();
    const path = absolute.pathname.toLowerCase();

    if (
      hostname === 'news.google.com' ||
      /\/(logos?|icons?|avatars?|favicons?)\//i.test(path) ||
      /(logo|avatar|favicon|sprite|placeholder|blank|pixel|tracking)/i.test(path) ||
      /\.(svg)(\?|$)/i.test(fullUrl)
    ) {
      return null;
    }

    return fullUrl;
  } catch {
    return null;
  }
}

function extractImageFromHTML(html, baseUrl) {
  if (!html) return null;

  const candidates = [];

  function addCandidate(url, score) {
    const image = validImage(url, baseUrl);
    if (!image) return;

    const existing = candidates.find(item => item.url === image);

    if (existing) {
      existing.score = Math.max(existing.score, score);
    } else {
      candidates.push({ url: image, score });
    }
  }

  // 1. Open Graph dan Twitter Card
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = getAttributes(tag);
    const key = (attrs.property || attrs.name || '').toLowerCase();

    if (key === 'og:image' || key === 'og:image:url') {
      addCandidate(attrs.content, 100);
    } else if (
      key === 'twitter:image' ||
      key === 'twitter:image:src'
    ) {
      addCandidate(attrs.content, 90);
    }
  }

  // 2. JSON-LD
  const scripts = html.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function scanJson(value) {
    if (!value) return;

    if (typeof value === 'string') {
      addCandidate(value, 80);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(scanJson);
      return;
    }

    if (typeof value === 'object') {
      for (const key of ['image', 'thumbnailUrl', 'thumbnail']) {
        const entry = value[key];

        if (typeof entry === 'string') {
          addCandidate(entry, 80);
        } else if (entry) {
          scanJson(entry);
        }
      }

      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
        if (value[key]) scanJson(value[key]);
      }
    }
  }

  for (const script of scripts) {
    try {
      const json = script
        .replace(/^<script\b[^>]*>/i, '')
        .replace(/<\/script>$/i, '');

      scanJson(JSON.parse(decodeEntities(json)));
    } catch {}
  }

  // 3. Gambar artikel dan lazy loading
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imgTags) {
    const attrs = getAttributes(tag);

    const candidate =
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'] ||
      attrs.src ||
      attrs.srcset?.split(',')[0]?.trim().split(/\s+/)[0];

    const description = [
      attrs.alt,
      attrs.class,
      attrs.id,
      candidate
    ].join(' ').toLowerCase();

    if (
      /logo|avatar|icon|sprite|placeholder|blank|tracking|pixel|favicon/.test(description)
    ) {
      continue;
    }

    addCandidate(candidate, 50);
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates[0]?.url || null;
}

function extractRssImage(block) {
  const mediaTags =
    block.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi) || [];

  
function extractRssImage(block) {
  const mediaTags =
    block.match(/<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi) || [];

  for (const tag of mediaTags) {
    const attrs = getAttributes(tag);
    const url = attrs.url || attrs.href;

    if (!url) continue;

    // Hindari thumbnail generik Google News
    try {
      const host = new URL(url, 'https://news.google.com').hostname;

      if (
        host === 'lh3.googleusercontent.com' ||
        host.endsWith('.googleusercontent.com')
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const image = validImage(url, 'https://news.google.com');

    if (image) return image;
  }

  const html = [
    getTag(block, 'description'),
    getTag(block, 'content:encoded')
  ].join(' ');

  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const description = [
      attrs.alt,
      attrs.class,
      attrs.id
    ].join(' ').toLowerCase();

    if (/logo|avatar|icon|sprite|placeholder|blank|pixel/.test(description)) {
      continue;
    }

    const url =
      attrs.src ||
      attrs['data-src'] ||
      attrs['data-original'];

    if (!url) continue;

    try {
      const host = new URL(url, 'https://news.google.com').hostname;

      if (
        host === 'lh3.googleusercontent.com' ||
        host.endsWith('.googleusercontent.com')
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const image = validImage(url, 'https://news.google.com');

    if (image) return image;
  }

  return null;
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

async function getArticleImage(articleUrl) {
  try {
    const response = await fetchWithTimeout(articleUrl, 7000);

    if (!response.ok) return null;

    const finalUrl = response.url || articleUrl;

    if (isGoogleNews(finalUrl)) {
      const googleHtml = await response.text();
      const publisherLink = findPublisherLink(googleHtml, finalUrl);

      if (!publisherLink) {
        return extractImageFromHTML(googleHtml, finalUrl);
      }

      const publisherResponse = await fetchWithTimeout(publisherLink, 7000);

      if (!publisherResponse.ok) return null;

      const contentType =
        publisherResponse.headers.get('content-type') || '';

      if (!contentType.includes('text/html')) return null;

      const publisherHtml = await publisherResponse.text();

      return extractImageFromHTML(
        publisherHtml,
        publisherResponse.url || publisherLink
      );
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) return null;

    const html = await response.text();

    return extractImageFromHTML(html, finalUrl);
  } catch {
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
      if (!unique.has(item.link)) {
        unique.set(item.link, item);
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
                                      

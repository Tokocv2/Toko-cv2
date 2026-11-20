
const FEEDS = [
  ['Mobile Legends', 'https://news.google.com/rss/search?q=Mobile+Legends+esports&hl=id&gl=ID&ceid=ID:id'],
  ['Mobile Legends', 'https://news.google.com/rss/search?q=Mobile+Legends+esports+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['PUBG Mobile', 'https://news.google.com/rss/search?q=PUBG+Mobile+esports&hl=id&gl=ID&ceid=ID:id'],
  ['PUBG Mobile', 'https://news.google.com/rss/search?q=PUBG+Mobile+esports+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['Valorant', 'https://news.google.com/rss/search?q=Valorant+esports&hl=id&gl=ID&ceid=ID:id'],
  ['Valorant', 'https://news.google.com/rss/search?q=Valorant+Champions+Tour&hl=en-US&gl=US&ceid=US:en'],
  ['Football Esports', 'https://news.google.com/rss/search?q=football+esports+FC+Mobile+eFootball&hl=id&gl=ID&ceid=ID:id'],
  ['Football Esports', 'https://news.google.com/rss/search?q=EA+Sports+FC+esports+eFootball+tournament&hl=en-US&gl=US&ceid=US:en'],
  ['Esports Lainnya', 'https://news.google.com/rss/search?q=esports+gaming+tournament&hl=en-US&gl=US&ceid=US:en']
];

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
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

function getRawTag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const match = block.match(new RegExp(
    '<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)</' +
    escaped + '>',
    'i'
  ));

  return match ? match[1] : '';
}

function getTag(block, name) {
  return cleanText(getRawTag(block, name));
}

function getAttributes(tag) {
  const attrs = {};
  const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = regex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] =
      decodeEntities(match[2] ?? match[3] ?? '');
  }

  return attrs;
}

function validImage(url, baseUrl) {
  if (!url) return '';

  try {
    const image = new URL(url.trim(), baseUrl);

    if (!['http:', 'https:'].includes(image.protocol)) {
      return '';
    }

    if (/^data:/i.test(url)) return '';

    return image.href;
  } catch (_) {
    return '';
  }
}

function extractImageFromHTML(html, baseUrl) {
  if (!html) return '';

  const decoded = decodeEntities(html);

  // 1. Cari gambar dari Open Graph dan Twitter Card.
  const metaTags = decoded.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const attrs = getAttributes(tag);

    const property = (
      attrs.property ||
      attrs.name ||
      attrs.itemprop ||
      ''
    ).toLowerCase();

    if (
      property === 'og:image' ||
      property === 'og:image:url' ||
      property === 'twitter:image' ||
      property === 'twitter:image:src'
    ) {
      const image = validImage(
        attrs.content || attrs.src,
        baseUrl
      );

      if (image) return image;
    }
  }

  // 2. Cari gambar dari JSON-LD artikel.
  const scripts = decoded.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  ) || [];

  function findJsonImage(data) {
    if (!data) return '';

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = findJsonImage(item);
        if (result) return result;
      }
      return '';
    }

    if (typeof data === 'object') {
      const image = data.image || data.thumbnailUrl;

      if (typeof image === 'string') return image;

      if (Array.isArray(image)) {
        for (const item of image) {
          const result = findJsonImage({ image: item });
          if (result) return result;
        }
      }

      if (image && typeof image === 'object') {
        const result = image.url || image.contentUrl;
        if (typeof result === 'string') return result;
      }

      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) {
        const result = findJsonImage(data[key]);
        if (result) return result;
      }
    }

    return '';
  }

  for (const script of scripts) {
    try {
      const jsonText = script
        .replace(/^<script\b[^>]*>/i, '')
        .replace(/<\/script>$/i, '');

      const data = JSON.parse(jsonText);
      const image = validImage(findJsonImage(data), baseUrl);

      if (image) return image;
    } catch (_) {}
  }

  // 3. Cari gambar dari tag IMG.
  const imageTags = decoded.match(/<img\b[^>]*>/gi) || [];

  for (const tag of imageTags) {
    const attrs = getAttributes(tag);

    const candidates = [
      attrs['data-src'],
      attrs['data-lazy-src'],
      attrs['data-original'],
      attrs.src
    ];

    for (const candidate of candidates) {
      const image = validImage(candidate, baseUrl);

      if (
        image &&
        !/logo|icon|avatar|sprite|placeholder|blank/i.test(image)
      ) {
        return image;
      }
    }
  }

  return '';
}

function extractRssImage(block) {
  // Cari media:thumbnail, media:content, dan enclosure.
  const mediaTags = block.match(
    /<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi
  ) || [];

  for (const tag of mediaTags) {
    const attrs = getAttributes(tag);

    const image = validImage(
      attrs.url || attrs.href
    );

    if (image) return image;
  }

  // Cari gambar di description dan content:encoded.
  const description = getRawTag(block, 'description');
  const content = getRawTag(block, 'content:encoded');

  const image1 = extractImageFromHTML(description);
  if (image1) return image1;

  const image2 = extractImageFromHTML(content);
  if (image2) return image2;

  // Cari gambar di seluruh item RSS.
  return extractImageFromHTML(block);
}

function parseFeed(xml, category) {
  const chunks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return chunks.map(block => ({
    category,
    title: getTag(block, 'title'),
    link: getTag(block, 'link'),
    description: getTag(block, 'description').slice(0, 260),
    source: getTag(block, 'source') || 'Google News',
    pubDate: getTag(block, 'pubDate'),
    imageUrl: extractRssImage(block) || ''
  })).filter(item =>
    item.title &&
    /^https?:\/\//i.test(item.link)
  );
}

async function fetchWithTimeout(url, options = {}, timeout = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getArticleImage(articleUrl) {
  try {
    const response = await fetchWithTimeout(
      articleUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        }
      },
      5500
    );

    if (!response.ok) return '';

    const contentType =
      response.headers.get('content-type') || '';

    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return '';
    }

    const html = await response.text();

    return extractImageFromHTML(
      html,
      response.url || articleUrl
    );
  } catch (_) {
    return '';
  }
}

async function fillMissingImages(items) {
  const candidates = items
    .filter(item => !item.imageUrl)
    .slice(0, 20);

  let index = 0;

  async function worker() {
    while (index < candidates.length) {
      const item = candidates[index++];

      const image = await getArticleImage(item.link);

      if (image) {
        item.imageUrl = image;
      }
    }
  }

  await Promise.all(
    Array.from({ length: 5 }, () => worker())
  );

  return items;
}

module.exports = async function (req, res) {
  res.setHeader(
    'Cache-Control',
    's-maxage=600, stale-while-revalidate=1800'
  );

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
      items: []
    });
  }

  try {
    const results = await Promise.all(
      FEEDS.map(async ([category, url]) => {
        try {
          const response = await fetchWithTimeout(
            url,
            {
              headers: {
                'User-Agent': 'TOKOCV2-EsportsNews/2.0'
              }
            },
            7000
          );

          if (!response.ok) return [];

          const xml = await response.text();

          return parseFeed(xml, category);
        } catch (_) {
          return [];
        }
      })
    );

    const seen = new Set();

    const items = results.flat()
      .filter(item => {
        if (seen.has(item.link)) return false;

        seen.add(item.link);
        return true;
      })
      .sort((a, b) =>
        new Date(b.pubDate) - new Date(a.pubDate)
      )
      .slice(0, 40);

    await fillMissingImages(items);

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      items
    });

  } catch (error) {
    console.error('TOKOCV2 NEWS ERROR:', error);

    return res.status(500).json({
      error: 'Feed esports sementara tidak tersedia',
      items: []
    });
  }
};
    

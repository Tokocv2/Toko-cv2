
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

function getTag(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(
    '<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)</' +
    escaped + '>',
    'i'
  ));

  return match ? cleanText(match[1]) : '';
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
  if (!url) return '';

  try {
    const result = new URL(url, baseUrl);

    if (!['http:', 'https:'].includes(result.protocol)) {
      return '';
    }

    return result.href;
  } catch (_) {
    return '';
  }
}

function extractRssImage(block) {
  // Cari gambar dari media:thumbnail, media:content, dan enclosure.
  const mediaTags = block.match(
    /<(?:media:thumbnail|media:content|enclosure)\b[^>]*>/gi
  ) || [];

  for (const mediaTag of mediaTags) {
    const attrs = getAttributes(mediaTag);
    const image = validImage(attrs.url);

    if (image) return image;
  }

  // Cari gambar dari description atau content:encoded.
  const imageTags = block.match(/<img\b[^>]*>/gi) || [];

  for (const imageTag of imageTags) {
    const attrs = getAttributes(imageTag);
    const image = validImage(
      attrs.src || attrs['data-src'] || attrs['data-original']
    );

    if (image) return image;
  }

  // Coba cari gambar dalam deskripsi yang di-escape XML.
  const decoded = decodeEntities(block);
  const embeddedImages = decoded.match(/<img\b[^>]*>/gi) || [];

  for (const imageTag of embeddedImages) {
    const attrs = getAttributes(imageTag);
    const image = validImage(
      attrs.src || attrs['data-src'] || attrs['data-original']
    );

    if (image) return image;
  }

  return '';
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
    imageUrl: extractRssImage(block)
  })).filter(item =>
    item.title &&
    /^https?:\/\//i.test(item.link)
  );
}

async function fetchWithTimeout(url, options = {}, timeout = 3500) {
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

function extractPageImage(html, pageUrl) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const metaTag of metaTags) {
    const attrs = getAttributes(metaTag);

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
        pageUrl
      );

      if (image) return image;
    }
  }

  // Cadangan: cari gambar pertama dalam halaman artikel.
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];

  for (const imageTag of imageTags) {
    const attrs = getAttributes(imageTag);

    const image = validImage(
      attrs.src ||
      attrs['data-src'] ||
      attrs['data-lazy-src'] ||
      attrs['data-original'],
      pageUrl
    );

    if (
      image &&
      !/logo|icon|avatar|sprite|placeholder/i.test(image)
    ) {
      return image;
    }
  }

  return '';
}

async function getArticleImage(articleUrl) {
  try {
    const response = await fetchWithTimeout(
      articleUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; TOKOCV2News/1.0)',
          'Accept':
            'text/html,application/xhtml+xml'
        }
      },
      3500
    );

    if (!response.ok) return '';

    const contentType =
      response.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) return '';

    const html = await response.text();

    return extractPageImage(
      html,
      response.url || articleUrl
    );
  } catch (_) {
    return '';
  }
}

async function fillMissingImages(items) {
  // Batasi pencarian halaman artikel agar respons API tidak terlalu lambat.
  const candidates = items
    .filter(item => !item.imageUrl)
    .slice(0, 24);

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
    Array.from({ length: 8 }, () => worker())
  );

  return items;
}

module.exports = async function (req, res) {
  res.setHeader(
    'Cache-Control',
    's-maxage=900, stale-while-revalidate=3600'
  );

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const results = await Promise.all(
      FEEDS.map(async ([category, url]) => {
        try {
          const response = await fetchWithTimeout(
            url,
            {
              headers: {
                'User-Agent': 'TOKOCV2-EsportsNews/1.0'
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

    // Ambil gambar tambahan dari halaman artikel jika RSS kosong.
    await fillMissingImages(items);

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      items
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Feed esports sementara tidak tersedia',
      items: []
    });
  }
};

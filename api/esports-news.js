
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

const decode = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(
    '<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'
  ));
  return m ? decode(m[1]) : '';
}

function parse(xml, category) {
  const chunks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return chunks.map(b => ({
    category,
    title: tag(b, 'title'),
    link: tag(b, 'link'),
    description: tag(b, 'description').slice(0, 260),
    source: tag(b, 'source') || 'Google News',
    pubDate: tag(b, 'pubDate')
  })).filter(x => x.title && /^https?:\/\//i.test(x.link));
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const results = await Promise.all(FEEDS.map(async ([category, url]) => {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'TOKOCV2-EsportsNews/1.0' }
        });
        if (!r.ok) return [];
        return parse(await r.text(), category);
      } catch (_) {
        return [];
      }
    }));

    const seen = new Set();
    const items = results.flat()
      .filter(x => {
        if (seen.has(x.link)) return false;
        seen.add(x.link);
        return true;
      })
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 40);

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      items
    });
  } catch (e) {
    res.status(500).json({
      error: 'Feed esports sementara tidak tersedia',
      items: []
    });
  }
};
    

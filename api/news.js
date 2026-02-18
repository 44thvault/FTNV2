// api/news.js — Florida Trees News
// All sources are Florida-specific searches.
// Every article is also hard-filtered server-side:
// must mention Florida AND cannabis/marijuana/hemp/mmj/dispensary.

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── CACHE ────────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── SOURCES: 100% Florida-targeted searches ─────────────────────────────
const SOURCES = [
  {
    name: 'Florida Cannabis',
    label: 'FL Cannabis',
    url: 'https://news.google.com/rss/search?q=florida+cannabis&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida Marijuana',
    label: 'FL Marijuana',
    url: 'https://news.google.com/rss/search?q=florida+marijuana&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida Hemp',
    label: 'FL Hemp',
    url: 'https://news.google.com/rss/search?q=florida+hemp&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida Medical Marijuana',
    label: 'FL Medical',
    url: 'https://news.google.com/rss/search?q=florida+%22medical+marijuana%22&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida Dispensary',
    label: 'FL Dispensary',
    url: 'https://news.google.com/rss/search?q=florida+dispensary+cannabis&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida MMJ Law',
    label: 'FL Law',
    url: 'https://news.google.com/rss/search?q=florida+marijuana+law+2025&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida Cannabis Business',
    label: 'FL Business',
    url: 'https://news.google.com/rss/search?q=florida+cannabis+business&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Florida THC CBD',
    label: 'FL THC/CBD',
    url: 'https://news.google.com/rss/search?q=florida+thc+OR+cbd+cannabis&hl=en-US&gl=US&ceid=US:en',
  },
];

// ─── RELEVANCE FILTER ─────────────────────────────────────────────────────
// Article must mention Florida AND at least one cannabis keyword.
const FL_WORDS   = ['florida', 'fl '];
const CANNA_WORDS = ['cannabis','marijuana','hemp','mmj','dispensary','thc','cbd','weed','edible','cultivation','trulieve','curaleaf','surterra','fluent','vidacann','canna'];

function isRelevant(title, desc) {
  const text = (title + ' ' + desc).toLowerCase();
  const hasFL    = FL_WORDS.some(w => text.includes(w));
  const hasCanna = CANNA_WORDS.some(w => text.includes(w));
  return hasFL && hasCanna;
}

// ─── HTTP FETCH ───────────────────────────────────────────────────────────
function fetchUrl(urlStr, redirects = 5) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FloridaTreesNewsBot/1.0; +https://floridatreesnews.vercel.app)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: 9000,
      }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, urlStr).toString();
          res.resume();
          return fetchUrl(next, redirects - 1).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    } catch(e) { reject(e); }
  });
}

// ─── XML HELPERS ─────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_,n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_,h) => String.fromCharCode(parseInt(h,16)));
}

function getTag(xml, tag) {
  const cdata = new RegExp(`<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plain = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(cdata) || xml.match(plain);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function getRawTag(xml, tag) {
  const cdata = new RegExp(`<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plain = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(cdata) || xml.match(plain);
  return m ? m[1].trim() : '';
}

function getThumbnail(itemXml, rawDesc) {
  let m;
  m = itemXml.match(/<media:content[^>]+url="([^"]+)"/i);   if (m) return m[1];
  m = itemXml.match(/<media:thumbnail[^>]+url="([^"]+)"/i);  if (m) return m[1];
  m = itemXml.match(/<enclosure[^>]+type="image[^"]*"[^>]+url="([^"]+)"/i); if (m) return m[1];
  m = rawDesc.match(/<img[^>]+src="([^"]+)"/i);              if (m) return m[1];
  return '';
}

// ─── PARSE RSS ────────────────────────────────────────────────────────────
function parseRSS(xml, source) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title = getTag(b, 'title');
    const link  = getTag(b, 'link') || getTag(b, 'guid') || '';
    if (!title || !link || !link.startsWith('http')) continue;

    const rawDesc = getRawTag(b, 'description');
    const desc    = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    const pubDate = getTag(b, 'pubDate') || getTag(b, 'dc:date') || '';
    const ts      = pubDate ? new Date(pubDate).getTime() : Date.now();
    const thumb   = getThumbnail(b, rawDesc);

    // Hard relevance gate — Florida + cannabis topic required
    if (!isRelevant(title, desc)) continue;

    items.push({
      title,
      link,
      description: desc,
      thumbnail: thumb.startsWith('http') ? thumb : '',
      pubDate,
      _pubTimestamp: isNaN(ts) ? Date.now() : ts,
      _source: source.name,
      _sourceLabel: source.label,
    });
  }
  return items;
}

// ─── DEDUP ────────────────────────────────────────────────────────────────
function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.slice(0, 65).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Serve cache if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(cache.data);
  }

  const settled = await Promise.allSettled(
    SOURCES.map(async s => {
      const xml = await fetchUrl(s.url);
      return parseRSS(xml, s);
    })
  );

  const articles = dedup(
    settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  ).sort((a, b) => b._pubTimestamp - a._pubTimestamp).slice(0, 120);

  const payload = { ok: true, count: articles.length, fetchedAt: Date.now(), articles };
  cache = { data: payload, ts: Date.now() };

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return res.status(200).json(payload);
};

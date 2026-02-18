// api/news.js — Florida Trees News
// Fetches Florida cannabis/hemp/marijuana news from Google News RSS.
// Uses CommonJS + Node built-ins only (no npm packages needed).

const https = require('https');
const { URL } = require('url');

// In-memory cache — survives warm Lambda restarts
let CACHE = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── RSS SOURCES: Florida-specific searches only ──────────────────────────
const SOURCES = [
  {
    label: 'FL Cannabis',
    url: 'https://news.google.com/rss/search?q=florida+cannabis&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'FL Marijuana',
    url: 'https://news.google.com/rss/search?q=florida+marijuana&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'FL Hemp',
    url: 'https://news.google.com/rss/search?q=florida+hemp&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'FL Medical',
    url: 'https://news.google.com/rss/search?q=florida+%22medical+marijuana%22&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'FL Dispensary',
    url: 'https://news.google.com/rss/search?q=florida+dispensary+marijuana&hl=en-US&gl=US&ceid=US:en',
  },
];

// ─── FETCH with timeout ───────────────────────────────────────────────────
function get(urlStr, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
    try {
      const u = new URL(urlStr);
      const req = https.get(
        { hostname: u.hostname, path: u.pathname + u.search,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/xml,text/xml,*/*' } },
        res => {
          // Follow one redirect
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            clearTimeout(timer);
            return get(res.headers.location, timeout).then(resolve).catch(reject);
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
          res.on('error', e => { clearTimeout(timer); reject(e); });
        }
      );
      req.on('error', e => { clearTimeout(timer); reject(e); });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

// ─── XML helpers ─────────────────────────────────────────────────────────
function unescape(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function tag(xml, name) {
  // CDATA first, then plain
  const m =
    xml.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i')) ||
    xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  return unescape(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseItems(xml, label) {
  const out = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title = tag(b, 'title');
    // Google News wraps the real URL in <link> after CDATA — grab it
    const linkMatch = b.match(/<link>([^<]+)<\/link>/) || b.match(/<link[^>]+href="([^"]+)"/i);
    const link = linkMatch ? unescape(linkMatch[1].trim()) : '';
    if (!title || !link) continue;

    const pubDate = tag(b, 'pubDate') || tag(b, 'dc:date') || '';
    const ts = pubDate ? Date.parse(pubDate) : Date.now();

    // Thumbnail: try media:content, media:thumbnail, enclosure, or first <img> in description
    let thumb = '';
    const mc = b.match(/<media:content[^>]+url="([^"]+)"/i);
    const mt = b.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
    const enc = b.match(/<enclosure[^>]+url="([^"]+)"/i);
    const rawDesc = b.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const imgInDesc = rawDesc && rawDesc[1].match(/<img[^>]+src="([^"]+)"/i);
    if (mc) thumb = mc[1];
    else if (mt) thumb = mt[1];
    else if (enc) thumb = enc[1];
    else if (imgInDesc) thumb = imgInDesc[1];

    const desc = rawDesc
      ? unescape(rawDesc[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 260)
      : '';

    out.push({ title, link, description: desc, thumbnail: thumb.startsWith('http') ? thumb : '',
      pubDate, _pubTimestamp: isNaN(ts) ? Date.now() : ts, _sourceLabel: label });
  }
  return out;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Serve cache if fresh
  if (CACHE.data && Date.now() - CACHE.ts < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(CACHE.data);
  }

  // Fetch all sources in parallel — don't let one failure block others
  const results = await Promise.allSettled(
    SOURCES.map(s => get(s.url).then(xml => parseItems(xml, s.label)))
  );

  const raw = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Deduplicate by title
  const seen = new Set();
  const articles = raw
    .filter(a => {
      const key = a.title.slice(0, 60).toLowerCase().replace(/\W/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b._pubTimestamp - a._pubTimestamp)
    .slice(0, 100);

  const payload = { ok: true, count: articles.length, fetchedAt: Date.now(), articles };

  // Only cache if we actually got articles
  if (articles.length > 0) CACHE = { data: payload, ts: Date.now() };

  res.setHeader('X-Cache', 'MISS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return res.status(200).json(payload);
};

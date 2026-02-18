// api/news.js — Vercel Serverless Function
// Fetches all RSS feeds server-side, merges, deduplicates, returns JSON.
// Edge-cached for 10 minutes via Cache-Control.

const SOURCES = [
  { name:'Marijuana Moment',    label:'MJMoment',    color:'#4ab45a', url:'https://www.marijuanamoment.net/feed/' },
  { name:'Leafly News',         label:'Leafly',       color:'#71bf44', url:'https://www.leafly.com/news/rss.xml' },
  { name:'Cannabis Business Times', label:'CBT',     color:'#c8a84b', url:'https://www.cannabisbusinesstimes.com/rss' },
  { name:'FL Cannabis News',    label:'FL Cannabis',  color:'#5096dc', url:'https://news.google.com/rss/search?q=florida+cannabis+marijuana&hl=en-US&gl=US&ceid=US:en' },
  { name:'FL Dispensary News',  label:'FL Dispensary',color:'#a050dc', url:'https://news.google.com/rss/search?q=florida+dispensary+medical+marijuana&hl=en-US&gl=US&ceid=US:en' },
  { name:'FL Policy News',      label:'FL Policy',    color:'#e05252', url:'https://news.google.com/rss/search?q=florida+marijuana+law+policy+2025&hl=en-US&gl=US&ceid=US:en' },
];

const CATS = {
  policy:     ['law','bill','senate','house','vote','election','amendment','regulation','ban','legal','policy','legislature','governor','tallahassee','ballot','court','arrest','decrim'],
  medical:    ['medical','patient','prescription','doctor','treatment','thc','cbd','health','clinical','mmj','qualifying','pain','ptsd','cancer','anxiety','epilepsy'],
  business:   ['million','revenue','market','invest','stock','acquisition','ceo','company','industry','profit','earn','funding','deal','valuation','expansion','license'],
  dispensary: ['dispensary','store','shop','retail','menu','trulieve','curaleaf','surterra','liberty','green thumb','location','open','purchase','buy'],
  lifestyle:  ['recipe','food','strain','review','product','terpene','edible','vape','flower','culture','lifestyle','wellness','sleep','smoke','grow'],
};

function detectCat(title='', desc='') {
  const t = (title+' '+desc).toLowerCase();
  for (const [c,kws] of Object.entries(CATS)) if (kws.some(k=>t.includes(k))) return c;
  return 'general';
}

function decode(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&#8217;/g,"'").replace(/&#8220;/g,'"').replace(/&#8221;/g,'"').replace(/&#8230;/g,'…');
}

function parseRSS(xml, source) {
  const items=[], re=/<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m=re.exec(xml))!==null) {
    const b=m[1];
    const get=tag=>{
      const r=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i');
      const x=b.match(r); return x?(x[1]||x[2]||'').trim():'';
    };
    const gattr=(tag,attr)=>{ const r=new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`,'i'); const x=b.match(r); return x?x[1]:''; };
    const title=get('title'), link=get('link')||gattr('link','href');
    if (!title||!link) continue;
    const pubDate=get('pubDate')||get('dc:date')||get('published');
    const d=pubDate?new Date(pubDate):new Date();
    if (isNaN(d)) continue;
    const rawDesc=get('description').replace(/<[^>]+>/g,'').trim().slice(0,300);
    const thumb=gattr('media:thumbnail','url')||gattr('media:content','url')||gattr('enclosure','url')||'';
    items.push({
      title:decode(title), link, description:decode(rawDesc), thumbnail:thumb,
      pubDate:d.toISOString(), source:source.name, sourceLabel:source.label,
      sourceColor:source.color, category:detectCat(title,rawDesc),
    });
  }
  return items;
}

async function fetchSource(source) {
  try {
    const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),7000);
    const res=await fetch(source.url,{signal:ctrl.signal,headers:{'User-Agent':'Mozilla/5.0 (compatible; FloridaTreesNewsBot/1.0)','Accept':'application/rss+xml,application/xml,text/xml,*/*'}});
    clearTimeout(t);
    if (!res.ok) return [];
    return parseRSS(await res.text(), source);
  } catch(e) { console.error(`[FTN] ${source.name}:`,e.message); return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if (req.method==='OPTIONS') { res.status(200).end(); return; }
  res.setHeader('Cache-Control','s-maxage=600, stale-while-revalidate=60');
  try {
    const results=await Promise.allSettled(SOURCES.map(fetchSource));
    const raw=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
    const seen=new Set(), articles=[];
    for (const a of raw) {
      if (!a.title||!a.link) continue;
      const k=a.title.slice(0,70).toLowerCase().replace(/\s+/g,'');
      if (seen.has(k)) continue;
      seen.add(k); articles.push(a);
    }
    articles.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
    res.status(200).json({ok:true, count:articles.length, fetchedAt:new Date().toISOString(), articles});
  } catch(e) {
    console.error('[FTN] handler:',e);
    res.status(500).json({ok:false,error:'Failed to fetch feeds'});
  }
}

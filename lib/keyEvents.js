import axios from 'axios';
import dayjs from 'dayjs';
import isBetween from 'dayjs/plugin/isBetween.js';
dayjs.extend(isBetween);
import crypto from 'crypto';
import { getCache, setCache } from './cache.js';
import { getNewsKeywords, fetchGdeltArticles } from './news.js';
import { getEventFilings } from './sec.js';

const KEY_EVENT_TTL = 6 * 60 * 60 * 1000;
const ALPHA_EVENT_TTL = 6 * 60 * 60 * 1000;

function cacheKey(prefix, parts){
  return `${prefix}_${parts.filter(Boolean).join('_')}`;
}

async function callOpenRouter(openKey, model, messages, cachePrefix, ttl){
  const hash = crypto.createHash('sha256').update(JSON.stringify({ model, messages })).digest('hex');
  const key = cacheKey(cachePrefix, [model, hash]);
  const cached = await getCache(key, ttl);
  if(cached) return cached;
  const { data } = await axios.post('https://openrouter.ai/api/v1/chat/completions',{
    model,
    messages,
    temperature:0.2
  },{
    headers:{ 'Authorization':`Bearer ${openKey}`, 'Content-Type':'application/json' },
    timeout: 60000
  });
  const text = data?.choices?.[0]?.message?.content?.trim();
  if(text) await setCache(key, text);
  return text;
}

async function fetchAlphaEarnings(symbol){
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if(!apiKey) return [];
  const cacheId = cacheKey('alpha_earnings', [symbol]);
  const cached = await getCache(cacheId, ALPHA_EVENT_TTL);
  if(cached) return cached;
  const params = new URLSearchParams({ function:'EARNINGS', symbol, apikey: apiKey });
  const { data } = await axios.get(`https://www.alphavantage.co/query?${params.toString()}`,{ timeout: 20000 });
  const calendar = data?.earningsCalendar || [];
  const events = calendar.map(row=>({
    type: 'earnings',
    date: row.reportDate || row.reportedDate || row.fiscalDateEnding,
    title: `${symbol} Earnings Call`,
    summary: `Estimate EPS ${row.epsEstimate ?? row.estimatedEPS ?? ''}`,
    source: 'AlphaVantage'
  }));
  await setCache(cacheId, events);
  return events;
}

function normalizeArticles(articles=[]){
  return articles.map(a=>({
    type: 'news',
    date: a.published_at || a.date,
    title: a.title || '新聞事件',
    summary: a.summary || '',
    source: a.source || 'GDELT'
  }));
}

function normalizeSecFilings(filings=[]){
  return filings.map(f=>({
    type: f.form === '8-K' ? 'regulatory' : 'filing',
    date: f.filingDate,
    title: `${f.form} filing`,
    summary: f.description || '',
    url: f.url,
    source: 'SEC'
  }));
}

function filterRecent(events, baselineDate){
  const base = dayjs(baselineDate);
  const start = base.subtract(1,'month');
  const end = base.add(1,'month');
  return events.filter(evt=>{
    if(!evt.date) return false;
    const d = dayjs(evt.date);
    return d.isValid() && d.isBetween(start,end,'day','[]');
  }).sort((a,b)=> dayjs(b.date) - dayjs(a.date));
}

async function classifyEvents({ ticker, baselineDate, events, openKey, model }){
  if(!events.length){
    return {
      primary:null,
      details:[],
      summary:'（近一月無重大事件）'
    };
  }
  if(!openKey){
    return {
      primary: events[0],
      details: events.slice(1),
      summary:'（缺少 LLM 金鑰，顯示近期事件列表）'
    };
  }
  const categories = [
    '財報與財測','併購與重大交易','資本市場操作','監管/法律事件',
    '產品/技術里程碑','宏觀與板塊事件','內部治理與人事','外部突發事件'
  ];
  const messages = [
    { role:'system', content:[
      '你是財經事件分析師，請根據輸入的事件列表，挑出最重要的一則並分類。',
      `分類請限定在：${categories.join('、')}，若不適用可寫 "其他"。`,
      '輸出 JSON：{"primary":{"title":string,"date":"YYYY-MM-DD","type":string,"summary":string},"details":[{"title":string,"date":"YYYY-MM-DD","type":string,"summary":string}],"summary":string}'
    ].join('\n') },
    { role:'user', content: JSON.stringify({ ticker, baseline_date: baselineDate, events }) }
  ];
  try{
    const text = await callOpenRouter(openKey, model, messages, 'key_events_cls', KEY_EVENT_TTL);
    if(!text) throw new Error('empty response');
    const cleaned = text.replace(/```json|```/gi,'').trim();
    const parsed = JSON.parse(cleaned);
    return {
      primary: parsed.primary || null,
      details: Array.isArray(parsed.details)? parsed.details : [],
      summary: parsed.summary || ''
    };
  }catch(err){
    console.warn('[KeyEvents] classify failed', err.message);
    return {
      primary: events[0] || null,
      details: events.slice(1),
      summary: '（事件分類失敗，列出近期事件）'
    };
  }
}

export async function buildKeyEvents({ ticker, cik, baselineDate, openKey, model }){
  const key = cacheKey('key_events', [ticker, baselineDate, model]);
  const cached = await getCache(key, KEY_EVENT_TTL);
  if(cached) return cached;
  try{
    const keywords = await getNewsKeywords(ticker, openKey, model);
    const gdeltArticles = await fetchGdeltArticles({ ticker, keywords, baselineDate, monthsBack:1, max:40 });
    const filings = cik ? await getEventFilings(cik, baselineDate, process.env.SEC_USER_AGENT || 'App/1.0', process.env.SEC_API_KEY || '') : [];
    const alphaEvents = await fetchAlphaEarnings(ticker);
    const combined = [
      ...normalizeArticles(gdeltArticles),
      ...normalizeSecFilings(filings),
      ...alphaEvents
    ];
    const recent = filterRecent(combined, baselineDate).slice(0,10);
    const classified = await classifyEvents({ ticker, baselineDate, events: recent, openKey, model });
    const bundle = { ...classified, raw_events: recent };
    await setCache(key, bundle);
    return bundle;
  }catch(err){
    console.warn('[KeyEvents] build failed', err.message);
    const fallback = { primary:null, details:[], summary:'無法取得重大事件資料。', raw_events:[] };
    await setCache(key, fallback);
    return fallback;
  }
}

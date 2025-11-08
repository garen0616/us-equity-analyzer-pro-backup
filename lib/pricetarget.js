import axios from 'axios';
import { getCache, setCache } from './cache.js';

const FH_BASE = 'https://finnhub.io/api/v1';
function toNum(x){ const n = Number(x); return Number.isFinite(n)? n : null; }
function round2(x){ return x==null? null : Math.round(x*100)/100; }

function normalizeTargets(obj={}, current=null){
  let mean = toNum(obj.targetMean ?? obj.targetMedian);
  let hi   = toNum(obj.targetHigh);
  let lo   = toNum(obj.targetLow);

  // 補齊邏輯
  if(mean!=null){
    if(hi==null && lo==null){
      hi = mean * 1.15;
      lo = mean * 0.85;
    } else if(hi!=null && lo==null){
      lo = mean ? Math.min(mean * 0.9, hi / 1.1) : hi / 1.1;
    } else if(lo!=null && hi==null){
      hi = mean ? Math.max(mean * 1.1, lo * 1.1) : lo * 1.1;
    }
  }
  if(hi!=null && lo==null) lo = hi / 1.2;
  if(lo!=null && hi==null) hi = lo * 1.2;

  const cur = toNum(current);
  if(cur!=null){
    if(hi!=null && cur>hi) hi = cur * 1.05;
    if(lo!=null && cur<lo) lo = cur * 0.95;
  }

  return {
    source: obj.source || 'aggregated',
    targetHigh: round2(hi),
    targetLow:  round2(lo),
    targetMean: round2(mean),
    targetMedian: round2(toNum(obj.targetMedian))
  };
}

export async function finnhubPriceTarget(symbol, key){
  const cacheKey = `finnhub_pt_${symbol}`;
  const cached = await getCache(cacheKey); if(cached) return cached;
  try{
    const {data} = await axios.get(`${FH_BASE}/stock/price-target`,{params:{symbol,token:key},timeout:15000});
    if(data && (data.targetHigh!=null || data.targetLow!=null || data.targetMean!=null)){
      const out = {source:'finnhub',...data};
      await setCache(cacheKey,out); return out;
    }
    throw new Error('Empty price-target payload');
  }catch(err){ throw new Error(`[FINNHUB] ${err.response?.data?.error || err.message}`); }
}

export async function yahooPriceTarget(symbol){
  const cacheKey=`yahoo_pt_${symbol}`;
  const cached=await getCache(cacheKey); if(cached) return cached;
  try{
    const url=`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData`;
    const {data}=await axios.get(url,{headers:{'User-Agent':'Mozilla/5.0'},timeout:15000});
    const fd=data?.quoteSummary?.result?.[0]?.financialData;
    const out={
      source:'yahoo',
      targetHigh:fd?.targetHighPrice?.raw??null,
      targetLow:fd?.targetLowPrice?.raw??null,
      targetMean:fd?.targetMeanPrice?.raw??null,
      targetMedian:null
    };
    if(out.targetHigh!=null || out.targetLow!=null || out.targetMean!=null){
      await setCache(cacheKey,out); return out;
    }
    throw new Error('Yahoo no financialData targets');
  }catch(err){ throw new Error(`[YAHOO] ${err.message}`); }
}

export async function alphaVantageTarget(symbol, apiKey){
  if(!apiKey) throw new Error('[ALPHAVANTAGE] Missing API key');
  const cacheKey=`av_overview_${symbol}`;
  const cached=await getCache(cacheKey); if(cached) return cached;
  try{
    const {data}=await axios.get('https://www.alphavantage.co/query',{params:{function:'OVERVIEW',symbol,apikey:apiKey},timeout:20000});
    if(data?.AnalystTargetPrice){
      const num=Number(data.AnalystTargetPrice);
      const out={source:'alphavantage',targetHigh:null,targetLow:null,targetMean:Number.isFinite(num)?num:null,targetMedian:null};
      await setCache(cacheKey,out); return out;
    }
    throw new Error('AlphaVantage no AnalystTargetPrice');
  }catch(err){ throw new Error(`[ALPHAVANTAGE] ${err.message}`); }
}

export async function getAggregatedPriceTarget(symbol, finnhubKey, alphaKey, current){
  const errors=[];
  try{return normalizeTargets(await finnhubPriceTarget(symbol,finnhubKey),current);}catch(e){errors.push(e.message);}
  try{return normalizeTargets(await yahooPriceTarget(symbol),current);}catch(e){errors.push(e.message);}
  try{return normalizeTargets(await alphaVantageTarget(symbol,alphaKey),current);}catch(e){errors.push(e.message);}
  throw new Error(errors.join(' | '));
}

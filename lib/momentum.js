import axios from 'axios';
import dayjs from 'dayjs';
import { getCache, setCache } from './cache.js';

const SERIES_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day
const METRIC_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours
const MAX_LOOKBACK_DAYS = 400;

const ETF_MAP = [
  { etf: 'SOXX', tickers: ['NVDA','AMD','TSM','ASML','AVGO','QCOM','MU','INTC','SMCI'] },
  { etf: 'XLV', tickers: ['UNH','LLY','JNJ','ABBV','PFE','MRK','TMO'] },
  { etf: 'XLF', tickers: ['JPM','GS','BAC','C','MS','BLK'] },
  { etf: 'QQQ', tickers: ['AAPL','MSFT','GOOGL','META','AMZN','NFLX','ADBE','CRM','NOW','SNOW'] }
];

function cacheKey(prefix, symbol){
  return `${prefix}_${symbol}`;
}

function pickEtf(symbol){
  const upper = symbol.toUpperCase();
  for(const bucket of ETF_MAP){
    if(bucket.tickers.includes(upper)) return bucket.etf;
  }
  return 'SPY';
}

function clamp(val, min, max){
  return Math.max(min, Math.min(max, val));
}

async function fetchFromAlpha(symbol){
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if(!apiKey) return null;
  const params = new URLSearchParams({
    function:'TIME_SERIES_DAILY_ADJUSTED',
    symbol,
    outputsize:'full',
    apikey: apiKey
  });
  const { data } = await axios.get(`https://www.alphavantage.co/query?${params.toString()}`,{ timeout:20000 });
  const series = data?.['Time Series (Daily)'];
  if(!series){
    const errMsg = data?.Note || data?.['Error Message'] || 'AlphaVantage no data';
    throw new Error(errMsg);
  }
  return Object.entries(series).map(([date, values])=>({
    date,
    close: Number(values['4. close'] ?? values['5. adjusted close'] ?? values['1. open']) || 0,
    high: Number(values['2. high']) || 0,
    low: Number(values['3. low']) || 0,
    volume: Number(values['6. volume']) || 0
  }));
}

async function fetchFromYahoo(symbol){
  const params = new URLSearchParams({
    range:'2y',
    interval:'1d'
  });
  const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`,{
    headers:{'User-Agent':'Mozilla/5.0'},
    timeout:20000
  });
  const result = data?.chart?.result?.[0];
  if(!result) throw new Error('Yahoo chart no data');
  const timestamps = result.timestamp || [];
  const close = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
  const high = result.indicators?.quote?.[0]?.high || [];
  const low = result.indicators?.quote?.[0]?.low || [];
  const volume = result.indicators?.quote?.[0]?.volume || [];
  return timestamps.map((ts,i)=>{
    const date = dayjs.unix(ts).format('YYYY-MM-DD');
    return {
      date,
      close: Number(close[i]) || Number(high[i]) || Number(low[i]) || 0,
      high: Number(high[i]) || Number(close[i]) || 0,
      low: Number(low[i]) || Number(close[i]) || 0,
      volume: Number(volume[i]) || 0
    };
  });
}

async function fetchDailySeries(symbol){
  const key = cacheKey('series', symbol);
  const cached = await getCache(key, SERIES_CACHE_TTL);
  if(cached) return cached;
  let rows = [];
  try{
    rows = await fetchFromAlpha(symbol);
  }catch(err){
    console.warn('[Momentum] alpha fetch failed', err.message);
  }
  if(!rows || !rows.length){
    try{
      rows = await fetchFromYahoo(symbol);
    }catch(err){
      console.warn('[Momentum] yahoo fetch failed', err.message);
    }
  }
  if(!rows || !rows.length) return null;
  const sorted = rows.sort((a,b)=> dayjs(b.date).valueOf() - dayjs(a.date).valueOf()).slice(0, MAX_LOOKBACK_DAYS);
  await setCache(key, sorted);
  return sorted;
}

function percentChange(series, idx){
  if(series.length <= idx || idx < 0) return null;
  const current = series[0];
  const base = series[idx];
  if(!current || !base || base.close === 0) return null;
  return (current.close / base.close) - 1;
}

function simpleMovingAverage(series, period){
  if(series.length < period) return null;
  const slice = series.slice(0, period);
  return slice.reduce((sum,row)=>sum+row.close,0)/period;
}

function calcRSI(series, period=14){
  if(series.length <= period) return null;
  let gains = 0; let losses = 0;
  for(let i=0;i<period;i++){
    const diff = series[i].close - series[i+1].close;
    if(diff>=0) gains += diff; else losses -= diff;
  }
  const avgGain = gains/period;
  const avgLoss = losses/period;
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}

function calcATR(series, period=14){
  if(series.length <= period) return null;
  const trs = [];
  for(let i=0;i<period;i++){
    const current = series[i];
    const prev = series[i+1] || current;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trs.push(tr);
  }
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}

function avgVolume(series, period){
  if(series.length < period) return null;
  return series.slice(0, period).reduce((sum,row)=>sum+row.volume,0)/period;
}

function sliceByDate(series, baselineDate){
  if(!baselineDate) return series;
  const target = dayjs(baselineDate);
  const idx = series.findIndex(row=> dayjs(row.date).isSame(target,'day') || dayjs(row.date).isBefore(target,'day'));
  return idx>=0 ? series.slice(idx) : series;
}

export async function computeMomentumMetrics(symbol, baselineDate){
  try{
    const cacheId = cacheKey('momentum_metrics', `${symbol}_${baselineDate}`);
    const cached = await getCache(cacheId, METRIC_CACHE_TTL);
    if(cached) return cached;
    const series = await fetchDailySeries(symbol);
    if(!series?.length) return null;
    const sliced = sliceByDate(series, baselineDate);
    if(sliced.length < 60) return null;
    const latest = sliced[0];
    const returns = {
      m3: percentChange(sliced, 63),
      m6: percentChange(sliced, 126),
      m12: percentChange(sliced, 252)
    };
    const ma20 = simpleMovingAverage(sliced, 20);
    const ma50 = simpleMovingAverage(sliced, 50);
    const ma200 = simpleMovingAverage(sliced, 200);
    const rsi14 = calcRSI(sliced,14);
    const atr14 = calcATR(sliced,14);
    const vol5 = avgVolume(sliced,5);
    const vol30 = avgVolume(sliced,30);
    const volumeRatio = (vol5 && vol30) ? vol5/vol30 : null;
    const above50 = ma50!=null ? latest.close > ma50 : null;
    const above200 = ma200!=null ? latest.close > ma200 : null;

    let trend = '中性';
    if((above50 && above200) && returns.m3!=null && returns.m3 > 0.10) trend = '強勢';
    if((above50===false && above200===false) && returns.m3!=null && returns.m3 < -0.05) trend = '弱勢';

    let score = 50;
    if(returns.m3!=null) score += clamp(returns.m3*200, -20, 20);
    if(returns.m6!=null) score += clamp(returns.m6*150, -15, 15);
    if(returns.m12!=null) score += clamp(returns.m12*100, -10, 10);
    if(rsi14!=null) score += clamp((rsi14-50)/2, -10, 10);
    if(volumeRatio!=null) score += clamp((volumeRatio-1)*20, -10, 10);
    if(above50===true) score += 5; else if(above50===false) score -=5;
    if(above200===true) score += 5; else if(above200===false) score -=5;
    const momentumScore = Math.round(clamp(score,0,100));

    let etf = { symbol: pickEtf(symbol), return3m: null };
    try{
      const etfSeries = await fetchDailySeries(etf.symbol);
      const etfSlice = etfSeries ? sliceByDate(etfSeries, baselineDate) : null;
      if(etfSlice && etfSlice.length>63){
        etf.return3m = percentChange(etfSlice, 63);
      }
    }catch(err){
      // ignore ETF errors
    }

    const metrics = {
      score: momentumScore,
      trend,
      returns,
      price: latest.close,
      moving_averages:{ ma20, ma50, ma200 },
      rsi14,
      atr14,
      volume_ratio: volumeRatio,
      price_vs_ma:{ above50, above200 },
      etf,
      reference_date: latest.date
    };
    await setCache(cacheId, metrics);
    return metrics;
  }catch(err){
    console.warn('[Momentum] compute failed', err.message);
    return null;
  }
}

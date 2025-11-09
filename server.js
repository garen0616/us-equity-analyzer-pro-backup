import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import dayjs from 'dayjs';
import fetch from 'node-fetch';
import multer from 'multer';
import path from 'path';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { getCIK, getRecentFilings } from './lib/sec.js';
import { fetchMDA } from './lib/secText.js';
import { getRecommendations, getEarnings, getQuote } from './lib/finnhub.js';
import { getAggregatedPriceTarget } from './lib/pricetarget.js';
import { analyzeWithLLM } from './lib/llm.js';
import { getHistoricalPrice } from './lib/historicalPrice.js';

const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const UA   = process.env.SEC_USER_AGENT || 'App/1.0 (email@example.com)';
const SEC_KEY = process.env.SEC_API_KEY || '';
const FH_KEY  = process.env.FINNHUB_KEY || '';
const AV_KEY  = process.env.ALPHAVANTAGE_KEY || '';
const TWELVE_KEY = process.env.TWELVE_DATA_KEY || '';
const OPEN_KEY= process.env.OPENROUTER_KEY || '';
const MODEL   = process.env.OPENROUTER_MODEL || 'gpt-5';
const BATCH_CONCURRENCY = Math.max(1, Number(process.env.BATCH_CONCURRENCY || 3));
const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize: 10 * 1024 * 1024 } });

function errRes(res, err){ console.error('❌', err); return res.status(500).json({error:String(err.message||err)}); }

async function mapWithConcurrency(items, limit, mapper){
  if(!Array.isArray(items) || !items.length) return [];
  const size = Math.max(1, Math.min(limit || 1, items.length));
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: size }, ()=>(async function worker(){
    while(true){
      const current = index++;
      if(current >= items.length) break;
      results[current] = await mapper(items[current], current);
    }
  })());
  await Promise.all(workers);
  return results;
}

async function performAnalysis(ticker, date){
  const parsedDate = dayjs(date);
  if(!parsedDate.isValid()) throw new Error('invalid date format');
  const baselineDate = parsedDate.format('YYYY-MM-DD');
  const upperTicker = ticker.toUpperCase();
  const isHistorical = parsedDate.isBefore(dayjs(), 'day');

  const cik = await getCIK(upperTicker, UA, SEC_KEY);
  const filings = await getRecentFilings(cik, baselineDate, UA, SEC_KEY);
  const perFiling = await mapWithConcurrency(filings, 3, async (f)=>{
    const mda = await fetchMDA(f.url, UA);
    return { form:f.form, formLabel:f.formLabel, filingDate:f.filingDate, reportDate:f.reportDate, mda };
  });

  const cacheContext = baselineDate;
  const [recoRes, earnRes, quoteRes] = await Promise.allSettled([
    getRecommendations(upperTicker, FH_KEY, cacheContext),
    getEarnings(upperTicker, FH_KEY, cacheContext),
    getQuote(upperTicker, FH_KEY, cacheContext)
  ]);
  const finnhub = {
    recommendation: recoRes.status==='fulfilled'?recoRes.value:{ error:recoRes.reason.message },
    earnings:       earnRes.status==='fulfilled'?earnRes.value:{ error:earnRes.reason.message },
    quote:          quoteRes.status==='fulfilled'?quoteRes.value:{ error:quoteRes.reason.message }
  };
  let current = finnhub?.quote?.c ?? null;
  const priceMeta = {
    source: isHistorical ? 'historical_missing' : 'real-time',
    as_of: isHistorical ? baselineDate : dayjs().format('YYYY-MM-DD')
  };
  if(isHistorical){
    try{
      const hist = await getHistoricalPrice(upperTicker, baselineDate, {
        finnhubKey: FH_KEY,
        alphaKey: AV_KEY,
        twelveKey: TWELVE_KEY
      });
      if(hist?.price!=null){
        current = hist.price;
        priceMeta.source = hist.source;
      }
    }catch(err){
      console.warn('[HistoricalPrice]', err.message);
      priceMeta.source = 'real-time_fallback';
    }
  }else{
    priceMeta.source = 'real-time';
  }
  priceMeta.value = current;
  priceMeta.kind = isHistorical && priceMeta.source !== 'real-time' ? 'historical' : 'real-time';
  const quote = { ...(finnhub.quote || {}), c: current };
  finnhub.quote = quote;
  finnhub.price_meta = priceMeta;

  let ptAgg;
  try{ ptAgg = await getAggregatedPriceTarget(upperTicker, FH_KEY, AV_KEY, current); }
  catch(e){ ptAgg = { error:e.message }; }

  const payload = {
      company: upperTicker,
      baseline_date: baselineDate,
      sec_filings: perFiling.map(x=>({
        form: x.form,
        form_label: x.formLabel || x.form,
        filingDate: x.filingDate,
        reportDate: x.reportDate,
      mda_excerpt: x.mda.slice(0,5000)
    })),
    finnhub: { recommendation:finnhub.recommendation, earnings:finnhub.earnings, quote:finnhub.quote, price_target: ptAgg }
  };
  const llmTtlMs = isHistorical ? 30 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const llm = await analyzeWithLLM(OPEN_KEY, MODEL, payload, { cacheTtlMs: llmTtlMs });

  return {
    input:{ticker:upperTicker, date: baselineDate},
    fetched:{
      filings: filings.map(f=>({form:f.form, form_label:f.formLabel || f.form, filingDate:f.filingDate, reportDate:f.reportDate, url:f.url})),
      finnhub_summary:{
        recommendation: Array.isArray(finnhub.recommendation)?finnhub.recommendation[0]:finnhub.recommendation,
        quote: finnhub.quote,
        price_target: ptAgg,
        price_meta: priceMeta
      }
    },
    analysis: llm
  };
}

function normalizeDate(raw){
  if(raw==null) return '';
  if(typeof raw === 'number'){
    const date = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? '' : dayjs(date).format('YYYY-MM-DD');
  }
  if(raw instanceof Date) return dayjs(raw).format('YYYY-MM-DD');
  const str = String(raw).trim();
  if(!str) return '';
  const parsed = dayjs(str);
  if(parsed.isValid()) return parsed.format('YYYY-MM-DD');
  const alt = dayjs(new Date(str));
  return alt.isValid() ? alt.format('YYYY-MM-DD') : str;
}

function parseBatchFile(file){
  if(!file) throw new Error('缺少檔案');
  const ext = path.extname(file.originalname || '').toLowerCase();
  let rows = [];
  if(ext === '.csv'){
    const text = file.buffer.toString('utf8');
    rows = Papa.parse(text, { skipEmptyLines:false }).data;
  }else{
    const wb = XLSX.read(file.buffer, { type:'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:false, defval:'' });
  }
  const tasks = [];
  for (const row of rows){
    if(!row || !row.length) continue;
    const ticker = String(row[0] ?? '').trim();
    const date = normalizeDate(row[1]);
    if(!ticker && !date) break;
    if(!ticker || !date) continue;
    tasks.push({ ticker, date });
  }
  return tasks;
}

app.post('/api/analyze', async (req,res)=>{
  const {ticker, date} = req.body||{};
  if(!ticker||!date) return res.status(400).json({error:'ticker and date required'});
  try{
    const result = await performAnalysis(ticker, date);
    res.json(result);
  }catch(err){ return errRes(res, err); }
});

app.post('/api/batch', upload.single('file'), async (req,res)=>{
  try{
    const tasks = parseBatchFile(req.file);
    if(!tasks.length) return res.status(400).json({error:'檔案內沒有有效的 ticker/date 列'});
    const memo = new Map();
    const rows = await mapWithConcurrency(tasks, BATCH_CONCURRENCY, async (task)=>{
      const key = `${task.ticker.toUpperCase()}__${task.date}`;
      if(!memo.has(key)){
        memo.set(key, (async ()=>{
          try{
            const result = await performAnalysis(task.ticker, task.date);
            return { ok:true, result };
          }catch(error){
            return { ok:false, error };
          }
        })());
      }
      const outcome = await memo.get(key);
      if(!outcome.ok){
        return {
          ticker: task.ticker.toUpperCase(),
          date: task.date,
          current_price: '',
          analyst_mean_target: '',
          llm_target_price: '',
          recommendation: `ERROR: ${outcome.error.message}`
        };
      }
      const result = outcome.result;
      const summary = result.fetched?.finnhub_summary || {};
      return {
        ticker: result.input.ticker,
        date: task.date,
        current_price: summary.quote?.c ?? '',
        analyst_mean_target: summary.price_target?.targetMean ?? summary.price_target?.targetMedian ?? '',
        llm_target_price: result.analysis?.action?.target_price ?? '',
        recommendation: result.analysis?.action?.rating ?? ''
      };
    });
    const fields = ['ticker','date','current_price','analyst_mean_target','llm_target_price','recommendation'];
    const csv = Papa.unparse({
      fields,
      data: rows.map(r=>fields.map(f=>r[f]))
    });
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="batch_results.csv"');
    res.send(csv);
  }catch(err){
    return errRes(res, err);
  }
});

// 自我測試
app.get('/selftest', async (req,res)=>{
  try{
    const t='NVDA'; const d=dayjs().format('YYYY-MM-DD');
    const r = await fetch(`http://localhost:${PORT}/api/analyze`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ticker:t, date:d})
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  }catch(err){ return errRes(res, err); }
});

app.listen(PORT, ()=> console.log(`🚀 http://localhost:${PORT}`));

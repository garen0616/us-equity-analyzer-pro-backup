import express from 'express';
import morgan from 'morgan';
import dayjs from 'dayjs';
import fetch from 'node-fetch';
import { getCIK, getRecentFilings } from './lib/sec.js';
import { fetchMDA } from './lib/secText.js';
import { getRecommendations, getEarnings, getQuote } from './lib/finnhub.js';
import { getAggregatedPriceTarget } from './lib/pricetarget.js';
import { analyzeWithLLM } from './lib/llm.js';

const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const UA   = process.env.SEC_USER_AGENT || 'App/1.0 (email@example.com)';
const SEC_KEY = process.env.SEC_API_KEY || '';
const FH_KEY  = process.env.FINNHUB_KEY || '';
const AV_KEY  = process.env.ALPHAVANTAGE_KEY || '';
const OPEN_KEY= process.env.OPENROUTER_KEY || '';
const MODEL   = process.env.OPENROUTER_MODEL || 'gpt-5';

function errRes(res, err){ console.error('❌', err); return res.status(500).json({error:String(err.message||err)}); }

app.post('/api/analyze', async (req,res)=>{
  const {ticker, date} = req.body||{};
  if(!ticker||!date) return res.status(400).json({error:'ticker and date required'});
  try{
    // 1) SEC filings
    const cik = await getCIK(ticker, UA, SEC_KEY);
    const filings = await getRecentFilings(cik, date, UA, SEC_KEY);
    const perFiling = [];
    for (const f of filings){
      const mda = await fetchMDA(f.url, UA);
      perFiling.push({form:f.form, filingDate:f.filingDate, reportDate:f.reportDate, mda});
    }

    // 2) Finnhub 基本資料（獨立錯誤不終止）
    const [recoRes, earnRes, quoteRes] = await Promise.allSettled([
      getRecommendations(ticker, FH_KEY),
      getEarnings(ticker, FH_KEY),
      getQuote(ticker, FH_KEY)
    ]);
    const finnhub = {
      recommendation: recoRes.status==='fulfilled'?recoRes.value:{ error:recoRes.reason.message },
      earnings:       earnRes.status==='fulfilled'?earnRes.value:{ error:earnRes.reason.message },
      quote:          quoteRes.status==='fulfilled'?quoteRes.value:{ error:quoteRes.reason.message }
    };
    const current = finnhub?.quote?.c ?? null;

    // 3) 目標價（多來源備援 + 補齊）
    let ptAgg;
    try{ ptAgg = await getAggregatedPriceTarget(ticker, FH_KEY, AV_KEY, current); }
    catch(e){ ptAgg = { error:e.message }; }

    // 4) LLM 分析
    const payload = {
      company: ticker.toUpperCase(),
      baseline_date: date,
      sec_filings: perFiling.map(x=>({form:x.form, filingDate:x.filingDate, reportDate:x.reportDate, mda_excerpt: x.mda.slice(0,5000)})),
      finnhub: { recommendation:finnhub.recommendation, earnings:finnhub.earnings, quote:finnhub.quote, price_target: ptAgg }
    };
    const llm = await analyzeWithLLM(OPEN_KEY, MODEL, payload);

    res.json({
      input:{ticker:ticker.toUpperCase(), date},
      fetched:{
        filings: filings.map(f=>({form:f.form, filingDate:f.filingDate, reportDate:f.reportDate, url:f.url})),
        finnhub_summary:{
          recommendation: Array.isArray(finnhub.recommendation)?finnhub.recommendation[0]:finnhub.recommendation,
          quote: finnhub.quote,
          price_target: ptAgg
        }
      },
      analysis: llm
    });
  }catch(err){ return errRes(res, err); }
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

import axios from 'axios';
import dayjs from 'dayjs';
import { getCache, setCache } from './cache.js';

const SUBMISSIONS = (cik)=>`https://data.sec.gov/submissions/CIK${cik}.json`;
const INDEX_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUPPORTED_FORMS = ['10-Q','10-K','20-F','6-K'];
const EVENT_FORMS = ['8-K','6-K'];
const FORM_LABEL = {
  '10-Q':'Form 10-Q（美國季報）',
  '10-K':'Form 10-K（美國年報）',
  '20-F':'Form 20-F（外國發行人年報）',
  '6-K':'Form 6-K（外國發行人臨時報告）'
};

export async function getCIK(ticker, userAgent, apiKey){
  const t = ticker.toUpperCase().trim();
  const key = `sec_index_all`;
  let idx = await getCache(key);
  if(!idx){
    try{
      const {data} = await axios.get(INDEX_URL,{
        headers:{ 'User-Agent': userAgent, 'Authorization': apiKey?`Bearer ${apiKey}`:undefined },
        timeout:15000
      });
      idx = data; await setCache(key, idx);
    }catch(err){ throw new Error(`[SEC] getCIK index failed: ${err.message}`); }
  }
  const row = Object.values(idx).find(x=>x.ticker?.toUpperCase()===t);
  if(!row) throw new Error('[SEC] Ticker not found in SEC index');
  return String(row.cik_str).padStart(10,'0');
}

export async function getRecentFilings(cik, baselineDate, userAgent, apiKey){
  const url = SUBMISSIONS(cik);
  const cacheKey = `sec_submissions_${cik}`;
  let data = await getCache(cacheKey);
  if(!data){
    try{
      const resp = await axios.get(url,{
        headers:{ 'User-Agent': userAgent, 'Authorization': apiKey?`Bearer ${apiKey}`:undefined },
        timeout:20000
      });
      data = resp.data; await setCache(cacheKey, data);
    }catch(err){ throw new Error(`[SEC] submissions failed: ${err.message}`); }
  }
  const forms = data?.filings?.recent;
  if(!forms) throw new Error('[SEC] No recent filings');
  const rows = forms.form.map((f,i)=>({
    form: f,
    reportDate: forms.reportDate[i],
    filingDate: forms.filingDate[i],
    accession: forms.accessionNumber[i],
    primary: forms.primaryDocument[i]
  })).filter(r=> SUPPORTED_FORMS.includes(r.form));
  const base = dayjs(baselineDate);
  const filtered = rows
    .filter(r=> dayjs(r.filingDate).isBefore(base.add(1,'day')))
    .sort((a,b)=> dayjs(b.filingDate)-dayjs(a.filingDate))
    .slice(0,4);
  const withLinks = filtered.map(r=>{
    const accNo = r.accession.replace(/-/g,'');
    const file = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik,10)}/${accNo}/${r.primary}`;
    return {...r, url:file, formLabel: FORM_LABEL[r.form] || r.form};
  });
  if(!withLinks.length) throw new Error('[SEC] No supported filings (10-Q/10-K/20-F/6-K) found before baseline');
  return withLinks;
}

export async function getEventFilings(cik, baselineDate, userAgent, apiKey){
  const url = SUBMISSIONS(cik);
  const cacheKey = `sec_submissions_${cik}`;
  let data = await getCache(cacheKey);
  if(!data){
    try{
      const resp = await axios.get(url,{
        headers:{ 'User-Agent': userAgent, 'Authorization': apiKey?`Bearer ${apiKey}`:undefined },
        timeout:20000
      });
      data = resp.data; await setCache(cacheKey, data);
    }catch(err){ throw new Error(`[SEC] submissions failed: ${err.message}`); }
  }
  const forms = data?.filings?.recent;
  if(!forms) return [];
  const rows = forms.form.map((f,i)=>({
    form: f,
    reportDate: forms.reportDate[i],
    filingDate: forms.filingDate[i],
    accession: forms.accessionNumber[i],
    primary: forms.primaryDocument[i],
    description: forms.primaryDocDescription?.[i]
  })).filter(r=> EVENT_FORMS.includes(r.form));
  const base = dayjs(baselineDate);
  return rows
    .filter(r=> dayjs(r.filingDate).isBefore(base.add(1,'day')))
    .sort((a,b)=> dayjs(b.filingDate) - dayjs(a.filingDate))
    .slice(0,15)
    .map(r=>{
      const accNo = r.accession?.replace(/-/g,'');
      const file = accNo && r.primary
        ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik,10)}/${accNo}/${r.primary}`
        : undefined;
      return {
        form: r.form,
        filingDate: r.filingDate,
        reportDate: r.reportDate,
        url: file,
        description: r.description || ''
      };
    });
}

import axios from 'axios';
import crypto from 'crypto';
import { getCache, setCache } from './cache.js';

export async function analyzeWithLLM(openKey, model, payload, options={}){
  const { cacheTtlMs } = options;
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const cacheKey = `llm_${model}_${payloadHash}`;
  const ttl = Number.isFinite(cacheTtlMs) ? cacheTtlMs : undefined;
  const cached = await getCache(cacheKey, ttl);
  if(cached) return cached;
  try{
    const {data} = await axios.post('https://openrouter.ai/api/v1/chat/completions',{
      model,
      messages:[
        { role:'system', content:[
          '你是專業金融分析師與審核者。',
          '請根據「SEC 10-Q/10-K MD&A 摘要」與「分析師資料」，輸出有效 JSON：',
          '所有文字欄位（包含 explanation、valuation_rationale、risk_factors、key_conflicts、catalyst_timeline、consensus_view.summary、action.rationale）必須以繁體中文撰寫。',
          '{',
          '"per_filing":[{',
          ' "form":"10-Q/10-K","filingDate":"YYYY-MM-DD","reportDate?":"YYYY-MM-DD",',
          ' "five_indicators":{',
          '   "alignment_score": number,',
          '   "key_conflicts": [string],',
          '   "valuation_rationale": string,',
          '   "risk_factors": [string],',
          '   "catalyst_timeline": [{"event":string,"window":string,"why":string}]',
          ' },',
          ' "explanation": "300-500字詳解"',
          '}]',
          '"consensus_view":{"summary":string,"agreement_ratio":number},',
          '"action":{"rating":"BUY|HOLD|SELL","target_price":number,"stop_loss":number,"rationale":string}',
          '}'
        ].join('\n') },
        { role:'user', content: JSON.stringify(payload) }
      ],
      temperature:0.2
    },{
      headers:{ 'Authorization':`Bearer ${openKey}`, 'Content-Type':'application/json' },
      timeout:120000
    });
    const text = data?.choices?.[0]?.message?.content || '{}';
    const cleaned = text.trim().replace(/^```json/i,'').replace(/```$/,'').trim();
    try{
      const parsed = JSON.parse(cleaned);
      await setCache(cacheKey, parsed);
      return parsed;
    }catch{
      const rawFallback = { raw: text };
      await setCache(cacheKey, rawFallback);
      return rawFallback;  // 保留原文避免 throw
    }
  }catch(err){
    throw new Error(`[OPENROUTER] ${err.response?.data?.error?.message || err.message}`);
  }
}

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const BASE_SCHEMA_VERSION = 'analysis_v1';
const DEFAULT_DB_PATH = path.resolve(process.env.ANALYSIS_DB_PATH || 'data/analyses.db');
const dir = path.dirname(DEFAULT_DB_PATH);
if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });

const db = new Database(DEFAULT_DB_PATH);
db.pragma('journal_mode = WAL');
db.prepare(`CREATE TABLE IF NOT EXISTS analyses (
  ticker TEXT NOT NULL,
  baseline_date TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  is_historical INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ticker, baseline_date, schema_version)
)`).run();

db.prepare('CREATE INDEX IF NOT EXISTS idx_analyses_lookup ON analyses(ticker, baseline_date)').run();

const getStmt = db.prepare(`SELECT result_json, updated_at, is_historical FROM analyses WHERE ticker=? AND baseline_date=? AND schema_version=?`);
const upsertStmt = db.prepare(`INSERT INTO analyses (ticker, baseline_date, schema_version, is_historical, result_json, updated_at)
VALUES (@ticker, @baseline_date, @schema_version, @is_historical, @result_json, @updated_at)
ON CONFLICT(ticker, baseline_date, schema_version) DO UPDATE SET
 result_json=excluded.result_json,
 updated_at=excluded.updated_at,
 is_historical=excluded.is_historical`);

function versionKey(model){
  const suffix = (model && String(model).trim()) || 'default';
  return `${BASE_SCHEMA_VERSION}:${suffix}`;
}

export function getCachedAnalysis({ ticker, baselineDate, ttlMs, model }){
  if(!ticker || !baselineDate || !ttlMs) return null;
  try{
    const row = getStmt.get(ticker, baselineDate, versionKey(model));
    if(!row) return null;
    const age = Date.now() - row.updated_at;
    if(age > ttlMs) return null;
    return JSON.parse(row.result_json);
  }catch(err){
    console.warn('[analysisStore] get failed', err.message);
    return null;
  }
}

export function saveAnalysisResult({ ticker, baselineDate, isHistorical, result, model }){
  if(!ticker || !baselineDate || !result) return;
  try{
    upsertStmt.run({
      ticker,
      baseline_date: baselineDate,
      schema_version: versionKey(model),
      is_historical: isHistorical ? 1 : 0,
      result_json: JSON.stringify(result),
      updated_at: Date.now()
    });
  }catch(err){
    console.warn('[analysisStore] save failed', err.message);
  }
}

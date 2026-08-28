import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const APP_VERSION='1.18';
const PACKAGES = [
  { key: 'can440', label: 'Can — 440 mL', litres: 0.44 },
  { key: 'can330', label: 'Can — 330 mL', litres: 0.33 },
  { key: 'keg30', label: 'Keg — 30 L', litres: 30 },
  { key: 'keg50', label: 'Keg — 50 L', litres: 50 },
  { key: 'cask20', label: 'Cask — 20 L', litres: 20 },
  { key: 'cask40', label: 'Cask — 40 L', litres: 40 }
];

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

const DEFAULT_HOP_FORMATS = ['T90','T45','Leaf','Freshpak','Cryo','HyperBoost','HyperBoost Oil','Incognito','Spectrum','Oil'];

function cleanHopFormat(value='') {
  return String(value || '').trim().replace(/\s+/g,' ');
}
function normaliseHopFormats(values) {
  const source = Array.isArray(values) && values.length ? values : DEFAULT_HOP_FORMATS;
  const result = [];
  const seen = new Set();
  for (const raw of source) {
    const value = cleanHopFormat(raw);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result.length ? result : [...DEFAULT_HOP_FORMATS];
}
function splitHopProduct(product='', explicitFormat='', formatList=null) {
  const raw = String(product || '').trim();
  if (!raw) return { variety:'', format:cleanHopFormat(explicitFormat) };
  const candidates = [];
  const seen = new Set();
  for (const f of [explicitFormat, ...(Array.isArray(formatList)?formatList:DEFAULT_HOP_FORMATS), ...DEFAULT_HOP_FORMATS]) {
    const value = cleanHopFormat(f);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) { seen.add(key); candidates.push(value); }
  }
  candidates.sort((a,b)=>b.length-a.length);
  const lower = raw.toLowerCase();
  for (const format of candidates) {
    const suffix = ` ${format.toLowerCase()}`;
    if (lower.endsWith(suffix)) {
      return { variety: raw.slice(0, raw.length - suffix.length).trim(), format };
    }
  }
  return { variety: raw, format:cleanHopFormat(explicitFormat) };
}
function hopProductName(variety='', format='') {
  return [String(variety || '').trim(), cleanHopFormat(format)].filter(Boolean).join(' ');
}
function allowedHopFormats() {
  return normaliseHopFormats(state?.settings?.hopFormats);
}
function hopFormatOptions() {
  return '';
}

function packageInfo(key) {
  return PACKAGES.find(p => p.key === key) || PACKAGES.find(p => p.key === 'cask40');
}

function unitsToHl(units, packageKey, customUnitSizeL = 0) {
  const litres = packageKey === 'custom' ? num(customUnitSizeL) : packageInfo(packageKey).litres;
  return Math.max(0, num(units)) * Math.max(0, litres) / 100;
}

function scenarioAdjustmentPct() {
  const key = state?.settings?.scenarioKey || 'base';
  if (key === 'conservative') return num(state.settings.scenarioConservativePct ?? -10);
  if (key === 'growth') return num(state.settings.scenarioGrowthPct ?? 10);
  if (key === 'custom') return num(state.settings.scenarioCustomPct ?? 0);
  return 0;
}

function scenarioLabel() {
  const key = state?.settings?.scenarioKey || 'base';
  if (key === 'conservative') return `Conservative ${scenarioAdjustmentPct() >= 0 ? '+' : ''}${fmt(scenarioAdjustmentPct())}%`;
  if (key === 'growth') return `Growth ${scenarioAdjustmentPct() >= 0 ? '+' : ''}${fmt(scenarioAdjustmentPct())}%`;
  if (key === 'custom') return `Custom ${scenarioAdjustmentPct() >= 0 ? '+' : ''}${fmt(scenarioAdjustmentPct())}%`;
  return 'Base';
}

function beerForecastComponents(beer){
  if(!beer || beer.active===false)return {historical:0,brews:0,brewHl:0,monthly:0,monthly12:0,oneOff:0,total:0};
  const historicalBase=Math.max(0,num(beer.last12Hl)*(1+Math.max(-100,num(beer.growthPct))/100));
  const historical=Math.max(0,historicalBase*(1+scenarioAdjustmentPct()/100));
  const brews=Math.max(0,Math.round(num(beer.forecastBrews)));
  const brewHl=brews*Math.max(0,num(beer.batchHl));
  const monthly=Math.max(0,num(beer.monthlyHl));
  const monthly12=monthly*12;
  const oneOff=Math.max(0,num(beer.oneOffHl));
  return {historical,brews,brewHl,monthly,monthly12,oneOff,total:historical+brewHl+monthly12+oneOff};
}
function beerBaseForecastHl(beer) {
  return beerForecastComponents(beer).total;
}

function recipeRates(beer) {
  const rates = new Map();
  const batch = Math.max(num(beer?.batchHl), 0.0001);
  for (const hop of beer?.hops || []) {
    const item = (hop.inventoryId && state?.inventory?.find(i => i.id === hop.inventoryId)) || null;
    const name = String(item?.variety || hop.variety || '').trim();
    if (!name) continue;
    const key = item?.id ? `id:${item.id}` : `name:${name.toLowerCase()}`;
    const existing = rates.get(key) || { key, inventoryId:item?.id || '', variety:name, kgPerHl:0 };
    existing.kgPerHl += num(hop.kgPerBrew) / batch;
    rates.set(key, existing);
  }
  return [...rates.values()];
}

function roundUp(value, increment) {
  const v = Math.max(0, num(value));
  const inc = num(increment);
  if (v <= 0) return 0;
  if (inc <= 0) return v;
  return Math.ceil((v - 1e-9) / inc) * inc;
}

function calculateForecast(state) {
  const rows = {};
  const inventoryById = new Map((state.inventory || []).map(i => [i.id, i]));
  const inventoryByName = new Map((state.inventory || []).filter(i => String(i.variety || '').trim()).map(i => [String(i.variety).trim().toLowerCase(), i]));
  const beers = (state.beers || []).filter(b => b.active !== false);
  const orders = (state.orders || []).filter(o => o.status !== 'cancelled');
  const globalBuffer = Math.max(0, num(state.settings?.bufferPct));
  const globalRound = Math.max(0, num(state.settings?.globalRoundingKg));

  const ensure = (key, variety, inventoryId='') => rows[key] ||= {
    key, inventoryId, variety, forecastDemand:0, historicalEquivalent:0,
    currentOrder:0, nextOrder:0, beerIds:new Set()
  };

  for (const beer of beers) {
    const rates = recipeRates(beer);
    const forecastHl = beerBaseForecastHl(beer);
    // Historical production is VOLUME ONLY. The current recipe is applied here
    // solely to produce a comparison equivalent; it is not treated as actual historic usage.
    const historicalHl = Math.max(0, num(beer.last12Hl));
    const beerOrders = orders.filter(o => o.beerId === beer.id);
    const currentHl = beerOrders.reduce((s,o) => s + unitsToHl(Math.max(0, num(o.confirmedUnits) - num(o.fulfilledUnits)), o.packageKey, o.unitSizeL), 0);
    const nextHl = beerOrders.reduce((s,o) => s + unitsToHl(o.likelyRepeatUnits, o.packageKey, o.unitSizeL), 0);
    for (const rate of rates) {
      const row = ensure(rate.key, rate.variety, rate.inventoryId);
      row.beerIds.add(beer.id);
      row.forecastDemand += forecastHl * rate.kgPerHl;
      row.historicalEquivalent += historicalHl * rate.kgPerHl;
      row.currentOrder += currentHl * rate.kgPerHl;
      row.nextOrder += nextHl * rate.kgPerHl;
    }
  }

  for (const item of state.inventory || []) {
    const key = `id:${item.id}`;
    ensure(key, item.variety, item.id);
  }

  return Object.values(rows).map(row => {
    const item = (row.inventoryId && inventoryById.get(row.inventoryId)) || inventoryByName.get(String(row.variety||'').trim().toLowerCase()) || {};
    const stockKg = Math.max(0, num(item.stockKg));
    const contractKg = Math.max(0, num(item.contractKg));
    const expectedUseKg = Math.max(0, num(item.expectedUseKg));
    const supplierReceived12Kg = Math.max(0, num(item.supplierReceived12Kg));
    const contractTotalKg = Math.max(0, num(item.contractTotalKg));
    const contractEnabled = item.contractEnabled !== false;
    const hemisphere = normaliseHemisphere(item.hemisphere,item.variety);
    const hopFormat = cleanHopFormat(item.hopFormat||splitHopProduct(item.variety,'',state.settings.hopFormats).format);
    const availableNow = stockKg + contractKg;
    const committedBeforeContract = expectedUseKg + row.currentOrder;
    const currentShortfall = Math.max(0, committedBeforeContract - availableNow);
    const carryover = Math.max(0, availableNow - committedBeforeContract);
    const nextGross = row.forecastDemand;
    const bufferPct = num(item.safetyStockPct) > 0 ? num(item.safetyStockPct) : globalBuffer;
    const buffer = nextGross * bufferPct / 100;
    const netRaw = Math.max(0, nextGross + buffer - carryover);
    const increment = num(item.roundingKg) > 0 ? num(item.roundingKg) : globalRound;
    let calculated = roundUp(netRaw, increment);
    const minimum = Math.max(0, num(item.minContractKg));
    if (calculated > 0 && minimum > 0) calculated = Math.max(calculated, minimum);
    const manual = item.manualContractKg === '' || item.manualContractKg === null || item.manualContractKg === undefined ? null : Math.max(0, num(item.manualContractKg));
    const recommended = manual === null ? calculated : manual;
    const priceKg = Math.max(0, num(item.priceKg));
    const beerCount = row.beerIds?.size || 0;
    return {
      ...row, baseDemand:row.forecastDemand, beerCount, beerIds:undefined,
      stockKg, contractTotalKg, contractKg, expectedUseKg, supplierReceived12Kg, contractEnabled, hemisphere, hopFormat,
      supplierVariance12Kg:supplierReceived12Kg-row.historicalEquivalent,
      availableNow, committedBeforeContract, currentShortfall, carryover, nextGross,
      bufferPct, buffer, netRaw, increment, minContractKg:minimum, calculated,
      manualContractKg:manual, recommended, priceKg, cost:recommended*priceKg,
      status: currentShortfall > 0 ? 'shortfall' : recommended > 0 ? 'contract' : 'covered'
    };
  }).sort((a,b) => b.recommended - a.recommended || a.variety.localeCompare(b.variety));
}

function totals(rows) {
  return rows.reduce((a,r) => {
    a.baseDemand += r.baseDemand;
    a.historicalEquivalent += r.historicalEquivalent;
    a.supplierReceived12Kg += r.supplierReceived12Kg;
    a.currentContractTotalKg += r.contractTotalKg;
    a.nextOrder += r.nextOrder;
    a.currentOrder += r.currentOrder;
    a.expectedUseKg += r.expectedUseKg;
    a.carryover += r.carryover;
    a.recommended += r.recommended;
    a.currentShortfall += r.currentShortfall;
    a.cost += r.cost;
    return a;
  }, {baseDemand:0,historicalEquivalent:0,supplierReceived12Kg:0,currentContractTotalKg:0,nextOrder:0,currentOrder:0,expectedUseKg:0,carryover:0,recommended:0,currentShortfall:0,cost:0});
}


const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:window.localStorage}});
const $ = s => document.querySelector(s);
const uuid = () => crypto.randomUUID();
const fmt = (v,dp=1) => num(v).toLocaleString('en-GB',{minimumFractionDigits:dp,maximumFractionDigits:dp});
const money = v => num(v).toLocaleString('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0});
const esc = v => String(v ?? '').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const today = () => new Date().toISOString().slice(0,10);
const currentYear = new Date().getFullYear();
const DAY_MS = 86400000;
function isoDateUtc(value){
  const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m)return null;
  return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));
}
function activeContractYearNumber(){
  const y=selectedContractYear();
  return Math.trunc(num(y?.year||state?.settings?.forecastYear||currentYear+1));
}
function contractStartDateIso(year=activeContractYearNumber()){
  return `${Math.trunc(num(year))}-01-01`;
}
function daysUntilContractStart(year=activeContractYearNumber()){
  const from=isoDateUtc(state?.settings?.asOfDate)||isoDateUtc(today());
  const to=isoDateUtc(contractStartDateIso(year));
  if(!from||!to)return 0;
  return Math.max(0,Math.ceil((to-from)/DAY_MS));
}
function januaryBridge(row,year=activeContractYearNumber()){
  const days=daysUntilContractStart(year);
  const annualUse=Math.max(0,num(row?.baseDemand));
  const useBeforeStart=annualUse*days/365.25;
  const stockNow=Math.max(0,num(row?.stockKg));
  const contractNow=Math.max(0,num(row?.contractKg));
  const stockAtStart=Math.max(0,stockNow-useBeforeStart);
  const useAfterStock=Math.max(0,useBeforeStart-stockNow);
  const contractAtStart=Math.max(0,contractNow-useAfterStock);
  const shortfallBeforeStart=Math.max(0,useBeforeStart-stockNow-contractNow);
  return {days,useBeforeStart,stockAtStart,contractAtStart,shortfallBeforeStart,startDate:contractStartDateIso(year)};
}
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||''));
const defaultState = () => ({version:APP_VERSION,settings:{currentYear,forecastYear:currentYear+1,asOfDate:today(),bufferPct:5,globalRoundingKg:5,scenarioKey:'base',scenarioConservativePct:-10,scenarioGrowthPct:10,scenarioCustomPct:0,hopFormats:[...DEFAULT_HOP_FORMATS]},beers:[],orders:[],inventory:[]});

let state = defaultState();
let page = 'dashboard';
let editingBeerId = null;
let dirty = false;
let readOnly = false;
let user = null;
let lockOwned = false;
let heartbeatTimer = null;
let snapshots = [];
let contractYears = [];
let selectedContractYearId = '';
let dashboardHemisphereFilter = 'Northern';
let selectedContractDetail = null;
let calc = {beerId:'',packageKey:'cask40',units:600};
let inventoryFocusVariety = '';
let inventorySortKey = 'name';
let inventorySortDir = 'asc';
let dashboardHopSortKey = 'recommended';
let dashboardHopSortDir = 'desc';
let dashboardBeerSortKey = 'total';
let dashboardBeerSortDir = 'desc';
let beerRegisterSortKey = 'beer';
let beerRegisterSortDir = 'asc';
let productionSortKey = 'beer';
let productionSortDir = 'asc';
let inventorySearch = '';
let inventoryFormatFilter = '';
let autoSaveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let saveError = '';
let changeRevision = 0;

// v1.10: persistent client-side diagnostics. No passwords, auth tokens or full save payloads are logged.
const DEBUG_LOG_KEY = 'hop-contract-debug-log-v110';
const DEBUG_MAX_ENTRIES = 250;
let debugEntries = (()=>{try{return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY)||'[]')}catch{return []}})();
function cleanDebugDetail(detail){
  if(detail===undefined||detail===null)return '';
  if(detail instanceof Error)return {name:detail.name,message:detail.message,stack:String(detail.stack||'').split('\n').slice(0,4).join('\n')};
  if(typeof detail==='string')return detail.slice(0,4000);
  try{
    const copy=JSON.parse(JSON.stringify(detail,(key,value)=>/password|token|apikey|authorization|secret/i.test(key)?'[redacted]':value));
    return copy;
  }catch{return String(detail).slice(0,4000)}
}
function debugLog(level,area,message,detail=''){
  const entry={ts:new Date().toISOString(),level,area,message,detail:cleanDebugDetail(detail)};
  debugEntries.push(entry);
  if(debugEntries.length>DEBUG_MAX_ENTRIES)debugEntries=debugEntries.slice(-DEBUG_MAX_ENTRIES);
  try{localStorage.setItem(DEBUG_LOG_KEY,JSON.stringify(debugEntries))}catch{}
  if(level==='error')console.error(`[Hop Contract:${area}] ${message}`,detail||'');
  else if(level==='warn')console.warn(`[Hop Contract:${area}] ${message}`,detail||'');
  else console.log(`[Hop Contract:${area}] ${message}`,detail||'');
  if(page==='debug')requestAnimationFrame(()=>{const el=$('#debug-live-log');if(el)el.innerHTML=debugLogHtml()});
}
function formatDbError(error){
  if(!error)return '';
  return [error.message,error.code?`code ${error.code}`:'',error.details?`details: ${error.details}`:'',error.hint?`hint: ${error.hint}`:''].filter(Boolean).join(' · ');
}
function payloadSummary(payload){
  let bytes=0;try{bytes=new Blob([JSON.stringify(payload)]).size}catch{}
  return {beers:payload?.beers?.length||0,inventory:payload?.inventory?.length||0,orders:payload?.orders?.length||0,recipeLines:(payload?.beers||[]).reduce((n,b)=>n+(b.hops?.length||0),0),bytes};
}
function timeoutError(label,ms){const e=new Error(`${label} timed out after ${Math.round(ms/1000)} seconds`);e.name='TimeoutError';e.code='CLIENT_TIMEOUT';return e}
async function withTimeout(promise,label,ms=30000){
  let timer;
  try{return await Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError(label,ms)),ms)})])}
  finally{clearTimeout(timer)}
}
function debugLogText(){
  return debugEntries.map(e=>`${e.ts} [${String(e.level).toUpperCase()}] ${e.area}: ${e.message}${e.detail!==''?`\n  ${typeof e.detail==='string'?e.detail:JSON.stringify(e.detail)}`:''}`).join('\n');
}
function debugLogHtml(){
  if(!debugEntries.length)return '<div class="empty">No debug entries yet. Press <strong>Run diagnostics</strong>, or make an edit and wait for autosave.</div>';
  return [...debugEntries].reverse().map(e=>`<div class="debug-entry ${esc(e.level)}"><div><strong>${esc(new Date(e.ts).toLocaleTimeString('en-GB'))}</strong> · ${esc(e.area)} · ${esc(e.message)}</div>${e.detail!==''?`<pre>${esc(typeof e.detail==='string'?e.detail:JSON.stringify(e.detail,null,2))}</pre>`:''}</div>`).join('');
}
function clearDebugLog(){debugEntries=[];try{localStorage.removeItem(DEBUG_LOG_KEY)}catch{};debugLog('info','debug','Debug log cleared')}
const SESSION_STORAGE_KEY = 'hop-contract-editor-session-v1';
let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
if (!sessionId) { sessionId = uuid(); sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId); }

const INVENTORY_COLUMN_DEFAULTS = {
  variety:190, format:95, hemisphere:115, contractEnabled:105, priceKg:105, stockKg:115, contractKg:135, supplierReceived12Kg:145, contractTotalKg:140, forecastContract:155
};
const DASHBOARD_HOP_COLUMN_DEFAULTS = {
  hop:220, stock:115, contractLeft:125, previousUse:145, projectedUse:150, previousContract:145, recommended:160
};
const DASHBOARD_BEER_COLUMN_DEFAULTS = {
  beer:180, type:125, basis:260, base:125, repeat:125, total:125
};
const BEER_REGISTER_COLUMN_DEFAULTS = {
  beer:180, type:120, batch:115, basis:240, forecast:125, recipe:360, status:100, actions:110
};
const PRODUCTION_COLUMN_DEFAULTS = {
  beer:175, include:80, batch:115, last12:150, growth:135, brews:120, brewHl:120, monthly:135, monthly12:125, oneoff:125, total:145
};
const INVENTORY_WIDTHS_KEY = 'hop-contract-inventory-column-widths-v113';
const DASHBOARD_HOP_WIDTHS_KEY = 'hop-contract-dashboard-hop-column-widths-v18';
const DASHBOARD_BEER_WIDTHS_KEY = 'hop-contract-dashboard-beer-column-widths-v18';
const BEER_REGISTER_WIDTHS_KEY = 'hop-contract-beer-register-column-widths-v18';
const PRODUCTION_WIDTHS_KEY = 'hop-contract-production-column-widths-v116';

const UNIVERSAL_TABLE_PREFS_KEY='hop-contract-universal-table-prefs-v118';
let universalTablePrefs=(()=>{
  try{
    const value=JSON.parse(localStorage.getItem(UNIVERSAL_TABLE_PREFS_KEY)||'{}');
    return value&&typeof value==='object'?value:{};
  }catch{return {}}
})();

// Carry the v1.17 12-month visibility selection into the new universal table system.
if(!universalTablePrefs.production){
  try{
    const oldVisible=JSON.parse(localStorage.getItem('hop-contract-production-visible-columns-v117')||'null');
    if(Array.isArray(oldVisible)){
      const all=Object.keys(PRODUCTION_COLUMN_DEFAULTS);
      universalTablePrefs.production={order:[...all],hidden:all.filter(k=>!oldVisible.includes(k))};
      localStorage.setItem(UNIVERSAL_TABLE_PREFS_KEY,JSON.stringify(universalTablePrefs));
    }
  }catch{}
}

let universalDraggedColumn=null;

function tableSlug(value=''){
  return String(value||'').toLowerCase().replace(/[↑↓]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'column';
}
function universalTableKey(table,index=0){
  if(table.dataset.tableViewKey)return table.dataset.tableViewKey;
  let key='';
  if(table.id)key=table.id.replace(/-table$/,'');
  else if(table.classList.contains('recipe-usage-table'))key='recipe-usage';
  else if(table.classList.contains('finalise-table'))key='finalise-contract';
  else{
    const labels=[...table.querySelectorAll('thead tr:first-child th')].slice(0,2).map(th=>tableSlug(th.textContent));
    key=`${page||'app'}-${labels.filter(Boolean).join('-')||`table-${index+1}`}`;
  }
  table.dataset.tableViewKey=key;
  return key;
}
function saveUniversalTablePrefs(){
  localStorage.setItem(UNIVERSAL_TABLE_PREFS_KEY,JSON.stringify(universalTablePrefs));
}
function universalPrefsFor(key,defaultOrder){
  const existing=universalTablePrefs[key]||{};
  const allowed=new Set(defaultOrder),order=[];
  for(const k of Array.isArray(existing.order)?existing.order:[])if(allowed.has(k)&&!order.includes(k))order.push(k);
  for(const k of defaultOrder)if(!order.includes(k))order.push(k);
  const hidden=(Array.isArray(existing.hidden)?existing.hidden:[]).filter(k=>allowed.has(k));
  return {order,hidden};
}
function tableViewDefaults(key,defaults){
  const prefs=universalPrefsFor(key,Object.keys(defaults)),hidden=new Set(prefs.hidden);
  return Object.fromEntries(prefs.order.filter(k=>!hidden.has(k)&&k in defaults).map(k=>[k,defaults[k]]));
}
function managedTableKey(key){
  return ['inventory','dashboard-hop','dashboard-beer','beer-register','production'].includes(key)?key:'';
}
function prepareUniversalTable(table,index=0){
  const key=universalTableKey(table,index);
  const ths=[...table.querySelectorAll('thead tr:first-child th')];
  if(!ths.length)return null;

  let defaultOrder=[];
  try{defaultOrder=JSON.parse(table.dataset.defaultColumnOrder||'[]')}catch{}
  if(!Array.isArray(defaultOrder)||defaultOrder.length!==ths.length){
    const cols=[...table.querySelectorAll(':scope > colgroup > col')],used=new Set();
    defaultOrder=ths.map((th,i)=>{
      let k=th.dataset.tableColumnKey||th.dataset.colKey||cols[i]?.dataset.colKey||'';
      if(!k){
        const base=tableSlug(th.textContent);k=base;let n=2;
        while(used.has(k))k=`${base}-${n++}`;
      }
      used.add(k);return k;
    });
    table.dataset.defaultColumnOrder=JSON.stringify(defaultOrder);
  }

  const labels={};
  ths.forEach((th,i)=>{
    const k=th.dataset.tableColumnKey||defaultOrder[i];
    th.dataset.tableColumnKey=k;
    labels[k]=String(th.textContent||k).replace(/[↑↓]/g,'').trim()||k;
  });

  const assignRowKeys=(row)=>{
    const cells=[...row.children].filter(c=>c.tagName==='TD'||c.tagName==='TH');
    if(cells.length!==defaultOrder.length)return;
    if(cells.every(c=>c.dataset.tableColumnKey))return;
    cells.forEach((cell,i)=>cell.dataset.tableColumnKey=defaultOrder[i]);
  };
  table.querySelectorAll('tbody tr,tfoot tr').forEach(assignRowKeys);

  const cols=[...table.querySelectorAll(':scope > colgroup > col')];
  if(cols.length===defaultOrder.length)cols.forEach((col,i)=>{if(!col.dataset.tableColumnKey)col.dataset.tableColumnKey=col.dataset.colKey||defaultOrder[i]});

  return {key,defaultOrder,labels};
}
function reorderUniversalChildren(parent,order){
  if(!parent)return;
  const byKey=new Map([...parent.children].filter(c=>c.dataset.tableColumnKey).map(c=>[c.dataset.tableColumnKey,c]));
  for(const key of order){const node=byKey.get(key);if(node)parent.appendChild(node)}
}
function applyUniversalTableView(table,info){
  if(!info)return;
  const prefs=universalPrefsFor(info.key,info.defaultOrder),hidden=new Set(prefs.hidden);
  reorderUniversalChildren(table.querySelector('thead tr:first-child'),prefs.order);

  table.querySelectorAll('tbody tr,tfoot tr').forEach(row=>{
    const cells=[...row.children].filter(c=>c.dataset.tableColumnKey);
    if(cells.length===info.defaultOrder.length)reorderUniversalChildren(row,prefs.order);
  });

  const colgroup=table.querySelector(':scope > colgroup');
  if(colgroup){
    reorderUniversalChildren(colgroup,prefs.order);
    [...colgroup.children].forEach(col=>{
      if(col.dataset.tableColumnKey)col.style.display=hidden.has(col.dataset.tableColumnKey)?'none':'';
    });
  }
  table.querySelectorAll('[data-table-column-key]').forEach(cell=>cell.style.display=hidden.has(cell.dataset.tableColumnKey)?'none':'');

  const mk=managedTableKey(info.key);
  if(mk){
    const cfg=resizeConfig(mk),total=widthTotal(cfg.widths,cfg.defaults),available=Math.max(0,(table.closest('.table-wrap')?.clientWidth||0)-2),displayWidth=Math.max(total,available);
    table.style.width=`${displayWidth}px`;table.style.minWidth=`${displayWidth}px`;
  }else{
    table.style.width='';table.style.minWidth='';
  }
}
function universalTableMenuHtml(info){
  const prefs=universalPrefsFor(info.key,info.defaultOrder),hidden=new Set(prefs.hidden),visibleCount=prefs.order.filter(k=>!hidden.has(k)).length;
  return `<details class="universal-column-picker" data-universal-picker="${esc(info.key)}">
    <summary class="btn">Columns · ${visibleCount}/${prefs.order.length}</summary>
    <div class="universal-column-menu">
      <div class="universal-column-menu-title">Columns & order</div>
      <div class="help universal-column-help">Tick to show. Drag rows to reorder.</div>
      <div class="universal-column-list">${prefs.order.map((colKey,idx)=>`<div class="universal-column-option" draggable="true" data-table-drag-column="${esc(colKey)}" data-table-key="${esc(info.key)}">
        <span class="universal-drag-handle" title="Drag to reorder">☰</span>
        <label><input type="checkbox" data-table-toggle-column="${esc(colKey)}" data-table-key="${esc(info.key)}" ${hidden.has(colKey)?'':'checked'}><span>${esc(info.labels[colKey]||colKey)}</span></label>
        <span class="universal-column-arrows"><button type="button" class="mini-order-btn" data-table-view-action="column-up" data-table-key="${esc(info.key)}" data-column="${esc(colKey)}" ${idx===0?'disabled':''} title="Move left">↑</button><button type="button" class="mini-order-btn" data-table-view-action="column-down" data-table-key="${esc(info.key)}" data-column="${esc(colKey)}" ${idx===prefs.order.length-1?'disabled':''} title="Move right">↓</button></span>
      </div>`).join('')}</div>
      <div class="universal-column-footer"><button type="button" class="btn small" data-table-view-action="show-all" data-table-key="${esc(info.key)}">Show all</button><button type="button" class="btn small" data-table-view-action="reset" data-table-key="${esc(info.key)}">Reset table</button></div>
      <div class="help">Display preferences are stored only in this browser.</div>
    </div>
  </details>`;
}
function ensureUniversalTableToolbar(table,info){
  const wrap=table.closest('.table-wrap')||table.parentElement;
  if(!wrap||!info)return;
  const toolbarKey=`universal-table-toolbar-${info.key}`;
  let toolbar=wrap.previousElementSibling;
  if(!toolbar||toolbar.dataset.universalToolbar!==toolbarKey){
    toolbar=document.createElement('div');toolbar.className='universal-table-toolbar';toolbar.dataset.universalToolbar=toolbarKey;
    wrap.parentNode.insertBefore(toolbar,wrap);
  }
  const wasOpen=!!toolbar.querySelector('details[open]');
  toolbar.innerHTML=`<div class="universal-table-toolbar-copy"><span>Table view</span><span class="help">show · hide · reorder</span></div><div class="actions">${universalTableMenuHtml(info)}<button type="button" class="btn" data-table-view-action="reset" data-table-key="${esc(info.key)}">Reset table</button></div>`;
  if(wasOpen)toolbar.querySelector('details')?.setAttribute('open','');
}
function universalTableInfoByKey(key){
  const tables=[...document.querySelectorAll('table')];
  for(let i=0;i<tables.length;i++){
    const table=tables[i];
    if(universalTableKey(table,i)===key)return {table,info:prepareUniversalTable(table,i)};
  }
  return null;
}
function enhanceUniversalTables(){
  document.querySelectorAll('#page-content [data-action="fit-table-columns"],#page-content [data-action="dashboard-reset-columns"]').forEach(btn=>btn.style.display='none');
  [...document.querySelectorAll('table')].forEach((table,index)=>{
    if(table.classList.contains('no-universal-table'))return;
    const info=prepareUniversalTable(table,index);if(!info)return;
    applyUniversalTableView(table,info);ensureUniversalTableToolbar(table,info);
  });
}
function updateUniversalToolbar(key,keepOpen=true){
  const found=universalTableInfoByKey(key);if(!found)return;
  const wrap=found.table.closest('.table-wrap')||found.table.parentElement,toolbarBefore=wrap?.previousElementSibling,wasOpen=keepOpen&&!!toolbarBefore?.querySelector('details[open]');
  applyUniversalTableView(found.table,found.info);ensureUniversalTableToolbar(found.table,found.info);
  if(wasOpen)(wrap?.previousElementSibling?.querySelector('details'))?.setAttribute('open','');
}
function moveUniversalColumn(key,column,delta){
  const found=universalTableInfoByKey(key);if(!found)return;
  const prefs=universalPrefsFor(key,found.info.defaultOrder),i=prefs.order.indexOf(column),j=i+delta;
  if(i<0||j<0||j>=prefs.order.length)return;
  [prefs.order[i],prefs.order[j]]=[prefs.order[j],prefs.order[i]];
  universalTablePrefs[key]={...universalTablePrefs[key],order:prefs.order,hidden:prefs.hidden};
  saveUniversalTablePrefs();updateUniversalToolbar(key,true);
}
function resetUniversalTableView(key){
  delete universalTablePrefs[key];saveUniversalTablePrefs();
  const mk=managedTableKey(key);
  if(mk){
    const cfg=resizeConfig(mk);
    const fullDefaults=mk==='inventory'?INVENTORY_COLUMN_DEFAULTS:mk==='dashboard-hop'?DASHBOARD_HOP_COLUMN_DEFAULTS:mk==='dashboard-beer'?DASHBOARD_BEER_COLUMN_DEFAULTS:mk==='beer-register'?BEER_REGISTER_COLUMN_DEFAULTS:PRODUCTION_COLUMN_DEFAULTS;
    for(const k of Object.keys(cfg.widths))delete cfg.widths[k];
    Object.assign(cfg.widths,fullDefaults);localStorage.removeItem(cfg.storageKey);
  }
  render();
}

function loadWidths(key,defaults){
  try { return {...defaults, ...JSON.parse(localStorage.getItem(key) || '{}')}; }
  catch { return {...defaults}; }
}
let inventoryColWidths = loadWidths(INVENTORY_WIDTHS_KEY,INVENTORY_COLUMN_DEFAULTS);
let dashboardHopColWidths = loadWidths(DASHBOARD_HOP_WIDTHS_KEY,DASHBOARD_HOP_COLUMN_DEFAULTS);
let dashboardBeerColWidths = loadWidths(DASHBOARD_BEER_WIDTHS_KEY,DASHBOARD_BEER_COLUMN_DEFAULTS);
let beerRegisterColWidths = loadWidths(BEER_REGISTER_WIDTHS_KEY,BEER_REGISTER_COLUMN_DEFAULTS);
let productionColWidths = loadWidths(PRODUCTION_WIDTHS_KEY,PRODUCTION_COLUMN_DEFAULTS);
const autoFitPending = new Set([
  ...(!localStorage.getItem(INVENTORY_WIDTHS_KEY)?['inventory']:[]),
  ...(!localStorage.getItem(DASHBOARD_HOP_WIDTHS_KEY)?['dashboard-hop']:[]),
  ...(!localStorage.getItem(DASHBOARD_BEER_WIDTHS_KEY)?['dashboard-beer']:[]),
  ...(!localStorage.getItem(BEER_REGISTER_WIDTHS_KEY)?['beer-register']:[]),
  ...(!localStorage.getItem(PRODUCTION_WIDTHS_KEY)?['production']:[])
]);

const pageMeta = {
  dashboard:['Dashboard','Annual hop contract planning with frozen historic contract years.'],
  beers:['Beers & recipes','Current forward-looking recipes; finalised contract years keep immutable recipe snapshots.'],
  production:['12-month forecast','Historical hL sets the volume baseline only; current recipes calculate future hop demand.'],
  orders:['Orders & calculator','Convert cans, kegs and casks into hL and exact hop requirements.'],
  inventory:['Hop inventory','Current quantities, supplier receipt cross-checks and next-contract requirements.'],
  settings:['Settings','Current planning assumptions. Contract years are created from the Dashboard.'],
  data:['Data & backup','Cloud saves, snapshots, JSON export and legacy import.'],
  debug:['Debug log','Live diagnostics for Supabase auth, editing lock, loading and autosave.']
};

function normalise(input={}) {
  const base = defaultState();
  const s = {...base,...input,version:APP_VERSION,settings:{...base.settings,...(input.settings||{})}};
  s.settings.hopFormats=normaliseHopFormats(s.settings.hopFormats);
  s.beers = Array.isArray(input.beers) ? input.beers.map(b=>({
    id:isUuid(b.id)?b.id:uuid(), name:b.name||'Unnamed beer', batchHl:Math.max(.01,num(b.batchHl)||21), active:b.active!==false,
    forecastType:['core','seasonal','monthly','oneoff'].includes(b.forecastType)?b.forecastType:'core',
    last12Hl:Math.max(0,num(b.last12Hl)),growthPct:Math.max(-100,num(b.growthPct)),forecastBrews:Math.max(0,Math.round(num(b.forecastBrews))),monthlyHl:Math.max(0,num(b.monthlyHl)),oneOffHl:Math.max(0,num(b.oneOffHl)),notes:b.notes||'',
    hops:Array.isArray(b.hops)?b.hops.map(h=>({id:isUuid(h.id)?h.id:uuid(),inventoryId:isUuid(h.inventoryId)?h.inventoryId:'',variety:h.variety||'',kgPerBrew:Math.max(0,num(h.kgPerBrew)),additionStage:h.additionStage||'',notes:h.notes||''})):[]
  })) : [];
  // v1.12 one-time forecast migration:
  // every beer actually brewed in the trailing 12 months starts Included.
  // Old single-brew imports were automatically labelled One-off; when they
  // have no explicit future one-off volume, convert them to Seasonal so the
  // real trailing-12-month volume is used as the baseline.
  if(!s.settings.includeHistoricalBrewsV112){
    for(const beer of s.beers){
      if(num(beer.last12Hl)>0){
        beer.active=true;
        if(beer.forecastType==='oneoff' && num(beer.oneOffHl)<=0) beer.forecastType='seasonal';
      }
    }
    s.settings.includeHistoricalBrewsV112=true;
  }
  const beerIds = new Set(s.beers.map(b=>b.id));
  s.orders = Array.isArray(input.orders) ? input.orders.filter(o=>beerIds.has(o.beerId)).map(o=>({
    id:isUuid(o.id)?o.id:uuid(),name:o.name||'Customer order',customerName:o.customerName||'',beerId:o.beerId,
    packageKey:[...PACKAGES.map(p=>p.key),'custom'].includes(o.packageKey)?o.packageKey:'cask40',unitSizeL:Math.max(.001,num(o.unitSizeL)||40),
    confirmedUnits:Math.max(0,Math.round(num(o.confirmedUnits))),fulfilledUnits:Math.max(0,Math.round(num(o.fulfilledUnits))),likelyRepeatUnits:Math.max(0,Math.round(num(o.likelyRepeatUnits))),
    status:['draft','provisional','confirmed','completed','cancelled'].includes(o.status)?o.status:'confirmed',deliveryDate:o.deliveryDate||'',notes:o.notes||''
  })) : [];
  s.inventory = Array.isArray(input.inventory) ? input.inventory.map(i=>({
    id:isUuid(i.id)?i.id:uuid(),variety:i.variety||'',hopFormat:cleanHopFormat(i.hopFormat||splitHopProduct(i.variety||'','',s.settings.hopFormats).format),stockKg:Math.max(0,num(i.stockKg)),contractTotalKg:Math.max(0,num(i.contractTotalKg)),contractKg:Math.max(0,num(i.contractKg)),expectedUseKg:Math.max(0,num(i.expectedUseKg)),
    supplierReceived12Kg:Math.max(0,num(i.supplierReceived12Kg)),contractEnabled:i.contractEnabled!==false,hemisphere:normaliseHemisphere(i.hemisphere,i.variety||''),priceKg:Math.max(0,num(i.priceKg)),roundingKg:Math.max(.01,num(i.roundingKg)||num(s.settings.globalRoundingKg)||1),minContractKg:Math.max(0,num(i.minContractKg)),
    manualContractKg:i.manualContractKg===null||i.manualContractKg===undefined||i.manualContractKg===''?'':Math.max(0,num(i.manualContractKg)),safetyStockPct:Math.max(0,num(i.safetyStockPct)),
    cropYear:i.cropYear||'',supplier:i.supplier||'',notes:i.notes||''
  })) : [];
  if(!s.settings.contractProductsV113){
    for(const item of s.inventory){
      item.hemisphere=normaliseHemisphere(item.hemisphere,item.variety);
      if(isHyperBoostProduct(item.variety))item.contractEnabled=false;
    }
    s.settings.contractProductsV113=true;
  }
  if(!s.settings.hopFormatsV114){
    const configured=normaliseHopFormats(s.settings.hopFormats);
    const seen=new Set(configured.map(f=>f.toLowerCase()));
    for(const item of s.inventory){
      const f=cleanHopFormat(item.hopFormat);
      if(f&&!seen.has(f.toLowerCase())){seen.add(f.toLowerCase());configured.push(f)}
    }
    s.settings.hopFormats=configured;
    s.settings.hopFormatsV114=true;
  }
  const inventoryByName = new Map(s.inventory.filter(i=>String(i.variety||'').trim()).map(i=>[String(i.variety).trim().toLowerCase(),i]));
  const inventoryIds = new Set(s.inventory.map(i=>i.id));
  for(const beer of s.beers){
    for(const hop of beer.hops||[]){
      if(hop.inventoryId && inventoryIds.has(hop.inventoryId)){
        const item=s.inventory.find(i=>i.id===hop.inventoryId);
        if(item)hop.variety=item.variety;
        continue;
      }
      const match=inventoryByName.get(String(hop.variety||'').trim().toLowerCase());
      if(match){hop.inventoryId=match.id;hop.variety=match.variety;}
    }
  }
  return s;
}

const SOUTHERN_HOP_VARIETIES = new Set([
  'nelson sauvin','nectaron','motueka','riwaka','rakau','wai-iti','waimea','kohatu',
  'pacific jade','pacifica','pacific gem','southern cross','taiheke','moutere','superdelic',
  'galaxy','vic secret','enigma','eclipse','ella','topaz'
]);
function inferredHemisphere(productName=''){
  const p=splitHopProduct(productName);
  return SOUTHERN_HOP_VARIETIES.has(String(p.variety||'').trim().toLowerCase())?'Southern':'Northern';
}
function normaliseHemisphere(value,productName=''){
  return value==='Southern'?'Southern':value==='Northern'?'Northern':inferredHemisphere(productName);
}
function isHyperBoostProduct(productName=''){
  return /(?:^|\s)hyperboost(?:\s+oil)?$/i.test(String(productName||'').trim());
}

function canonicalInventoryName(value=''){return String(value||'').trim().replace(/\s+/g,' ').toLowerCase()}
function inventoryDuplicateGroups(){
  const groups=new Map();
  for(const item of state.inventory||[]){
    const key=canonicalInventoryName(item.variety);
    if(!key)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(item);
  }
  return [...groups.values()].filter(group=>group.length>1);
}
function inventoryReferenceCount(id){
  return (state.beers||[]).reduce((total,b)=>total+(b.hops||[]).filter(h=>h.inventoryId===id).length,0);
}
function mergeInventoryDuplicates(){
  const groups=inventoryDuplicateGroups();
  if(!groups.length)return {merged:0,names:[]};
  const names=[];
  let merged=0;
  for(const group of groups){
    const ranked=[...group].sort((a,b)=>inventoryReferenceCount(b.id)-inventoryReferenceCount(a.id));
    const keeper=ranked[0];
    names.push(keeper.variety);
    const others=ranked.slice(1);
    const numericMax=['stockKg','contractTotalKg','contractKg','expectedUseKg','supplierReceived12Kg','minContractKg','roundingKg','safetyStockPct'];
    for(const field of numericMax) keeper[field]=Math.max(...group.map(x=>num(x[field])));
    if(!num(keeper.priceKg)){const priced=group.find(x=>num(x.priceKg)>0);if(priced)keeper.priceKg=num(priced.priceKg)}
    if(keeper.manualContractKg===''||keeper.manualContractKg===null||keeper.manualContractKg===undefined){const manual=group.find(x=>x.manualContractKg!==''&&x.manualContractKg!==null&&x.manualContractKg!==undefined);if(manual)keeper.manualContractKg=manual.manualContractKg}
    const duplicateIds=new Set(others.map(x=>x.id));
    for(const beer of state.beers||[])for(const hop of beer.hops||[])if(duplicateIds.has(hop.inventoryId)||canonicalInventoryName(hop.variety)===canonicalInventoryName(keeper.variety)){hop.inventoryId=keeper.id;hop.variety=keeper.variety}
    state.inventory=state.inventory.filter(x=>!duplicateIds.has(x.id));
    merged+=others.length;
  }
  return {merged,names};
}
function validateBeforeSave(){
  const duplicates=inventoryDuplicateGroups();
  if(!duplicates.length)return null;
  return `Duplicate Hop Stock item${duplicates.length>1?'s':''}: ${duplicates.map(g=>g[0].variety).join(', ')}. Merge duplicate entries before saving.`;
}
function captureViewPosition(){
  return {windowY:window.scrollY,wraps:[...document.querySelectorAll('#page-content .table-wrap')].map((el,index)=>({index,id:el.querySelector('table')?.id||'',top:el.scrollTop,left:el.scrollLeft}))};
}
function restoreViewPosition(view){
  if(!view)return;
  requestAnimationFrame(()=>{window.scrollTo(0,view.windowY||0);for(const saved of view.wraps||[]){let el=saved.id?document.querySelector(`#${CSS.escape(saved.id)}`)?.closest('.table-wrap'):null;if(!el)el=document.querySelectorAll('#page-content .table-wrap')[saved.index];if(el){el.scrollTop=saved.top;el.scrollLeft=saved.left}}});
}
function renderPreservingView(view=captureViewPosition()){render();restoreViewPosition(view)}
function recipeUsageForInventory(inventoryId){
  const item=state.inventory.find(i=>i.id===inventoryId);
  if(!item)return [];
  const rows=[];
  for(const beer of state.beers||[]){
    const matches=(beer.hops||[]).filter(h=>h.inventoryId===inventoryId||(!h.inventoryId&&canonicalInventoryName(h.variety)===canonicalInventoryName(item.variety)));
    if(!matches.length)continue;
    const kgPerBrew=matches.reduce((sum,h)=>sum+num(h.kgPerBrew),0);
    const batchHl=Math.max(.001,num(beer.batchHl));
    const kgPerHl=kgPerBrew/batchHl;
    const forecastHl=beerBaseForecastHl(beer);
    rows.push({beer,kgPerBrew,batchHl,kgPerHl,forecastHl,projectedKg:forecastHl*kgPerHl,lineCount:matches.length});
  }
  return rows.sort((a,b)=>a.beer.name.localeCompare(b.beer.name,undefined,{numeric:true,sensitivity:'base'}));
}
function openRecipeUsageModal(inventoryId){
  const item=state.inventory.find(i=>i.id===inventoryId);
  if(!item)return;

  const modal=$('#recipe-usage-modal');
  const title=$('#recipe-usage-title');
  const copy=$('#recipe-usage-copy');
  const summary=$('#recipe-usage-summary');
  const body=$('#recipe-usage-rows');

  if(!modal||!title||!copy||!summary||!body){
    debugLog('error','recipe-usage','Recipe usage modal is missing required HTML elements',{
      modal:!!modal,title:!!title,copy:!!copy,summary:!!summary,rows:!!body
    });
    alert('The recipe usage window could not be opened. Refresh after deploying the latest app version.');
    return;
  }

  const rows=recipeUsageForInventory(inventoryId);
  const product=splitHopProduct(item.variety,item.hopFormat,state.settings.hopFormats);
  const displayFormat=cleanHopFormat(item.hopFormat||product.format);
  title.textContent=`${product.variety||item.variety}${displayFormat?` · ${displayFormat}`:''}`;
  copy.textContent='Current recipe snapshot. This shows every live beer recipe using this exact inventory item and its contribution to the current 12-month forecast.';

  const projectedTotal=rows.reduce((sum,row)=>sum+num(row.projectedKg),0);
  const recipeTotal=rows.reduce((sum,row)=>sum+num(row.kgPerBrew),0);

  summary.innerHTML=`
    <div><span>Recipes</span><strong>${rows.length}</strong></div>
    <div><span>Total kg across listed standard brews</span><strong>${fmt(recipeTotal,3)} kg</strong></div>
    <div><span>Projected 12m use</span><strong>${fmt(projectedTotal,2)} kg</strong></div>
    <div><span>Contract product</span><strong>${item.contractEnabled===false?'No':'Yes'}</strong></div>
  `;

  body.innerHTML=rows.length?rows.map(r=>`
    <tr>
      <td><strong>${esc(r.beer.name)}</strong>${r.beer.active===false?'<div class="help">Not included in forecast</div>':''}</td>
      <td>${esc(currentRecipeVersionLabel(r.beer,selectedContractYear()?.year||state.settings.forecastYear))}</td>
      <td>${fmt(r.batchHl)} hL</td>
      <td><strong>${fmt(r.kgPerBrew,3)}</strong></td>
      <td>${fmt(r.kgPerHl,4)}</td>
      <td>${fmt(r.forecastHl)}</td>
      <td><strong>${fmt(r.projectedKg,2)} kg</strong></td>
    </tr>
  `).join(''):`<tr><td colspan="7"><div class="empty">No current beer recipes use this exact inventory item.</div></td></tr>`;

  modal.classList.remove('hidden');
  requestAnimationFrame(enhanceUniversalTables);
}

function csvCell(value){
  const text=String(value??'');
  return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}
function supplierContractExportRows(hemisphere='Northern'){
  const year=selectedContractYear();
  let rows=[];
  if(year?.status==='finalised'){
    if(!selectedContractDetail)return [];
    rows=(selectedContractDetail.hops||[]).map(h=>{
      const product=splitHopProduct(h.hopName||'',h.hopFormat||'',state.settings.hopFormats);
      return {variety:product.variety||h.hopName||'',format:cleanHopFormat(h.hopFormat||product.format),hemisphere:normaliseHemisphere(h.hemisphere,h.hopName||''),contractEnabled:h.contractEnabled!==false,kg:Math.max(0,num(h.finalContractKg))};
    });
  }else{
    rows=calculateForecast(state).map(r=>{
      const product=splitHopProduct(r.variety||'',r.hopFormat||'',state.settings.hopFormats);
      return {variety:product.variety||r.variety||'',format:cleanHopFormat(r.hopFormat||product.format),hemisphere:normaliseHemisphere(r.hemisphere,r.variety||''),contractEnabled:r.contractEnabled!==false,kg:Math.max(0,dashboardRecommendedContract(r))};
    });
  }
  return rows.filter(r=>r.contractEnabled&&r.hemisphere===hemisphere&&r.variety&&r.kg>0)
    .sort((a,b)=>a.variety.localeCompare(b.variety,undefined,{numeric:true,sensitivity:'base'})||a.format.localeCompare(b.format));
}
function exportSupplierContractCsv(hemisphere='Northern'){
  const year=selectedContractYear();
  const rows=supplierContractExportRows(hemisphere);
  if(!rows.length){alert(`No ${hemisphere.toLowerCase()} hemisphere contract quantities above 0 kg are available to export.`);return}
  if(year?.status!=='finalised'&&!confirm(`The ${year?.year||state.settings.forecastYear} ${hemisphere.toLowerCase()} hemisphere contract is still a draft. Export the current recommended quantities as a supplier proposal?`))return;
  const heading='Variety,Format,Final Contract kg';
  const body=rows.map(r=>[csvCell(r.variety),csvCell(r.format),csvCell(r.kg.toFixed(1))].join(',')).join('\r\n');
  const status=year?.status==='finalised'?'final':'draft';
  download(`Hop-Contract-${year?.year||state.settings.forecastYear}-${hemisphere}-${status}-supplier.csv`,`\ufeff${heading}\r\n${body}`,'text/csv;charset=utf-8');
}

function scheduleAutoSave(delay=60000){
  if(readOnly||!dirty||!user)return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer=setTimeout(()=>saveCloud({silent:true}),delay);
}
function markDirty() {
  if(readOnly)return;
  changeRevision+=1;
  dirty=true;
  saveError='';
  updateTopStatus();
  scheduleAutoSave();
}
function updateTopStatus(){
  const dirtyLabel=$('#dirty-label');
  if(dirtyLabel){
    dirtyLabel.classList.toggle('hidden',!dirty&&!saveInFlight&&!saveError);
    dirtyLabel.textContent=saveError?'Save problem':saveInFlight?'Saving…':dirty?'Unsaved changes':'Saved';
    dirtyLabel.title=saveError?`Click to see save error: ${saveError}`:'';
    dirtyLabel.style.cursor=saveError?'pointer':'default';
  }
  const status=$('#cloud-status');
  if(status)status.textContent=readOnly?'Cloud · read-only':saveError?'Cloud · save failed':saveInFlight?'Cloud · saving…':dirty?'Cloud · unsaved changes':'Cloud · saved';
  const saveBtn=$('#save-changes-btn');
  if(saveBtn){saveBtn.disabled=readOnly||saveInFlight||!dirty;saveBtn.textContent=saveInFlight?'Saving…':'Save changes';}
}

async function loadCloud(){
  clearTimeout(autoSaveTimer);
  const started=performance.now();
  debugLog('info','cloud-load','get_forecast_state started');
  let response;
  try{response=await withTimeout(supabase.rpc('get_forecast_state'),'Cloud load',30000)}
  catch(err){debugLog('error','cloud-load','Cloud load request failed or timed out',err);throw err}
  const {data,error}=response||{};
  if(error){debugLog('error','cloud-load','get_forecast_state returned an error',{message:error.message,code:error.code,details:error.details,hint:error.hint});throw error}
  state=normalise(data||{});
  dirty=false;
  saveError='';
  changeRevision=0;
  editingBeerId=null;
  debugLog('info','cloud-load',`Cloud state loaded in ${Math.round(performance.now()-started)} ms`,payloadSummary(state));
  render();
  updateTopStatus();
}
async function saveCloud({silent=false}={}){
  clearTimeout(autoSaveTimer);
  if(readOnly){
    debugLog('warn','save','Save blocked because session is read-only');
    if(!silent)alert('This session is read-only because another user owns the editing lock.');
    return;
  }
  if(!dirty){debugLog('info','save','Save requested but there are no unsaved changes');return;}
  const validationError=validateBeforeSave();
  if(validationError){saveError=validationError;debugLog('error','save-validation','Save blocked by local validation',{message:validationError});updateTopStatus();if(!silent)alert(validationError);return;}
  if(saveInFlight){saveQueued=true;debugLog('info','save','Save already in flight; queued another save');return;}
  saveInFlight=true;
  saveQueued=false;
  saveError='';
  const revisionAtStart=changeRevision;
  const saveStarted=performance.now();
  updateTopStatus();

  const payload=normalise(state);
  debugLog('info','save','Autosave/save started',{revision:revisionAtStart,sessionId,payload:payloadSummary(payload)});

  let lockResponse;
  try{
    debugLog('info','save-lock','Checking edit lock');
    lockResponse=await withTimeout(supabase.from('edit_locks').select('session_id,user_email,heartbeat_at').eq('lock_key','global').maybeSingle(),'Editing lock check',12000);
  }catch(err){
    saveInFlight=false;saveError=err.message;debugLog('error','save-lock','Editing lock request failed or timed out',err);updateTopStatus();scheduleAutoSave(60000);if(!silent)alert(`Could not verify editing lock: ${err.message}`);return;
  }
  const {data:lock,error:lockError}=lockResponse||{};
  if(lockError){
    saveInFlight=false;saveError=formatDbError(lockError);debugLog('error','save-lock','Editing lock query returned an error',{message:lockError.message,code:lockError.code,details:lockError.details,hint:lockError.hint});updateTopStatus();
    scheduleAutoSave(60000);
    if(!silent)alert(`Could not verify editing lock: ${saveError}`);
    return;
  }
  debugLog('info','save-lock','Editing lock read OK',{ownerEmail:lock?.user_email||'',sameSession:lock?.session_id===sessionId,heartbeat:lock?.heartbeat_at||''});
  if(!lock || lock.session_id!==sessionId){
    saveInFlight=false;
    lockOwned=false; readOnly=true; render(); updateTopStatus();
    debugLog('error','save-lock','Editing lock is not owned by this browser session',{ownerEmail:lock?.user_email||'',ownerSession:lock?.session_id||'',ourSession:sessionId});
    $('#lock-banner').textContent=`Editing lock lost${lock?.user_email?` to ${lock.user_email}`:''}. Reopen or take over editing before saving.`;
    $('#lock-banner').classList.remove('hidden');
    if(!silent)alert('Your changes have not been saved because another session now owns the editing lock.');
    return;
  }

  let saveResponse;
  try{
    debugLog('info','save-rpc','save_forecast_state RPC started',payloadSummary(payload));
    saveResponse=await withTimeout(supabase.rpc('save_forecast_state',{payload}),'save_forecast_state RPC',30000);
  }catch(err){
    saveInFlight=false;saveError=err.message;debugLog('error','save-rpc','Save RPC failed or timed out',err);updateTopStatus();scheduleAutoSave(60000);if(!silent)alert(`Save failed: ${saveError}`);return;
  }
  const {error}=saveResponse||{};
  saveInFlight=false;
  if(error){
    saveError=formatDbError(error);
    debugLog('error','save-rpc',`Save RPC returned an error after ${Math.round(performance.now()-saveStarted)} ms`,{message:error.message,code:error.code,details:error.details,hint:error.hint});
    updateTopStatus();
    scheduleAutoSave(60000);
    if(!silent)alert(`Save failed: ${saveError}`);
    return;
  }

  debugLog('info','save-rpc',`Save completed successfully in ${Math.round(performance.now()-saveStarted)} ms`,payloadSummary(payload));
  if(changeRevision===revisionAtStart){
    state=payload;
    dirty=false;
  }else{
    dirty=true;
    debugLog('info','save','More edits occurred while saving; scheduling another save',{startRevision:revisionAtStart,currentRevision:changeRevision});
    scheduleAutoSave(500);
  }
  saveError='';
  updateTopStatus();
  if(saveQueued||dirty)scheduleAutoSave(500);
}

async function loadSnapshots(){
  const {data,error}=await supabase.from('forecast_snapshots').select('id,name,created_at,created_by,snapshot').order('created_at',{ascending:false}).limit(30);
  snapshots=error?[]:(data||[]);
}


function selectedContractYear(){return contractYears.find(y=>y.id===selectedContractYearId)||null}
function contractYearByYear(year){return contractYears.find(y=>num(y.year)===num(year))||null}
async function loadContractYears(preferredId=''){
  const {data,error}=await supabase.rpc('get_contract_years');
  if(error){
    contractYears=[];selectedContractYearId='';selectedContractDetail=null;
    console.warn('Contract years unavailable:',error.message);
    return;
  }
  contractYears=Array.isArray(data)?data:[];
  if(preferredId && contractYears.some(y=>y.id===preferredId))selectedContractYearId=preferredId;
  if(!selectedContractYearId || !contractYears.some(y=>y.id===selectedContractYearId)){
    const matching=contractYears.find(y=>num(y.year)===num(state.settings.forecastYear));
    const draft=contractYears.find(y=>y.status==='draft');
    const latest=[...contractYears].sort((a,b)=>num(b.year)-num(a.year))[0];
    selectedContractYearId=(matching||draft||latest)?.id||'';
  }
  await loadSelectedContractDetail();
}
async function loadSelectedContractDetail(){
  const y=selectedContractYear();
  selectedContractDetail=null;
  if(!y || y.status!=='finalised')return;
  const {data,error}=await supabase.rpc('get_contract_year_detail',{p_contract_year_id:y.id});
  if(error){console.warn('Could not load contract year detail:',error.message);return}
  selectedContractDetail=data||null;
}
function contractYearOptions(){
  return contractYears.map(y=>`<option value="${y.id}" ${y.id===selectedContractYearId?'selected':''}>${esc(y.year)} · ${y.status==='finalised'?'Finalised':'Draft'}</option>`).join('');
}
function contractYearBar(){
  if(!contractYears.length)return `<div class="notice warn"><strong>Annual contract years are not enabled yet.</strong> Run the v1.7 Supabase migration, then reload the app.</div>`;
  const y=selectedContractYear();
  const hasDraft=contractYears.some(x=>x.status==='draft');
  const latestFinal=[...contractYears].filter(x=>x.status==='finalised').sort((a,b)=>num(b.year)-num(a.year))[0];
  return `<div class="contract-year-bar card"><div class="contract-year-picker"><div class="metric-label">Contract year</div><select id="contract-year-select">${contractYearOptions()}</select></div><div class="contract-year-copy"><strong>${y?.status==='finalised'?`${esc(y.year)} contract is frozen`:`Planning ${esc(y?.year||state.settings.forecastYear)}`}</strong><div class="help">${y?.status==='finalised'?'Historic beer volumes, recipes and hop decisions are immutable.':`Draft uses the latest actual trailing-12-month volumes and the current live recipes. Finalising freezes both.`}</div></div><div class="actions"><button class="btn" data-action="export-supplier-csv" data-hemisphere="Northern">${y?.status==='finalised'?'Export Northern CSV':'Export Northern proposal'}</button><button class="btn" data-action="export-supplier-csv" data-hemisphere="Southern">${y?.status==='finalised'?'Export Southern CSV':'Export Southern proposal'}</button>${y?.status==='draft'?`<button class="btn primary" data-action="finalise-contract-year">Finalise ${esc(y.year)} contract</button>`:''}${!hasDraft?`<button class="btn primary" data-action="create-contract-year">Create ${num((latestFinal||y)?.year)+1} contract year</button>`:''}</div></div>`;
}
function currentRecipeVersionLabel(beer,year){
  const text=[beer?.notes,...(beer?.hops||[]).map(h=>h.notes)].filter(Boolean).join(' ');
  const m=text.match(/Brewer(?:'s)? Friend\s*v?([0-9]+(?:\.[0-9]+)*)/i);
  return m?`v${m[1]}`:`${year} contract snapshot`;
}
function buildFinalisePayload(finalContracts=new Map()){
  const y=selectedContractYear();
  const rows=calculateForecast(state);
  const scenarioPct=scenarioAdjustmentPct();
  const beers=state.beers.filter(b=>b.active!==false).map(b=>({
    beerId:b.id,name:b.name,standardBrewHl:num(b.batchHl),recipeVersionLabel:currentRecipeVersionLabel(b,y?.year||state.settings.forecastYear),
    baselineLast12Hl:num(b.last12Hl),forecastType:b.forecastType,growthPct:num(b.growthPct),scenarioAdjustmentPct:scenarioPct,
    forecastBrews:Math.max(0,Math.round(num(b.forecastBrews))),monthlyHl:num(b.monthlyHl),oneOffHl:num(b.oneOffHl),forecastHl:beerBaseForecastHl(b),
    recipeHops:(b.hops||[]).map(h=>{const item=hopInventoryItem(h);return {inventoryId:item?.id||h.inventoryId||'',hopName:item?.variety||h.variety||'Unlinked hop',kgPerBrew:num(h.kgPerBrew),additionStage:h.additionStage||'',notes:h.notes||''}})
  }));
  const hops=rows.filter(r=>num(r.baseDemand)>0||num(r.stockKg)>0||num(r.contractKg)>0||num(r.contractTotalKg)>0||dashboardRecommendedContract(r)>0).map(r=>{
    const key=r.inventoryId||r.key;
    const recommended=dashboardRecommendedContract(r);
    const bridge=januaryBridge(r,y?.year||state.settings.forecastYear);
    return {inventoryId:r.inventoryId||'',hopName:r.variety,hopFormat:cleanHopFormat(r.hopFormat||splitHopProduct(r.variety,'',state.settings.hopFormats).format),hemisphere:normaliseHemisphere(r.hemisphere,r.variety),contractEnabled:r.contractEnabled!==false,inStockKg:num(r.stockKg),onContractKg:num(r.contractKg),previousUse12mKg:num(r.supplierReceived12Kg),projectedUseKg:num(r.baseDemand),useBeforeStartKg:bridge.useBeforeStart,stockAtStartKg:bridge.stockAtStart,contractRemainingAtStartKg:bridge.contractAtStart,preStartShortfallKg:bridge.shortfallBeforeStart,previousContractKg:num(r.contractTotalKg),recommendedContractKg:recommended,finalContractKg:r.contractEnabled===false?0:(finalContracts.has(key)?num(finalContracts.get(key)):recommended),priceKg:num(r.priceKg)};
  });
  return {year:y?.year,beers,hops};
}
function openFinaliseContractModal(){
  const y=selectedContractYear();
  if(!y||y.status!=='draft')return;
  const payload=buildFinalisePayload();
  const rows=payload.hops.sort((a,b)=>b.recommendedContractKg-a.recommendedContractKg||a.hopName.localeCompare(b.hopName));
  $('#finalise-contract-title').textContent=`Finalise ${y.year} hop contract`;
  $('#finalise-contract-copy').innerHTML=`This freezes the ${y.year} volume assumptions and the <strong>current recipe for every beer</strong>. Stock and current-contract balances are projected forward to <strong>1 January ${y.year}</strong> before the new contract is calculated. Later recipe changes will only affect future contract years. Final quantities are rounded up to 5 kg when saved.`;
  $('#finalise-contract-rows').innerHTML=rows.map(r=>`<tr><td><strong>${esc(r.hopName)}</strong><div class="help">${esc(r.hemisphere)}${r.contractEnabled===false?' · Not contracted':''}</div></td><td>${fmt(r.projectedUseKg)}</td><td>${fmt(r.previousContractKg)}</td><td>${fmt(r.recommendedContractKg)}</td><td><input type="number" min="0" step="5" data-final-contract-key="${esc(r.inventoryId||r.hopName)}" value="${num(r.contractEnabled===false?0:r.recommendedContractKg)}" ${r.contractEnabled===false?'disabled':''}></td></tr>`).join('');
  $('#finalise-contract-modal').classList.remove('hidden');
  requestAnimationFrame(enhanceUniversalTables);
}
function historicalHopSort(rows){
  const dir=dashboardHopSortDir==='desc'?-1:1;
  return [...rows].sort((a,b)=>{
    const val=(r,key)=>key==='hop'?String(r.hopName||'').toLowerCase():key==='stock'?num(r.inStockKg):key==='contractLeft'?num(r.onContractKg):key==='previousUse'?num(r.previousUse12mKg):key==='projectedUse'?num(r.projectedUseKg):key==='previousContract'?num(r.previousContractKg):key==='recommended'?num(r.finalContractKg):'';
    const av=val(a,dashboardHopSortKey),bv=val(b,dashboardHopSortKey);
    if(typeof av==='number'&&typeof bv==='number')return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}
function historicalBeerSort(rows){
  const dir=dashboardBeerSortDir==='desc'?-1:1;
  return [...rows].sort((a,b)=>{
    const val=(r,key)=>key==='beer'?String(r.name||'').toLowerCase():key==='type'?forecastTypeLabel(r.forecastType):key==='basis'?`${num(r.baselineLast12Hl)} ${num(r.growthPct)} ${num(r.scenarioAdjustmentPct)}`:key==='base'?num(r.forecastHl):key==='repeat'?String(r.recipeVersionLabel||'').toLowerCase():key==='total'?String((r.recipeHops||[]).map(h=>h.hopName).join(' ')).toLowerCase():'';
    const av=val(a,dashboardBeerSortKey),bv=val(b,dashboardBeerSortKey);
    if(typeof av==='number'&&typeof bv==='number')return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}

async function acquireLock(force=false){
  const {data:existing}=await supabase.from('edit_locks').select('*').eq('lock_key','global').maybeSingle();
  const stale=!existing || (Date.now()-new Date(existing.heartbeat_at).getTime()>120000);
  if(!existing||stale||force||existing.session_id===sessionId){
    const {error}=await supabase.from('edit_locks').upsert({lock_key:'global',user_id:user.id,user_email:user.email,session_id:sessionId,heartbeat_at:new Date().toISOString(),created_at:existing?.created_at||new Date().toISOString()},{onConflict:'lock_key'});
    if(error) throw error;
    readOnly=false;lockOwned=true;startHeartbeat();return true;
  }
  lockOwned=false;
  $('#lock-copy').textContent=`${existing.user_email||'Another user'} has the editing lock and was active ${new Date(existing.heartbeat_at).toLocaleTimeString('en-GB')}.`;
  $('#lock-modal').classList.remove('hidden');
  return false;
}
function startHeartbeat(){clearInterval(heartbeatTimer);heartbeatTimer=setInterval(async()=>{if(lockOwned&&user){await supabase.from('edit_locks').update({heartbeat_at:new Date().toISOString()}).eq('lock_key','global').eq('session_id',sessionId)}},30000)}
async function releaseLock(){if(!lockOwned)return;clearInterval(heartbeatTimer);await supabase.from('edit_locks').delete().eq('lock_key','global').eq('session_id',sessionId);lockOwned=false}

let passwordRecoveryMode=false;
const isPasswordRecoveryUrl=()=>new URLSearchParams(window.location.search).get('password-reset')==='1'||window.location.hash.includes('type=recovery');
function hideAuthViews(){['#auth-view','#signup-view','#reset-view'].forEach(s=>$(s)?.classList.add('hidden'));$('#app-view').classList.add('hidden')}
function showAuth(){hideAuthViews();$('#auth-view').classList.remove('hidden')}
function showSignUp(){hideAuthViews();$('#signup-view').classList.remove('hidden');$('#signup-email').value=$('#auth-email')?.value||'';setTimeout(()=>$('#signup-email')?.focus(),0)}
function showResetPassword(){hideAuthViews();$('#reset-view').classList.remove('hidden');setTimeout(()=>$('#reset-password')?.focus(),0)}
function showApp(){hideAuthViews();$('#app-view').classList.remove('hidden');$('#user-email').textContent=user?.email||'' }

async function enterAppFromSession(session,acquire=true){
  if(!session?.user){showAuth();return}
  user=session.user;showApp();await loadCloud();await loadContractYears();await loadSnapshots();if(acquire)await acquireLock(false);render();updateTopStatus();
}
async function initSession(){
  const {data:{session}}=await supabase.auth.getSession();
  if(isPasswordRecoveryUrl()&&session){passwordRecoveryMode=true;user=session.user;showResetPassword();return}
  if(!session){showAuth();return}
  await enterAppFromSession(session,true);
}

$('#auth-form').addEventListener('submit',async e=>{e.preventDefault();const email=$('#auth-email').value.trim(),password=$('#auth-password').value;$('#auth-message').classList.remove('good-message');$('#auth-message').textContent='Signing in…';const {data,error}=await supabase.auth.signInWithPassword({email,password});if(error){$('#auth-message').textContent=error.message;return}$('#auth-message').textContent='';await enterAppFromSession(data.session||{user:data.user},true)});
$('#show-sign-up-btn').addEventListener('click',showSignUp);
$('#back-to-sign-in-btn').addEventListener('click',showAuth);
$('#signup-form').addEventListener('submit',async e=>{e.preventDefault();const email=$('#signup-email').value.trim(),password=$('#signup-password').value,confirmPassword=$('#signup-password-confirm').value;const msg=$('#signup-message');msg.classList.remove('good-message');if(password!==confirmPassword){msg.textContent='Passwords do not match.';return}if(!email||password.length<6){msg.textContent='Enter an email and password of at least 6 characters.';return}msg.textContent='Creating account…';const {data,error}=await supabase.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin}});if(error){msg.textContent=error.message;return}if(data.session){msg.textContent='';await enterAppFromSession(data.session,true)}else{msg.classList.add('good-message');msg.textContent='Account created. Check your email to confirm the address, then sign in.'}});
$('#forgot-password-btn').addEventListener('click',async()=>{const email=$('#auth-email').value.trim();const msg=$('#auth-message');msg.classList.remove('good-message');if(!email){msg.textContent='Enter your email address first.';$('#auth-email').focus();return}msg.textContent='Sending reset email…';const redirectTo=`${window.location.origin}/?password-reset=1`;const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo});if(error){msg.textContent=error.message;return}msg.classList.add('good-message');msg.textContent='Password reset email sent. Open the link in that email to choose a new password.'});
$('#reset-password-form').addEventListener('submit',async e=>{e.preventDefault();const password=$('#reset-password').value,confirmPassword=$('#reset-password-confirm').value,msg=$('#reset-message');msg.classList.remove('good-message');if(password!==confirmPassword){msg.textContent='Passwords do not match.';return}if(password.length<6){msg.textContent='Password must be at least 6 characters.';return}msg.textContent='Saving new password…';const {data,error}=await supabase.auth.updateUser({password});if(error){msg.textContent=error.message;return}msg.classList.add('good-message');msg.textContent='Password updated.';passwordRecoveryMode=false;history.replaceState({},document.title,window.location.pathname);const {data:{session}}=await supabase.auth.getSession();setTimeout(()=>enterAppFromSession(session,true),350)});
$('#save-changes-btn')?.addEventListener('click',async()=>{const view=captureViewPosition();await saveCloud({silent:false});if(!dirty&&!saveError)renderPreservingView(view)});
$('#close-recipe-usage')?.addEventListener('click',()=>$('#recipe-usage-modal')?.classList.add('hidden'));
$('#recipe-usage-modal')?.addEventListener('click',e=>{if(e.target.id==='recipe-usage-modal')$('#recipe-usage-modal')?.classList.add('hidden')});
$('#change-password-btn').addEventListener('click',()=>{$('#change-password').value='';$('#change-password-confirm').value='';$('#change-password-message').textContent='';$('#change-password-modal').classList.remove('hidden');setTimeout(()=>$('#change-password').focus(),0)});
$('#cancel-change-password').addEventListener('click',()=>$('#change-password-modal').classList.add('hidden'));
$('#change-password-form').addEventListener('submit',async e=>{e.preventDefault();const password=$('#change-password').value,confirmPassword=$('#change-password-confirm').value,msg=$('#change-password-message');msg.classList.remove('good-message');if(password!==confirmPassword){msg.textContent='Passwords do not match.';return}if(password.length<6){msg.textContent='Password must be at least 6 characters.';return}msg.textContent='Updating password…';const {error}=await supabase.auth.updateUser({password});if(error){msg.textContent=error.message;return}msg.classList.add('good-message');msg.textContent='Password updated successfully.';setTimeout(()=>$('#change-password-modal').classList.add('hidden'),700)});
$('#cancel-finalise-contract').addEventListener('click',()=>$('#finalise-contract-modal').classList.add('hidden'));
$('#confirm-finalise-contract').addEventListener('click',async()=>{
  if(readOnly)return alert('Read-only mode.');
  const y=selectedContractYear();if(!y||y.status!=='draft')return;
  const finals=new Map();
  document.querySelectorAll('#finalise-contract-rows [data-final-contract-key]').forEach(i=>finals.set(i.dataset.finalContractKey,roundUp(Math.max(0,num(i.value)),5)));
  if(!confirm(`Finalise the ${y.year} contract? This permanently freezes the beer assumptions and exact recipe versions used for this forecast.`))return;
  if(dirty)await saveCloud({silent:false});
  const payload=buildFinalisePayload(finals);
  const {data,error}=await supabase.rpc('finalise_contract_year',{p_contract_year_id:y.id,p_payload:payload});
  if(error)return alert(`Finalisation failed: ${error.message}`);
  $('#finalise-contract-modal').classList.add('hidden');
  await loadContractYears(y.id);selectedContractDetail=data||selectedContractDetail;await loadSnapshots();render();
});
$('#sign-out-btn').addEventListener('click',async()=>{if(dirty&&!confirm('You have unsaved changes. Sign out anyway?'))return;await releaseLock();await supabase.auth.signOut();user=null;showAuth()});
$('#dirty-label').addEventListener('click',()=>{if(saveError||saveInFlight){page='debug';render()}});
$('#lock-readonly').addEventListener('click',()=>{$('#lock-modal').classList.add('hidden');readOnly=true;render();updateTopStatus();$('#lock-banner').textContent='Read-only mode: another user currently owns the editing lock.';$('#lock-banner').classList.remove('hidden')});
$('#lock-takeover').addEventListener('click',async()=>{if(!confirm('Take over editing? The other user will be unable to save without taking the lock back.'))return;await acquireLock(true);$('#lock-modal').classList.add('hidden');$('#lock-banner').classList.add('hidden');render();updateTopStatus()});

$('#nav').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(!b)return;page=b.dataset.page;editingBeerId=null;inventoryFocusVariety='';render()});

function render(){
  document.querySelectorAll('#nav [data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  const [title,sub]=pageMeta[page]||pageMeta.dashboard;$('#page-title').textContent=title;$('#page-subtitle').textContent=sub;
  const content=$('#page-content');
  if(page==='dashboard')content.innerHTML=renderDashboard();
  if(page==='beers')content.innerHTML=editingBeerId?renderBeerEditor():renderBeers();
  if(page==='production')content.innerHTML=renderProduction();
  if(page==='orders')content.innerHTML=renderOrders();
  if(page==='inventory'){content.innerHTML=renderInventory();requestAnimationFrame(applyInventoryFilters)}
  if(page==='settings')content.innerHTML=renderSettings();
  if(page==='data')content.innerHTML=renderData();
  if(page==='debug')content.innerHTML=renderDebug();
  if(readOnly) content.querySelectorAll('input,select,textarea').forEach(x=>x.disabled=true);
  requestAnimationFrame(()=>{enhanceUniversalTables();autoFitVisibleManagedTables()});
  updateTopStatus();
}

function forecastTypeLabel(t){return ({core:'Core',seasonal:'Seasonal',monthly:'Monthly / fixed',oneoff:'One-off'})[t]||'Core'}
function forecastBasis(b){
  const c=beerForecastComponents(b),parts=[];
  if(num(b.last12Hl)>0)parts.push(`${fmt(c.historical)} hL history`);
  if(c.brews>0)parts.push(`${c.brews} brew${c.brews===1?'':'s'} = ${fmt(c.brewHl)} hL`);
  if(c.monthly>0)parts.push(`${fmt(c.monthly)} hL/month = ${fmt(c.monthly12)} hL`);
  if(c.oneOff>0)parts.push(`${fmt(c.oneOff)} hL one-off`);
  return parts.length?parts.join(' + '):'0 hL';
}
function contractDecision(r){
  if(r.currentShortfall>0)return {label:'Current shortfall',cls:'bad'};
  if(r.manualContractKg!==null && r.recommended<r.calculated)return {label:`${fmt(r.calculated-r.recommended)} kg below calc`,cls:'bad'};
  if(r.calculated>0 && r.calculated<=10)return {label:'Small requirement · review spot/minimum',cls:'warn'};
  if(r.calculated>0 && r.beerCount<=1)return {label:'Single-beer hop',cls:'warn'};
  if(r.recommended>0)return {label:'Contract',cls:'warn'};
  return {label:'Covered',cls:'good'};
}
function beerOptions(selected=''){return `<option value="">Select beer…</option>`+state.beers.filter(b=>b.active!==false).map(b=>`<option value="${b.id}" ${b.id===selected?'selected':''}>${esc(b.name)}</option>`).join('')}
function packageOptions(selected){return PACKAGES.map(p=>`<option value="${p.key}" ${p.key===selected?'selected':''}>${esc(p.label)}</option>`).join('')}
function inventoryRecipeOptions(selectedId='',fallbackName=''){
  const items=[...state.inventory].filter(i=>String(i.variety||'').trim()).sort((a,b)=>String(a.variety).localeCompare(String(b.variety),undefined,{numeric:true,sensitivity:'base'}));
  const linked=items.some(i=>i.id===selectedId);
  let out='<option value="">Select inventory item…</option>';
  if(!linked && fallbackName) out+=`<option value="" selected>Unlinked: ${esc(fallbackName)}</option>`;
  out+=items.map(i=>{const p=splitHopProduct(i.variety);const label=[p.variety,p.format].filter(Boolean).join(' — ');return `<option value="${i.id}" ${i.id===selectedId?'selected':''}>${esc(label)} · stock ${fmt(i.stockKg,2)} kg</option>`}).join('');
  return out;
}
function hopInventoryItem(hop){return state.inventory.find(i=>i.id===hop?.inventoryId)||state.inventory.find(i=>String(i.variety||'').trim().toLowerCase()===String(hop?.variety||'').trim().toLowerCase())||null}
function orderHlForBeer(beerId,next=false){return state.orders.filter(o=>o.beerId===beerId&&o.status!=='cancelled').reduce((s,o)=>s+unitsToHl(next?o.likelyRepeatUnits:Math.max(0,num(o.confirmedUnits)-num(o.fulfilledUnits)),o.packageKey,o.unitSizeL),0)}

function recipeHopButtons(beer){
  const hops=(beer?.hops||[]).filter(h=>String(h.variety||'').trim()||h.inventoryId);
  if(!hops.length)return '<span class="muted">No hops</span>';
  return `<div class="recipe-summary">${hops.map(h=>{
    const item=hopInventoryItem(h);const name=item?.variety||h.variety||'Unlinked hop';const product=splitHopProduct(name);
    return `<button type="button" class="hop-link" data-action="go-hop" data-hop-id="${esc(item?.id||'')}" data-hop="${esc(name)}" title="Open ${esc(name)} in Hop inventory"><span class="hop-variety">${esc(product.variety)}</span>${product.format?`<span class="hop-format">${esc(product.format)}</span>`:''}<span class="hop-qty">${fmt(h.kgPerBrew,2)} kg</span></button>`;
  }).join('')}</div>`;
}

function inventorySortHeader(label,key){
  const active=inventorySortKey===key;
  const arrow=active?(inventorySortDir==='asc'?' ↑':' ↓'):'';
  return `<button type="button" class="sort-head ${active?'active':''}" data-action="inventory-sort" data-sort="${key}">${esc(label)}${arrow}</button>`;
}

function inventorySortValue(item,row,key){
  const p=splitHopProduct(item.variety);
  if(key==='name') return `${p.variety.toLowerCase()}\u0000${p.format.toLowerCase()}`;
  if(key==='format') return `${p.format.toLowerCase()}\u0000${p.variety.toLowerCase()}`;
  if(key==='stockKg') return num(item.stockKg);
  if(key==='contractTotalKg') return num(item.contractTotalKg);
  if(key==='contractKg') return num(item.contractKg);
  if(key==='expectedUseKg') return num(item.expectedUseKg);
  if(key==='historicalEquivalent') return num(row?.historicalEquivalent);
  if(key==='supplierReceived12Kg') return num(item.supplierReceived12Kg);
  if(key==='carryover') return num(row?.carryover);
  if(key==='nextGross') return num(row?.nextGross);
  if(key==='calculated') return num(row?.calculated);
  if(key==='recommended') return num(row?.recommended);
  if(key==='priceKg') return num(item.priceKg);
  if(key==='hemisphere') return normaliseHemisphere(item.hemisphere,item.variety);
  if(key==='contractEnabled') return item.contractEnabled===false?0:1;
  if(key==='forecastContract') return dashboardRecommendedContract(row||{});
  return '';
}

function sortedInventory(rowsByVariety){
  const dir=inventorySortDir==='desc'?-1:1;
  return [...state.inventory].sort((a,b)=>{
    const av=inventorySortValue(a,rowsByVariety.get(a.id)||rowsByVariety.get(a.variety),inventorySortKey);
    const bv=inventorySortValue(b,rowsByVariety.get(b.id)||rowsByVariety.get(b.variety),inventorySortKey);
    if(typeof av==='number' && typeof bv==='number') return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}

function inventoryTableWidth(){return widthTotal(inventoryColWidths,INVENTORY_COLUMN_DEFAULTS)}
function saveInventoryWidths(){localStorage.setItem(INVENTORY_WIDTHS_KEY,JSON.stringify(inventoryColWidths))}
function inventoryColgroup(){return colgroupFor(inventoryColWidths,INVENTORY_COLUMN_DEFAULTS)}
function resizableHead(content,key){return managedHead(content,key,'inventory')}

function widthTotal(widths,defaults){return Object.keys(defaults).reduce((sum,key)=>sum+Math.max(70,num(widths[key])),0)}
function colgroupFor(widths,defaults){return `<colgroup>${Object.keys(defaults).map(key=>`<col data-col-key="${key}" style="width:${Math.max(70,num(widths[key]))}px">`).join('')}</colgroup>`}
function managedHead(content,key,tableKey){return `<th class="resizable-th" data-table-column-key="${esc(key)}">${content}<span class="col-resizer" data-resize-table="${tableKey}" data-resize-col="${key}" title="Drag to resize"></span></th>`}
function tableSortHeader(label,key,tableKey,activeKey,dir){const arrow=activeKey===key?(dir==='asc'?' ↑':' ↓'):'';return `<button type="button" class="sort-head ${activeKey===key?'active':''}" data-action="managed-sort" data-table="${tableKey}" data-sort="${key}">${esc(label)}${arrow}</button>`}
function dashboardSortHeader(label,key,table='hop'){
  const active=table==='hop'?dashboardHopSortKey===key:dashboardBeerSortKey===key;
  const dir=table==='hop'?dashboardHopSortDir:dashboardBeerSortDir;
  const arrow=active?(dir==='asc'?' ↑':' ↓'):'';
  return `<button type="button" class="sort-head ${active?'active':''}" data-action="dashboard-sort" data-table="${table}" data-sort="${key}">${esc(label)}${arrow}</button>`;
}
function fitManagedTableColumns(tableKey){
  const cfg=resizeConfig(tableKey),table=document.getElementById(cfg.tableId);
  if(!table)return false;
  const wrap=table.closest('.table-wrap');
  const available=Math.max(320,Math.floor((wrap?.clientWidth||table.parentElement?.clientWidth||0)-2));
  if(!available)return false;
  const baseTotal=Object.values(cfg.defaults).reduce((a,b)=>a+Math.max(70,num(b)),0);
  const scale=available/baseTotal;
  for(const [key,base] of Object.entries(cfg.defaults)) cfg.widths[key]=Math.max(70,Math.round(num(base)*scale));
  const total=widthTotal(cfg.widths,cfg.defaults);
  const cols=table.querySelectorAll('col[data-col-key]');
  cols.forEach(col=>{const key=col.dataset.colKey;if(key in cfg.widths)col.style.width=`${cfg.widths[key]}px`});
  table.style.width=`${Math.max(total,available)}px`;table.style.minWidth=`${Math.max(total,available)}px`;
  localStorage.setItem(cfg.storageKey,JSON.stringify(cfg.widths));
  autoFitPending.delete(tableKey);
  return true;
}
function autoFitVisibleManagedTables(){for(const key of [...autoFitPending])fitManagedTableColumns(key)}
function dashboardRecommendedContract(r){
  if(r?.contractEnabled===false)return 0;
  const projectedUse=Math.max(0,num(r.baseDemand));
  const bridge=januaryBridge(r);
  const openingAvailability=bridge.stockAtStart+bridge.contractAtStart;
  return roundUp(Math.max(0,projectedUse-openingAvailability),5);
}
function sortedDashboardHops(rows){
  const dir=dashboardHopSortDir==='desc'?-1:1;
  return [...rows].sort((a,b)=>{
    const value=(r,key)=>{
      if(key==='hop')return String(r.variety||'').toLowerCase();
      if(key==='stock')return num(r.stockKg);
      if(key==='contractLeft')return num(r.contractKg);
      if(key==='previousUse')return num(r.supplierReceived12Kg);
      if(key==='projectedUse')return num(r.baseDemand);
      if(key==='previousContract')return num(r.contractTotalKg);
      if(key==='recommended')return dashboardRecommendedContract(r);
      return '';
    };
    const av=value(a,dashboardHopSortKey),bv=value(b,dashboardHopSortKey);
    if(typeof av==='number'&&typeof bv==='number')return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}

function dashboardBeerRows(){
  return state.beers.map(b=>{
    const base=beerBaseForecastHl(b);
    return {beer:b,type:forecastTypeLabel(b.forecastType),basis:forecastBasis(b),base,repeat:0,total:base};
  });
}
function sortedDashboardBeers(rows){
  const dir=dashboardBeerSortDir==='desc'?-1:1;
  return [...rows].sort((a,b)=>{
    const value=(r,key)=>key==='beer'?String(r.beer.name||'').toLowerCase():key==='type'?r.type:key==='basis'?r.basis:num(r[key]);
    const av=value(a,dashboardBeerSortKey),bv=value(b,dashboardBeerSortKey);
    if(typeof av==='number'&&typeof bv==='number')return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}
function applyInventoryFilters(){
  const q=inventorySearch.trim().toLowerCase();
  document.querySelectorAll('#inventory-table tbody tr[data-inv-id]').forEach(row=>{
    const matchText=!q || (row.dataset.searchText||'').includes(q);
    const matchFormat=!inventoryFormatFilter || (row.dataset.format||'')===inventoryFormatFilter.toLowerCase();
    row.hidden=!(matchText&&matchFormat);
  });
}

function jumpToInventoryHop(variety,inventoryId=''){
  const item=(inventoryId&&state.inventory.find(i=>i.id===inventoryId))||state.inventory.find(i=>i.variety===String(variety||'').trim());
  inventoryFocusVariety=item?.variety||String(variety||'').trim();
  page='inventory';editingBeerId=null;render();
  requestAnimationFrame(()=>{
    const row=inventoryId?document.querySelector(`[data-inv-id="${CSS.escape(inventoryId)}"]`):[...document.querySelectorAll('[data-inv-variety]')].find(x=>x.dataset.invVariety===inventoryFocusVariety);
    if(row){row.scrollIntoView({behavior:'smooth',block:'center'});row.classList.add('inventory-target');setTimeout(()=>row.classList.remove('inventory-target'),2600);const input=row.querySelector('[data-inv-field="stockKg"]');if(input)input.focus({preventScroll:true});}
  });
}

function renderHistoricalDashboard(){
  const d=selectedContractDetail,y=selectedContractYear();
  if(!d)return `${contractYearBar()}<div class="empty">Loading finalised contract…</div>`;
  const allHistoricHops=d.hops||[];
  const hopRows=historicalHopSort(allHistoricHops.filter(h=>dashboardHemisphereFilter==='All'||normaliseHemisphere(h.hemisphere,h.hopName)===dashboardHemisphereFilter)),beerRows=historicalBeerSort(d.beers||[]);
  const totalBeer=(d.beers||[]).reduce((x,b)=>x+num(b.forecastHl),0);
  const projected=(d.hops||[]).reduce((x,h)=>x+num(h.projectedUseKg),0);
  const finalKg=(d.hops||[]).reduce((x,h)=>x+num(h.finalContractKg),0);
  const finalValue=(d.hops||[]).reduce((x,h)=>x+num(h.finalContractKg)*num(h.priceKg),0);
  const hopTableWidth=widthTotal(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS);
  const beerTableWidth=widthTotal(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS);
  return `${contractYearBar()}<div class="notice"><strong>Historic ${esc(y.year)} contract.</strong> These figures and recipes were frozen when the year was finalised. Editing today's recipes or inventory will not alter this record.</div>
  <div class="grid metrics"><div class="card"><div class="metric-label">${esc(y.year)} beer forecast</div><div class="metric-value">${fmt(totalBeer)} hL</div></div><div class="card"><div class="metric-label">Projected hop use · 12m</div><div class="metric-value">${fmt(projected)} kg</div></div><div class="card"><div class="metric-label">Final contract</div><div class="metric-value">${fmt(finalKg)} kg</div></div><div class="card"><div class="metric-label">Recorded contract value</div><div class="metric-value">${money(finalValue)}</div></div></div>
  <div class="section-head"><div><h2>${esc(dashboardHemisphereFilter)} finalised hop contract</h2><p>Previous Contract came from the prior year; Final Contract is the amount carried into the following year. Hemisphere and Contract On/Off are frozen with the historic record.</p></div><div class="actions"><div class="scenario-buttons"><button class="btn small ${dashboardHemisphereFilter==='Northern'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="Northern">Northern</button><button class="btn small ${dashboardHemisphereFilter==='Southern'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="Southern">Southern</button><button class="btn small ${dashboardHemisphereFilter==='All'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="All">All</button></div><button class="btn" data-action="dashboard-reset-columns">Reset column widths</button></div></div>
  ${hopRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-hop-table" class="managed-table dashboard-table" style="width:${hopTableWidth}px;min-width:${hopTableWidth}px">${colgroupFor(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Hop','hop','hop'),'hop','dashboard-hop')}${managedHead(dashboardSortHeader('In Stock','stock','hop'),'stock','dashboard-hop')}${managedHead(dashboardSortHeader('On Contract','contractLeft','hop'),'contractLeft','dashboard-hop')}${managedHead(dashboardSortHeader('Previous Use (12m)','previousUse','hop'),'previousUse','dashboard-hop')}${managedHead(dashboardSortHeader('Projected Use (12m)','projectedUse','hop'),'projectedUse','dashboard-hop')}${managedHead(dashboardSortHeader('Previous Contract','previousContract','hop'),'previousContract','dashboard-hop')}${managedHead(dashboardSortHeader('Final Contract','recommended','hop'),'recommended','dashboard-hop')}</tr></thead><tbody>${hopRows.map(h=>`<tr><td><strong>${esc(h.hopName)}</strong></td><td>${fmt(h.inStockKg)}<div class="help">Jan: ${fmt(h.stockAtStartKg||0)}</div></td><td>${fmt(h.onContractKg)}<div class="help">Jan: ${fmt(h.contractRemainingAtStartKg||0)}</div>${num(h.preStartShortfallKg)>0?`<div class="help danger-text">Short ${fmt(h.preStartShortfallKg)} before Jan</div>`:''}</td><td>${fmt(h.previousUse12mKg||0)}</td><td><strong>${fmt(h.projectedUseKg)}</strong><div class="help">${fmt(h.useBeforeStartKg||0)} used before Jan</div></td><td>${fmt(h.previousContractKg)}</td><td><strong>${fmt(h.finalContractKg)}</strong><div class="help">${h.contractEnabled===false?'Not contracted':`Recommended ${fmt(h.recommendedContractKg)} kg`}</div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No frozen hop rows.</div>`}
  <div class="section-head"><div><h2>Beer assumptions & recipe versions</h2><p>Each beer points to the immutable recipe snapshot used for this contract year.</p></div><button class="btn" data-action="fit-table-columns" data-table="dashboard-beer">Reset column widths</button></div>
  ${beerRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-beer-table" class="managed-table dashboard-table" style="width:${beerTableWidth}px;min-width:${beerTableWidth}px">${colgroupFor(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Beer','beer','beer'),'beer','dashboard-beer')}${managedHead(dashboardSortHeader('Type','type','beer'),'type','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast basis','basis','beer'),'basis','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast hL','base','beer'),'base','dashboard-beer')}${managedHead(dashboardSortHeader('Recipe version','repeat','beer'),'repeat','dashboard-beer')}${managedHead(dashboardSortHeader('Recipe used','total','beer'),'total','dashboard-beer')}</tr></thead><tbody>${beerRows.map(b=>`<tr><td><strong>${esc(b.name)}</strong></td><td>${esc(forecastTypeLabel(b.forecastType))}</td><td>${fmt(b.baselineLast12Hl)} hL ${num(b.growthPct)>=0?'+':''}${fmt(b.growthPct)}%${num(b.scenarioAdjustmentPct)?` · scenario ${num(b.scenarioAdjustmentPct)>=0?'+':''}${fmt(b.scenarioAdjustmentPct)}%`:''}</td><td><strong>${fmt(b.forecastHl)}</strong></td><td>${esc(b.recipeVersionLabel||'Snapshot')}</td><td>${(b.recipeHops||[]).map(h=>`${esc(h.hopName)} <strong>${fmt(h.kgPerBrew,2)} kg</strong>`).join(' · ')||'<span class="muted">No hops</span>'}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}

function renderDashboard(){
  const y=selectedContractYear();
  if(y?.status==='finalised')return renderHistoricalDashboard();
  const rows=calculateForecast(state),t=totals(rows);
  const filteredRows=rows.filter(r=>dashboardHemisphereFilter==='All'||normaliseHemisphere(r.hemisphere,r.variety)===dashboardHemisphereFilter);
  const totalBeer=state.beers.filter(b=>b.active!==false).reduce((sum,b)=>sum+beerBaseForecastHl(b),0);
  const dashboardRecommendedTotal=rows.reduce((sum,r)=>sum+dashboardRecommendedContract(r),0);
  const dashboardCost=rows.reduce((sum,r)=>sum+dashboardRecommendedContract(r)*Math.max(0,num(r.priceKg)),0);
  const bridgeShortfallTotal=rows.reduce((sum,r)=>sum+januaryBridge(r,y?.year||state.settings.forecastYear).shortfallBeforeStart,0);
  const topHops=[...rows].map(r=>({...r,dashboardRecommended:dashboardRecommendedContract(r)})).sort((a,b)=>b.dashboardRecommended-a.dashboardRecommended).filter(r=>r.dashboardRecommended>0).slice(0,5);
  const topBeers=state.beers.filter(b=>b.active!==false).map(b=>({name:b.name,hl:beerBaseForecastHl(b)})).sort((a,b)=>b.hl-a.hl).slice(0,5);
  const hopRows=sortedDashboardHops(filteredRows);
  const beerRows=sortedDashboardBeers(dashboardBeerRows());
  const hopTableWidth=widthTotal(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS);
  const beerTableWidth=widthTotal(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS);

  return `${contractYearBar()}<div class="scenario-bar card"><div><div class="metric-label">Forecast scenario</div><strong>${esc(scenarioLabel())}</strong><div class="help">Projected Use (12m) starts from trailing-12-month beer volume, applies each beer's agreed increase/decrease, then applies the current recipe.</div></div><div class="scenario-buttons">
    <button class="btn small ${state.settings.scenarioKey==='base'?'primary':''}" data-action="set-scenario" data-scenario="base">Base</button>
    <button class="btn small ${state.settings.scenarioKey==='conservative'?'primary':''}" data-action="set-scenario" data-scenario="conservative">Conservative ${num(state.settings.scenarioConservativePct)>=0?'+':''}${fmt(state.settings.scenarioConservativePct)}%</button>
    <button class="btn small ${state.settings.scenarioKey==='growth'?'primary':''}" data-action="set-scenario" data-scenario="growth">Growth +${fmt(state.settings.scenarioGrowthPct)}%</button>
    <button class="btn small ${state.settings.scenarioKey==='custom'?'primary':''}" data-action="set-scenario" data-scenario="custom">Custom ${num(state.settings.scenarioCustomPct)>=0?'+':''}${fmt(state.settings.scenarioCustomPct)}%</button>
  </div></div>
  <div class="grid metrics">
    <div class="card"><div class="metric-label">${esc(y?.year||state.settings.forecastYear)} beer forecast</div><div class="metric-value">${fmt(totalBeer)} hL</div></div>
    <div class="card"><div class="metric-label">Projected hop use · 12m</div><div class="metric-value">${fmt(t.baseDemand)} kg</div></div>
    <div class="card"><div class="metric-label">Recommended contract</div><div class="metric-value ${dashboardRecommendedTotal?'warn-text':'good'}">${fmt(dashboardRecommendedTotal)} kg</div></div>
    <div class="card"><div class="metric-label">Estimated contract value</div><div class="metric-value">${money(dashboardCost)}</div></div>
  </div>
  ${bridgeShortfallTotal>0?`<div class="notice warn"><strong>Pre-January cover warning:</strong> current stock + contract remaining are forecast to be short by ${fmt(bridgeShortfallTotal)} kg in total before 1 January. Those quantities need a current-contract top-up / spot purchase because the new annual contract does not start until January.</div>`:''}
  <div class="section-head"><div><h2>${esc(dashboardHemisphereFilter)} hop contract recommendation</h2><p><strong>New contract starts 1 January ${esc(y?.year||state.settings.forecastYear)}.</strong> Northern and Southern hemisphere products can be planned separately. Products with Contract switched Off still show projected use but receive a 0 kg contract recommendation.</p></div><div class="actions"><div class="scenario-buttons"><button class="btn small ${dashboardHemisphereFilter==='Northern'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="Northern">Northern</button><button class="btn small ${dashboardHemisphereFilter==='Southern'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="Southern">Southern</button><button class="btn small ${dashboardHemisphereFilter==='All'?'primary':''}" data-action="set-hemisphere-filter" data-hemisphere="All">All</button></div><button class="btn" data-action="dashboard-reset-columns">Reset column widths</button></div></div>
  ${rows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-hop-table" class="managed-table dashboard-table" style="width:${hopTableWidth}px;min-width:${hopTableWidth}px">${colgroupFor(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS)}<thead><tr>
    ${managedHead(dashboardSortHeader('Hop','hop','hop'),'hop','dashboard-hop')}
    ${managedHead(dashboardSortHeader('In Stock','stock','hop'),'stock','dashboard-hop')}
    ${managedHead(dashboardSortHeader('On Contract','contractLeft','hop'),'contractLeft','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Previous Use (12m)','previousUse','hop'),'previousUse','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Projected Use (12m)','projectedUse','hop'),'projectedUse','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Previous Contract','previousContract','hop'),'previousContract','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Recommended Contract','recommended','hop'),'recommended','dashboard-hop')}
  </tr></thead><tbody>${hopRows.map(r=>{const recommended=dashboardRecommendedContract(r),bridge=januaryBridge(r,y?.year||state.settings.forecastYear);return `<tr><td><strong>${esc(r.variety)}</strong></td><td>${fmt(r.stockKg)}<div class="help">Est. Jan ${fmt(bridge.stockAtStart)} kg</div></td><td>${fmt(r.contractKg)}<div class="help">Est. Jan ${fmt(bridge.contractAtStart)} kg</div>${bridge.shortfallBeforeStart>0?`<div class="help danger-text">Need ${fmt(bridge.shortfallBeforeStart)} kg before Jan</div>`:''}</td><td>${fmt(r.supplierReceived12Kg)}</td><td><strong>${fmt(r.baseDemand)}</strong><div class="help">${fmt(bridge.useBeforeStart)} kg est. use to Jan</div></td><td>${fmt(r.contractTotalKg)}</td><td><strong>${fmt(recommended)}</strong>${r.contractEnabled===false?`<div class="help">Not contracted</div>`:''}</td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">No hops in this hemisphere/filter.</div>`}
  <div class="grid two insight-grid" style="margin-top:16px"><div class="card"><h3 style="margin-top:0">Largest contract requirements</h3>${topHops.length?topHops.map((r,i)=>`<div class="rank-row"><span>${i+1}. ${esc(r.variety)}</span><strong>${fmt(r.dashboardRecommended)} kg</strong></div>`).join(''):`<div class="help">No new contract quantity required.</div>`}</div><div class="card"><h3 style="margin-top:0">Largest beer forecasts</h3>${topBeers.length?topBeers.map((b,i)=>`<div class="rank-row"><span>${i+1}. ${esc(b.name)}</span><strong>${fmt(b.hl)} hL</strong></div>`).join(''):`<div class="help">No active beer forecasts.</div>`}</div></div>
  <div class="section-head"><div><h2>Beer forecast detail</h2><p>Historical hL is a volume baseline only; the current recipe is applied to the forward forecast.</p></div><button class="btn" data-action="fit-table-columns" data-table="dashboard-beer">Reset column widths</button></div>${beerRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-beer-table" class="managed-table dashboard-table" style="width:${beerTableWidth}px;min-width:${beerTableWidth}px">${colgroupFor(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Beer','beer','beer'),'beer','dashboard-beer')}${managedHead(dashboardSortHeader('Type','type','beer'),'type','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast basis','basis','beer'),'basis','dashboard-beer')}${managedHead(dashboardSortHeader('Projected hL','base','beer'),'base','dashboard-beer')}${managedHead(dashboardSortHeader('Total hL','total','beer'),'total','dashboard-beer')}</tr></thead><tbody>${beerRows.map(r=>`<tr><td><strong>${esc(r.beer.name)}</strong></td><td>${esc(r.type)}</td><td>${esc(r.basis)}</td><td><strong>${fmt(r.base)}</strong></td><td>${fmt(r.total)}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}

function beerRegisterRows(){
  const rows=state.beers.map(b=>({beer:b,type:forecastTypeLabel(b.forecastType),batch:num(b.batchHl),basis:forecastBasis(b),forecast:beerBaseForecastHl(b),recipeKg:(b.hops||[]).reduce((x,h)=>x+num(h.kgPerBrew),0),status:b.active!==false?1:0}));
  const dir=beerRegisterSortDir==='desc'?-1:1;
  return rows.sort((a,b)=>{const value=(r,key)=>key==='beer'?String(r.beer.name||'').toLowerCase():key==='type'?r.type:key==='basis'?r.basis:key==='batch'?r.batch:key==='forecast'?r.forecast:key==='recipe'?r.recipeKg:key==='status'?r.status:'';const av=value(a,beerRegisterSortKey),bv=value(b,beerRegisterSortKey);if(typeof av==='number'&&typeof bv==='number')return(av-bv)*dir;return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;});
}
function renderBeers(){
  const rows=beerRegisterRows(),tableWidth=widthTotal(beerRegisterColWidths,BEER_REGISTER_COLUMN_DEFAULTS);
  return `<div class="section-head"><div><h2>Beer register</h2><p>Recipes are forward-looking only: the current recipe is applied to forecast beer volume. Historical hL never assumes an old recipe. Click any hop to open it in inventory.</p></div><div class="actions"><button class="btn" data-action="fit-table-columns" data-table="beer-register">Reset column widths</button><button class="btn primary" data-action="add-beer">Add beer</button></div></div>
  ${rows.length?`<div class="table-wrap sticky-table-wrap"><table id="beer-register-table" class="managed-table beer-register-table" style="width:${tableWidth}px;min-width:${tableWidth}px">${colgroupFor(beerRegisterColWidths,BEER_REGISTER_COLUMN_DEFAULTS)}<thead><tr>
    ${managedHead(tableSortHeader('Beer','beer','beer-register',beerRegisterSortKey,beerRegisterSortDir),'beer','beer-register')}
    ${managedHead(tableSortHeader('Type','type','beer-register',beerRegisterSortKey,beerRegisterSortDir),'type','beer-register')}
    ${managedHead(tableSortHeader('Standard brew','batch','beer-register',beerRegisterSortKey,beerRegisterSortDir),'batch','beer-register')}
    ${managedHead(tableSortHeader('Forecast basis','basis','beer-register',beerRegisterSortKey,beerRegisterSortDir),'basis','beer-register')}
    ${managedHead(tableSortHeader(`${esc(state.settings.forecastYear)} forecast`,'forecast','beer-register',beerRegisterSortKey,beerRegisterSortDir),'forecast','beer-register')}
    ${managedHead(tableSortHeader('Hop recipe','recipe','beer-register',beerRegisterSortKey,beerRegisterSortDir),'recipe','beer-register')}
    ${managedHead(tableSortHeader('Status','status','beer-register',beerRegisterSortKey,beerRegisterSortDir),'status','beer-register')}
    ${managedHead('','actions','beer-register')}
  </tr></thead><tbody>${rows.map(r=>{const b=r.beer;return `<tr><td><strong>${esc(b.name)}</strong></td><td>${esc(r.type)}</td><td>${fmt(b.batchHl)} hL</td><td>${esc(r.basis)}</td><td><strong>${fmt(r.forecast)} hL</strong></td><td>${recipeHopButtons(b)}</td><td><span class="pill ${b.active?'good':'warn'}">${b.active?'Active':'Inactive'}</span></td><td><button class="btn small" data-action="edit-beer" data-id="${b.id}">View / edit</button></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">No beers yet. Add the first beer and recipe.</div>`}`;
}
function renderBeerEditor(){
  const b=state.beers.find(x=>x.id===editingBeerId);if(!b){editingBeerId=null;return renderBeers()}
  const total=(b.hops||[]).reduce((s,h)=>s+num(h.kgPerBrew),0);
  return `<div class="editor"><div class="section-head"><div><button class="btn small" data-action="back-beers">← Back</button><h2 style="margin-top:12px">${esc(b.name)}</h2><p>${fmt(total,2)} kg hops / ${fmt(b.batchHl)} hL = ${fmt(total/Math.max(.001,num(b.batchHl)),3)} kg/hL</p></div></div>
  <div class="card"><div class="form-grid"><div class="field"><label>Beer name</label><input data-beer-field="name" value="${esc(b.name)}"></div><div class="field"><label>Standard brew hL</label><input type="number" min="0.01" step="0.1" data-beer-field="batchHl" value="${num(b.batchHl)}"></div><div class="field"><label>Active</label><select data-beer-field="active"><option value="true" ${b.active?'selected':''}>Active</option><option value="false" ${!b.active?'selected':''}>Inactive</option></select></div></div><div class="field" style="margin-top:12px"><label>Notes</label><textarea data-beer-field="notes">${esc(b.notes)}</textarea></div></div>
  <div class="section-head"><div><h3>Current hop recipe</h3><p>Forward-looking recipe used for the next draft contract. Choose the exact Inventory item and quantity per standard brew. <strong>Finalised contract years keep an immutable snapshot of the recipe used</strong>, so changing this recipe later never rewrites historic forecasts.</p></div><button class="btn primary small" data-action="add-hop" ${state.inventory.length?'':'disabled'}>Add hop</button></div>
  ${state.inventory.length?'':`<div class="notice warn"><strong>No inventory items yet.</strong> Add the hop variety/format in Hop inventory first, then return here to use it in a recipe.</div>`}
  <div class="card">${b.hops.length?b.hops.map(h=>{const item=hopInventoryItem(h);const name=item?.variety||h.variety||'';const product=splitHopProduct(name);return `<div class="hop-row hop-row-v11 ${item?'':'unlinked-hop-row'}" data-hop-id="${h.id}"><div class="field"><label>Inventory item</label><select data-hop-inventory="true">${inventoryRecipeOptions(item?.id||h.inventoryId,name)}</select><div class="help">${item?`${esc(product.variety)}${product.format?` · ${esc(product.format)}`:''}`:`Unlinked recipe item — choose an inventory item`}</div></div><div class="field"><label>kg per brew</label><input type="number" min="0" step="0.01" data-hop-field="kgPerBrew" value="${num(h.kgPerBrew)}"></div><button class="btn danger small" data-action="delete-hop" data-id="${h.id}">Remove</button></div>`}).join(''):`<div class="empty">${state.inventory.length?'No hops in this recipe yet. Click Add hop and choose one from Inventory.':'Add inventory items before building this recipe.'}</div>`}</div>
  <div class="section-head"><div><h3>Beer record</h3></div><button class="btn danger" data-action="delete-beer" data-id="${b.id}">Delete beer</button></div></div>`;
}

function productionRows(){
  const rows=state.beers.map(b=>({beer:b,...beerForecastComponents(b)}));
  const dir=productionSortDir==='desc'?-1:1;
  return rows.sort((a,b)=>{
    const value=(r,key)=>key==='beer'?String(r.beer.name||'').toLowerCase()
      :key==='include'?(r.beer.active!==false?1:0)
      :key==='batch'?num(r.beer.batchHl)
      :key==='last12'?num(r.beer.last12Hl)
      :key==='growth'?num(r.beer.growthPct)
      :key==='brews'?num(r.brews)
      :key==='brewHl'?num(r.brewHl)
      :key==='monthly'?num(r.monthly)
      :key==='monthly12'?num(r.monthly12)
      :key==='oneoff'?num(r.oneOff)
      :key==='total'?num(r.total):'';
    const av=value(a,productionSortKey),bv=value(b,productionSortKey);
    if(typeof av==='number'&&typeof bv==='number')return(av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}
function renderProduction(){
  const rows=productionRows(),tableWidth=widthTotal(productionColWidths,PRODUCTION_COLUMN_DEFAULTS);
  return `<div class="notice"><strong>Additive forecast:</strong> Projected hL = trailing-12-month baseline after % change + <strong>forecast brews × standard brew hL</strong> + <strong>monthly hL × 12</strong> + <strong>one-off hL</strong>. All four can contribute at the same time. Likely repeat orders are not included. Current scenario: <strong>${esc(scenarioLabel())}</strong>.</div>
  <div class="section-head"><div><h2>Beer volume forecast</h2><p>Use Forecast brews for recipes you know you will brew even if they have no historical production yet. Monthly and one-off volumes are additional forward hL.</p></div><button class="btn" data-action="fit-table-columns" data-table="production">Reset column widths</button></div>
  ${rows.length?`<div class="table-wrap sticky-table-wrap"><table id="production-table" class="managed-table production-table" style="width:${tableWidth}px;min-width:${tableWidth}px">${colgroupFor(productionColWidths,PRODUCTION_COLUMN_DEFAULTS)}<thead><tr>
    ${managedHead(tableSortHeader('Beer','beer','production',productionSortKey,productionSortDir),'beer','production')}
    ${managedHead(tableSortHeader('Included','include','production',productionSortKey,productionSortDir),'include','production')}
    ${managedHead(tableSortHeader('Standard brew hL','batch','production',productionSortKey,productionSortDir),'batch','production')}
    ${managedHead(tableSortHeader('Last 12m hL','last12','production',productionSortKey,productionSortDir),'last12','production')}
    ${managedHead(tableSortHeader('Change %','growth','production',productionSortKey,productionSortDir),'growth','production')}
    ${managedHead(tableSortHeader('Forecast brews','brews','production',productionSortKey,productionSortDir),'brews','production')}
    ${managedHead(tableSortHeader('Brew forecast hL','brewHl','production',productionSortKey,productionSortDir),'brewHl','production')}
    ${managedHead(tableSortHeader('Additional hL / month','monthly','production',productionSortKey,productionSortDir),'monthly','production')}
    ${managedHead(tableSortHeader('Monthly × 12 hL','monthly12','production',productionSortKey,productionSortDir),'monthly12','production')}
    ${managedHead(tableSortHeader('Additional one-off hL','oneoff','production',productionSortKey,productionSortDir),'oneoff','production')}
    ${managedHead(tableSortHeader(`Projected ${esc(state.settings.forecastYear)} hL`,'total','production',productionSortKey,productionSortDir),'total','production')}
  </tr></thead><tbody>${rows.map(r=>{const b=r.beer;return `<tr data-beer-id="${b.id}"><td><strong>${esc(b.name)}</strong></td><td><input type="checkbox" data-row-field="active" ${b.active!==false?'checked':''}></td><td><strong>${fmt(b.batchHl)}</strong></td><td><input type="number" min="0" step="0.1" data-row-field="last12Hl" value="${num(b.last12Hl)}"><div class="help">Volume history only</div></td><td><input type="number" min="-100" step="0.5" data-row-field="growthPct" value="${num(b.growthPct)}"></td><td><input type="number" min="0" step="1" data-row-field="forecastBrews" value="${Math.round(num(b.forecastBrews))}"></td><td data-derived="brewHl"><strong>${fmt(r.brewHl)}</strong></td><td><input type="number" min="0" step="0.1" data-row-field="monthlyHl" value="${num(b.monthlyHl)}"></td><td data-derived="monthly12"><strong>${fmt(r.monthly12)}</strong></td><td><input type="number" min="0" step="0.1" data-row-field="oneOffHl" value="${num(b.oneOffHl)}"></td><td data-derived="total"><strong>${fmt(r.total)}</strong><div class="help">Current recipe drives hop demand</div></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add beers before entering production forecasts.</div>`}`;
}
function updateProductionRowDisplay(beer,row){
  if(!beer||!row)return;
  const c=beerForecastComponents(beer);
  const brew=row.querySelector('[data-derived="brewHl"] strong');
  const monthly=row.querySelector('[data-derived="monthly12"] strong');
  const total=row.querySelector('[data-derived="total"] strong');
  if(brew)brew.textContent=fmt(c.brewHl);
  if(monthly)monthly.textContent=fmt(c.monthly12);
  if(total)total.textContent=fmt(c.total);
}
function renderOrders(){
  const b=state.beers.find(x=>x.id===calc.beerId);const hl=unitsToHl(calc.units,calc.packageKey);const breakdown=b?Object.entries(recipeRates(b)).map(([v,r])=>({v,kg:r*hl})):[];
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">One-off packaging calculator</h2><p class="help">Does not affect the forecast unless you save it as an order.</p><div class="form-grid"><div class="field"><label>Beer</label><select id="calc-beer">${beerOptions(calc.beerId)}</select></div><div class="field"><label>Package</label><select id="calc-package">${packageOptions(calc.packageKey)}</select></div><div class="field"><label>Units</label><input id="calc-units" type="number" min="0" step="1" value="${num(calc.units)}"></div></div><div class="calc-result" style="margin-top:14px"><strong>${fmt(hl)} hL</strong> · ${b?`${fmt(hl/Math.max(.001,num(b.batchHl)),2)} standard brews`:'select a beer'}${breakdown.length?`<div style="margin-top:8px">${breakdown.map(x=>`${esc(x.v)} <strong>${fmt(x.kg,2)} kg</strong>`).join(' · ')}</div>`:''}</div><button class="btn primary" style="margin-top:12px" data-action="calc-save" ${!b?'disabled':''}>Save as customer order</button></div>
  <div class="card"><h2 style="margin-top:0">Forecast treatment</h2><p><strong>Confirmed units remaining</strong> are deducted from stock/current contract now.</p><p><strong>Likely repeat units are no longer used in the 12-month forecast.</strong> Use Forecast brews, additional monthly hL or one-off hL on the 12-month forecast page instead.</p></div></div>
  <div class="section-head"><div><h2>Saved customer orders</h2></div><button class="btn" data-action="add-order" ${state.beers.length?'':'disabled'}>Add blank order</button></div>
  ${state.orders.length?`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Beer</th><th>Package</th><th>Confirmed units</th><th>Fulfilled</th><th>Remaining hL</th><th>Likely repeat units</th><th>Repeat hL (not forecast)</th><th>Status</th><th></th></tr></thead><tbody>${state.orders.map(o=>`<tr data-order-id="${o.id}"><td><input data-order-field="name" value="${esc(o.name)}"></td><td><select data-order-field="beerId">${beerOptions(o.beerId)}</select></td><td><select data-order-field="packageKey">${packageOptions(o.packageKey)}</select></td><td><input type="number" min="0" step="1" data-order-field="confirmedUnits" value="${num(o.confirmedUnits)}"></td><td><input type="number" min="0" step="1" data-order-field="fulfilledUnits" value="${num(o.fulfilledUnits)}"></td><td>${fmt(unitsToHl(Math.max(0,num(o.confirmedUnits)-num(o.fulfilledUnits)),o.packageKey,o.unitSizeL))}</td><td><input type="number" min="0" step="1" data-order-field="likelyRepeatUnits" value="${num(o.likelyRepeatUnits)}"></td><td>${fmt(unitsToHl(o.likelyRepeatUnits,o.packageKey,o.unitSizeL))}</td><td><select data-order-field="status"><option value="confirmed" ${o.status==='confirmed'?'selected':''}>Confirmed</option><option value="provisional" ${o.status==='provisional'?'selected':''}>Provisional</option><option value="completed" ${o.status==='completed'?'selected':''}>Completed</option><option value="cancelled" ${o.status==='cancelled'?'selected':''}>Cancelled</option></select></td><td><button class="btn danger small" data-action="delete-order" data-id="${o.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No saved customer orders.</div>`}`;
}

function renderInventory(){
  const rows=calculateForecast(state),by=new Map();
  for(const r of rows){if(r.inventoryId)by.set(r.inventoryId,r);if(r.variety)by.set(r.variety,r)}
  const items=sortedInventory(by);
  const focusExists=inventoryFocusVariety && state.inventory.some(i=>i.variety===inventoryFocusVariety);
  const formats=[...new Set(state.inventory.map(i=>splitHopProduct(i.variety).format).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const jumpNote=inventoryFocusVariety
    ? focusExists
      ? `<div class="notice inventory-jump-note"><strong>${esc(inventoryFocusVariety)}</strong> opened from a beer recipe.</div>`
      : `<div class="notice warn inventory-jump-note"><strong>${esc(inventoryFocusVariety)}</strong> is used in a beer recipe but does not yet have an inventory line. Add the hop below to track its quantity.</div>`
    : '';
  const duplicateGroups=inventoryDuplicateGroups();
  const duplicateNotice=duplicateGroups.length?`<div class="notice warn"><strong>Duplicate Hop Stock entries detected:</strong> ${duplicateGroups.map(g=>esc(g[0].variety)).join(', ')}. Exact Variety + Format combinations must only appear once. <button class="btn small" data-action="merge-inventory-duplicates">Merge duplicates</button><div class="help">Merge keeps the most-used inventory ID, repoints recipes to it and keeps the highest quantity value from duplicate rows to avoid double-counting.</div></div>`:'';
  return `${jumpNote}${duplicateNotice}<div class="notice"><strong>Previous Use (12m)</strong> is the supplier-delivered quantity from the previous 12 months. The new contract starts <strong>1 January ${esc(selectedContractYear()?.year||state.settings.forecastYear)}</strong>: Forecast Contract first estimates average use to that date, then subtracts the stock and current-contract balance projected to remain on 1 January. It always rounds up to the next 5 kg.</div>
  <div class="section-head"><div><h2>Hop stock & contract</h2><p>One line = one variety + format. Click headings to sort; drag column edges to resize.</p></div><div class="actions"><button class="btn" data-action="fit-table-columns" data-table="inventory">Reset column widths</button><button class="btn primary" data-action="add-inventory">Add hop</button></div></div>
  <div class="inventory-tools card"><div class="field"><label>Search hops</label><input id="inventory-search" value="${esc(inventorySearch)}" placeholder="e.g. Citra, Simcoe, T45"></div><div class="field"><label>Format</label><select id="inventory-format-filter"><option value="">All formats</option>${formats.map(f=>`<option value="${esc(f)}" ${f===inventoryFormatFilter?'selected':''}>${esc(f)}</option>`).join('')}</select></div><div class="help"><strong>Contract?</strong> applies to the exact product. HyperBoost starts Off. Hemisphere controls the separate Northern/Southern planning and supplier exports.</div></div>
  ${hopFormatOptions()}
  ${state.inventory.length?`<div class="table-wrap inventory-wrap sticky-table-wrap"><table id="inventory-table" class="inventory-table managed-table" style="width:${inventoryTableWidth()}px;min-width:${inventoryTableWidth()}px">${inventoryColgroup()}<thead><tr>
    ${resizableHead(inventorySortHeader('Variety','name'),'variety')}
    ${resizableHead(inventorySortHeader('Format','format'),'format')}
    ${resizableHead(inventorySortHeader('Hemisphere','hemisphere'),'hemisphere')}
    ${resizableHead(inventorySortHeader('Contract?','contractEnabled'),'contractEnabled')}
    ${resizableHead(inventorySortHeader('Price per kg','priceKg'),'priceKg')}
    ${resizableHead(inventorySortHeader('Current stock','stockKg'),'stockKg')}
    ${resizableHead(inventorySortHeader('Contract Remaining','contractKg'),'contractKg')}
    ${resizableHead(inventorySortHeader('Previous Use (12m)','supplierReceived12Kg'),'supplierReceived12Kg')}
    ${resizableHead(inventorySortHeader('Previous Contract','contractTotalKg'),'contractTotalKg')}
    ${resizableHead(inventorySortHeader('Forecast Contract','forecastContract'),'forecastContract')}
  </tr></thead><tbody>${items.map(i=>{const r=by.get(i.id)||by.get(i.variety)||{};const focused=i.variety===inventoryFocusVariety;const product=splitHopProduct(i.variety,i.hopFormat,state.settings.hopFormats);const forecastContract=dashboardRecommendedContract(r);const bridge=januaryBridge(r,selectedContractYear()?.year||state.settings.forecastYear);return `<tr data-inv-id="${i.id}" data-inv-variety="${esc(i.variety)}" data-search-text="${esc(`${i.variety} ${product.variety} ${product.format}`.toLowerCase())}" data-format="${esc(product.format.toLowerCase())}" class="${focused?'inventory-target':''}">
    <td><div class="inventory-variety-edit"><input class="hop-name-input" data-inv-product-part="variety" value="${esc(product.variety)}" placeholder="Citra"><button class="mini-delete" type="button" data-action="delete-inventory" data-id="${i.id}" title="Delete inventory line">×</button></div>${recipeUsageForInventory(i.id).length?`<button class="recipe-usage-link" type="button" data-action="recipe-usage" data-id="${i.id}">${recipeUsageForInventory(i.id).length} recipe${recipeUsageForInventory(i.id).length===1?'':'s'}</button>`:`<span class="help">No recipes</span>`}</td>
    <td><select data-inv-product-part="format"><option value="">Select…</option>${allowedHopFormats().map(f=>`<option value="${esc(f)}" ${cleanHopFormat(product.format).toLowerCase()===f.toLowerCase()?'selected':''}>${esc(f)}</option>`).join('')}</select></td>
    <td><select data-inv-field="hemisphere"><option value="Northern" ${normaliseHemisphere(i.hemisphere,i.variety)==='Northern'?'selected':''}>Northern</option><option value="Southern" ${normaliseHemisphere(i.hemisphere,i.variety)==='Southern'?'selected':''}>Southern</option></select></td>
    <td><label class="contract-switch"><input type="checkbox" data-inv-field="contractEnabled" ${i.contractEnabled===false?'':'checked'}><span>${i.contractEnabled===false?'Off':'On'}</span></label></td>
    <td><input type="number" min="0" step="0.01" data-inv-field="priceKg" value="${num(i.priceKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="stockKg" value="${num(i.stockKg)}"><div class="help">Est. Jan ${fmt(bridge.stockAtStart)} kg</div></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="contractKg" value="${num(i.contractKg)}"><div class="help">Est. Jan ${fmt(bridge.contractAtStart)} kg</div>${bridge.shortfallBeforeStart>0?`<div class="help danger-text">Short ${fmt(bridge.shortfallBeforeStart)} kg before Jan</div>`:''}</td>
    <td><input type="number" min="0" step="0.1" data-inv-field="supplierReceived12Kg" value="${num(i.supplierReceived12Kg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="contractTotalKg" value="${num(i.contractTotalKg)}"></td>
    <td><strong>${fmt(forecastContract)} kg</strong><div class="help">${i.contractEnabled===false?'Not included in contract':`${fmt(bridge.useBeforeStart)} kg est. use to Jan · rounded up to 5 kg`}</div></td>
  </tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add current hop stock and contract balances.</div>`}`;
}

function renderSettings(){
  const y=selectedContractYear();
  const formats=allowedHopFormats();
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Forecast period</h2><div class="form-grid"><div class="field"><label>Current year</label><input type="number" step="1" data-setting="currentYear" value="${num(state.settings.currentYear)}"></div><div class="field"><label>Active contract year</label><input value="${esc(y?.year||state.settings.forecastYear)}" disabled><div class="help">New annual contracts start on 1 January. Create/finalise years from Dashboard.</div></div><div class="field"><label>Stock / contract as at</label><input type="date" data-setting="asOfDate" value="${esc(state.settings.asOfDate)}"><div class="help">${daysUntilContractStart(y?.year||state.settings.forecastYear)} days to 1 January ${esc(y?.year||state.settings.forecastYear)}.</div></div></div></div><div class="card"><h2 style="margin-top:0">Contract assumptions</h2><p><strong>Dashboard contract rounding is fixed at 5 kg upward</strong> for annual recommendations and final contracts.</p><p class="help">Use to 1 January is estimated from the projected 12-month recipe demand as a daily average. Physical stock is assumed to be consumed first, then the current contract balance. Any predicted pre-January shortfall is flagged separately.</p></div></div>
  <div class="card" style="margin-top:16px"><div class="section-head"><div><h2 style="margin-top:0">Hop formats</h2><p>Manage the approved product formats here. Inventory can only choose from this list, preventing spelling variations from creating duplicate products.</p></div><button class="btn" data-action="add-hop-format">Add format</button></div>
    <div class="settings-list">${formats.map((f,idx)=>`<div class="settings-list-row"><input data-hop-format-index="${idx}" value="${esc(f)}"><button class="btn small danger" data-action="remove-hop-format" data-index="${idx}">Remove</button></div>`).join('')}</div>
    <p class="help">Renaming a format updates current Inventory products using it while preserving recipe links. A format cannot be removed while a current Inventory product still uses it.</p>
  </div>
  <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Scenario presets</h2><p class="help">Extra overlay on Core and Seasonal beer forecasts only. Monthly/fixed and one-off volumes are not changed by scenarios.</p><div class="form-grid"><div class="field"><label>Conservative %</label><input type="number" step="0.5" data-setting="scenarioConservativePct" value="${num(state.settings.scenarioConservativePct)}"></div><div class="field"><label>Growth %</label><input type="number" step="0.5" data-setting="scenarioGrowthPct" value="${num(state.settings.scenarioGrowthPct)}"></div><div class="field"><label>Custom %</label><input type="number" step="0.5" data-setting="scenarioCustomPct" value="${num(state.settings.scenarioCustomPct)}"></div></div><p><strong>Current scenario:</strong> ${esc(scenarioLabel())}</p></div>
  <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Annual history rule</h2><pre>draft year = latest actual trailing-12m beer hL + agreed forecast change + current recipe\n\nfinalise year = freeze beer assumptions + exact current recipe + final hop contract\n\nnext year Previous Contract = prior year's Final Contract\n\nchanging today's recipe never changes a finalised historic contract year</pre></div>`;
}

function renderData(){
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Cloud database</h2><p>Supabase is the master copy. Use <strong>Save changes</strong> in the top bar when you have finished a batch of edits. A delayed autosave remains as a safety backup. Finalised annual contract years and their recipe snapshots are stored separately and are not overwritten by live saves.</p>${saveError?`<div class="notice warn"><strong>Last save failed.</strong><br>${esc(saveError)}</div>`:''}<p>Automatic safety backups are throttled so repeated edits do not fill the snapshot history; named forecast snapshots remain manual.</p><p><strong>User:</strong> ${esc(user?.email||'')}</p><p><strong>Mode:</strong> ${readOnly?'Read-only':'Editor'}</p><div class="actions"><button class="btn primary" data-action="save-now">Save now</button><button class="btn" data-action="reload-cloud">Reload cloud copy</button><button class="btn" data-action="export-json">Download JSON backup</button><label class="btn" style="cursor:pointer">Import legacy JSON<input id="legacy-file" type="file" accept="application/json,.json" hidden></label><button class="btn" data-action="refresh-snapshots">Refresh snapshots</button></div><p class="help">If “Save problem” appears, click it to see the exact database error. v1.12 keeps the Debug Log, manual Save changes workflow and duplicate-inventory validation. Supplier contract CSV export is available from the Dashboard contract-year bar.</p></div><div class="card"><h2 style="margin-top:0">Named forecast snapshot</h2><p class="help">Save a labelled copy such as “2027 Initial Forecast”, “Supplier Quote” or “Final Contract”.</p><div class="field"><label>Snapshot name</label><input id="snapshot-name" placeholder="2027 Initial Forecast"></div><button class="btn primary" style="margin-top:10px" data-action="save-named-snapshot">Save named snapshot</button></div></div>
  <div class="section-head"><div><h2>Latest cloud snapshots</h2><p>Named snapshots plus throttled automatic safety backups; maximum 30.</p></div></div>${snapshots.length?`<div class="table-wrap sticky-table-wrap"><table><thead><tr><th>Snapshot</th><th>Created</th><th></th></tr></thead><tbody>${snapshots.map(s=>`<tr><td>${esc(s.name)}</td><td>${new Date(s.created_at).toLocaleString('en-GB')}</td><td><button class="btn small" data-action="restore-snapshot" data-id="${s.id}">Restore</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No cloud snapshots yet.</div>`}`;
}


function renderDebug(){
  const payload=normalise(state);
  const summary=payloadSummary(payload);
  const y=selectedContractYear();
  return `<div class="grid two debug-summary-grid">
    <div class="card"><h2 style="margin-top:0">Live save status</h2>
      <div class="debug-kv"><span>App</span><strong>v${esc(APP_VERSION)}</strong><span>User</span><strong>${esc(user?.email||'Not signed in')}</strong><span>Mode</span><strong>${readOnly?'Read-only':'Editor'}</strong><span>Dirty</span><strong>${dirty?'Yes':'No'}</strong><span>Save in flight</span><strong>${saveInFlight?'Yes':'No'}</strong><span>Lock owned</span><strong>${lockOwned?'Yes':'No'}</strong><span>Contract year</span><strong>${esc(y?.year||state.settings.forecastYear)}</strong></div>
      ${saveError?`<div class="notice warn"><strong>Current save error</strong><br>${esc(saveError)}</div>`:''}
    </div>
    <div class="card"><h2 style="margin-top:0">Current payload</h2>
      <div class="debug-kv"><span>Beers</span><strong>${summary.beers}</strong><span>Recipe lines</span><strong>${summary.recipeLines}</strong><span>Inventory lines</span><strong>${summary.inventory}</strong><span>Orders</span><strong>${summary.orders}</strong><span>Payload size</span><strong>${fmt(summary.bytes/1024,1)} KB</strong><span>Session ID</span><strong class="mono">${esc(sessionId)}</strong></div>
      <p class="help">The debug log never records passwords, access tokens or your full save payload.</p>
    </div>
  </div>
  <div class="section-head"><div><h2>Diagnostics</h2><p>Tests each cloud layer separately without changing your forecast data.</p></div><div class="actions"><button class="btn primary" data-action="run-debug-diagnostics">Run diagnostics</button><button class="btn" data-action="debug-save-now">Test save now</button><button class="btn" data-action="copy-debug-log">Copy debug log</button><button class="btn" data-action="clear-debug-log">Clear log</button></div></div>
  <div class="notice"><strong>What to do:</strong> press <strong>Run diagnostics</strong>, then <strong>Test save now</strong>. If saving still fails, press <strong>Copy debug log</strong> and paste it into ChatGPT.</div>
  <div id="debug-live-log" class="debug-log">${debugLogHtml()}</div>`;
}

async function runDiagnostics(){
  debugLog('info','diagnostics','Diagnostic run started',{appVersion:APP_VERSION,online:navigator.onLine,urlHost:new URL(SUPABASE_URL).host,payload:payloadSummary(normalise(state))});
  try{
    const auth=await withTimeout(supabase.auth.getSession(),'Auth session check',10000);
    debugLog(auth?.data?.session?'info':'warn','diagnostics-auth',auth?.data?.session?'Auth session OK':'No active auth session',{userId:auth?.data?.session?.user?.id||'',email:auth?.data?.session?.user?.email||'',expiresAt:auth?.data?.session?.expires_at||''});
  }catch(err){debugLog('error','diagnostics-auth','Auth session check failed',err)}
  try{
    const lr=await withTimeout(supabase.from('edit_locks').select('lock_key,user_id,user_email,session_id,heartbeat_at').eq('lock_key','global').maybeSingle(),'Lock diagnostic',10000);
    if(lr.error)debugLog('error','diagnostics-lock','Lock query returned an error',{message:lr.error.message,code:lr.error.code,details:lr.error.details,hint:lr.error.hint});
    else debugLog('info','diagnostics-lock','Lock query OK',{lock:lr.data||null,ours:lr.data?.session_id===sessionId});
  }catch(err){debugLog('error','diagnostics-lock','Lock diagnostic failed',err)}
  try{
    const read=await withTimeout(supabase.rpc('get_forecast_state'),'Read RPC diagnostic',20000);
    if(read.error)debugLog('error','diagnostics-read','get_forecast_state returned an error',{message:read.error.message,code:read.error.code,details:read.error.details,hint:read.error.hint});
    else debugLog('info','diagnostics-read','get_forecast_state OK',payloadSummary(read.data||{}));
  }catch(err){debugLog('error','diagnostics-read','Read RPC failed or timed out',err)}
  try{
    const diag=await withTimeout(supabase.rpc('diagnose_hop_contract',{p_payload:normalise(state)}),'Database preflight diagnostic',20000);
    if(diag.error)debugLog('error','diagnostics-db','diagnose_hop_contract returned an error',{message:diag.error.message,code:diag.error.code,details:diag.error.details,hint:diag.error.hint});
    else debugLog('info','diagnostics-db','Database preflight completed',diag.data||{});
  }catch(err){debugLog('error','diagnostics-db','Database preflight unavailable or timed out. If this says function not found, run the v1.10 migration.',err)}
  debugLog('info','diagnostics','Diagnostic run finished');
  render();
}


document.addEventListener('click',e=>{
  const el=e.target.closest('[data-table-view-action]');
  if(!el)return;
  e.preventDefault();e.stopPropagation();
  const action=el.dataset.tableViewAction,key=el.dataset.tableKey;
  if(action==='reset'){resetUniversalTableView(key);return}
  if(action==='show-all'){
    const found=universalTableInfoByKey(key);if(!found)return;
    const prefs=universalPrefsFor(key,found.info.defaultOrder);
    universalTablePrefs[key]={...universalTablePrefs[key],order:prefs.order,hidden:[]};
    saveUniversalTablePrefs();updateUniversalToolbar(key,true);return;
  }
  if(action==='column-up'){moveUniversalColumn(key,el.dataset.column,-1);return}
  if(action==='column-down'){moveUniversalColumn(key,el.dataset.column,1);return}
},true);

document.addEventListener('change',e=>{
  const el=e.target;
  if(!el.dataset.tableToggleColumn)return;
  e.stopPropagation();
  const key=el.dataset.tableKey,column=el.dataset.tableToggleColumn,found=universalTableInfoByKey(key);
  if(!found)return;
  const prefs=universalPrefsFor(key,found.info.defaultOrder),hidden=new Set(prefs.hidden),visible=prefs.order.filter(k=>!hidden.has(k));
  if(el.checked)hidden.delete(column);
  else{
    if(visible.length<=1){el.checked=true;alert('Keep at least one column visible.');return}
    hidden.add(column);
  }
  universalTablePrefs[key]={...universalTablePrefs[key],order:prefs.order,hidden:[...hidden]};
  saveUniversalTablePrefs();updateUniversalToolbar(key,true);
},true);

document.addEventListener('dragstart',e=>{
  const row=e.target.closest('[data-table-drag-column]');if(!row)return;
  universalDraggedColumn={tableKey:row.dataset.tableKey,column:row.dataset.tableDragColumn};
  row.classList.add('dragging');
  if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.tableDragColumn)}
});
document.addEventListener('dragend',e=>{
  e.target.closest('[data-table-drag-column]')?.classList.remove('dragging');
  document.querySelectorAll('.universal-column-option.drag-over').forEach(x=>x.classList.remove('drag-over'));
  universalDraggedColumn=null;
});
document.addEventListener('dragover',e=>{
  const target=e.target.closest('[data-table-drag-column]');
  if(!target||!universalDraggedColumn||target.dataset.tableKey!==universalDraggedColumn.tableKey)return;
  e.preventDefault();
  document.querySelectorAll('.universal-column-option.drag-over').forEach(x=>x.classList.remove('drag-over'));
  target.classList.add('drag-over');
});
document.addEventListener('drop',e=>{
  const target=e.target.closest('[data-table-drag-column]');
  if(!target||!universalDraggedColumn||target.dataset.tableKey!==universalDraggedColumn.tableKey)return;
  e.preventDefault();
  const key=target.dataset.tableKey,from=universalDraggedColumn.column,to=target.dataset.tableDragColumn,found=universalTableInfoByKey(key);
  if(!found||from===to)return;
  const prefs=universalPrefsFor(key,found.info.defaultOrder),order=[...prefs.order],fromIndex=order.indexOf(from),toIndex=order.indexOf(to);
  if(fromIndex<0||toIndex<0)return;
  order.splice(fromIndex,1);order.splice(toIndex,0,from);
  universalTablePrefs[key]={...universalTablePrefs[key],order,hidden:prefs.hidden};
  saveUniversalTablePrefs();updateUniversalToolbar(key,true);universalDraggedColumn=null;
});

window.addEventListener('error',e=>debugLog('error','browser','Unhandled browser error',{message:e.message,filename:e.filename,line:e.lineno,column:e.colno}));
window.addEventListener('unhandledrejection',e=>debugLog('error','browser','Unhandled promise rejection',e.reason instanceof Error?e.reason:{reason:String(e.reason)}));

$('#page-content').addEventListener('click',async e=>{
  const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action;
  if(a==='recipe-usage'){openRecipeUsageModal(el.dataset.id);return;}
  if(a==='merge-inventory-duplicates'){const view=captureViewPosition();const result=mergeInventoryDuplicates();if(result.merged){markDirty();renderPreservingView(view);alert(`Merged ${result.merged} duplicate Hop Stock row${result.merged===1?'':'s'}: ${result.names.join(', ')}. Review the retained quantities, then press Save changes.`)}return;}
  const mutating=!['back-beers','export-json','refresh-snapshots','go-hop','inventory-sort','inventory-reset-columns','dashboard-sort','dashboard-reset-columns','managed-sort','fit-table-columns','reload-cloud','run-debug-diagnostics','copy-debug-log','clear-debug-log','export-supplier-csv','set-hemisphere-filter'].includes(a)&&a!=='restore-snapshot';if(readOnly&&mutating)return alert('Read-only mode.');
  if(a==='add-beer'){const id=uuid();state.beers.push({id,name:'New beer',batchHl:27,active:true,forecastType:'core',last12Hl:0,growthPct:0,forecastBrews:0,monthlyHl:0,oneOffHl:0,notes:'',hops:[]});editingBeerId=id;markDirty();render()}
  if(a==='edit-beer'){editingBeerId=el.dataset.id;render()}
  if(a==='go-hop'){jumpToInventoryHop(el.dataset.hop,el.dataset.hopId||'')}
  if(a==='inventory-sort'){
    const key=el.dataset.sort;
    if(inventorySortKey===key) inventorySortDir=inventorySortDir==='asc'?'desc':'asc';
    else { inventorySortKey=key; inventorySortDir='asc'; }
    render();
  }
  if(a==='managed-sort'){
    const table=el.dataset.table,key=el.dataset.sort;
    if(table==='beer-register'){if(beerRegisterSortKey===key)beerRegisterSortDir=beerRegisterSortDir==='asc'?'desc':'asc';else{beerRegisterSortKey=key;beerRegisterSortDir='asc'}}
    if(table==='production'){if(productionSortKey===key)productionSortDir=productionSortDir==='asc'?'desc':'asc';else{productionSortKey=key;productionSortDir='asc'}}
    render();
  }
  if(a==='fit-table-columns'){const tableKey=el.dataset.table;requestAnimationFrame(()=>fitManagedTableColumns(tableKey));}
  if(a==='dashboard-sort'){
    const table=el.dataset.table,key=el.dataset.sort;
    if(table==='beer'){
      if(dashboardBeerSortKey===key)dashboardBeerSortDir=dashboardBeerSortDir==='asc'?'desc':'asc';
      else{dashboardBeerSortKey=key;dashboardBeerSortDir='asc'}
    }else{
      if(dashboardHopSortKey===key)dashboardHopSortDir=dashboardHopSortDir==='asc'?'desc':'asc';
      else{dashboardHopSortKey=key;dashboardHopSortDir='asc'}
    }
    render();
  }
  if(a==='dashboard-reset-columns'){requestAnimationFrame(()=>{fitManagedTableColumns('dashboard-hop');fitManagedTableColumns('dashboard-beer')})}
  if(a==='finalise-contract-year'){openFinaliseContractModal()}
  if(a==='create-contract-year'){
    const draft=contractYears.find(x=>x.status==='draft');if(draft)return alert(`Finalise ${draft.year} before creating another contract year.`);
    const source=[...contractYears].filter(x=>x.status==='finalised').sort((a,b)=>num(b.year)-num(a.year))[0]||null;
    const nextYear=(source?num(source.year):Math.max(num(state.settings.forecastYear),new Date().getFullYear()))+1;
    if(!confirm(`Create ${nextYear} contract year? The latest actual trailing-12-month beer volumes and current recipes will be used for the new forecast.`))return;
    const copyGrowth=confirm('Copy the current beer increase/decrease percentages into the new year?\n\nOK = copy them\nCancel = reset Core/Seasonal forecast changes to 0%');
    if(dirty)await saveCloud({silent:false});
    const {data,error}=await supabase.rpc('create_contract_year',{p_contract_year:nextYear,p_source_year_id:source?.id||null});
    if(error)return alert(`Could not create contract year: ${error.message}`);
    state.settings.forecastYear=nextYear;state.settings.currentYear=nextYear-1;state.settings.scenarioKey='base';
    if(!copyGrowth)for(const b of state.beers)if(['core','seasonal'].includes(b.forecastType))b.growthPct=0;
    const previous=Array.isArray(data?.previousContracts)?data.previousContracts:[];
    const byId=new Map(previous.filter(x=>x.inventoryId).map(x=>[x.inventoryId,x]));
    const byName=new Map(previous.map(x=>[String(x.hopName||'').toLowerCase(),x]));
    for(const i of state.inventory){const p=byId.get(i.id)||byName.get(String(i.variety||'').toLowerCase());i.contractTotalKg=p?num(p.finalContractKg):0}
    for(const p of previous){if(!state.inventory.some(i=>i.id===p.inventoryId||String(i.variety||'').toLowerCase()===String(p.hopName||'').toLowerCase())&&num(p.finalContractKg)>0)state.inventory.push({id:isUuid(p.inventoryId)?p.inventoryId:uuid(),variety:p.hopName||'Historic hop',hopFormat:cleanHopFormat(p.hopFormat||splitHopProduct(p.hopName||'','',state.settings.hopFormats).format),hemisphere:normaliseHemisphere(p.hemisphere,p.hopName||''),contractEnabled:p.contractEnabled!==false,stockKg:0,contractTotalKg:num(p.finalContractKg),contractKg:0,expectedUseKg:0,supplierReceived12Kg:0,priceKg:0,roundingKg:5,minContractKg:0,manualContractKg:'',safetyStockPct:0,cropYear:'',supplier:'',notes:'Carried forward from prior finalised contract'})}
    selectedContractYearId=data.id;selectedContractDetail=null;markDirty();await saveCloud({silent:false});await loadContractYears(data.id);render();
  }
  if(a==='save-now'){await saveCloud({silent:false})}
  if(a==='debug-save-now'){debugLog('info','debug','Manual test save requested');await saveCloud({silent:false});render()}
  if(a==='run-debug-diagnostics'){await runDiagnostics()}
  if(a==='copy-debug-log'){try{await navigator.clipboard.writeText(debugLogText());debugLog('info','debug','Debug log copied to clipboard')}catch(err){debugLog('error','debug','Could not copy debug log',err);alert('Could not copy automatically. Select the log text manually.')}render()}
  if(a==='clear-debug-log'){debugEntries=[];try{localStorage.removeItem(DEBUG_LOG_KEY)}catch{};render()}
  if(a==='reload-cloud'){if(dirty&&!confirm('Discard local unsaved changes and reload the cloud copy?'))return;await loadCloud()}
  if(a==='set-scenario'){state.settings.scenarioKey=el.dataset.scenario||'base';markDirty();render()}
  if(a==='set-hemisphere-filter'){dashboardHemisphereFilter=['Northern','Southern','All'].includes(el.dataset.hemisphere)?el.dataset.hemisphere:'Northern';render()}
  if(a==='save-named-snapshot'){
    const name=$('#snapshot-name')?.value.trim();
    if(!name)return alert('Enter a snapshot name first.');
    const {error}=await supabase.from('forecast_snapshots').insert({name,snapshot:normalise(state),created_by:user.id});
    if(error)return alert(`Snapshot failed: ${error.message}`);
    await loadSnapshots();render();
  }
  if(a==='back-beers'){editingBeerId=null;render()}
  if(a==='delete-beer'){if(!confirm('Delete this beer and its saved customer orders?'))return;const id=el.dataset.id;state.beers=state.beers.filter(b=>b.id!==id);state.orders=state.orders.filter(o=>o.beerId!==id);editingBeerId=null;markDirty();render()}
  if(a==='add-hop'){const b=state.beers.find(x=>x.id===editingBeerId);if(!state.inventory.length)return alert('Add the hop to Inventory first.');b.hops.push({id:uuid(),inventoryId:'',variety:'',kgPerBrew:0,additionStage:'',notes:''});markDirty();render()}
  if(a==='delete-hop'){const b=state.beers.find(x=>x.id===editingBeerId);b.hops=b.hops.filter(h=>h.id!==el.dataset.id);markDirty();render()}
  if(a==='add-order'){state.orders.push({id:uuid(),name:'Customer order',customerName:'',beerId:state.beers[0]?.id||'',packageKey:'cask40',unitSizeL:40,confirmedUnits:0,fulfilledUnits:0,likelyRepeatUnits:0,status:'confirmed',deliveryDate:'',notes:''});markDirty();render()}
  if(a==='delete-order'){state.orders=state.orders.filter(o=>o.id!==el.dataset.id);markDirty();render()}
  if(a==='calc-save'){if(!calc.beerId)return;state.orders.push({id:uuid(),name:`${num(calc.units)} × ${packageInfo(calc.packageKey).label}`,customerName:'',beerId:calc.beerId,packageKey:calc.packageKey,unitSizeL:packageInfo(calc.packageKey).litres,confirmedUnits:Math.max(0,Math.round(num(calc.units))),fulfilledUnits:0,likelyRepeatUnits:0,status:'confirmed',deliveryDate:'',notes:''});markDirty();render()}
  if(a==='add-hop-format'){
    const raw=prompt('New hop format name (for example T90, T45 or CGX):','');
    const value=cleanHopFormat(raw||'');
    if(!value)return;
    const formats=allowedHopFormats();
    if(formats.some(f=>f.toLowerCase()===value.toLowerCase()))return alert('That hop format already exists.');
    state.settings.hopFormats=[...formats,value];
    markDirty();render();
  }
  if(a==='remove-hop-format'){
    const idx=Math.max(0,Math.floor(num(el.dataset.index)));
    const formats=allowedHopFormats();
    const target=formats[idx];
    if(!target)return;
    const inUse=state.inventory.some(i=>cleanHopFormat(i.hopFormat||splitHopProduct(i.variety,'',formats).format).toLowerCase()===target.toLowerCase());
    if(inUse)return alert(`${target} is currently used by at least one Hop Stock product. Change those products to another format first.`);
    state.settings.hopFormats=formats.filter((_,i)=>i!==idx);
    markDirty();render();
  }
  if(a==='add-inventory'){state.inventory.push({id:uuid(),variety:'',hopFormat:'',hemisphere:'Northern',contractEnabled:true,stockKg:0,contractTotalKg:0,contractKg:0,expectedUseKg:0,supplierReceived12Kg:0,priceKg:0,roundingKg:num(state.settings.globalRoundingKg)||5,minContractKg:0,manualContractKg:'',safetyStockPct:0,cropYear:'',supplier:'',notes:''});markDirty();render()}
  if(a==='delete-inventory'){const id=el.dataset.id,item=state.inventory.find(i=>i.id===id);const uses=state.beers.flatMap(b=>(b.hops||[]).filter(h=>h.inventoryId===id||(!h.inventoryId&&String(h.variety||'').toLowerCase()===String(item?.variety||'').toLowerCase())).map(()=>b.name));if(uses.length)return alert(`${item?.variety||'This inventory item'} is used in ${[...new Set(uses)].join(', ')}. Remove it from those recipes before deleting it from Inventory.`);state.inventory=state.inventory.filter(i=>i.id!==id);markDirty();render()}
  if(a==='export-json'){download(`hop-contract-backup-${today()}.json`,JSON.stringify(state,null,2),'application/json')}
  if(a==='export-supplier-csv'){exportSupplierContractCsv(el.dataset.hemisphere||'Northern')}
  if(a==='refresh-snapshots'){await loadSnapshots();render()}
  if(a==='restore-snapshot'){const s=snapshots.find(x=>x.id===el.dataset.id);if(!s)return;if(!confirm('Restore this snapshot? The restored state will auto-save to the cloud.'))return;state=normalise(s.snapshot);markDirty();render()}
});

$('#page-content').addEventListener('change',async e=>{
  const el=e.target;
  if(el.id==='contract-year-select'){selectedContractYearId=el.value;await loadSelectedContractDetail();render();return;}
  if(el.id==='inventory-format-filter'){inventoryFormatFilter=el.value;applyInventoryFilters();return;}
  if(readOnly)return;
  if(el.dataset.beerField){const b=state.beers.find(x=>x.id===editingBeerId);const f=el.dataset.beerField;b[f]=f==='batchHl'?Math.max(.01,num(el.value)):f==='active'?el.value==='true':el.value;markDirty()}
  if(el.dataset.hopInventory){
    const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId),item=state.inventory.find(i=>i.id===el.value);
    h.inventoryId=item?.id||'';h.variety=item?.variety||'';markDirty();
  }
  if(el.dataset.hopField){const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId);h[el.dataset.hopField]=el.dataset.hopField==='kgPerBrew'?Math.max(0,num(el.value)):el.value;markDirty()}
  if(el.dataset.rowField){const row=el.closest('[data-beer-id]'),b=state.beers.find(x=>x.id===row.dataset.beerId),f=el.dataset.rowField;b[f]=f==='active'?el.checked:f==='forecastType'?el.value:f==='growthPct'?Math.max(-100,num(el.value)):f==='forecastBrews'?Math.max(0,Math.round(num(el.value))):Math.max(0,num(el.value));markDirty();updateProductionRowDisplay(b,row)}
  if(el.dataset.orderField){const row=el.closest('[data-order-id]'),o=state.orders.find(x=>x.id===row.dataset.orderId),f=el.dataset.orderField;o[f]=['confirmedUnits','fulfilledUnits','likelyRepeatUnits'].includes(f)?Math.max(0,Math.round(num(el.value))):el.value;markDirty()}
  if(el.dataset.hopFormatIndex!==undefined){
    const idx=Math.max(0,Math.floor(num(el.dataset.hopFormatIndex)));
    const formats=allowedHopFormats();
    const oldValue=formats[idx]||'';
    const newValue=cleanHopFormat(el.value);
    if(!newValue){el.value=oldValue;return alert('Hop format cannot be blank.')}
    if(formats.some((f,i)=>i!==idx&&f.toLowerCase()===newValue.toLowerCase())){el.value=oldValue;return alert('That hop format already exists.')}
    const affected=state.inventory.filter(i=>cleanHopFormat(i.hopFormat||splitHopProduct(i.variety,'',formats).format).toLowerCase()===oldValue.toLowerCase());
    // Make sure renaming cannot create duplicate exact products.
    for(const item of affected){
      const p=splitHopProduct(item.variety,item.hopFormat,formats);
      const proposed=hopProductName(p.variety,newValue);
      const duplicate=state.inventory.find(x=>x.id!==item.id&&canonicalInventoryName(x.variety)===canonicalInventoryName(proposed));
      if(duplicate){el.value=oldValue;return alert(`Cannot rename ${oldValue} to ${newValue}: ${proposed} already exists.`)}
    }
    formats[idx]=newValue;
    state.settings.hopFormats=formats;
    for(const item of affected){
      const oldProduct=item.variety;
      const p=splitHopProduct(oldProduct,item.hopFormat,[oldValue,...formats]);
      item.hopFormat=newValue;
      item.variety=hopProductName(p.variety,newValue);
      for(const beer of state.beers)for(const hop of beer.hops||[])if(hop.inventoryId===item.id||(!hop.inventoryId&&hop.variety===oldProduct)){hop.inventoryId=item.id;hop.variety=item.variety}
    }
    markDirty();render();
    return;
  }
  if(el.dataset.invProductPart){
    const row=el.closest('[data-inv-id]'),i=state.inventory.find(x=>x.id===row.dataset.invId);
    const oldProduct=i.variety;
    const product=splitHopProduct(oldProduct,i.hopFormat,state.settings.hopFormats);
    const part=el.dataset.invProductPart;
    if(part==='format'){
      const selected=cleanHopFormat(el.value);
      if(selected&&!allowedHopFormats().some(f=>f.toLowerCase()===selected.toLowerCase())){alert('Choose a hop format from Settings.');render();return}
      product.format=selected;
    }else{
      product.variety=el.value;
    }
    const newProduct=hopProductName(product.variety,product.format);
    const duplicate=state.inventory.find(x=>x.id!==i.id&&canonicalInventoryName(x.variety)===canonicalInventoryName(newProduct));
    if(duplicate){alert(`${newProduct} already exists in Hop Stock. Variety + Format must be unique.`);render();return;}
    i.variety=newProduct;
    i.hopFormat=cleanHopFormat(product.format);
    for(const beer of state.beers) for(const hop of beer.hops||[]) if(hop.inventoryId===i.id || (!hop.inventoryId&&hop.variety===oldProduct)){hop.inventoryId=i.id;hop.variety=newProduct;}
    if(inventoryFocusVariety===oldProduct) inventoryFocusVariety=newProduct;
    markDirty();
  }
  if(el.dataset.invField){const row=el.closest('[data-inv-id]'),i=state.inventory.find(x=>x.id===row.dataset.invId),f=el.dataset.invField;if(f==='contractEnabled')i[f]=el.checked;else if(f==='hemisphere')i[f]=normaliseHemisphere(el.value,i.variety);else if(f==='manualContractKg')i[f]=el.value===''?'':Math.max(0,num(el.value));else i[f]=['supplier','notes'].includes(f)?el.value:Math.max(0,num(el.value));markDirty()}
  if(el.dataset.setting){const f=el.dataset.setting;state.settings[f]=f==='asOfDate'?el.value:num(el.value);markDirty()}
  if(el.id==='calc-beer'){calc.beerId=el.value;render()}
  if(el.id==='calc-package'){calc.packageKey=el.value;render()}
  if(el.id==='calc-units'){calc.units=Math.max(0,num(el.value));render()}
  if(el.id==='legacy-file'&&el.files?.[0]) importLegacy(el.files[0]);
});

$('#page-content').addEventListener('input',e=>{
  if(e.target.id==='inventory-search'){inventorySearch=e.target.value;applyInventoryFilters()}
});

let resizingColumn=null;
function resizeConfig(tableKey){
  if(tableKey==='dashboard-hop')return {widths:dashboardHopColWidths,defaults:tableViewDefaults('dashboard-hop',DASHBOARD_HOP_COLUMN_DEFAULTS),storageKey:DASHBOARD_HOP_WIDTHS_KEY,tableId:'dashboard-hop-table'};
  if(tableKey==='dashboard-beer')return {widths:dashboardBeerColWidths,defaults:tableViewDefaults('dashboard-beer',DASHBOARD_BEER_COLUMN_DEFAULTS),storageKey:DASHBOARD_BEER_WIDTHS_KEY,tableId:'dashboard-beer-table'};
  if(tableKey==='beer-register')return {widths:beerRegisterColWidths,defaults:tableViewDefaults('beer-register',BEER_REGISTER_COLUMN_DEFAULTS),storageKey:BEER_REGISTER_WIDTHS_KEY,tableId:'beer-register-table'};
  if(tableKey==='production')return {widths:productionColWidths,defaults:tableViewDefaults('production',PRODUCTION_COLUMN_DEFAULTS),storageKey:PRODUCTION_WIDTHS_KEY,tableId:'production-table'};
  return {widths:inventoryColWidths,defaults:tableViewDefaults('inventory',INVENTORY_COLUMN_DEFAULTS),storageKey:INVENTORY_WIDTHS_KEY,tableId:'inventory-table'};
}
$('#page-content').addEventListener('pointerdown',e=>{
  const handle=e.target.closest('[data-resize-col]');
  if(!handle)return;
  e.preventDefault();e.stopPropagation();
  const tableKey=handle.dataset.resizeTable||'inventory';
  const key=handle.dataset.resizeCol;
  const cfg=resizeConfig(tableKey);
  resizingColumn={tableKey,key,startX:e.clientX,startWidth:Math.max(70,num(cfg.widths[key]))};
  document.body.classList.add('resizing-column');
});
document.addEventListener('pointermove',e=>{
  if(!resizingColumn)return;
  const cfg=resizeConfig(resizingColumn.tableKey);
  const width=Math.max(70,Math.min(560,resizingColumn.startWidth+(e.clientX-resizingColumn.startX)));
  cfg.widths[resizingColumn.key]=Math.round(width);
  const table=document.querySelector(`#${cfg.tableId}`);
  const col=table?.querySelector(`col[data-col-key="${resizingColumn.key}"]`);
  if(col)col.style.width=`${Math.round(width)}px`;
  if(table){
    const total=widthTotal(cfg.widths,cfg.defaults);
    const available=Math.max(0,(table.closest('.table-wrap')?.clientWidth||0)-2);
    const displayWidth=Math.max(total,available);
    table.style.width=`${displayWidth}px`;
    table.style.minWidth=`${displayWidth}px`;
  }
});
document.addEventListener('pointerup',()=>{
  if(!resizingColumn)return;
  const cfg=resizeConfig(resizingColumn.tableKey);
  localStorage.setItem(cfg.storageKey,JSON.stringify(cfg.widths));
  resizingColumn=null;
  document.body.classList.remove('resizing-column');
});

function download(name,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}
async function importLegacy(file){try{const raw=JSON.parse(await file.text());const old=raw.beers||[];const idMap=new Map(old.map(b=>[b.id,uuid()]));const migrated={...raw,beers:old.map(b=>({...b,id:idMap.get(b.id),hops:(b.hops||[]).map(h=>({...h,id:uuid()}))})),orders:(raw.orders||[]).filter(o=>idMap.has(o.beerId)).map(o=>({...o,id:uuid(),beerId:idMap.get(o.beerId)})),inventory:(raw.inventory||[]).map(i=>({...i,id:uuid()}))};state=normalise(migrated);markDirty();alert('Legacy data loaded. Review it, then press Save changes.');render()}catch(err){alert(`Could not import JSON: ${err.message}`)}}

window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
supabase.auth.onAuthStateChange((event,session)=>{if(event==='PASSWORD_RECOVERY'){passwordRecoveryMode=true;user=session?.user||null;showResetPassword();return}if(!session&&!passwordRecoveryMode&&!$('#app-view').classList.contains('hidden'))showAuth()});

await loadSnapshots().catch(()=>{});
await initSession();

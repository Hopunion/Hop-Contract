import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const APP_VERSION='1.8';
const PACKAGES = [
  { key: 'can440', label: 'Can — 440 mL', litres: 0.44 },
  { key: 'can330', label: 'Can — 330 mL', litres: 0.33 },
  { key: 'keg30', label: 'Keg — 30 L', litres: 30 },
  { key: 'keg50', label: 'Keg — 50 L', litres: 50 },
  { key: 'cask20', label: 'Cask — 20 L', litres: 20 },
  { key: 'cask40', label: 'Cask — 40 L', litres: 40 }
];

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

const HOP_FORMATS = ['HyperBoost Oil','HyperBoost','Freshpak','Leaf','T90','T45','Cryo','Incognito','Spectrum','Oil'];

function splitHopProduct(product='') {
  const raw = String(product || '').trim();
  if (!raw) return { variety:'', format:'' };
  const lower = raw.toLowerCase();
  for (const format of HOP_FORMATS) {
    const suffix = ` ${format.toLowerCase()}`;
    if (lower.endsWith(suffix)) {
      return { variety: raw.slice(0, raw.length - suffix.length).trim(), format };
    }
  }
  return { variety: raw, format:'' };
}

function hopProductName(variety='', format='') {
  return [String(variety || '').trim(), String(format || '').trim()].filter(Boolean).join(' ');
}

function hopFormatOptions() {
  return `<datalist id="hop-format-options">${HOP_FORMATS.map(f=>`<option value="${esc(f)}"></option>`).join('')}</datalist>`;
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

function beerBaseForecastHl(beer) {
  if (!beer || beer.active === false) return 0;
  if (beer.forecastType === 'monthly') return Math.max(0, num(beer.monthlyHl) * 12);
  if (beer.forecastType === 'oneoff') return Math.max(0, num(beer.oneOffHl));
  const beerForecast = Math.max(0, num(beer.last12Hl) * (1 + Math.max(-100, num(beer.growthPct)) / 100));
  const scenarioPct = scenarioAdjustmentPct();
  return Math.max(0, beerForecast * (1 + scenarioPct / 100));
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
    const availableNow = stockKg + contractKg;
    const committedBeforeContract = expectedUseKg + row.currentOrder;
    const currentShortfall = Math.max(0, committedBeforeContract - availableNow);
    const carryover = Math.max(0, availableNow - committedBeforeContract);
    const nextGross = row.forecastDemand + row.nextOrder;
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
      stockKg, contractTotalKg, contractKg, expectedUseKg, supplierReceived12Kg,
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
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||''));
const defaultState = () => ({version:APP_VERSION,settings:{currentYear,forecastYear:currentYear+1,asOfDate:today(),bufferPct:5,globalRoundingKg:5,scenarioKey:'base',scenarioConservativePct:-10,scenarioGrowthPct:10,scenarioCustomPct:0},beers:[],orders:[],inventory:[]});

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
const SESSION_STORAGE_KEY = 'hop-contract-editor-session-v1';
let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
if (!sessionId) { sessionId = uuid(); sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId); }

const INVENTORY_COLUMN_DEFAULTS = {
  variety:220, format:105, priceKg:115, stockKg:125, contractKg:145, supplierReceived12Kg:155, contractTotalKg:150, forecastContract:165
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
  beer:180, include:90, type:135, last12:165, growth:160, monthly:125, oneoff:115, forecast:145, repeat:125, total:135
};
const INVENTORY_WIDTHS_KEY = 'hop-contract-inventory-column-widths-v18';
const DASHBOARD_HOP_WIDTHS_KEY = 'hop-contract-dashboard-hop-column-widths-v18';
const DASHBOARD_BEER_WIDTHS_KEY = 'hop-contract-dashboard-beer-column-widths-v18';
const BEER_REGISTER_WIDTHS_KEY = 'hop-contract-beer-register-column-widths-v18';
const PRODUCTION_WIDTHS_KEY = 'hop-contract-production-column-widths-v18';
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
  data:['Data & backup','Cloud saves, snapshots, JSON export and legacy import.']
};

function normalise(input={}) {
  const base = defaultState();
  const s = {...base,...input,version:APP_VERSION,settings:{...base.settings,...(input.settings||{})}};
  s.beers = Array.isArray(input.beers) ? input.beers.map(b=>({
    id:isUuid(b.id)?b.id:uuid(), name:b.name||'Unnamed beer', batchHl:Math.max(.01,num(b.batchHl)||21), active:b.active!==false,
    forecastType:['core','seasonal','monthly','oneoff'].includes(b.forecastType)?b.forecastType:'core',
    last12Hl:Math.max(0,num(b.last12Hl)),growthPct:Math.max(-100,num(b.growthPct)),monthlyHl:Math.max(0,num(b.monthlyHl)),oneOffHl:Math.max(0,num(b.oneOffHl)),notes:b.notes||'',
    hops:Array.isArray(b.hops)?b.hops.map(h=>({id:isUuid(h.id)?h.id:uuid(),inventoryId:isUuid(h.inventoryId)?h.inventoryId:'',variety:h.variety||'',kgPerBrew:Math.max(0,num(h.kgPerBrew)),additionStage:h.additionStage||'',notes:h.notes||''})):[]
  })) : [];
  const beerIds = new Set(s.beers.map(b=>b.id));
  s.orders = Array.isArray(input.orders) ? input.orders.filter(o=>beerIds.has(o.beerId)).map(o=>({
    id:isUuid(o.id)?o.id:uuid(),name:o.name||'Customer order',customerName:o.customerName||'',beerId:o.beerId,
    packageKey:[...PACKAGES.map(p=>p.key),'custom'].includes(o.packageKey)?o.packageKey:'cask40',unitSizeL:Math.max(.001,num(o.unitSizeL)||40),
    confirmedUnits:Math.max(0,Math.round(num(o.confirmedUnits))),fulfilledUnits:Math.max(0,Math.round(num(o.fulfilledUnits))),likelyRepeatUnits:Math.max(0,Math.round(num(o.likelyRepeatUnits))),
    status:['draft','provisional','confirmed','completed','cancelled'].includes(o.status)?o.status:'confirmed',deliveryDate:o.deliveryDate||'',notes:o.notes||''
  })) : [];
  s.inventory = Array.isArray(input.inventory) ? input.inventory.map(i=>({
    id:isUuid(i.id)?i.id:uuid(),variety:i.variety||'',stockKg:Math.max(0,num(i.stockKg)),contractTotalKg:Math.max(0,num(i.contractTotalKg)),contractKg:Math.max(0,num(i.contractKg)),expectedUseKg:Math.max(0,num(i.expectedUseKg)),
    supplierReceived12Kg:Math.max(0,num(i.supplierReceived12Kg)),priceKg:Math.max(0,num(i.priceKg)),roundingKg:Math.max(.01,num(i.roundingKg)||num(s.settings.globalRoundingKg)||1),minContractKg:Math.max(0,num(i.minContractKg)),
    manualContractKg:i.manualContractKg===null||i.manualContractKg===undefined||i.manualContractKg===''?'':Math.max(0,num(i.manualContractKg)),safetyStockPct:Math.max(0,num(i.safetyStockPct)),
    cropYear:i.cropYear||'',supplier:i.supplier||'',notes:i.notes||''
  })) : [];
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

function scheduleAutoSave(delay=1400){
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
    dirtyLabel.textContent=saveError?'Save problem':saveInFlight?'Saving…':dirty?'Waiting to save':'Saved';
  }
  const status=$('#cloud-status');
  if(status)status.textContent=readOnly?'Cloud · read-only':saveError?'Cloud · save failed':saveInFlight?'Cloud · saving…':dirty?'Cloud · autosave pending':'Cloud · saved';
}

async function loadCloud(){
  clearTimeout(autoSaveTimer);
  const {data,error}=await supabase.rpc('get_forecast_state');
  if(error) throw error;
  state=normalise(data||{});
  dirty=false;
  saveError='';
  changeRevision=0;
  editingBeerId=null;
  render();
  updateTopStatus();
}
async function saveCloud({silent=false}={}){
  clearTimeout(autoSaveTimer);
  if(readOnly){
    if(!silent)alert('This session is read-only because another user owns the editing lock.');
    return;
  }
  if(!dirty)return;
  if(saveInFlight){saveQueued=true;return;}
  saveInFlight=true;
  saveQueued=false;
  saveError='';
  const revisionAtStart=changeRevision;
  updateTopStatus();

  const {data:lock,error:lockError}=await supabase.from('edit_locks').select('session_id,user_email,heartbeat_at').eq('lock_key','global').maybeSingle();
  if(lockError){
    saveInFlight=false;saveError=lockError.message;updateTopStatus();
    scheduleAutoSave(5000);
    if(!silent)alert(`Could not verify editing lock: ${lockError.message}`);
    return;
  }
  if(!lock || lock.session_id!==sessionId){
    saveInFlight=false;
    lockOwned=false; readOnly=true; render(); updateTopStatus();
    $('#lock-banner').textContent=`Editing lock lost${lock?.user_email?` to ${lock.user_email}`:''}. Reopen or take over editing before saving.`;
    $('#lock-banner').classList.remove('hidden');
    if(!silent)alert('Your changes have not been saved because another session now owns the editing lock.');
    return;
  }

  const payload=normalise(state);
  const {error}=await supabase.rpc('save_forecast_state',{payload});
  saveInFlight=false;
  if(error){
    saveError=error.message;
    updateTopStatus();
    scheduleAutoSave(5000);
    if(!silent)alert(`Save failed: ${error.message}`);
    return;
  }

  if(changeRevision===revisionAtStart){
    state=payload;
    dirty=false;
  }else{
    dirty=true;
    scheduleAutoSave(500);
  }
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
  return `<div class="contract-year-bar card"><div class="contract-year-picker"><div class="metric-label">Contract year</div><select id="contract-year-select">${contractYearOptions()}</select></div><div class="contract-year-copy"><strong>${y?.status==='finalised'?`${esc(y.year)} contract is frozen`:`Planning ${esc(y?.year||state.settings.forecastYear)}`}</strong><div class="help">${y?.status==='finalised'?'Historic beer volumes, recipes and hop decisions are immutable.':`Draft uses the latest actual trailing-12-month volumes and the current live recipes. Finalising freezes both.`}</div></div><div class="actions">${y?.status==='draft'?`<button class="btn primary" data-action="finalise-contract-year">Finalise ${esc(y.year)} contract</button>`:''}${!hasDraft?`<button class="btn primary" data-action="create-contract-year">Create ${num((latestFinal||y)?.year)+1} contract year</button>`:''}</div></div>`;
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
    monthlyHl:num(b.monthlyHl),oneOffHl:num(b.oneOffHl),forecastHl:beerBaseForecastHl(b),
    recipeHops:(b.hops||[]).map(h=>{const item=hopInventoryItem(h);return {inventoryId:item?.id||h.inventoryId||'',hopName:item?.variety||h.variety||'Unlinked hop',kgPerBrew:num(h.kgPerBrew),additionStage:h.additionStage||'',notes:h.notes||''}})
  }));
  const hops=rows.filter(r=>num(r.baseDemand)>0||num(r.stockKg)>0||num(r.contractKg)>0||num(r.contractTotalKg)>0||dashboardRecommendedContract(r)>0).map(r=>{
    const key=r.inventoryId||r.key;
    const recommended=dashboardRecommendedContract(r);
    return {inventoryId:r.inventoryId||'',hopName:r.variety,inStockKg:num(r.stockKg),onContractKg:num(r.contractKg),previousUse12mKg:num(r.supplierReceived12Kg),projectedUseKg:num(r.baseDemand),previousContractKg:num(r.contractTotalKg),recommendedContractKg:recommended,finalContractKg:finalContracts.has(key)?num(finalContracts.get(key)):recommended,priceKg:num(r.priceKg)};
  });
  return {year:y?.year,beers,hops};
}
function openFinaliseContractModal(){
  const y=selectedContractYear();
  if(!y||y.status!=='draft')return;
  const payload=buildFinalisePayload();
  const rows=payload.hops.sort((a,b)=>b.recommendedContractKg-a.recommendedContractKg||a.hopName.localeCompare(b.hopName));
  $('#finalise-contract-title').textContent=`Finalise ${y.year} hop contract`;
  $('#finalise-contract-copy').innerHTML=`This freezes the ${y.year} volume assumptions and the <strong>current recipe for every beer</strong>. Later recipe changes will only affect future contract years. Final quantities are rounded up to 5 kg when saved.`;
  $('#finalise-contract-rows').innerHTML=rows.map(r=>`<tr><td><strong>${esc(r.hopName)}</strong></td><td>${fmt(r.projectedUseKg)}</td><td>${fmt(r.previousContractKg)}</td><td>${fmt(r.recommendedContractKg)}</td><td><input type="number" min="0" step="5" data-final-contract-key="${esc(r.inventoryId||r.hopName)}" value="${num(r.recommendedContractKg)}"></td></tr>`).join('');
  $('#finalise-contract-modal').classList.remove('hidden');
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
  if(readOnly) content.querySelectorAll('input,select,textarea').forEach(x=>x.disabled=true);
  requestAnimationFrame(autoFitVisibleManagedTables);
  updateTopStatus();
}

function forecastTypeLabel(t){return ({core:'Core',seasonal:'Seasonal',monthly:'Monthly / fixed',oneoff:'One-off'})[t]||'Core'}
function forecastBasis(b){
  if(b.forecastType==='monthly')return `${fmt(b.monthlyHl)} hL/month × 12`;
  if(b.forecastType==='oneoff')return `${fmt(b.oneOffHl)} hL explicit`;
  const scenario=scenarioAdjustmentPct();
  return `${fmt(b.last12Hl)} hL ${num(b.growthPct)>=0?'+':''}${fmt(b.growthPct)}%${scenario?` · scenario ${scenario>=0?'+':''}${fmt(scenario)}%`:''}`;
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
function managedHead(content,key,tableKey){return `<th class="resizable-th">${content}<span class="col-resizer" data-resize-table="${tableKey}" data-resize-col="${key}" title="Drag to resize"></span></th>`}
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
  const projectedUse=Math.max(0,num(r.baseDemand));
  const available=Math.max(0,num(r.stockKg))+Math.max(0,num(r.contractKg));
  return roundUp(Math.max(0,projectedUse-available),5);
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
    const base=beerBaseForecastHl(b),repeat=orderHlForBeer(b.id,true);
    return {beer:b,type:forecastTypeLabel(b.forecastType),basis:forecastBasis(b),base,repeat,total:base+repeat};
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
  const hopRows=historicalHopSort(d.hops||[]),beerRows=historicalBeerSort(d.beers||[]);
  const totalBeer=(d.beers||[]).reduce((x,b)=>x+num(b.forecastHl),0);
  const projected=(d.hops||[]).reduce((x,h)=>x+num(h.projectedUseKg),0);
  const finalKg=(d.hops||[]).reduce((x,h)=>x+num(h.finalContractKg),0);
  const finalValue=(d.hops||[]).reduce((x,h)=>x+num(h.finalContractKg)*num(h.priceKg),0);
  const hopTableWidth=widthTotal(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS);
  const beerTableWidth=widthTotal(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS);
  return `${contractYearBar()}<div class="notice"><strong>Historic ${esc(y.year)} contract.</strong> These figures and recipes were frozen when the year was finalised. Editing today's recipes or inventory will not alter this record.</div>
  <div class="grid metrics"><div class="card"><div class="metric-label">${esc(y.year)} beer forecast</div><div class="metric-value">${fmt(totalBeer)} hL</div></div><div class="card"><div class="metric-label">Projected hop use · 12m</div><div class="metric-value">${fmt(projected)} kg</div></div><div class="card"><div class="metric-label">Final contract</div><div class="metric-value">${fmt(finalKg)} kg</div></div><div class="card"><div class="metric-label">Recorded contract value</div><div class="metric-value">${money(finalValue)}</div></div></div>
  <div class="section-head"><div><h2>Finalised hop contract</h2><p>Previous Contract came from the prior year; Final Contract is the amount carried into the following year.</p></div><button class="btn" data-action="dashboard-reset-columns">Reset column widths</button></div>
  ${hopRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-hop-table" class="managed-table dashboard-table" style="width:${hopTableWidth}px;min-width:${hopTableWidth}px">${colgroupFor(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Hop','hop','hop'),'hop','dashboard-hop')}${managedHead(dashboardSortHeader('In Stock','stock','hop'),'stock','dashboard-hop')}${managedHead(dashboardSortHeader('On Contract','contractLeft','hop'),'contractLeft','dashboard-hop')}${managedHead(dashboardSortHeader('Previous Use (12m)','previousUse','hop'),'previousUse','dashboard-hop')}${managedHead(dashboardSortHeader('Projected Use (12m)','projectedUse','hop'),'projectedUse','dashboard-hop')}${managedHead(dashboardSortHeader('Previous Contract','previousContract','hop'),'previousContract','dashboard-hop')}${managedHead(dashboardSortHeader('Final Contract','recommended','hop'),'recommended','dashboard-hop')}</tr></thead><tbody>${hopRows.map(h=>`<tr><td><strong>${esc(h.hopName)}</strong></td><td>${fmt(h.inStockKg)}</td><td>${fmt(h.onContractKg)}</td><td>${fmt(h.previousUse12mKg||0)}</td><td><strong>${fmt(h.projectedUseKg)}</strong></td><td>${fmt(h.previousContractKg)}</td><td><strong>${fmt(h.finalContractKg)}</strong><div class="help">Recommended ${fmt(h.recommendedContractKg)} kg</div></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No frozen hop rows.</div>`}
  <div class="section-head"><div><h2>Beer assumptions & recipe versions</h2><p>Each beer points to the immutable recipe snapshot used for this contract year.</p></div><button class="btn" data-action="fit-table-columns" data-table="dashboard-beer">Reset column widths</button></div>
  ${beerRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-beer-table" class="managed-table dashboard-table" style="width:${beerTableWidth}px;min-width:${beerTableWidth}px">${colgroupFor(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Beer','beer','beer'),'beer','dashboard-beer')}${managedHead(dashboardSortHeader('Type','type','beer'),'type','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast basis','basis','beer'),'basis','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast hL','base','beer'),'base','dashboard-beer')}${managedHead(dashboardSortHeader('Recipe version','repeat','beer'),'repeat','dashboard-beer')}${managedHead(dashboardSortHeader('Recipe used','total','beer'),'total','dashboard-beer')}</tr></thead><tbody>${beerRows.map(b=>`<tr><td><strong>${esc(b.name)}</strong></td><td>${esc(forecastTypeLabel(b.forecastType))}</td><td>${fmt(b.baselineLast12Hl)} hL ${num(b.growthPct)>=0?'+':''}${fmt(b.growthPct)}%${num(b.scenarioAdjustmentPct)?` · scenario ${num(b.scenarioAdjustmentPct)>=0?'+':''}${fmt(b.scenarioAdjustmentPct)}%`:''}</td><td><strong>${fmt(b.forecastHl)}</strong></td><td>${esc(b.recipeVersionLabel||'Snapshot')}</td><td>${(b.recipeHops||[]).map(h=>`${esc(h.hopName)} <strong>${fmt(h.kgPerBrew,2)} kg</strong>`).join(' · ')||'<span class="muted">No hops</span>'}</td></tr>`).join('')}</tbody></table></div>`:''}`;
}

function renderDashboard(){
  const y=selectedContractYear();
  if(y?.status==='finalised')return renderHistoricalDashboard();
  const rows=calculateForecast(state),t=totals(rows);
  const totalBeer=state.beers.filter(b=>b.active!==false).reduce((sum,b)=>sum+beerBaseForecastHl(b),0);
  const dashboardRecommendedTotal=rows.reduce((sum,r)=>sum+dashboardRecommendedContract(r),0);
  const dashboardCost=rows.reduce((sum,r)=>sum+dashboardRecommendedContract(r)*Math.max(0,num(r.priceKg)),0);
  const topHops=[...rows].map(r=>({...r,dashboardRecommended:dashboardRecommendedContract(r)})).sort((a,b)=>b.dashboardRecommended-a.dashboardRecommended).filter(r=>r.dashboardRecommended>0).slice(0,5);
  const topBeers=state.beers.filter(b=>b.active!==false).map(b=>({name:b.name,hl:beerBaseForecastHl(b)})).sort((a,b)=>b.hl-a.hl).slice(0,5);
  const hopRows=sortedDashboardHops(rows);
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
  <div class="section-head"><div><h2>Hop contract recommendation</h2><p><strong>Recommended Contract = Projected Use (12m) − In Stock − On Contract</strong>, floor zero, always rounded UP to the next 5 kg. Previous Contract is comparison-only.</p></div><button class="btn" data-action="dashboard-reset-columns">Reset column widths</button></div>
  ${rows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-hop-table" class="managed-table dashboard-table" style="width:${hopTableWidth}px;min-width:${hopTableWidth}px">${colgroupFor(dashboardHopColWidths,DASHBOARD_HOP_COLUMN_DEFAULTS)}<thead><tr>
    ${managedHead(dashboardSortHeader('Hop','hop','hop'),'hop','dashboard-hop')}
    ${managedHead(dashboardSortHeader('In Stock','stock','hop'),'stock','dashboard-hop')}
    ${managedHead(dashboardSortHeader('On Contract','contractLeft','hop'),'contractLeft','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Previous Use (12m)','previousUse','hop'),'previousUse','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Projected Use (12m)','projectedUse','hop'),'projectedUse','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Previous Contract','previousContract','hop'),'previousContract','dashboard-hop')}
    ${managedHead(dashboardSortHeader('Recommended Contract','recommended','hop'),'recommended','dashboard-hop')}
  </tr></thead><tbody>${hopRows.map(r=>{const recommended=dashboardRecommendedContract(r);return `<tr><td><strong>${esc(r.variety)}</strong></td><td>${fmt(r.stockKg)}</td><td>${fmt(r.contractKg)}</td><td>${fmt(r.supplierReceived12Kg)}</td><td><strong>${fmt(r.baseDemand)}</strong></td><td>${fmt(r.contractTotalKg)}</td><td><strong>${fmt(recommended)}</strong></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add hop inventory and current recipes to build the contract recommendation.</div>`}
  <div class="grid two insight-grid" style="margin-top:16px"><div class="card"><h3 style="margin-top:0">Largest contract requirements</h3>${topHops.length?topHops.map((r,i)=>`<div class="rank-row"><span>${i+1}. ${esc(r.variety)}</span><strong>${fmt(r.dashboardRecommended)} kg</strong></div>`).join(''):`<div class="help">No new contract quantity required.</div>`}</div><div class="card"><h3 style="margin-top:0">Largest beer forecasts</h3>${topBeers.length?topBeers.map((b,i)=>`<div class="rank-row"><span>${i+1}. ${esc(b.name)}</span><strong>${fmt(b.hl)} hL</strong></div>`).join(''):`<div class="help">No active beer forecasts.</div>`}</div></div>
  <div class="section-head"><div><h2>Beer forecast detail</h2><p>Historical hL is a volume baseline only; the current recipe is applied to the forward forecast.</p></div><button class="btn" data-action="fit-table-columns" data-table="dashboard-beer">Reset column widths</button></div>${beerRows.length?`<div class="table-wrap sticky-table-wrap dashboard-table-wrap"><table id="dashboard-beer-table" class="managed-table dashboard-table" style="width:${beerTableWidth}px;min-width:${beerTableWidth}px">${colgroupFor(dashboardBeerColWidths,DASHBOARD_BEER_COLUMN_DEFAULTS)}<thead><tr>${managedHead(dashboardSortHeader('Beer','beer','beer'),'beer','dashboard-beer')}${managedHead(dashboardSortHeader('Type','type','beer'),'type','dashboard-beer')}${managedHead(dashboardSortHeader('Forecast basis','basis','beer'),'basis','dashboard-beer')}${managedHead(dashboardSortHeader('Projected hL','base','beer'),'base','dashboard-beer')}${managedHead(dashboardSortHeader('Repeat orders hL','repeat','beer'),'repeat','dashboard-beer')}${managedHead(dashboardSortHeader('Total hL','total','beer'),'total','dashboard-beer')}</tr></thead><tbody>${beerRows.map(r=>`<tr><td><strong>${esc(r.beer.name)}</strong></td><td>${esc(r.type)}</td><td>${esc(r.basis)}</td><td><strong>${fmt(r.base)}</strong></td><td>${fmt(r.repeat)}</td><td>${fmt(r.total)}</td></tr>`).join('')}</tbody></table></div>`:''}`;
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
  const rows=state.beers.map(b=>{const base=beerBaseForecastHl(b),rep=orderHlForBeer(b.id,true);return {beer:b,base,rep,total:base+rep};});
  const dir=productionSortDir==='desc'?-1:1;
  return rows.sort((a,b)=>{const value=(r,key)=>key==='beer'?String(r.beer.name||'').toLowerCase():key==='include'?(r.beer.active!==false?1:0):key==='type'?forecastTypeLabel(r.beer.forecastType):key==='last12'?num(r.beer.last12Hl):key==='growth'?num(r.beer.growthPct):key==='monthly'?num(r.beer.monthlyHl):key==='oneoff'?num(r.beer.oneOffHl):key==='forecast'?r.base:key==='repeat'?r.rep:key==='total'?r.total:'';const av=value(a,productionSortKey),bv=value(b,productionSortKey);if(typeof av==='number'&&typeof bv==='number')return(av-bv)*dir;return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;});
}
function renderProduction(){
  const rows=productionRows(),tableWidth=widthTotal(productionColWidths,PRODUCTION_COLUMN_DEFAULTS);
  return `<div class="notice"><strong>Forecast rule:</strong> <strong>Last 12m hL is volume only.</strong> The app does not assume those beers historically used today’s hop recipe. For the forward forecast it projects each beer’s hL, then applies the <strong>current recipe</strong>. Current scenario: <strong>${esc(scenarioLabel())}</strong>.</div>
  <div class="section-head"><div><h2>Beer volume forecast</h2><p>Click headings to sort; drag columns to resize.</p></div><button class="btn" data-action="fit-table-columns" data-table="production">Reset column widths</button></div>
  ${rows.length?`<div class="table-wrap sticky-table-wrap"><table id="production-table" class="managed-table production-table" style="width:${tableWidth}px;min-width:${tableWidth}px">${colgroupFor(productionColWidths,PRODUCTION_COLUMN_DEFAULTS)}<thead><tr>
    ${managedHead(tableSortHeader('Beer','beer','production',productionSortKey,productionSortDir),'beer','production')}
    ${managedHead(tableSortHeader('Include','include','production',productionSortKey,productionSortDir),'include','production')}
    ${managedHead(tableSortHeader('Forecast type','type','production',productionSortKey,productionSortDir),'type','production')}
    ${managedHead(tableSortHeader('Historical brewed hL · last 12m','last12','production',productionSortKey,productionSortDir),'last12','production')}
    ${managedHead(tableSortHeader('Forecast increase / decrease %','growth','production',productionSortKey,productionSortDir),'growth','production')}
    ${managedHead(tableSortHeader('Monthly fixed hL','monthly','production',productionSortKey,productionSortDir),'monthly','production')}
    ${managedHead(tableSortHeader('One-off hL','oneoff','production',productionSortKey,productionSortDir),'oneoff','production')}
    ${managedHead(tableSortHeader(`Forecast ${esc(state.settings.forecastYear)} hL`,'forecast','production',productionSortKey,productionSortDir),'forecast','production')}
    ${managedHead(tableSortHeader('Repeat orders hL','repeat','production',productionSortKey,productionSortDir),'repeat','production')}
    ${managedHead(tableSortHeader('Total forward hL','total','production',productionSortKey,productionSortDir),'total','production')}
  </tr></thead><tbody>${rows.map(r=>{const b=r.beer;return `<tr data-beer-id="${b.id}"><td><strong>${esc(b.name)}</strong></td><td><input type="checkbox" data-row-field="active" ${b.active!==false?'checked':''}></td><td><select data-row-field="forecastType"><option value="core" ${b.forecastType==='core'?'selected':''}>Core</option><option value="seasonal" ${b.forecastType==='seasonal'?'selected':''}>Seasonal</option><option value="monthly" ${b.forecastType==='monthly'?'selected':''}>Monthly / fixed</option><option value="oneoff" ${b.forecastType==='oneoff'?'selected':''}>One-off</option></select></td><td><input type="number" min="0" step="0.1" data-row-field="last12Hl" value="${num(b.last12Hl)}"><div class="help">Volume history only</div></td><td><input type="number" min="-100" step="0.5" data-row-field="growthPct" value="${num(b.growthPct)}" ${['monthly','oneoff'].includes(b.forecastType)?'disabled':''}></td><td><input type="number" min="0" step="0.1" data-row-field="monthlyHl" value="${num(b.monthlyHl)}" ${b.forecastType==='monthly'?'':'disabled'}></td><td><input type="number" min="0" step="0.1" data-row-field="oneOffHl" value="${num(b.oneOffHl)}" ${b.forecastType==='oneoff'?'':'disabled'}></td><td><strong>${fmt(r.base)}</strong><div class="help">Current recipe applied after volume forecast</div></td><td>${fmt(r.rep)}</td><td><strong>${fmt(r.total)}</strong></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add beers before entering production forecasts.</div>`}`;
}
function renderOrders(){
  const b=state.beers.find(x=>x.id===calc.beerId);const hl=unitsToHl(calc.units,calc.packageKey);const breakdown=b?Object.entries(recipeRates(b)).map(([v,r])=>({v,kg:r*hl})):[];
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">One-off packaging calculator</h2><p class="help">Does not affect the forecast unless you save it as an order.</p><div class="form-grid"><div class="field"><label>Beer</label><select id="calc-beer">${beerOptions(calc.beerId)}</select></div><div class="field"><label>Package</label><select id="calc-package">${packageOptions(calc.packageKey)}</select></div><div class="field"><label>Units</label><input id="calc-units" type="number" min="0" step="1" value="${num(calc.units)}"></div></div><div class="calc-result" style="margin-top:14px"><strong>${fmt(hl)} hL</strong> · ${b?`${fmt(hl/Math.max(.001,num(b.batchHl)),2)} standard brews`:'select a beer'}${breakdown.length?`<div style="margin-top:8px">${breakdown.map(x=>`${esc(x.v)} <strong>${fmt(x.kg,2)} kg</strong>`).join(' · ')}</div>`:''}</div><button class="btn primary" style="margin-top:12px" data-action="calc-save" ${!b?'disabled':''}>Save as customer order</button></div>
  <div class="card"><h2 style="margin-top:0">Forecast treatment</h2><p><strong>Confirmed units remaining</strong> are deducted from stock/current contract now.</p><p><strong>Likely repeat units</strong> are added to next year's hop requirement.</p><p>This means a 600-cask customer contract never becomes recurring demand unless you explicitly enter a likely repeat quantity.</p></div></div>
  <div class="section-head"><div><h2>Saved customer orders</h2></div><button class="btn" data-action="add-order" ${state.beers.length?'':'disabled'}>Add blank order</button></div>
  ${state.orders.length?`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Beer</th><th>Package</th><th>Confirmed units</th><th>Fulfilled</th><th>Remaining hL</th><th>Likely repeat units</th><th>Repeat hL</th><th>Status</th><th></th></tr></thead><tbody>${state.orders.map(o=>`<tr data-order-id="${o.id}"><td><input data-order-field="name" value="${esc(o.name)}"></td><td><select data-order-field="beerId">${beerOptions(o.beerId)}</select></td><td><select data-order-field="packageKey">${packageOptions(o.packageKey)}</select></td><td><input type="number" min="0" step="1" data-order-field="confirmedUnits" value="${num(o.confirmedUnits)}"></td><td><input type="number" min="0" step="1" data-order-field="fulfilledUnits" value="${num(o.fulfilledUnits)}"></td><td>${fmt(unitsToHl(Math.max(0,num(o.confirmedUnits)-num(o.fulfilledUnits)),o.packageKey,o.unitSizeL))}</td><td><input type="number" min="0" step="1" data-order-field="likelyRepeatUnits" value="${num(o.likelyRepeatUnits)}"></td><td>${fmt(unitsToHl(o.likelyRepeatUnits,o.packageKey,o.unitSizeL))}</td><td><select data-order-field="status"><option value="confirmed" ${o.status==='confirmed'?'selected':''}>Confirmed</option><option value="provisional" ${o.status==='provisional'?'selected':''}>Provisional</option><option value="completed" ${o.status==='completed'?'selected':''}>Completed</option><option value="cancelled" ${o.status==='cancelled'?'selected':''}>Cancelled</option></select></td><td><button class="btn danger small" data-action="delete-order" data-id="${o.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No saved customer orders.</div>`}`;
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
  return `${jumpNote}<div class="notice"><strong>Previous Use (12m)</strong> is the supplier-delivered quantity from the previous 12 months. <strong>Forecast Contract</strong> uses projected recipe demand less Current Stock and Contract Remaining, then rounds up to the next 5 kg.</div>
  <div class="section-head"><div><h2>Hop stock & contract</h2><p>One line = one variety + format. Click headings to sort; drag column edges to resize.</p></div><div class="actions"><button class="btn" data-action="fit-table-columns" data-table="inventory">Reset column widths</button><button class="btn primary" data-action="add-inventory">Add hop</button></div></div>
  <div class="inventory-tools card"><div class="field"><label>Search hops</label><input id="inventory-search" value="${esc(inventorySearch)}" placeholder="e.g. Citra, Simcoe, T45"></div><div class="field"><label>Format</label><select id="inventory-format-filter"><option value="">All formats</option>${formats.map(f=>`<option value="${esc(f)}" ${f===inventoryFormatFilter?'selected':''}>${esc(f)}</option>`).join('')}</select></div><div class="help">Previous and forecast contract quantities are shown side by side for quick annual planning.</div></div>
  ${hopFormatOptions()}
  ${state.inventory.length?`<div class="table-wrap inventory-wrap sticky-table-wrap"><table id="inventory-table" class="inventory-table managed-table" style="width:${inventoryTableWidth()}px;min-width:${inventoryTableWidth()}px">${inventoryColgroup()}<thead><tr>
    ${resizableHead(inventorySortHeader('Variety','name'),'variety')}
    ${resizableHead(inventorySortHeader('Format','format'),'format')}
    ${resizableHead(inventorySortHeader('Price per kg','priceKg'),'priceKg')}
    ${resizableHead(inventorySortHeader('Current stock','stockKg'),'stockKg')}
    ${resizableHead(inventorySortHeader('Contract Remaining','contractKg'),'contractKg')}
    ${resizableHead(inventorySortHeader('Previous Use (12m)','supplierReceived12Kg'),'supplierReceived12Kg')}
    ${resizableHead(inventorySortHeader('Previous Contract','contractTotalKg'),'contractTotalKg')}
    ${resizableHead(inventorySortHeader('Forecast Contract','forecastContract'),'forecastContract')}
  </tr></thead><tbody>${items.map(i=>{const r=by.get(i.id)||by.get(i.variety)||{};const focused=i.variety===inventoryFocusVariety;const product=splitHopProduct(i.variety);const forecastContract=dashboardRecommendedContract(r);return `<tr data-inv-id="${i.id}" data-inv-variety="${esc(i.variety)}" data-search-text="${esc(`${i.variety} ${product.variety} ${product.format}`.toLowerCase())}" data-format="${esc(product.format.toLowerCase())}" class="${focused?'inventory-target':''}">
    <td><div class="inventory-variety-edit"><input class="hop-name-input" data-inv-product-part="variety" value="${esc(product.variety)}" placeholder="Citra"><button class="mini-delete" type="button" data-action="delete-inventory" data-id="${i.id}" title="Delete inventory line">×</button></div></td>
    <td><input list="hop-format-options" data-inv-product-part="format" value="${esc(product.format)}" placeholder="T90"></td>
    <td><input type="number" min="0" step="0.01" data-inv-field="priceKg" value="${num(i.priceKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="stockKg" value="${num(i.stockKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="contractKg" value="${num(i.contractKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="supplierReceived12Kg" value="${num(i.supplierReceived12Kg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="contractTotalKg" value="${num(i.contractTotalKg)}"></td>
    <td><strong>${fmt(forecastContract)} kg</strong><div class="help">Rounded up to 5 kg</div></td>
  </tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add current hop stock and contract balances.</div>`}`;
}

function renderSettings(){const y=selectedContractYear();return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Forecast period</h2><div class="form-grid"><div class="field"><label>Current year</label><input type="number" step="1" data-setting="currentYear" value="${num(state.settings.currentYear)}"></div><div class="field"><label>Active contract year</label><input value="${esc(y?.year||state.settings.forecastYear)}" disabled><div class="help">Create/finalise annual contract years from Dashboard.</div></div><div class="field"><label>Stock / contract as at</label><input type="date" data-setting="asOfDate" value="${esc(state.settings.asOfDate)}"></div></div></div><div class="card"><h2 style="margin-top:0">Contract assumptions</h2><p><strong>Dashboard contract rounding is fixed at 5 kg upward</strong> for annual recommendations and final contracts.</p><p class="help">The detailed Inventory fields remain available for operational checks, but the Dashboard recommendation is Projected Use − In Stock − On Contract.</p></div></div>
  <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Scenario presets</h2><p class="help">Extra overlay on Core and Seasonal beer forecasts only. Monthly/fixed and one-off volumes are not changed by scenarios.</p><div class="form-grid"><div class="field"><label>Conservative %</label><input type="number" step="0.5" data-setting="scenarioConservativePct" value="${num(state.settings.scenarioConservativePct)}"></div><div class="field"><label>Growth %</label><input type="number" step="0.5" data-setting="scenarioGrowthPct" value="${num(state.settings.scenarioGrowthPct)}"></div><div class="field"><label>Custom %</label><input type="number" step="0.5" data-setting="scenarioCustomPct" value="${num(state.settings.scenarioCustomPct)}"></div></div><p><strong>Current scenario:</strong> ${esc(scenarioLabel())}</p></div>
  <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Annual history rule</h2><pre>draft year = latest actual trailing-12m beer hL + agreed forecast change + current recipe\n\nfinalise year = freeze beer assumptions + exact current recipe + final hop contract\n\nnext year Previous Contract = prior year's Final Contract\n\nchanging today's recipe never changes a finalised historic contract year</pre></div>`}

function renderData(){
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Cloud database</h2><p>Supabase is the master copy. Normal edits <strong>auto-save</strong> after a short pause. Finalised annual contract years and their recipe snapshots are stored separately and are not overwritten by live saves.</p><p>Automatic safety backups are throttled so repeated edits do not fill the snapshot history; named forecast snapshots remain manual.</p><p><strong>User:</strong> ${esc(user?.email||'')}</p><p><strong>Mode:</strong> ${readOnly?'Read-only':'Editor'}</p><div class="actions"><button class="btn primary" data-action="save-now">Save now</button><button class="btn" data-action="reload-cloud">Reload cloud copy</button><button class="btn" data-action="export-json">Download JSON backup</button><label class="btn" style="cursor:pointer">Import legacy JSON<input id="legacy-file" type="file" accept="application/json,.json" hidden></label><button class="btn" data-action="refresh-snapshots">Refresh snapshots</button></div><p class="help">“Save now” and “Reload cloud copy” are troubleshooting controls; they are not needed during normal use.</p></div><div class="card"><h2 style="margin-top:0">Named forecast snapshot</h2><p class="help">Save a labelled copy such as “2027 Initial Forecast”, “Supplier Quote” or “Final Contract”.</p><div class="field"><label>Snapshot name</label><input id="snapshot-name" placeholder="2027 Initial Forecast"></div><button class="btn primary" style="margin-top:10px" data-action="save-named-snapshot">Save named snapshot</button></div></div>
  <div class="section-head"><div><h2>Latest cloud snapshots</h2><p>Named snapshots plus throttled automatic safety backups; maximum 30.</p></div></div>${snapshots.length?`<div class="table-wrap sticky-table-wrap"><table><thead><tr><th>Snapshot</th><th>Created</th><th></th></tr></thead><tbody>${snapshots.map(s=>`<tr><td>${esc(s.name)}</td><td>${new Date(s.created_at).toLocaleString('en-GB')}</td><td><button class="btn small" data-action="restore-snapshot" data-id="${s.id}">Restore</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No cloud snapshots yet.</div>`}`;
}

$('#page-content').addEventListener('click',async e=>{
  const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action;
  const mutating=!['back-beers','export-json','refresh-snapshots','go-hop','inventory-sort','inventory-reset-columns','dashboard-sort','dashboard-reset-columns','managed-sort','fit-table-columns','reload-cloud'].includes(a)&&a!=='restore-snapshot';if(readOnly&&mutating)return alert('Read-only mode.');
  if(a==='add-beer'){const id=uuid();state.beers.push({id,name:'New beer',batchHl:27,active:true,forecastType:'core',last12Hl:0,growthPct:0,monthlyHl:0,oneOffHl:0,notes:'',hops:[]});editingBeerId=id;markDirty();render()}
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
    for(const p of previous){if(!state.inventory.some(i=>i.id===p.inventoryId||String(i.variety||'').toLowerCase()===String(p.hopName||'').toLowerCase())&&num(p.finalContractKg)>0)state.inventory.push({id:isUuid(p.inventoryId)?p.inventoryId:uuid(),variety:p.hopName||'Historic hop',stockKg:0,contractTotalKg:num(p.finalContractKg),contractKg:0,expectedUseKg:0,supplierReceived12Kg:0,priceKg:0,roundingKg:5,minContractKg:0,manualContractKg:'',safetyStockPct:0,cropYear:'',supplier:'',notes:'Carried forward from prior finalised contract'})}
    selectedContractYearId=data.id;selectedContractDetail=null;markDirty();await saveCloud({silent:false});await loadContractYears(data.id);render();
  }
  if(a==='save-now'){await saveCloud({silent:false})}
  if(a==='reload-cloud'){if(dirty&&!confirm('Discard local unsaved changes and reload the cloud copy?'))return;await loadCloud()}
  if(a==='set-scenario'){state.settings.scenarioKey=el.dataset.scenario||'base';markDirty();render()}
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
  if(a==='add-inventory'){state.inventory.push({id:uuid(),variety:'',stockKg:0,contractTotalKg:0,contractKg:0,expectedUseKg:0,supplierReceived12Kg:0,priceKg:0,roundingKg:num(state.settings.globalRoundingKg)||5,minContractKg:0,manualContractKg:'',safetyStockPct:0,cropYear:'',supplier:'',notes:''});markDirty();render()}
  if(a==='delete-inventory'){const id=el.dataset.id,item=state.inventory.find(i=>i.id===id);const uses=state.beers.flatMap(b=>(b.hops||[]).filter(h=>h.inventoryId===id||(!h.inventoryId&&String(h.variety||'').toLowerCase()===String(item?.variety||'').toLowerCase())).map(()=>b.name));if(uses.length)return alert(`${item?.variety||'This inventory item'} is used in ${[...new Set(uses)].join(', ')}. Remove it from those recipes before deleting it from Inventory.`);state.inventory=state.inventory.filter(i=>i.id!==id);markDirty();render()}
  if(a==='export-json'){download(`hop-contract-backup-${today()}.json`,JSON.stringify(state,null,2),'application/json')}
  if(a==='refresh-snapshots'){await loadSnapshots();render()}
  if(a==='restore-snapshot'){const s=snapshots.find(x=>x.id===el.dataset.id);if(!s)return;if(!confirm('Restore this snapshot? The restored state will auto-save to the cloud.'))return;state=normalise(s.snapshot);markDirty();render()}
});

$('#page-content').addEventListener('change',async e=>{
  const el=e.target;
  if(el.id==='contract-year-select'){selectedContractYearId=el.value;await loadSelectedContractDetail();render();return;}
  if(el.id==='inventory-format-filter'){inventoryFormatFilter=el.value;applyInventoryFilters();return;}
  if(readOnly)return;
  if(el.dataset.beerField){const b=state.beers.find(x=>x.id===editingBeerId);const f=el.dataset.beerField;b[f]=f==='batchHl'?Math.max(.01,num(el.value)):f==='active'?el.value==='true':el.value;markDirty();render()}
  if(el.dataset.hopInventory){
    const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId),item=state.inventory.find(i=>i.id===el.value);
    h.inventoryId=item?.id||'';h.variety=item?.variety||'';markDirty();render();
  }
  if(el.dataset.hopField){const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId);h[el.dataset.hopField]=el.dataset.hopField==='kgPerBrew'?Math.max(0,num(el.value)):el.value;markDirty();render()}
  if(el.dataset.rowField){const row=el.closest('[data-beer-id]'),b=state.beers.find(x=>x.id===row.dataset.beerId),f=el.dataset.rowField;b[f]=f==='active'?el.checked:f==='forecastType'?el.value:f==='growthPct'?Math.max(-100,num(el.value)):Math.max(0,num(el.value));markDirty();render()}
  if(el.dataset.orderField){const row=el.closest('[data-order-id]'),o=state.orders.find(x=>x.id===row.dataset.orderId),f=el.dataset.orderField;o[f]=['confirmedUnits','fulfilledUnits','likelyRepeatUnits'].includes(f)?Math.max(0,Math.round(num(el.value))):el.value;markDirty();render()}
  if(el.dataset.invProductPart){
    const row=el.closest('[data-inv-id]'),i=state.inventory.find(x=>x.id===row.dataset.invId);
    const oldProduct=i.variety;
    const product=splitHopProduct(oldProduct);
    product[el.dataset.invProductPart]=el.value;
    const newProduct=hopProductName(product.variety,product.format);
    i.variety=newProduct;
    // Keep recipe links pointing at the renamed quantity line.
    for(const beer of state.beers) for(const hop of beer.hops||[]) if(hop.inventoryId===i.id || (!hop.inventoryId&&hop.variety===oldProduct)){hop.inventoryId=i.id;hop.variety=newProduct;}
    if(inventoryFocusVariety===oldProduct) inventoryFocusVariety=newProduct;
    markDirty();render();
  }
  if(el.dataset.invField){const row=el.closest('[data-inv-id]'),i=state.inventory.find(x=>x.id===row.dataset.invId),f=el.dataset.invField;if(f==='manualContractKg')i[f]=el.value===''?'':Math.max(0,num(el.value));else i[f]=['supplier','notes'].includes(f)?el.value:Math.max(0,num(el.value));markDirty();render()}
  if(el.dataset.setting){const f=el.dataset.setting;state.settings[f]=f==='asOfDate'?el.value:num(el.value);markDirty();render()}
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
  if(tableKey==='dashboard-hop')return {widths:dashboardHopColWidths,defaults:DASHBOARD_HOP_COLUMN_DEFAULTS,storageKey:DASHBOARD_HOP_WIDTHS_KEY,tableId:'dashboard-hop-table'};
  if(tableKey==='dashboard-beer')return {widths:dashboardBeerColWidths,defaults:DASHBOARD_BEER_COLUMN_DEFAULTS,storageKey:DASHBOARD_BEER_WIDTHS_KEY,tableId:'dashboard-beer-table'};
  if(tableKey==='beer-register')return {widths:beerRegisterColWidths,defaults:BEER_REGISTER_COLUMN_DEFAULTS,storageKey:BEER_REGISTER_WIDTHS_KEY,tableId:'beer-register-table'};
  if(tableKey==='production')return {widths:productionColWidths,defaults:PRODUCTION_COLUMN_DEFAULTS,storageKey:PRODUCTION_WIDTHS_KEY,tableId:'production-table'};
  return {widths:inventoryColWidths,defaults:INVENTORY_COLUMN_DEFAULTS,storageKey:INVENTORY_WIDTHS_KEY,tableId:'inventory-table'};
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
async function importLegacy(file){try{const raw=JSON.parse(await file.text());const old=raw.beers||[];const idMap=new Map(old.map(b=>[b.id,uuid()]));const migrated={...raw,beers:old.map(b=>({...b,id:idMap.get(b.id),hops:(b.hops||[]).map(h=>({...h,id:uuid()}))})),orders:(raw.orders||[]).filter(o=>idMap.has(o.beerId)).map(o=>({...o,id:uuid(),beerId:idMap.get(o.beerId)})),inventory:(raw.inventory||[]).map(i=>({...i,id:uuid()}))};state=normalise(migrated);markDirty();alert('Legacy data loaded. Review it; changes will auto-save to the cloud.');render()}catch(err){alert(`Could not import JSON: ${err.message}`)}}

window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
supabase.auth.onAuthStateChange((event,session)=>{if(event==='PASSWORD_RECOVERY'){passwordRecoveryMode=true;user=session?.user||null;showResetPassword();return}if(!session&&!passwordRecoveryMode&&!$('#app-view').classList.contains('hidden'))showAuth()});

await loadSnapshots().catch(()=>{});
await initSession();

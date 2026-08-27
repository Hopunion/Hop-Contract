import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const APP_VERSION='0.8';
const PACKAGES = [
  { key: 'can440', label: 'Can — 440 mL', litres: 0.44 },
  { key: 'can330', label: 'Can — 330 mL', litres: 0.33 },
  { key: 'keg30', label: 'Keg — 30 L', litres: 30 },
  { key: 'keg50', label: 'Keg — 50 L', litres: 50 },
  { key: 'cask20', label: 'Cask — 20 L', litres: 20 },
  { key: 'cask40', label: 'Cask — 40 L', litres: 40 }
];

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

const HOP_FORMATS = ['HyperBoost Oil','HyperBoost','T90','T45','Cryo','Incognito','Spectrum','Oil'];

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

function beerBaseForecastHl(beer) {
  if (!beer || beer.active === false) return 0;
  if (beer.forecastType === 'monthly') return Math.max(0, num(beer.monthlyHl) * 12);
  if (beer.forecastType === 'oneoff') return Math.max(0, num(beer.oneOffHl));
  return Math.max(0, num(beer.last12Hl) * (1 + Math.max(-100, num(beer.growthPct)) / 100));
}

function recipeRates(beer) {
  const rates = {};
  const batch = Math.max(num(beer?.batchHl), 0.0001);
  for (const hop of beer?.hops || []) {
    const variety = String(hop.variety || '').trim();
    if (!variety) continue;
    rates[variety] = (rates[variety] || 0) + num(hop.kgPerBrew) / batch;
  }
  return rates;
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
  const inventory = new Map((state.inventory || []).filter(i => String(i.variety || '').trim()).map(i => [String(i.variety).trim(), i]));
  const beers = (state.beers || []).filter(b => b.active !== false);
  const orders = (state.orders || []).filter(o => o.status !== 'cancelled');
  const globalBuffer = Math.max(0, num(state.settings?.bufferPct));
  const globalRound = Math.max(0, num(state.settings?.globalRoundingKg));

  const ensure = variety => rows[variety] ||= { variety, baseDemand: 0, currentOrder: 0, nextOrder: 0 };

  for (const beer of beers) {
    const rates = recipeRates(beer);
    const baseHl = beerBaseForecastHl(beer);
    const beerOrders = orders.filter(o => o.beerId === beer.id);
    const currentHl = beerOrders.reduce((s,o) => s + unitsToHl(Math.max(0, num(o.confirmedUnits) - num(o.fulfilledUnits)), o.packageKey, o.unitSizeL), 0);
    const nextHl = beerOrders.reduce((s,o) => s + unitsToHl(o.likelyRepeatUnits, o.packageKey, o.unitSizeL), 0);
    for (const [variety, kgPerHl] of Object.entries(rates)) {
      const row = ensure(variety);
      row.baseDemand += baseHl * kgPerHl;
      row.currentOrder += currentHl * kgPerHl;
      row.nextOrder += nextHl * kgPerHl;
    }
  }

  for (const variety of inventory.keys()) ensure(variety);

  return Object.values(rows).map(row => {
    const item = inventory.get(row.variety) || {};
    const stockKg = Math.max(0, num(item.stockKg));
    const contractKg = Math.max(0, num(item.contractKg));
    const expectedUseKg = Math.max(0, num(item.expectedUseKg));
    const availableNow = stockKg + contractKg;
    const committedBeforeContract = expectedUseKg + row.currentOrder;
    const currentShortfall = Math.max(0, committedBeforeContract - availableNow);
    const carryover = Math.max(0, availableNow - committedBeforeContract);
    const nextGross = row.baseDemand + row.nextOrder;
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
    return {
      ...row,
      stockKg, contractKg, expectedUseKg, availableNow, committedBeforeContract,
      currentShortfall, carryover, nextGross, bufferPct, buffer, netRaw,
      increment, minContractKg: minimum, calculated, manualContractKg: manual,
      recommended, priceKg, cost: recommended * priceKg,
      status: currentShortfall > 0 ? 'shortfall' : recommended > 0 ? 'contract' : 'covered'
    };
  }).sort((a,b) => b.recommended - a.recommended || a.variety.localeCompare(b.variety));
}

function totals(rows) {
  return rows.reduce((a,r) => {
    a.baseDemand += r.baseDemand;
    a.nextOrder += r.nextOrder;
    a.currentOrder += r.currentOrder;
    a.expectedUseKg += r.expectedUseKg;
    a.carryover += r.carryover;
    a.recommended += r.recommended;
    a.currentShortfall += r.currentShortfall;
    a.cost += r.cost;
    return a;
  }, {baseDemand:0,nextOrder:0,currentOrder:0,expectedUseKg:0,carryover:0,recommended:0,currentShortfall:0,cost:0});
}


const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = s => document.querySelector(s);
const uuid = () => crypto.randomUUID();
const fmt = (v,dp=1) => num(v).toLocaleString('en-GB',{minimumFractionDigits:dp,maximumFractionDigits:dp});
const money = v => num(v).toLocaleString('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0});
const esc = v => String(v ?? '').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const today = () => new Date().toISOString().slice(0,10);
const currentYear = new Date().getFullYear();
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||''));
const defaultState = () => ({version:APP_VERSION,settings:{currentYear,forecastYear:currentYear+1,asOfDate:today(),bufferPct:5,globalRoundingKg:5},beers:[],orders:[],inventory:[]});

let state = defaultState();
let page = 'dashboard';
let editingBeerId = null;
let dirty = false;
let readOnly = false;
let user = null;
let lockOwned = false;
let heartbeatTimer = null;
let snapshots = [];
let calc = {beerId:'',packageKey:'cask40',units:600};
let inventoryFocusVariety = '';
let inventorySortKey = 'name';
let inventorySortDir = 'asc';
const sessionId = uuid();

const pageMeta = {
  dashboard:['Dashboard','Next-contract view of demand, stock and commitments.'],
  beers:['Beers & recipes','One line per beer; open a beer to edit the full hop recipe.'],
  production:['12-month forecast','Set each beer as Core, Seasonal, Monthly / fixed or One-off.'],
  orders:['Orders & calculator','Convert cans, kegs and casks into hL and exact hop requirements.'],
  inventory:['Hop inventory','Current stock, current contract and the quantities available for the next contract.'],
  settings:['Settings','Forecast year, safety buffer and contract rounding assumptions.'],
  data:['Data & backup','Cloud saves, snapshots, JSON export and legacy import.']
};

function normalise(input={}) {
  const base = defaultState();
  const s = {...base,...input,version:APP_VERSION,settings:{...base.settings,...(input.settings||{})}};
  s.beers = Array.isArray(input.beers) ? input.beers.map(b=>({
    id:isUuid(b.id)?b.id:uuid(), name:b.name||'Unnamed beer', batchHl:Math.max(.01,num(b.batchHl)||21), active:b.active!==false,
    forecastType:['core','seasonal','monthly','oneoff'].includes(b.forecastType)?b.forecastType:'core',
    last12Hl:Math.max(0,num(b.last12Hl)),growthPct:Math.max(-100,num(b.growthPct)),monthlyHl:Math.max(0,num(b.monthlyHl)),oneOffHl:Math.max(0,num(b.oneOffHl)),notes:b.notes||'',
    hops:Array.isArray(b.hops)?b.hops.map(h=>({id:isUuid(h.id)?h.id:uuid(),variety:h.variety||'',kgPerBrew:Math.max(0,num(h.kgPerBrew)),additionStage:h.additionStage||'',notes:h.notes||''})):[]
  })) : [];
  const beerIds = new Set(s.beers.map(b=>b.id));
  s.orders = Array.isArray(input.orders) ? input.orders.filter(o=>beerIds.has(o.beerId)).map(o=>({
    id:isUuid(o.id)?o.id:uuid(),name:o.name||'Customer order',customerName:o.customerName||'',beerId:o.beerId,
    packageKey:[...PACKAGES.map(p=>p.key),'custom'].includes(o.packageKey)?o.packageKey:'cask40',unitSizeL:Math.max(.001,num(o.unitSizeL)||40),
    confirmedUnits:Math.max(0,Math.round(num(o.confirmedUnits))),fulfilledUnits:Math.max(0,Math.round(num(o.fulfilledUnits))),likelyRepeatUnits:Math.max(0,Math.round(num(o.likelyRepeatUnits))),
    status:['draft','provisional','confirmed','completed','cancelled'].includes(o.status)?o.status:'confirmed',deliveryDate:o.deliveryDate||'',notes:o.notes||''
  })) : [];
  s.inventory = Array.isArray(input.inventory) ? input.inventory.map(i=>({
    id:isUuid(i.id)?i.id:uuid(),variety:i.variety||'',stockKg:Math.max(0,num(i.stockKg)),contractKg:Math.max(0,num(i.contractKg)),expectedUseKg:Math.max(0,num(i.expectedUseKg)),
    priceKg:Math.max(0,num(i.priceKg)),roundingKg:Math.max(.01,num(i.roundingKg)||num(s.settings.globalRoundingKg)||1),minContractKg:Math.max(0,num(i.minContractKg)),
    manualContractKg:i.manualContractKg===null||i.manualContractKg===undefined||i.manualContractKg===''?'':Math.max(0,num(i.manualContractKg)),safetyStockPct:Math.max(0,num(i.safetyStockPct)),
    cropYear:i.cropYear||'',supplier:i.supplier||'',notes:i.notes||''
  })) : [];
  return s;
}

function markDirty() { if(readOnly)return; dirty=true; updateTopStatus(); }
function updateTopStatus(){
  $('#dirty-label').classList.toggle('hidden',!dirty);
  $('#save-btn').disabled=readOnly||!dirty;
  $('#cloud-status').textContent=readOnly?'Cloud · read-only':dirty?'Cloud · unsaved':'Cloud · saved';
}

async function loadCloud(){
  const {data,error}=await supabase.rpc('get_forecast_state');
  if(error) throw error;
  state=normalise(data||{}); dirty=false; editingBeerId=null; render(); updateTopStatus();
}
async function saveCloud(){
  if(readOnly) return alert('This session is read-only because another user owns the editing lock.');
  const {data:lock,error:lockError}=await supabase.from('edit_locks').select('session_id,user_email,heartbeat_at').eq('lock_key','global').maybeSingle();
  if(lockError){alert(`Could not verify editing lock: ${lockError.message}`);return;}
  if(!lock || lock.session_id!==sessionId){
    lockOwned=false; readOnly=true; render(); updateTopStatus();
    $('#lock-banner').textContent=`Editing lock lost${lock?.user_email?` to ${lock.user_email}`:''}. Reopen or take over editing before saving.`;
    $('#lock-banner').classList.remove('hidden');
    alert('Your changes have not been saved because another session now owns the editing lock.');
    return;
  }
  $('#save-btn').disabled=true; $('#save-btn').textContent='Saving…';
  const payload=normalise(state);
  const {error}=await supabase.rpc('save_forecast_state',{payload});
  $('#save-btn').textContent='Save to cloud';
  if(error){updateTopStatus();alert(`Save failed: ${error.message}`);return;}
  state=payload;dirty=false;await loadSnapshots();updateTopStatus();
}

async function loadSnapshots(){
  const {data,error}=await supabase.from('forecast_snapshots').select('id,name,created_at,created_by,snapshot').order('created_at',{ascending:false}).limit(30);
  snapshots=error?[]:(data||[]);
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

async function initSession(){
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){showAuth();return}
  user=session.user;showApp();await loadCloud();await loadSnapshots();await acquireLock(false);render();updateTopStatus();
}
function showAuth(){ $('#auth-view').classList.remove('hidden');$('#app-view').classList.add('hidden') }
function showApp(){ $('#auth-view').classList.add('hidden');$('#app-view').classList.remove('hidden');$('#user-email').textContent=user?.email||'' }

$('#auth-form').addEventListener('submit',async e=>{e.preventDefault();const email=$('#auth-email').value.trim(),password=$('#auth-password').value;$('#auth-message').textContent='Signing in…';const {data,error}=await supabase.auth.signInWithPassword({email,password});if(error){$('#auth-message').textContent=error.message;return}user=data.user;$('#auth-message').textContent='';showApp();await loadCloud();await loadSnapshots();await acquireLock();render()});
$('#sign-up-btn').addEventListener('click',async()=>{const email=$('#auth-email').value.trim(),password=$('#auth-password').value;if(!email||password.length<6){$('#auth-message').textContent='Enter an email and password of at least 6 characters.';return}$('#auth-message').textContent='Creating account…';const {data,error}=await supabase.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin}});if(error){$('#auth-message').textContent=error.message;return}if(data.session){user=data.user;showApp();await loadCloud();await loadSnapshots();await acquireLock();render()}else $('#auth-message').textContent='Account created. Check your email to confirm the address, then sign in.'});
$('#sign-out-btn').addEventListener('click',async()=>{if(dirty&&!confirm('You have unsaved changes. Sign out anyway?'))return;await releaseLock();await supabase.auth.signOut();user=null;showAuth()});
$('#save-btn').addEventListener('click',saveCloud);
$('#reload-btn').addEventListener('click',async()=>{if(dirty&&!confirm('Discard unsaved changes and reload the cloud version?'))return;await loadCloud()});
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
  if(page==='inventory')content.innerHTML=renderInventory();
  if(page==='settings')content.innerHTML=renderSettings();
  if(page==='data')content.innerHTML=renderData();
  if(readOnly) content.querySelectorAll('input,select,textarea').forEach(x=>x.disabled=true);
  updateTopStatus();
}

function forecastTypeLabel(t){return ({core:'Core',seasonal:'Seasonal',monthly:'Monthly / fixed',oneoff:'One-off'})[t]||'Core'}
function forecastBasis(b){if(b.forecastType==='monthly')return `${fmt(b.monthlyHl)} hL/month × 12`;if(b.forecastType==='oneoff')return `${fmt(b.oneOffHl)} hL explicit`;return `${fmt(b.last12Hl)} hL ${num(b.growthPct)>=0?'+':''}${fmt(b.growthPct)}%`}
function beerOptions(selected=''){return `<option value="">Select beer…</option>`+state.beers.filter(b=>b.active!==false).map(b=>`<option value="${b.id}" ${b.id===selected?'selected':''}>${esc(b.name)}</option>`).join('')}
function packageOptions(selected){return PACKAGES.map(p=>`<option value="${p.key}" ${p.key===selected?'selected':''}>${esc(p.label)}</option>`).join('')}
function orderHlForBeer(beerId,next=false){return state.orders.filter(o=>o.beerId===beerId&&o.status!=='cancelled').reduce((s,o)=>s+unitsToHl(next?o.likelyRepeatUnits:Math.max(0,num(o.confirmedUnits)-num(o.fulfilledUnits)),o.packageKey,o.unitSizeL),0)}

function recipeHopButtons(beer){
  const hops=(beer?.hops||[]).filter(h=>String(h.variety||'').trim());
  if(!hops.length)return '<span class="muted">No hops</span>';
  return `<div class="recipe-summary">${hops.map(h=>{
    const product=splitHopProduct(h.variety);
    return `<button type="button" class="hop-link" data-action="go-hop" data-hop="${esc(h.variety)}" title="Open ${esc(h.variety)} in Hop inventory"><span class="hop-variety">${esc(product.variety)}</span>${product.format?`<span class="hop-format">${esc(product.format)}</span>`:''}<span class="hop-qty">${fmt(h.kgPerBrew,2)} kg</span></button>`;
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
  if(key==='contractKg') return num(item.contractKg);
  if(key==='expectedUseKg') return num(item.expectedUseKg);
  if(key==='carryover') return num(row?.carryover);
  if(key==='nextGross') return num(row?.nextGross);
  if(key==='calculated') return num(row?.calculated);
  if(key==='recommended') return num(row?.recommended);
  if(key==='priceKg') return num(item.priceKg);
  return '';
}

function sortedInventory(rowsByVariety){
  const dir=inventorySortDir==='desc'?-1:1;
  return [...state.inventory].sort((a,b)=>{
    const av=inventorySortValue(a,rowsByVariety.get(a.variety),inventorySortKey);
    const bv=inventorySortValue(b,rowsByVariety.get(b.variety),inventorySortKey);
    if(typeof av==='number' && typeof bv==='number') return (av-bv)*dir;
    return String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'})*dir;
  });
}

function jumpToInventoryHop(variety){
  inventoryFocusVariety=String(variety||'').trim();
  page='inventory';
  editingBeerId=null;
  render();
  requestAnimationFrame(()=>{
    const row=[...document.querySelectorAll('[data-inv-variety]')].find(x=>x.dataset.invVariety===inventoryFocusVariety);
    if(row){
      row.scrollIntoView({behavior:'smooth',block:'center'});
      row.classList.add('inventory-target');
      setTimeout(()=>row.classList.remove('inventory-target'),2600);
      const input=row.querySelector('[data-inv-field="stockKg"]');
      if(input) input.focus({preventScroll:true});
    }
  });
}

function renderDashboard(){
  const rows=calculateForecast(state),t=totals(rows);const totalBeer=state.beers.filter(b=>b.active!==false).reduce((s,b)=>s+beerBaseForecastHl(b)+orderHlForBeer(b.id,true),0);
  return `${rows.some(r=>r.currentShortfall>0)?`<div class="notice bad"><strong>Current shortfall:</strong> ${fmt(t.currentShortfall)} kg of hop demand is not covered by current stock + contract.</div>`:''}
  <div class="grid metrics">
    <div class="card"><div class="metric-label">${esc(state.settings.forecastYear)} beer forecast</div><div class="metric-value">${fmt(totalBeer)} hL</div></div>
    <div class="card"><div class="metric-label">Base hop demand</div><div class="metric-value">${fmt(t.baseDemand)} kg</div></div>
    <div class="card"><div class="metric-label">Recommended new contract</div><div class="metric-value ${t.recommended?'warn-text':'good'}">${fmt(t.recommended)} kg</div></div>
    <div class="card"><div class="metric-label">Estimated contract value</div><div class="metric-value">${money(t.cost)}</div></div>
  </div>
  <div class="section-head"><div><h2>Hop contract recommendation</h2><p>Next-year demand + repeat commitments + buffer − projected carryover.</p></div></div>
  ${rows.length?`<div class="table-wrap"><table><thead><tr><th>Hop</th><th>Base next year</th><th>Repeat orders</th><th>Stock</th><th>Contract left</th><th>Use before new contract</th><th>Current orders</th><th>Carryover</th><th>Buffer</th><th>Calculated</th><th>Final contract</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.variety)}</strong></td><td>${fmt(r.baseDemand)}</td><td>${fmt(r.nextOrder)}</td><td>${fmt(r.stockKg)}</td><td>${fmt(r.contractKg)}</td><td>${fmt(r.expectedUseKg)}</td><td>${fmt(r.currentOrder)}</td><td>${fmt(r.carryover)}</td><td>${fmt(r.buffer)}</td><td>${fmt(r.calculated)}</td><td><strong>${fmt(r.recommended)}</strong></td><td><span class="pill ${r.status==='covered'?'good':r.status==='shortfall'?'bad':'warn'}">${r.status==='covered'?'Covered':r.status==='shortfall'?'Current shortfall':'Contract'}</span></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">Add beers and recipes to start the forecast.</div>`}
  <div class="section-head"><div><h2>Beer forecast</h2><p>The volume assumptions driving hop demand.</p></div></div>
  ${state.beers.length?`<div class="table-wrap"><table><thead><tr><th>Beer</th><th>Type</th><th>Basis</th><th>Base hL</th><th>Likely repeat hL</th><th>Total hL</th></tr></thead><tbody>${state.beers.map(b=>{const base=beerBaseForecastHl(b),rep=orderHlForBeer(b.id,true);return `<tr><td><strong>${esc(b.name)}</strong></td><td>${forecastTypeLabel(b.forecastType)}</td><td>${esc(forecastBasis(b))}</td><td>${fmt(base)}</td><td>${fmt(rep)}</td><td><strong>${fmt(base+rep)}</strong></td></tr>`}).join('')}</tbody></table></div>`:''}`;
}

function renderBeers(){
  return `<div class="section-head"><div><h2>Beer register</h2><p>Recipes are stored as kg per standard brew and automatically converted to kg/hL. Click any hop to open it in inventory.</p></div><button class="btn primary" data-action="add-beer">Add beer</button></div>
  ${state.beers.length?`<div class="table-wrap"><table><thead><tr><th>Beer</th><th>Type</th><th>Standard brew</th><th>Forecast basis</th><th>${esc(state.settings.forecastYear)} forecast</th><th>Hop recipe</th><th>Status</th><th></th></tr></thead><tbody>${state.beers.map(b=>`<tr><td><strong>${esc(b.name)}</strong></td><td>${forecastTypeLabel(b.forecastType)}</td><td>${fmt(b.batchHl)} hL</td><td>${esc(forecastBasis(b))}</td><td><strong>${fmt(beerBaseForecastHl(b))} hL</strong></td><td>${recipeHopButtons(b)}</td><td><span class="pill ${b.active?'good':'warn'}">${b.active?'Active':'Inactive'}</span></td><td><button class="btn small" data-action="edit-beer" data-id="${b.id}">View / edit</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No beers yet. Add the first beer and recipe.</div>`}`;
}
function renderBeerEditor(){
  const b=state.beers.find(x=>x.id===editingBeerId);if(!b){editingBeerId=null;return renderBeers()}
  const total=(b.hops||[]).reduce((s,h)=>s+num(h.kgPerBrew),0);
  return `<div class="editor"><div class="section-head"><div><button class="btn small" data-action="back-beers">← Back</button><h2 style="margin-top:12px">${esc(b.name)}</h2><p>${fmt(total,2)} kg hops / ${fmt(b.batchHl)} hL = ${fmt(total/Math.max(.001,num(b.batchHl)),3)} kg/hL</p></div></div>
  <div class="card"><div class="form-grid"><div class="field"><label>Beer name</label><input data-beer-field="name" value="${esc(b.name)}"></div><div class="field"><label>Standard brew hL</label><input type="number" min="0.01" step="0.1" data-beer-field="batchHl" value="${num(b.batchHl)}"></div><div class="field"><label>Active</label><select data-beer-field="active"><option value="true" ${b.active?'selected':''}>Active</option><option value="false" ${!b.active?'selected':''}>Inactive</option></select></div></div><div class="field" style="margin-top:12px"><label>Notes</label><textarea data-beer-field="notes">${esc(b.notes)}</textarea></div></div>
  <div class="section-head"><div><h3>Hop recipe</h3><p>Each variety + format is a separate quantity line, e.g. Citra / T45 and Citra / T90.</p></div><button class="btn primary small" data-action="add-hop">Add hop</button></div>
  ${hopFormatOptions()}
  <div class="card">${b.hops.length?b.hops.map(h=>{const product=splitHopProduct(h.variety);return `<div class="hop-row hop-row-v08" data-hop-id="${h.id}"><div class="field"><label>Variety</label><input data-hop-product-part="variety" value="${esc(product.variety)}" placeholder="Citra"></div><div class="field"><label>Format</label><input list="hop-format-options" data-hop-product-part="format" value="${esc(product.format)}" placeholder="T90"></div><div class="field"><label>kg per brew</label><input type="number" min="0" step="0.01" data-hop-field="kgPerBrew" value="${num(h.kgPerBrew)}"></div><button class="btn danger small" data-action="delete-hop" data-id="${h.id}">Remove</button></div>`}).join(''):`<div class="empty">No hops in this recipe yet.</div>`}</div>
  <div class="section-head"><div><h3>Beer record</h3></div><button class="btn danger" data-action="delete-beer" data-id="${b.id}">Delete beer</button></div></div>`;
}

function renderProduction(){
  return `<div class="notice"><strong>Fast workflow:</strong> use ChatGPT separately to total the hL brewed for each beer over the previous 12 months, then paste those numbers here.</div>
  ${state.beers.length?`<div class="table-wrap"><table><thead><tr><th>Beer</th><th>Forecast type</th><th>Last 12m hL</th><th>Increase / decrease %</th><th>Monthly fixed hL</th><th>One-off hL</th><th>Base ${esc(state.settings.forecastYear)} hL</th><th>Repeat orders hL</th><th>Total hL</th></tr></thead><tbody>${state.beers.map(b=>{const base=beerBaseForecastHl(b),rep=orderHlForBeer(b.id,true);return `<tr data-beer-id="${b.id}"><td><strong>${esc(b.name)}</strong></td><td><select data-row-field="forecastType"><option value="core" ${b.forecastType==='core'?'selected':''}>Core</option><option value="seasonal" ${b.forecastType==='seasonal'?'selected':''}>Seasonal</option><option value="monthly" ${b.forecastType==='monthly'?'selected':''}>Monthly / fixed</option><option value="oneoff" ${b.forecastType==='oneoff'?'selected':''}>One-off</option></select></td><td><input type="number" min="0" step="0.1" data-row-field="last12Hl" value="${num(b.last12Hl)}" ${['monthly','oneoff'].includes(b.forecastType)?'disabled':''}></td><td><input type="number" min="-100" step="0.5" data-row-field="growthPct" value="${num(b.growthPct)}" ${['monthly','oneoff'].includes(b.forecastType)?'disabled':''}></td><td><input type="number" min="0" step="0.1" data-row-field="monthlyHl" value="${num(b.monthlyHl)}" ${b.forecastType==='monthly'?'':'disabled'}></td><td><input type="number" min="0" step="0.1" data-row-field="oneOffHl" value="${num(b.oneOffHl)}" ${b.forecastType==='oneoff'?'':'disabled'}></td><td><strong>${fmt(base)}</strong></td><td>${fmt(rep)}</td><td><strong>${fmt(base+rep)}</strong></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add beers before entering production forecasts.</div>`}`;
}

function renderOrders(){
  const b=state.beers.find(x=>x.id===calc.beerId);const hl=unitsToHl(calc.units,calc.packageKey);const breakdown=b?Object.entries(recipeRates(b)).map(([v,r])=>({v,kg:r*hl})):[];
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">One-off packaging calculator</h2><p class="help">Does not affect the forecast unless you save it as an order.</p><div class="form-grid"><div class="field"><label>Beer</label><select id="calc-beer">${beerOptions(calc.beerId)}</select></div><div class="field"><label>Package</label><select id="calc-package">${packageOptions(calc.packageKey)}</select></div><div class="field"><label>Units</label><input id="calc-units" type="number" min="0" step="1" value="${num(calc.units)}"></div></div><div class="calc-result" style="margin-top:14px"><strong>${fmt(hl)} hL</strong> · ${b?`${fmt(hl/Math.max(.001,num(b.batchHl)),2)} standard brews`:'select a beer'}${breakdown.length?`<div style="margin-top:8px">${breakdown.map(x=>`${esc(x.v)} <strong>${fmt(x.kg,2)} kg</strong>`).join(' · ')}</div>`:''}</div><button class="btn primary" style="margin-top:12px" data-action="calc-save" ${!b?'disabled':''}>Save as customer order</button></div>
  <div class="card"><h2 style="margin-top:0">Forecast treatment</h2><p><strong>Confirmed units remaining</strong> are deducted from stock/current contract now.</p><p><strong>Likely repeat units</strong> are added to next year's hop requirement.</p><p>This means a 600-cask customer contract never becomes recurring demand unless you explicitly enter a likely repeat quantity.</p></div></div>
  <div class="section-head"><div><h2>Saved customer orders</h2></div><button class="btn" data-action="add-order" ${state.beers.length?'':'disabled'}>Add blank order</button></div>
  ${state.orders.length?`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Beer</th><th>Package</th><th>Confirmed units</th><th>Fulfilled</th><th>Remaining hL</th><th>Likely repeat units</th><th>Repeat hL</th><th>Status</th><th></th></tr></thead><tbody>${state.orders.map(o=>`<tr data-order-id="${o.id}"><td><input data-order-field="name" value="${esc(o.name)}"></td><td><select data-order-field="beerId">${beerOptions(o.beerId)}</select></td><td><select data-order-field="packageKey">${packageOptions(o.packageKey)}</select></td><td><input type="number" min="0" step="1" data-order-field="confirmedUnits" value="${num(o.confirmedUnits)}"></td><td><input type="number" min="0" step="1" data-order-field="fulfilledUnits" value="${num(o.fulfilledUnits)}"></td><td>${fmt(unitsToHl(Math.max(0,num(o.confirmedUnits)-num(o.fulfilledUnits)),o.packageKey,o.unitSizeL))}</td><td><input type="number" min="0" step="1" data-order-field="likelyRepeatUnits" value="${num(o.likelyRepeatUnits)}"></td><td>${fmt(unitsToHl(o.likelyRepeatUnits,o.packageKey,o.unitSizeL))}</td><td><select data-order-field="status"><option value="confirmed" ${o.status==='confirmed'?'selected':''}>Confirmed</option><option value="provisional" ${o.status==='provisional'?'selected':''}>Provisional</option><option value="completed" ${o.status==='completed'?'selected':''}>Completed</option><option value="cancelled" ${o.status==='cancelled'?'selected':''}>Cancelled</option></select></td><td><button class="btn danger small" data-action="delete-order" data-id="${o.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No saved customer orders.</div>`}`;
}

function renderInventory(){
  const rows=calculateForecast(state),by=new Map(rows.map(r=>[r.variety,r]));
  const items=sortedInventory(by);
  const focusExists=inventoryFocusVariety && state.inventory.some(i=>i.variety===inventoryFocusVariety);
  const jumpNote=inventoryFocusVariety
    ? focusExists
      ? `<div class="notice inventory-jump-note"><strong>${esc(inventoryFocusVariety)}</strong> opened from a beer recipe.</div>`
      : `<div class="notice warn inventory-jump-note"><strong>${esc(inventoryFocusVariety)}</strong> is used in a beer recipe but does not yet have an inventory line. Add the hop below to track its quantity.</div>`
    : '';
  return `${jumpNote}<div class="notice"><strong>One line = one variety + format.</strong> Citra T90, Citra T45 and Citra HyperBoost Oil are separate quantity lines, but stay visually grouped by variety when sorted by name. Current stock + current contract remaining are your starting availability.</div>
  <div class="section-head"><div><h2>Hop stock & contract</h2><p>Click a column heading to sort; click again to reverse the order.</p></div><button class="btn primary" data-action="add-inventory">Add hop</button></div>
  ${hopFormatOptions()}
  ${state.inventory.length?`<div class="table-wrap"><table><thead><tr>
    <th>${inventorySortHeader('Variety','name')}</th>
    <th>${inventorySortHeader('Format','format')}</th>
    <th>${inventorySortHeader('Stock kg','stockKg')}</th>
    <th>${inventorySortHeader('Contract left kg','contractKg')}</th>
    <th>${inventorySortHeader('Use before new contract kg','expectedUseKg')}</th>
    <th>${inventorySortHeader('Projected carryover','carryover')}</th>
    <th>${inventorySortHeader('Next-year gross','nextGross')}</th>
    <th>Min contract</th><th>Round to</th>
    <th>${inventorySortHeader('Calculated','calculated')}</th>
    <th>${inventorySortHeader('Final contract','recommended')}</th>
    <th>${inventorySortHeader('£/kg','priceKg')}</th><th></th>
  </tr></thead><tbody>${items.map(i=>{const r=by.get(i.variety)||{};const focused=i.variety===inventoryFocusVariety;const product=splitHopProduct(i.variety);return `<tr data-inv-id="${i.id}" data-inv-variety="${esc(i.variety)}" class="${focused?'inventory-target':''}">
    <td><input data-inv-product-part="variety" value="${esc(product.variety)}" placeholder="Citra"></td>
    <td><input list="hop-format-options" data-inv-product-part="format" value="${esc(product.format)}" placeholder="T90"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="stockKg" value="${num(i.stockKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="contractKg" value="${num(i.contractKg)}"></td>
    <td><input type="number" min="0" step="0.1" data-inv-field="expectedUseKg" value="${num(i.expectedUseKg)}"></td>
    <td>${fmt(r.carryover||0)}</td><td>${fmt(r.nextGross||0)}</td>
    <td><input type="number" min="0" step="0.1" data-inv-field="minContractKg" value="${num(i.minContractKg)}"></td>
    <td><input type="number" min="0.01" step="0.1" data-inv-field="roundingKg" value="${num(i.roundingKg)}"></td>
    <td><strong>${fmt(r.calculated||0)}</strong></td>
    <td><input type="number" min="0" step="0.1" placeholder="Auto: ${fmt(r.calculated||0)}" data-inv-field="manualContractKg" value="${i.manualContractKg===''?'':num(i.manualContractKg)}"><div class="help">${i.manualContractKg===''?`Auto ${fmt(r.recommended||0)} kg`:`Manual ${fmt(r.recommended||0)} kg`}</div></td>
    <td><input type="number" min="0" step="0.01" data-inv-field="priceKg" value="${num(i.priceKg)}"></td>
    <td><button class="btn danger small" data-action="delete-inventory" data-id="${i.id}">Delete</button></td></tr>`}).join('')}</tbody></table></div>`:`<div class="empty">Add current hop stock and contract balances.</div>`}`;
}

function renderSettings(){return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Forecast period</h2><div class="form-grid"><div class="field"><label>Current year</label><input type="number" step="1" data-setting="currentYear" value="${num(state.settings.currentYear)}"></div><div class="field"><label>Contract / forecast year</label><input type="number" step="1" data-setting="forecastYear" value="${num(state.settings.forecastYear)}"></div><div class="field"><label>Stock / contract as at</label><input type="date" data-setting="asOfDate" value="${esc(state.settings.asOfDate)}"></div></div></div><div class="card"><h2 style="margin-top:0">Contract assumptions</h2><div class="form-grid"><div class="field"><label>Default safety buffer %</label><input type="number" min="0" step="0.5" data-setting="bufferPct" value="${num(state.settings.bufferPct)}"></div><div class="field"><label>Default rounding kg</label><input type="number" min="0.01" step="0.1" data-setting="globalRoundingKg" value="${num(state.settings.globalRoundingKg)}"></div></div><p class="help">A hop can override these defaults in Hop inventory.</p></div></div><div class="card" style="margin-top:16px"><h2 style="margin-top:0">Calculation</h2><pre>beer hop kg = forecast hL × (hop kg per standard brew ÷ standard brew hL)\n\nprojected carryover = stock + current contract − ordinary use before new contract − confirmed unfulfilled orders\n\nnew contract = next-year beer demand + likely repeat orders + safety buffer − projected carryover</pre></div>`}

function renderData(){
  return `<div class="grid two"><div class="card"><h2 style="margin-top:0">Cloud database</h2><p>Supabase is now the master copy. Each <strong>Save to cloud</strong> creates a snapshot of the previous database state and keeps the latest 30.</p><p><strong>User:</strong> ${esc(user?.email||'')}</p><p><strong>Mode:</strong> ${readOnly?'Read-only':'Editor'}</p><div class="actions"><button class="btn" data-action="export-json">Download JSON backup</button><label class="btn" style="cursor:pointer">Import v0.5 JSON<input id="legacy-file" type="file" accept="application/json,.json" hidden></label><button class="btn" data-action="refresh-snapshots">Refresh snapshots</button></div></div><div class="card"><h2 style="margin-top:0">Database scope</h2><p class="help">Stored as structured rows: beers, hop recipes, inventory, customer orders and app settings. No OneDrive folder or local JSON file is required.</p><p class="help">The browser only needs the public Supabase key; Row Level Security blocks all database access until a user signs in.</p></div></div>
  <div class="section-head"><div><h2>Latest cloud snapshots</h2><p>Automatic pre-save backups; maximum 30.</p></div></div>${snapshots.length?`<div class="table-wrap"><table><thead><tr><th>Snapshot</th><th>Created</th><th></th></tr></thead><tbody>${snapshots.map(s=>`<tr><td>${esc(s.name)}</td><td>${new Date(s.created_at).toLocaleString('en-GB')}</td><td><button class="btn small" data-action="restore-snapshot" data-id="${s.id}">Restore</button></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">No cloud snapshots yet. The first backup appears after the second save.</div>`}`;
}

$('#page-content').addEventListener('click',async e=>{
  const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action;
  const mutating=!['back-beers','export-json','refresh-snapshots','go-hop','inventory-sort'].includes(a)&&a!=='restore-snapshot';if(readOnly&&mutating)return alert('Read-only mode.');
  if(a==='add-beer'){const id=uuid();state.beers.push({id,name:'New beer',batchHl:27,active:true,forecastType:'core',last12Hl:0,growthPct:0,monthlyHl:0,oneOffHl:0,notes:'',hops:[]});editingBeerId=id;markDirty();render()}
  if(a==='edit-beer'){editingBeerId=el.dataset.id;render()}
  if(a==='go-hop'){jumpToInventoryHop(el.dataset.hop)}
  if(a==='inventory-sort'){
    const key=el.dataset.sort;
    if(inventorySortKey===key) inventorySortDir=inventorySortDir==='asc'?'desc':'asc';
    else { inventorySortKey=key; inventorySortDir='asc'; }
    render();
  }
  if(a==='back-beers'){editingBeerId=null;render()}
  if(a==='delete-beer'){if(!confirm('Delete this beer and its saved customer orders?'))return;const id=el.dataset.id;state.beers=state.beers.filter(b=>b.id!==id);state.orders=state.orders.filter(o=>o.beerId!==id);editingBeerId=null;markDirty();render()}
  if(a==='add-hop'){const b=state.beers.find(x=>x.id===editingBeerId);b.hops.push({id:uuid(),variety:'',kgPerBrew:0,additionStage:'',notes:''});markDirty();render()}
  if(a==='delete-hop'){const b=state.beers.find(x=>x.id===editingBeerId);b.hops=b.hops.filter(h=>h.id!==el.dataset.id);markDirty();render()}
  if(a==='add-order'){state.orders.push({id:uuid(),name:'Customer order',customerName:'',beerId:state.beers[0]?.id||'',packageKey:'cask40',unitSizeL:40,confirmedUnits:0,fulfilledUnits:0,likelyRepeatUnits:0,status:'confirmed',deliveryDate:'',notes:''});markDirty();render()}
  if(a==='delete-order'){state.orders=state.orders.filter(o=>o.id!==el.dataset.id);markDirty();render()}
  if(a==='calc-save'){if(!calc.beerId)return;state.orders.push({id:uuid(),name:`${num(calc.units)} × ${packageInfo(calc.packageKey).label}`,customerName:'',beerId:calc.beerId,packageKey:calc.packageKey,unitSizeL:packageInfo(calc.packageKey).litres,confirmedUnits:Math.max(0,Math.round(num(calc.units))),fulfilledUnits:0,likelyRepeatUnits:0,status:'confirmed',deliveryDate:'',notes:''});markDirty();render()}
  if(a==='add-inventory'){state.inventory.push({id:uuid(),variety:'',stockKg:0,contractKg:0,expectedUseKg:0,priceKg:0,roundingKg:num(state.settings.globalRoundingKg)||5,minContractKg:0,manualContractKg:'',safetyStockPct:0,cropYear:'',supplier:'',notes:''});markDirty();render()}
  if(a==='delete-inventory'){state.inventory=state.inventory.filter(i=>i.id!==el.dataset.id);markDirty();render()}
  if(a==='export-json'){download(`hop-contract-backup-${today()}.json`,JSON.stringify(state,null,2),'application/json')}
  if(a==='refresh-snapshots'){await loadSnapshots();render()}
  if(a==='restore-snapshot'){const s=snapshots.find(x=>x.id===el.dataset.id);if(!s)return;if(!confirm('Restore this snapshot? The current cloud state will be backed up first when you save.'))return;state=normalise(s.snapshot);dirty=true;render()}
});

$('#page-content').addEventListener('change',e=>{
  if(readOnly)return;const el=e.target;
  if(el.dataset.beerField){const b=state.beers.find(x=>x.id===editingBeerId);const f=el.dataset.beerField;b[f]=f==='batchHl'?Math.max(.01,num(el.value)):f==='active'?el.value==='true':el.value;markDirty();render()}
  if(el.dataset.hopProductPart){
    const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId);
    const product=splitHopProduct(h.variety);
    product[el.dataset.hopProductPart]=el.value;
    h.variety=hopProductName(product.variety,product.format);
    markDirty();render();
  }
  if(el.dataset.hopField){const row=el.closest('[data-hop-id]'),b=state.beers.find(x=>x.id===editingBeerId),h=b.hops.find(x=>x.id===row.dataset.hopId);h[el.dataset.hopField]=el.dataset.hopField==='kgPerBrew'?Math.max(0,num(el.value)):el.value;markDirty();render()}
  if(el.dataset.rowField){const row=el.closest('[data-beer-id]'),b=state.beers.find(x=>x.id===row.dataset.beerId),f=el.dataset.rowField;b[f]=f==='forecastType'?el.value:f==='growthPct'?Math.max(-100,num(el.value)):Math.max(0,num(el.value));markDirty();render()}
  if(el.dataset.orderField){const row=el.closest('[data-order-id]'),o=state.orders.find(x=>x.id===row.dataset.orderId),f=el.dataset.orderField;o[f]=['confirmedUnits','fulfilledUnits','likelyRepeatUnits'].includes(f)?Math.max(0,Math.round(num(el.value))):el.value;markDirty();render()}
  if(el.dataset.invProductPart){
    const row=el.closest('[data-inv-id]'),i=state.inventory.find(x=>x.id===row.dataset.invId);
    const oldProduct=i.variety;
    const product=splitHopProduct(oldProduct);
    product[el.dataset.invProductPart]=el.value;
    const newProduct=hopProductName(product.variety,product.format);
    i.variety=newProduct;
    // Keep recipe links pointing at the renamed quantity line.
    for(const beer of state.beers) for(const hop of beer.hops||[]) if(hop.variety===oldProduct) hop.variety=newProduct;
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

function download(name,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}
async function importLegacy(file){try{const raw=JSON.parse(await file.text());const old=raw.beers||[];const idMap=new Map(old.map(b=>[b.id,uuid()]));const migrated={...raw,beers:old.map(b=>({...b,id:idMap.get(b.id),hops:(b.hops||[]).map(h=>({...h,id:uuid()}))})),orders:(raw.orders||[]).filter(o=>idMap.has(o.beerId)).map(o=>({...o,id:uuid(),beerId:idMap.get(o.beerId)})),inventory:(raw.inventory||[]).map(i=>({...i,id:uuid()}))};state=normalise(migrated);dirty=true;alert('Legacy data loaded into this browser. Review it, then press Save to cloud.');render()}catch(err){alert(`Could not import JSON: ${err.message}`)}}

window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
supabase.auth.onAuthStateChange((_event,session)=>{if(!session&&!$('#app-view').classList.contains('hidden'))showAuth()});

await loadSnapshots().catch(()=>{});
await initSession();

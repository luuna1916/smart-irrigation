'use strict';
/* =====================================================================
 * Smart Irrigation Demo. Sections:
 *  1 CONFIG   2 ENGINE (pure decision logic, no DOM)   3 ADAPTERS (sim <-> ESP32)
 *  4 SIMULATOR/STATE   5 UI
 * ===================================================================== */

/* ---------- 1 CONFIG (assumed demo values, see README) ---------- */
const CFG = { AREA: 0.25, EFF: 0.9, FLOW: 1.2, TL: 30, MAX_RUN: 20, DAILY_L: 15,
  MIN_OK: 2, MAX_OK: 60, RAIN_STOP: 1, HIST: 150 };
const SOILS = {
  sand: { name: 'Sandy',      fc: 16, wp: 5,  sat: 38, drain: 0.12, maxMm: 6,   soakMin: 10, color: '#d9b97a' },
  loam: { name: 'Loam',       fc: 27, wp: 12, sat: 45, drain: 0.05, maxMm: 4.5, soakMin: 20, color: '#a97c50' },
  clay: { name: 'Clay-rich',  fc: 38, wp: 22, sat: 50, drain: 0.02, maxMm: 3,   soakMin: 30, color: '#7a4f33' }
};
const PLANTS = {
  tomato:  { name: 'Tomato',  kc: 1.1, root: 300, trig: 0.50, tgt: 0.85 },
  lettuce: { name: 'Lettuce', kc: 0.9, root: 200, trig: 0.60, tgt: 0.90 },
  chili:   { name: 'Chili',   kc: 1.0, root: 300, trig: 0.45, tgt: 0.80 },
  aloe:    { name: 'Aloe (drought-tolerant)', kc: 0.4, root: 150, trig: 0.25, tgt: 0.60 }
};
const f = (n, d = 1) => Number(n).toFixed(d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- 2 ENGINE: pure functions ---------- */
const Engine = {
  targets(soil, plant) {
    const s = SOILS[soil], p = PLANTS[plant], aw = s.fc - s.wp;
    return { trigger: s.wp + aw * p.trig, target: s.wp + aw * p.tgt, rootMm: p.root };
  },
  validReading(r) { return r != null && r >= CFG.MIN_OK && r <= CFG.MAX_OK; },
  /* i: {reading, soil, plant, rainNow, forecast, sinceLast, todayL} */
  decide(i) {
    const t = this.targets(i.soil, i.plant), s = SOILS[i.soil];
    if (!this.validReading(i.reading))
      return { action: 'FAULT', liters: 0, deficitMm: 0, effRain: 0, why: ['Sensor reading is outside the valid range (' + CFG.MIN_OK + '-' + CFG.MAX_OK + '%). Irrigation blocked until it is fixed.'] };
    const deficitMm = Math.max(0, (t.target - i.reading) / 100 * t.rootMm);
    const effRain = Math.max(0, i.forecast - 2) * 0.8;
    const why = [`Reading ${f(i.reading)}% | trigger ${f(t.trigger)}% | target ${f(t.target)}%`,
                 `Deficit to target: ${f(deficitMm)} mm; effective forecast rain: ${f(effRain)} mm`];
    const out = (action, liters, msg) => ({ action, liters, deficitMm, effRain, why: [...why, msg] });
    if (i.reading >= t.trigger) return out('WAIT', 0, 'Moisture is above the trigger. No irrigation needed.');
    if (i.rainNow >= CFG.RAIN_STOP) return out('SKIP_RAIN', 0, 'It is raining now. Irrigation paused.');
    if (effRain >= deficitMm * 0.8) return out('SKIP_RAIN', 0, 'Forecast rain should cover the deficit. Waiting for rain first.');
    if (i.todayL >= CFG.DAILY_L) return out('BLOCK', 0, 'Daily water limit reached (' + CFG.DAILY_L + ' L). Blocked for safety.');
    if (i.sinceLast < s.soakMin) return out('SOAK', 0, `Soak pause: ${s.name} soil needs ${s.soakMin} min between cycles (${f(i.sinceLast, 0)} min so far).`);
    const need = (deficitMm - effRain) * CFG.AREA / CFG.EFF;
    const cap = s.maxMm * CFG.AREA / CFG.EFF;
    const liters = Math.max(0.05, Math.min(need, cap, CFG.DAILY_L - i.todayL));
    const capped = liters < need - 1e-6 ? ` Cycle capped at ${f(liters, 2)} L (infiltration/daily limit); more cycles may follow.` : '';
    return out('START', liters, `Below trigger. Plan ${f(liters, 2)} L (estimate).` + capped);
  },
  /* returns a stop reason string, or null to keep running */
  stopReason(c) { // c: {reading, delivered, planL, elapsed, soil, plant, rainNow, todayL}
    const t = this.targets(c.soil, c.plant);
    if (!this.validReading(c.reading)) return 'Sensor fault: stopped for safety';
    if (c.reading >= t.target) return 'Target moisture reached';
    if (c.delivered >= c.planL - 1e-6) return 'Planned volume delivered';
    if (c.elapsed >= CFG.MAX_RUN) return 'Max run time safety limit';
    if (c.rainNow >= CFG.RAIN_STOP) return 'Rain started';
    if (c.todayL >= CFG.DAILY_L) return 'Daily water limit reached';
    return null;
  }
};

/* ---------- 3 ADAPTERS: swap 'sim' for 'esp32' on hardware day ---------- */
const Hardware = {
  mode: 'sim', // 'sim' | 'esp32'
  ESP32_URL: 'http://192.168.1.50', // change to your ESP32 IP
  // Expected: GET /api/status -> {A:{moisture:23.4,flow_lpm:1.18}, B:{...}}
  async readAll() {
    const r = await fetch(this.ESP32_URL + '/api/status'); return r.json();
  },
  // Expected: POST /api/valve {tray:'A', on:true}. ESP32 firmware must ALSO enforce its own hard timeout.
  async setValve(id, on) {
    if (this.mode === 'sim') return;
    await fetch(this.ESP32_URL + '/api/valve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tray: id, on }) });
  }
  // MQTT option: subscribe tray/A/moisture, publish tray/A/valve/set (use mqtt.js over WebSocket).
};

/* ---------- 4 STORAGE API: SQLite-backed history ---------- */
const StorageAPI = {
  lastPersistedAt: 0,
  setStatus(message) {
    const status = document.querySelector('#storageStatus');
    if (status) status.textContent = message;
  },
  async request(path, data) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error(`Storage request failed (${response.status})`);
    return response.json();
  },
  async check() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Storage unavailable');
      this.setStatus('Data saving is on');
    } catch (error) {
      this.setStatus('Data saving is offline');
      console.warn(error);
    }
  },
  saveEvent(tray, message) {
    this.request('/api/events', { event: { tick: S.tick, tray, message } })
      .then(() => this.setStatus('Data saving is on'))
      .catch(error => { this.setStatus('Data saving is offline'); console.warn(error); });
  },
  saveReadings() {
    const now = Date.now();
    if (now - this.lastPersistedAt < 5000) return;
    this.lastPersistedAt = now;
    const readings = all().map(t => ({
      tick: S.tick, tray: t.id, moisture: t.reading, flow: t.flow,
      total_water: t.total, today_water: t.today,
      status: t.running ? 'Irrigating' : (t.decision ? ACT[t.decision.action] : 'Monitoring')
    }));
    this.request('/api/readings', { readings })
      .then(() => this.setStatus('Data saving is on'))
      .catch(error => { this.setStatus('Data saving is offline'); console.warn(error); });
  }
};

/* ---------- 5 SIMULATOR / STATE ---------- */
let S, timer = null, uiBuilt = false;
const all = () => Object.values(S.trays);
function mk(id, soil, plant, m) {
  return { id, soil, plant, moisture: m, reading: m, mode: 'auto', running: false, plan: null, total: 0, today: 0,
    lastEnd: -1e9, fault: false, cycles: 0, skips: 0, lastAction: '', decision: null, flow: 0 };
}
function fresh() {
  return { tick: 0, temp: 28, rainNow: 0, forecast: 0, speed: 5, playing: true, log: [], hist: [],
    trays: { A: mk('A', 'sand', 'tomato', 14), B: mk('B', 'clay', 'tomato', 33) } };
}
function logEv(tray, msg) {
  S.log.unshift({ t: S.tick, tray, msg }); S.log.length = Math.min(S.log.length, 40);
  StorageAPI.saveEvent(tray, msg);
}
function resumeForWatering() {
  if (S.playing) return;
  S.playing = true;
  $('#play').textContent = 'Pause';
  loop();
}
function startIrrigation(t, liters, reason) {
  t.running = true; t.plan = { L: liters, del: 0, start: S.tick }; Hardware.setValve(t.id, true);
  logEv(t.id, `START - plan ${f(liters, 2)} L (est.). ${reason}`);
}
function stopIrrigation(t, why) {
  if (!t.running) return;
  t.running = false; t.flow = 0; t.lastEnd = S.tick; t.cycles++; Hardware.setValve(t.id, false);
  logEv(t.id, `STOP - ${why}. Delivered ${f(t.plan.del, 2)} L (simulated flow).`);
}
function step() {
  S.tick++;
  if (S.tick % 1440 === 0) all().forEach(t => t.today = 0);
  const et0 = Math.max(1, 2 + 0.2 * (S.temp - 15));
  for (const t of all()) {
    const so = SOILS[t.soil], p = PLANTS[t.plant];
    t.moisture -= p.kc * et0 * CFG.TL / 1440 / p.root * 100;           // evapotranspiration (time-lapse)
    if (S.rainNow > 0) {                                                // rain (time-lapse); clay sheds heavy rain
      const e = (S.rainNow > 12 && t.soil === 'clay') ? 0.6 : 0.9;
      t.moisture += S.rainNow / 60 * CFG.TL * e / p.root * 100;
    }
    if (t.running) {                                                    // simulated flow sensor
      const flow = CFG.FLOW * (0.95 + Math.random() * 0.1);
      const l = Math.min(flow, t.plan.L - t.plan.del);
      t.plan.del += l; t.total += l; t.today += l; t.flow = l;
      t.moisture += l * CFG.EFF / CFG.AREA / p.root * 100;
    }
    if (t.moisture > so.fc) t.moisture -= (t.moisture - so.fc) * so.drain;   // drainage
    t.moisture = clamp(t.moisture, 3, so.sat);
    t.reading = t.fault ? 0 : t.moisture + (Math.random() - 0.5) * 0.6;       // simulated capacitive sensor
    if (t.running) {
      const why = Engine.stopReason({ reading: t.reading, delivered: t.plan.del, planL: t.plan.L, elapsed: S.tick - t.plan.start,
        soil: t.soil, plant: t.plant, rainNow: S.rainNow, todayL: t.today });
      if (why) stopIrrigation(t, why);
    }
    if (!t.running) {
      const d = Engine.decide({ reading: t.reading, soil: t.soil, plant: t.plant, rainNow: S.rainNow, forecast: S.forecast,
        sinceLast: S.tick - t.lastEnd, todayL: t.today });
      t.decision = d;
      if (d.action !== t.lastAction) {
        if (d.action === 'SKIP_RAIN') { t.skips++; logEv(t.id, 'SKIP - ' + d.why[2]); }
        if (d.action === 'FAULT' || d.action === 'BLOCK') logEv(t.id, 'BLOCKED - ' + d.why[0]);
        t.lastAction = d.action;
      }
      if (t.mode === 'auto' && d.action === 'START') startIrrigation(t, d.liters, d.why[2]);
    }
  }
  S.hist.push({ tick: S.tick, A: S.trays.A.reading, B: S.trays.B.reading, wA: S.trays.A.total, wB: S.trays.B.total });
  if (S.hist.length > CFG.HIST) S.hist.shift();
  StorageAPI.saveReadings();
  render();
}
function loop() {
  clearInterval(timer);
  if (S.playing) timer = setInterval(() => { for (let i = 0; i < S.speed; i++) step(); }, 1000);
}

/* ---------- Scenarios ---------- */
const SCENARIOS = [
  { n: '1. Dry sand, hot day', d: 'Sandy tray is dry at 34 C. Expect a START with a capped cycle, then a stop at target.',
    set: s => { s.temp = 34; s.trays.A.moisture = 7; s.trays.B.moisture = 34; } },
  { n: '2. Rain forecast skip', d: '28 mm rain is forecast. Both trays are dry but the engine waits instead of watering.',
    set: s => { s.forecast = 28; s.trays.A.moisture = 8; s.trays.B.moisture = 28; } },
  { n: '3. Clay slow-soak', d: 'Clay is dry. Small cycles with long soak pauses avoid runoff.',
    set: s => { s.trays.A.moisture = 14; s.trays.B.moisture = 24; } },
  { n: '4. Rain interrupts watering', d: 'Sandy tray starts, then raise "Rain now" above 1 mm/h and watch it stop.',
    set: s => { s.trays.A.moisture = 6; s.trays.B.moisture = 36; } },
  { n: '5. Sensor fault', d: 'Tray A sensor reads 0%. Irrigation is blocked and an alert appears. Uncheck the fault box to recover.',
    set: s => { s.trays.A.moisture = 8; s.trays.A.fault = true; } },
  { n: '6. Different plants', d: 'Lettuce on sand needs frequent water; aloe on clay needs very little.',
    set: s => { const a = s.trays.A, b = s.trays.B; a.plant = 'lettuce'; a.moisture = 9; b.plant = 'aloe'; b.moisture = 24; } }
];
function loadScenario(i) {
  const keepSpeed = S.speed; S = fresh(); S.speed = keepSpeed; SCENARIOS[i].set(S);
  $('#temp').value = S.temp; $('#rain').value = S.rainNow; $('#fc').value = S.forecast; $('#speed').value = S.speed;
  all().forEach(t => { t.reading = t.moisture; });
  $('#scenInfo').textContent = SCENARIOS[i].d; $('#play').textContent = 'Pause'; syncUI(); loop(); step();
}

/* ---------- 5 UI ---------- */
function $(s, r = document) { return r.querySelector(s); }
const opts = o => Object.entries(o).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
function buildTrays() {
  $('#trays').innerHTML = all().map(t => `
  <article class="card tray" id="t${t.id}">
    <h2>Tray ${t.id}<span class="pill" id="${t.id}st"></span></h2>
    <svg class="tr" viewBox="0 0 220 150" id="${t.id}svg" role="img" aria-label="Top-down view of tray ${t.id} with watering boundary">
      <rect x="6" y="6" width="208" height="138" rx="12" fill="#5b4a3a"/>
      <rect id="${t.id}soil" x="10" y="10" width="200" height="130" rx="9"/>
      <rect id="${t.id}wet" x="10" y="10" width="200" height="130" rx="9" fill="#2a7fa8"/>
      <rect x="24" y="24" width="172" height="102" rx="6" fill="none" stroke="#2f5d3a" stroke-width="2.5" stroke-dasharray="8 5"/>
      <text x="110" y="21" font-size="8" text-anchor="middle" fill="#2f5d3a">permitted watering boundary</text>
      <g fill="#4f8a3c" stroke="#2f5d3a">${[0, 1, 2].map(i => [0, 1].map(j => `<circle cx="${80 + i * 45}" cy="${55 + j * 45}" r="9"/>`).join('')).join('')}</g>
      <g id="${t.id}g"><path class="spray" d="M74 30 A50 50 0 0 1 24 80"/><path class="spray" d="M104 30 A80 80 0 0 1 24 110"/></g>
      <circle cx="24" cy="24" r="7" fill="#2a7fa8" stroke="#fff" stroke-width="2"/>
    </svg>
    <div class="sel">
      <label>Soil<select id="${t.id}soilSel">${opts(SOILS)}</select></label>
      <label>Plant<select id="${t.id}plantSel">${opts(PLANTS)}</select></label>
    </div>
    <label>Simulated moisture sensor (%) <b id="${t.id}mV"></b><input id="${t.id}m" type="range" min="3" max="50" step="0.5"></label>
    <label class="chk"><input type="checkbox" id="${t.id}fault"> Simulate sensor fault</label>
    <div class="stats">
      <div class="stat">Reading (sim)<b id="${t.id}rd"></b></div>
      <div class="stat">Flow (sim)<b id="${t.id}fl"></b></div>
      <div class="stat">Total water (sim)<b id="${t.id}tot"></b></div>
      <div class="stat">Today / limit<b id="${t.id}td"></b></div>
      <div class="stat">Cycles / rain skips<b id="${t.id}cy"></b></div>
      <div class="stat">Plan (estimate)<b id="${t.id}pl"></b></div>
    </div>
    <div class="row wrap">
      <label>Mode<select id="${t.id}mode"><option value="auto">Automatic</option><option value="manual">Manual</option></select></label>
      <button class="btn" id="${t.id}go">Start</button>
      <button class="btn stop" id="${t.id}stop">Stop</button>
    </div>
    <div class="why" id="${t.id}why"></div>
  </article>`).join('');
  all().forEach(t => {
    const id = t.id;
    $(`#${id}soilSel`).onchange = e => { t.soil = e.target.value; step(); };
    $(`#${id}plantSel`).onchange = e => { t.plant = e.target.value; step(); };
    $(`#${id}m`).oninput = e => { t.moisture = +e.target.value; t.reading = t.fault ? 0 : t.moisture; render(); };
    $(`#${id}fault`).onchange = e => { t.fault = e.target.checked; step(); };
    $(`#${id}mode`).onchange = e => { t.mode = e.target.value; if (t.mode === 'manual' && t.running) logEv(id, 'Switched to manual while running'); render(); };
    $(`#${id}stop`).onclick = () => { stopIrrigation(t, 'Manual stop pressed'); render(); };
    $(`#${id}go`).onclick = () => {
      if (t.running) return;
      const d = Engine.decide({ reading: t.reading, soil: t.soil, plant: t.plant, rainNow: S.rainNow, forecast: 0, sinceLast: 1e9, todayL: t.today });
      if (d.action === 'FAULT' || d.action === 'BLOCK') { logEv(id, 'Manual start refused - ' + d.why[0]); render(); return; }
      const cap = SOILS[t.soil].maxMm * CFG.AREA / CFG.EFF;
      startIrrigation(t, Math.min(cap, CFG.DAILY_L - t.today), 'Manual start (safety limits still apply)'); resumeForWatering(); render();
    };
  });
  uiBuilt = true;
}
const ACT = { START: 'Irrigating', WAIT: 'Moisture OK', SKIP_RAIN: 'Waiting for rain', BLOCK: 'Limit reached', SOAK: 'Soak pause', FAULT: 'Sensor fault' };
function syncUI() {
  all().forEach(t => { const id = t.id;
    $(`#${id}soilSel`).value = t.soil; $(`#${id}plantSel`).value = t.plant; $(`#${id}m`).value = t.moisture;
    $(`#${id}fault`).checked = t.fault; $(`#${id}mode`).value = t.mode; });
}
function render() {
  $('#tempV').textContent = S.temp + ' C'; $('#rainV').textContent = S.rainNow; $('#fcV').textContent = S.forecast;
  $('#dashUsed').textContent = f(all().reduce((sum,t)=>sum+t.total,0),2) + ' L'; $('#dashToday').textContent = f(all().reduce((sum,t)=>sum+t.today,0),1) + ' / 30 L';
  const m = S.tick % 1440; $('#clock').textContent = `Sim day ${Math.floor(S.tick / 1440) + 1}, ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const alerts = [];
  for (const t of all()) {
    const id = t.id, so = SOILS[t.soil], tg = Engine.targets(t.soil, t.plant), d = t.decision;
    $(`#${id}soil`).setAttribute('fill', so.color); $(`#${id}wet`).setAttribute('opacity', clamp((t.moisture - 3) / 60, 0, 0.7));
    $(`#${id}g`).parentNode.classList.toggle('on', t.running); $(`#${id}svg`).classList.toggle('on', t.running);
    const st = $(`#${id}st`), label = t.running ? 'Irrigating' : (d ? ACT[d.action] : 'Idle');
    st.textContent = label + (t.mode === 'manual' ? ' (manual)' : ''); st.className = 'pill' + (t.running ? ' run' : (d && ['FAULT', 'BLOCK'].includes(d.action) ? ' bad' : ''));
    $(`#${id}mV`).textContent = f(t.moisture) + '%'; $(`#${id}m`).value = t.moisture;
    $(`#${id}rd`).textContent = f(t.reading) + '%'; $(`#${id}fl`).textContent = f(t.flow / 1 , 2) + ' L/min';
    $(`#${id}tot`).textContent = f(t.total, 2) + ' L'; $(`#${id}td`).textContent = `${f(t.today, 1)} / ${CFG.DAILY_L} L`;
    $(`#${id}cy`).textContent = `${t.cycles} / ${t.skips}`;
    $(`#${id}pl`).textContent = t.running ? `${f(t.plan.del, 2)} / ${f(t.plan.L, 2)} L` : (d && d.liters ? f(d.liters, 2) + ' L' : '-');
    $(`#${id}go`).disabled = t.running; $(`#${id}stop`).disabled = !t.running;
    const lines = t.running ? [`Running: ${f(t.plan.del, 2)} of ${f(t.plan.L, 2)} L planned. Stops at target ${f(tg.target)}%, max ${CFG.MAX_RUN} min, or on rain/fault.`] : (d ? d.why : []);
    $(`#${id}why`).innerHTML = '<b>Why this decision?</b><ul>' + lines.map(l => `<li>${l}</li>`).join('') + '</ul>';
    if (d && d.action === 'FAULT') alerts.push([1, `Tray ${id}: sensor fault. Irrigation blocked.`]);
    if (d && d.action === 'BLOCK') alerts.push([1, `Tray ${id}: daily water limit reached.`]);
    if (d && d.action === 'SKIP_RAIN') alerts.push([0, `Tray ${id}: watering skipped because of rain/forecast.`]);
    if (t.running) alerts.push([0, `Tray ${id}: irrigating (simulated).`]);
    if (t.reading < tg.trigger * 0.6 && t.reading > CFG.MIN_OK) alerts.push([1, `Tray ${id}: moisture very low.`]);
  }
  $('#decisionCards').innerHTML = all().map(t => { const d=t.decision, tg=Engine.targets(t.soil,t.plant); const lines=t.running?[`Irrigation in progress: ${f(t.plan.del,2)} / ${f(t.plan.L,2)} L.`, `Stops at ${f(tg.target)}% target or a safety limit.`]:(d?d.why:[]); return `<article class="card"><h2>Tray ${t.id} <span class="pill">${d?d.action:'Idle'}</span></h2><p><b>Recommendation:</b> ${lines[2]||lines[0]||'Monitoring conditions.'}</p><p><b>Trigger / target:</b> ${f(tg.trigger)}% / ${f(tg.target)}%</p><ul>${lines.map(x=>`<li>${x}</li>`).join('')}</ul></article>`; }).join('');
  $('#reportWater').textContent = f(all().reduce((sum,t)=>sum+t.total,0),2) + ' L';
  $('#reportCycles').textContent = all().reduce((sum,t)=>sum+t.cycles,0);
  $('#reportSkips').textContent = all().reduce((sum,t)=>sum+t.skips,0);
  $('#reportSamples').textContent = S.hist.length;
  $('#reportTable').innerHTML = '<tr><th>Tray</th><th>Soil / plant</th><th>Moisture</th><th>Trigger / target</th><th>Water today</th><th>Total water</th><th>Status</th></tr>' + all().map(t => { const g=Engine.targets(t.soil,t.plant); return `<tr><td>Tray ${t.id}</td><td>${SOILS[t.soil].name} / ${PLANTS[t.plant].name}</td><td>${f(t.reading)}%</td><td>${f(g.trigger)}% / ${f(g.target)}%</td><td>${f(t.today,2)} L</td><td>${f(t.total,2)} L</td><td>${t.running?'Irrigating':(t.decision?t.decision.action:'Monitoring')}</td></tr>`; }).join('');
  $('#sampleLog').innerHTML = '<tr><th>Sim time</th><th>Tray A moisture</th><th>Tray B moisture</th><th>Tray A water</th><th>Tray B water</th></tr>' + S.hist.slice(-20).reverse().map(p => { const m=p.tick%1440; const time=`Day ${Math.floor(p.tick/1440)+1} ${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; return `<tr><td>${time}</td><td>${f(p.A)}%</td><td>${f(p.B)}%</td><td>${f(p.wA,2)} L</td><td>${f(p.wB,2)} L</td></tr>`; }).join('');
  if (S.temp >= 38) alerts.push([1, 'Heat warning: high evapotranspiration expected.']);
  $('#alerts').innerHTML = alerts.length ? alerts.map(a => `<li class="${a[0] ? 'w' : ''}">${a[1]}</li>`).join('') : '<li>No active alerts.</li>';
  const A = S.trays.A, B = S.trays.B, row = (k, fa, fb) => `<tr><th>${k}</th><td>${fa(A)}</td><td>${fb(B)}</td></tr>`;
  $('#cmp').innerHTML = '<tr><th></th><th>Tray A</th><th>Tray B</th></tr>' + [
    ['Soil / plant', t => `${SOILS[t.soil].name} / ${PLANTS[t.plant].name}`],
    ['Moisture (sim)', t => f(t.reading) + '%'], ['Trigger / target', t => { const g = Engine.targets(t.soil, t.plant); return f(g.trigger) + '% / ' + f(g.target) + '%'; }],
    ['Total water (sim)', t => f(t.total, 2) + ' L'], ['Cycles', t => t.cycles], ['Rain skips', t => t.skips], ['Mode', t => t.mode]
  ].map(r => row(r[0], r[1], r[1])).join('');
  $('#log').innerHTML = '<tr><th>Sim time</th><th>Tray</th><th>Event</th></tr>' + (S.log.length ? S.log.slice(0, 15).map(e =>
    `<tr><td>${String(Math.floor(e.t % 1440 / 60)).padStart(2, '0')}:${String(e.t % 60).padStart(2, '0')}</td><td>${e.tray}</td><td>${e.msg}</td></tr>`).join('') : '<tr><td colspan="3">No irrigation events yet.</td></tr>');
  renderCharts();
}
function renderCharts() {
  const points = S.hist.slice(-36);
  const waterMax = Math.max(1, ...points.map(p => Math.max(p.wA, p.wB))) * 1.1;
  const bars = (keyA, keyB, max) => points.map(p => `<span class="chart-column" title="Minute ${p.tick}: Tray A ${f(p[keyA],2)}, Tray B ${f(p[keyB],2)}"><i class="bar-a" style="height:${clamp(p[keyA] / max * 100, 1, 100)}%"></i><i class="bar-b" style="height:${clamp(p[keyB] / max * 100, 1, 100)}%"></i></span>`).join('');
  $('#c1').innerHTML = bars('A', 'B', 50);
  $('#c2').innerHTML = bars('wA', 'wB', waterMax);
}
function line(cv, series, min, max, dashes = []) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 30; g.clearRect(0, 0, W, H);
  const h = S.hist; if (max == null) max = Math.max(1, ...h.map(p => Math.max(...series.map(s => p[s.k])))) * 1.1;
  const y = v => H - pad - (v - min) / (max - min) * (H - 2 * pad), x = i => pad + i / (CFG.HIST - 1) * (W - pad - 10);
  g.strokeStyle = '#d5e0cc'; g.fillStyle = '#5d6b60'; g.font = '12px system-ui'; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const v = min + (max - min) * k / 4; g.beginPath(); g.moveTo(pad, y(v)); g.lineTo(W - 10, y(v)); g.stroke(); g.fillText(f(v, 0), 2, y(v) + 4); }
  dashes.forEach((v, i) => { g.setLineDash([6, 4]); g.strokeStyle = series[i].c; g.beginPath(); g.moveTo(pad, y(v)); g.lineTo(W - 10, y(v)); g.stroke(); });
  g.setLineDash([]); g.lineWidth = 2.5;
  series.forEach(s => { g.strokeStyle = s.c; g.beginPath(); h.forEach((p, i) => i ? g.lineTo(x(i), y(p[s.k])) : g.moveTo(x(i), y(p[s.k]))); g.stroke(); });
}
function init() {
  const showPage = name => { document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name)); document.querySelectorAll('.nav-link').forEach(b=>b.classList.toggle('active',b.dataset.page===name)); history.replaceState(null,'','#'+name); if (name==='reports' && S) requestAnimationFrame(render); };
  $('#startApp').onclick = () => { $('#welcome').hidden = true; $('#appShell').hidden = false; showPage('dashboard'); window.scrollTo(0,0); };
  document.querySelector('.navbar').onclick = e => { const b=e.target.closest('[data-page]'); if(b) showPage(b.dataset.page); };
  document.querySelector('main').onclick = e => { const b=e.target.closest('[data-go]'); if(b) showPage(b.dataset.go); };
  const initial=location.hash.slice(1); if(initial && document.getElementById('page-'+initial)) showPage(initial);
  S = fresh(); buildTrays(); syncUI(); StorageAPI.check();
  $('#scen').innerHTML = SCENARIOS.map((s, i) => `<button class="btn ghost" data-i="${i}">${s.n}</button>`).join('');
  $('#scen').onclick = e => { if (e.target.dataset.i != null) loadScenario(+e.target.dataset.i); };
  $('#temp').oninput = e => { S.temp = +e.target.value; render(); };
  $('#rain').oninput = e => { S.rainNow = +e.target.value; render(); };
  $('#fc').oninput = e => { S.forecast = +e.target.value; render(); };
  $('#speed').onchange = e => { S.speed = +e.target.value; loop(); };
  $('#play').onclick = e => { S.playing = !S.playing; e.target.textContent = S.playing ? 'Pause' : 'Play'; loop(); };
  $('#stepBtn').onclick = () => { for (let i = 0; i < 10; i++) step(); };
  $('#reset').onclick = () => { S = fresh(); $('#temp').value = 28; $('#rain').value = 0; $('#fc').value = 0; $('#speed').value = 5;
    $('#play').textContent = 'Pause'; $('#scenInfo').textContent = 'Demo reset.'; syncUI(); loop(); step(); };
  step(); loop();
}
document.addEventListener('DOMContentLoaded', init);

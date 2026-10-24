// 1) PASTE YOUR FIREBASE CONFIG HERE (Firebase console > Project settings > Your apps > Web)
const firebaseConfig = {
  apiKey: "AIzaSyD2UMIQTfyCujdeGAnClcz1B2xkjOccNYo",
  authDomain: "sym-security.firebaseapp.com",
  projectId: "sym-security",
  storageBucket: "sym-security.firebasestorage.app",
  messagingSenderId: "715027680832",
  appId: "1:715027680832:web:5e6d4710c5a055242619a5"
};
// 2) PASTE YOUR CLOUDINARY DETAILS HERE (cloud name + an UNSIGNED upload preset)
const CLOUDINARY_CLOUD = "jby85ass";
const CLOUDINARY_PRESET = "guard_patrol";
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth(), db = firebase.firestore();
const $ = id => document.getElementById(id);
const ts = () => firebase.firestore.FieldValue.serverTimestamp();
const fmt = d => (d && d.toDate ? d.toDate() : new Date(d || Date.now())).toLocaleString();
let me = null, unsubs = [];

/* ---------- AUTH ---------- */
function authMsg(e) {
  const m = {
    'auth/invalid-email': 'The email address is not valid. Check for typing mistakes or spaces.',
    'auth/user-not-found': 'No account exists for this email. Ask the admin to create your account.',
    'auth/wrong-password': 'The password is wrong. Try again or ask the admin to reset it.',
    'auth/invalid-credential': 'The email or password is wrong, or this account has not been created in Firebase Authentication yet. Check both, or ask the admin.',
    'auth/user-disabled': 'This account has been disabled. Contact the admin.',
    'auth/too-many-requests': 'Too many failed attempts. Wait a few minutes, then try again.',
    'auth/network-request-failed': 'No internet connection. Check your network and try again.',
    'auth/operation-not-allowed': 'Email/password sign-in is turned off. Admin: enable it in Firebase Authentication > Sign-in method.',
    'auth/invalid-api-key': 'The Firebase API key in app.js is not valid. Admin: check firebaseConfig.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The Firebase API key in app.js is not valid. Admin: check firebaseConfig.',
    'auth/unauthorized-domain': 'This website address is not allowed. Admin: add it under Authentication > Settings > Authorized domains.'
  };
  return (m[e.code] || 'Sign-in failed.') + '  [' + (e.code || e.message) + ']';
}
$('bin').onclick = async () => {
  const em = $('email').value.trim(), pw = $('pass').value;
  if (!em || !pw) { $('err').textContent = 'Enter your email and password.'; return; }
  $('err').textContent = 'Signing in...'; $('bin').disabled = true;
  try { await auth.signInWithEmailAndPassword(em, pw); $('err').textContent = ''; }
  catch (e) { $('err').textContent = authMsg(e); }
  $('bin').disabled = false;
};
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('bin').click(); });
$('out').onclick = () => auth.signOut();

auth.onAuthStateChanged(async u => {
  unsubs.forEach(f => f()); unsubs = [];
  if (meWatch !== null) { navigator.geolocation.clearWatch(meWatch); meWatch = null; centered = false; }
  ['login', 'guard', 'admin'].forEach(i => $(i).classList.add('hide'));
  $('out').classList.toggle('hide', !u);
  if (!u) { $('who').textContent = ''; $('login').classList.remove('hide'); return; }
  let snap;
  try { snap = await db.doc('users/' + u.uid).get(); }
  catch (e) {
    await auth.signOut();
    $('err').textContent = 'Signed in, but your profile could not be loaded (' + e.code + '). Admin: publish the Firestore rules and make sure the Firestore database exists.';
    return;
  }
  me = { uid: u.uid, ...(snap.data() || { name: u.email, role: 'guard' }) };
  $('who').textContent = me.name + ' (' + me.role + ')';
  if (me.role === 'admin') { $('admin').classList.remove('hide'); initAdmin(); }
  else { $('guard').classList.remove('hide'); initGuard(); }
});

/* ---------- MAP HELPERS ---------- */
function makeMap(el) {
  const m = L.map(el).setView([14.5995, 120.9842], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(m);
  return m;
}
const pin = c => L.divIcon({ className: '', html: `<div style="width:16px;height:16px;border-radius:50%;background:${c};border:3px solid #fff;box-shadow:0 0 4px #0008"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
const getPos = () => new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: true, timeout: 15000 }));

/* ---------- CHECKPOINTS ---------- */
let cps = [], done = {}, doneUnsub = null, pendingCp = null, myLL = null, myAcc = 0, gcpLayer = null, acpLayer = null, selDone = {}, selPhotos = {}, placeHandler = null;
const esc = t => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cpIcon = (n, col) => L.divIcon({ className: '', html: `<div class="cpnum" style="background:${col}">${n}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function drawCps(grp, doneMap) {
  if (!grp) return;
  grp.clearLayers();
  cps.forEach((c, i) => {
    const ok = !!doneMap[c.id], col = ok ? '#1f9d55' : '#e08a1d';
    L.circle([c.lat, c.lng], { radius: c.radius, color: col, weight: 2, dashArray: '5 5', fillColor: col, fillOpacity: 0.12 }).addTo(grp);
    L.marker([c.lat, c.lng], { icon: cpIcon(i + 1, col) }).addTo(grp).bindPopup('<b>' + esc(c.name) + '</b><br>' + (ok ? 'Done ' + fmt(doneMap[c.id]) : 'Not visited'));
  });
}
const distTo = c => myLL ? L.latLng(myLL).distanceTo([c.lat, c.lng]) : null;
const isNear = (d, acc, c) => d !== null && d - Math.min(acc, 30) <= c.radius;   // allows for GPS inaccuracy

/* ---------- RESORT AREA (boundary the admin draws; maps are limited to it) ---------- */
let area = [], areaPolys = {}, drawing = false, drawPts = [], draftLayer = null, wasOut = false, lastOutNote = 0;
function inArea(lat, lng) {   // point-in-polygon
  let ins = false;
  for (let i = 0, j = area.length - 1; i < area.length; j = i++) {
    const yi = area[i][0], xi = area[i][1], yj = area[j][0], xj = area[j][1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function applyArea(map, key, fit) {
  if (!map) return;
  [key, key + 'm'].forEach(k => { if (areaPolys[k]) { map.removeLayer(areaPolys[k]); areaPolys[k] = null; } });
  if (key === 'g') $('maplock').classList.toggle('hide', area.length < 3);
  if (area.length < 3) { map.setMaxBounds(null); map.setMinZoom(0); return; }
  areaPolys[key] = L.polygon(area, { color: '#1d6fe0', weight: 3, dashArray: '8 6', fillColor: '#1d6fe0', fillOpacity: 0.06, interactive: false }).addTo(map);
  const b = areaPolys[key].getBounds();
  if (key === 'g') {
    /* guard map is LOCKED to the area: no panning or zooming out beyond it, outside is dimmed */
    map.invalidateSize();
    const gb = b.pad(0.02);
    map.options.maxBoundsViscosity = 1; map.setMaxBounds(gb);
    map.setMinZoom(0); map.fitBounds(gb, { animate: false }); map.setMinZoom(map.getZoom());
    areaPolys.gm = L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], area], { stroke: false, fillColor: '#000', fillOpacity: 0.35, interactive: false }).addTo(map);
    return;
  }
  if (!(drawing && key === 'a')) { map.options.maxBoundsViscosity = 1; map.setMaxBounds(b.pad(0.25)); }
  if (fit) map.fitBounds(b, { padding: [20, 20] });
}
function watchArea(isAdmin) {
  unsubs.push(db.doc('settings/resort').onSnapshot(sn => {
    area = sn.exists && sn.data().points ? sn.data().points.map(p => [p.lat, p.lng]) : [];
    if (isAdmin) {
      applyArea(amap, 'a', !$('admin').classList.contains('gv'));
      $('areastat').textContent = area.length >= 3 ? 'Area set (' + area.length + ' corners). Maps are limited to this area.' : 'No area set. The map shows everywhere.';
    } else { applyArea(gmap, 'g', !myLL); if (myLL) checkOutside(myLL); }
  }));
}
function checkOutside(ll) {
  const out = area.length >= 3 && !inArea(ll[0], ll[1]);
  $('areawarn').classList.toggle('hide', !out);
  if (out && !wasOut && shiftId && Date.now() - lastOutNote > 60000) { lastOutNote = Date.now(); notify('is outside the resort area'); }
  wasOut = out;
}
function redrawDraft() {
  draftLayer.clearLayers();
  drawPts.forEach(p => L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: '#d64545', fillOpacity: 1, interactive: false }).addTo(draftLayer));
  if (drawPts.length >= 3) L.polygon(drawPts, { color: '#d64545', weight: 3, fillOpacity: 0.1, interactive: false }).addTo(draftLayer);
  else if (drawPts.length === 2) L.polyline(drawPts, { color: '#d64545', weight: 3, interactive: false }).addTo(draftLayer);
  $('areamsg').textContent = drawPts.length + ' corner' + (drawPts.length === 1 ? '' : 's') + ' placed. ' + (drawPts.length < 3 ? 'Add at least 3 corners around the resort.' : 'Tap "Finish and save" when done.');
}
const onDrawClick = e => { drawPts.push([e.latlng.lat, e.latlng.lng]); redrawDraft(); };
function endDraw() {
  drawing = false; amap.off('click', onDrawClick); amap.getContainer().style.cursor = '';
  if (draftLayer) draftLayer.clearLayers();
  $('areabtns').classList.remove('hide'); $('areadrawbtns').classList.add('hide');
  applyArea(amap, 'a', false);
}
$('areadraw').onclick = () => {
  if (placeHandler) { amap.off('click', placeHandler); placeHandler = null; }
  drawing = true; drawPts = []; if (!draftLayer) draftLayer = L.layerGroup().addTo(amap);
  amap.setMaxBounds(null); amap.getContainer().style.cursor = 'crosshair'; amap.on('click', onDrawClick);
  $('areabtns').classList.add('hide'); $('areadrawbtns').classList.remove('hide');
  $('amap').scrollIntoView({ behavior: 'smooth', block: 'center' }); redrawDraft();
};
$('areaundo').onclick = () => { drawPts.pop(); redrawDraft(); };
$('areacancel').onclick = () => { endDraw(); $('areamsg').textContent = ''; };
$('areadone').onclick = async () => {
  if (drawPts.length < 3) { $('areamsg').textContent = 'Add at least 3 corners first.'; return; }
  try {
    await db.doc('settings/resort').set({ points: drawPts.map(p => ({ lat: p[0], lng: p[1] })), updatedAt: ts() });
    endDraw(); $('areamsg').textContent = 'Resort area saved.';
  } catch (e) { $('areamsg').textContent = 'Could not save: ' + e.message; }
};
$('areaclear').onclick = async () => {
  if (!confirm('Clear the resort area? Maps will show everywhere again.')) return;
  try { await db.doc('settings/resort').delete(); $('areamsg').textContent = 'Resort area cleared.'; } catch (e) { $('areamsg').textContent = 'Could not clear: ' + e.message; }
};

/* ---------- STEP COUNTER (phone motion sensor; GPS distance estimate if no sensor) ---------- */
const STRIDE_M = 0.75;
let steps = 0, gpsDist = 0, legSteps0 = 0, legDist0 = 0, lastCpName = 'Start of duty', motionOK = false, motionOn = false, lastStepAt = 0, gBase = 9.8, prevD = 0;
const curSteps = () => motionOK ? steps : Math.round(gpsDist / STRIDE_M);
const skey = () => 'patrol:' + shiftId;
function persist() { try { localStorage.setItem(skey(), JSON.stringify({ steps, gpsDist, legSteps0, legDist0, lastCpName, motionOK })); } catch (e) {} }
function restore() {
  steps = 0; gpsDist = 0; legSteps0 = 0; legDist0 = 0; lastCpName = 'Start of duty'; motionOK = false;
  try { const v = JSON.parse(localStorage.getItem(skey()) || 'null'); if (v) ({ steps, gpsDist, legSteps0, legDist0, lastCpName, motionOK } = v); } catch (e) {}
}
function updateStepUI() {
  $('stepinfo').textContent = shiftId ? 'Steps since ' + lastCpName + ': ' + (curSteps() - legSteps0) + '  ·  Total: ' + curSteps() + (motionOK ? '' : ' (estimated from GPS)') : '';
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null || !shiftId) return;
  if (!motionOK) { steps = Math.round(gpsDist / STRIDE_M); motionOK = true; }   // carry the estimate over so the count never jumps
  const m = Math.hypot(a.x, a.y, a.z); gBase = gBase * 0.97 + m * 0.03;
  const d = m - gBase, now = Date.now();
  if (prevD < 1.2 && d >= 1.2 && now - lastStepAt > 300) { steps++; lastStepAt = now; if (steps % 5 === 0) persist(); updateStepUI(); }
  prevD = d;
}
async function startMotion() {   // call from a tap: iPhone asks for motion permission here
  if (motionOn) return;
  try {
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return;
    }
  } catch (e) { return; }
  window.addEventListener('devicemotion', onMotion); motionOn = true;
}

/* ---------- GUARD ---------- */
let gmap, gline, shiftId = null, watchId = null, lastPt = null, gpts = [];
async function notify(text) { await db.collection('notifications').add({ text, guard: me.name, at: ts() }); }

/* Ask for location permission; explain how to fix it if the guard blocked it */
async function ensureLocation() {
  const box = $('locwarn');
  const ok = () => { box.classList.add('hide'); return true; };
  const blocked = () => {
    box.innerHTML = '<b>Location is blocked.</b> You cannot start duty without it. Tap the lock icon next to the web address, set Location to <b>Allow</b>, then reload this page.<br><button id="locretry" style="margin-top:8px">I allowed it, check again</button>';
    box.classList.remove('hide');
    $('locretry').onclick = () => location.reload();
    return false;
  };
  if (!navigator.geolocation) { box.textContent = 'This device or browser does not support location.'; box.classList.remove('hide'); return false; }
  try {
    if (navigator.permissions) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      if (st.state === 'granted') return ok();
      if (st.state === 'denied') return blocked();
    }
  } catch (e) {}
  try { await getPos(); return ok(); }   // shows the browser's Allow / Block prompt
  catch (e) { return e.code === 1 ? blocked() : (box.textContent = 'Could not get your location. Turn on GPS and try again.', box.classList.remove('hide'), false); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && me && me.role !== 'admin' && !shiftId) ensureLocation(); });

/* Blue "you are here" dot with an accuracy circle, like a maps app */
let meDot = null, meCircle = null, meWatch = null, centered = false;
function showMyLocation() {
  if (meWatch !== null || !navigator.geolocation) return;
  meWatch = navigator.geolocation.watchPosition(p => {
    const ll = [p.coords.latitude, p.coords.longitude];
    myLL = ll; myAcc = p.coords.accuracy; updateCpDist(); checkOutside(ll);
    if (!meDot) {
      meCircle = L.circle(ll, { radius: p.coords.accuracy, color: '#1d6fe0', weight: 1, fillColor: '#1d6fe0', fillOpacity: 0.15 }).addTo(gmap);
      meDot = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(gmap).bindTooltip('You are here');
    } else { meDot.setLatLng(ll); meCircle.setLatLng(ll).setRadius(p.coords.accuracy); }
    if (!centered) { gmap.setView(ll, 17); centered = true; }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}

function renderCpList() {
  const box = $('cplist'); box.innerHTML = '';
  if (!cps.length) { box.innerHTML = '<span class="mut">The admin has not added checkpoints yet.</span>'; $('cpcount').textContent = ''; return; }
  $('cpcount').textContent = '(' + cps.filter(c => done[c.id]).length + ' of ' + cps.length + ' done)';
  cps.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'item cp';
    row.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><div><b>${i + 1}. ${esc(c.name)}</b><div class="mut" id="cps-${c.id}"></div></div><button id="cpb-${c.id}"></button></div>`;
    row.querySelector('button').onclick = () => { startMotion(); pendingCp = c; $('file').click(); };
    box.appendChild(row);
  });
  updateCpDist();
}
function updateCpDist() {
  cps.forEach(c => {
    const s = $('cps-' + c.id), b = $('cpb-' + c.id); if (!s || !b) return;
    const d = distTo(c), ok = !!done[c.id], near = isNear(d, myAcc, c);
    s.textContent = (ok ? '✓ Done ' + fmt(done[c.id]) + ' · ' : '') +
      (!shiftId ? 'Start duty first' : d === null ? 'Finding your location…' : near ? 'You are at the checkpoint' : Math.round(d) + ' m away (get within ' + c.radius + ' m)');
    b.textContent = ok ? 'Retake photo' : 'Take photo';
    b.disabled = !(shiftId && near);
  });
}
function watchDone() {
  if (doneUnsub) doneUnsub();
  doneUnsub = db.collection('shifts/' + shiftId + '/photos').onSnapshot(s => {
    done = {}; s.forEach(d => { const v = d.data(); if (v.checkpointId) done[v.checkpointId] = v.at || new Date(); });
    renderCpList(); drawCps(gcpLayer, done);
  });
}

function initGuard() {
  shiftId = null; done = {}; if (doneUnsub) { doneUnsub(); doneUnsub = null; }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  ensureLocation().then(ok => { if (ok) showMyLocation(); });
  if (!gmap) { gmap = makeMap('gmap'); gline = L.polyline([], { color: '#1d6fe0', weight: 5 }).addTo(gmap); gcpLayer = L.layerGroup().addTo(gmap); }
  unsubs.push(db.collection('checkpoints').orderBy('order').onSnapshot(sn => {
    cps = sn.docs.map(d => ({ id: d.id, ...d.data() })); renderCpList(); drawCps(gcpLayer, done);
  }));
  watchArea(false);
  setTimeout(() => gmap.invalidateSize(), 200);
  db.collection('shifts').where('guardId', '==', me.uid).where('status', '==', 'active').limit(1).get().then(s => {
    if (!s.empty) { shiftId = s.docs[0].id; beginTracking(); }
    else setUI(false);
  });
}
function setUI(on) {
  $('start').classList.toggle('hide', on);
  $('end').classList.toggle('hide', !on);
  $('gstatus').textContent = on ? 'You are ON DUTY. Location is being recorded.' : 'You are off duty.';
}
let lastBeat = 0;
function sendBeat(lat, lng, acc) {   // tells the admin where the guard is right now (and that the app is alive)
  if (!shiftId || Date.now() - lastBeat < 10000) return;
  lastBeat = Date.now();
  db.doc('shifts/' + shiftId).update({ lastLat: lat, lastLng: lng, lastAcc: Math.round(acc || 0), lastAt: ts() }).catch(() => {});
}
setInterval(() => { if (shiftId && myLL) sendBeat(myLL[0], myLL[1], myAcc); }, 20000);

function beginTracking() {
  restore(); startMotion(); updateStepUI();
  setUI(true); gpts = []; lastPt = null; gline.setLatLngs([]); watchDone();
  watchId = navigator.geolocation.watchPosition(p => {
    const pt = [p.coords.latitude, p.coords.longitude];
    sendBeat(pt[0], pt[1], p.coords.accuracy);
    if (lastPt && gmap.distance(lastPt, pt) < 8) return; // ignore GPS jitter
    if (lastPt) gpsDist += gmap.distance(lastPt, pt); lastPt = pt; gpts.push(pt); gline.setLatLngs(gpts); persist(); updateStepUI(); gmap.setView(pt, 17);
    db.collection('shifts/' + shiftId + '/points').add({ lat: pt[0], lng: pt[1], at: ts() });
  }, e => $('gmsg').textContent = 'GPS error: ' + e.message + '. Allow location access.', { enableHighAccuracy: true, maximumAge: 5000 });
}
$('start').onclick = async () => {
  startMotion();
  if (!(await ensureLocation())) return;
  showMyLocation();
  try {
    const p = await getPos();
    const ref = await db.collection('shifts').add({ guardId: me.uid, guardName: me.name, status: 'active', start: ts(), startLat: p.coords.latitude, startLng: p.coords.longitude });
    shiftId = ref.id; await notify('started duty'); beginTracking();
  } catch (e) { $('gmsg').textContent = 'Could not get location. Turn on GPS and allow access.'; }
};
$('end').onclick = async () => {
  if (!confirm('End your duty?')) return;
  const last = lastPt || [null, null];
  navigator.geolocation.clearWatch(watchId);
  await db.doc('shifts/' + shiftId).update({ status: 'ended', end: ts(), endLat: last[0], endLng: last[1] });
  await notify('ended duty'); try { localStorage.removeItem(skey()); } catch (e) {}
  shiftId = null; setUI(false); updateStepUI();
  if (doneUnsub) { doneUnsub(); doneUnsub = null; }
  done = {}; renderCpList(); drawCps(gcpLayer, done);
};
$('file').onchange = async e => {
  const f = e.target.files[0], cp = pendingCp; if (!f) return;
  if (!cp || !shiftId) { $('gmsg').textContent = 'Choose a checkpoint first.'; e.target.value = ''; return; }
  $('gmsg').textContent = 'Saving photo…';
  try {
    const p = await getPos(), lat = p.coords.latitude, lng = p.coords.longitude, now = new Date();
    const dist = L.latLng(lat, lng).distanceTo([cp.lat, cp.lng]);
    if (!isNear(dist, p.coords.accuracy, cp)) { $('gmsg').textContent = 'You are ' + Math.round(dist) + ' m from "' + cp.name + '". Move within ' + cp.radius + ' m and try again.'; e.target.value = ''; return; }
    const bmp = await createImageBitmap(f), s = Math.min(1, 800 / bmp.width);
    const c = document.createElement('canvas'); c.width = bmp.width * s; c.height = bmp.height * s;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height);
    const total = curSteps(), legSteps = total - legSteps0, legM = Math.round(gpsDist - legDist0), from = lastCpName, est = motionOK ? '' : '~';
    const idx = cps.findIndex(k => k.id === cp.id) + 1, doneAfter = new Set(Object.keys(done)); doneAfter.add(cp.id);
    const finished = cps.length > 0 && cps.every(k => doneAfter.has(k.id));
    const lines = [
      'CHECKPOINT ' + idx + '/' + cps.length + ': ' + cp.name,
      now.toLocaleString(),
      'GPS ' + lat.toFixed(6) + ', ' + lng.toFixed(6) + ' (+/-' + Math.round(p.coords.accuracy) + ' m)',
      'Steps from ' + from + ': ' + est + legSteps + ' (' + legM + ' m)',
      'Total steps: ' + est + total,
      'Guard: ' + me.name];
    if (finished) lines.unshift('PATROL COMPLETE - ALL ' + cps.length + ' CHECKPOINTS');
    let fs = Math.max(14, c.width / 34);
    x.font = `bold ${fs}px sans-serif`;
    while (fs > 10 && Math.max(...lines.map(t => x.measureText(t).width)) > c.width - 20) { fs--; x.font = `bold ${fs}px sans-serif`; }
    const boxH = fs * 1.3 * lines.length + fs * 0.7;
    x.fillStyle = '#000a'; x.fillRect(0, c.height - boxH, c.width, boxH);
    x.fillStyle = '#fff'; lines.forEach((t, i) => { if (finished && i === 0) x.fillStyle = '#7dffa8'; x.fillText(t, 10, c.height - boxH + fs * 1.15 + i * fs * 1.3); if (i === 0) x.fillStyle = '#fff'; });
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    const fd = new FormData();
    fd.append('file', blob); fd.append('upload_preset', CLOUDINARY_PRESET); fd.append('folder', 'patrol');
    const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd });
    const up = await res.json();
    if (!up.secure_url) throw new Error((up.error && up.error.message) || 'Cloudinary upload failed');
    await db.collection('shifts/' + shiftId + '/photos').add({ img: up.secure_url, lat, lng, checkpointId: cp.id, checkpointName: cp.name, checkpointIndex: idx, distance: Math.round(dist), fromName: from, stepsLeg: legSteps, stepsTotal: total, legMeters: legM, stepsEstimated: !motionOK, accuracy: Math.round(p.coords.accuracy), finished, at: ts() });
    legSteps0 = total; legDist0 = gpsDist; lastCpName = cp.name; persist(); updateStepUI();
    await notify('took a photo at ' + cp.name);
    $('gmsg').textContent = 'Photo saved for ' + cp.name + '.';
  } catch (err) { $('gmsg').textContent = 'Photo failed: ' + err.message; }
  e.target.value = '';
};

/* ---------- ADMIN ---------- */
let allShifts = [], gvGuard = null, selStatus = null;
let amap, layer, sel = null, selUnsubs = [], booted = false;
function toast(t) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 8000);
  try { if (Notification.permission === 'granted') new Notification('Guard Patrol', { body: t }); } catch (e) {}
  try { const a = new (window.AudioContext || webkitAudioContext)(), o = a.createOscillator(); o.connect(a.destination); o.frequency.value = 880; o.start(); o.stop(a.currentTime + 0.2); } catch (e) {}
}
/* ---------- LIVE MAP (admin sees every guard on duty, with their route) ---------- */
let liveLayer = null, selLiveLayer = null, liveSubs = {}, livePts = {};
const GCOL = ['#1d6fe0', '#e0561d', '#8a3fd1', '#0e9aa7', '#c2185b', '#6d8f00'];
const gcol = id => GCOL[[...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % GCOL.length];
function ago(t) {
  const sec = Math.max(0, Math.round((Date.now() - (t.toDate ? t.toDate() : new Date(t)).getTime()) / 1000));
  return sec < 60 ? sec + 's ago' : sec < 3600 ? Math.round(sec / 60) + ' min ago' : Math.round(sec / 3600) + ' h ago';
}
function liveMarker(x, pts) {
  const pos = x.lastLat != null ? [x.lastLat, x.lastLng] : (pts && pts.length ? pts[pts.length - 1] : null);
  if (!pos) return null;
  const col = gcol(x.guardId), stale = x.lastAt && x.lastAt.toDate && (Date.now() - x.lastAt.toDate().getTime()) > 120000;
  return L.marker(pos, { icon: L.divIcon({ className: '', html: `<div class="me-dot${stale ? ' stale' : ''}" style="background:${stale ? '#8896a3' : col}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
    .bindTooltip(esc(x.guardName) + (x.lastAt ? ' · ' + ago(x.lastAt) : ' · live'), { permanent: true, direction: 'top', offset: [0, -10] });
}
function drawLive() {
  if (!liveLayer) return;
  liveLayer.clearLayers();
  if ($('admin').classList.contains('gv')) return;
  allShifts.filter(x => x.status === 'active').forEach(x => {
    const pts = livePts[x.id] || [], col = gcol(x.guardId);
    if (pts.length > 1) L.polyline(pts, { color: col, weight: 5, opacity: 0.9, interactive: false }).addTo(liveLayer);
    if (pts.length) L.marker(pts[0], { icon: pin('#1f9d55'), interactive: false }).addTo(liveLayer);
    const m = liveMarker(x, pts);
    if (m) m.addTo(liveLayer).on('click', () => openGuard(x.guardId, x.id));
  });
}
function drawSelLive() {   // live dot for the guard opened in the guard view
  if (!selLiveLayer) return;
  selLiveLayer.clearLayers();
  const x = allShifts.find(k => k.id === sel);
  if (!x || x.status !== 'active') return;
  const m = liveMarker(x, null); if (m) m.addTo(selLiveLayer);
}
function syncLive() {
  const act = allShifts.filter(x => x.status === 'active'), ids = new Set(act.map(x => x.id));
  Object.keys(liveSubs).forEach(id => { if (!ids.has(id)) { liveSubs[id](); delete liveSubs[id]; delete livePts[id]; } });
  act.forEach(x => {
    if (liveSubs[x.id]) return;
    liveSubs[x.id] = db.collection('shifts/' + x.id + '/points').orderBy('at').onSnapshot(sn => {
      livePts[x.id] = sn.docs.map(d => d.data()).filter(p => p.at).map(p => [p.lat, p.lng]); drawLive();
    });
  });
  drawLive();
}

function initAdmin() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  if (!amap) { amap = makeMap('amap'); acpLayer = L.layerGroup().addTo(amap); layer = L.layerGroup().addTo(amap); liveLayer = L.layerGroup().addTo(amap); selLiveLayer = L.layerGroup().addTo(amap); }
  setTimeout(() => amap.invalidateSize(), 200);
  booted = false;
  const liveTimer = setInterval(() => { drawLive(); drawSelLive(); }, 30000);   // refreshes "last seen" times
  unsubs.push(() => { clearInterval(liveTimer); Object.values(liveSubs).forEach(f => f()); liveSubs = {}; livePts = {}; });
  unsubs.push(db.collection('checkpoints').orderBy('order').onSnapshot(sn => {
    cps = sn.docs.map(d => ({ id: d.id, ...d.data() })); renderCpAdmin(); drawCps(acpLayer, selDone); renderProgress();
  }));
  watchArea(true);
  unsubs.push(db.collection('notifications').orderBy('at', 'desc').limit(1).onSnapshot(s => {
    if (!booted) { booted = true; return; }
    s.docChanges().forEach(c => { if (c.type === 'added' && c.doc.data().at) toast(c.doc.data().guard + ' ' + c.doc.data().text); });
  }));
  unsubs.push(db.collection('shifts').orderBy('start', 'desc').limit(30).onSnapshot(s => {
    allShifts = s.docs.map(d => ({ id: d.id, ...d.data() }));
    const act = $('active'), rec = $('recent'); act.innerHTML = ''; rec.innerHTML = '';
    allShifts.forEach(v => {
      const on = v.status === 'active';
      const el = document.createElement('div'); el.className = 'item' + (v.id === sel ? ' sel' : '');
      el.innerHTML = `<span class="go">View ›</span><span class="dot ${on ? 'on' : ''}"></span><b>${esc(v.guardName)}</b><div class="mut">${fmt(v.start)}${on ? ' · on duty' + (v.lastAt ? ' · seen ' + ago(v.lastAt) : '') : ' → ' + fmt(v.end)}</div>`;
      el.onclick = () => openGuard(v.guardId, v.id);
      (on ? act : rec).appendChild(el);
    });
    if (!act.children.length) act.innerHTML = '<span class="mut">No guards on duty.</span>';
    syncLive();
    if ($('admin').classList.contains('gv')) {
      refreshGvSelect();
      const cur = allShifts.find(x => x.id === sel);
      if (cur) { updateGvHeader(cur); if (cur.status !== selStatus) select(cur.id, cur); }
      drawSelLive();
    }
  }));
}

/* ---------- GUARD VIEW (admin picks a guard) ---------- */
function updateGvHeader(v) {
  $('gvname').textContent = v.guardName;
  $('gvstat').textContent = v.status === 'active' ? '🟢 On duty' : '⚪ Shift ended';
}
function refreshGvSelect() {
  const list = allShifts.filter(x => x.guardId === gvGuard), sl = $('gvshift');
  sl.innerHTML = '';
  list.forEach(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = fmt(x.start) + (x.status === 'active' ? '  ·  ON DUTY' : ''); sl.appendChild(o); });
  if (sel) sl.value = sel;
}
function openGuard(guardId, shiftId) {
  const v = allShifts.find(x => x.id === shiftId); if (!v) return;
  gvGuard = guardId; $('admin').classList.add('gv'); drawLive();
  refreshGvSelect(); updateGvHeader(v); select(shiftId, v);
  window.scrollTo(0, 0); setTimeout(() => amap.invalidateSize(), 150);
}
function closeGuard() {
  $('admin').classList.remove('gv'); gvGuard = null;
  selUnsubs.forEach(f => f()); selUnsubs = []; sel = null; selStatus = null; selDone = {}; selPhotos = {};
  layer.clearLayers(); selLiveLayer.clearLayers(); drawCps(acpLayer, selDone); renderProgress(); drawLive();
  $('mtitle').textContent = 'Live map: guards on duty'; $('thumbs').innerHTML = '<span class="mut">None.</span>';
  document.querySelectorAll('.item.sel').forEach(e => e.classList.remove('sel'));
  window.scrollTo(0, 0); setTimeout(() => amap.invalidateSize(), 150);
}
$('gvback').onclick = closeGuard;
$('gvshift').onchange = e => { const v = allShifts.find(x => x.id === e.target.value); if (v) { updateGvHeader(v); select(v.id, v); } };
function renderProgress() {
  const b = $('progress');
  if (!sel) { b.innerHTML = '<span class="mut">Select a shift to see which checkpoints were visited.</span>'; return; }
  if (!cps.length) { b.innerHTML = '<span class="mut">No checkpoints yet.</span>'; return; }
  const got = cps.filter(c => selPhotos[c.id]);
  const total = Math.max(0, ...got.map(c => selPhotos[c.id].stepsTotal || 0));
  b.innerHTML = `<p><b>${got.length} of ${cps.length}</b> checkpoints visited · <b>${total}</b> total steps${got.length === cps.length ? ' · ✅ patrol complete' : ''}</p><div class="cpgrid">` +
    cps.map((c, i) => {
      const p = selPhotos[c.id];
      return p
        ? `<div class="cpcard"><b>${i + 1}. ${esc(c.name)}</b><div class="mut">${fmt(p.at)}</div><img class="cpimg zoomable" src="${p.img}" alt="Photo at ${esc(c.name)}" loading="lazy"><div class="mut">${p.stepsLeg != null ? (p.stepsEstimated ? '~' : '') + p.stepsLeg + ' steps from ' + esc(p.fromName) + ' (' + p.legMeters + ' m) · total ' + p.stepsTotal : ''}</div></div>`
        : `<div class="cpcard"><b>${i + 1}. ${esc(c.name)}</b><div class="mut">⬜ Not visited yet</div></div>`;
    }).join('') + '</div>';
}
function renderCpAdmin() {
  const b = $('cpadmin'); b.innerHTML = cps.length ? '' : '<span class="mut">No checkpoints yet.</span>';
  cps.forEach((c, i) => {
    const r = document.createElement('div'); r.className = 'item';
    r.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><div><b>${i + 1}. ${esc(c.name)}</b><div class="mut">Radius ${c.radius} m</div></div><button class="bad" style="min-height:40px;padding:6px 12px">Delete</button></div>`;
    r.firstElementChild.firstElementChild.onclick = () => amap.setView([c.lat, c.lng], 18);
    r.querySelector('button').onclick = e => { e.stopPropagation(); if (confirm('Delete checkpoint "' + c.name + '"?')) db.doc('checkpoints/' + c.id).delete(); };
    b.appendChild(r);
  });
}
async function saveCp(lat, lng) {
  const name = $('cpname').value.trim(), radius = Math.max(10, +$('cpradius').value || 30);
  if (area.length >= 3 && !inArea(lat, lng)) { $('cpmsg').textContent = 'That spot is outside the resort area. Choose a place inside the outline.'; return; }
  await db.collection('checkpoints').add({ name, lat, lng, radius, order: Date.now() });
  $('cpname').value = ''; $('cpmsg').textContent = 'Checkpoint added.';
}
function needName() {
  if ($('cpname').value.trim()) return true;
  $('cpmsg').textContent = 'Type a checkpoint name first.'; $('cpname').focus(); return false;
}
$('cpmap').onclick = () => {
  if (!needName()) return;
  $('cpmsg').textContent = 'Tap the map where the checkpoint is.';
  amap.getContainer().style.cursor = 'crosshair';
  $('amap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (placeHandler) amap.off('click', placeHandler);
  placeHandler = e => { amap.off('click', placeHandler); placeHandler = null; amap.getContainer().style.cursor = ''; saveCp(e.latlng.lat, e.latlng.lng).catch(err => $('cpmsg').textContent = 'Could not save: ' + err.message); };
  amap.on('click', placeHandler);
};
$('cpgps').onclick = async () => {
  if (!needName()) return;
  try { const p = await getPos(); await saveCp(p.coords.latitude, p.coords.longitude); }
  catch (e) { $('cpmsg').textContent = 'Could not get your location or save. ' + (e.message || ''); }
};

function select(id, v) {
  sel = id; selStatus = v.status; selDone = {}; selPhotos = {}; selUnsubs.forEach(f => f()); selUnsubs = [];
  $('mtitle').textContent = v.guardName + ' — ' + fmt(v.start);
  document.querySelectorAll('.item').forEach(e => e.classList.remove('sel'));
  let pts = [], photos = [], fitted = false;
  const draw = () => {
    layer.clearLayers();
    $('gvsum').textContent = 'Started ' + fmt(v.start) + (v.end ? '  ·  Ended ' + fmt(v.end) : '') + (pts.length ? '  ·  Last location ' + fmt(pts[pts.length - 1].at) : '');
    if (pts.length) {
      const ll = pts.map(p => [p.lat, p.lng]);
      L.polyline(ll, { color: '#1d6fe0', weight: 5 }).addTo(layer);
      L.marker(ll[0], { icon: pin('#1f9d55') }).addTo(layer).bindPopup('Start: ' + fmt(pts[0].at));
      const last = pts[pts.length - 1];
      if (v.status !== 'active') L.marker(ll[ll.length - 1], { icon: pin('#d64545') }).addTo(layer).bindPopup('End: ' + fmt(last.at));
      if (!fitted) { amap.fitBounds(ll, { padding: [30, 30], maxZoom: 18 }); fitted = true; }
    }
    photos.forEach(p => L.marker([p.lat, p.lng]).addTo(layer).bindPopup(`<div class="pop">${p.checkpointName ? '<b>' + esc(p.checkpointName) + '</b><br>' : ''}<img class="zoomable" src="${p.img}"><br>${fmt(p.at)}${p.stepsLeg != null ? '<br>' + p.stepsLeg + ' steps from ' + esc(p.fromName) : ''}</div>`));
    const extra = photos.filter(p => !p.checkpointId);
    $('thumbs').innerHTML = extra.length ? '' : '<span class="mut">None.</span>';
    selDone = {}; selPhotos = {}; photos.forEach(p => { if (p.checkpointId) { selDone[p.checkpointId] = p.at; selPhotos[p.checkpointId] = p; } });
    drawCps(acpLayer, selDone); renderProgress();
    extra.forEach(p => { const i = new Image(); i.src = p.img; i.className = 'zoomable'; $('thumbs').appendChild(i); });
  };
  selUnsubs.push(db.collection('shifts/' + id + '/points').orderBy('at').onSnapshot(s => { pts = s.docs.map(d => d.data()).filter(p => p.at); draw(); }));
  selUnsubs.push(db.collection('shifts/' + id + '/photos').orderBy('at').onSnapshot(s => { photos = s.docs.map(d => d.data()).filter(p => p.at); draw(); }));
  drawSelLive();
}

$('fitlive').onclick = () => {
  const pts = allShifts.filter(x => x.status === 'active' && x.lastLat != null).map(x => [x.lastLat, x.lastLng]);
  if (pts.length) amap.fitBounds(pts, { padding: [50, 50], maxZoom: 18 }); else toast('No guard on duty has a live location yet.');
};

/* keep maps correct when the phone/tablet rotates or the window resizes */
function fixMaps() {
  setTimeout(() => {
    if (gmap) {
      gmap.invalidateSize();
      if (areaPolys.g && area.length >= 3) { gmap.setMinZoom(0); gmap.setMinZoom(gmap.getBoundsZoom(areaPolys.g.getBounds().pad(0.02))); }   // keep the lock correct after rotating
    }
    if (amap) amap.invalidateSize();
  }, 250);
}
window.addEventListener('resize', fixMaps);
window.addEventListener('orientationchange', fixMaps);

/* full-screen photo viewer (tap any photo) */
document.addEventListener('click', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('zoomable')) { $('vimg').src = t.src; $('vopen').href = t.src; $('viewer').classList.remove('hide'); }
});
$('vclose').onclick = () => $('viewer').classList.add('hide');
$('viewer').addEventListener('click', e => { if (e.target.id === 'viewer') $('viewer').classList.add('hide'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('viewer').classList.add('hide'); });

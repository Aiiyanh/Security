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
    if (!meDot) {
      meCircle = L.circle(ll, { radius: p.coords.accuracy, color: '#1d6fe0', weight: 1, fillColor: '#1d6fe0', fillOpacity: 0.15 }).addTo(gmap);
      meDot = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(gmap).bindTooltip('You are here');
    } else { meDot.setLatLng(ll); meCircle.setLatLng(ll).setRadius(p.coords.accuracy); }
    if (!centered) { gmap.setView(ll, 17); centered = true; }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}

function initGuard() {
  ensureLocation().then(ok => { if (ok) showMyLocation(); });
  if (!gmap) { gmap = makeMap('gmap'); gline = L.polyline([], { color: '#1d6fe0', weight: 5 }).addTo(gmap); }
  setTimeout(() => gmap.invalidateSize(), 200);
  db.collection('shifts').where('guardId', '==', me.uid).where('status', '==', 'active').limit(1).get().then(s => {
    if (!s.empty) { shiftId = s.docs[0].id; beginTracking(); }
    else setUI(false);
  });
}
function setUI(on) {
  $('start').classList.toggle('hide', on);
  $('snap').classList.toggle('hide', !on);
  $('end').classList.toggle('hide', !on);
  $('gstatus').textContent = on ? 'You are ON DUTY. Location is being recorded.' : 'You are off duty.';
}
function beginTracking() {
  setUI(true); gpts = []; lastPt = null; gline.setLatLngs([]);
  watchId = navigator.geolocation.watchPosition(p => {
    const pt = [p.coords.latitude, p.coords.longitude];
    if (lastPt && gmap.distance(lastPt, pt) < 8) return; // ignore GPS jitter
    lastPt = pt; gpts.push(pt); gline.setLatLngs(gpts); gmap.setView(pt, 17);
    db.collection('shifts/' + shiftId + '/points').add({ lat: pt[0], lng: pt[1], at: ts() });
  }, e => $('gmsg').textContent = 'GPS error: ' + e.message + '. Allow location access.', { enableHighAccuracy: true, maximumAge: 5000 });
}
$('start').onclick = async () => {
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
  await notify('ended duty'); shiftId = null; setUI(false);
};
$('snap').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  $('gmsg').textContent = 'Saving photo…';
  try {
    const p = await getPos(), lat = p.coords.latitude, lng = p.coords.longitude, now = new Date();
    const bmp = await createImageBitmap(f), s = Math.min(1, 800 / bmp.width);
    const c = document.createElement('canvas'); c.width = bmp.width * s; c.height = bmp.height * s;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height);
    const lines = [now.toLocaleString(), lat.toFixed(6) + ', ' + lng.toFixed(6), me.name], fs = Math.max(14, c.width / 32);
    x.font = `bold ${fs}px sans-serif`; x.fillStyle = '#0009'; x.fillRect(0, c.height - fs * 3.6, c.width, fs * 3.6);
    x.fillStyle = '#fff'; lines.forEach((t, i) => x.fillText(t, 8, c.height - fs * 2.6 + i * fs * 1.2));
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    const fd = new FormData();
    fd.append('file', blob); fd.append('upload_preset', CLOUDINARY_PRESET); fd.append('folder', 'patrol');
    const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload', { method: 'POST', body: fd });
    const up = await res.json();
    if (!up.secure_url) throw new Error((up.error && up.error.message) || 'Cloudinary upload failed');
    await db.collection('shifts/' + shiftId + '/photos').add({ img: up.secure_url, lat, lng, at: ts() });
    L.marker([lat, lng]).addTo(gmap).bindPopup('Photo ' + now.toLocaleTimeString());
    await notify('sent a patrol photo');
    $('gmsg').textContent = 'Photo saved with time and location.';
  } catch (err) { $('gmsg').textContent = 'Photo failed: ' + err.message; }
  e.target.value = '';
};

/* ---------- ADMIN ---------- */
let amap, layer, sel = null, selUnsubs = [], booted = false;
function toast(t) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 8000);
  try { if (Notification.permission === 'granted') new Notification('Guard Patrol', { body: t }); } catch (e) {}
  try { const a = new (window.AudioContext || webkitAudioContext)(), o = a.createOscillator(); o.connect(a.destination); o.frequency.value = 880; o.start(); o.stop(a.currentTime + 0.2); } catch (e) {}
}
function initAdmin() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  if (!amap) { amap = makeMap('amap'); layer = L.layerGroup().addTo(amap); }
  setTimeout(() => amap.invalidateSize(), 200);
  booted = false;
  unsubs.push(db.collection('notifications').orderBy('at', 'desc').limit(1).onSnapshot(s => {
    if (!booted) { booted = true; return; }
    s.docChanges().forEach(c => { if (c.type === 'added' && c.doc.data().at) toast(c.doc.data().guard + ' ' + c.doc.data().text); });
  }));
  unsubs.push(db.collection('shifts').orderBy('start', 'desc').limit(30).onSnapshot(s => {
    const act = $('active'), rec = $('recent'); act.innerHTML = ''; rec.innerHTML = '';
    s.forEach(d => {
      const v = d.data(), on = v.status === 'active';
      const el = document.createElement('div'); el.className = 'item' + (d.id === sel ? ' sel' : '');
      el.innerHTML = `<span class="dot ${on ? 'on' : ''}"></span><b>${v.guardName}</b><div class="mut">${fmt(v.start)}${on ? ' · on duty' : ' → ' + fmt(v.end)}</div>`;
      el.onclick = () => select(d.id, v);
      (on ? act : rec).appendChild(el);
    });
    if (!act.children.length) act.innerHTML = '<span class="mut">No guards on duty.</span>';
  }));
}
function select(id, v) {
  sel = id; selUnsubs.forEach(f => f()); selUnsubs = [];
  if (window.innerWidth < 700) $('amap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('mtitle').textContent = v.guardName + ' — ' + fmt(v.start);
  document.querySelectorAll('.item').forEach(e => e.classList.remove('sel'));
  let pts = [], photos = [];
  const draw = () => {
    layer.clearLayers();
    if (pts.length) {
      const ll = pts.map(p => [p.lat, p.lng]);
      L.polyline(ll, { color: '#1d6fe0', weight: 5 }).addTo(layer);
      L.marker(ll[0], { icon: pin('#1f9d55') }).addTo(layer).bindPopup('Start: ' + fmt(pts[0].at));
      const last = pts[pts.length - 1];
      L.marker(ll[ll.length - 1], { icon: pin(v.status === 'active' ? '#1d6fe0' : '#d64545') }).addTo(layer)
        .bindPopup((v.status === 'active' ? 'Latest: ' : 'End: ') + fmt(last.at));
      amap.fitBounds(ll, { padding: [30, 30], maxZoom: 18 });
    }
    photos.forEach(p => L.marker([p.lat, p.lng]).addTo(layer).bindPopup(`<div class="pop"><img src="${p.img}"><br>${fmt(p.at)}</div>`));
    $('thumbs').innerHTML = photos.length ? '' : '<span class="mut">No photos.</span>';
    photos.forEach(p => { const i = new Image(); i.src = p.img; i.onclick = () => amap.setView([p.lat, p.lng], 19); $('thumbs').appendChild(i); });
  };
  selUnsubs.push(db.collection('shifts/' + id + '/points').orderBy('at').onSnapshot(s => { pts = s.docs.map(d => d.data()).filter(p => p.at); draw(); }));
  selUnsubs.push(db.collection('shifts/' + id + '/photos').orderBy('at').onSnapshot(s => { photos = s.docs.map(d => d.data()).filter(p => p.at); draw(); }));
}

/* keep maps correct when the phone/tablet rotates or the window resizes */
function fixMaps() { setTimeout(() => { if (gmap) gmap.invalidateSize(); if (amap) amap.invalidateSize(); }, 250); }
window.addEventListener('resize', fixMaps);
window.addEventListener('orientationchange', fixMaps);
"use strict";

/* ============================================================
   STATE
   ============================================================ */
const STORE_KEY = "waktusolat_state_v1";
let state = {
  zoneCode: "WLY01",
  zoneLabel: "Kuala Lumpur, Putrajaya",
  notifEnabled: false,
  azanEnabled: true,
  reminderMin: 0,
  lat: null,
  lng: null
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = Object.assign(state, JSON.parse(raw));
  } catch (e) {}
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

// Fallback estimate (typical KL times) shown instantly while real JAKIM data loads
const FALLBACK_PRAYER_DATA = { imsak: "05:50", subuh: "06:00", syuruk: "07:15", zohor: "13:15", asar: "16:30", maghrib: "19:20", isyak: "20:35" };

let prayerData = null;       // today's times from API {imsak, subuh, syuruk, zohor, asar, maghrib, isyak}
let prayerCache = {};        // cache by "zone_YYYY-MM-DD"
let deferredInstallPrompt = null;
let notifiedToday = new Set(); // which prayers already notified today (to avoid dupes)

/* ============================================================
   PRAYER NAMES CONFIG
   ============================================================ */
const PRAYER_META = [
  { key: "imsak",   label: "Imsak",   icon: "moon" },
  { key: "subuh",   label: "Subuh",   icon: "sunrise-dim" },
  { key: "syuruk",  label: "Syuruk",  icon: "sunrise" },
  { key: "zohor",   label: "Zohor",   icon: "sun" },
  { key: "asar",    label: "Asar",    icon: "sun-low" },
  { key: "maghrib", label: "Maghrib", icon: "sunset" },
  { key: "isyak",   label: "Isyak",   icon: "moon-star" }
];
// which of these count as "solat wajib" for notification/hero purposes (exclude imsak & syuruk from countdown targets but show them)
const NOTIFY_PRAYERS = ["subuh", "zohor", "asar", "maghrib", "isyak"];

const ICONS = {
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="#dfbe6a" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  "sunrise-dim": '<svg viewBox="0 0 24 24" fill="none" stroke="#9fb8d6" stroke-width="2"><path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 9V2M4.2 10.2l1.4 1.4M2 18h2M20 18h2M18.4 11.6l1.4-1.4"/><line x1="1" y1="22" x2="23" y2="22"/></svg>',
  sunrise: '<svg viewBox="0 0 24 24" fill="none" stroke="#f5c84c" stroke-width="2"><path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 9V2M4.2 10.2l1.4 1.4M2 18h2M20 18h2M18.4 11.6l1.4-1.4"/><line x1="1" y1="22" x2="23" y2="22"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="#ffd54f" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>',
  "sun-low": '<svg viewBox="0 0 24 24" fill="none" stroke="#ff9f4a" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 4v1M12 19v1M4 12h1M19 12h1M6.3 6.3l.7.7M17 17l.7.7M6.3 17.7l.7-.7M17 6.3l.7-.7"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" fill="none" stroke="#ff6f61" stroke-width="2"><path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 2v7M4.2 10.2l1.4 1.4M2 18h2M20 18h2M18.4 11.6l1.4-1.4"/><line x1="1" y1="22" x2="23" y2="22"/><path d="M16 15l-4 4-4-4"/></svg>',
  "moon-star": '<svg viewBox="0 0 24 24" fill="none" stroke="#8a7bff" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/><path d="M19 3l.7 1.7L21.5 5.5l-1.8.8L19 8l-.7-1.7-1.8-.8 1.8-.8z"/></svg>'
};

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener("DOMContentLoaded", () => {
  loadState();
  document.getElementById("toggleNotif").checked = state.notifEnabled;
  document.getElementById("toggleAzan").checked = state.azanEnabled;
  document.getElementById("selectReminder").value = String(state.reminderMin);
  document.getElementById("locationLabel").textContent = state.zoneLabel;
  document.getElementById("settingsZoneLabel").textContent = state.zoneLabel;
  document.getElementById("zoneSub").textContent = state.zoneLabel;

  bindSettingsEvents();
  tickClock();
  setInterval(tickClock, 1000);

  fetchPrayerTimes();
  // refresh at midnight-ish by checking every minute if date changed
  setInterval(checkDateRollover, 30000);

  registerServiceWorker();
  setupInstallPrompt();
  tryGeolocation();

  // Unlock audio playback on first tap anywhere (required by iOS/Android autoplay policies)
  const unlockOnce = () => { unlockAzanAudio(); };
  document.addEventListener("touchend", unlockOnce, { once: true });
  document.addEventListener("click", unlockOnce, { once: true });
});

function bindSettingsEvents() {
  document.getElementById("toggleNotif").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const perm = await requestNotifPermission();
      if (perm !== "granted") {
        e.target.checked = false;
        showToast("Kebenaran notifikasi ditolak");
        return;
      }
    }
    state.notifEnabled = e.target.checked;
    saveState();
    showToast(state.notifEnabled ? "Notifikasi diaktifkan" : "Notifikasi dimatikan");
  });
  document.getElementById("toggleAzan").addEventListener("change", (e) => {
    state.azanEnabled = e.target.checked;
    saveState();
  });
  document.getElementById("selectReminder").addEventListener("change", (e) => {
    state.reminderMin = parseInt(e.target.value, 10);
    saveState();
  });
}

/* ============================================================
   CLOCK + HIJRI + MASIHI DATE
   ============================================================ */
function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  document.getElementById("clockTime").textContent = `${hh}:${mm}`;

  const dayNames = ["Ahad","Isnin","Selasa","Rabu","Khamis","Jumaat","Sabtu"];
  const monthNames = ["Januari","Februari","Mac","April","Mei","Jun","Julai","Ogos","September","Oktober","November","Disember"];
  const masihiStr = `${dayNames[now.getDay()]}, ${now.getDate()} ${monthNames[now.getMonth()]} ${now.getFullYear()}`;
  document.getElementById("dateMasihi").textContent = masihiStr;
  document.getElementById("dateHijri").textContent = gregorianToHijriString(now);

  if (prayerData) updateHeroAndList(now);
}

// Hijri conversion (Umm al-Qura-ish tabular approximation, Kuwaiti algorithm)
function gregorianToHijriString(date) {
  const hijriMonths = ["Muharram","Safar","Rabiulawal","Rabiulakhir","Jamadilawal","Jamadilakhir","Rejab","Syaaban","Ramadan","Syawal","Zulkaedah","Zulhijjah"];
  const { hy, hm, hd } = gregorianToHijri(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return `${hd} ${hijriMonths[hm - 1]} ${hy}H`;
}

// Kuwaiti algorithm for Gregorian -> Hijri (widely used approximation, +/-1 day accuracy vs official sighting)
function gregorianToHijri(gy, gm, gd) {
  let jd = gregorianToJD(gy, gm, gd);
  jd = Math.floor(jd) + 0.5;
  const l = Math.floor(jd) - 1948440 + 10632;
  const n = Math.floor((l - 1) / 10631);
  let l2 = l - 10631 * n + 354;
  const j = Math.floor((10985 - l2) / 5316) * Math.floor((50 * l2) / 17719) + Math.floor(l2 / 5670) * Math.floor((43 * l2) / 15238);
  l2 = l2 - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  const hm = Math.floor((24 * l2) / 709);
  const hd = l2 - Math.floor((709 * hm) / 24);
  const hy = 30 * n + j - 30;
  return { hy, hm, hd };
}
function gregorianToJD(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

let lastDateStr = null;
function checkDateRollover() {
  const now = new Date();
  const ds = now.toDateString();
  if (lastDateStr && lastDateStr !== ds) {
    notifiedToday.clear();
    fetchPrayerTimes();
  }
  lastDateStr = ds;
}

/* ============================================================
   FETCH PRAYER TIMES FROM JAKIM (via api.waktusolat.app)
   ============================================================ */
async function fetchPrayerTimes() {
  const now = new Date();
  const dateKey = `${state.zoneCode}_${now.toISOString().slice(0,10)}`;

  if (prayerCache[dateKey]) {
    prayerData = prayerCache[dateKey];
    updateHeroAndList(new Date());
    return;
  }

  try {
    const url = `https://api.waktusolat.app/v2/solat/${state.zoneCode}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();

    // v2 API returns { zone, year, month, ..., prayers: [ {day, hijri, fajr, syuruk, dhuhr, asr, maghrib, isha, ...}, ... ] }
    const todayNum = now.getDate();
    const todayEntry = (json.prayers || []).find(p => p.day === todayNum);
    if (!todayEntry) throw new Error("Tiada data untuk hari ini");

    const toHHMM = (unixOrStr) => {
      if (typeof unixOrStr === "number") {
        const d = new Date(unixOrStr * 1000);
        return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      }
      return unixOrStr;
    };

    prayerData = {
      imsak: subtractMinutes(toHHMM(todayEntry.fajr), 10),
      subuh: toHHMM(todayEntry.fajr),
      syuruk: toHHMM(todayEntry.syuruk),
      zohor: toHHMM(todayEntry.dhuhr),
      asar: toHHMM(todayEntry.asr),
      maghrib: toHHMM(todayEntry.maghrib),
      isyak: toHHMM(todayEntry.isha)
    };
    prayerCache[dateKey] = prayerData;
    updateHeroAndList(new Date());
    showToast("Waktu solat dikemas kini");
  } catch (err) {
    console.error("Fetch error:", err);
    if (!prayerData) {
      // Show a clearly-labelled estimate so the UI is never blank, then keep trying real data
      prayerData = FALLBACK_PRAYER_DATA;
      updateHeroAndList(new Date());
    }
    showToast("Tiada sambungan — memaparkan anggaran waktu");
  }
}

function subtractMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m - mins, 0, 0);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

/* ============================================================
   HERO + LIST RENDERING
   ============================================================ */
function timeStrToDate(hhmm, base) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function updateHeroAndList(now) {
  if (!prayerData) return;

  const times = NOTIFY_PRAYERS.map(key => ({
    key, label: PRAYER_META.find(p => p.key === key).label,
    time: prayerData[key], date: timeStrToDate(prayerData[key], now)
  }));

  let current = null, next = null;
  for (let i = 0; i < times.length; i++) {
    if (now >= times[i].date) current = times[i];
    else { next = times[i]; break; }
  }
  if (!next) {
    // after isyak -> next is tomorrow's subuh (approx, just label)
    next = { key: "subuh", label: "Subuh", date: null };
  }

  const target = next.date ? next : null;
  const heroLabel = document.getElementById("heroLabel");
  const heroName = document.getElementById("heroName");
  const heroCountdown = document.getElementById("heroCountdown");
  const heroTime = document.getElementById("heroTime");

  heroLabel.textContent = "SETERUSNYA";
  heroName.textContent = next.label;
  heroTime.textContent = next.date ? formatTime12(prayerData[next.key]) : "";

  if (target) {
    const diffMs = target.date - now;
    const mins = Math.floor(diffMs / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    heroCountdown.innerHTML = diffMs > 0
      ? `Baki <b>${h > 0 ? h + " jam " : ""}${m} minit</b>`
      : `<b>Waktu ${next.label} telah masuk</b>`;
  } else {
    heroCountdown.textContent = "Menunggu waktu Subuh esok";
  }

  renderPrayerList(now, times);
  checkNotifications(now, times);
}

function formatTime12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2,"0")} ${period}`;
}

function renderPrayerList(now, times) {
  const list = document.getElementById("prayerList");
  list.innerHTML = "";

  PRAYER_META.forEach(meta => {
    const hhmm = prayerData[meta.key];
    const rowDate = timeStrToDate(hhmm, now);
    const isNotifyPrayer = NOTIFY_PRAYERS.includes(meta.key);
    const isCurrent = isNotifyPrayer && times.find(t => t.key === meta.key) &&
      now >= rowDate && isNextUnpassed(meta.key, times, now);
    const isPassed = now > rowDate && !isCurrent;

    const row = document.createElement("div");
    row.className = "prayer-row" + (isCurrent ? " active" : "") + (isPassed ? " passed" : "");
    row.innerHTML = `
      <div class="prayer-icon">${ICONS[meta.icon]}</div>
      <div class="prayer-name">${meta.label}</div>
      ${isCurrent ? '<span class="prayer-badge">SEKARANG</span>' : ""}
      <div class="prayer-time">${formatTime12(hhmm)}</div>
    `;
    list.appendChild(row);
  });
}

function isNextUnpassed(key, times, now) {
  // returns true if this key is the most recently passed notify-prayer (i.e. "current" prayer window)
  let current = null;
  for (const t of times) {
    if (now >= t.date) current = t.key;
  }
  return current === key;
}

/* ============================================================
   NOTIFICATIONS + AZAN
   ============================================================ */
async function requestNotifPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  return await Notification.requestPermission();
}

function checkNotifications(now, times) {
  if (!state.notifEnabled) return;

  times.forEach(t => {
    const diffSec = (t.date - now) / 1000;
    const reminderSec = state.reminderMin * 60;

    // Exact prayer time notification (within 30s window to catch the tick)
    const key = t.key + "_exact_" + now.toDateString();
    if (diffSec <= 0 && diffSec > -30 && !notifiedToday.has(key)) {
      notifiedToday.add(key);
      fireNotification(`Waktu ${t.label} telah masuk`, `Semoga Allah menerima ibadah anda.`);
      if (state.azanEnabled) playAzan();
    }

    // Reminder before prayer
    if (state.reminderMin > 0) {
      const remKey = t.key + "_rem_" + now.toDateString();
      if (diffSec <= reminderSec && diffSec > reminderSec - 30 && !notifiedToday.has(remKey)) {
        notifiedToday.add(remKey);
        fireNotification(`${state.reminderMin} minit lagi ke waktu ${t.label}`, `Bersedia untuk solat.`);
      }
    }
  });
}

function fireNotification(title, body) {
  if (Notification.permission !== "granted") return;
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, {
          body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [200,100,200]
        });
      });
    } else {
      new Notification(title, { body, icon: "icons/icon-192.png" });
    }
  } catch (e) { console.error(e); }
}

// Play the real azan recording. Falls back to a short chime if the audio file can't play
// (e.g. blocked by browser autoplay policy before first user interaction).
let azanCtx = null;
let azanUnlocked = false;

function unlockAzanAudio() {
  // Call this on any user tap so iOS/Android allow later programmatic playback
  if (azanUnlocked) return;
  const audio = document.getElementById("azanAudio");
  audio.src = "audio/azan.mp3";
  audio.volume = 0;
  audio.play().then(() => {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    azanUnlocked = true;
  }).catch(() => { /* still locked, will try again on next tap */ });
}

function playAzan() {
  showToast("🕌 Waktu solat telah masuk");
  const audio = document.getElementById("azanAudio");
  audio.src = "audio/azan.mp3";
  audio.volume = 1;
  audio.currentTime = 0;
  const p = audio.play();
  if (p && p.catch) {
    p.catch(err => {
      console.error("Azan playback blocked, using fallback chime:", err);
      playChime();
    });
  }
}
function testAzan() {
  const audio = document.getElementById("azanAudio");
  if (!audio.paused) {
    stopAzan();
    showToast("Azan dihentikan");
    return;
  }
  showToast("🔊 Menguji bunyi azan");
  audio.src = "audio/azan.mp3";
  audio.volume = 1;
  audio.currentTime = 0;
  const p = audio.play();
  if (p && p.catch) {
    p.catch(err => {
      console.error("Azan playback blocked, using fallback chime:", err);
      playChime();
    });
  }
}
function stopAzan() {
  const audio = document.getElementById("azanAudio");
  audio.pause();
  audio.currentTime = 0;
}
function playChime() {
  try {
    azanCtx = azanCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = [660, 784, 660, 587, 660];
    notes.forEach((freq, i) => {
      const t = azanCtx.currentTime + i * 0.35;
      const osc = azanCtx.createOscillator();
      const gain = azanCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
      gain.gain.linearRampToValueAtTime(0, t + 0.32);
      osc.connect(gain).connect(azanCtx.destination);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  } catch (e) { console.error("Audio error", e); }
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function switchPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));

  if (name === "qibla") setTimeout(drawCompassBase, 50);
}

/* ============================================================
   ZONE PICKER
   ============================================================ */
function openZonePicker() {
  document.getElementById("zoneModal").classList.add("show");
  document.getElementById("zoneSearch").value = "";
  renderZoneList("");
}
function closeZonePicker() {
  document.getElementById("zoneModal").classList.remove("show");
}
function renderZoneList(query) {
  const q = query.trim().toLowerCase();
  const listEl = document.getElementById("zoneList");
  const filtered = ZONES.filter(z =>
    z.state.toLowerCase().includes(q) || z.area.toLowerCase().includes(q) || z.code.toLowerCase().includes(q)
  );
  listEl.innerHTML = filtered.map(z => `
    <div class="zone-item" onclick="selectZone('${z.code}', '${z.state.replace(/'/g,"")} — ${z.area.replace(/'/g,"")}')">
      <div class="z-state">${z.state} <span class="z-code">${z.code}</span></div>
      <div class="z-area">${z.area}</div>
    </div>
  `).join("") || `<div style="padding:20px 0;color:var(--text-tertiary);text-align:center;">Tiada hasil carian</div>`;
}
function selectZone(code, label) {
  state.zoneCode = code;
  state.zoneLabel = label;
  saveState();
  document.getElementById("locationLabel").textContent = label;
  document.getElementById("settingsZoneLabel").textContent = label;
  document.getElementById("zoneSub").textContent = label;
  closeZonePicker();
  showToast("Zon ditukar ke " + label.split(" — ")[0]);
  fetchPrayerTimes();
}

/* ============================================================
   GEOLOCATION (for qibla distance + auto zone hint)
   ============================================================ */
function tryGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.lat = pos.coords.latitude;
      state.lng = pos.coords.longitude;
      saveState();
      updateQiblaNumbers();
    },
    () => { /* silent fail, user can still use zone picker */ },
    { enableHighAccuracy: false, timeout: 8000 }
  );
}

/* ============================================================
   QIBLA COMPASS
   ============================================================ */
const KAABA = { lat: 21.4225, lng: 39.8262 };

function computeQiblaBearing(lat, lng) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const phi1 = toRad(lat), phi2 = toRad(KAABA.lat);
  const dLambda = toRad(KAABA.lng - lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

let qiblaBearingDeg = null;
let currentHeading = 0;

function updateQiblaNumbers() {
  if (state.lat == null) return;
  qiblaBearingDeg = computeQiblaBearing(state.lat, state.lng);
  const dist = haversineKm(state.lat, state.lng, KAABA.lat, KAABA.lng);
  document.getElementById("qiblaBearing").textContent = Math.round(qiblaBearingDeg) + "°";
  document.getElementById("qiblaDistance").textContent = Math.round(dist).toLocaleString() + " km";
  drawCompassBase();
}

function drawCompassBase() {
  const wrap = document.getElementById("qiblaCompass");
  const size = 280;
  const cx = size/2, cy = size/2, r = size/2 - 14;

  const needleAngle = qiblaBearingDeg != null ? (qiblaBearingDeg - currentHeading) : 0;

  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <defs>
        <radialGradient id="compassBg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.06)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0.01)"/>
        </radialGradient>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#compassBg)" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>
      ${[0,45,90,135,180,225,270,315].map(deg => {
        const rad = (deg - currentHeading) * Math.PI/180;
        const x1 = cx + Math.sin(rad) * (r-6), y1 = cy - Math.cos(rad) * (r-6);
        const x2 = cx + Math.sin(rad) * (r-16), y2 = cy - Math.cos(rad) * (r-16);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>`;
      }).join("")}
      ${["U","T","S","B"].map((label,i) => {
        const deg = i*90;
        const rad = (deg - currentHeading) * Math.PI/180;
        const x = cx + Math.sin(rad) * (r-32), y = cy - Math.cos(rad) * (r-32);
        return `<text x="${x}" y="${y+5}" text-anchor="middle" fill="${i===0?'#0a84ff':'rgba(255,255,255,0.5)'}" font-size="15" font-weight="700" font-family="-apple-system,sans-serif">${label}</text>`;
      }).join("")}
      <g transform="rotate(${needleAngle} ${cx} ${cy})">
        <polygon points="${cx},${cy-r+30} ${cx-9},${cy-6} ${cx+9},${cy-6}" fill="#dfbe6a"/>
        <polygon points="${cx},${cy+r-30} ${cx-7},${cy+6} ${cx+7},${cy+6}" fill="rgba(255,255,255,0.3)"/>
        <circle cx="${cx}" cy="${cy}" r="9" fill="#dfbe6a"/>
      </g>
      <circle cx="${cx}" cy="${cy}" r="3" fill="#fff"/>
    </svg>
  `;

  const statusEl = document.getElementById("qiblaStatus");
  if (qiblaBearingDeg == null) {
    statusEl.textContent = "Dapatkan lokasi anda untuk kira arah kiblat";
    statusEl.className = "qibla-status";
  } else {
    const diff = Math.abs(((qiblaBearingDeg - currentHeading + 540) % 360) - 180);
    if (diff < 8) {
      statusEl.textContent = "✓ Sejajar dengan Kiblat";
      statusEl.className = "qibla-status aligned";
    } else {
      statusEl.textContent = "Pusing telefon anda ke arah anak panah emas";
      statusEl.className = "qibla-status";
    }
  }
}

function requestCompassPermission() {
  const btn = document.getElementById("qiblaPermBtn");

  const start = () => {
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    btn.style.display = "none";
    if (!navigator.geolocation) {
      showToast("GPS tidak disokong pada peranti ini");
    } else if (state.lat == null) {
      tryGeolocation();
    } else {
      updateQiblaNumbers();
    }
  };

  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission().then(resp => {
      if (resp === "granted") start();
      else showToast("Kebenaran kompas ditolak");
    }).catch(() => showToast("Ralat meminta kebenaran kompas"));
  } else {
    start();
  }
}

function onOrientation(e) {
  let heading;
  if (typeof e.webkitCompassHeading === "number") {
    heading = e.webkitCompassHeading; // iOS Safari gives true compass heading directly
  } else if (e.absolute && e.alpha != null) {
    heading = 360 - e.alpha;
  } else if (e.alpha != null) {
    heading = 360 - e.alpha;
  } else {
    return;
  }
  currentHeading = heading;
  drawCompassBase();
}

/* ============================================================
   SERVICE WORKER + INSTALL PROMPT
   ============================================================ */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(e => console.error("SW register failed", e));
    });
  }
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById("installBanner").style.display = "flex";
  });
  window.addEventListener("appinstalled", () => {
    document.getElementById("installBanner").style.display = "none";
    showToast("Aplikasi berjaya dipasang!");
  });

  // iOS Safari has no beforeinstallprompt - show manual instructions if not standalone
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !isStandalone) {
    document.getElementById("installBanner").style.display = "flex";
  }
}

function triggerInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; });
  } else {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      showToast("Tekan Kongsi ⬆️ lalu 'Tambah ke Skrin Utama'");
    } else {
      showToast("Buka menu pelayar dan pilih 'Pasang Aplikasi'");
    }
  }
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ═══════════════ YY CLUB 播客播放器 ═══════════════ */
"use strict";

/* ---------- 全局状态 ---------- */
const S = {
  eps: [],
  cur: -1,
  order: [],
  desc: true,
  query: "",
  rate: 1,
  userScrubbing: false,
  specC1: "#6366f1",
  specC2: "#a855f7",
};

const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* 移动端直连播放：Web Audio 会在锁屏/后台时被系统挂起导致停播，
   故手机/平板不走频谱图，直接 <audio> 输出以保证锁屏持续播放 */
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/* ---------- Web Audio 频谱 ---------- */
let actx = null, analyser = null, srcNode = null, gainNode = null;
let freqData = null;

function ensureGraph() {
  if (isMobile) return;
  if (actx) { if (actx.state === "suspended") actx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC();
  srcNode = actx.createMediaElementSource(audio);
  analyser = actx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;
  gainNode = actx.createGain();
  gainNode.gain.value = $("volume").value / 100;
  srcNode.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(actx.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
}

const BAR_N = 48;
const bars = new Float32Array(BAR_N);

function sampleBars() {
  if (!analyser) { bars.fill(0); return; }
  analyser.getByteFrequencyData(freqData);
  const usable = Math.floor(freqData.length * 0.72);
  for (let i = 0; i < BAR_N; i++) {
    const t0 = Math.pow(i / BAR_N, 1.7) * usable;
    const t1 = Math.pow((i + 1) / BAR_N, 1.7) * usable;
    let sum = 0, n = 0;
    for (let j = Math.floor(t0); j < Math.max(Math.floor(t1), Math.floor(t0) + 1); j++) { sum += freqData[j]; n++; }
    const v = n ? sum / n / 255 : 0;
    const shaped = Math.pow(v, 1.25);
    bars[i] += (shaped - bars[i]) * (shaped > bars[i] ? 0.55 : 0.16);
  }
}

/* ---------- 工具 ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function gradFor(i) {
  const h1 = (i * 137.508) % 360;
  const h2 = (h1 + 42) % 360;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    css: `linear-gradient(135deg, hsl(${h1} 62% 52%), hsl(${h2} 68% 42%))`,
    accent: `hsl(${h1} 72% ${dark ? 62 : 46}%)`,
    c1: `hsl(${h1} 78% ${dark ? 66 : 56}%)`,
    c2: `hsl(${h2} 74% ${dark ? 56 : 44}%)`,
  };
}

/* ---------- 单集列表渲染 ---------- */
function renderList() {
  const list = $("episodeList");
  const q = S.query.trim().toLowerCase();
  let idx = S.eps.map((e, i) => i);
  idx.sort((a, b) => S.desc ? S.eps[b].num - S.eps[a].num : S.eps[a].num - S.eps[b].num);
  if (q) idx = idx.filter(i => String(S.eps[i].num).includes(q) || S.eps[i].title.toLowerCase().includes(q));
  S.order = idx;
  $("listEmpty").hidden = idx.length > 0;

  list.innerHTML = idx.map(i => {
    const e = S.eps[i], g = gradFor(e.num);
    const pos = getPos(e.id);
    const pct = pos && e.dur ? Math.min(pos / e.dur * 100, 100) : 0;
    const isCur = i === S.cur;
    return `<button class="ep-row ${isCur ? "playing" : ""}" data-i="${i}" role="listitem">
      <span class="ep-art" style="background:${g.css}">${e.num}</span>
      <span class="ep-info">
        <span class="ep-title">${e.title}${isCur ? '<span class="now-badge">正在播放</span>' : ""}</span>
        <span class="ep-meta">YY CLUB<span class="dot"></span>${fmt(e.dur)}</span>
        ${pct > 1 && pct < 99 ? `<span class="ep-progress-track"><i style="width:${pct}%"></i></span>` : ""}
      </span>
      <span class="ep-play-btn">
        <svg class="icon-play" viewBox="0 0 24 24" style="display:${isCur && !audio.paused ? "none" : "block"}"><path d="M8 5.5v13c0 .8.9 1.3 1.6.9l10-6.5c.6-.4.6-1.4 0-1.8l-10-6.5c-.7-.4-1.6.1-1.6.9z"/></svg>
        <svg class="icon-pause" viewBox="0 0 24 24" style="display:${isCur && !audio.paused ? "block" : "none"}"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>
      </span>
    </button>`;
  }).join("");
}

/* ---------- 播放记忆 ---------- */
const store = {
  read() { try { return JSON.parse(localStorage.getItem("yyclub") || "{}"); } catch { return {}; } },
  write(d) { try { localStorage.setItem("yyclub", JSON.stringify(d)); } catch {} },
};
function savePos() {
  if (S.cur < 0) return;
  const d = store.read();
  d.last = S.eps[S.cur].id;
  d.pos = d.pos || {};
  d.pos[S.eps[S.cur].id] = Math.floor(audio.currentTime);
  store.write(d);
}
function getPos(id) { const d = store.read(); return d.pos && d.pos[id] || 0; }

/* ---------- 载入并播放单集 ---------- */
function loadEpisode(i, autoplay = true, restorePos = true) {
  if (i < 0 || i >= S.eps.length) return;
  const sameAsCur = i === S.cur;
  S.cur = i;
  const e = S.eps[i];
  const g = gradFor(e.num);
  document.documentElement.style.setProperty("--player-tint", g.accent);
  S.specC1 = g.c1; S.specC2 = g.c2; specGrad = null;

  if (!sameAsCur) {
    audio.src = e.src;
    audio.playbackRate = S.rate;
  }

  $("miniTitle").textContent = e.title;
  $("miniSub").textContent = `YY CLUB · ${fmt(e.dur)}`;
  $("miniArt").style.background = g.css;
  $("miniArt").textContent = e.num;
  $("fpTitle").textContent = e.title;
  $("fpSub").textContent = "YY CLUB 播客";
  $("fpArt").style.background = g.css;
  $("fpArt").innerHTML = `<span class="art-num">${pad2(e.num)}</span><span class="art-label">YY CLUB</span>`;
  $("fpBg").style.background = g.css;
  $("aboutText").textContent = `YY CLUB 电台第 ${e.num} 期节目。戴上耳机，沉浸收听。`;
  $("aboutMeta").textContent = `时长 ${fmt(e.dur)} · AAC 高品质音质`;
  $("miniPlayer").hidden = false;

  // 迷你 EQ 渐变着色（跨 4 根条的整体渐变）
  const eqBars = $("miniEq").children;
  const eqW = 20, gap = 2.5, bw = (eqW - gap * (eqBars.length - 1)) / eqBars.length;
  for (let k = 0; k < eqBars.length; k++) {
    eqBars[k].style.backgroundImage = `linear-gradient(90deg, ${g.c1}, ${g.c2})`;
    eqBars[k].style.backgroundSize = `${eqW}px 100%`;
    eqBars[k].style.backgroundPositionX = `-${(k * (bw + gap)).toFixed(2)}px`;
  }

  const resume = restorePos ? getPos(e.id) : 0;
  const start = () => {
    if (resume > 3 && resume < (e.dur || Infinity) - 3) audio.currentTime = resume;
    if (autoplay) play();
    updateTimes();
  };
  if (audio.readyState >= 1) start();
  else audio.addEventListener("loadedmetadata", start, { once: true });

  renderList();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: e.title, artist: "YY CLUB", album: "YY CLUB 播客" });
  }
}

/* ---------- 切换单集 ---------- */
function stepEpisode(d) {
  if (!S.order.length) return;
  let pos = S.order.indexOf(S.cur);
  if (pos < 0) pos = 0;
  const n = (pos + d + S.order.length) % S.order.length;
  loadEpisode(S.order[n], true, false);
}

/* ---------- 播放控制 ---------- */
function play() { ensureGraph(); audio.play().catch(() => {}); }
function pause() { audio.pause(); savePos(); }
function togglePlay() {
  if (S.cur < 0) { if (S.eps.length) loadEpisode(S.order[0] ?? 0, true, true); return; }
  audio.paused ? play() : pause();
}
function seekBy(d) { if (audio.src) audio.currentTime = Math.max(0, Math.min((audio.duration || 0), audio.currentTime + d)); }

function syncPlayIcons() {
  const playing = !audio.paused && !audio.ended;
  [["miniPlay"], ["btnPlay"]].forEach(([id]) => {
    const b = $(id);
    b.querySelector(".icon-play").style.display = playing ? "none" : "block";
    b.querySelector(".icon-pause").style.display = playing ? "block" : "none";
  });
  document.querySelectorAll(".ep-row").forEach(r => {
    const i = +r.dataset.i;
    const showPause = i === S.cur && playing;
    const p = r.querySelector(".ep-play-btn");
    p.querySelector(".icon-play").style.display = showPause ? "none" : "block";
    p.querySelector(".icon-pause").style.display = showPause ? "block" : "none";
  });
}

/* ---------- 进度条 ---------- */
function updateTimes() {
  const d = audio.duration || (S.eps[S.cur] && S.eps[S.cur].dur) || 0;
  const c = audio.currentTime || 0;
  $("timeCur").textContent = fmt(c);
  $("timeRemain").textContent = "-" + fmt(Math.max(d - c, 0));
  if (!S.userScrubbing && d) {
    const v = c / d * 1000;
    $("scrubber").value = v;
    $("scrubber").style.setProperty("--val", (v / 10) + "%");
  }
  $("miniProgress").firstElementChild.style.width = d ? (c / d * 100) + "%" : "0";
}

/* ---------- 频谱渲染循环（渐变色） ---------- */
const canvas = $("fpSpectrum"), c2d = canvas.getContext("2d");
let rafId = null, specGrad = null, specGradW = 0;

function drawSpectrum() {
  sampleBars();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  c2d.clearRect(0, 0, W, H);

  if (!specGrad || specGradW !== W) {
    specGrad = c2d.createLinearGradient(0, 0, W, 0);
    specGrad.addColorStop(0, S.specC1);
    specGrad.addColorStop(1, S.specC2);
    specGradW = W;
  }
  c2d.fillStyle = specGrad;

  const gap = W * 0.006, bw = (W - gap * (BAR_N - 1)) / BAR_N;
  const idle = audio.paused;
  for (let i = 0; i < BAR_N; i++) {
    const h = Math.max(H * 0.045, bars[i] * H * 0.96);
    const x = i * (bw + gap), y = (H - h) / 2;
    c2d.globalAlpha = idle ? 0.4 : 0.95;
    c2d.beginPath();
    c2d.roundRect(x, y, bw, h, bw / 2);
    c2d.fill();
  }
  c2d.globalAlpha = 1;

  const eq = $("miniEq").children;
  for (let k = 0; k < eq.length; k++) {
    const v = idle ? 0.12 : Math.max(0.12, bars[Math.floor(k * BAR_N / eq.length / 2) * 2]);
    eq[k].style.height = (v * 100) + "%";
  }
}
function loop() { drawSpectrum(); rafId = requestAnimationFrame(loop); }

/* ---------- 全屏播放器开合 ---------- */
function openFull() {
  if (S.cur < 0) return;
  const fp = $("fullPlayer");
  fp.classList.remove("closing");
  fp.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeFull() {
  const fp = $("fullPlayer");
  if (fp.hidden) return;
  fp.classList.add("closing");
  setTimeout(() => { fp.hidden = true; fp.classList.remove("closing"); }, 290);
  document.body.style.overflow = "";
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $("episodeList").addEventListener("click", (ev) => {
    const row = ev.target.closest(".ep-row");
    if (!row) return;
    const i = +row.dataset.i;
    if (i === S.cur) togglePlay();
    else loadEpisode(i, true, true);
  });
  $("episodeList").addEventListener("dblclick", (ev) => {
    const row = ev.target.closest(".ep-row");
    if (row) { loadEpisode(+row.dataset.i, true, true); openFull(); }
  });

  $("searchInput").addEventListener("input", (e) => { S.query = e.target.value; renderList(); });
  $("sortBtn").addEventListener("click", () => {
    S.desc = !S.desc;
    $("sortLabel").textContent = S.desc ? "最新优先" : "最早优先";
    $("sortBtn").classList.toggle("asc", !S.desc);
    renderList();
  });

  $("miniPlay").addEventListener("click", togglePlay);
  $("miniFwd").addEventListener("click", () => seekBy(15));
  $("miniInfo").addEventListener("click", openFull);
  $("miniArt").addEventListener("click", openFull);
  $("fpCollapse").addEventListener("click", closeFull);
  $("fpHandleArea").addEventListener("click", closeFull);

  $("btnPlay").addEventListener("click", togglePlay);
  $("btnBack").addEventListener("click", () => seekBy(-15));
  $("btnFwd").addEventListener("click", () => seekBy(15));
  $("btnPrev").addEventListener("click", () => stepEpisode(-1));
  $("btnNext").addEventListener("click", () => stepEpisode(1));

  const scr = $("scrubber");
  scr.addEventListener("input", () => {
    S.userScrubbing = true;
    const d = audio.duration || 0;
    scr.style.setProperty("--val", (scr.value / 10) + "%");
    $("timeCur").textContent = fmt(scr.value / 1000 * d);
  });
  scr.addEventListener("change", () => {
    if (audio.duration) audio.currentTime = scr.value / 1000 * audio.duration;
    S.userScrubbing = false;
  });

  $("volume").addEventListener("input", (e) => {
    const v = e.target.value / 100;
    if (gainNode) gainNode.gain.value = v;
    else audio.volume = v;
  });

  /* 倍速菜单 */
  const rateBtn = $("rateBtn"), rateMenu = $("rateMenu");
  rateBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = rateMenu.hidden;
    rateMenu.hidden = !willOpen;
    rateBtn.setAttribute("aria-expanded", String(willOpen));
  });
  rateMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rate]");
    if (!b) return;
    S.rate = parseFloat(b.dataset.rate);
    audio.playbackRate = S.rate;
    $("rateLabel").textContent = b.dataset.rate.replace(/\.?0+$/, "") + "×";
    rateMenu.querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    rateMenu.hidden = true;
    rateBtn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".rate-wrap")) {
      rateMenu.hidden = true;
      rateBtn.setAttribute("aria-expanded", "false");
    }
  });

  audio.addEventListener("play", () => { ensureGraph(); syncPlayIcons(); });
  audio.addEventListener("pause", () => { syncPlayIcons(); savePos(); });
  audio.addEventListener("ended", () => {
    savePos();
    const pos = S.order.indexOf(S.cur);
    if (pos >= 0 && pos + 1 < S.order.length) loadEpisode(S.order[pos + 1], true, false);
  });
  audio.addEventListener("timeupdate", updateTimes);

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "search") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight") seekBy(e.shiftKey ? 30 : 15);
    else if (e.code === "ArrowLeft") seekBy(e.shiftKey ? -30 : -15);
    else if (e.code === "Escape" && !$("fullPlayer").hidden) closeFull();
  });

  setInterval(savePos, 5000);
  addEventListener("pagehide", savePos);

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("previoustrack", () => stepEpisode(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => stepEpisode(1));
  }
}

/* ---------- 启动 ---------- */
(async function init() {
  try {
    const r = await fetch("episodes.json", { cache: "no-cache" });
    S.eps = await r.json();
  } catch {
    $("episodeList").innerHTML = '<div class="list-empty">单集数据加载失败</div>';
    return;
  }
  $("totalCount").textContent = S.eps.length;
  $("brandSub").textContent = `播客电台 · ${S.eps.length} 期节目`;
  bind();
  renderList();
  loop();

  const d = store.read();
  if (d.last) {
    const i = S.eps.findIndex(e => e.id === d.last);
    if (i >= 0) loadEpisode(i, false, true);
  }
})();

/* ═══════════════ YY CLUB 播客播放器 ═══════════════ */
"use strict";

/* ---------- 全局状态 ---------- */
const S = {
  eps: [],            // 单集数据
  cur: -1,            // 当前单集索引（按原始顺序）
  order: [],          // 当前展示顺序
  desc: true,         // 最新优先
  query: "",
  rate: 1,
  cues: [],           // 当前字幕
  activeCue: -2,
  userScrubbing: false,
  transcriptLoadedFor: -1,
};

const $ = (id) => document.getElementById(id);
const audio = $("audio");

/* ---------- Web Audio 频谱 ---------- */
let actx = null, analyser = null, srcNode = null, gainNode = null;
let freqData = null;

function ensureGraph() {
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

/* 频谱条带平滑值 */
const BAR_N = 48;
const bars = new Float32Array(BAR_N);

function sampleBars() {
  if (!analyser) { bars.fill(0); return; }
  analyser.getByteFrequencyData(freqData);
  const usable = Math.floor(freqData.length * 0.72); // 高频尾部能量低，截掉
  for (let i = 0; i < BAR_N; i++) {
    // 对数分布，低音部细节更多
    const t0 = Math.pow(i / BAR_N, 1.7) * usable;
    const t1 = Math.pow((i + 1) / BAR_N, 1.7) * usable;
    let sum = 0, n = 0;
    for (let j = Math.floor(t0); j < Math.max(Math.floor(t1), Math.floor(t0) + 1); j++) { sum += freqData[j]; n++; }
    const v = n ? sum / n / 255 : 0;
    const shaped = Math.pow(v, 1.25);
    bars[i] += (shaped - bars[i]) * (shaped > bars[i] ? 0.55 : 0.16); // 快攻慢放
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
  return {
    css: `linear-gradient(135deg, hsl(${h1} 62% 52%), hsl(${h2} 68% 42%))`,
    accent: `hsl(${h1} 72% ${matchMedia("(prefers-color-scheme: dark)").matches ? 62 : 46}%)`,
    hue: h1,
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
        <span class="ep-meta">YY CLUB<span class="dot"></span>${fmt(e.dur)}${e.hasSub ? '<span class="dot"></span>含字幕' : ""}</span>
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

  if (!sameAsCur) {
    audio.src = e.src;
    audio.playbackRate = S.rate;
    S.cues = []; S.activeCue = -2; S.transcriptLoadedFor = -1;
    renderTranscript();
  }

  // 更新各视图
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
  $("aboutMeta").textContent = `时长 ${fmt(e.dur)} · AAC 高品质音质${e.hasSub ? " · AI 字幕已上线" : ""}`;
  $("miniPlayer").hidden = false;

  const resume = restorePos ? getPos(e.id) : 0;
  const start = () => {
    if (resume > 3 && resume < (e.dur || Infinity) - 3) audio.currentTime = resume;
    if (autoplay) play();
    updateTimes();
  };
  if (audio.readyState >= 1) start();
  else audio.addEventListener("loadedmetadata", start, { once: true });

  loadTranscript(i);
  renderList();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: e.title, artist: "YY CLUB", album: "YY CLUB 播客" });
  }
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

/* ---------- 字幕 ---------- */
function parseVTT(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, "").split("\n\n");
  for (const b of blocks) {
    const lines = b.trim().split("\n").filter(l => l.trim());
    if (!lines.length || lines[0].startsWith("WEBVTT") || lines[0].startsWith("NOTE")) continue;
    let tIdx = lines.findIndex(l => l.includes("-->"));
    if (tIdx < 0) continue;
    const m = lines[tIdx].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4]) / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + (+m[8]) / 1000;
    const text2 = lines.slice(tIdx + 1).join(" ").trim();
    if (text2) cues.push({ start, end, text: text2 });
  }
  return cues;
}

async function loadTranscript(i) {
  if (S.transcriptLoadedFor === i) return;
  S.transcriptLoadedFor = i;
  const e = S.eps[i];
  try {
    const r = await fetch(e.sub, { cache: "no-cache" });
    if (!r.ok) throw 0;
    S.cues = parseVTT(await r.text());
    if (!S.cues.length) throw 0;
    e.hasSub = true;
  } catch {
    S.cues = [];
    e.hasSub = false;
  }
  S.activeCue = -2;
  renderTranscript();
  renderList();
}

function renderTranscript() {
  const list = $("transcriptList"), empty = $("transcriptEmpty");
  if (!S.cues.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = S.cues.map((c, i) =>
    `<button class="ts-line" data-c="${i}"><span class="ts-time">${fmt(c.start)}</span>${c.text}</button>`
  ).join("");
}

function syncTranscript() {
  if (!S.cues.length || $("panelTranscript").hidden) return;
  const t = audio.currentTime;
  // 二分查找当前句
  let lo = 0, hi = S.cues.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < S.cues[mid].start) hi = mid - 1;
    else if (t > S.cues[mid].end) lo = mid + 1;
    else { hit = mid; break; }
  }
  if (hit === -1) hit = t < S.cues[0].start ? -1 : Math.min(lo, S.cues.length - 1);
  if (hit === S.activeCue) return;
  S.activeCue = hit;
  document.querySelectorAll(".ts-line.active").forEach(n => n.classList.remove("active"));
  if (hit >= 0) {
    const el = document.querySelector(`.ts-line[data-c="${hit}"]`);
    if (el) {
      el.classList.add("active");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

/* ---------- 频谱渲染循环 ---------- */
const canvas = $("fpSpectrum"), c2d = canvas.getContext("2d");
let rafId = null;

function drawSpectrum() {
  sampleBars();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  c2d.clearRect(0, 0, W, H);
  const gap = W * 0.006, bw = (W - gap * (BAR_N - 1)) / BAR_N;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--player-tint").trim() || "#6366f1";
  c2d.fillStyle = accent;
  const idle = audio.paused;
  for (let i = 0; i < BAR_N; i++) {
    const h = Math.max(H * 0.045, bars[i] * H * 0.96);
    const x = i * (bw + gap), y = (H - h) / 2;
    c2d.globalAlpha = idle ? 0.28 : 0.95;
    c2d.beginPath();
    c2d.roundRect(x, y, bw, h, bw / 2);
    c2d.fill();
  }
  c2d.globalAlpha = 1;

  // 迷你条
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
  $("miniFwd").addEventListener("click", () => seekBy(30));
  $("miniInfo").addEventListener("click", openFull);
  $("miniArt").addEventListener("click", openFull);
  $("fpClose").addEventListener("click", closeFull);
  $("fpHandleArea").addEventListener("click", closeFull);

  $("btnPlay").addEventListener("click", togglePlay);
  $("btnBack").addEventListener("click", () => seekBy(-15));
  $("btnFwd").addEventListener("click", () => seekBy(30));

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

  const RATES = [1, 1.25, 1.5, 2, 0.8];
  $("rateBtn").addEventListener("click", () => {
    S.rate = RATES[(RATES.indexOf(S.rate) + 1) % RATES.length];
    audio.playbackRate = S.rate;
    $("rateBtn").textContent = (S.rate === 0.8 ? "0.8" : S.rate) + "×";
  });

  document.querySelectorAll(".fp-tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".fp-tab").forEach(x => x.classList.toggle("active", x === t));
    const isTs = t.dataset.tab === "transcript";
    $("panelAbout").hidden = isTs;
    $("panelTranscript").hidden = !isTs;
    if (isTs) { S.activeCue = -2; syncTranscript(); }
  }));

  $("transcriptList").addEventListener("click", (ev) => {
    const line = ev.target.closest(".ts-line");
    if (!line) return;
    const c = S.cues[+line.dataset.c];
    if (c) { audio.currentTime = c.start + 0.01; play(); }
  });

  audio.addEventListener("play", () => { ensureGraph(); syncPlayIcons(); });
  audio.addEventListener("pause", () => { syncPlayIcons(); savePos(); });
  audio.addEventListener("ended", () => {
    savePos();
    const pos = S.order.indexOf(S.cur);
    if (pos >= 0 && pos + 1 < S.order.length) loadEpisode(S.order[pos + 1], true, false);
  });
  audio.addEventListener("timeupdate", () => { updateTimes(); syncTranscript(); });

  // 键盘
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "search") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight") seekBy(e.shiftKey ? 30 : 15);
    else if (e.code === "ArrowLeft") seekBy(e.shiftKey ? -30 : -15);
    else if (e.code === "Escape" && !$("fullPlayer").hidden) closeFull();
  });

  setInterval(savePos, 5000);
  addEventListener("pagehide", savePos);

  // Media Session
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("previoustrack", () => seekBy(-15));
    navigator.mediaSession.setActionHandler("nexttrack", () => seekBy(30));
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
  loop(); // 频谱渲染循环常驻（无音频时显示静态底条）

  // 恢复上次收听
  const d = store.read();
  if (d.last) {
    const i = S.eps.findIndex(e => e.id === d.last);
    if (i >= 0) loadEpisode(i, false, true);
  }
})();

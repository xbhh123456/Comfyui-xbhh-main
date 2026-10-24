import { app } from "../../../scripts/app.js";

/**
 * 提示治理（Toast Tamer）
 *
 * 解决 ComfyUI 右上/右下的提示 toast 太烦人：
 *   1) 自动关闭：给“赖着不走”的提示补上存活时间（life），无需手动一个个点 ✕；
 *   2) 报错收纳：把 warn/error 提示按内容去重计数后存进“提示收件箱”（类似邮箱），
 *      随时回看历史报错、复制、清空，方便定位问题。
 *
 * 原理：ComfyUI 的 toast 是一个 Pinia store（app.extensionManager.toast），
 *       add(msg) 只是把消息对象推入队列，再由 GlobalToast 组件交给 PrimeVue 渲染。
 *       因此替换该 store 实例的 add 方法即可全局拦截所有提示：
 *         - 注入 life / 取消 sticky   → 自动关闭
 *         - 结构化读取 severity/summary/detail → 收纳
 *       若包装失败（极少数前端版本），退化为 MutationObserver 监听 .p-toast-message 兜底。
 */

const TAG = "[XBHH toast]";
const LS_SETTINGS = "xbhh_toastTamer.settings";
const LS_INBOX = "xbhh_toastTamer.inbox";
const INBOX_CAP = 200;
/** life 超过该值视为“常驻”，会被改写成设定值 */
const MAX_AUTO_LIFE = 60000;

const DEFAULTS = { autoClose: true, closeMs: 8000, inbox: true };

let settings = { ...DEFAULTS };
let inbox = [];
let unread = 0;

let panelEl = null;
let listEl = null;
let btnEl = null;
let badgeEl = null;
let autoCloseEl = null;
let lifeEl = null;
let domFallbackActive = false;

/* ────────────────────────── 持久化 ────────────────────────── */

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    console.warn(TAG, "读取设置失败", e);
  }
  if (!(settings.closeMs >= 2000)) settings.closeMs = DEFAULTS.closeMs;
}

function saveSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch (e) {
    /* 忽略配额错误 */
  }
}

function loadInbox() {
  try {
    const raw = localStorage.getItem(LS_INBOX);
    const parsed = raw ? JSON.parse(raw) : [];
    inbox = Array.isArray(parsed) ? parsed : [];
  } catch {
    inbox = [];
  }
}

function saveInbox() {
  try {
    localStorage.setItem(LS_INBOX, JSON.stringify(inbox.slice(0, INBOX_CAP)));
  } catch (e) {
    /* 忽略配额错误 */
  }
}

/* ────────────────────────── 收纳逻辑 ────────────────────────── */

function keyOf(m) {
  return [m.severity || "", m.summary || "", m.detail || ""].join("\u0000");
}

function collectible(m) {
  return m && (m.severity === "error" || m.severity === "warn");
}

function pushInbox(m) {
  if (!collectible(m)) return;
  const k = keyOf(m);
  const now = Date.now();
  const idx = inbox.findIndex((it) => it.k === k);
  if (idx >= 0) {
    const it = inbox[idx];
    // 1.5s 内重复出现的同一条，视为同一次事件，不重复计数
    if (now - (it.ts || 0) >= 1500) it.count = (it.count || 1) + 1;
    it.ts = now;
    inbox.splice(idx, 1);
    inbox.unshift(it);
  } else {
    inbox.unshift({
      k,
      severity: m.severity,
      summary: m.summary || "",
      detail: m.detail || "",
      ts: now,
      count: 1,
    });
    if (inbox.length > INBOX_CAP) inbox.length = INBOX_CAP;
  }
  saveInbox();
  if (panelEl && !panelEl.hidden && listEl) {
    renderList();
  } else {
    unread += 1;
    bumpBadge();
  }
}

/* ────────────────────────── 拦截 toast.add ────────────────────────── */

function installToastPatch() {
  const toast = app.extensionManager && app.extensionManager.toast;
  if (!toast || typeof toast.add !== "function") return false;
  if (toast.__xbhhTT) return true;

  const origAdd = toast.add.bind(toast);

  const wrapped = function (msg) {
    let m = msg;
    try {
      if (typeof m === "string") m = { detail: m, severity: "info" };
      else if (!m || typeof m !== "object") m = { detail: String(m), severity: "info" };

      if (settings.inbox) pushInbox(m);

      if (settings.autoClose) {
        const life = typeof m.life === "number" ? m.life : undefined;
        const persistent =
          m.sticky === true || life === undefined || life <= 0 || life > MAX_AUTO_LIFE;
        if (persistent) {
          m.sticky = false;
          m.life = Math.max(2000, settings.closeMs | 0);
        }
      }
    } catch (e) {
      console.warn(TAG, "处理提示失败", e);
    }
    return origAdd(m);
  };

  try {
    toast.add = wrapped;
    toast.__xbhhTT = true;
  } catch (e) {
    console.warn(TAG, "接管 toast.add 失败，改用 DOM 兜底", e);
    return false;
  }
  return true;
}

/* ────────────────────────── DOM 兜底（仅当无法接管时启用） ────────────────────────── */

function installDomFallback() {
  if (domFallbackActive || !document.body) return;
  domFallbackActive = true;
  console.log(TAG, "启用 DOM 兜底监听");

  const obs = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const els = node.matches(".p-toast-message")
          ? [node]
          : node.querySelectorAll(".p-toast-message");
        els.forEach(handleDomToast);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function handleDomToast(el) {
  if (!(el instanceof HTMLElement) || el.__xbhhTT) return;
  el.__xbhhTT = true;

  const sev = el.classList.contains("p-toast-message-error")
    ? "error"
    : el.classList.contains("p-toast-message-warn")
      ? "warn"
      : "info";

  if (settings.inbox && (sev === "error" || sev === "warn")) {
    const summary = el.querySelector(".p-toast-summary")?.textContent?.trim() || "";
    const detail = el.querySelector(".p-toast-detail")?.textContent?.trim() || "";
    pushInbox({ severity: sev, summary, detail });
  }

  if (!settings.autoClose) return;
  const life = Math.max(2000, settings.closeMs | 0);
  const fire = (delay) => {
    setTimeout(() => {
      if (!document.body.contains(el)) return;
      if (el.matches(":hover")) {
        fire(2000); // 鼠标停留时延后，避免打断阅读
        return;
      }
      const closeBtn = el.querySelector(
        ".p-toast-close-button, .p-toast-icon-close, button",
      );
      if (closeBtn instanceof HTMLElement) closeBtn.click();
      else el.remove();
    }, delay);
  };
  fire(life);
}

/* ────────────────────────── UI ────────────────────────── */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bumpBadge() {
  if (!badgeEl) return;
  if (unread > 0) {
    badgeEl.textContent = unread > 99 ? "99+" : String(unread);
    badgeEl.style.display = "";
  } else {
    badgeEl.style.display = "none";
  }
}

function renderList() {
  if (!listEl) return;
  if (!inbox.length) {
    listEl.innerHTML = '<div class="xbhh-tt-empty">暂无报错记录</div>';
    return;
  }
  listEl.innerHTML = inbox
    .map((it) => {
      const sev = it.severity === "error" ? "error" : "warn";
      const count = it.count > 1 ? `<span class="xbhh-tt-count">×${it.count}</span>` : "";
      const sum = it.summary ? `<span class="xbhh-tt-sum">${esc(it.summary)}</span>` : "";
      const detail = it.detail
        ? `<div class="xbhh-tt-detail">${esc(it.detail)}</div>`
        : "";
      return (
        `<div class="xbhh-tt-item" data-sev="${sev}" data-k="${esc(it.k)}">` +
        `<div class="xbhh-tt-item-top">` +
        `<span class="xbhh-tt-dot"></span>` +
        `<span class="xbhh-tt-time">${fmtTime(it.ts)}</span>` +
        `${count}${sum}` +
        `<button class="xbhh-tt-copy" type="button" title="复制此条">复制</button>` +
        `</div>${detail}</div>`
      );
    })
    .join("");
}

function copyText(text) {
  const done = () => showLocalToast("已复制");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-9999px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch (e) {
    console.warn(TAG, "复制失败", e);
  }
  ta.remove();
}

function showLocalToast(msg) {
  let box = document.getElementById("xbhh-tt-local");
  if (!box) {
    box = document.createElement("div");
    box.id = "xbhh-tt-local";
    box.style.cssText =
      "position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:100050;" +
      "padding:6px 16px;border-radius:8px;font-size:13px;color:#cdd6f4;" +
      "background:rgba(17,17,27,.94);border:1px solid #45475a;pointer-events:none;" +
      "transition:opacity .25s ease;opacity:0;";
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.style.opacity = "1";
  clearTimeout(box.__t);
  box.__t = setTimeout(() => {
    box.style.opacity = "0";
  }, 1500);
}

function itemText(it) {
  const head = `[${fmtTime(it.ts)}] ${it.severity === "error" ? "错误" : "警告"}` +
    (it.summary ? ` ${it.summary}` : "") +
    (it.count > 1 ? ` (×${it.count})` : "");
  return it.detail ? `${head}\n${it.detail}` : head;
}

function openPanel() {
  if (!panelEl) return;
  panelEl.hidden = false;
  positionPanel();
  unread = 0;
  bumpBadge();
  renderList();
}

function closePanel() {
  if (!panelEl) return;
  panelEl.hidden = true;
}

/* ─────────────────── 顶部栏挂载 + 面板定位 ─────────────────── */

/** 侧边栏是否位于左侧（读取 ComfyUI 原生设置，默认 left） */
function sidebarOnLeft() {
  try {
    const loc = app.ui?.settings?.getSettingValue?.("Comfy.Sidebar.Location");
    return loc !== "right";
  } catch {
    return true;
  }
}

/**
 * 把收件箱按钮挂到 ComfyUI 顶部栏（贴侧边栏所在侧的最边缘）。
 * Vue 重渲染会移除注入节点，故用定时器 + isConnected 检测反复挂载。
 */
function mountButton() {
  if (!btnEl) return;

  const onLeft = sidebarOnLeft();
  const wantSide = onLeft ? "left" : "right";
  // 已挂载且所在侧未变 → 无需处理（避免 Vue 重渲染造成的重复搬运）
  if (btnEl.isConnected && btnEl.__xbhhSide === wantSide) return;
  if (btnEl.isConnected) btnEl.remove();

  const attach = (parent, before) => {
    if (before) parent.insertBefore(btnEl, before);
    else parent.appendChild(btnEl);
    btnEl.__xbhhSide = wantSide;
  };

  const host = document.querySelector('[data-testid="topbar-workflow-tabs"]');
  if (host) {
    const row = host.firstElementChild || host;
    btnEl.classList.remove("xbhh-tt-floating");
    attach(row, onLeft ? row.firstElementChild : null);
    return;
  }

  const fallback = document.querySelector('[data-testid="top-menu-actionbars"]');
  if (fallback && fallback.parentElement) {
    btnEl.classList.remove("xbhh-tt-floating");
    attach(fallback.parentElement, onLeft ? fallback : null);
    return;
  }

  // 最终兜底：左下角浮标
  btnEl.classList.add("xbhh-tt-floating");
  btnEl.__xbhhSide = "float";
  if (btnEl.parentElement !== document.body) document.body.appendChild(btnEl);
}

/** 面板位置跟随按钮：顶部栏态贴按钮下方，浮标态用默认左下角 */
function positionPanel() {
  if (!panelEl || !btnEl) return;
  const anchor = btnEl.getBoundingClientRect();
  const floating = btnEl.classList.contains("xbhh-tt-floating");
  const onLeft = sidebarOnLeft();

  if (floating || !anchor.width) {
    panelEl.style.top = "";
    panelEl.style.left = "12px";
    panelEl.style.right = "";
    panelEl.style.bottom = "60px";
    return;
  }

  const w = Math.min(380, window.innerWidth * 0.92);
  const top = Math.round(anchor.bottom + 6);
  let left = onLeft ? Math.round(anchor.left) : Math.round(anchor.right - w);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

  panelEl.style.top = `${top}px`;
  panelEl.style.bottom = "";
  panelEl.style.left = `${left}px`;
  panelEl.style.right = "";
}

function ensureUI() {
  if (!document.body || btnEl) return;

  const style = document.createElement("style");
  style.textContent = `
.xbhh-tt-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;
  flex:none;width:30px;height:30px;margin:0 3px;border-radius:7px;cursor:pointer;color:#cdd6f4;
  background:transparent;border:1px solid transparent;
  transition:background .15s ease,border-color .15s ease;}
.xbhh-tt-btn:hover{background:rgba(49,50,68,.98);border-color:#89b4fa;}
.xbhh-tt-btn.xbhh-tt-floating{position:fixed;left:12px;bottom:12px;width:40px;height:40px;
  margin:0;border-radius:50%;background:rgba(30,30,46,.92);border-color:#45475a;
  box-shadow:0 4px 16px rgba(0,0,0,.45);}
.xbhh-tt-btn.xbhh-tt-floating:hover{background:rgba(49,50,68,.98);border-color:#89b4fa;}
.xbhh-tt-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;
  border-radius:9px;background:#f38ba8;color:#11111b;font-size:11px;font-weight:700;line-height:18px;
  text-align:center;box-sizing:border-box;}
.xbhh-tt-panel{position:fixed;left:12px;top:48px;z-index:100041;width:380px;max-width:92vw;
  max-height:min(60vh,560px);display:flex;flex-direction:column;border-radius:10px;overflow:hidden;
  background:rgba(24,24,37,.98);border:1px solid #45475a;box-shadow:0 8px 28px rgba(0,0,0,.55);
  color:#cdd6f4;font-size:13px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
.xbhh-tt-panel[hidden]{display:none;}
.xbhh-tt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #313244;}
.xbhh-tt-title{font-weight:600;flex:1;}
.xbhh-tt-head button{background:transparent;border:1px solid #45475a;color:#cdd6f4;border-radius:6px;
  padding:3px 8px;font-size:12px;cursor:pointer;}
.xbhh-tt-head button:hover{background:#313244;border-color:#89b4fa;}
.xbhh-tt-opts{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 12px;
  border-bottom:1px solid #313244;color:#a6adc8;font-size:12px;}
.xbhh-tt-opts label{display:flex;align-items:center;gap:6px;cursor:pointer;}
.xbhh-tt-opts input[type=number]{width:52px;background:#11111b;border:1px solid #45475a;color:#cdd6f4;
  border-radius:5px;padding:2px 4px;font-size:12px;}
.xbhh-tt-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:6px;}
.xbhh-tt-empty{padding:24px 8px;text-align:center;color:#6c7086;}
.xbhh-tt-item{background:#1e1e2e;border:1px solid #313244;border-radius:8px;padding:8px 10px;}
.xbhh-tt-item[data-sev=error]{border-left:3px solid #f38ba8;}
.xbhh-tt-item[data-sev=warn]{border-left:3px solid #f9e2af;}
.xbhh-tt-item-top{display:flex;align-items:center;gap:8px;}
.xbhh-tt-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.xbhh-tt-item[data-sev=error] .xbhh-tt-dot{background:#f38ba8;}
.xbhh-tt-item[data-sev=warn] .xbhh-tt-dot{background:#f9e2af;}
.xbhh-tt-time{color:#6c7086;font-size:12px;flex:none;font-variant-numeric:tabular-nums;}
.xbhh-tt-sum{flex:1;color:#cdd6f4;font-weight:600;word-break:break-word;}
.xbhh-tt-count{flex:none;color:#f9e2af;font-size:11px;background:rgba(249,226,175,.14);
  border-radius:6px;padding:0 5px;}
.xbhh-tt-copy{flex:none;background:transparent;border:1px solid #45475a;color:#a6adc8;border-radius:5px;
  padding:1px 6px;font-size:11px;cursor:pointer;}
.xbhh-tt-copy:hover{background:#313244;color:#cdd6f4;border-color:#89b4fa;}
.xbhh-tt-detail{margin-top:6px;color:#a6adc8;font-size:12px;line-height:1.5;white-space:pre-wrap;
  word-break:break-word;max-height:3.1em;overflow:hidden;cursor:pointer;}
.xbhh-tt-item.open .xbhh-tt-detail{max-height:none;}
`;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "xbhh-tt-btn";
  btn.className = "xbhh-tt-btn";
  btn.type = "button";
  btn.title = "提示收件箱";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>' +
    "</svg>";
  badgeEl = document.createElement("span");
  badgeEl.className = "xbhh-tt-badge";
  badgeEl.style.display = "none";
  btn.appendChild(badgeEl);
  btnEl = btn;
  mountButton();

  const panel = document.createElement("div");
  panel.id = "xbhh-tt-panel";
  panel.className = "xbhh-tt-panel";
  panel.hidden = true;
  panel.innerHTML =
    '<div class="xbhh-tt-head">' +
    '<span class="xbhh-tt-title">提示收件箱</span>' +
    '<button type="button" data-act="copy-all">全部复制</button>' +
    '<button type="button" data-act="clear">清空</button>' +
    '<button type="button" data-act="close">✕</button>' +
    "</div>" +
    '<div class="xbhh-tt-opts">' +
    '<label><input type="checkbox" data-act="autoclose"> 自动关闭提示</label>' +
    '<label>存活 <input type="number" data-act="life" min="2" max="120" step="1"> 秒</label>' +
    '<label><input type="checkbox" data-act="inbox"> 收纳警告 / 错误</label>' +
    "</div>" +
    '<div class="xbhh-tt-list"></div>';
  document.body.appendChild(panel);
  panelEl = panel;
  listEl = panel.querySelector(".xbhh-tt-list");
  autoCloseEl = panel.querySelector('[data-act="autoclose"]');
  lifeEl = panel.querySelector('[data-act="life"]');
  const inboxEl = panel.querySelector('[data-act="inbox"]');

  autoCloseEl.checked = !!settings.autoClose;
  lifeEl.value = String(Math.round(settings.closeMs / 1000));
  inboxEl.checked = !!settings.inbox;

  btn.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  autoCloseEl.addEventListener("change", () => {
    settings.autoClose = autoCloseEl.checked;
    saveSettings();
  });

  lifeEl.addEventListener("change", () => {
    let sec = parseInt(lifeEl.value, 10);
    if (!Number.isFinite(sec)) sec = DEFAULTS.closeMs / 1000;
    sec = Math.min(120, Math.max(2, sec));
    lifeEl.value = String(sec);
    settings.closeMs = sec * 1000;
    saveSettings();
  });

  inboxEl.addEventListener("change", () => {
    settings.inbox = inboxEl.checked;
    saveSettings();
  });

  panel.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const act = target.getAttribute("data-act");
    if (!act) {
      const item = target.closest(".xbhh-tt-item");
      if (item) item.classList.toggle("open");
      return;
    }
    if (act === "close") {
      closePanel();
      return;
    }
    if (act === "clear") {
      inbox = [];
      unread = 0;
      saveInbox();
      bumpBadge();
      renderList();
      return;
    }
    if (act === "copy-all") {
      if (!inbox.length) return showLocalToast("没有可复制的内容");
      copyText(inbox.map(itemText).join("\n\n"));
      return;
    }
  });

  listEl.addEventListener("click", (ev) => {
    const target = ev.target;
    if (target instanceof HTMLElement && target.classList.contains("xbhh-tt-copy")) {
      ev.stopPropagation();
      const item = target.closest(".xbhh-tt-item");
      const k = item && item.getAttribute("data-k");
      const rec = inbox.find((it) => it.k === k);
      if (rec) copyText(itemText(rec));
    }
  });

  renderList();
  bumpBadge();
}

/* ────────────────────────── 启动 ────────────────────────── */

function boot() {
  loadSettings();
  loadInbox();
  if (document.body) ensureUI();
  else window.addEventListener("DOMContentLoaded", ensureUI, { once: true });

  // 顶部栏为 Vue 渲染，重渲染会移除注入按钮 → 定时检测重新挂载；窗口尺寸变化时重定位面板
  setInterval(mountButton, 700);
  window.addEventListener("resize", () => {
    if (panelEl && !panelEl.hidden) positionPanel();
  });

  let tries = 0;
  const timer = setInterval(() => {
    if (installToastPatch()) {
      clearInterval(timer);
      return;
    }
    tries += 1;
    if (tries >= 20) {
      clearInterval(timer);
      installDomFallback();
    }
  }, 300);
  installToastPatch();
}

app.registerExtension({
  name: "xbhh.ToastTamer",
  setup() {
    boot();
  },
});

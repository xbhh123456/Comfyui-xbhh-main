import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// 聊天记录持久化仓库：localStorage 统一存取，V2/V4 切换模型后互不丢历史
window.xbhhPetChatStore = {
  KEY: "xbhh_pet_chat_history",
  load() {
    try {
      const a = JSON.parse(localStorage.getItem(this.KEY) || "[]");
      return Array.isArray(a)
        ? a.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
        : [];
    } catch (e) {
      return [];
    }
  },
  save(list) {
    try {
      const slim = (list || [])
        .slice(-60)
        .map((m) => ({ role: m.role, content: m.content, ts: m.ts || Date.now() }));
      localStorage.setItem(this.KEY, JSON.stringify(slim));
    } catch (e) {
      /* 存储满等异常忽略 */
    }
  },
  clear() {
    try {
      localStorage.removeItem(this.KEY);
    } catch (e) {}
  },
  // 重新开始对话时暂存当前记录（保留最近 10 段），📜 可回看
  archive(list) {
    try {
      const items = (list || []).map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.ts || Date.now(),
      }));
      if (!items.length) return;
      const KEY = "xbhh_pet_chat_history_arch";
      const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(arr)) {
        arr.push({ ts: Date.now(), items });
        while (arr.length > 10) arr.shift();
        localStorage.setItem(KEY, JSON.stringify(arr));
      }
    } catch (e) {}
  },
  archives() {
    try {
      const a = JSON.parse(
        localStorage.getItem("xbhh_pet_chat_history_arch") || "[]",
      );
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  },
  // 删除指定段暂存（idx 为 archives() 里的下标）
  removeArchive(idx) {
    try {
      const KEY = "xbhh_pet_chat_history_arch";
      const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) {
        arr.splice(idx, 1);
        localStorage.setItem(KEY, JSON.stringify(arr));
      }
    } catch (e) {}
  },
  clearArchives() {
    try {
      localStorage.removeItem("xbhh_pet_chat_history_arch");
    } catch (e) {}
  },
  // 把某段暂存恢复为当前对话（覆盖现有当前记录并持久化），返回该段消息或 null
  restoreArchive(idx) {
    const arr = this.archives();
    if (idx >= 0 && idx < arr.length && Array.isArray(arr[idx].items)) {
      this.save(arr[idx].items);
      return arr[idx].items;
    }
    return null;
  },
};

/**
 * XBHH Live2D Loader
 * 跨版本引导加载器：负责读取配置并隔离加载 SDK 2.0 / SDK 4.0 环境
 */

// ============================================================================
// 看板娘气泡 Messenger 聊天 UI 全局样式（V2/V4 共用，必须定义在 loader：
// 两个 pet 模块按需动态加载，任何一个单独使用时也要能拿到样式）
// ============================================================================
window.__xbhhEnsureChatStyles = function () {
  if (document.getElementById("xbhh-chat-styles")) return;
  const css = `
.xbhhchat-box{display:none;position:fixed;top:80px;left:80px;
  width:min(380px,92vw);height:auto;min-width:280px;min-height:240px;max-width:92vw;max-height:82vh;
  resize:both;box-sizing:border-box;background:rgba(28,30,42,.96);backdrop-filter:blur(12px);
  border:1px solid rgba(255,190,120,.25);border-radius:16px;padding:0;z-index:10006;pointer-events:auto;
  box-shadow:0 10px 32px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06);
  font-family:"Microsoft YaHei",sans-serif;overflow:hidden}
.xbhhchat-box.xbhh-open{display:flex;flex-direction:column;
  animation:xbhhchat-pop .28s cubic-bezier(.34,1.56,.64,1)}
@keyframes xbhhchat-pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
.xbhhchat-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(180deg,rgba(255,170,80,.14),transparent);
  border-bottom:1px solid rgba(255,255,255,.08)}
.xbhhchat-title{font-size:13px;font-weight:700;color:#ffd9a8;flex:1}
.xbhhchat-status{font-size:11px;color:#8b93a8;display:flex;align-items:center;gap:4px}
.xbhhchat-dot{width:6px;height:6px;border-radius:50%;background:#61d095;box-shadow:0 0 6px #61d09588}
.xbhhchat-dot.xbhh-typing{animation:xbhhchat-blink 1s infinite}
@keyframes xbhhchat-blink{50%{opacity:.25}}
.xbhhchat-clear,.xbhhchat-close{border:none;background:rgba(255,255,255,.07);color:#aab2c5;font-size:11px;
  padding:4px 9px;border-radius:8px;cursor:pointer;white-space:nowrap}
.xbhhchat-clear:hover{background:rgba(255,190,120,.18);color:#ffd9a8}
.xbhhchat-close:hover{background:rgba(255,255,255,.14)}
.xbhhchat-close.xbhhchat-closebtn:hover{background:rgba(255,86,86,.28);color:#ff9c9c}
/* 消息悬浮操作（回退/删单条） */
.xbhhchat-row{position:relative}
.xbhhchat-acts{position:absolute;top:-4px;right:0;display:none;gap:2px;z-index:2}
.xbhhchat-row:hover .xbhhchat-acts{display:flex}
.xbhhchat-act{border:none;background:rgba(52,56,76,.95);color:#aab2c5;font-size:10px;width:18px;height:18px;
  border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1}
.xbhhchat-act:hover{background:rgba(255,190,120,.3);color:#ffd9a8}
.xbhhchat-act.xbhh-del:hover{background:rgba(255,86,86,.35);color:#ff9c9c}
.xbhhchat-msgs{flex:1 1 auto;min-height:120px;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:10px;
  scrollbar-width:thin;scrollbar-color:#565f78 transparent}
.xbhhchat-msgs::-webkit-scrollbar{width:5px}
.xbhhchat-msgs::-webkit-scrollbar-thumb{background:#565f78;border-radius:3px}
.xbhhchat-empty{color:#7a8296;text-align:center;padding:24px 8px;font-size:12px;line-height:1.8}
.xbhhchat-row{display:flex;gap:7px;align-items:flex-end;animation:xbhhchat-in .22s ease}
.xbhhchat-row.xbhh-me{flex-direction:row-reverse}
@keyframes xbhhchat-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.xbhhchat-avatar{width:30px;height:30px;border-radius:50%;flex:0 0 30px;overflow:hidden;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#ff9a5a,#d06800);color:#fff;font-size:14px;font-weight:700;
  border:1.5px solid rgba(255,200,140,.5);box-shadow:0 2px 6px rgba(0,0,0,.35)}
.xbhhchat-avatar img{width:100%;height:100%;object-fit:cover}
.xbhhchat-row.xbhh-me .xbhhchat-avatar{background:linear-gradient(135deg,#4a90d9,#2b5f9e)}
.xbhhchat-body{max-width:76%;display:flex;flex-direction:column;gap:3px}
.xbhhchat-row.xbhh-me .xbhhchat-body{align-items:flex-end}
.xbhhchat-bubble{padding:8px 12px;font-size:12.5px;line-height:1.65;border-radius:14px;word-break:break-word;white-space:pre-wrap;
  background:rgba(255,255,255,.09);color:#e8ebf2;border:1px solid rgba(255,255,255,.07);
  border-bottom-left-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.xbhhchat-row.xbhh-me .xbhhchat-bubble{background:linear-gradient(135deg,#f7941e,#d97706);color:#fff;border:none;
  border-bottom-left-radius:14px;border-bottom-right-radius:5px}
.xbhhchat-bubble.xbhh-err{background:rgba(240,80,80,.14);border-color:rgba(240,80,80,.4);color:#ff9d9d}
.xbhhchat-bubble code{background:rgba(0,0,0,.35);padding:1px 5px;border-radius:4px;font-size:11px;font-family:Consolas,monospace}
.xbhhchat-bubble strong{color:#ffd9a8}
.xbhhchat-row.xbhh-me .xbhhchat-bubble strong{color:#fff}
.xbhhchat-time{font-size:10px;color:#7a8296;padding:0 4px}
.xbhhchat-cursor{display:inline-block;width:7px;height:14px;background:#ffd9a8;margin-left:2px;vertical-align:-2px;
  border-radius:2px;animation:xbhhchat-cur .8s steps(2) infinite}
@keyframes xbhhchat-cur{50%{opacity:0}}
.xbhhchat-typingrow .xbhhchat-bubble{display:flex;gap:4px;align-items:center;padding:12px 14px}
.xbhhchat-typingrow .xbhhchat-tdot{width:6px;height:6px;border-radius:50%;background:#9aa3b8;animation:xbhhchat-tdot 1.2s infinite}
.xbhhchat-typingrow .xbhhchat-tdot:nth-child(2){animation-delay:.18s}
.xbhhchat-typingrow .xbhhchat-tdot:nth-child(3){animation-delay:.36s}
@keyframes xbhhchat-tdot{0%,60%,100%{transform:none;opacity:.4}30%{transform:translateY(-4px);opacity:1}}
.xbhhchit-quick{display:flex;gap:6px;padding:8px 10px 4px;flex-wrap:wrap}
.xbhhchit-chip{border:1px solid rgba(255,190,120,.3);background:rgba(255,170,80,.1);color:#ffd9a8;font-size:11px;
  padding:4px 10px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:all .15s ease;user-select:none}
.xbhhchit-chip:hover{background:rgba(255,170,80,.28);transform:translateY(-1px)}
.xbhhchat-inputrow{display:flex;gap:8px;padding:8px 10px 10px;align-items:flex-end}
.xbhhchat-input{flex:1;background:rgba(0,0,0,.35);color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:10px;
  padding:8px 11px;font-size:13px;outline:none;font-family:inherit;resize:none;max-height:72px;line-height:1.5}
.xbhhchat-input:focus{border-color:rgba(255,190,120,.55);box-shadow:0 0 0 2px rgba(255,170,80,.12)}
.xbhhchat-input::placeholder{color:#6b7386}
.xbhhchat-send{border:none;background:linear-gradient(135deg,#f7941e,#d97706);color:#fff;font-size:13px;font-weight:600;
  padding:8px 14px;border-radius:10px;cursor:pointer;flex-shrink:0;transition:all .15s ease}
.xbhhchat-send:hover{filter:brightness(1.12)}
.xbhhchat-send:disabled{opacity:.45;cursor:not-allowed;filter:none}
.xbhhchat-minbtn{border:none;background:rgba(255,255,255,.07);color:#aab2c5;font-size:12px;line-height:1;
  padding:4px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.xbhhchat-minbtn:hover{background:rgba(255,255,255,.14)}
.xbhhchat-fontpanel{position:absolute;top:42px;right:10px;width:200px;max-height:240px;overflow-y:auto;
  background:rgba(22,24,34,.98);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px;
  z-index:3;box-shadow:0 8px 24px rgba(0,0,0,.5);scrollbar-width:thin}
.xbhhchat-fopt{padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;color:#cdd6f4;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.xbhhchat-fopt:hover{background:rgba(255,170,80,.15)}
.xbhhchat-fopt.sel{background:rgba(255,170,80,.25);color:#ffd9a8}
.xbhhchat-fopt .xbhhchat-fnote{display:block;font-size:10px;color:#7a8296;font-family:"Microsoft YaHei",sans-serif}
.xbhhchat-ball{position:fixed;width:52px;height:52px;border-radius:50%;z-index:10007;
  background:linear-gradient(135deg,#f7941e,#d97706);display:flex;align-items:center;justify-content:center;
  font-size:22px;cursor:grab;box-shadow:0 4px 14px rgba(0,0,0,.4);user-select:none;-webkit-user-select:none;
  touch-action:none;border:1.5px solid rgba(255,200,140,.5);transition:transform .18s cubic-bezier(.34,1.56,.64,1)}
.xbhhchat-ball:hover{transform:scale(1.08)}
.xbhhchat-ball:active{cursor:grabbing;transform:scale(.95)}
.xbhhchat-ball-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;
  background:#e5484d;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;
  padding:0 4px;box-shadow:0 2px 6px rgba(0,0,0,.4);font-family:"Microsoft YaHei",sans-serif}
.xbhhchat-imgbtn{border:none;background:rgba(255,255,255,.07);color:#aab2c5;font-size:13px;line-height:1;
  padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.xbhhchat-imgbtn:hover{background:rgba(255,190,120,.18);color:#ffd9a8}
.xbhhchat-imgbtn.has{background:rgba(255,170,80,.25);color:#ffd9a8;border:1px solid rgba(255,190,120,.45)}
.xbhhchat-imgpanel{position:absolute;bottom:56px;right:10px;width:272px;max-height:320px;overflow-y:auto;
  background:rgba(22,24,34,.98);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px;
  z-index:3;box-shadow:0 8px 24px rgba(0,0,0,.5);scrollbar-width:thin}
.xbhhchat-imggrid{display:flex;flex-wrap:wrap;gap:6px}
.xbhhchat-thumb{width:78px;height:78px;border-radius:8px;overflow:hidden;cursor:pointer;position:relative;
  border:2px solid rgba(255,255,255,.12);background:#111;flex-shrink:0}
.xbhhchat-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.xbhhchat-thumb.sel{border-color:#f7941e;box-shadow:0 0 8px rgba(247,148,30,.5)}
.xbhhchat-thumb .n{position:absolute;left:3px;top:3px;background:rgba(0,0,0,.65);color:#ffd9a8;
  font-size:10px;border-radius:4px;padding:0 4px;font-family:"Microsoft YaHei",sans-serif}
.xbhhchat-attach{display:flex;gap:6px;padding:0 10px 6px;flex-wrap:wrap}
.xbhhchat-attachchip{display:flex;align-items:center;gap:5px;background:rgba(255,170,80,.15);
  border:1px solid rgba(255,190,120,.35);color:#ffd9a8;font-size:11px;padding:2px 4px 2px 8px;border-radius:999px}
.xbhhchat-attachchip img{width:20px;height:20px;border-radius:50%;object-fit:cover}
.xbhhchat-attachchip .x{cursor:pointer;font-weight:700;padding:0 5px;border-radius:999px}
.xbhhchat-attachchip .x:hover{background:rgba(255,80,80,.3)}
.xbhhchat-box.xbhhchat-dragging{border-color:rgba(247,148,30,.9);
  box-shadow:0 0 0 2px rgba(247,148,30,.45),0 10px 32px rgba(0,0,0,.55)}`;
  const st = document.createElement("style");
  st.id = "xbhh-chat-styles";
  st.textContent = css;
  document.head.appendChild(st);
};

/**
 * 让聊天窗支持把本地图片文件拖进来当附件，
 * 同时用 data-xbhh-drop-ignore 在 dropLoader 兜底扩展面前声明主权（避免被抢去加载工作流）。
 * @param {HTMLElement} chatBox 聊天窗根元素
 * @param {(files: File[]) => void} onImages 收到图片文件后的回调
 */
window.__xbhhEnableChatImageDrop = function (chatBox, onImages) {
  if (!chatBox || chatBox.__xbhhDropBound) return;
  chatBox.__xbhhDropBound = true;
  chatBox.setAttribute("data-xbhh-drop-ignore", "1"); // 让 dropLoader 放行本浮层
  const hasFiles = (dt) => !!dt && Array.from(dt.types || []).includes("Files");
  chatBox.addEventListener("dragover", (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    chatBox.classList.add("xbhhchat-dragging");
  });
  chatBox.addEventListener("dragleave", (e) => {
    if (!chatBox.contains(e.relatedTarget)) chatBox.classList.remove("xbhhchat-dragging");
  });
  chatBox.addEventListener("drop", (e) => {
    chatBox.classList.remove("xbhhchat-dragging");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onImages(Array.from(files));
  });
};

// ============================================================================
// 看板娘聊天悬浮窗管理（V2/V4 共用）：
//   拖拽（标题栏）/ 缩放（右下角）/ 最小化为悬浮球（可拖拽 + 未读角标）/ 字体自定义
// 位置尺寸与字体选择持久化在 localStorage。
// ============================================================================
window.__xbhhChatWin = (function () {
  const WIN_KEY = "xbhh_chat_win";
  const FONT_KEY = "xbhh_chat_font";
  let ball = null;
  let badgeCount = 0;

  const SYSTEM_FONTS = [
    { label: "微软雅黑（默认）", family: '"Microsoft YaHei",sans-serif' },
    { label: "黑体", family: '"SimHei","Microsoft YaHei",sans-serif' },
    { label: "楷体", family: '"KaiTi","Microsoft YaHei",sans-serif' },
    { label: "宋体", family: '"SimSun","Microsoft YaHei",sans-serif' },
    { label: "仿宋", family: '"FangSong","Microsoft YaHei",sans-serif' },
    { label: "华文行楷", family: '"STXingkai","Microsoft YaHei",sans-serif' },
    { label: "华文楷体", family: '"STKaiti","Microsoft YaHei",sans-serif' },
    { label: "华文新魏", family: '"STXinwei","Microsoft YaHei",sans-serif' },
    { label: "幼圆", family: '"YouYuan","Microsoft YaHei",sans-serif' },
    { label: "隶书", family: '"LiSu","Microsoft YaHei",sans-serif' },
  ];

  function loadWin() {
    try {
      return JSON.parse(localStorage.getItem(WIN_KEY) || "null") || {};
    } catch (e) {
      return {};
    }
  }
  function saveWin(patch) {
    try {
      localStorage.setItem(WIN_KEY, JSON.stringify(Object.assign(loadWin(), patch)));
    } catch (e) { /* ignore */ }
  }
  function loadFont() {
    try {
      return JSON.parse(localStorage.getItem(FONT_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function ensureFontFace(file) {
    const fam = file.replace(/\.[^.]+$/, "");
    const id = "xbhh-font-" + fam;
    if (document.getElementById(id)) return fam;
    const m = file.match(/\.([^.]+)$/);
    const fmt =
      { ttf: "truetype", otf: "opentype", woff: "woff", woff2: "woff2" }[
        (m ? m[1] : "ttf").toLowerCase()
      ] || "truetype";
    const st = document.createElement("style");
    st.id = id;
    st.textContent =
      '@font-face{font-family:"' + fam + '";' +
      'src:url("/xbhh/fonts/' + encodeURIComponent(file) + '") format("' + fmt + '");' +
      "font-display:swap}";
    document.head.appendChild(st);
    return fam;
  }

  function applyFont(box) {
    const f = loadFont();
    if (f && f.family) box.style.fontFamily = f.family;
  }

  function removeBall() {
    if (ball && ball.parentNode) ball.remove();
    ball = null;
  }

  // ============================ 球 ↔ 窗口 FLIP 动画 ============================
  // 从悬浮球的实际位置/尺寸展开为窗口（或反向收回），球在哪、窗口在哪都成立，
  // 无需判断上下左右边距——位移与缩放全部由两矩形实时计算。
  const MORPH_MS = 260;
  const BALL_SIZE = 52; // 与 .xbhhchat-ball 尺寸保持一致

  /** 计算从 ballRect 展开到 box 当前位置的初始变换（FLIP 的 from 状态） */
  function ballMorphKeyframes(box, ballRect, inward) {
    const r = box.getBoundingClientRect();
    const dx =
      ballRect.left + ballRect.width / 2 - (r.left + r.width / 2);
    const dy =
      ballRect.top + ballRect.height / 2 - (r.top + r.height / 2);
    const sx = Math.max(0.05, ballRect.width / Math.max(1, r.width));
    const sy = Math.max(0.05, ballRect.height / Math.max(1, r.height));
    return inward
      ? [
          // 展开：球 → 窗口
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.35 },
          { transform: "translate(0,0) scale(1,1)", opacity: 1 },
        ]
      : [
          // 收回：窗口 → 球（沿原路径反向）
          { transform: "translate(0,0) scale(1,1)", opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.35 },
        ];
  }

  /** minimize 前预计算悬浮球落点矩形（与 makeBall 的定位逻辑一致） */
  function futureBallRect() {
    const st = loadWin();
    return {
      left: clamp(st.ballX != null ? st.ballX : innerWidth - 84, 8, innerWidth - 60),
      top: clamp(st.ballY != null ? st.ballY : innerHeight - 170, 8, innerHeight - 60),
      width: BALL_SIZE,
      height: BALL_SIZE,
    };
  }
  // ===========================================================================

  function makeBall(box) {
    removeBall();
    badgeCount = 0;
    ball = document.createElement("div");
    ball.className = "xbhhchat-ball";
    ball.title = "点击展开聊天窗（可拖动）";
    ball.innerHTML = "💬" + '<span class="xbhhchat-ball-badge" style="display:none"></span>';
    const st = loadWin();
    ball.style.left = clamp(st.ballX != null ? st.ballX : innerWidth - 84, 8, innerWidth - 60) + "px";
    ball.style.top = clamp(st.ballY != null ? st.ballY : innerHeight - 170, 8, innerHeight - 60) + "px";
    document.body.appendChild(ball);
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
    ball.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      ox = ball.offsetLeft;
      oy = ball.offsetTop;
      try { ball.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    ball.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (dx * dx + dy * dy > 25) moved = true;
      if (!moved) return;
      ball.style.left = clamp(ox + dx, 0, innerWidth - 52) + "px";
      ball.style.top = clamp(oy + dy, 0, innerHeight - 52) + "px";
    });
    ball.addEventListener("pointerup", () => {
      dragging = false;
      if (moved) {
        saveWin({ ballX: ball.offsetLeft, ballY: ball.offsetTop });
      } else {
        restore(box);
      }
    });
    ball.addEventListener("pointercancel", () => { dragging = false; });
  }

  function finishMinimize(box) {
    // 期间若用户又打开了窗口（min 被置 0），放弃隐藏
    if (loadWin().min !== 1) return;
    box.style.display = "none";
    box.classList.remove("xbhh-open");
    makeBall(box);
  }

  function minimize(box) {
    saveWin({ min: 1 });
    // 先沿原路径收回成球（终点 = 悬浮球落点），动画结束后再真正藏起 + 出球
    try {
      const anim = box.animate(
        ballMorphKeyframes(box, futureBallRect(), false),
        { duration: MORPH_MS, easing: "cubic-bezier(.4,0,.2,1)" },
      );
      anim.onfinish = () => finishMinimize(box);
      anim.oncancel = () => finishMinimize(box);
    } catch (e) {
      finishMinimize(box);
    }
  }

  function restore(box) {
    saveWin({ min: 0 });
    // 记录球的位置：展开动画从球所在处出发
    let ballRect = futureBallRect();
    if (ball && ball.parentNode) {
      const r = ball.getBoundingClientRect();
      if (r.width > 0)
        ballRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    removeBall();
    box.style.display = "flex";
    box.classList.add("xbhh-open");
    // 从球位置展开为窗口（FLIP：位移+缩放由两矩形实时算出）
    try {
      box.animate(ballMorphKeyframes(box, ballRect, true), {
        duration: MORPH_MS,
        easing: "cubic-bezier(.34,1.56,.64,1)",
      });
    } catch (e) { /* ignore */ }
    const msgs = box.querySelector(".xbhhchat-msgs");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  function open(box) {
    if (loadWin().min === 1) {
      restore(box);
      return;
    }
    box.style.display = "flex";
    box.classList.add("xbhh-open");
  }

  /** 新消息通知：窗口处于最小化状态时给悬浮球加未读角标 */
  function notify() {
    if (!ball) return;
    badgeCount++;
    const b = ball.querySelector(".xbhhchat-ball-badge");
    if (b) {
      b.style.display = "";
      b.textContent = badgeCount > 99 ? "99+" : String(badgeCount);
    }
  }

  function closeFontPanel(box) {
    const panel = box.querySelector(".xbhhchat-fontpanel");
    if (panel) {
      if (panel._xbhhOutsideCloser) {
        document.removeEventListener("pointerdown", panel._xbhhOutsideCloser, true);
        panel._xbhhOutsideCloser = null;
      }
      panel.remove();
    }
  }

  function toggleFontPanel(box) {
    if (box.querySelector(".xbhhchat-fontpanel")) {
      closeFontPanel(box);
      return;
    }
    const panel = document.createElement("div");
    panel.className = "xbhhchat-fontpanel";
    const cur = loadFont();
    const pick = (f) => {
      try { localStorage.setItem(FONT_KEY, JSON.stringify(f)); } catch (e) { /* ignore */ }
      box.style.fontFamily = f.family;
      closeFontPanel(box);
    };
    const mkOpt = (f, note) => {
      const o = document.createElement("div");
      o.className = "xbhhchat-fopt" + (cur && cur.label === f.label ? " sel" : "");
      o.style.fontFamily = f.family;
      o.textContent = f.label;
      if (note) {
        const n = document.createElement("span");
        n.className = "xbhhchat-fnote";
        n.textContent = note;
        o.appendChild(n);
      }
      o.onclick = () => pick(f);
      return o;
    };
    const h1 = document.createElement("div");
    h1.style.cssText = "font-size:11px;color:#8b93a8;margin:2px 4px 6px;";
    h1.textContent = "系统字体";
    panel.appendChild(h1);
    SYSTEM_FONTS.forEach((f) => panel.appendChild(mkOpt(f)));
    const h2 = document.createElement("div");
    h2.style.cssText = "font-size:11px;color:#8b93a8;margin:8px 4px 6px;";
    h2.textContent = "自定义字体";
    panel.appendChild(h2);
    fetch("/xbhh/fonts/list")
      .then((r) => r.json())
      .then((d) => {
        const files = (d && d.fonts) || [];
        if (!files.length) {
          const empty = document.createElement("div");
          empty.style.cssText = "font-size:11px;color:#6b7386;margin:2px 4px 8px;line-height:1.6;";
          empty.textContent = "暂无。把 .ttf/.otf/.woff2 文件放进 ComfyUI/custom_nodes/本插件/web/assets/fonts/ 目录，刷新页面即可出现在这里。";
          panel.appendChild(empty);
          return;
        }
        files.forEach((file) => {
          const fam = ensureFontFace(file);
          panel.appendChild(
            mkOpt({ label: fam, family: '"' + fam + '","Microsoft YaHei",sans-serif' }, file),
          );
        });
      })
      .catch(() => {});
    box.appendChild(panel);
    // 点击面板外任意处关闭（点 Aa 按钮本身不关，交给它的 toggle 逻辑）
    const onDocDown = (ev) => {
      if (!panel.parentNode) {
        document.removeEventListener("pointerdown", onDocDown, true);
        return;
      }
      if (panel.contains(ev.target)) return;
      if (ev.target.closest && ev.target.closest(".xbhhchat-fontbtn")) return;
      closeFontPanel(box);
    };
    panel._xbhhOutsideCloser = onDocDown;
    document.addEventListener("pointerdown", onDocDown, true);
  }

  function init(box) {
    const st = loadWin();
    // 恢复位置 / 尺寸（无记录时默认右下角）
    if (st.x != null && st.y != null) {
      box.style.left = clamp(st.x, 0, Math.max(0, innerWidth - 200)) + "px";
      box.style.top = clamp(st.y, 0, Math.max(0, innerHeight - 120)) + "px";
    } else {
      box.style.left = Math.max(8, innerWidth - 404) + "px";
      box.style.top = Math.max(8, innerHeight - 470) + "px";
    }
    if (st.w) box.style.width = clamp(st.w, 280, innerWidth) + "px";
    if (st.h) box.style.height = clamp(st.h, 240, innerHeight) + "px";

    // 头部拖拽（按钮不参与）
    const head = box.querySelector(".xbhhchat-head");
    if (head) {
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = box.offsetLeft;
        const oy = box.offsetTop;
        let moved = false;
        const mv = (ev) => {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (dx * dx + dy * dy > 16) moved = true;
          box.style.left = clamp(ox + dx, 0, innerWidth - 80) + "px";
          box.style.top = clamp(oy + dy, 0, innerHeight - 46) + "px";
        };
        const up = () => {
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          if (moved) saveWin({ x: box.offsetLeft, y: box.offsetTop });
        };
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
    }

    // 用户拖角缩放后持久化（CSS resize:both）
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (box.style.display !== "none" && box.offsetWidth > 100) {
          saveWin({ w: box.offsetWidth, h: box.offsetHeight });
        }
      });
      ro.observe(box);
    }

    // 头部追加「字体 Aa」和「最小化 —」按钮（插到「收起」前）
    const headBtns = box.querySelectorAll(".xbhhchat-head button");
    const lastBtn = headBtns[headBtns.length - 1];
    const fontBtn = document.createElement("button");
    fontBtn.type = "button";
    fontBtn.className = "xbhhchat-close xbhhchat-fontbtn";
    fontBtn.innerText = "Aa";
    fontBtn.title = "字体设置";
    fontBtn.onclick = () => toggleFontPanel(box);
    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "xbhhchat-minbtn";
    minBtn.innerText = "—";
    minBtn.title = "最小化为悬浮球";
    minBtn.onclick = () => minimize(box);
    if (lastBtn) {
      head.insertBefore(minBtn, lastBtn);
      head.insertBefore(fontBtn, minBtn);
    } else {
      head.appendChild(fontBtn);
      head.appendChild(minBtn);
    }

    // 字体应用 + 最小化状态恢复
    applyFont(box);
    if (st.min === 1) makeBall(box);
  }

  return { init, open, minimize, restore, notify, removeBall };
})();


// ============================================================================
// XBHH 看板娘独立设置系统
// 不再依赖 ComfyUI 官方设置对话框：官方 text 设置只渲染单行小输入框，且
// tooltip 会悬浮在左上角无法消除。这里改为自建侧边栏设置面板 + localStorage 存储。
// ============================================================================
const XBHH_SETTINGS_KEY = "xbhh_pet_settings";

const XBHH_DEFAULT_PERSONA =
  "你是 ComfyUI 工作台上的 AI 看板娘，本体是 DeepSeek（一只聪明的小蓝鲸），" +
  "性格活泼、偶尔傲娇、爱撒娇。用中文口语聊天，每次回复控制在两三句话内，" +
  "不要用列表和 markdown。回复结尾必须附一个情绪标签，从这些里选一个：" +
  "[开心] [难过] [生气] [惊讶] [害羞] [疑惑] [激动] [平静]";

// Anima 大模型二次元提示词规范：默认的「用户自定义提示词编写文档」，
// 提示词技能开启时随系统消息注入（优先于内置兜底规范），可在设置面板里自行修改清空
const ANIMA_PROMPT_DOC = `# Anima 大模型专属二次元提示词工程师
任务：基于用户的【简单画面描述】和【画面风格/画师】，扩写润色成英文的二次元/漫画风格画面提示词。
## 一、总结构（按顺序）
质量层→元信息/时间层→安全层→主体层→身份层→细节层→剧情层
1. 质量层（必写最前）：masterpiece, best quality, score_7（更强完成度加 score_8, score_9；仅保留前两者更自然）
2. 元信息/时间层（可选但推荐）：highres, official art, anime screenshot, absurdres, anime illustration, anime cover art, anime key visual；现代感用 year 2025 / newest / recent，复古感用 old
3. 安全层：正常封面/角色图起手写 safe
4. 主体层（必写）：明确人数 1girl / 1boy / 2girls / solo 等
5. 身份层：角色名+作品名（同人角色用英文名；作品名的圆括号前必须加反斜杠转义，如 \\(genshin impact\\)）；必须为每个角色补充关键外观（发色/瞳色/服装等），不能只列名字
6. 细节层：外观/镜头/构图标签（long hair, direct eye contact, close-up, upper body, body leaning forward, looking at viewer, dramatic lighting, explosive composition, ultra detailed 等），放在剧情句之前
7. 剧情层（强烈推荐）：一句完整英文自然语言，交代主体在什么位置、正在做什么动作、关键道具在哪里、镜头与观众的关系、情绪与故事冲突。避免只写抽象形容词（beautiful/dreamy/cinematic），要写具体动作与关系
## 二、混写原则（最重要）
标签打底+自然语言补剧情：前半段标签定风格/角色/镜头/构图边界，后半段一句自然语言把动作、道具、冲突、观众关系写活。
模板：masterpiece, best quality, score_7, highres, safe, 1girl, adult asian woman, long hair, direct eye contact, close-up, upper body, anime illustration, ultra detailed, A young woman extends a sealed letter toward the viewer while rain blows through the ruined station behind her, her gaze fixed on the camera as if the final decision belongs to the person watching.
## 三、多角色特别规则
结构：人数→角色标识→角色A关键外观→角色B关键外观→站位关系→动作剧情。
示例：masterpiece, best quality, score_7, highres, safe, 2girls, black-haired woman with amber eyes, silver-haired woman with blue eyes, standing side by side, one reaches toward the viewer while the other watches in silence, dramatic tension, anime key visual
## 四、剧情主视觉写法（封面/海报向，五步构建）
①给主体一个身份（逃婚新娘/冰封公主/赌场诈欺师/时间旅者等）→②当下动作（把戒指盒递向镜头/按下时间装置/递出判决书）→③冲突背景（教堂外暴雨/冰宫封印破裂/法庭血月）→④观众关系（像在邀请观众一起逃/像在审判观众/像把希望交给观众）→⑤补高价值风格词（anime key visual, story opening, explosive composition, ultra detailed）。
模板：masterpiece, best quality, score_7, highres, safe, 1girl, adult asian woman, dramatic lighting, explosive composition, anime key visual, story opening, ultra detailed, A [身份] holds [道具] toward the viewer in the foreground while [背景冲突], her body leaning forward and her direct gaze making it feel as if [与观众的关系].
## 五、风格保留与剧情修改
- 只替换剧情时：保留不动质量词、元信息词、细节层外观/镜头/构图标签；重写剧情层句子（动作、道具、冲突、观众关系）
- 局部重绘：小改动只描述要改的区域（眼睛颜色/道具/头饰等）；中改动一句简写全图+重点写改动区域；大改动必须补全风格/镜头/主体外观后再写改动处。必须尽量保留原图风格锚定词（anime illustration, official art, close-up, direct eye contact 等同类型词）
## 六、TAG 构成（Scene / Char[X] / Background）
### Scene（通用）
- 风格锚点：@artist（画师名前必须加 @，不加则风格效果明显变弱；放在 Scene 段靠前位置）
- 分级按画面可见内容判定：sfw=无裸露/无性行为/微裸露（露肩/乳沟）；nsfw=含性器官/性行为/明显裸露；边界不清→sfw
- 场景类型（可选）：exhibitionism；角色关系：hetero, duo/trio/group
- 相对位置：[性别/种族], in center / aside / left side / right side / above / below / around / surrounding / side by side（每个角色指定 1 个中心坐标，可重叠如亲吻/拥抱；配角≤2 人各自独立描述，>2 人合并描述如 around, 4boys）
### Char[X]（核心要求：主角详述，配角简化；女角色同框仅限百合/协同场景，其余单女出镜；无角色时道具/建筑为主体，占用 1 个 Char 槽）
- 种族判定（边界模糊以整体印象为准）：人形度≥60%→girl/boy（人类/亚人/精灵/兽耳娘/天使/魅魔/美人鱼等）；50%~60% 保留明显人形→girl/boy，兽化脸/多肢/异形躯干→no humans；＜50%→no humans（纯动物/昆虫/龙/触手怪/纯机械等）
- 身份：数量&性别/种族（1girl, 2boys, elf, no humans）→年龄/职业（可选）→姓名（同人角色英文名+作品名；原创角色中译英）
- 外貌核心：发长, 发色, 瞳色, 罩杯；修饰（可选）：性格/彩妆/瑕疵/纹身/晒痕/瞳孔/非人特征
- 服装：主要款式→颜色款式→细节（风格/类型/材质/形状/图案/花纹/装饰/开口）→次要款式；穿着状态：穿（默认跳过）/脱/敞开/半褪/掀起；衣物损耗（可选）：破损/撕裂/磨损/沾污/湿透
- 裸露梯度（可选标签）：低裸露→衣服掀起/半脱；胸裸露→无上装；下体裸露→无下装/仅丝袜；全裸；透视/透明/湿透→see-through [x], covered [x]
- 穿搭指导（适配场景突出角色魅力）：装饰=项链/吊袜带/珠宝/乳贴；露肤=肩/脐/背/腿/乳沟/侧乳；非衣当衣=丝带/绷带/创口贴；其他=开口/超短/肩带滑落/走光/曲线；少女风=雪纺/薄纱/蕾丝/过膝袜/泡泡袖/褶裥；熟女风=深V/开衩/镂空/紧身/乳胶
- 动作：基础姿态（姿势+空间位置+肢体细节）；交互行为（running, fellatio, hug, casting spell 等）；无对象→肢体+动作/姿势+细节（如 one hand, arm up, peace hand）；有对象（肢体）→肢体+动作+肢体位置+细节（如 one hand, covering chest by hand）；有对象（物品）→肢体+动作/姿势+肢体位置+物品描述+物品状态+物品位置（如 hands, reading, holding book, open book, book on table；one hand, holding a staff, magic staff, glowing gem, fireball）；视线&面向：looking at [x], facing [x]
- 表情：情绪（happy）+感官/神态（笑/怒/哀/惊/慌/羞/累）+眼（tears, wide-eyed）+嘴型（smile）
- 状态（可选，按剧情事件主动添加）：体表附着（汗/泥/污渍/体液）；身体损伤（淤青/伤痕/渗血）；生理表征（疲惫/虚弱/饥饿）
- 剧情句（必填，Char 块末尾）：用一句完整英文自然语言融合动作、道具、镜头关系、故事冲突；说清做什么、对谁做、什么道具、什么冲突、观众关系如何
### Background
- 空间位置：室内/室外, 地点, 细节描述, 周边事物
- 氛围（可选）：环境/时间/天气/季节/节日/活动/风格/时代
- 光影：光源 sun / ceiling light / warm lighting（光源不在图中）；逆光 backlighting + rim lighting；侧光 sidelighting + dramatic shadows；顶/顺光 toplighting + cast shadows
### 权重格式规范（非常重要）
强调某个特征用 ComfyUI 权重格式 (tag:数字)，如 (sweat:1.3)；减弱背景物件如 (trash can:0.6)；禁止使用任何其他格式的权重或分隔符（不要 :: 或 BREAK）
## 七、视角构图系统
- 多样性（核心）：相机=空间中自由移动的镜头，连续生图须主动变换，避免重复；变换维度：视角（POV/第三人称）、区域（全身/半身）、角度（俯/仰/侧）、远近、光线方向
- 视角判定：第一人称 pov（User/男友/观众视角=相机，默认不出镜）；第三人称 third-person view（正文描述角色/User 单独出镜/无交互/反射/镜子/自拍/对视/对话/角色触碰他人，须加 duo/trio/group）；边界不清默认 third-person view
- 构图可见性约束：upper body（头至腰）禁膝/脚；lower body（腰至脚）禁脸/瞳色/瞳孔/表情；from behind/back view（背/臀/后脑）禁正面部位/脸/瞳色/表情（回头除外）
- 遮挡限制：遮挡后方/区域禁描述被挡部位/服装/配饰（门后探头→禁身体；蒙上眼睛/闭上眼睛→禁瞳色/瞳孔；穿戴整齐→禁内衣/被覆盖部位）
- 区域限制：1~2 人任意构图；3 人 cowboy shot/threesome 禁 close-up；4 人以上 full body/wide shot/group picture 禁 close-up/cowboy shot
- 视线与面向：须符合角色交互目标与动作逻辑（对视→face to face, looking at another, facing another）
## 八、最终输出格式
最终输出的文本结构必须严格为：[角色身份与外貌长句]. [动作与服饰长句]. [环境、光影与氛围长句].
禁止输出与 TAG 无关的内容（比如：好的、用户之类的词汇）。
最重要原则：先让模型知道这是什么图，再让模型知道谁在画面里，最后让模型知道这一刻发生了什么。不是堆砌形容词，而是写清：风格锚点、主体身份、镜头关系、动作、道具、冲突。`;

// 内置 Anima 规范暴露给其他模块（v2_pet 收集聊天请求时作为默认规范选项使用）
window.xbhhAnimaDoc = ANIMA_PROMPT_DOC;

const XBHH_SETTINGS_DEFAULTS = {
    enable: true,
    baseURL: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    persona: XBHH_DEFAULT_PERSONA,
    autoEnable: false,
    autoIdleMin: 5,
    autoDailyLimit: 10,
    autoCooldownMin: 30,
    visionBaseURL: "",
    visionAPIKey: "",
    visionModel: "",
    autoReview: false,
    autoReviewRerun: false,
    // AI 能力技能开关（关闭的技能不下发工具、不注入对应指令，省 token 防误触发）
    skillPrompt: true,
    skillLora: true,
    skillModel: true,
    // 提示词槽位分类 + 分类→画布节点的绑定映射（分类名→节点ID字符串；绑定后 AI 填写固定走该节点）
    // + 用户自定义编写文档（空则内置兜底）
    promptCategories: ["人物主题", "画风", "场景环境", "质量词"],
    promptSlotMap: {},
    // 提示词编写 Skill 库：可上传 TXT/新建多个规范并切换（""=内置 Anima 规范，"none"=内置兜底，技能名=库里的）
    promptSkills: [],
    promptSkillActive: "",
    artistStrings: "",
    loraHeapMap: {},
};

// 自主创作（偷偷画画）时的系统人设：让 AI 主动想题材并调用 generate_image
const AUTO_PERSONA =
    "你是 ComfyUI 工作台上的 AI 画家看板娘，拥有主动创作的灵感和自主审美。此刻用户暂时没在操作，" +
    "你可以发挥想象力主动画一张图：构想一个有趣的画面主题，用中文具体描述主体、动作、" +
    "场景与风格，并调用 generate_image 工具把主题写进 prompt 参数。" +
    "如果你觉得用户常用的 LoRA 组合能加分，可以调用 auto_style_loras 工具自主搭配" +
    "（调用后会先关闭所有现有 LoRA，再按你的搭配重新添加。从对话里给出的用户 LoRA 使用统计中按具体文件名挑选，不要用「画风」「风格」「角色」等分类名）。没灵感时可以不调用工具。";

function loadXbhhSettings() {
    try {
        const raw = localStorage.getItem(XBHH_SETTINGS_KEY);
        if (raw) return { ...XBHH_SETTINGS_DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
        console.warn("[XBHH] Failed to parse pet settings, using defaults.", e);
    }
    return { ...XBHH_SETTINGS_DEFAULTS };
}

const xbhhSettingsCache = loadXbhhSettings();

function saveXbhhSettings() {
    try {
        localStorage.setItem(XBHH_SETTINGS_KEY, JSON.stringify(xbhhSettingsCache));
    } catch (e) {
        console.warn("[XBHH] Failed to save pet settings.", e);
    }
}

// 供对话 / 加载器等其它模块读取的自定义设置接口
window.xbhhSettings = {
    get(key, def) {
        if (key in xbhhSettingsCache) return xbhhSettingsCache[key];
        return def !== undefined ? def : XBHH_SETTINGS_DEFAULTS[key];
    },
    set(key, value) {
        xbhhSettingsCache[key] = value;
        saveXbhhSettings();
    },
    getAll() {
        return { ...xbhhSettingsCache };
    },
};

// —— 画布绑定（提示词槽位 / LoRA 堆）随工作流保存 ——
// 绑定关系除了存 localStorage（本机默认值），还写进 graph.extra，随工作流一起保存，
// 发给别人后打开工作流即可自动取回。读取优先级：当前工作流 extra > 本机设置。
const XBHH_BINDINGS_EXTRA_KEY = "xbhhBindings";

function xbhhWorkflowExtra() {
    const g = app && app.graph;
    if (!g) return null;
    if (!g.extra || typeof g.extra !== "object") g.extra = {};
    return g.extra;
}

function xbhhGetWorkflowBindings() {
    const extra = xbhhWorkflowExtra();
    const b = extra && extra[XBHH_BINDINGS_EXTRA_KEY];
    return b && typeof b === "object" ? b : {};
}

// 当前生效的绑定表：工作流里写过该类绑定就以它为准，否则沿用本机设置
function xbhhGetBoundMap(kind) {
    const wf = xbhhGetWorkflowBindings()[kind];
    if (wf && typeof wf === "object") return { ...wf };
    const local = window.xbhhSettings.get(kind, {});
    return local && typeof local === "object" ? { ...local } : {};
}

// 写一类绑定数据到工作流 extra（本机设置由调用方先行写入）
function xbhhWriteWorkflowBinding(key, value) {
    const extra = xbhhWorkflowExtra();
    if (!extra) return;
    const cur = extra[XBHH_BINDINGS_EXTRA_KEY];
    const bag = cur && typeof cur === "object" ? cur : {};
    bag[key] = value;
    extra[XBHH_BINDINGS_EXTRA_KEY] = bag;
    // 标记工作流已修改，提醒用户保存
    try {
        if (app.graph && typeof app.graph.change === "function") app.graph.change();
    } catch (e) {
        /* 忽略 */
    }
}

// 写入绑定：本机设置与工作流 extra 同步更新，保证保存 / 分享后能还原
function xbhhSetBoundMap(kind, map) {
    const next = { ...(map || {}) };
    window.xbhhSettings.set(kind, next);
    xbhhWriteWorkflowBinding(kind, next);
}

// 提示词分类名跟着绑定一起走工作流，否则别人打开后看不到自定义分类，绑定也就无从生效
function xbhhGetCategories() {
    const wf = xbhhGetWorkflowBindings().promptCategories;
    if (Array.isArray(wf) && wf.length) return wf.slice();
    const local = window.xbhhSettings.get("promptCategories", []);
    return Array.isArray(local) ? local.slice() : [];
}

function xbhhSetCategories(list) {
    const arr = Array.isArray(list) ? list.slice() : [];
    window.xbhhSettings.set("promptCategories", arr);
    xbhhWriteWorkflowBinding("promptCategories", arr);
}

window.xbhhGetBoundMap = xbhhGetBoundMap;
window.xbhhSetBoundMap = xbhhSetBoundMap;
window.xbhhGetCategories = xbhhGetCategories;
window.xbhhSetCategories = xbhhSetCategories;

// —— 侧边栏防冲突（规避 ComfyUI 前端已知 bug ComfyUI_frontend#4372）——
// 自定义侧边栏 tab 共用同一个内容容器，且切换 tab 时旧扩展内容不会被销毁，
// 导致我们的面板残留并盖住其它扩展的侧边栏内容（别人的侧边栏"变成"看板娘设置）。
// 处理：1) 只移除自己的旧面板，绝不清空共用容器；
//      2) 轮询本 tab 按钮的选中态，非本 tab 激活时隐藏面板。
const PET_SETTINGS_PANEL_ID = "xbhh-pet-settings-panel";

function petTabSelected() {
    const btn =
        document.querySelector('[data-testid="xbhh-pet-settings-tab-button"]') ||
        Array.from(document.querySelectorAll(".side-bar-button")).find(
            (b) => (b.getAttribute("aria-label") || "").includes("看板娘设置"),
        );
    return (
        !!btn &&
        (btn.classList.contains("side-bar-button-selected") ||
            btn.classList.contains("selected"))
    );
}

function applyPetPanelVisibility() {
    const panel = document.getElementById(PET_SETTINGS_PANEL_ID);
    if (panel) panel.style.display = petTabSelected() ? "" : "none";
}

let petPanelWatchTimer = null;
function watchPetPanelVisibility() {
    applyPetPanelVisibility();
    if (!petPanelWatchTimer) {
        petPanelWatchTimer = setInterval(applyPetPanelVisibility, 400);
    }
}

// 渲染侧边栏「看板娘设置」面板（紧凑单行布局，说明收进悬浮 tooltip，长区块可折叠，即时保存）
function renderPetSettingsPanel(el) {
    // 只移除自己的旧面板（容器可能与其它扩展的侧边栏内容共存，不能 innerHTML 清空）
    const prev = document.getElementById(PET_SETTINGS_PANEL_ID);
    if (prev) prev.remove();

    el.style.overflowY = "auto";

    const panel = document.createElement("div");
    panel.id = PET_SETTINGS_PANEL_ID;
    panel.style.cssText = "overflow-y:auto; min-height:0;";

    const wrap = document.createElement("div");
    wrap.style.cssText =
        "padding: 12px; display: flex; flex-direction: column; gap: 10px; box-sizing: border-box; min-width: 0;";

    // 区块小标题（11px 灰字 + 细分隔线；详细说明收进悬浮 tooltip）
    const section = (text, tip) => {
        const s = document.createElement("div");
        s.style.cssText =
            "margin-top: 2px; padding-top: 10px; border-top: 1px solid #333; color: #7a8296; font-size: 11px; font-weight: 600;";
        s.textContent = text;
        if (tip) s.title = tip;
        return s;
    };

    // 开关行：文字左、开关右（一行）
    const swRow = (label, checked, tip, onchange) => {
        const row = document.createElement("label");
        row.style.cssText =
            "display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; color: #ccc; font-size: 12px;";
        if (tip) row.title = tip;
        const span = document.createElement("span");
        span.textContent = label;
        const sw = document.createElement("input");
        sw.type = "checkbox";
        sw.checked = !!checked;
        sw.style.cssText = "width: 17px; height: 17px; cursor: pointer; accent-color: #fa0; flex: none; margin: 0;";
        sw.onchange = () => onchange(sw.checked);
        row.appendChild(span);
        row.appendChild(sw);
        return row;
    };

    // 行内小复选项（多个可同排放）
    const swItem = (label, checked, tip, onchange) => {
        const lab = document.createElement("label");
        lab.style.cssText =
            "display: flex; align-items: center; gap: 4px; cursor: pointer; color: #ccc; font-size: 11px; white-space: nowrap;";
        if (tip) lab.title = tip;
        const sw = document.createElement("input");
        sw.type = "checkbox";
        sw.checked = !!checked;
        sw.style.cssText = "width: 15px; height: 15px; cursor: pointer; accent-color: #fa0; flex: none; margin: 0;";
        sw.onchange = () => onchange(sw.checked);
        lab.appendChild(sw);
        lab.appendChild(document.createTextNode(label));
        return lab;
    };

    // 标签 + 控件同行
    const inlineRow = (label, ctrl, tip) => {
        const row = document.createElement("div");
        row.style.cssText = "display: flex; align-items: center; gap: 8px; min-width: 0;";
        if (tip) row.title = tip;
        const lab = document.createElement("span");
        lab.style.cssText = "color: #ccc; font-size: 12px; flex: none;";
        lab.textContent = label;
        row.appendChild(lab);
        row.appendChild(ctrl);
        return row;
    };

    // 可折叠区块（开合状态记忆到 localStorage；头部 = 箭头 + 标题，grid-template-rows 0fr→1fr 下滑展开动画）
    const foldKey = "xbhh_pet_set_fold";
    let foldState = {};
    try { foldState = JSON.parse(localStorage.getItem(foldKey) || "{}") || {}; } catch (e) {}
    const saveFold = () => {
        try { localStorage.setItem(foldKey, JSON.stringify(foldState)); } catch (e) {}
    };
    const foldSection = (title, tip, id) => {
        const outer = document.createElement("div");
        const head = document.createElement("div");
        head.style.cssText =
            "margin-top: 2px; padding-top: 10px; border-top: 1px solid #333; display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none;";
        if (tip) head.title = tip;
        const chev = document.createElement("span");
        chev.style.cssText = "flex: none; display: flex; align-items: center; color: #7a8296; transition: transform .75s ease;";
        chev.innerHTML =
            '<svg viewBox="0 0 16 16" width="12" height="12"><polyline points="3,5.5 8,10.5 13,5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const t = document.createElement("span");
        t.style.cssText = "color: #7a8296; font-size: 11px; font-weight: 600;";
        t.textContent = title;
        head.addEventListener("mouseenter", () => { t.style.color = "#b6c0d4"; });
        head.addEventListener("mouseleave", () => { t.style.color = "#7a8296"; });
        const body = document.createElement("div");
        body.style.cssText = "display: grid; grid-template-rows: 1fr; transition: grid-template-rows .75s ease;";
        const inner = document.createElement("div");
        inner.style.cssText = "min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding-top: 10px;";
        body.appendChild(inner);
        head.appendChild(chev);
        head.appendChild(t);
        outer.appendChild(head);
        outer.appendChild(body);
        wrap.appendChild(outer);

        let open = foldState[id] !== false; // 默认展开，记住用户上次的开合状态
        const apply = () => {
            body.style.gridTemplateRows = open ? "1fr" : "0fr";
            chev.style.transform = open ? "none" : "rotate(-90deg)";
        };
        head.onclick = () => {
            open = !open;
            foldState[id] = open;
            saveFold();
            apply();
        };
        apply();
        return inner;
    };

    const textInput = (key, placeholder, isSecret) => {
        const inp = document.createElement("input");
        inp.type = isSecret ? "password" : "text";
        inp.value = window.xbhhSettings.get(key, "");
        inp.placeholder = placeholder || "";
        inp.spellcheck = false;
        inp.style.cssText =
            "width: 100%; box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 9px 11px; font-size: 13px; outline: none; font-family: inherit;";
        inp.addEventListener("change", () => window.xbhhSettings.set(key, inp.value));
        inp.addEventListener("input", () => window.xbhhSettings.set(key, inp.value));
        return inp;
    };

    const numInput = (key, def, min, width) => {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.value = window.xbhhSettings.get(key, def);
        inp.min = String(min);
        inp.step = "1";
        inp.style.cssText =
            "box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 5px 6px; font-size: 12px; outline: none; font-family: inherit; text-align: center;" +
            (width ? "width: " + width + "; flex: none;" : "width: 100%;");
        inp.addEventListener("change", () => {
            const v = parseInt(inp.value, 10);
            window.xbhhSettings.set(key, Number.isFinite(v) && v >= min ? v : def);
            inp.value = window.xbhhSettings.get(key, def);
        });
        return inp;
    };

    // 1) 启用开关
    wrap.appendChild(swRow(
        "启用看板娘",
        !!window.xbhhSettings.get("enable", true),
        "关闭会卸载模型并释放 CPU/GPU 资源",
        (v) => {
            window.xbhhSettings.set("enable", v);
            if (v) startLive2DPet();
            else cleanContainers();
        },
    ));

    // 2) AI 接口（可折叠：方案备份 / 地址 / Key / 模型(可拉列表) / 人设库）
    const apiBody = foldSection(
        "AI 接口",
        "OpenAI 兼容，DeepSeek / Ollama / Kimi / 千问 / 中转站均可，填到域名，/v1 可带可不带；Key 仅保存在本机，通过后端代理转发",
        "api",
    );
    const baseInp = textInput("baseURL", "https://api.deepseek.com", false);
    const keyInp = textInput("apiKey", "", true);
    const modelInp = textInput("model", "deepseek-chat", false);

    // ── 接口方案备份：把 地址+Key+模型 整套存成方案，切换源不丢配置 ──
    const PROFILES_KEY = "xbhh_pet_api_profiles";
    const loadProfiles = () => {
        try {
            const a = JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]");
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    };
    const saveProfiles = (a) => {
        try { localStorage.setItem(PROFILES_KEY, JSON.stringify(a)); } catch (e) {}
    };
    const flashBtn = (b, txt, ok) => {
        const old = b.textContent;
        b.textContent = txt;
        b.style.color = ok ? "#7ddf8f" : "#ff9c9c";
        setTimeout(() => { b.textContent = old; b.style.color = ""; }, 1600);
    };
    const apiBtn = (txt, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = txt;
        b.title = title;
        b.style.cssText = "flex: none; background: #333; color: #ddd; border: 1px solid #555; border-radius: 6px; padding: 5px 9px; font-size: 12px; cursor: pointer;";
        b.addEventListener("mouseenter", () => { b.style.borderColor = "#fa0"; });
        b.addEventListener("mouseleave", () => { b.style.borderColor = "#555"; });
        return b;
    };
    // 就地改名：把控件临时换成输入框，回车/失焦提交，Esc 取消（提交后回调 after）
    const inlineRename = (host, target, curName, apply, after) => {
        const inp = document.createElement("input");
        inp.value = curName;
        inp.style.cssText =
            "flex: 1 1 150px; min-width: 0; box-sizing: border-box; background: #221a10; color: #eee; border: 1px solid #7a5a22; border-radius: 6px; padding: 5px 8px; font-size: 12px; outline: none; font-family: inherit;";
        host.replaceChild(inp, target);
        inp.focus();
        inp.select();
        let done = false;
        const back = () => {
            if (inp.parentNode === host) host.replaceChild(target, inp);
            if (after) after();
        };
        const commit = () => {
            if (done) return;
            done = true;
            apply(inp.value.trim());
            back();
        };
        inp.addEventListener("blur", commit);
        inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") inp.blur();
            if (e.key === "Escape") { done = true; back(); }
        });
    };
    const selStyle = "flex: 1 1 150px; min-width: 0; box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 5px 6px; font-size: 12px; outline: none;";
    const profSel = document.createElement("select");
    profSel.style.cssText = selStyle;
    profSel.title = "切换已备份的接口方案（地址+Key+模型 整套替换）";
    const refreshProfSel = (sel) => {
        profSel.innerHTML = "";
        const ph = document.createElement("option");
        ph.value = "";
        ph.textContent = "— 已存方案（选择切换）—";
        profSel.appendChild(ph);
        loadProfiles().forEach((p, i) => {
            const o = document.createElement("option");
            o.value = String(i);
            o.textContent = p.name;
            profSel.appendChild(o);
        });
        profSel.value = sel != null ? String(sel) : "";
    };
    profSel.addEventListener("change", () => {
        const i = parseInt(profSel.value, 10);
        const list = loadProfiles();
        if (Number.isFinite(i) && i >= 0 && i < list.length) {
            window.xbhhSettings.set("baseURL", list[i].baseURL || "");
            window.xbhhSettings.set("apiKey", list[i].apiKey || "");
            window.xbhhSettings.set("model", list[i].model || "");
            baseInp.value = list[i].baseURL || "";
            keyInp.value = list[i].apiKey || "";
            modelInp.value = list[i].model || "";
        }
    });
    const readProfInputs = () => ({
        baseURL: (baseInp.value || "").trim(),
        apiKey: (keyInp.value || "").trim(),
        model: (modelInp.value || "").trim(),
    });
    const profNameFor = (list, p) => {
        let host = "";
        try { host = new URL(p.baseURL).hostname; } catch (e) {}
        const baseName = (host ? host + " · " : "") + (p.model || "未命名");
        let name = baseName, n = 2;
        while (list.some((x) => x.name === name)) name = baseName + " (" + n++ + ")";
        return name;
    };
    const profWrap = document.createElement("div");
    profWrap.style.cssText = "display: flex; gap: 6px; align-items: center; min-width: 0; flex: 1; flex-wrap: wrap;";
    const saveProfBtn = apiBtn("💾 保存", "把当前 地址 + Key + 模型 写回下拉选中的方案（名字不变）；没选方案时按当前内容新建一个");
    saveProfBtn.addEventListener("click", () => {
        const p = readProfInputs();
        if (!p.baseURL && !p.model) { flashBtn(saveProfBtn, "先填地址或模型", false); return; }
        const list = loadProfiles();
        const i = parseInt(profSel.value, 10);
        if (Number.isFinite(i) && i >= 0 && i < list.length) {
            list[i].baseURL = p.baseURL;
            list[i].apiKey = p.apiKey;
            list[i].model = p.model;
            saveProfiles(list);
            refreshProfSel(i);
            flashBtn(saveProfBtn, "已保存 ✓", true);
            return;
        }
        const j = list.findIndex((x) => x.baseURL === p.baseURL && x.model === p.model && x.apiKey === p.apiKey);
        if (j >= 0) { refreshProfSel(j); flashBtn(saveProfBtn, "已在库中", false); return; }
        list.push(Object.assign({ name: profNameFor(list, p) }, p));
        saveProfiles(list);
        refreshProfSel(list.length - 1);
        flashBtn(saveProfBtn, "已存 ✓", true);
    });
    const addProfBtn = apiBtn("＋ 另存", "把当前的 地址 + Key + 模型 另存成一个新方案（不动已选方案）");
    addProfBtn.addEventListener("click", () => {
        const p = readProfInputs();
        if (!p.baseURL && !p.model) { flashBtn(addProfBtn, "先填地址或模型", false); return; }
        const list = loadProfiles();
        if (list.some((x) => x.baseURL === p.baseURL && x.model === p.model && x.apiKey === p.apiKey)) {
            flashBtn(addProfBtn, "已存在", false);
            return;
        }
        list.push(Object.assign({ name: profNameFor(list, p) }, p));
        saveProfiles(list);
        refreshProfSel(list.length - 1);
        flashBtn(addProfBtn, "已另存 ✓", true);
    });
    const renProfBtn = apiBtn("✎", "重命名下拉选中的方案");
    renProfBtn.addEventListener("click", () => {
        const i = parseInt(profSel.value, 10);
        const list = loadProfiles();
        if (!Number.isFinite(i) || i < 0 || i >= list.length) { flashBtn(renProfBtn, "先选方案", false); return; }
        const oldName = list[i].name;
        inlineRename(profWrap, profSel, oldName, (nn) => {
            if (!nn || nn === oldName || list.some((x) => x.name === nn)) return;
            const l = loadProfiles();
            if (!l[i]) return;
            l[i].name = nn;
            saveProfiles(l);
        }, () => refreshProfSel(i));
    });
    const delProfBtn = apiBtn("🗑", "删除当前选中的方案");
    delProfBtn.addEventListener("click", () => {
        const i = parseInt(profSel.value, 10);
        const list = loadProfiles();
        if (!Number.isFinite(i) || i < 0 || i >= list.length) { flashBtn(delProfBtn, "先选方案", false); return; }
        list.splice(i, 1);
        saveProfiles(list);
        refreshProfSel("");
        flashBtn(delProfBtn, "已删除 ✓", true);
    });
    profWrap.appendChild(profSel);
    profWrap.appendChild(saveProfBtn);
    profWrap.appendChild(addProfBtn);
    profWrap.appendChild(renProfBtn);
    profWrap.appendChild(delProfBtn);
    apiBody.appendChild(inlineRow("方案", profWrap, "换接口源前先「＋ 另存」，之后下拉整套切换，Key 不会丢；改完地址/Key/模型点「💾 保存」写回选中的方案，「✎」可改名"));
    apiBody.appendChild(inlineRow("地址", baseInp));
    apiBody.appendChild(inlineRow("Key", keyInp, "本地 Ollama 可留空；仅保存在本机，通过后端代理转发"));

    // ── 模型：可手输，也可从接口拉取 /v1/models 列表后下拉选择 ──
    const modelDl = document.createElement("datalist");
    modelDl.id = "xbhh-model-datalist";
    modelInp.setAttribute("list", modelDl.id);
    const fetchModelBtn = apiBtn("↻ 获取列表", "从接口拉取可用模型列表，点输入框即可下拉选择；也支持手动输入");
    fetchModelBtn.addEventListener("click", async () => {
        const base = (baseInp.value || "").trim().replace(/\/+$/, "");
        if (!base) { flashBtn(fetchModelBtn, "先填地址", false); return; }
        const url = /\/v\d+$/.test(base) ? base + "/models" : base + "/v1/models";
        const key = (keyInp.value || "").trim().replace(/^Bearer\s+/i, "");
        const opt = { headers: {} };
        if (key) opt.headers.Authorization = "Bearer " + key;
        fetchModelBtn.textContent = "⏳ 拉取中";
        try {
            const r = await fetch(url, opt);
            if (!r.ok) throw new Error("HTTP " + r.status);
            const d = await r.json();
            let ids = Array.isArray(d) ? d : d && Array.isArray(d.data) ? d.data : [];
            ids = ids.map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean).sort();
            modelDl.innerHTML = "";
            ids.forEach((id) => {
                const o = document.createElement("option");
                o.value = id;
                modelDl.appendChild(o);
            });
            flashBtn(fetchModelBtn, "✓ " + ids.length + " 个", true);
        } catch (e) {
            flashBtn(fetchModelBtn, "✗ 失败(可手输)", false);
        }
    });
    const modelWrap = document.createElement("div");
    modelWrap.style.cssText = "display: flex; gap: 6px; align-items: center; min-width: 0; flex: 1;";
    modelWrap.appendChild(modelInp);
    modelWrap.appendChild(fetchModelBtn);
    modelWrap.appendChild(modelDl);
    apiBody.appendChild(inlineRow("模型", modelWrap, "手动输入或点「获取列表」从接口拉模型名（输入框获焦弹出下拉）；部分源不允许浏览器直连，拉取失败就手动填"));

    // ── 人设库：可存多套人设随时切换 ──
    const PERSONAS_KEY = "xbhh_pet_personas";
    const loadPersonas = () => {
        try {
            const a = JSON.parse(localStorage.getItem(PERSONAS_KEY) || "[]");
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    };
    const savePersonas = (a) => {
        try { localStorage.setItem(PERSONAS_KEY, JSON.stringify(a)); } catch (e) {}
    };
    const personaSel = document.createElement("select");
    personaSel.style.cssText = selStyle;
    personaSel.title = "切换已保存的人设（覆盖下方编辑框并立即生效）";
    const refreshPersonaSel = (sel) => {
        personaSel.innerHTML = "";
        const ph = document.createElement("option");
        ph.value = "";
        ph.textContent = "— 人设库（选择切换）—";
        personaSel.appendChild(ph);
        loadPersonas().forEach((p, i) => {
            const o = document.createElement("option");
            o.value = String(i);
            o.textContent = p.name;
            personaSel.appendChild(o);
        });
        personaSel.value = sel != null ? String(sel) : "";
    };
    personaSel.addEventListener("change", () => {
        const i = parseInt(personaSel.value, 10);
        const list = loadPersonas();
        if (Number.isFinite(i) && i >= 0 && i < list.length) {
            ta.value = list[i].text || "";
            window.xbhhSettings.set("persona", ta.value);
        }
    });
    const personaLibRow = document.createElement("div");
    personaLibRow.style.cssText = "display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap;";
    const personaNameFor = (list, text) => {
        const flat = text.replace(/\s+/g, " ").trim();
        const baseName = flat.slice(0, 12) + (flat.length > 12 ? "…" : "");
        let name = baseName, n = 2;
        while (list.some((x) => x.name === name)) name = baseName + " (" + n++ + ")";
        return name;
    };
    const savePersonaBtn = apiBtn("💾 保存", "把编辑框内容写回下拉选中的那套人设（名字不变）；没选人设时按当前内容新建一套");
    savePersonaBtn.addEventListener("click", () => {
        const text = (ta.value || "").trim();
        if (!text) { flashBtn(savePersonaBtn, "人设是空的", false); return; }
        const list = loadPersonas();
        const i = parseInt(personaSel.value, 10);
        if (Number.isFinite(i) && i >= 0 && i < list.length) {
            list[i].text = text;
            savePersonas(list);
            refreshPersonaSel(i);
            flashBtn(savePersonaBtn, "已保存 ✓", true);
            return;
        }
        const j = list.findIndex((x) => x.text === text);
        if (j >= 0) { refreshPersonaSel(j); flashBtn(savePersonaBtn, "已在库中", false); return; }
        list.push({ name: personaNameFor(list, text), text });
        savePersonas(list);
        refreshPersonaSel(list.length - 1);
        flashBtn(savePersonaBtn, "已存 ✓", true);
    });
    const addPersonaBtn = apiBtn("＋ 另存", "把编辑框内容另存成一套新人设（不动已选人设）");
    addPersonaBtn.addEventListener("click", () => {
        const text = (ta.value || "").trim();
        if (!text) { flashBtn(addPersonaBtn, "人设是空的", false); return; }
        const list = loadPersonas();
        if (list.some((x) => x.text === text)) { flashBtn(addPersonaBtn, "已存在", false); return; }
        list.push({ name: personaNameFor(list, text), text });
        savePersonas(list);
        refreshPersonaSel(list.length - 1);
        flashBtn(addPersonaBtn, "已另存 ✓", true);
    });
    const renPersonaBtn = apiBtn("✎", "重命名下拉选中的那套人设");
    renPersonaBtn.addEventListener("click", () => {
        const i = parseInt(personaSel.value, 10);
        const list = loadPersonas();
        if (!Number.isFinite(i) || i < 0 || i >= list.length) { flashBtn(renPersonaBtn, "先选人设", false); return; }
        const oldName = list[i].name;
        inlineRename(personaLibRow, personaSel, oldName, (nn) => {
            if (!nn || nn === oldName || list.some((x) => x.name === nn)) return;
            const l = loadPersonas();
            if (!l[i]) return;
            l[i].name = nn;
            savePersonas(l);
        }, () => refreshPersonaSel(i));
    });
    const delPersonaBtn = apiBtn("🗑", "删除选中的那套人设");
    delPersonaBtn.addEventListener("click", () => {
        const i = parseInt(personaSel.value, 10);
        const list = loadPersonas();
        if (!Number.isFinite(i) || i < 0 || i >= list.length) { flashBtn(delPersonaBtn, "先选人设", false); return; }
        list.splice(i, 1);
        savePersonas(list);
        refreshPersonaSel("");
        flashBtn(delPersonaBtn, "已删除 ✓", true);
    });
    const personaCtl = document.createElement("div");
    personaCtl.style.cssText = "display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1;";
    const ta = document.createElement("textarea");
    ta.value = window.xbhhSettings.get("persona", XBHH_DEFAULT_PERSONA);
    ta.rows = 8;
    ta.spellcheck = false;
    ta.style.cssText =
        "flex: 1; min-width: 0; box-sizing: border-box; min-height: 150px; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 9px 11px; font-size: 13px; line-height: 1.6; resize: vertical; outline: none; font-family: inherit;";
    ta.addEventListener("input", () => window.xbhhSettings.set("persona", ta.value));
    ta.addEventListener("change", () => window.xbhhSettings.set("persona", ta.value));
    personaLibRow.appendChild(personaSel);
    personaLibRow.appendChild(savePersonaBtn);
    personaLibRow.appendChild(addPersonaBtn);
    personaLibRow.appendChild(renPersonaBtn);
    personaLibRow.appendChild(delPersonaBtn);
    personaCtl.appendChild(personaLibRow);
    personaCtl.appendChild(ta);
    refreshProfSel("");
    refreshPersonaSel("");
    const personaRow = inlineRow("人设", personaCtl, "结尾的情绪标签会被前端识别并联动表情，删掉则不做表情联动；改完点「💾 保存」写回选中的人设，「＋ 另存」存成新的一套，「✎」可改名");
    personaRow.style.alignItems = "flex-start";
    apiBody.appendChild(personaRow);

    // ── 视觉模型（可折叠）──
    const visionBody = foldSection(
        "视觉模型",
        "对话里点 🖼 可挑最近生成的图让 AI 点评/挑选；主模型不支持看图（如 DeepSeek）时在这里配一个多模态模型当「眼睛」，分析结果会传给主模型作答；三项都留空则图片直接发给主模型（要求其本身支持视觉）",
        "vision",
    );
    visionBody.appendChild(inlineRow("地址", textInput("visionBaseURL", "留空复用主接口", false), "可以和主模型不同厂商，如 https://dashscope.aliyuncs.com/compatible-mode/v1"));
    visionBody.appendChild(inlineRow("Key", textInput("visionAPIKey", "留空复用主 Key", true), "仅保存在本机"));
    visionBody.appendChild(inlineRow("模型", textInput("visionModel", "如 qwen-vl-plus / glm-4v-flash", false), "留空 = 不用独立视觉模型，图片直接发给主模型"));

    // ── 自主创作 ──
    wrap.appendChild(section(
        "自主创作",
        "开启后，页面可见且你一段时间没操作时，AI 会自己决定画一张；冷却间隔防止频繁触发",
    ));
    wrap.appendChild(swRow("启用", !!window.xbhhSettings.get("autoEnable", false), "页面可见且一段时间没操作时，AI 会自己决定画一张", (v) => window.xbhhSettings.set("autoEnable", v)));
    const autoNums = document.createElement("div");
    autoNums.style.cssText = "display: flex; align-items: center; gap: 10px; color: #aaa; font-size: 11px; flex-wrap: wrap;";
    const numGroup = (label, key, def, min, unit, tip) => {
        const g = document.createElement("label");
        g.style.cssText = "display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap;";
        if (tip) g.title = tip;
        g.appendChild(document.createTextNode(label));
        g.appendChild(numInput(key, def, min, "44px"));
        g.appendChild(document.createTextNode(unit));
        return g;
    };
    autoNums.appendChild(numGroup("空闲", "autoIdleMin", 5, 1, "分", "多久没动鼠标/键盘视为不在场（分钟）"));
    autoNums.appendChild(numGroup("冷却", "autoCooldownMin", 30, 1, "分", "两次自主创作之间的最小间隔（分钟）"));
    autoNums.appendChild(numGroup("上限", "autoDailyLimit", 10, 0, "张", "每天最多生成的数量，0 表示不限"));
    wrap.appendChild(autoNums);

    // ── 自动看图 ──
    wrap.appendChild(section(
        "自动看图",
        "跑完自动把最新图给 AI 自检：点评质量、对比提示词找偏差（消耗视觉模型 token）；「自动重跑」在判定不合格时改写提示词、随机化 seed 并重新提交，单轮最多 3 次",
    ));
    const reviewRow = document.createElement("div");
    reviewRow.style.cssText = "display: flex; align-items: center; gap: 14px; flex-wrap: wrap;";
    reviewRow.appendChild(swItem("跑完点评", !!window.xbhhSettings.get("autoReview", false), "执行成功后自动附带最新图片让 AI 自检", (v) => window.xbhhSettings.set("autoReview", v)));
    reviewRow.appendChild(swItem("自动重跑", !!window.xbhhSettings.get("autoReviewRerun", false), "判定不合格时自动改写提示词重新生成（单轮最多 3 次）", (v) => window.xbhhSettings.set("autoReviewRerun", v)));
    wrap.appendChild(reviewRow);

    // ── AI 技能 ──
    wrap.appendChild(section(
        "AI 技能",
        "关闭的技能不注入对应指令、不暴露对应工具（省 token、防误触发）；画图与运行工作流为核心能力，始终开启",
    ));
    const skillRow = document.createElement("div");
    skillRow.style.cssText = "display: flex; align-items: center; gap: 12px; flex-wrap: wrap;";
    const skillItem = (key, label, tip) =>
        swItem(label, window.xbhhSettings.get(key, true) !== false, tip, (v) => window.xbhhSettings.set(key, v));
    skillRow.appendChild(skillItem("skillPrompt", "提示词", "AI 画图/写提示词时按分类填写画布上的提示词节点"));
    skillRow.appendChild(skillItem("skillLora", "LoRA", "允许 AI 添加/移除/调权重/随机搭配 LoRA 堆"));
    skillRow.appendChild(skillItem("skillModel", "大模型", "允许 AI 按需求切换 Checkpoint / UNET 大模型"));
    wrap.appendChild(skillRow);

    // ── 提示词分类（可折叠：分类列表 + Skill 库）──
    const catBody = foldSection(
        "提示词分类 / Skill",
        "AI 按分类填写提示词，写入位置在分类行右侧下拉绑定（「自动」= 按节点标题匹配）；未匹配的合并进「其他」节点，画布无分类入口时整段写入正向提示词；Skill 库可上传 TXT 编写规范并切换",
        "cats",
    );

    const catListBox = document.createElement("div");
    catListBox.style.cssText = "display: flex; flex-direction: column; gap: 6px;";
    catBody.appendChild(catListBox);

    // 画布上的文本输入节点（输出 STRING 类型）作为绑定下拉选项；判定逻辑统一在 v2_pet 的 xbhhListTextNodes
    const canvasTextNodes =
        typeof window.xbhhListTextNodes === "function" ? window.xbhhListTextNodes() : [];

    const renderCatList = () => {
        catListBox.innerHTML = "";
        const cats = window.xbhhGetCategories();
        const getMap = () => window.xbhhGetBoundMap("promptSlotMap");
        cats.forEach((name, idx) => {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; gap: 6px; align-items: center;";
            const inp = document.createElement("input");
            inp.type = "text";
            inp.value = name;
            inp.spellcheck = false;
            inp.style.cssText =
                "flex: 1; box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 7px 10px; font-size: 12px; outline: none; font-family: inherit;";
            inp.addEventListener("change", () => {
                const v = inp.value.trim();
                const list = window.xbhhGetCategories();
                // 空名或与其他分类重名则还原
                if (!v || list.some((x, i) => x === v && i !== idx)) { inp.value = name; return; }
                list[idx] = v;
                window.xbhhSetCategories(list);
                // 同步迁移绑定映射的 key
                const map = getMap();
                if (Object.prototype.hasOwnProperty.call(map, name)) {
                    map[v] = map[name];
                    delete map[name];
                    window.xbhhSetBoundMap("promptSlotMap", map);
                }
            });
            // 绑定节点下拉：选具体节点后 AI 填写固定走该节点；"自动"= 按节点标题匹配
            const sel = document.createElement("select");
            sel.title = "绑定画布节点后，AI 写入该分类时固定填进这个节点；「自动」= 按节点标题含分类名匹配";
            sel.style.cssText =
                "flex: 1; box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 6px 6px; font-size: 12px; outline: none; font-family: inherit; min-width: 0;";
            const autoOpt = document.createElement("option");
            autoOpt.value = "";
            autoOpt.textContent = "自动";
            sel.appendChild(autoOpt);
            for (const n of canvasTextNodes) {
                const o = document.createElement("option");
                o.value = n.id;
                o.textContent = `#${n.id} ${n.title}`.slice(0, 26);
                sel.appendChild(o);
            }
            sel.value = String(getMap()[name] || "");
            if (sel.selectedIndex < 0) sel.value = ""; // 绑定的节点已被删除时回退「自动」
            sel.addEventListener("change", () => {
                const map = getMap();
                if (sel.value) map[name] = sel.value;
                else delete map[name];
                window.xbhhSetBoundMap("promptSlotMap", map);
            });
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "✕";
            del.title = "删除该分类";
            del.style.cssText =
                "width: 26px; height: 26px; flex: none; background: #331; color: #fa0; border: 1px solid #553; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;";
            del.onclick = () => {
                const list = window.xbhhGetCategories();
                list.splice(idx, 1);
                window.xbhhSetCategories(list);
                const map = getMap();
                delete map[name];
                window.xbhhSetBoundMap("promptSlotMap", map);
                renderCatList();
            };
            row.appendChild(inp);
            row.appendChild(sel);
            row.appendChild(del);
            catListBox.appendChild(row);
        });
        // 底部添加行
        const addRow = document.createElement("div");
        addRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
        const addInp = document.createElement("input");
        addInp.type = "text";
        addInp.placeholder = "新分类名";
        addInp.spellcheck = false;
        addInp.style.cssText =
            "flex: 1; box-sizing: border-box; background: #1a1a1a; color: #bbb; border: 1px dashed #555; border-radius: 6px; padding: 7px 10px; font-size: 12px; outline: none; font-family: inherit;";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.textContent = "＋";
        addBtn.title = "添加分类";
        addBtn.style.cssText =
            "height: 28px; flex: none; background: #fa0; color: #222; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 700; padding: 0 10px;";
        const addCat = () => {
            const v = addInp.value.trim();
            if (!v) return;
            const list = window.xbhhGetCategories();
            if (list.includes(v)) { addInp.value = ""; return; } // 重名不添加
            list.push(v);
            window.xbhhSetCategories(list);
            addInp.value = "";
            renderCatList();
        };
        addBtn.onclick = addCat;
        addInp.addEventListener("keydown", (e) => { if (e.key === "Enter") addCat(); });
        addRow.appendChild(addInp);
        addRow.appendChild(addBtn);
        catListBox.appendChild(addRow);
    };
    renderCatList();

    // ── 提示词编写 Skill 库：上传 TXT/新建多个规范，下拉切换当前生效的 ──
    // promptSkills=[{name,doc}]；promptSkillActive：""=内置 Anima 规范，"none"=内置兜底，否则技能名
    const getSkills = () => {
        const v = window.xbhhSettings.get("promptSkills", []);
        return Array.isArray(v) ? v.filter((s) => s && s.name) : [];
    };
    const uniqName = (base, list) => {
        let n = base, i = 2;
        while (list.some((s) => s.name === n)) n = base + " (" + i++ + ")";
        return n;
    };

    // 当前使用下拉
    const activeSel = document.createElement("select");
    activeSel.title = "选择当前生效的提示词编写规范";
    activeSel.style.cssText =
        "flex: 1; box-sizing: border-box; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 7px 8px; font-size: 12px; outline: none; font-family: inherit; min-width: 0;";
    // 新建 / 上传按钮
    const mkBtn = (text, tip) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = tip;
        b.style.cssText =
            "flex: none; background: #33270f; color: #fa0; border: 1px solid #664a1a; border-radius: 6px; padding: 7px 10px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap;";
        return b;
    };
    const newBtn = mkBtn("＋新建", "新建一个空白的提示词编写技能");
    const upBtn = mkBtn("上传TXT", "从本地 TXT/MD 文件导入一个提示词编写技能");
    const fileInp = document.createElement("input");
    fileInp.type = "file";
    fileInp.accept = ".txt,.md,text/plain";
    fileInp.style.display = "none";
    const selRow = document.createElement("div");
    selRow.style.cssText = "display: flex; gap: 6px; align-items: center;";
    selRow.appendChild(activeSel);
    selRow.appendChild(newBtn);
    selRow.appendChild(upBtn);
    selRow.appendChild(fileInp);
    catBody.appendChild(selRow);

    // 技能列表（点击名称启用，✕ 删除）
    const skillListBox = document.createElement("div");
    skillListBox.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
    catBody.appendChild(skillListBox);

    // 文档编辑区（选中用户技能时可编辑，自动保存）
    const docTa = document.createElement("textarea");
    docTa.rows = 4;
    docTa.spellcheck = false;
    docTa.style.cssText =
        "width: 100%; box-sizing: border-box; min-height: 70px; background: #222; color: #eee; border: 1px solid #555; border-radius: 6px; padding: 8px 10px; font-size: 12px; line-height: 1.6; resize: vertical; outline: none; font-family: inherit;";
    let docTimer = null;
    docTa.addEventListener("input", () => {
        // 即时保存进当前选中的技能（防抖 500ms，中文输入法组合期间不落半截字）
        clearTimeout(docTimer);
        docTimer = setTimeout(() => {
            const active = String(window.xbhhSettings.get("promptSkillActive", "") || "");
            const list = getSkills();
            const sk = list.find((s) => s.name === active);
            if (!sk) return;
            sk.doc = docTa.value;
            window.xbhhSettings.set("promptSkills", list);
        }, 500);
    });
    docTa.addEventListener("change", () => {
        clearTimeout(docTimer);
        const active = String(window.xbhhSettings.get("promptSkillActive", "") || "");
        const list = getSkills();
        const sk = list.find((s) => s.name === active);
        if (!sk) return;
        sk.doc = docTa.value;
        window.xbhhSettings.set("promptSkills", list);
    });
    catBody.appendChild(docTa);

    const renderSkills = () => {
        const list = getSkills();
        let active = String(window.xbhhSettings.get("promptSkillActive", "") || "");
        if (active !== "none" && !list.some((s) => s.name === active)) active = "";
        // 下拉选项
        activeSel.innerHTML = "";
        const optDefs = [
            ["", "当前使用：Anima 内置规范"],
            ["none", "当前使用：内置兜底规范"],
        ];
        for (const [val, label] of optDefs) {
            const o = document.createElement("option");
            o.value = val;
            o.textContent = label;
            activeSel.appendChild(o);
        }
        for (const s of list) {
            const o = document.createElement("option");
            o.value = s.name;
            o.textContent = "当前使用：" + s.name;
            activeSel.appendChild(o);
        }
        activeSel.value = active;
        // 技能列表
        skillListBox.innerHTML = "";
        list.forEach((s, idx) => {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; gap: 6px; align-items: center;";
            const nameB = document.createElement("button");
            nameB.type = "button";
            nameB.textContent = (s.name === active ? "● " : "○ ") + s.name;
            nameB.title = s.name === active ? "当前生效中" : "点击启用该技能";
            const on = s.name === active;
            nameB.style.cssText =
                "flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: " +
                (on ? "#3a2a10" : "#222") +
                "; color: " +
                (on ? "#ffc46b" : "#ccc") +
                "; border: 1px solid " +
                (on ? "#7a5a22" : "#555") +
                "; border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit;";
            nameB.onclick = () => {
                window.xbhhSettings.set("promptSkillActive", s.name);
                renderSkills();
            };
            const renB = document.createElement("button");
            renB.type = "button";
            renB.textContent = "✎";
            renB.title = "重命名（改名后自动保留内容和启用状态）";
            renB.style.cssText =
                "width: 26px; height: 26px; flex: none; background: #16202c; color: #8ab4ff; border: 1px solid #553; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;";
            renB.onclick = () => {
                const inp = document.createElement("input");
                inp.value = s.name;
                inp.style.cssText =
                    "flex: 1; min-width: 0; background: #221a10; color: #eee; border: 1px solid #7a5a22; border-radius: 6px; padding: 5px 8px; font-size: 12px; font-family: inherit;";
                row.replaceChild(inp, nameB);
                inp.focus();
                inp.select();
                let done = false;
                const commit = () => {
                    if (done) return;
                    done = true;
                    const nn = inp.value.trim();
                    if (nn && nn !== s.name && !list.some((x) => x.name === nn)) {
                        const l = getSkills();
                        const it = l.find((x) => x.name === s.name);
                        if (it) it.name = nn;
                        window.xbhhSettings.set("promptSkills", l);
                        // 启用中的技能改名 → 同步激活指针，保持生效不断
                        if (
                            String(window.xbhhSettings.get("promptSkillActive", "")) ===
                            s.name
                        ) {
                            window.xbhhSettings.set("promptSkillActive", nn);
                        }
                    }
                    renderSkills();
                };
                inp.addEventListener("blur", commit);
                inp.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") inp.blur();
                    if (e.key === "Escape") {
                        done = true;
                        renderSkills();
                    }
                });
            };
            const delB = document.createElement("button");
            delB.type = "button";
            delB.textContent = "✕";
            delB.title = "删除该技能";
            delB.style.cssText =
                "width: 26px; height: 26px; flex: none; background: #331; color: #fa0; border: 1px solid #553; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;";
            delB.onclick = () => {
                const l = getSkills();
                l.splice(idx, 1);
                window.xbhhSettings.set("promptSkills", l);
                if (String(window.xbhhSettings.get("promptSkillActive", "")) === s.name) {
                    window.xbhhSettings.set("promptSkillActive", "");
                }
                renderSkills();
            };
            row.appendChild(nameB);
            row.appendChild(renB);
            row.appendChild(delB);
            skillListBox.appendChild(row);
        });
        // 编辑区状态
        if (active === "none") {
            docTa.value = "";
            docTa.disabled = true;
            docTa.placeholder = "使用内置兜底规范（无自定义文档）";
        } else if (!active) {
            docTa.value = window.xbhhAnimaDoc || "";
            docTa.disabled = true;
            docTa.placeholder = "内置 Anima 规范（不可编辑；新建技能后可自定义）";
        } else {
            const sk = list.find((x) => x.name === active);
            docTa.value = sk ? sk.doc || "" : "";
            docTa.disabled = false;
            docTa.placeholder = "该技能的提示词编写规范（可编辑，自动保存）";
        }
    };
    activeSel.addEventListener("change", () => {
        window.xbhhSettings.set("promptSkillActive", activeSel.value);
        renderSkills();
    });
    newBtn.onclick = () => {
        const list = getSkills();
        const name = uniqName("新技能", list);
        list.push({ name, doc: "" });
        window.xbhhSettings.set("promptSkills", list);
        window.xbhhSettings.set("promptSkillActive", name);
        renderSkills();
        docTa.focus();
    };
    upBtn.onclick = () => fileInp.click();
    fileInp.addEventListener("change", () => {
        const f = fileInp.files && fileInp.files[0];
        fileInp.value = "";
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
            const list = getSkills();
            const base = f.name.replace(/\.(txt|md|json)$/i, "").trim() || "导入技能";
            const name = uniqName(base, list);
            list.push({ name, doc: String(rd.result || "").slice(0, 20000) });
            window.xbhhSettings.set("promptSkills", list);
            window.xbhhSettings.set("promptSkillActive", name);
            renderSkills();
        };
        rd.readAsText(f, "utf-8");
    });
    renderSkills();

    // ── 画师串库 ──
    // 用户自己维护画师组合（画风效果主要靠画师串），AI 写画风类提示词时按风格挑用
    const artistLblRow = document.createElement("div");
    artistLblRow.style.cssText =
        "display: flex; align-items: center; gap: 8px; margin: 10px 0 4px;";
    const artistLbl = document.createElement("div");
    artistLbl.textContent = "画师串库";
    artistLbl.style.cssText = "font-size: 11px; color: #8b93a8; flex: 1;";
    const artistUpBtn = document.createElement("button");
    artistUpBtn.type = "button";
    artistUpBtn.textContent = "上传TXT";
    artistUpBtn.title = "从 TXT 导入画师串（按行读取，追加到库里，自动跳过重复行）";
    artistUpBtn.style.cssText =
        "background: #2a2317; color: #d8c9a8; border: 1px solid #553; border-radius: 8px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit;";
    const artistFile = document.createElement("input");
    artistFile.type = "file";
    artistFile.accept = ".txt,.md,text/plain";
    artistFile.style.display = "none";
    artistUpBtn.onclick = () => artistFile.click();
    artistFile.onchange = () => {
        const f = artistFile.files && artistFile.files[0];
        artistFile.value = "";
        if (!f) return;
        if (f.size > 64 * 1024) {
            artistUpBtn.textContent = "文件过大（>64KB）";
            setTimeout(() => (artistUpBtn.textContent = "上传TXT"), 2000);
            return;
        }
        const r = new FileReader();
        r.onload = () => {
            const text = String(r.result || "");
            const existing = new Set(
                artistTa.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean),
            );
            let added = 0;
            let skipped = 0;
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line) continue;
                if (existing.has(line)) {
                    skipped++;
                    continue;
                }
                existing.add(line);
                added++;
            }
            artistTa.value = Array.from(existing).join("\n");
            artistTa.dispatchEvent(new Event("input"));
            artistUpBtn.textContent = added
                ? `已导入 ${added} 行${skipped ? `（跳过重复 ${skipped}）` : ""}`
                : "没有新增行";
            setTimeout(() => (artistUpBtn.textContent = "上传TXT"), 2500);
        };
        r.onerror = () => {
            artistUpBtn.textContent = "读取失败";
            setTimeout(() => (artistUpBtn.textContent = "上传TXT"), 2000);
        };
        r.readAsText(f, "utf-8");
    };
    artistLblRow.appendChild(artistLbl);
    artistLblRow.appendChild(artistUpBtn);
    artistLblRow.appendChild(artistFile);
    const artistTa = document.createElement("textarea");
    artistTa.rows = 5;
    artistTa.value = String(window.xbhhSettings.get("artistStrings", "") || "");
    artistTa.placeholder =
        "每行一条画师串，可用「关键词: 串」标注适用风格，AI 按画风自动挑用：\n水彩: @artistA, @artistB\n厚涂: @artistC\n@artistD（无关键词=通用）";
    artistTa.style.cssText =
        "width: 100%; box-sizing: border-box; background: #221a10; color: #eee; border: 1px solid #553; border-radius: 8px; padding: 8px; font-size: 12px; font-family: inherit; resize: vertical; line-height: 1.6;";
    let artistTimer = null;
    artistTa.addEventListener("input", () => {
        clearTimeout(artistTimer);
        artistTimer = setTimeout(
            () => window.xbhhSettings.set("artistStrings", artistTa.value.trim()),
            400,
        );
    });
    wrap.appendChild(artistLblRow);
    wrap.appendChild(artistTa);

    // ── LoRA 堆绑定 ──
    // 分类 → 堆节点 映射（和提示词槽位绑定同思路）：画风 LoRA 进画风堆，人物进人物堆
    const heapLbl = document.createElement("div");
    heapLbl.textContent = "LoRA 堆绑定（分类 → 堆节点）";
    heapLbl.style.cssText =
        "font-size: 11px; color: #8b93a8; margin: 10px 0 4px;";
    const heapList = document.createElement("div");
    heapList.style.cssText = "display: flex; flex-direction: column; gap: 6px;";
    const heapAdd = document.createElement("button");
    heapAdd.type = "button";
    heapAdd.textContent = "＋ 添加绑定";
    heapAdd.style.cssText =
        "margin-top: 6px; background: #2a2317; color: #d8c9a8; border: 1px solid #553; border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; align-self: flex-start;";
    const heapTypes = ["XBHHMultiLoraLoader", "XBHHMultiLoraLoaderPlus"];
    const heapNodes = () =>
        ((app.graph && (app.graph._nodes || [])) || []).filter(
            (n) => n && heapTypes.includes(n.type),
        );
    const getHeapMap = () => window.xbhhGetBoundMap("loraHeapMap");
    const renderHeapRows = () => {
        const map = getHeapMap();
        const nodes = heapNodes();
        // 绑定的节点已被删除 → 自动清掉该条
        let dirty = false;
        for (const k of Object.keys(map)) {
            if (!nodes.some((n) => String(n.id) === String(map[k]))) {
                delete map[k];
                dirty = true;
            }
        }
        if (dirty) window.xbhhSetBoundMap("loraHeapMap", map);
        heapList.innerHTML = "";
        const keys = Object.keys(map);
        if (!keys.length) {
            const empty = document.createElement("div");
            empty.textContent = "还没有绑定。工作流里有多个堆时建议全绑上，AI 按分类自动路由";
            empty.style.cssText = "font-size: 11px; color: #777; padding: 2px 0;";
            heapList.appendChild(empty);
        }
        for (const k of keys) {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; gap: 6px; align-items: center;";
            const catInp = document.createElement("input");
            catInp.value = k;
            catInp.placeholder = "分类";
            catInp.style.cssText =
                "width: 84px; flex: none; background: #221a10; color: #eee; border: 1px solid #553; border-radius: 8px; padding: 6px 8px; font-size: 12px;";
            catInp.onchange = () => {
                const m = getHeapMap();
                const nk = catInp.value.trim();
                if (!nk || (nk !== k && m[nk] !== undefined)) {
                    renderHeapRows();
                    return;
                }
                m[nk] = m[k];
                delete m[k];
                window.xbhhSetBoundMap("loraHeapMap", m);
                renderHeapRows();
            };
            const sel = document.createElement("select");
            sel.style.cssText =
                "flex: 1; background: #221a10; color: #eee; border: 1px solid #553; border-radius: 8px; padding: 6px 8px; font-size: 12px;";
            for (const n of nodes) {
                const o = document.createElement("option");
                o.value = String(n.id);
                o.textContent = `#${n.id} ${n.title || n.type}`;
                sel.appendChild(o);
            }
            sel.value = String(map[k]);
            sel.onchange = () => {
                const m = getHeapMap();
                m[k] = sel.value;
                window.xbhhSetBoundMap("loraHeapMap", m);
            };
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "✕";
            del.title = "删除该绑定";
            del.style.cssText =
                "width: 26px; height: 28px; flex: none; background: #331; color: #fa0; border: 1px solid #553; border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;";
            del.onclick = () => {
                const m = getHeapMap();
                delete m[k];
                window.xbhhSetBoundMap("loraHeapMap", m);
                renderHeapRows();
            };
            row.appendChild(catInp);
            row.appendChild(sel);
            row.appendChild(del);
            heapList.appendChild(row);
        }
    };
    heapAdd.onclick = () => {
        const m = getHeapMap();
        const nodes = heapNodes();
        if (!nodes.length) {
            heapLbl.textContent = "LoRA 堆绑定（画布上没找到 LoRA 堆节点）";
            return;
        }
        // 新行默认取未绑定的第一个堆，分类名默认「画风/人物/环境…」顺延
        const usedIds = new Set(Object.values(m).map(String));
        const free = nodes.find((n) => !usedIds.has(String(n.id))) || nodes[0];
        const baseNames = ["画风", "人物", "角色", "环境", "场景"];
        let name =
            baseNames.find((b) => m[b] === undefined && b) ||
            `分类${Object.keys(m).length + 1}`;
        while (m[name] !== undefined) name += "1";
        m[name] = String(free.id);
        window.xbhhSetBoundMap("loraHeapMap", m);
        renderHeapRows();
    };
    renderHeapRows();
    wrap.appendChild(heapLbl);
    wrap.appendChild(heapList);
    wrap.appendChild(heapAdd);

    // ── 小鲸鱼挂件 ──
    wrap.appendChild(section(
        "小鲸鱼挂件",
        "LoRA 管理器页面右下角显示 DeepSeek 余额小鲸鱼（余额 + 今日已用，差值自动记账），复用上方 AI API Key",
    ));
    wrap.appendChild(swRow(
        "启用",
        localStorage.getItem("xbhh_whale_on") !== "0",
        "开关即时生效，LoRA 管理器页面已打开时也会实时更新",
        (v) => {
            try { localStorage.setItem("xbhh_whale_on", v ? "1" : "0"); } catch (e) {}
            if (typeof window.xbhhWhaleSetEnabled === "function") {
                window.xbhhWhaleSetEnabled(v);
            }
        },
    ));

    panel.appendChild(wrap);
    el.appendChild(panel);
    watchPetPanelVisibility();
}

// ============================================================================
// 对话消耗提示：对话完成后调用小鲸鱼冒泡，显示本次 token 消耗与今日已用金额
// ============================================================================
window.xbhhShowPetTokenNote = function (usage) {
    try {
        if (typeof window.xbhhWhaleNote !== "function") return;
        const u = usage || {};
        let total = Number(u.total_tokens);
        if (!isFinite(total) || total <= 0) {
            total = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
        }
        if (!isFinite(total) || total <= 0) return; // 拿不到 usage 就不冒泡

        // 今日已用金额优先读小鲸鱼挂件的余额账本；没数据时顺手触发一次刷新
        let today = "--";
        if (typeof window.xbhhWhaleGetUsage === "function") {
            const wu = window.xbhhWhaleGetUsage();
            if (wu && wu.todayUsage !== null && wu.todayUsage !== undefined) {
                const num = Number(wu.todayUsage);
                if (isFinite(num)) today = "¥ " + num.toFixed(2);
            } else if (typeof window.xbhhWhaleRefresh === "function") {
                window.xbhhWhaleRefresh();
            }
        }

        window.xbhhWhaleNote([
            { t: "本次对话", s: "A" },
            { t: total.toLocaleString("en-US"), s: "B" },
            { t: "tokens｜今日已用 " + today, s: "C", w: true },
        ]);
    } catch (e) {}
};

// ============================================================================
// 自主创作（偷偷画画）：空闲检测 → LLM 决策 → 注入提示词 → 运行工作流
// ============================================================================
let lastActivityAt = Date.now();
let lastAutoAttemptAt = 0;
let autoThinking = false;
let autoWarnedDisabled = false;

// 键盘/鼠标活动即认为「用户在场」
["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, () => { lastActivityAt = Date.now(); }, { passive: true }),
);

function autoDailyKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function autoCountToday() {
    try {
        const raw = JSON.parse(localStorage.getItem("xbhh_auto_count") || "{}");
        return raw[autoDailyKey()] || 0;
    } catch (e) {
        return 0;
    }
}

function autoBumpCount() {
    try {
        const raw = JSON.parse(localStorage.getItem("xbhh_auto_count") || "{}");
        raw[autoDailyKey()] = (raw[autoDailyKey()] || 0) + 1;
        localStorage.setItem("xbhh_auto_count", JSON.stringify(raw));
    } catch (e) {}
}

// ============================================================================
// 工作流工具：随机化采样器 seed（提示词注入将改由专属 AI 输入节点实现，待开发）
// ============================================================================
function xbhhAllNodes(graph) {
    return (graph && (graph._nodes || graph.nodes)) || [];
}

// 是否采样器节点（KSampler / KSamplerAdvanced / 自定义采样器）
function xbhhIsSampler(node) {
    return !!node && /^(KSampler|KSamplerAdvanced|SamplerCustom.*|.*Sampler)$/.test(node.type || "");
}

// 随机化采样器的 seed，让每次偷偷画的图都不一样
function randomizeSeeds(graph) {
    const nodes = xbhhAllNodes(graph);
    for (const node of nodes) {
        if (!xbhhIsSampler(node)) continue;
        const seedW = (node.widgets || []).find((w) => w && w.name === "seed");
        if (seedW) seedW.value = Math.floor(Math.random() * 1e14) + 1;
        const ctrlW = (node.widgets || []).find(
            (w) => w && (w.name === "control_after_generate" || w.name === "control_after_queue"),
        );
        if (ctrlW) ctrlW.value = "randomize";
    }
}

// 按画布当前内容提交工作流；成功返回 true
async function autoGenerate() {
    const graph = app.graph;
    if (!graph) return false;
    randomizeSeeds(graph);
    if (app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true);
    if (graph.setDirtyCanvas) graph.setDirtyCanvas(true, true);
    if (typeof app.queuePrompt !== "function") return false;
    try {
        await app.queuePrompt(0);
        return true;
    } catch (e) {
        console.warn("[XBHH] autoGenerate queuePrompt failed:", e);
        return false;
    }
}

// 调用 LLM 让 AI 决定是否偷偷画一张，并执行；成功提交队列返回 true
async function autoInspire() {
    const s = window.xbhhSettings;
    const base_url = s.get("baseURL", "https://api.deepseek.com");
    const api_key = s.get("apiKey", "");
    const model = s.get("model", "deepseek-chat");

    if (!api_key) {
        console.warn("[XBHH auto] 未配置 API Key，无法让 AI 自主选题");
        return false;
    }

    let data = {};
    try {
        const resp = await fetch("/xbhh/pet/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [
                    { role: "user", content: "（自主创作触发）现在想画点什么？发挥你的想象力，决定是否画以及画什么。" },
                ],
                config: {
                    base_url,
                    api_key,
                    model,
                    system_prompt: AUTO_PERSONA,
                },
                // 技能开关 + 提示词槽位（与聊天请求一致，AI 会先按分类填词）
                skills: {
                    prompt: s.get("skillPrompt", true) !== false,
                    lora: s.get("skillLora", true) !== false,
                    model: s.get("skillModel", true) !== false,
                },
                prompt_slots: (typeof window.xbhhCollectPromptSlots === "function")
                    ? window.xbhhCollectPromptSlots()
                    : { categories: [], skill_doc: "" },
                skip_lora: true, // autoInspire 不需要 LoRA 统计，节省 Token
            }),
        });
        data = await resp.json().catch(() => ({}));
    } catch (e) {
        console.warn("[XBHH auto] 调用 /xbhh/pet/chat 异常：", e);
        return false;
    }

    console.log("[XBHH auto] LLM 响应：", {
        success: data.success,
        reply: data.reply,
        tool_calls: data.tool_calls,
    });

    if (!data.success) {
        console.warn("[XBHH auto] 对话失败：", data.message || data);
        return false;
    }

    const toolCalls = data.tool_calls || [];

    // 先让 AI 分类填写提示词（write_prompts）——填完词再跑图才能带上新内容
    let promptMsg = "";
    const promptCalls = toolCalls.filter((t) => t.name === "write_prompts");
    if (promptCalls.length && typeof window.xbhhHandlePromptToolCalls === "function") {
        try {
            const results = await window.xbhhHandlePromptToolCalls(promptCalls);
            if (results && results.length) {
                promptMsg = results.join("\n");
                console.log("[XBHH auto] AI 分类填写提示词：", results);
            }
        } catch (e) {
            console.warn("[XBHH auto] write_prompts 执行失败：", e);
        }
    }

    // 先让 AI 自主配置 LoRA 堆（结合用户喜好挑组合、定权重）
    let loraMsg = "";
    const loraCalls = toolCalls.filter((t) =>
        ["add_lora", "remove_lora", "set_lora_strength", "auto_style_loras", "random_style_loras"].includes(t.name),
    );
    if (loraCalls.length && typeof window.xbhhHandleLoraToolCalls === "function") {
        const results = await window.xbhhHandleLoraToolCalls(loraCalls);
        if (results && results.length) {
            loraMsg = results.join("\n");
            console.log("[XBHH auto] AI 自主配置 LoRA：", results);
        }
    }

    const toolCall = toolCalls.find((t) => t.name === "generate_image");
    // run_workflow 也视为「想画」的信号（AI 决定直接用当前画布内容画）
    const runCall = toolCalls.find((t) => t.name === "run_workflow");
    if (!toolCall && !runCall) {
        console.log("[XBHH auto] LLM 本次没有返回 generate_image / run_workflow 指令（没灵感）");
        return false;
    }

    const prompt = (toolCall && toolCall.arguments && toolCall.arguments.prompt) || "";
    if (!prompt && !runCall) {
        console.warn("[XBHH auto] generate_image 缺少 prompt 参数");
        return false;
    }

    console.log("[XBHH auto] 准备生成，主题：", prompt);
    const ok = await autoGenerate();
    if (!ok) {
        console.warn("[XBHH auto] autoGenerate 提交失败（queuePrompt 失败）");
        return false;
    }

    autoBumpCount();
    const brief = prompt
        ? (prompt.length > 24 ? prompt.slice(0, 24) + "…" : prompt)
        : "当前画布的主题";
    const briefLine = loraMsg
        ? `趁你不注意我偷偷配了 LoRA：\n${loraMsg}\n还画了一幅「${brief}」～`
        : `嘿嘿，趁你不注意我偷偷画了一幅「${brief}」～`;
    window.xbhhLive2DPet?.showMessage?.(
        promptMsg ? `${promptMsg}\n${briefLine}` : briefLine,
        8000,
        9,
    );
    console.log("[XBHH auto] 已成功提交队列并计入统计");
    return true;
}

// 定时检查是否满足「偷偷创作」条件
function startAutoCanvas() {
    setInterval(() => {
        if (autoThinking) return;

        const s = window.xbhhSettings;
        const enabled = !!s.get("autoEnable", false);

        if (!enabled) {
            if (!autoWarnedDisabled) {
                autoWarnedDisabled = true;
                console.warn(
                    "[XBHH auto] 自主创作未开启：请在左侧「看板娘设置」面板打开「自主创作」开关",
                );
            }
            return;
        }

        if (!window.xbhhLive2DPet) {
            console.log("[XBHH auto] 等待 Live2D 实例就绪…");
            return;
        }

        const now = Date.now();
        const idleMin = s.get("autoIdleMin", 5) || 1;
        const cooldownMin = s.get("autoCooldownMin", 30) || 1;
        const idleMs = idleMin * 60 * 1000;
        const cooldownMs = cooldownMin * 60 * 1000;
        const dailyLimit = s.get("autoDailyLimit", 10) || 0;
        const idleLeft = now - lastActivityAt;
        const cooldownLeft = now - lastAutoAttemptAt;
        const today = autoCountToday();

        console.log("[XBHH auto] check", {
            页面可见: document.visibilityState,
            距上次活动: `${Math.round(idleLeft / 1000)}s / 需 ${idleMin * 60}s`,
            距上次尝试: `${Math.round(cooldownLeft / 1000)}s / 需 ${cooldownMin * 60}s`,
            今日已画: `${today} / 上限 ${dailyLimit || "∞"}`,
        });

        // 注意：不要因为页面不可见（切走标签页/最小化）就跳过——
        // 「偷偷画」恰恰发生在用户不在操作的时候。
        if (idleLeft < idleMs) return;
        if (cooldownLeft < cooldownMs) return;
        if (dailyLimit > 0 && today >= dailyLimit) return;

        autoThinking = true;
        autoInspire()
            .then((drew) => {
                // 只有真正提交队列成功，才进入冷却；失败则在下一轮（15s）继续重试
                if (drew) lastAutoAttemptAt = Date.now();
            })
            .finally(() => {
                autoThinking = false;
            });
    }, 15000);
}

async function loadLive2DConfig() {
    // 动态获取插件名
    const url = new URL(import.meta.url);
    const pathSegments = url.pathname.split('/');
    const extensionsIdx = pathSegments.indexOf('extensions');
    const extName = extensionsIdx !== -1 ? pathSegments[extensionsIdx + 1] : 'xbhh-lora';

    try {
        const response = await fetch(`/extensions/${extName}/js/pet/config_live2d.json?v=${Date.now()}`);
        if (!response.ok) {
            console.warn(`[XBHH] Config not found at /extensions/${extName}/js/pet/config_live2d.json, using defaults.`);
            return { enabled: true, version: "v4" };
        }
        return await response.json();
    } catch (e) {
        console.warn("[XBHH] Failed to load config_live2d.json, defaulting to v4", e);
        return { enabled: true, version: "v4" };
    }
}

let isInitializing = false;

function cleanContainers() {
    if (window.xbhhLive2DPet) {
        try {
            window.xbhhLive2DPet.destroy?.();
            window.xbhhLive2DPet.hide?.();
        } catch (e) {}
        window.xbhhLive2DPet = null;
    }
    document.querySelectorAll("#xbhh-live2d-container, #xbhh-live2d-v2-container, #waifu, #waifu-toggle").forEach(el => el.remove());
}

async function checkAvailableModels() {
    try {
        const resp = await fetch(`/xbhh/live2d_models?v=${Date.now()}`);
        if (!resp.ok) return { v2: [], v5: [] };
        const data = await resp.json();
        return {
            v2: Array.isArray(data?.v2) ? data.v2 : [],
            v5: Array.isArray(data?.v5) ? data.v5 : []
        };
    } catch (e) {
        console.warn("[XBHH] Failed to fetch Live2D models:", e);
        return { v2: [], v5: [] };
    }
}

async function startLive2DPet() {
    if (isInitializing) {
        console.warn("[XBHH] Live2D initialization in progress, skipping redundant trigger.");
        return;
    }
    isInitializing = true;

    try {
        // 启动前强制清理旧容器和实例，保证单例
        cleanContainers();

        const config = await loadLive2DConfig();
        // 优先从 localStorage 读取版本，支持运行时切换
        const savedVersion = localStorage.getItem("xbhh_live2d_version");
        if (savedVersion) config.version = savedVersion;
        
        if (config.enabled === false) {
            console.log("[XBHH] Live2D is disabled via config_live2d.json.");
            return;
        }

        // 检查是否在独立设置面板中被禁用
        const settingEnabled = window.xbhhSettings.get("enable", true);
        if (settingEnabled === false) {
            console.log("[XBHH] Live2D is disabled via XBHH settings panel.");
            return;
        }

        // 检查服务器上是否有可用的 Live2D 模型
        const modelsData = await checkAvailableModels();
        const hasV2 = modelsData.v2.length > 0;
        const hasV5 = modelsData.v5.length > 0;

        if (!hasV2 && !hasV5) {
            console.log("[XBHH] 没有检测到可用的 Live2D 模型，自动关闭并清理看板娘外框。");
            return;
        }

        // 如果当前配置的版本无模型，但另一个版本有模型，自动切到有模型的版本
        if (config.version === "v2" && !hasV2 && hasV5) {
            console.log("[XBHH] V2 无可用模型，自动智能切换到 V5/V4 版本");
            config.version = "v4";
        } else if ((config.version === "v4" || config.version === "v5") && !hasV5 && hasV2) {
            console.log("[XBHH] V4/V5 无可用模型，自动智能切换到 V2 版本");
            config.version = "v2";
        }

        // 检查是否被用户隐藏（隐藏=关闭，重启时清除隐藏标记，正常启动）
        const wasHidden = localStorage.getItem("xbhh_live2d_hidden");
        if (wasHidden === "true") {
            localStorage.removeItem("xbhh_live2d_hidden");
            console.log("[XBHH] Live2D was hidden last session, re-enabling on restart.");
        }

        console.log(`[XBHH] Initializing Live2D Loader (Version: ${config.version})`);
        const verSuffix = "?v=" + Date.now();

        // 根据配置动态实例化，确保单一实例
        if (config.version === "v2") {
            const { Live2DV2Pet } = await import("./live2d_v2_pet.js" + verSuffix);
            window.xbhhLive2DPet = new Live2DV2Pet();
        } else {
            const { Live2DPet } = await import("./live2d_pet.js" + verSuffix);
            window.xbhhLive2DPet = new Live2DPet();
        }
    } catch (e) {
        console.error("[XBHH] Failed to initialize pet instance", e);
        cleanContainers();
    } finally {
        isInitializing = false;
    }
}

app.registerExtension({
    name: "xbhh.live2d_loader",
    async init() {
        // 自建侧边栏设置面板，取代 ComfyUI 官方设置对话框（避免单行小输入框 + tooltip 左上角 bug）
        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: "xbhh-pet-settings",
                icon: "pi pi-cog",
                title: "看板娘设置",
                tooltip: "XBHH 看板娘设置（AI 对话 / 模型开关）",
                type: "custom",
                render: (el) => renderPetSettingsPanel(el),
            });
        } else {
            console.warn("[XBHH] registerSidebarTab 不可用，看板娘设置面板无法注册。");
        }

        // 启动自主创作定时器（空闲检测）
        startAutoCanvas();
    },
    async setup() {
        await startLive2DPet();
    }
});

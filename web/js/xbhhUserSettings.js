import { app } from "../../../scripts/app.js";

/**
 * 我的设置（XBHH User Settings）
 *
 * 在 ComfyUI 原生设置面板中新增一级分类「我的设置」，提供：
 *   侧边栏按钮控制：逐个显示/隐藏侧边栏标签页（含 ComfyUI 自带标签页与
 *   「模板」按钮），以及一键隐藏其它扩展注册的标签页；选择会记忆到 localStorage。
 *
 * 实现要点：
 *   - 原生设置的 type 支持传函数，签名 (name, setValue, currentValue, attrs) => HTMLElement，
 *     返回值会被挂进设置项容器 → 可以用来渲染真正的按钮 / 自定义面板。
 *   - 标签页显隐不改动 store，改为注入 <style>（[data-testid="<id>-tab-button"]{display:none}），
 *     可逆、对核心与扩展标签页统一生效。
 */

const LS_KEY = "xbhh_userSettings";

/** ComfyUI 自带的核心标签页 id */
const CORE_TABS = ["assets", "node-library", "model-library", "workflows", "apps", "job-history"];
/** 本工程自己注册的标签页 id（不视为“其它扩展”） */
const OWN_TABS = ["xbhh-lora-manager", "xbhh-pet-settings"];

/**
 * 侧边栏里“不是注册标签页”的特殊按钮（核心自带）。
 * 典型：右上角的「模板」按钮（SidebarTemplatesButton），渲染为
 * class="templates-tab-button"，没有 data-testid，也不出现在 getSidebarTabs() 中，
 * 点击直接打开模板对话框。这里手动登记，让它能进入控制列表并可显隐。
 */
const SPECIAL_TABS = [
  { id: "xbhh-core-templates", label: "模板", selector: ".templates-tab-button" },
];

/** 某个 id 对应的 DOM 隐藏选择器（特殊按钮用自定义选择器） */
function tabSelector(id) {
  const sp = SPECIAL_TABS.find((s) => s.id === id);
  if (sp) return `[data-testid="side-toolbar"] ${sp.selector}`;
  return `[data-testid="${cssEsc(id)}-tab-button"]`;
}

const cfg = { hidden: {}, hideOtherTabs: false };

/* ────────────────────────── 持久化 ────────────────────────── */

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        cfg.hidden = parsed.hidden && typeof parsed.hidden === "object" ? parsed.hidden : {};
        cfg.hideOtherTabs = !!parsed.hideOtherTabs;
      }
    }
  } catch (e) {
    console.warn("[XBHH userSettings] 读取设置失败", e);
  }
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* 忽略配额错误 */
  }
}

/* ────────────────────────── 标签页枚举 ────────────────────────── */

function listAllTabIds() {
  const set = new Set();
  try {
    const tabs = app.extensionManager?.getSidebarTabs?.() || [];
    tabs.forEach((t) => t && t.id && set.add(t.id));
  } catch {
    /* ignore */
  }
  document
    .querySelectorAll('[data-testid="side-toolbar"] [data-testid$="-tab-button"]')
    .forEach((b) => {
      const tid = b.getAttribute("data-testid") || "";
      const id = tid.replace(/-tab-button$/, "");
      if (id) set.add(id);
    });
  // 特殊按钮（如「模板」）单独登记
  SPECIAL_TABS.forEach((s) => set.add(s.id));
  return Array.from(set);
}

function tabLabel(id) {
  const sp = SPECIAL_TABS.find((s) => s.id === id);
  if (sp) return sp.label;
  try {
    const t = (app.extensionManager?.getSidebarTabs?.() || []).find((x) => x && x.id === id);
    if (t && t.title) return t.title;
  } catch {
    /* ignore */
  }
  const btn = document.querySelector(`[data-testid="${id}-tab-button"]`);
  if (btn) {
    return btn.getAttribute("aria-label") || btn.getAttribute("title") || id;
  }
  return id;
}

function isOwnOrCore(id) {
  return (
    CORE_TABS.indexOf(id) !== -1 ||
    OWN_TABS.indexOf(id) !== -1 ||
    SPECIAL_TABS.some((s) => s.id === id)
  );
}

/* ────────────────────────── 显隐应用 ────────────────────────── */

function ensureStyleEl() {
  let el = document.getElementById("xbhh-user-sidebar-style");
  if (!el) {
    el = document.createElement("style");
    el.id = "xbhh-user-sidebar-style";
    document.head.appendChild(el);
  }
  return el;
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

function applyVisibility() {
  if (!document.head) return;
  const rules = [];
  Object.keys(cfg.hidden).forEach((id) => {
    if (cfg.hidden[id]) {
      rules.push(`${tabSelector(id)}{display:none!important}`);
    }
  });
  if (cfg.hideOtherTabs) {
    listAllTabIds().forEach((id) => {
      if (!isOwnOrCore(id)) {
        rules.push(`${tabSelector(id)}{display:none!important}`);
      }
    });
  }
  ensureStyleEl().textContent = rules.join("\n");
}

/* ────────────────────────── 设置项 UI ────────────────────────── */

const S = {
  box: "display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid #45475a;" +
    "border-radius:8px;background:#1e1e2e;color:#cdd6f4;font-size:13px;max-width:520px;",
  row: "display:flex;align-items:center;gap:8px;cursor:pointer;line-height:1.4;",
  sub: "color:#a6adc8;font-size:12px;line-height:1.5;",
  sep: "height:1px;background:#313244;margin:2px 0;",
  tag: "flex:none;font-size:11px;color:#89b4fa;background:rgba(137,180,250,.14);" +
    "border-radius:5px;padding:0 5px;",
};

function makeCheckbox(checked, onToggle) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!checked;
  input.style.cssText = "margin:0;flex:none;cursor:pointer;";
  input.addEventListener("change", () => onToggle(input.checked));
  return input;
}

/** 自定义面板：侧边栏标签页显隐控制 */
function buildSidebarTabsPanel() {
  const box = document.createElement("div");
  box.style.cssText = S.box;

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;";
  const title = document.createElement("strong");
  title.textContent = "侧边栏按钮控制";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新列表";
  refresh.style.cssText =
    "margin-left:auto;background:transparent;border:1px solid #45475a;color:#a6adc8;" +
    "border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;";
  head.appendChild(title);
  head.appendChild(refresh);
  box.appendChild(head);

  const hint = document.createElement("div");
  hint.style.cssText = S.sub;
  hint.textContent = "勾选 = 显示该标签页按钮，取消勾选 = 隐藏。选择会自动记住。";
  box.appendChild(hint);

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  box.appendChild(listWrap);

  const renderList = () => {
    listWrap.innerHTML = "";
    const ids = listAllTabIds();
    if (!ids.length) {
      const empty = document.createElement("div");
      empty.style.cssText = S.sub;
      empty.textContent = "未检测到侧边栏标签页（可点“刷新列表”重试）。";
      listWrap.appendChild(empty);
      return;
    }
    ids.forEach((id) => {
      const row = document.createElement("label");
      row.style.cssText = S.row;
      const show = !cfg.hidden[id];
      row.appendChild(
        makeCheckbox(show, (checked) => {
          if (checked) delete cfg.hidden[id];
          else cfg.hidden[id] = true;
          save();
          applyVisibility();
        }),
      );
      const name = document.createElement("span");
      name.textContent = tabLabel(id);
      row.appendChild(name);
      const tag = document.createElement("span");
      tag.style.cssText = S.tag;
      tag.textContent = isOwnOrCore(id) ? "核心" : "扩展";
      row.appendChild(tag);
      listWrap.appendChild(row);
    });
  };
  renderList();
  refresh.addEventListener("click", renderList);

  const sep = document.createElement("div");
  sep.style.cssText = S.sep;
  box.appendChild(sep);

  const otherRow = document.createElement("label");
  otherRow.style.cssText = S.row;
  otherRow.appendChild(
    makeCheckbox(cfg.hideOtherTabs, (checked) => {
      cfg.hideOtherTabs = checked;
      save();
      applyVisibility();
    }),
  );
  const otherName = document.createElement("span");
  otherName.textContent = "隐藏其它扩展注册的标签页";
  otherRow.appendChild(otherName);
  box.appendChild(otherRow);

  const otherHint = document.createElement("div");
  otherHint.style.cssText = S.sub;
  otherHint.textContent = "只会隐藏非 ComfyUI 核心、也非本工程注册的第三方扩展标签页。";
  box.appendChild(otherHint);

  return box;
}

/* ────────────────────────── 注册 ────────────────────────── */

function registerSettings() {
  if (!app.ui?.settings?.addSetting) {
    console.warn("[XBHH userSettings] app.ui.settings 不可用，跳过注册");
    return;
  }

  app.ui.settings.addSetting({
    id: "XBHH.User.SidebarTabs",
    name: "侧边栏按钮控制",
    type: () => buildSidebarTabsPanel(),
    defaultValue: "",
    tooltip: "逐个显示/隐藏侧边栏标签页，或一键隐藏其它扩展注册的标签页。",
    category: ["我的设置", "侧边栏"],
  });
}

app.registerExtension({
  name: "xbhh.UserSettings",
  init() {
    load();
    registerSettings();
    applyVisibility();
    // 标签页在 init 阶段可能尚未全部注册，持续补齐显隐规则
    setInterval(applyVisibility, 1000);
  },
});

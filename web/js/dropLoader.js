import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * 拖拽打开工作流（兜底扩展）
 *
 * 背景：部分新版 ComfyUI 前端的 workspace 模块未接管画布拖放，
 * 导致拖 .json / .png 到画布无任何反应（dragover/drop 均 defaultPrevented: false）。
 * 本扩展在 capture 阶段接管 window 级 drop：
 *   - .json       → 识别 UI 格式（含 nodes）直接加载；API 格式给出提示
 *   - .png/.webp  → 拖到「图片加载器」这类可接收图片的节点上时，一律上传图片
 *                   并填入该节点（即使图片内嵌了工作流元数据，也以「换图」为准，
 *                   避免用户想换图却意外打开工作流）；
 *                   未拖到图片节点上时，才解析 PNG tEXt/iTXt chunk 中的
 *                   workflow 元数据并加载
 * 事件已被他人处理（defaultPrevented）时不抢，兼容未来官方修复。
 */

const TAG = "[XBHH drop]";

function toast(msg, kind = "info") {
  const colors = {
    info: "#89b4fa",
    ok: "#a6e3a1",
    warn: "#f9e2af",
    error: "#f38ba8",
  };
  let box = document.getElementById("xbhh-drop-toast");
  if (!box) {
    box = document.createElement("div");
    box.id = "xbhh-drop-toast";
    box.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10001;" +
      "padding:8px 18px;border-radius:8px;font-size:13px;color:#cdd6f4;" +
      "background:rgba(17,17,27,0.92);border:1px solid #45475a;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;" +
      "transition:opacity .25s ease;opacity:0;max-width:80vw;";
    document.body.appendChild(box);
  }
  box.style.borderColor = colors[kind] || colors.info;
  box.textContent = msg;
  box.style.opacity = "1";
  clearTimeout(box.__t);
  box.__t = setTimeout(() => { box.style.opacity = "0"; }, 2600);
}

function consume(e) {
  e.preventDefault();
  e.stopPropagation();
}

// UI 浮层（看板娘聊天窗等）自行处理 drop 时让行：目标在带 data-xbhh-drop-ignore 的容器内则不抢
function wantsDrop(target) {
  return !!(target && target.closest && target.closest("[data-xbhh-drop-ignore]"));
}

// ── PNG 元数据解析 ──────────────────────────────────────────────
// 返回 { workflow?: string, prompt?: string }；非 PNG 或解析失败返回 null
function parsePngTextChunks(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 16 || dv.getUint32(0) !== 0x89504e47) return null; // PNG 签名
  const decoder = new TextDecoder("utf-8");
  const texts = {};
  let off = 8;
  while (off + 12 <= buf.byteLength) {
    const len = dv.getUint32(off);
    if (off + 12 + len > buf.byteLength) break;
    const type = String.fromCharCode(
      dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7)
    );
    if (type === "tEXt" || type === "iTXt") {
      const bytes = new Uint8Array(buf, off + 8, len);
      const nul = bytes.indexOf(0);
      if (nul > 0) {
        const keyword = decoder.decode(bytes.subarray(0, nul));
        if (type === "tEXt") {
          texts[keyword] = decoder.decode(bytes.subarray(nul + 1));
        } else {
          // iTXt: keyword\0 compFlag compMethod\0 langTag\0 translatedKeyword\0 text
          let p = nul + 1;
          const compFlag = bytes[p] || 0;
          p += 2;
          p = bytes.indexOf(0, p) + 1;  // langTag
          p = bytes.indexOf(0, p) + 1;  // translatedKeyword
          const payload = bytes.subarray(p);
          texts[keyword + "__bytes"] = { payload, compFlag };
        }
      }
    }
    off += 12 + len;
    if (type === "IEND") break;
  }
  return texts;
}

// 压缩的 iTXt 用 DecompressionStream 解压（async）
async function resolvePngTexts(texts) {
  const decoder = new TextDecoder("utf-8");
  for (const [k, v] of Object.entries(texts)) {
    if (!k.endsWith("__bytes")) continue;
    const keyword = k.slice(0, -8);
    const { payload, compFlag } = v;
    try {
      if (compFlag === 1) {
        const ds = new DecompressionStream("deflate");
        const stream = new Blob([payload]).stream().pipeThrough(ds);
        texts[keyword] = decoder.decode(await new Response(stream).arrayBuffer());
      } else {
        texts[keyword] = decoder.decode(payload);
      }
    } catch (err) {
      console.warn(TAG, "iTXt 解压失败:", keyword, err);
    }
    delete texts[k];
  }
  return texts;
}

// ── 工作流格式判断与加载 ─────────────────────────────────────────
function isUiGraph(data) {
  return data && typeof data === "object" && Array.isArray(data.nodes);
}

function isApiPrompt(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return Object.values(data).some((v) => v && typeof v === "object" && v.class_type);
}

function loadGraph(data) {
  try {
    app.loadGraphData(data);
  } catch (err) {
    console.error(TAG, "loadGraphData 失败:", err);
    toast(`❌ 工作流加载失败: ${err.message || err}`, "error");
  }
}

// ── 定位鼠标下的「图片加载器」节点 ────────────────────────────────
// 同步执行：必须在 drop 事件的同步阶段调用，才能在任何 await 之前 consume(e)
function findImageNodeAtEvent(e) {
  try {
    const canvas = app.canvas;
    if (!canvas) return null;
    canvas.adjustMouseEvent?.(e); // 写入 e.canvasX / e.canvasY
    const x = e.canvasX;
    const y = e.canvasY;
    if (typeof x !== "number" || typeof y !== "number") return null;
    const node = canvas.graph?.getNodeOnPos?.(x, y);
    if (!node || !Array.isArray(node.widgets)) return null;
    const widget = node.widgets.find((w) => w && w.name === "image");
    if (!widget) return null;
    return { node, widget };
  } catch (err) {
    console.warn(TAG, "定位图片节点失败:", err);
    return null;
  }
}

// 上传图片到后端并写入图片加载器节点的 image widget
async function uploadImageToNode(node, widget, file) {
  const body = new FormData();
  body.append("image", file);
  body.append("type", "input");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!resp.ok) throw new Error(`上传失败 (HTTP ${resp.status})`);
  const data = await resp.json();
  const path = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;

  // 让下拉框包含新上传的图片名，并把选中值指向它
  if (widget.options && Array.isArray(widget.options.values)) {
    if (!widget.options.values.includes(path)) widget.options.values.push(path);
  }
  widget.value = path;
  try {
    widget.callback?.(path, app.canvas, node, [0, 0], null);
  } catch (err) {
    console.warn(TAG, "image widget callback 执行异常:", err);
  }

  // 清除旧预览，触发重绘
  node.imgs = undefined;
  node.imageIndex = null;
  node.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  return path;
}

// ── drop 处理 ───────────────────────────────────────────────────
async function handleDrop(e) {
  if (e.defaultPrevented) return; // 已有其他代码处理，不抢
  if (wantsDrop(e.target)) return; // UI 浮层（看板娘聊天窗）自行处理，让行
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return; // 非本地文件拖拽（画布内操作等），放行

  const file = files[0];
  const name = file.name.toLowerCase();

  try {
    // 1) JSON 工作流
    if (name.endsWith(".json") || file.type === "application/json") {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        toast("❌ JSON 解析失败，文件不是合法的 JSON", "error");
        return consume(e);
      }
      if (isUiGraph(data)) {
        loadGraph(data);
        return consume(e);
      }
      if (isApiPrompt(data)) {
        toast("⚠️ 这是 API 格式工作流，拖拽暂不支持，请用 菜单 → 工作流 → 打开(API格式)", "warn");
        return consume(e);
      }
      toast("❌ JSON 中未找到工作流数据（非 UI 格式）", "error");
      return consume(e);
    }

    // 2) PNG / WEBP / 图片：优先填入鼠标下的「图片加载器」节点，其次提取工作流元数据
    if (name.endsWith(".png") || name.endsWith(".webp") || file.type.startsWith("image/")) {
      // 同步定位鼠标下的可接收图片的节点（await 后再 stopPropagation 已无效）
      const target = findImageNodeAtEvent(e);

      // 拖到「图片加载器」节点上：一律把图片载入该节点，即使图片内嵌了工作流元数据
      // （节点目标意图明确，优先「换图」，避免想换图却意外打开工作流）
      if (target) {
        consume(e);
        try {
          await uploadImageToNode(target.node, target.widget, file);
        } catch (err) {
          console.error(TAG, "图片上传失败:", err);
          toast(`❌ 图片载入失败: ${err.message || err}`, "error");
        }
        return;
      }

      const buf = await file.arrayBuffer();
      const raw = parsePngTextChunks(buf);
      const texts = raw ? await resolvePngTexts(raw) : {};

      // 未拖到图片节点上：图片内嵌 UI 工作流时才加载工作流
      if (texts.workflow) {
        try {
          const wf = JSON.parse(texts.workflow);
          if (isUiGraph(wf)) {
            loadGraph(wf);
            return;
          }
        } catch (err) {
          console.warn(TAG, "图片 workflow 元数据解析失败:", err);
          toast("❌ 图片内的工作流元数据损坏", "error");
          return;
        }
      }

      if (texts.prompt) {
        toast("⚠️ 图片仅含 API 格式元数据（prompt），请用 菜单 → 工作流 → 打开(API格式)", "warn");
        return;
      }

      // 既无工作流元数据、也未拖到图片节点上：放行给原生逻辑（原生会新建图片加载器节点）
      return;
    }
  } catch (err) {
    console.error(TAG, "drop 处理异常:", err);
    toast(`❌ 处理拖入文件失败: ${err.message || err}`, "error");
    return consume(e);
  }
}

app.registerExtension({
  name: "xbhh.dropLoader",
  setup() {
    // dragover 必须 preventDefault，否则浏览器不会产生有效的 drop
    window.addEventListener(
      "dragover",
      (e) => {
        if (e.defaultPrevented) return;
        if (wantsDrop(e.target)) return; // UI 浮层（看板娘聊天窗）自行处理，让行
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      },
      { capture: true }
    );

    window.addEventListener("drop", handleDrop, { capture: true });
    console.log(TAG, "拖拽兜底已启用（JSON / PNG 元数据 / 图片拖到图片加载器）");
  },
});

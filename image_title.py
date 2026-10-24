import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

# 常见字体候选（优先中文字体，避免触发词/中文标题显示为方块）
FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",      # 微软雅黑
    "C:/Windows/Fonts/msyhbd.ttc",    # 微软雅黑 粗体
    "C:/Windows/Fonts/simhei.ttf",    # 黑体
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


class XBHHImageTitle:
    """
    XBHH 图片标题

    在图片顶部叠加半透明横幅并绘制标题文本（如 LoRA 名称 / 触发词），
    未连接标题时原图直通。常与 LoRA 测试堆的 status_text 输出搭配，
    批量测试时每张图自动带上当前测试的模型名。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "font_size": ("INT", {"default": 40, "min": 8, "max": 512, "step": 1}),
            },
            "optional": {
                "title": ("STRING", {"forceInput": True}),
            },
            "hidden": {},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "add_title"
    CATEGORY = "XBHH/image"

    def add_title(self, image, font_size=40, title=None):
        text = str(title or "").strip().replace("\n", " ")
        # 无标题：原图直通
        if not text:
            return (image,)

        font = _load_font(int(font_size))
        frames = []
        for i in range(image.shape[0]):
            # ComfyUI IMAGE: [B, H, W, C]，RGB 0-1
            arr = (image[i].clamp(0, 1).cpu().numpy() * 255.0).round().astype("uint8")
            pil = Image.fromarray(arr, mode="RGB")
            draw = ImageDraw.Draw(pil, "RGBA")
            w, h = pil.size

            # 文本尺寸（textbbox 带 base 偏移，需减去 top）
            try:
                l, t, r, b = draw.textbbox((0, 0), text, font=font)
                tw, th = r - l, b - t
            except Exception:
                tw, th = font_size * max(len(text), 1), font_size

            # 顶部半透明横幅
            pad_x = max(10, int(font_size) // 3)
            pad_y = max(6, int(font_size) // 5)
            banner_h = min(th + pad_y * 2, h)

            # 文本过长时逐字截断加省略号
            disp = text
            try:
                while draw.textlength(disp, font=font) > w - pad_x * 2 and len(disp) > 3:
                    disp = disp[:-2] + "…"
                disp_w = draw.textlength(disp, font=font)
            except Exception:
                disp = text
                disp_w = tw

            draw.rectangle([0, 0, w, banner_h], fill=(0, 0, 0, 170))
            tx = max(pad_x, int((w - disp_w) // 2))
            ty = max(0, (banner_h - th) // 2 - t)
            draw.text((tx, ty), disp, font=font, fill=(255, 255, 255, 255))

            frames.append(torch.from_numpy(np.array(pil).astype("float32") / 255.0))

        out = torch.stack(frames, dim=0)
        return (out,)


NODE_CLASS_MAPPINGS = {
    "XBHHImageTitle": XBHHImageTitle
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHImageTitle": "XBHH Image Title（图片标题）"
}

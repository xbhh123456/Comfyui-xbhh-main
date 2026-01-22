# XBHH Pet Module - 仅保留 CUI 虚拟货币和图片保存功能
from .wallet import CUIWallet
from .save_image_cui import XBHHSaveImageWithCUI

NODE_CLASS_MAPPINGS = {
    "XBHHSaveImageWithCUI": XBHHSaveImageWithCUI,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHSaveImageWithCUI": "xbhh 保存图片 (CUI奖励) 💰",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "CUIWallet", "XBHHSaveImageWithCUI"]

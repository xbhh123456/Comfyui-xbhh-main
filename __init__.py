from .lora_loader import XBHHMultiLoraLoader

NODE_CLASS_MAPPINGS = {
    "XBHHMultiLoraLoader": XBHHMultiLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHMultiLoraLoader": "XBHH Multi Lora Loader 🎨",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

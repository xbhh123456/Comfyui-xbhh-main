"""
XBHH 保存图片节点 (带CUI奖励)
参考官方 SaveImage 节点实现，增加CUI虚拟货币奖励功能

功能：
1. 保存生成的图片到输出目录
2. 根据图片尺寸计算CUI奖励
3. 按批次计算（多张图片只计算一次奖励）
4. 显示奖励信息
"""

import os
import json
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from datetime import datetime

import folder_paths
from comfy.cli_args import args

from .wallet import CUIWallet, get_wallet


class XBHHSaveImageWithCUI:
    """保存图片并获得CUI奖励的节点"""
    
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""
        self.compress_level = 4
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "要保存的图片"}),
                "filename_prefix": ("STRING", {
                    "default": "XBHH", 
                    "tooltip": "文件名前缀，支持格式化如 %date:yyyy-MM-dd%"
                }),
            },
            "hidden": {
                "prompt": "PROMPT", 
                "extra_pnginfo": "EXTRA_PNGINFO"
            },
        }
    
    RETURN_TYPES = ()
    FUNCTION = "save_and_earn"
    OUTPUT_NODE = True
    CATEGORY = "XBHH/Pet"
    DESCRIPTION = "保存图片到输出目录，并根据图片尺寸获得CUI虚拟货币奖励。按批次计算，多张图片只计算一次奖励。"
    
    def save_and_earn(self, images, filename_prefix="XBHH", prompt=None, extra_pnginfo=None):
        """保存图片并计算CUI奖励"""
        
        filename_prefix += self.prefix_append
        
        # 获取第一张图片的尺寸用于计算奖励
        # images shape: [batch, height, width, channels]
        height = images[0].shape[0]
        width = images[0].shape[1]
        batch_size = len(images)
        
        # 计算CUI奖励（按批次，只计算一次）
        cui_reward = CUIWallet.calculate_reward(width, height)
        
        # 获取钱包并增加余额
        wallet = get_wallet()
        new_balance = wallet.add_balance(
            amount=cui_reward,
            source="image_save",
            details={
                "width": width,
                "height": height,
                "batch_size": batch_size,
                "pixels": width * height,
                "filename_prefix": filename_prefix
            }
        )
        
        # 保存图片
        full_output_folder, filename, counter, subfolder, filename_prefix = \
            folder_paths.get_save_image_path(
                filename_prefix, 
                self.output_dir, 
                images[0].shape[1],  # width
                images[0].shape[0]   # height
            )
        
        results = []
        for batch_number, image in enumerate(images):
            # 转换图片格式
            i = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
            
            # 添加元数据
            metadata = None
            if not args.disable_metadata:
                metadata = PngInfo()
                if prompt is not None:
                    metadata.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo is not None:
                    for x in extra_pnginfo:
                        metadata.add_text(x, json.dumps(extra_pnginfo[x]))
                
                # 添加CUI奖励信息到元数据
                metadata.add_text("cui_reward", json.dumps({
                    "earned": cui_reward,
                    "balance": new_balance,
                    "size": f"{width}x{height}",
                    "batch_size": batch_size
                }))
            
            # 生成文件名并保存
            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.png"
            img.save(
                os.path.join(full_output_folder, file), 
                pnginfo=metadata, 
                compress_level=self.compress_level
            )
            
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type
            })
            counter += 1
        
        # 返回UI结果，包含CUI信息
        return {
            "ui": {
                "images": results,
                "cui_info": [{
                    "earned": cui_reward,
                    "balance": new_balance,
                    "size": f"{width}x{height}",
                    "batch_size": batch_size,
                    "total_earned": wallet.get_total_earned(),
                    "message": f"💰 获得 {cui_reward} CUI！当前余额：{new_balance} CUI"
                }]
            }
        }


# 节点注册映射
NODE_CLASS_MAPPINGS = {
    "XBHHSaveImageWithCUI": XBHHSaveImageWithCUI,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHSaveImageWithCUI": "xbhh 保存图片 (CUI奖励) 💰",
}

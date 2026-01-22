"""
CUI虚拟货币钱包系统
用于管理用户通过生成图片获得的CUI货币

定价规则（基于像素总数）：
- ≤ 786,432 像素 (768×1024): 2 CUI
- ≤ 1,048,576 像素 (1024×1024): 5 CUI
- > 1,048,576 像素: 7 CUI
"""

import os
import json
from datetime import datetime
from typing import Optional, Dict, Any, List
import folder_paths


class CUIWallet:
    """CUI虚拟货币钱包"""
    
    # 数据目录名称
    DATA_DIR_NAME = "xbhh_pet"
    WALLET_FILE_NAME = "wallet.json"
    
    def __init__(self):
        self.data_file = self._get_data_file_path()
        self.data = self._load()
    
    def _get_data_file_path(self) -> str:
        """获取钱包数据文件路径"""
        # 使用ComfyUI的用户目录
        user_dir = folder_paths.get_user_directory()
        data_dir = os.path.join(user_dir, self.DATA_DIR_NAME)
        return os.path.join(data_dir, self.WALLET_FILE_NAME)
    
    def _load(self) -> Dict[str, Any]:
        """加载钱包数据"""
        if os.path.exists(self.data_file):
            try:
                with open(self.data_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                # 数据损坏时返回默认值
                pass
        
        # 返回默认钱包数据
        return {
            "balance": 0,
            "total_earned": 0,
            "total_spent": 0,
            "history": [],
            "created_at": datetime.now().isoformat()
        }
    
    def _save(self):
        """保存钱包数据"""
        # 确保目录存在
        os.makedirs(os.path.dirname(self.data_file), exist_ok=True)
        
        # 限制历史记录数量，保留最近1000条
        if len(self.data["history"]) > 1000:
            self.data["history"] = self.data["history"][-1000:]
        
        with open(self.data_file, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
    
    def add_balance(self, amount: int, source: str = "image_save", 
                    details: Optional[Dict[str, Any]] = None) -> int:
        """
        增加CUI余额
        
        Args:
            amount: 增加的数量
            source: 来源，默认为 image_save
            details: 额外详情，如图片尺寸等
        
        Returns:
            当前余额
        """
        if amount <= 0:
            return self.data["balance"]
        
        self.data["balance"] += amount
        self.data["total_earned"] += amount
        
        # 记录历史
        record = {
            "type": "earn",
            "amount": amount,
            "source": source,
            "timestamp": datetime.now().isoformat()
        }
        if details:
            record["details"] = details
        
        self.data["history"].append(record)
        self._save()
        
        return self.data["balance"]
    
    def spend(self, amount: int, item_id: str, item_name: str = "") -> bool:
        """
        消费CUI
        
        Args:
            amount: 消费数量
            item_id: 物品ID
            item_name: 物品名称
        
        Returns:
            是否消费成功
        """
        if amount <= 0 or self.data["balance"] < amount:
            return False
        
        self.data["balance"] -= amount
        self.data["total_spent"] += amount
        
        # 记录历史
        self.data["history"].append({
            "type": "spend",
            "amount": amount,
            "item_id": item_id,
            "item_name": item_name,
            "timestamp": datetime.now().isoformat()
        })
        self._save()
        
        return True
    
    def get_balance(self) -> int:
        """获取当前余额"""
        return self.data["balance"]
    
    def get_total_earned(self) -> int:
        """获取累计赚取"""
        return self.data["total_earned"]
    
    def get_total_spent(self) -> int:
        """获取累计消费"""
        return self.data["total_spent"]
    
    def get_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        """获取最近的交易历史"""
        return self.data["history"][-limit:][::-1]  # 最新的在前
    
    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        return {
            "balance": self.data["balance"],
            "total_earned": self.data["total_earned"],
            "total_spent": self.data["total_spent"],
            "transaction_count": len(self.data["history"]),
            "created_at": self.data.get("created_at", "未知")
        }
    
    @staticmethod
    def calculate_reward(width: int, height: int) -> int:
        """
        根据图片尺寸计算CUI奖励
        
        Args:
            width: 图片宽度
            height: 图片高度
        
        Returns:
            CUI奖励数量
        """
        total_pixels = width * height
        
        if total_pixels <= 786432:      # 768 * 1024
            return 2
        elif total_pixels <= 1048576:   # 1024 * 1024
            return 5
        else:
            return 7


# 单例钱包实例
_wallet_instance: Optional[CUIWallet] = None

def get_wallet() -> CUIWallet:
    """获取钱包单例实例"""
    global _wallet_instance
    if _wallet_instance is None:
        _wallet_instance = CUIWallet()
    return _wallet_instance

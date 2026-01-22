"""
XBHH 动态文本处理节点
支持在文本中使用 %variable% 语法进行动态变量替换
"""

import re
import random
import uuid
from datetime import datetime
import os
import json

# 全局计数器字典，按节点 ID 存储
_counters = {}

# 用户自定义处理器存储
_custom_processors = {}


class VariableProcessor:
    """变量处理引擎"""
    
    # 日期格式映射表
    DATE_FORMAT_MAP = {
        'YYYY': '%Y',    # 4位年份
        'yyyy': '%Y',
        'YY': '%y',      # 2位年份
        'yy': '%y',
        'MM': '%m',      # 月份
        'dd': '%d',      # 日期
        'DD': '%d',
        'HH': '%H',      # 小时(24制)
        'hh': '%I',      # 小时(12制)
        'mm': '%M',      # 分钟
        'ss': '%S',      # 秒
        'SS': '%S',
    }
    
    def __init__(self, seed=None, node_id=None):
        self.seed = seed
        self.node_id = node_id or "default"
        if seed is not None and seed > 0:
            random.seed(seed)
    
    def _convert_format(self, format_str):
        """将用户友好的格式转换为 Python strftime 格式"""
        result = format_str
        # 按长度降序排序，先替换长的模式
        for user_fmt, py_fmt in sorted(self.DATE_FORMAT_MAP.items(), key=lambda x: -len(x[0])):
            result = result.replace(user_fmt, py_fmt)
        return result
    
    def process_date(self, arg=None):
        """处理日期变量"""
        now = datetime.now()
        if arg:
            fmt = self._convert_format(arg)
            return now.strftime(fmt)
        return now.strftime('%Y-%m-%d')
    
    def process_time(self, arg=None):
        """处理时间变量"""
        now = datetime.now()
        if arg:
            fmt = self._convert_format(arg)
            return now.strftime(fmt)
        return now.strftime('%H:%M:%S')
    
    def process_datetime(self, arg=None):
        """处理日期时间组合"""
        now = datetime.now()
        if arg:
            fmt = self._convert_format(arg)
            return now.strftime(fmt)
        return now.strftime('%Y-%m-%d_%H-%M-%S')
    
    def process_random(self, arg=None):
        """处理随机数变量 - 格式: %random:MIN-MAX%"""
        if arg:
            try:
                parts = arg.split('-')
                if len(parts) == 2:
                    min_val = int(parts[0])
                    max_val = int(parts[1])
                    return str(random.randint(min_val, max_val))
            except ValueError:
                pass
        return str(random.randint(0, 100))
    
    def process_uuid(self, arg=None):
        """生成唯一标识符"""
        full_uuid = str(uuid.uuid4())
        if arg:
            try:
                length = int(arg)
                return full_uuid.replace('-', '')[:length]
            except ValueError:
                pass
        return full_uuid[:8]
    
    def process_counter(self, arg=None):
        """自增计数器"""
        global _counters
        key = self.node_id
        if key not in _counters:
            _counters[key] = 0
        _counters[key] += 1
        
        # 支持格式化，如 %counter:3% 表示3位数字，不足补零
        if arg:
            try:
                width = int(arg)
                return str(_counters[key]).zfill(width)
            except ValueError:
                pass
        return str(_counters[key])
    
    def process_reset_counter(self, arg=None):
        """重置计数器"""
        global _counters
        key = self.node_id
        _counters[key] = 0
        return ""
    
    def process_year(self, arg=None):
        """当前年份"""
        return datetime.now().strftime('%Y')
    
    def process_month(self, arg=None):
        """当前月份"""
        return datetime.now().strftime('%m')
    
    def process_day(self, arg=None):
        """当前日期"""
        return datetime.now().strftime('%d')
    
    def process_hour(self, arg=None):
        """当前小时"""
        return datetime.now().strftime('%H')
    
    def process_minute(self, arg=None):
        """当前分钟"""
        return datetime.now().strftime('%M')
    
    def process_second(self, arg=None):
        """当前秒"""
        return datetime.now().strftime('%S')
    
    def process_weekday(self, arg=None):
        """星期几 (0-6, 0=周一)"""
        weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        weekday_num = datetime.now().weekday()
        if arg == 'num':
            return str(weekday_num)
        elif arg == 'en':
            en_weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            return en_weekdays[weekday_num]
        elif arg == 'short':
            short_weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            return short_weekdays[weekday_num]
        return weekdays[weekday_num]
    
    def process_choice(self, arg=None):
        """从选项中随机选择 - 格式: %choice:选项1|选项2|选项3%"""
        if arg:
            options = arg.split('|')
            if options:
                return random.choice(options)
        return ""
    
    def process_env(self, arg=None):
        """获取环境变量"""
        if arg:
            return os.environ.get(arg, '')
        return ""
    
    def get_builtin_processors(self):
        """返回所有内置处理器"""
        return {
            'date': self.process_date,
            'time': self.process_time,
            'datetime': self.process_datetime,
            'random': self.process_random,
            'uuid': self.process_uuid,
            'counter': self.process_counter,
            'reset_counter': self.process_reset_counter,
            'year': self.process_year,
            'month': self.process_month,
            'day': self.process_day,
            'hour': self.process_hour,
            'minute': self.process_minute,
            'second': self.process_second,
            'weekday': self.process_weekday,
            'choice': self.process_choice,
            'env': self.process_env,
        }
    
    def process_text(self, text):
        """处理文本中的所有变量"""
        # 匹配 %变量名% 或 %变量名:参数%
        pattern = r'%([a-zA-Z_][a-zA-Z0-9_]*)(?::([^%]*))?%'
        
        processors = self.get_builtin_processors()
        processors.update(_custom_processors)
        
        def replace_var(match):
            var_name = match.group(1).lower()
            var_arg = match.group(2)
            
            if var_name in processors:
                try:
                    return processors[var_name](var_arg)
                except Exception as e:
                    return f"[Error: {var_name}]"
            
            # 未知变量，保持原样
            return match.group(0)
        
        return re.sub(pattern, replace_var, text)


def register_processor(name, func):
    """注册自定义处理器"""
    global _custom_processors
    _custom_processors[name.lower()] = func


def reset_counter(node_id=None):
    """重置指定节点的计数器"""
    global _counters
    if node_id:
        if node_id in _counters:
            _counters[node_id] = 0
    else:
        _counters.clear()


class XBHHDynamicText:
    """
    动态文本处理节点
    支持在文本中使用 %variable% 语法进行动态变量替换
    """
    
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "文件_%date%_%counter:3%", 
                    "multiline": True,
                    "dynamicPrompts": False
                }),
            },
            "optional": {
                "seed": ("INT", {
                    "default": 0, 
                    "min": 0, 
                    "max": 0xffffffffffffffff,
                    "tooltip": "随机种子，0表示每次随机"
                }),
                "reset_counter": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "重置计数器"
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID"
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "process"
    CATEGORY = "XBHH"
    OUTPUT_NODE = False
    
    DESCRIPTION = """动态文本处理节点 - 支持变量替换

内置变量：
• %date% - 日期 (YYYY-MM-DD)
• %date:MM-dd% - 自定义日期格式
• %time% - 时间 (HH:MM:SS)
• %datetime% - 日期时间组合
• %random:1-100% - 随机数
• %uuid% - 唯一标识符
• %counter% - 自增计数器
• %counter:3% - 3位计数器(补零)
• %year%, %month%, %day% - 年月日
• %weekday% - 星期几
• %choice:A|B|C% - 随机选择
"""

    def process(self, text, seed=0, reset_counter=False, unique_id=None):
        node_id = str(unique_id) if unique_id else "default"
        
        # 重置计数器
        if reset_counter:
            global _counters
            _counters[node_id] = 0
        
        # 创建处理器并处理文本
        processor = VariableProcessor(seed=seed if seed > 0 else None, node_id=node_id)
        result = processor.process_text(text)
        
        return (result,)


# 获取可用变量列表的辅助函数
def get_available_variables():
    """返回所有可用变量的描述"""
    variables = {
        "date": "日期 (YYYY-MM-DD)，支持格式：%date:MM-dd%",
        "time": "时间 (HH:MM:SS)，支持格式：%time:HH-mm%",
        "datetime": "日期时间组合",
        "random": "随机数，格式：%random:MIN-MAX%",
        "uuid": "唯一标识符，可指定长度：%uuid:8%",
        "counter": "自增计数器，支持补零：%counter:3%",
        "year": "当前年份",
        "month": "当前月份",
        "day": "当前日期",
        "hour": "当前小时",
        "minute": "当前分钟",
        "second": "当前秒",
        "weekday": "星期几，支持：%weekday:en% %weekday:short%",
        "choice": "随机选择，格式：%choice:选项1|选项2|选项3%",
        "env": "环境变量，格式：%env:VARIABLE_NAME%",
    }
    return variables


# 注册节点
NODE_CLASS_MAPPINGS = {
    "XBHHDynamicText": XBHHDynamicText
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHDynamicText": "xbhh 动态文本 ⚡"
}

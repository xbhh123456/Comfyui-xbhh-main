import re

class XBHHPromptFormatter:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "dynamicPrompts": False}),
                "to_lowercase": (["true", "false"], {"default": "true"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("formatted_text",)
    FUNCTION = "format_prompt"
    CATEGORY = "xbhh/text"

    def format_prompt(self, text, to_lowercase):
        # 1. 修正错误的权重格式：例如 5::postcard:: -> postcard
        text = re.sub(r'-?\d+(?:\.\d+)?::(.*?)::', r'\1', text)
        
        # 2. 下划线替换成空格
        text = text.replace('_', ' ')
        
        # 3. 按逗号拆分 (忽略括号内的逗号，以防破坏复合权重结构)
        def split_tags(s):
            tags = []
            current_tag = []
            depth = 0
            for char in s:
                if char in '({[':
                    depth += 1
                elif char in ')}]':
                    depth -= 1
                    if depth < 0:
                        depth = 0
                
                if char == ',' and depth <= 0:
                    tags.append(''.join(current_tag))
                    current_tag = []
                    depth = 0
                else:
                    current_tag.append(char)
            if current_tag:
                tags.append(''.join(current_tag))
            return tags

        tags = split_tags(text)
        
        seen = set()
        result_tags = []
        
        def replace_nai_weight(match):
            left_chars = match.group(1)
            content = match.group(2)
            right_chars = match.group(3)
            
            is_curly = left_chars[0] == '{'
            
            count = min(len(left_chars), len(right_chars))
            
            left_remain = left_chars[count:]
            right_remain = right_chars[:-count] if len(right_chars) > count else ""
            
            base = 1.05
            weight = base ** count if is_curly else base ** (-count)
            
            return f"{left_remain}({content.strip()}:{weight:.2f}){right_remain}"

        for tag in tags:
            tag = tag.strip()
            if to_lowercase == "true":
                tag = tag.lower()
                
            if not tag:
                continue
                
            # 对单个 tag 处理 NAI 权重
            while True:
                new_tag = re.sub(r'(\{+)([^{}]+?)(\}+)', replace_nai_weight, tag)
                if new_tag == tag:
                    break
                tag = new_tag

            while True:
                new_tag = re.sub(r'(\[+)([^\[\]]+?)(\]+)', replace_nai_weight, tag)
                if new_tag == tag:
                    break
                tag = new_tag
                
            # 去重：使用去除多余空白且全小写的版本作为 key
            clean_key = re.sub(r'\s+', ' ', tag.lower())
            if clean_key not in seen:
                seen.add(clean_key)
                result_tags.append(tag)
                
        final_text = ', '.join(result_tags)
        return (final_text,)

NODE_CLASS_MAPPINGS = {
    "XBHHPromptFormatter": XBHHPromptFormatter
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XBHHPromptFormatter": "XBHH Prompt Formatter 📝"
}

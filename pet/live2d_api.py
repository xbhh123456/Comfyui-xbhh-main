import os
import json
from server import PromptServer
from aiohttp import web

class Live2DApi:
    @classmethod
    def setup(cls):
        @PromptServer.instance.routes.get("/xbhh/live2d_models")
        async def get_models(request):
            return web.json_response(cls.scan_models())

        @PromptServer.instance.routes.get("/xbhh/waifu-tips.json")
        async def get_waifu_tips(request):
            root_path = os.path.dirname(os.path.dirname(__file__))
            # 原始 JSON 模板路径
            json_path = os.path.join(root_path, "web", "js", "pet", "waifu-tips.json")
            
            if not os.path.exists(json_path):
                return web.Response(status=404)
                
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                # 动态注入扫描到的 V2 模型
                scanned = cls.scan_models()
                v2_models = []
                for m in scanned["v2"]:
                    v2_models.append({
                        "name": m["name"],
                        "paths": [f"/extensions/xbhh-lora/live2d/v2/{m['name']}/{c}" for c in m["clothes"]],
                        "message": f"来自 {m['name']} 的动态加载模型 ~"
                    })
                
                if v2_models:
                    data["models"] = v2_models
                    
                return web.json_response(data)
            except Exception as e:
                print(f"[XBHH] Error generating dynamic waifu-tips.json: {e}")
                return web.Response(status=500)

    @staticmethod
    def scan_models():
        # 获取插件根目录 e:\桌面\1\xbhh-lora
        root_path = os.path.dirname(os.path.dirname(__file__))
        # 模型存放在 web/live2d 下
        live2d_path = os.path.join(root_path, "web", "live2d")
        
        models = {
            "v2": [],
            "v5": []
        }
        
        if not os.path.exists(live2d_path):
            return models
            
        # 扫描 V2 模型
        v2_path = os.path.join(live2d_path, "v2")
        if os.path.exists(v2_path):
            if os.path.isdir(v2_path):
                for dirname in os.listdir(v2_path):
                    dirpath = os.path.join(v2_path, dirname)
                    if os.path.isdir(dirpath):
                        # 查找 model.json 作为主入口
                        main_model = os.path.join(dirpath, "model.json")
                        if os.path.exists(main_model):
                            clothes = []
                            for filename in os.listdir(dirpath):
                                if filename.startswith("model") and filename.endswith(".json"):
                                    clothes.append(filename)
                            clothes.sort()
                            
                            models["v2"].append({
                                "name": dirname,
                                "path": f"/extensions/xbhh-lora/live2d/v2/{dirname}/model.json",
                                "clothes": clothes
                            })
        
        # 扫描 V4/V5 模型
        for v_dir in ["v4", "v5"]:
            v_path = os.path.join(live2d_path, v_dir)
            if os.path.exists(v_path):
                for dirname in os.listdir(v_path):
                    dirpath = os.path.join(v_path, dirname)
                    if os.path.isdir(dirpath):
                        for filename in os.listdir(dirpath):
                            if filename.endswith(".model3.json"):
                                models["v5"].append({
                                    "name": dirname,
                                    "path": f"/extensions/xbhh-lora/live2d/{v_dir}/{dirname}/{filename}"
                                })
                                break
        return models

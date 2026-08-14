# 免费音乐MCP服务器

这是一个专为小智AI音响设计的免费音乐MCP（模型上下文协议）服务器，提供音乐搜索、播放控制等功能。

## 功能特性

- 🎵 **音乐搜索**: 支持按歌曲名、歌手名搜索
- ▶️ **播放控制**: 播放、暂停、停止、上一首、下一首
- 🔊 **音量控制**: 调节播放音量（0-100）
- 📝 **播放列表**: 添加、查看、清空播放列表
- 🆓 **完全免费**: 基于开源协议，无需付费
- 🔌 **标准接口**: 遵循MCP协议标准

## 安装配置

### 1. 环境准备

确保已安装Python 3.8+：
```bash
python3 --version
```

### 2. 安装依赖

```bash
cd /Users/a1234/Documents/music
pip3 install -r requirements.txt
```

Set a Yandex Music OAuth token before starting the server. Token instructions are at
https://ym.marshal.dev/token/.

```bash
export YANDEX_MUSIC_TOKEN="your-token"
```

On PowerShell:

```powershell
$env:YANDEX_MUSIC_TOKEN="your-token"
```

### 3. 测试服务器

```bash
python3 music_mcp_server.py
```

### 4. 小智AI配置

#### 步骤1：获取MCP接入点
1. 登录 [xiaozhi.me](https://xiaozhi.me) 控制台
2. 进入智能体的配置角色页面
3. 在右下角找到该智能体专属的MCP接入点

#### 步骤2：配置MCP服务器
在小智AI控制台中添加以下配置：

```json
{
  "name": "免费音乐服务器",
  "command": "python3",
  "args": ["/Users/a1234/Documents/music/music_mcp_server.py"],
  "transport": "stdio"
}
```

## 使用方法

配置完成后，您可以通过语音或文字与小智AI交互：

### 音乐搜索
- "搜索周杰伦的歌曲"
- "找一些流行音乐"
- "搜索青花瓷"

### 播放控制
- "播放青花瓷"
- "暂停音乐"
- "继续播放"
- "停止播放"
- "下一首歌"
- "上一首歌"

### 音量控制
- "音量调到80"
- "声音小一点"
- "音量设置为50"

### 播放列表管理
- "显示播放列表"
- "添加这首歌到播放列表"
- "清空播放列表"

## 可用工具

| 工具名称 | 功能描述 | 参数 |
|---------|---------|------|
| search_music | 搜索音乐 | query（搜索关键词）, limit（结果数量） |
| play_music | 播放指定歌曲 | song_id（歌曲ID）, song_name, artist |
| get_stream_url | 获取可播放音频URL | song_id（搜索结果中的歌曲ID） |
| pause_music | 暂停播放 | 无 |
| resume_music | 继续播放 | 无 |
| stop_music | 停止播放 | 无 |
| next_song | 下一首歌 | 无 |
| previous_song | 上一首歌 | 无 |
| set_volume | 设置音量 | volume（0-100） |
| add_to_playlist | 添加到播放列表 | song_id, song_name, artist |
| get_playlist | 获取播放列表 | 无 |
| clear_playlist | 清空播放列表 | 无 |

## 技术架构

- **协议**: MCP (Model Context Protocol)
- **传输**: stdio（标准输入输出）
- **语言**: Python 3.8+
- **依赖**: mcp, httpx, pydantic

## 扩展开发

### 接入真实音乐API

当前版本通过 [yandex-music](https://ym.marshal.dev/) 客户端接入 Yandex Music。

```python
async def search_music_api(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    async with httpx.AsyncClient() as client:
        # 接入您选择的免费音乐API
        response = await client.get(
            "https://api.example.com/search",
            params={"q": query, "limit": limit}
        )
        data = response.json()
        return parse_search_results(data)
```

### 添加新功能

1. 在 `handle_list_tools()` 中添加新工具定义
2. 在 `handle_call_tool()` 中实现工具逻辑
3. 更新配置文件和文档

## 故障排除

### 常见问题

**Q: 服务器启动失败**
A: 检查Python版本和依赖包是否正确安装

**Q: 小智AI无法连接**
A: 确认文件路径正确，检查MCP接入点配置

**Q: 搜索无结果**
A: 当前使用模拟数据，可接入真实音乐API

### 调试模式

启用详细日志：
```bash
PYTHON_LOG_LEVEL=DEBUG python3 music_mcp_server.py
```

## 许可证

本项目基于MIT许可证开源，您可以自由使用、修改和分发。

## 贡献

欢迎提交Issue和Pull Request来改进这个项目！

---

**注意**: 请确保遵守相关音乐版权法律法规，仅使用合法的音乐资源。

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
免费音乐MCP服务器
适用于小智AI音响的音乐控制服务
"""

import asyncio
import json
import sys
from typing import Any, Dict, List, Optional
import logging
from yandex_music_provider import provider

# 简化的MCP服务器实现
class MCPServer:
    def __init__(self, name: str):
        self.name = name
        self.tools = []
        self.resources = []
        
    def add_tool(self, name: str, description: str, schema: dict, handler):
        self.tools.append({
            'name': name,
            'description': description,
            'schema': schema,
            'handler': handler
        })
    
    def add_resource(self, uri: str, name: str, description: str):
        self.resources.append({
            'uri': uri,
            'name': name,
            'description': description
        })
    
    async def handle_request(self, request: dict) -> dict:
        method = request.get('method')
        params = request.get('params', {})
        
        if method == 'tools/list':
            return {
                'tools': [{
                    'name': tool['name'],
                    'description': tool['description'],
                    'inputSchema': tool['schema']
                } for tool in self.tools]
            }
        elif method == 'tools/call':
            tool_name = params.get('name')
            arguments = params.get('arguments', {})
            
            for tool in self.tools:
                if tool['name'] == tool_name:
                    result = await tool['handler'](arguments)
                    return {'content': [{'type': 'text', 'text': result}]}
            
            return {'error': f'Unknown tool: {tool_name}'}
        elif method == 'resources/list':
            return {'resources': self.resources}
        else:
            return {'error': f'Unknown method: {method}'}
    
    async def run_stdio(self):
        while True:
            try:
                line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
                if not line:
                    break
                
                request = json.loads(line.strip())
                response = await self.handle_request(request)
                
                print(json.dumps(response))
                sys.stdout.flush()
            except Exception as e:
                error_response = {'error': str(e)}
                print(json.dumps(error_response))
                sys.stdout.flush()

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 创建MCP服务器实例
server = MCPServer("music-mcp-server")

# 当前播放状态
playback_state = {
    "current_song": None,
    "playlist": [],
    "is_playing": False,
    "volume": 50,
    "position": 0
}

# 添加资源
server.add_resource("music://playlist", "当前播放列表", "显示当前的音乐播放列表")
server.add_resource("music://current", "当前播放", "显示当前正在播放的歌曲信息")

async def search_music_api(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Search Yandex Music through the ym.marshal.dev client library."""
    return await provider.search(query, limit)

async def get_stream_url_handler(arguments: Dict[str, Any]) -> str:
    song_id = arguments["song_id"]
    url = await provider.get_stream_url(song_id)
    return json.dumps({"song_id": song_id, "url": url}, ensure_ascii=False)

# 工具处理函数
async def search_music_handler(arguments: Dict[str, Any]) -> str:
    query = arguments["query"]
    limit = arguments.get("limit", 10)
    
    results = await search_music_api(query, limit)
    
    response = f"搜索 '{query}' 的结果：\n\n"
    for i, song in enumerate(results, 1):
        response += f"{i}. {song['name']} - {song['artist']}\n"
        response += f"   专辑: {song['album']}\n"
        response += f"   时长: {song['duration']}秒\n"
        response += f"   ID: {song['id']}\n\n"
    
    return response

async def play_music_handler(arguments: Dict[str, Any]) -> str:
    song_id = arguments["song_id"]
    song_name = arguments.get("song_name", "未知歌曲")
    artist = arguments.get("artist", "未知歌手")
    url = await provider.get_stream_url(song_id)
    
    playback_state["current_song"] = {
        "id": song_id,
        "name": song_name,
        "artist": artist,
        "url": url
    }
    playback_state["is_playing"] = True
    playback_state["position"] = 0
    
    return json.dumps({
        "message": f"正在播放: {song_name} - {artist}",
        "song_id": song_id,
        "url": url
    }, ensure_ascii=False)

async def pause_music_handler(arguments: Dict[str, Any]) -> str:
    playback_state["is_playing"] = False
    return "音乐已暂停"

async def resume_music_handler(arguments: Dict[str, Any]) -> str:
    playback_state["is_playing"] = True
    current = playback_state["current_song"]
    if current:
        return f"继续播放: {current['name']} - {current['artist']}"
    else:
        return "没有可继续播放的歌曲"

async def stop_music_handler(arguments: Dict[str, Any]) -> str:
    playback_state["is_playing"] = False
    playback_state["current_song"] = None
    playback_state["position"] = 0
    return "音乐已停止"

async def set_volume_handler(arguments: Dict[str, Any]) -> str:
    volume = arguments["volume"]
    playback_state["volume"] = volume
    return f"音量已设置为: {volume}%"

async def add_to_playlist_handler(arguments: Dict[str, Any]) -> str:
    song_id = arguments["song_id"]
    song_name = arguments.get("song_name", "未知歌曲")
    artist = arguments.get("artist", "未知歌手")
    
    song = {
        "id": song_id,
        "name": song_name,
        "artist": artist
    }
    playback_state["playlist"].append(song)
    
    return f"已添加到播放列表: {song_name} - {artist}"

async def get_playlist_handler(arguments: Dict[str, Any]) -> str:
    playlist = playback_state["playlist"]
    if not playlist:
        return "播放列表为空"
    
    response = "当前播放列表:\n\n"
    for i, song in enumerate(playlist, 1):
        response += f"{i}. {song['name']} - {song['artist']}\n"
    
    return response

async def clear_playlist_handler(arguments: Dict[str, Any]) -> str:
    playback_state["playlist"] = []
    return "播放列表已清空"

async def next_song_handler(arguments: Dict[str, Any]) -> str:
    playlist = playback_state["playlist"]
    current = playback_state["current_song"]
    
    if not playlist:
        return "播放列表为空，无法切换到下一首"
    
    if current:
        try:
            current_index = next(i for i, song in enumerate(playlist) if song["id"] == current["id"])
            next_index = (current_index + 1) % len(playlist)
        except StopIteration:
            next_index = 0
    else:
        next_index = 0
    
    next_song = playlist[next_index]
    playback_state["current_song"] = next_song
    playback_state["is_playing"] = True
    
    return f"下一首: {next_song['name']} - {next_song['artist']}"

async def previous_song_handler(arguments: Dict[str, Any]) -> str:
    playlist = playback_state["playlist"]
    current = playback_state["current_song"]
    
    if not playlist:
        return "播放列表为空，无法切换到上一首"
    
    if current:
        try:
            current_index = next(i for i, song in enumerate(playlist) if song["id"] == current["id"])
            prev_index = (current_index - 1) % len(playlist)
        except StopIteration:
            prev_index = len(playlist) - 1
    else:
        prev_index = len(playlist) - 1
    
    prev_song = playlist[prev_index]
    playback_state["current_song"] = prev_song
    playback_state["is_playing"] = True
    
    return f"上一首: {prev_song['name']} - {prev_song['artist']}"

async def main():
    """主函数"""
    logger.info("启动免费音乐MCP服务器...")
    
    # 注册工具
    server.add_tool("search_music", "搜索音乐", {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "limit": {"type": "integer", "description": "返回结果数量", "default": 10}
        },
        "required": ["query"]
    }, search_music_handler)
    
    server.add_tool("play_music", "播放音乐", {
        "type": "object",
        "properties": {
            "song_id": {"type": "string", "description": "歌曲ID"},
            "song_name": {"type": "string", "description": "歌曲名称"},
            "artist": {"type": "string", "description": "歌手名称"}
        },
        "required": ["song_id"]
    }, play_music_handler)

    server.add_tool("get_stream_url", "获取歌曲的可播放音频URL", {
        "type": "object",
        "properties": {
            "song_id": {"type": "string", "description": "搜索结果中的歌曲ID"}
        },
        "required": ["song_id"]
    }, get_stream_url_handler)
    
    server.add_tool("pause_music", "暂停音乐", {
        "type": "object",
        "properties": {}
    }, pause_music_handler)
    
    server.add_tool("resume_music", "继续播放音乐", {
        "type": "object",
        "properties": {}
    }, resume_music_handler)
    
    server.add_tool("stop_music", "停止音乐", {
        "type": "object",
        "properties": {}
    }, stop_music_handler)
    
    server.add_tool("set_volume", "设置音量", {
        "type": "object",
        "properties": {
            "volume": {"type": "integer", "description": "音量百分比 (0-100)", "minimum": 0, "maximum": 100}
        },
        "required": ["volume"]
    }, set_volume_handler)
    
    server.add_tool("add_to_playlist", "添加到播放列表", {
        "type": "object",
        "properties": {
            "song_id": {"type": "string", "description": "歌曲ID"},
            "song_name": {"type": "string", "description": "歌曲名称"},
            "artist": {"type": "string", "description": "歌手名称"}
        },
        "required": ["song_id"]
    }, add_to_playlist_handler)
    
    server.add_tool("get_playlist", "获取播放列表", {
        "type": "object",
        "properties": {}
    }, get_playlist_handler)
    
    server.add_tool("clear_playlist", "清空播放列表", {
        "type": "object",
        "properties": {}
    }, clear_playlist_handler)
    
    server.add_tool("next_song", "下一首歌", {
        "type": "object",
        "properties": {}
    }, next_song_handler)
    
    server.add_tool("previous_song", "上一首歌", {
        "type": "object",
        "properties": {}
    }, previous_song_handler)
    
    # 运行服务器
    await server.run_stdio()

if __name__ == "__main__":
    asyncio.run(main())

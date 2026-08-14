#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
免费音乐MCP WebSocket服务器
为小智AI音响提供音乐控制服务 - WebSocket版本
"""

import asyncio
import json
import logging
import os
import websockets
from typing import Dict, Any, List
from datetime import datetime
from yandex_music_provider import provider

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 播放状态管理
playback_state = {
    "is_playing": False,
    "current_song": None,
    "volume": 50,
    "position": 0,
    "playlist": []
}

class MCPWebSocketServer:
    """MCP WebSocket服务器"""
    
    def __init__(self):
        self.tools = {}
        self.resources = {}
        
    def add_tool(self, name: str, description: str, input_schema: Dict[str, Any], handler):
        """添加工具"""
        self.tools[name] = {
            "name": name,
            "description": description,
            "inputSchema": input_schema,
            "handler": handler
        }
        
    def add_resource(self, uri: str, name: str, description: str = ""):
        """添加资源"""
        self.resources[uri] = {
            "uri": uri,
            "name": name,
            "description": description
        }
    
    async def handle_message(self, websocket, message: str):
        """处理WebSocket消息"""
        try:
            data = json.loads(message)
            method = data.get("method")
            msg_id = data.get("id")
            params = data.get("params", {})
            
            logger.info(f"收到消息: {method}")
            
            if method == "initialize":
                response = {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {"listChanged": True},
                            "resources": {"subscribe": True, "listChanged": True}
                        },
                        "serverInfo": {
                            "name": "music-mcp-server",
                            "version": "1.0.0"
                        }
                    }
                }
                
            elif method == "tools/list":
                tools_list = [{
                    "name": tool["name"],
                    "description": tool["description"],
                    "inputSchema": tool["inputSchema"]
                } for tool in self.tools.values()]
                
                response = {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "tools": tools_list
                    }
                }
                
            elif method == "tools/call":
                tool_name = params.get("name")
                arguments = params.get("arguments", {})
                
                if tool_name in self.tools:
                    try:
                        result = await self.tools[tool_name]["handler"](arguments)
                        response = {
                            "jsonrpc": "2.0",
                            "id": msg_id,
                            "result": {
                                "content": [{
                                    "type": "text",
                                    "text": result
                                }]
                            }
                        }
                    except Exception as e:
                        logger.error(f"工具调用错误: {e}")
                        response = {
                            "jsonrpc": "2.0",
                            "id": msg_id,
                            "error": {
                                "code": -32603,
                                "message": f"工具执行错误: {str(e)}"
                            }
                        }
                else:
                    response = {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {
                            "code": -32601,
                            "message": f"未知工具: {tool_name}"
                        }
                    }
                    
            elif method == "resources/list":
                resources_list = list(self.resources.values())
                response = {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "resources": resources_list
                    }
                }
                
            elif method == "resources/read":
                uri = params.get("uri")
                if uri in self.resources:
                    content = await self.get_resource_content(uri)
                    response = {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {
                            "contents": [{
                                "uri": uri,
                                "mimeType": "text/plain",
                                "text": content
                            }]
                        }
                    }
                else:
                    response = {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "error": {
                            "code": -32602,
                            "message": f"未知资源: {uri}"
                        }
                    }
            else:
                response = {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {
                        "code": -32601,
                        "message": f"未知方法: {method}"
                    }
                }
            
            await websocket.send(json.dumps(response))
            
        except json.JSONDecodeError as e:
            logger.error(f"JSON解析错误: {e}")
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": "JSON解析错误"
                }
            }
            await websocket.send(json.dumps(error_response))
            
        except Exception as e:
            logger.error(f"处理消息错误: {e}")
            error_response = {
                "jsonrpc": "2.0",
                "id": data.get("id") if 'data' in locals() else None,
                "error": {
                    "code": -32603,
                    "message": f"内部错误: {str(e)}"
                }
            }
            await websocket.send(json.dumps(error_response))
    
    async def get_resource_content(self, uri: str) -> str:
        """获取资源内容"""
        if uri == "music://current_playlist":
            playlist = playback_state["playlist"]
            if not playlist:
                return "播放列表为空"
            
            content = "当前播放列表:\n\n"
            for i, song in enumerate(playlist, 1):
                content += f"{i}. {song['name']} - {song['artist']}\n"
            return content
            
        elif uri == "music://current_playing":
            current = playback_state["current_song"]
            if not current:
                return "当前没有播放歌曲"
            
            status = "播放中" if playback_state["is_playing"] else "已暂停"
            return f"当前播放: {current['name']} - {current['artist']}\n状态: {status}\n音量: {playback_state['volume']}%"
            
        return "未知资源"

# 音乐搜索API
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

async def handle_client(websocket):
    """处理WebSocket客户端连接"""
    logger.info(f"新客户端连接: {websocket.remote_address}")
    
    try:
        async for message in websocket:
            await server.handle_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        logger.info(f"客户端断开连接: {websocket.remote_address}")
    except Exception as e:
        logger.error(f"处理客户端错误: {e}")

# 创建服务器实例
server = MCPWebSocketServer()

async def main():
    """主函数"""
    logger.info("启动免费音乐MCP WebSocket服务器...")
    
    # 添加资源
    server.add_resource("music://current_playlist", "当前播放列表", "显示当前播放列表中的所有歌曲")
    server.add_resource("music://current_playing", "当前播放", "显示当前正在播放的歌曲信息")
    
    # 注册工具
    server.add_tool("search_music", "搜索音乐", {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "limit": {"type": "integer", "description": "返回结果数量", "default": 10, "minimum": 1, "maximum": 50}
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
            "volume": {"type": "integer", "description": "音量百分比", "minimum": 0, "maximum": 100}
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
    
    # 启动WebSocket服务器
    # 支持云端部署的动态端口配置
    host = os.getenv('HOST', '0.0.0.0')  # 云端部署需要监听所有接口
    port = int(os.getenv('PORT', 8765))  # 支持云平台的动态端口
    
    start_server = websockets.serve(handle_client, host, port)
    logger.info(f"WebSocket服务器启动在 ws://{host}:{port}")
    
    await start_server
    await asyncio.Future()  # 保持服务器运行

if __name__ == "__main__":
    asyncio.run(main())

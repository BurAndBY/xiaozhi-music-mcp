"""Minimal Xiaozhi MCP endpoint simulator.

This accepts the Worker websocket connection and acknowledges a routed
``self.audio.play_stream`` call as a fake device. It is intentionally small:
it validates the JSON-RPC direction and records the URL without touching an
ESP32 or downloading audio.
"""

import argparse
import asyncio
import json
from typing import Any

import websockets


async def run_client(socket: websockets.ServerConnection) -> None:
    print("connected")
    async for raw in socket:
        message = json.loads(raw)
        method = message.get("method")
        request_id = message.get("id")

        if method == "initialize":
            await socket.send(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "device-simulator", "version": "1.0"},
                },
            }))
        elif method == "ping":
            await socket.send(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": {}}))
        elif method == "tools/call":
            params: dict[str, Any] = message.get("params", {})
            name = params.get("name")
            arguments = params.get("arguments", {})
            print(json.dumps({"device_tool": name, "arguments": arguments}, ensure_ascii=False))
            await socket.send(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"content": [{"type": "text", "text": "simulated device accepted"}]},
            }))
        elif request_id is not None:
            await socket.send(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"Unsupported method: {method}"},
            }))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    async with websockets.serve(run_client, args.host, args.port):
        print(f"simulator listening on ws://{args.host}:{args.port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

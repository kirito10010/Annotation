#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Label Auto 在线注册表（云端）

接收各客户端的心跳，按机器去重统计同时在线人数。零第三方依赖。

接口：
  POST /presence/heartbeat    Header: X-App-Token: <APP_TOKEN>
      body: {"id":"<实例id>","host":"<主机hash>","role":"staff","ver":"1.7.0"}
      -> {"ok":true,"count":3}
  GET  /presence/count        -> {"ok":true,"count":3}
  GET  /                      -> 状态页

部署（Windows 服务器）：
  1) 放行防火墙：
     netsh advfirewall firewall add rule name="LabelAuto-Presence" dir=in action=allow protocol=TCP localport=39417
  2) 云厂商安全组放行 TCP 39417 入站
  3) 前台试跑： python presence_server.py
  4) 常驻（二选一）：
     - 任务计划程序 -> 计算机启动时运行 -> pythonw.exe <本文件绝对路径>
     - NSSM 注册为 Windows 服务
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = int(os.environ.get("PRESENCE_PORT", "39417"))
APP_TOKEN = os.environ.get("PRESENCE_TOKEN", "la-9f4c1d7b-2026")
TTL = 45          # 秒：超过没心跳视为离线
MAX_PEERS = 2000  # 内存上限，防止被刷爆
MAX_BODY = 4096   # 请求体上限
RATE_LIMIT = 5    # 单 IP 每秒最多心跳次数

_START = time.time()
_PEERS = {}       # instance_id -> {"host", "role", "ver", "ts"}
_LOCK = threading.Lock()
_RATE = {}        # ip -> [window_start, count]
_RATE_LOCK = threading.Lock()
_LAST_COUNT = -1
_COUNT_LOCK = threading.Lock()


def _prune_and_count():
    """清理超时心跳，返回按 host 去重后的在线数。"""
    now = time.time()
    with _LOCK:
        for k in [k for k, v in _PEERS.items() if now - v["ts"] > TTL]:
            _PEERS.pop(k, None)
        return len({v["host"] for v in _PEERS.values()})


def _note_count(count):
    global _LAST_COUNT
    with _COUNT_LOCK:
        if count != _LAST_COUNT:
            _LAST_COUNT = count
            print("[presence] online=%d" % count, flush=True)


def _rate_ok(ip):
    """简单令牌桶：每个 IP 每秒最多 RATE_LIMIT 次。"""
    now = time.time()
    with _RATE_LOCK:
        ent = _RATE.get(ip)
        if not ent or now - ent[0] >= 1.0:
            _RATE[ip] = [now, 1]
            return True
        ent[1] += 1
        return ent[1] <= RATE_LIMIT


class Handler(BaseHTTPRequestHandler):
    server_version = "LabelAutoPresence/1.0"

    def log_message(self, fmt, *args):
        pass  # 关掉默认的逐请求日志，只保留在线数变化

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/presence/count":
            n = _prune_and_count()
            _note_count(n)
            return self._json(200, {"ok": True, "count": n})
        if path == "/":
            n = _prune_and_count()
            _note_count(n)
            html = ("<!doctype html><meta charset='utf-8'><title>Label Auto 在线统计</title>"
                    "<h3>Label Auto 在线统计</h3><p>在线：<b>%d</b> 台</p>"
                    "<p>运行时长：%d 秒</p><p>端口：%d</p>"
                    % (n, int(time.time() - _START), PORT))
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/presence/heartbeat":
            return self._json(404, {"ok": False, "error": "not found"})
        if self.headers.get("X-App-Token") != APP_TOKEN:
            return self._json(401, {"ok": False, "error": "bad token"})
        ip = self.client_address[0] if self.client_address else "?"
        if not _rate_ok(ip):
            return self._json(429, {"ok": False, "error": "too many requests"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return self._json(400, {"ok": False, "error": "empty body"})
        if n > MAX_BODY:
            return self._json(413, {"ok": False, "error": "body too large"})
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json(400, {"ok": False, "error": "bad json"})
        if not isinstance(d, dict):
            return self._json(400, {"ok": False, "error": "bad json"})
        iid = str(d.get("id") or "")[:64]
        host = str(d.get("host") or "")[:64]
        if not iid or not host:
            return self._json(400, {"ok": False, "error": "missing id/host"})
        with _LOCK:
            if len(_PEERS) >= MAX_PEERS and iid not in _PEERS:
                return self._json(503, {"ok": False, "error": "peer table full"})
            _PEERS[iid] = {
                "host": host,
                "role": str(d.get("role") or "")[:16],
                "ver": str(d.get("ver") or "")[:16],
                "ts": time.time(),
            }
        count = _prune_and_count()
        _note_count(count)
        return self._json(200, {"ok": True, "count": count})


def make_server(host=HOST, port=PORT):
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    return httpd


def main():
    try:
        httpd = make_server()
    except OSError as e:
        print("[presence] 无法监听 %s:%d -> %s" % (HOST, PORT, e), flush=True)
        print("[presence] 端口可能被占用，或需要管理员权限", flush=True)
        return 1
    print("[presence] listening on %s:%d (ttl=%ds, max_peers=%d)"
          % (HOST, PORT, TTL, MAX_PEERS), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

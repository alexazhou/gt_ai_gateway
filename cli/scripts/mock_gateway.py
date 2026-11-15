#!/usr/bin/env python3
"""gtgw CI/e2e 用的最小 mock 网关（P1 会话与系统命令涉及的 6 条接口）。

用法： python3 mock_gateway.py <port> <request-log-path>

设计要点：
  * 每个用例轮次都起一个**新进程**，掉电即忘 ⇒ `config set` 造成的状态不会污染下一轮
    （#256 验收里 O1「accept.sh 不幂等」的根因就是 mock 的 CONFIG 是跨轮残留的进程内状态）。
  * 所有请求追加一行 JSON 到 request-log（含方法/路径/租户/脱敏 token），
    日志放在每轮独立的临时目录里，跨轮不累积。
  * 用 token 触发状态码，便于验证退出码映射：
      sk-abcdefghijkl -> 200, forbidden -> 403, bad-request -> 400, boom -> 500, 其它 -> 401
  * 未登记路径返回 404 并在日志里留痕，避免 CLI 打到不存在的接口还「看起来成功」。
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = sys.argv[2]

TOKEN_STATUS = {"forbidden": 403, "bad-request": 400, "boom": 500}
VALID_TOKEN = "sk-abcdefghijkl"

# 进程内可变状态：只在本进程生命周期内有效（幂等的前提）
CONFIG = {"site_name": "gtgw-demo", "theme": "light", "multi_tenant_enabled": "false"}

STATUS = {
    "status": "ok",
    "mode": "node",
    "user_type": "root",
    "user_id": 1,
    "user_name": "Root",
    "tenant": {"id": 1, "main_id": 1, "multi_tenant_enabled": True},
    "statistics": {"users": 3, "vendors": 4, "models": 17, "records": 123575},
    "system": {
        "environment": "Node",
        "version": "1.9.1-beta1",
        "apiAddress": f"http://127.0.0.1:{PORT}",
        "startTime": "2026-11-15T12:00:00.000Z",
        "uptime": "1小时 2分钟",
    },
}
DASHBOARD = {
    "total_requests": 10, "success_count": 8, "failed_count": 2,
    "success_rate": 0.8, "active_users": 2, "active_models": 3, "today_requests": 4,
}
RECENT = [
    {"id": 9, "user_id": 1, "model_id": 2, "status": "success", "created_at": "2026-11-15 12:30:00"},
    {"id": 8, "user_id": 2, "model_id": 3, "status": "failed", "created_at": "2026-11-15 12:29:00"},
]
UPDATE = {"success": True, "has_update": False,
          "current_version": "1.9.1-beta1", "latest_version": "1.9.1-beta1"}

ROUTES = [
    ("GET", r"/status\.json", lambda body: (200, STATUS)),
    ("GET", r"/update\.json", lambda body: (200, UPDATE)),
    ("GET", r"/config\.json", lambda body: (200, CONFIG)),
    ("PUT", r"/config\.json", lambda body: (200, {"success": True, "config": _merge_config(body)})),
    ("GET", r"/stats/dashboard\.json", lambda body: (200, DASHBOARD)),
    ("GET", r"/stats/recent\.json", lambda body: (200, RECENT)),
]
ROUTES = [(m, re.compile("^" + p + "$"), fn) for m, p, fn in ROUTES]


def _merge_config(body):
    CONFIG.update({k: v for k, v in body.items() if k in ("site_name", "theme", "multi_tenant_enabled")})
    return dict(CONFIG)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _token(self):
        return (self.headers.get("Authorization") or "").replace("Bearer ", "").strip()

    def _record(self, body):
        token = self._token()
        masked = token[:4] + "****" + token[-4:] if len(token) > 8 else ("****" if token else "")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "method": self.command,
                "path": self.path,
                "tenant": self.headers.get("X-Tenant-ID") or "",
                "token": masked,
                "body": body,
            }, ensure_ascii=False) + "\n")

    def _send(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = {}
        if not isinstance(body, dict):
            body = {}

        token = self._token()
        self._record(body)
        if not token:
            return self._send(401, {"error": "missing token"})
        if token in TOKEN_STATUS:
            return self._send(TOKEN_STATUS[token], {"error": "token implies status"})
        if token != VALID_TOKEN:
            return self._send(401, {"error": "invalid token"})

        path = self.path.split("?")[0]
        for method, pattern, handler in ROUTES:
            if method == self.command and pattern.match(path):
                status, resp = handler(body)
                return self._send(status, resp)
        self._send(404, {"error": "mock: 未登记的路径", "path": path})

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle


if __name__ == "__main__":
    open(LOG, "w").close()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

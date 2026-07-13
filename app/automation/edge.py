from __future__ import annotations

import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse


EDGE_PATHS = [
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
]


def find_edge_executable() -> Path:
    for path in EDGE_PATHS:
        if path.exists():
            return path
    raise FileNotFoundError("未找到 Microsoft Edge，可在系统常见安装路径外手动启动 Edge CDP")


def cdp_port_is_open(cdp_url: str) -> bool:
    parsed = urlparse(cdp_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 9222
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def wait_for_cdp(cdp_url: str, timeout_seconds: float = 20) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if cdp_port_is_open(cdp_url):
            return True
        time.sleep(0.5)
    return False


def launch_edge_for_cdp(cdp_url: str, user_data_dir: Path, target_url: str) -> int:
    parsed = urlparse(cdp_url)
    port = parsed.port or 9222
    edge_path = find_edge_executable()
    user_data_dir.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [
            str(edge_path),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            target_url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return int(process.pid)


def open_edge_url(cdp_url: str, user_data_dir: Path, target_url: str) -> int:
    parsed = urlparse(cdp_url)
    port = parsed.port or 9222
    edge_path = find_edge_executable()
    user_data_dir.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [
            str(edge_path),
            f"--remote-debugging-port={port}",
            f"--user-data-dir={user_data_dir}",
            target_url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return int(process.pid)

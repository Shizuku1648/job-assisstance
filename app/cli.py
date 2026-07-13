from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="jobseeker-agent")
    subparsers = parser.add_subparsers(dest="command", required=True)
    web = subparsers.add_parser("web", help="启动 Web 控制台")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.command == "web":
        uvicorn.run("main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()

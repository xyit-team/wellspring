#!/usr/bin/env python3
"""PTY 桥接器：在没有 node-pty 的机器上提供真 tty。

由宿主 spawn，标准输出直接是 pty 的原始字节流；控制命令从 fd 3 读，
每行一个 JSON：

    {"type": "input", "data": "ls\r"}
    {"type": "resize", "cols": 120, "rows": 30}
    {"type": "kill"}

退出码沿用子进程的退出码，宿主据此判断会话结束。
"""

import errno
import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios


def set_size(fd: int, cols: int, rows: int) -> None:
    winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main() -> int:
    config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    shell = config.get("shell") or os.environ.get("SHELL") or "/bin/bash"
    args = config.get("args") or []
    cwd = config.get("cwd") or os.getcwd()
    cols = int(config.get("cols") or 100)
    rows = int(config.get("rows") or 28)
    extra_env = config.get("env") or {}

    env = dict(os.environ)
    env.update({k: str(v) for k, v in extra_env.items()})
    env.setdefault("TERM", "xterm-256color")

    master, slave = os.openpty()
    set_size(slave, cols, rows)

    child = subprocess.Popen(
        [shell, *args],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=cwd,
        env=env,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave)

    # 控制通道默认走 stdin（宿主用 stdio 的 pipe 直连）；也可指定别的 fd
    control = int(config.get("controlFd") or 0)
    out = sys.stdout.buffer
    pending_control = b""
    running = True

    while running:
        try:
            readable, _, _ = select.select([master, control], [], [], 0.5)
        except (OSError, ValueError):
            break

        if control in readable:
            try:
                chunk = os.read(control, 65536)
            except OSError as error:
                chunk = b"" if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK) else b""
            if chunk == b"" and child.poll() is not None:
                running = False
            else:
                pending_control += chunk
                while b"\n" in pending_control:
                    line, pending_control = pending_control.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        command = json.loads(line)
                    except ValueError:
                        continue
                    kind = command.get("type")
                    if kind == "input":
                        data = command.get("data") or ""
                        if data:
                            try:
                                os.write(master, data.encode("utf-8", "replace"))
                            except OSError:
                                running = False
                    elif kind == "resize":
                        try:
                            set_size(master, int(command.get("cols") or cols), int(command.get("rows") or rows))
                        except OSError:
                            pass
                    elif kind == "kill":
                        try:
                            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
                        except OSError:
                            pass
                        running = False

        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                # 子进程退出后 Linux 在 master 上返回 EIO
                if error.errno == errno.EIO:
                    break
                if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                break
            if not data:
                break
            out.write(data)
            out.flush()

        if child.poll() is not None:
            # 把 pty 里剩余的输出取完再退出
            while True:
                try:
                    rest = os.read(master, 65536)
                except OSError:
                    rest = b""
                if not rest:
                    break
                out.write(rest)
                out.flush()
            break

    try:
        os.close(master)
    except OSError:
        pass

    code = child.poll()
    if code is None:
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except OSError:
            pass
        child.wait(timeout=2)
        code = child.returncode
    return code or 0


if __name__ == "__main__":
    sys.exit(main())

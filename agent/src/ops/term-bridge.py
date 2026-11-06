#!/usr/bin/env python3
# Keel account terminal bridge (contract section 68). Started by whm-agentd as the
# hosting account (setpriv/runuser, no root descriptor but the three control pipes):
#   term-bridge.py <socket-path> <cols> <rows> <idle-seconds> <max-seconds>
# Forks the account's login shell on a pty, listens on the unix socket, serves the
# first client only and bridges pty <-> socket. Everything else comes from the
# environment (SHELL, HOME, USER, LOGNAME, TERM, LANG, PATH); nothing is parsed.
#
# Wire format (client -> bridge): frames of [type:1][length:2 big-endian][payload],
# payload at most 8192 bytes. type 0 = keyboard bytes, type 1 = resize with a
# 4-byte payload (cols u16, rows u16). bridge -> client: raw pty bytes.
# Control (agent -> bridge, stdin): "resize <cols> <rows>\n". The bridge prints
# "ready\n" on stdout once the socket listens, and exits on hangup (shell exit or
# client gone), idle timeout, hard cap, SIGHUP or SIGTERM.
import errno
import fcntl
import os
import select
import signal
import socket
import struct
import sys
import termios
import time

MAX_FRAME = 8192
HEADER = 3


def die(message, code=1):
    sys.stderr.write(message + '\n')
    sys.stderr.flush()
    sys.exit(code)


def set_winsize(fd, cols, rows):
    cols = max(20, min(500, int(cols)))
    rows = max(5, min(200, int(rows)))
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass
    return cols, rows


def main(argv):
    if len(argv) != 6:
        die('usage: term-bridge.py <socket-path> <cols> <rows> <idle-seconds> <max-seconds>', 2)
    sock_path = argv[1]
    try:
        cols, rows, idle_s, max_s = int(argv[2]), int(argv[3]), int(argv[4]), int(argv[5])
    except ValueError:
        die('cols, rows, idle-seconds and max-seconds must be integers', 2)
    shell = os.environ.get('SHELL') or ''
    home = os.environ.get('HOME') or '/'
    base = os.path.basename(shell)
    if not shell.startswith('/') or not os.access(shell, os.X_OK) or base in ('nologin', 'false'):
        die('shell_disabled: no login shell is available for this account', 3)
    if os.path.lexists(sock_path):
        die('socket path already exists: ' + sock_path, 4)

    # 0660: the account owns the socket, the agent hands it to the panel group afterwards.
    os.umask(0o117)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(sock_path)
    except OSError as exc:
        die('cannot bind ' + sock_path + ': ' + exc.strerror, 4)
    listener.listen(1)

    import pty
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(home)
        except OSError:
            os.chdir('/')
        env = {k: v for k, v in os.environ.items() if k in ('HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'PATH')}
        env.setdefault('TERM', 'xterm-256color')
        env.setdefault('LANG', 'C.UTF-8')
        env.setdefault('PATH', '/usr/local/bin:/usr/bin:/bin')
        try:
            os.execve(shell, ['-' + base], env)
        except OSError as exc:
            os.write(2, ('cannot start ' + shell + ': ' + exc.strerror + '\n').encode())
            os._exit(127)

    set_winsize(master, cols, rows)
    sys.stdout.write('ready\n')
    sys.stdout.flush()

    started = time.monotonic()
    last_activity = started
    client = None
    inbuf = b''
    ctlbuf = b''
    exit_reason = 'hangup'

    def hangup(*_args):
        raise SystemExit(0)

    signal.signal(signal.SIGHUP, hangup)
    signal.signal(signal.SIGTERM, hangup)

    try:
        while True:
            now = time.monotonic()
            if now - last_activity > idle_s:
                exit_reason = 'idle'
                break
            if now - started > max_s:
                exit_reason = 'max'
                break
            readers = [master, sys.stdin.fileno()]
            readers.append(client if client is not None else listener)
            try:
                ready, _w, _x = select.select(readers, [], [], 5)
            except InterruptedError:
                continue
            for r in ready:
                if r is listener:
                    conn, _addr = listener.accept()
                    client = conn
                    listener.close()
                    try:
                        os.unlink(sock_path)
                    except OSError:
                        pass
                    last_activity = time.monotonic()
                elif r is client:
                    try:
                        data = client.recv(65536)
                    except OSError:
                        data = b''
                    if not data:
                        exit_reason = 'client_closed'
                        raise SystemExit(0)
                    last_activity = time.monotonic()
                    inbuf += data
                    while len(inbuf) >= HEADER:
                        ftype, length = inbuf[0], struct.unpack('>H', inbuf[1:3])[0]
                        if length > MAX_FRAME:
                            exit_reason = 'protocol'
                            raise SystemExit(0)
                        if len(inbuf) < HEADER + length:
                            break
                        payload = inbuf[HEADER:HEADER + length]
                        inbuf = inbuf[HEADER + length:]
                        if ftype == 0 and payload:
                            os.write(master, payload)
                        elif ftype == 1 and length == 4:
                            c, rw = struct.unpack('>HH', payload)
                            set_winsize(master, c, rw)
                            os.kill(pid, signal.SIGWINCH)
                elif r == master:
                    try:
                        out = os.read(master, MAX_FRAME)
                    except OSError:
                        out = b''
                    if not out:
                        exit_reason = 'shell_exited'
                        raise SystemExit(0)
                    last_activity = time.monotonic()
                    if client is not None:
                        try:
                            client.sendall(out)
                        except OSError:
                            exit_reason = 'client_closed'
                            raise SystemExit(0)
                else:
                    line = os.read(sys.stdin.fileno(), 4096)
                    if not line:
                        exit_reason = 'agent_closed'
                        raise SystemExit(0)
                    ctlbuf += line
                    while b'\n' in ctlbuf:
                        cmd, ctlbuf = ctlbuf.split(b'\n', 1)
                        parts = cmd.decode('ascii', 'replace').split()
                        if len(parts) == 3 and parts[0] == 'resize' and parts[1].isdigit() and parts[2].isdigit():
                            set_winsize(master, parts[1], parts[2])
                            os.kill(pid, signal.SIGWINCH)
    except SystemExit:
        pass
    finally:
        for fd_obj in (client, listener):
            try:
                if fd_obj is not None:
                    fd_obj.close()
            except OSError:
                pass
        try:
            os.unlink(sock_path)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            os.close(master)
        except OSError:
            pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                done, _status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                done = pid
            if done:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass
        sys.stdout.write('exit ' + exit_reason + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main(sys.argv)

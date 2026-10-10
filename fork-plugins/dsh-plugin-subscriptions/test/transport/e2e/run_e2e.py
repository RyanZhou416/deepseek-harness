#!/usr/bin/env python3
"""Bun 桥的端到端 harness(零出网):
  ① 用帧格式写一个请求到文件(标准输入)
  ② 真实启动 Bun 子进程,stdin/stdout 走文件重定向(不用管道)
  ③ 回环 TLS 监听:记录 ClientHello 并算 JA3,然后回一个 SSE 响应
  ④ 断言:响应帧内容正确 + JA3 与真客户端向量一致
"""
import hashlib
import os
import shutil
import re
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TEMP = tempfile.gettempdir()
BUN = os.path.join(TEMP, 'buntest', 'node_modules', '@oven', 'bun-windows-x64', 'bin', 'bun.exe')
CHILD = r'C:\Project\deepseek-harness\fork-plugins\dsh-plugin-subscriptions\lib\transport\bun-child.js'
CERT = os.path.join(HERE, 'srv.crt')
KEY = os.path.join(HERE, 'srv.key')
CAFILE = os.path.join(HERE, 'ca.crt')
EXPECTED_JA3 = '1523504b38f0fae0d881d4b6554aac1b'
PORT = 18590


def ensure_certs():
    """Generates a CA and a localhost certificate signed by it, once."""
    if os.path.exists(os.path.join(HERE, "srv.crt")):
        return
    openssl = shutil.which("openssl") or r"C:\Program Files\Git\usr\bin\openssl.exe"
    if not os.path.exists(openssl) and shutil.which("openssl") is None:
        raise SystemExit("  x openssl not found; install it or generate srv.crt/srv.key/ca.crt here")
    san = os.path.join(HERE, "san.cnf")
    with open(san, "w", encoding="ascii") as fh:
        fh.write("subjectAltName=DNS:localhost,IP:127.0.0.1\n")
    run = lambda *a: subprocess.run([openssl, *a], cwd=HERE, capture_output=True, check=True)
    run("req", "-x509", "-newkey", "rsa:2048", "-days", "2", "-nodes", "-keyout", "ca.key",
        "-out", "ca.crt", "-subj", "/CN=bridge-e2e-ca", "-addext", "basicConstraints=critical,CA:TRUE")
    run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost")
    run("x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
        "-out", "srv.crt", "-days", "2", "-extfile", "san.cnf")

TAG_CONTROL, TAG_BODY = 1, 2
caught = {}
sse_payload = b'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'


# ---------- 帧编解码(Python 侧,与 TS 实现同格式)----------
def frame(tag, payload):
    return struct.pack('>I', 1 + len(payload)) + bytes([tag]) + payload


def control(stream_id, **fields):
    import json
    return frame(TAG_CONTROL, json.dumps({'streamId': stream_id, **fields}).encode())


def body(stream_index, raw):
    return frame(TAG_BODY, struct.pack('>I', stream_index) + raw)


def parse_frames(buf):
    out, i = [], 0
    while i + 4 <= len(buf):
        length = struct.unpack('>I', buf[i:i + 4])[0]
        if i + 4 + length > len(buf):
            break
        payload = buf[i + 4:i + 4 + length]
        i += 4 + length
        tag, rest = payload[0], payload[1:]
        if tag == TAG_CONTROL:
            import json
            out.append(('control', json.loads(rest.decode('utf-8'))))
        elif tag == TAG_BODY:
            out.append(('body', struct.unpack('>I', rest[:4])[0], rest[4:]))
    return out


# ---------- ClientHello 解析 + JA3 ----------
GREASE = {0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a, 0x8a8a, 0x9a9a,
          0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa}


def ja3_of(rec):
    if len(rec) < 6 or rec[0] != 0x16:
        return None
    hs = rec[5:]
    if len(hs) < 4 or hs[0] != 0x01:
        return None
    p = 4 + 2 + 32
    sid_len = hs[p]; p += 1 + sid_len
    cs_len = struct.unpack('>H', hs[p:p + 2])[0]; p += 2
    ciphers = [struct.unpack('>H', hs[p + i:p + i + 2])[0] for i in range(0, cs_len, 2)]
    p += cs_len
    comp_len = hs[p]; p += 1 + comp_len
    ext_len = struct.unpack('>H', hs[p:p + 2])[0] if p + 2 <= len(hs) else 0
    p += 2
    end = min(len(hs), p + ext_len)
    exts, curves, points = [], [], []
    while p + 4 <= end:
        etype, elen = struct.unpack('>H', hs[p:p + 2])[0], struct.unpack('>H', hs[p + 2:p + 4])[0]
        data = hs[p + 4:p + 4 + elen]
        exts.append(etype)
        if etype == 10 and len(data) >= 2:  # supported_groups
            n = struct.unpack('>H', data[:2])[0]
            curves = [struct.unpack('>H', data[2 + i:4 + i])[0] for i in range(0, n, 2)]
        elif etype == 11 and len(data) >= 1:  # ec_point_formats
            points = list(data[1:1 + data[0]])
        p += 4 + elen
    clean = lambda xs: [x for x in xs if x not in GREASE]
    ciphers, exts, curves = clean(ciphers), clean(exts), clean(curves)
    s = ','.join([
        str(struct.unpack('>H', hs[4:6])[0]),
        '-'.join(map(str, ciphers)), '-'.join(map(str, exts)),
        '-'.join(map(str, curves)), '-'.join(map(str, points)),
    ])
    return hashlib.md5(s.encode()).hexdigest(), s


# ---------- 回环 TLS 监听 ----------
def serve():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', PORT))
    srv.listen(4)
    srv.settimeout(25)
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        return
    conn.settimeout(10)
    # Peek the first TLS record without consuming it, tolerating short reads.
    head = b''
    while len(head) < 5:
        head = conn.recv(4096, socket.MSG_PEEK)
        if len(head) < 5:
            time.sleep(0.02)
    need = struct.unpack('>H', head[3:5])[0]
    while len(head) < 5 + need:
        head = conn.recv(65536, socket.MSG_PEEK)
        if len(head) < 5 + need:
            time.sleep(0.02)
    head = head[:5 + need]
    caught['clienthello'] = head
    ja3 = ja3_of(head)
    caught['ja3'] = ja3
    # 把已读字节回灌给 ssl 模块,完成握手
    try:
        tls = ctx.wrap_socket(conn, server_side=True)
        req = b''
        while b'\r\n\r\n' not in req:
            chunk = tls.recv(4096)
            if not chunk:
                break
            req += chunk
        caught['request'] = req.decode('latin1')
        body_len = 0
        m = re.search(rb'content-length:\s*(\d+)', req, re.I)
        if m:
            body_len = int(m.group(1))
        already = req.split(b'\r\n\r\n', 1)[1] if b'\r\n\r\n' in req else b''
        while len(already) < body_len:
            chunk = tls.recv(4096)
            if not chunk:
                break
            already += chunk
        caught['body'] = already[:body_len]
        tls.sendall(b'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: '
                    + str(len(sse_payload)).encode() + b'\r\nconnection: close\r\n\r\n' + sse_payload)
        tls.close()
    except Exception as exc:  # noqa: BLE001 - harness 记录而非抛出
        caught['tls_error'] = f'{type(exc).__name__}: {exc}'
    finally:
        try:
            conn.close()
        except OSError:
            pass


class BioProxy:
    """把已读的 ClientHello 字节先喂给 ssl,再交回真实 socket。"""

    def __init__(self, sock, prefix):
        self._sock = sock
        self._prefix = prefix

    def recv(self, n):
        if self._prefix:
            out, self._prefix = self._prefix[:n], self._prefix[n:]
            return out
        return self._sock.recv(n)

    def sendall(self, data):
        return self._sock.sendall(data)

    def send(self, data):
        return self._sock.send(data)

    def settimeout(self, t):
        return self._sock.settimeout(t)

    def gettimeout(self):
        return self._sock.gettimeout()

    def fileno(self):
        return self._sock.fileno()

    def close(self):
        return self._sock.close()


def main():
    ensure_certs()
    if not os.path.exists(BUN):
        print(f'  ✗ 未找到 Bun: {BUN}')
        return 1
    if not os.path.exists(CHILD):
        print(f'  ✗ 未找到子进程产物: {CHILD}')
        return 1

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    time.sleep(0.4)

    stream_id = 'e2e-1'
    request_body = b'{"model":"claude-opus-5-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"ping"}]}'
    client_hello_headers = [
        ['content-type', 'application/json'],
        ['user-agent', 'claude-cli/2.1.280 (external, cli)'],
        ['x-app', 'cli'],
        ['x-client-request-id', '00000000-0000-4000-8000-000000000002'],
        ['anthropic-version', '2023-06-01'],
    ]
    payload = b''.join([
        control(stream_id, index=0, type='request', url=f'https://localhost:{PORT}/v1/messages?beta=true',
                method='POST', headers=client_hello_headers, body=True),
        body(0, request_body),
        control(stream_id, type='body-end'),
    ])

    inp = os.path.join(HERE, 'in.frames')
    outp = os.path.join(HERE, 'out.frames')
    with open(inp, 'wb') as fh:
        fh.write(payload)
    if os.path.exists(outp):
        os.remove(outp)

    env = dict(os.environ)
    env['NODE_EXTRA_CA_CERTS'] = CAFILE
    env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    with open(inp, 'rb') as fin, open(outp, 'wb') as fout:
        proc = subprocess.run([BUN, CHILD], stdin=fin, stdout=fout, stderr=subprocess.PIPE,
                              env=env, timeout=90)
    thread.join(timeout=5)

    print(f'  子进程退出码: {proc.returncode}')
    err = (proc.stderr or b'').decode('utf-8', 'replace').strip()
    if err:
        print('  stderr: ' + err.splitlines()[0][:200])

    print('\n=== ① ClientHello / JA3 ===')
    ja3 = caught.get('ja3')
    if ja3 is None:
        print('  ✗ 未捕获到 ClientHello')
    else:
        digest, raw = ja3
        print(f'  JA3 = {digest}')
        print(f'  期望 = {EXPECTED_JA3}')
        print('  判定: ' + ('一致 ✓✓' if digest == EXPECTED_JA3 else '不一致 ✗'))
        print(f'  明细: {raw[:150]}')

    print('\n=== ② 服务器侧收到的请求 ===')
    req = caught.get('request')
    if req:
        lines = req.split('\r\n')
        print('  ' + lines[0][:110])
        for line in lines[1:]:
            if line.lower().startswith(('content-type', 'user-agent', 'x-app', 'x-client-request-id',
                                        'anthropic-version', 'accept-encoding', 'host', 'connection',
                                        'content-length')):
                print('  ' + line[:110])
        print(f'  body({len(caught.get("body", b""))}B): ' + caught.get('body', b'').decode('utf-8', 'replace')[:90])
    else:
        print('  ✗ 未收到请求 ' + str(caught.get('tls_error', '')))

    print('\n=== ③ 子进程回帧 ===')
    data = open(outp, 'rb').read() if os.path.exists(outp) else b''
    frames = parse_frames(data)
    print(f'  帧数: {len(frames)}')
    head = None
    chunks = []
    ended = False
    for item in frames:
        if item[0] == 'control':
            msg = item[1]
            print(f"  control: type={msg.get('type')} " + (f"status={msg.get('status')}" if 'status' in msg else '')
                  + (f" message={str(msg.get('message'))[:70]}" if 'message' in msg else ''))
            if msg.get('type') == 'response':
                head = msg
            if msg.get('type') == 'end':
                ended = True
        else:
            chunks.append(item[2])
    joined = b''.join(chunks)
    print(f'  响应体 {len(joined)} 字节, 结束帧: {ended}')
    print('  体内容匹配 SSE: ' + ('✓' if joined == sse_payload else '✗'))
    print(f'  首块: {joined[:60]!r}')
    verdict = (ja3 is not None and ja3[0] == EXPECTED_JA3 and joined == sse_payload and ended
               and head is not None and head.get('status') == 200)
    print('\n=== 结论 ===')
    print('  桥端到端可用 ✓✓' if verdict else '  存在失败项 ✗(见上)')
    return 0 if verdict else 1


if __name__ == '__main__':
    sys.exit(main())

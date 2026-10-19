"""Stage 0 of Phase I: what does a RunPod network volume do when two Pods use
it at once? Run by two Pods (ROLE=A and ROLE=B) mounted on the same volume.
Started by tools/runpod/stage0/run.mjs, which reads the results through
RunPod's proxy and terminates both Pods.

Everything is measured with each Pod's own clock (durations, never times
compared across machines), and everything it writes lives under
/workspace/_stage0/<RUN_ID>/. The big files are deleted at the end; the small
JSON results stay so a run can be looked at again.

Tests:
  mount       both Pods see the volume and each other's first file
  visibility  ping-pong: A writes ping-i, B answers pong-i; A times the round trip
  exclusive   both race to O_EXCL-create the same 400 lock files; each must
              have exactly one owner (what Phase I's download lock relies on)
  rename      A renames 24 freshly written files into place, and replaces one
              file 20 times; B must never read a partial or mixed file
  throughput  write speed, one Pod reading alone, then both reading a model
              file at once
"""
import hashlib, http.server, json, os, socketserver, threading, time, traceback

ROLE = os.environ.get("ROLE", "A")
OTHER = "B" if ROLE == "A" else "A"
RUN = os.environ.get("RUN_ID", "run")
VOL = os.environ.get("STAGE0_VOLUME", "/workspace")
BASE = os.path.join(VOL, "_stage0", RUN)
# For a local dry run: two processes on one PC need two ports, and less data.
PORT = int(os.environ.get("STAGE0_PORT", "3000"))
SCALE = float(os.environ.get("STAGE0_SCALE", "1"))
os.makedirs(BASE, exist_ok=True)

status = {"role": ROLE, "phase": "starting", "started": time.time(), "error": None}
results = {"role": ROLE}


def save(name, obj):
    tmp = os.path.join(BASE, f".{name}.{ROLE}.tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, os.path.join(BASE, name))


def phase(p):
    status["phase"] = p
    status["at"] = time.time()
    save(f"status-{ROLE}.json", status)
    print(f"[{ROLE}] {p}", flush=True)


def wait_for(path, timeout, poll=0.05):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if os.path.exists(path):
            return time.monotonic() - t0
        time.sleep(poll)
    raise TimeoutError(f"{os.path.basename(path)} did not appear within {timeout}s")


def barrier(name, timeout=900):
    open(os.path.join(BASE, f"bar-{name}-{ROLE}"), "w").close()
    wait_for(os.path.join(BASE, f"bar-{name}-{OTHER}"), timeout)


# Serve the results folder on port 3000 so the launcher can read it through
# RunPod's proxy without the Pods needing any credential.
class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=BASE, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Quiet) as s:
        s.serve_forever()


threading.Thread(target=serve, daemon=True).start()


def t_mount():
    phase("mount: waiting for the other Pod")
    with open(os.path.join(BASE, f"hello-{ROLE}"), "w") as f:
        f.write(f"{ROLE} {time.time()}")
    waited = wait_for(os.path.join(BASE, f"hello-{OTHER}"), 1800)
    results["mount"] = {"ok": True, "waitedForOtherSec": round(waited, 1)}


def t_visibility(rounds=20):
    phase("visibility: ping-pong")
    rtts = []
    for i in range(rounds):
        if ROLE == "A":
            t0 = time.monotonic()
            with open(os.path.join(BASE, f"ping-{i}"), "w") as f:
                f.write(str(i))
            wait_for(os.path.join(BASE, f"pong-{i}"), 120, poll=0.01)
            rtts.append(time.monotonic() - t0)
        else:
            wait_for(os.path.join(BASE, f"ping-{i}"), 300, poll=0.01)
            with open(os.path.join(BASE, f"pong-{i}"), "w") as f:
                f.write(str(i))
    if ROLE == "A":
        rtts.sort()
        results["visibility"] = {
            "rounds": rounds,
            "oneWayMedianMs": round(rtts[len(rtts) // 2] / 2 * 1000, 1),
            "oneWayWorstMs": round(rtts[-1] / 2 * 1000, 1),
            "note": "half the round trip A->B->A, polling every 10 ms",
        }


def t_exclusive(n=400):
    phase("exclusive: racing for lock files")
    d = os.path.join(BASE, "excl")
    os.makedirs(d, exist_ok=True)
    barrier("excl")
    wins, errors = [], []
    for i in range(n):
        try:
            fd = os.open(os.path.join(d, str(i)), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, ROLE.encode())
            os.close(fd)
            wins.append(i)
        except FileExistsError:
            pass
        except OSError as e:
            errors.append(f"{i}: {e}")
    save(f"excl-{ROLE}.json", {"wins": wins, "errors": errors[:20]})
    barrier("excl-done")
    if ROLE == "A":
        other = json.load(open(os.path.join(BASE, f"excl-{OTHER}.json")))
        a, b = set(wins), set(other["wins"])
        mismatched = []
        for i in range(n):
            owner = open(os.path.join(d, str(i))).read().strip()
            expect = "A" if i in a else "B" if i in b else None
            if owner != expect:
                mismatched.append(i)
        results["exclusive"] = {
            "attempts": n, "winsA": len(a), "winsB": len(b),
            "bothWon": len(a & b), "nobodyWon": n - len(a | b),
            "ownerMismatch": len(mismatched),
            "errors": errors[:5] + other["errors"][:5],
            "ok": not (a & b) and len(a | b) == n and not mismatched,
        }


def payload(k, size):
    body = bytes([k % 251]) * (size - 32)
    return body + hashlib.sha256(body).digest()


def check(data, size):
    return len(data) == size and hashlib.sha256(data[:-32]).digest() == data[-32:] \
        and data[:-32] == bytes([data[0]]) * (size - 32)


def t_rename(files=24, size=int((64 << 20) * SCALE), replaces=20, rsize=int((32 << 20) * SCALE)):
    phase("rename: new files and replacements")
    d = os.path.join(BASE, "ren")
    os.makedirs(d, exist_ok=True)
    barrier("ren")
    if ROLE == "A":
        for k in range(files):
            tmp = os.path.join(d, f".tmp-{k}")
            with open(tmp, "wb") as f:
                f.write(payload(k, size))
                f.flush()
                os.fsync(f.fileno())
            os.rename(tmp, os.path.join(d, f"file-{k}"))
        for k in range(replaces):
            tmp = os.path.join(d, ".tmp-cur")
            with open(tmp, "wb") as f:
                f.write(payload(k + 100, rsize))
                f.flush()
                os.fsync(f.fileno())
            # Linux replaces a file another process has open; Windows (a local
            # dry run) refuses, so retry there rather than fail the test.
            for attempt in range(200):
                try:
                    os.replace(tmp, os.path.join(d, "current"))
                    break
                except PermissionError:
                    time.sleep(0.02)
            else:
                raise RuntimeError("could not replace 'current' after 200 tries")
            time.sleep(0.2)
        open(os.path.join(d, "done"), "w").close()
    else:
        bad_new, seen = [], 0
        for k in range(files):
            p = os.path.join(d, f"file-{k}")
            wait_for(p, 600, poll=0.005)
            with open(p, "rb") as f:
                data = f.read()
            seen += 1
            if not check(data, size):
                bad_new.append({"k": k, "len": len(data)})
        bad_cur, reads = 0, 0
        done = os.path.join(d, "done")
        give_up = time.monotonic() + 600
        while (not os.path.exists(done) or reads == 0) and time.monotonic() < give_up:
            try:
                with open(os.path.join(d, "current"), "rb") as f:
                    data = f.read()
                reads += 1
                if not check(data, rsize):
                    bad_cur += 1
            except FileNotFoundError:
                time.sleep(0.01)
        results["rename"] = {
            "newFilesRead": seen, "partialOrCorruptNew": len(bad_new), "examples": bad_new[:3],
            "replacedReads": reads, "mixedOrPartialReplaced": bad_cur,
            "ok": not bad_new and bad_cur == 0,
        }
        save(f"rename-{ROLE}.json", results["rename"])
    barrier("ren-done")
    if ROLE == "A":
        results["rename"] = json.load(open(os.path.join(BASE, f"rename-{OTHER}.json")))


def read_speed(path, block=16 << 20):
    t0, n = time.monotonic(), 0
    with open(path, "rb", buffering=0) as f:
        while True:
            b = f.read(block)
            if not b:
                break
            n += len(b)
    dt = time.monotonic() - t0
    return {"file": os.path.basename(path), "gb": round(n / 1e9, 2), "sec": round(dt, 1), "MBps": round(n / 1e6 / dt) if dt else None}


def biggest_model():
    best = None
    for root in ("comfyui/models", "shared/models"):
        for dp, _, fs in os.walk(os.path.join(VOL, root)):
            for f in fs:
                p = os.path.join(dp, f)
                try:
                    s = os.path.getsize(p)
                except OSError:
                    continue
                if s > 1 << 30 and (best is None or s > best[1]):
                    best = (p, s)
    return best[0] if best else None


def t_throughput(gb=max(1, round(3 * SCALE))):
    phase("throughput: writing")
    mine = os.path.join(BASE, f"big-{ROLE}")
    block = os.urandom(16 << 20)
    t0 = time.monotonic()
    with open(mine, "wb") as f:
        for _ in range(gb * 1024 // 16):
            f.write(block)
        f.flush()
        os.fsync(f.fileno())
    dt = time.monotonic() - t0
    res = {"writeMBps": round(gb * 1024 * 1.048576 / dt)}
    barrier("tp-written")
    # One Pod reads alone: A reads the file B wrote (not in A's page cache).
    phase("throughput: one Pod reading alone")
    if ROLE == "A":
        res["readAlone"] = read_speed(os.path.join(BASE, f"big-{OTHER}"))
    barrier("tp-alone")
    # Both read a model file at the same moment (cold for both).
    model = biggest_model()
    phase("throughput: both reading a model at once")
    barrier("tp-both")
    res["readTogether"] = read_speed(model) if model else {"skipped": "no model over 1 GB on the volume"}
    save(f"tp-{ROLE}.json", res)
    barrier("tp-done")
    os.remove(mine)
    if ROLE == "A":
        res["B"] = json.load(open(os.path.join(BASE, f"tp-{OTHER}.json")))
        results["throughput"] = res


def cleanup():
    import shutil
    for sub in ("excl", "ren"):
        shutil.rmtree(os.path.join(BASE, sub), ignore_errors=True)
    for f in os.listdir(BASE):
        if f.startswith(("ping-", "pong-", "bar-", "big-")):
            try:
                os.remove(os.path.join(BASE, f))
            except OSError:
                pass


try:
    t_mount()
    t_visibility()
    t_exclusive()
    t_rename()
    t_throughput()
    barrier("end")
    if ROLE == "A":
        cleanup()
        results["finished"] = time.time()
        save("summary.json", results)
    phase("done")
except Exception as e:
    status["error"] = f"{e.__class__.__name__}: {e}"
    status["trace"] = traceback.format_exc()[-2000:]
    phase("failed")

# Stay up so the launcher can read the results; it terminates the Pod.
# ★ Never exit: RunPod restarts a container whose process ends, which would
#   bill exactly the same and run the tests again over these results.
while True:
    time.sleep(60)

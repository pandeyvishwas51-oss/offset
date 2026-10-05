#!/usr/bin/env python3
"""Adds narration and captions to a screen recording of one OFFSET run.

The narration is written after the run, from what actually happened: each line is tied to a moment in the
app's own log (the first invoice held back, the first loop cancelled, ...), so voice and captions follow the
picture, and the figures spoken are the figures on screen.

    python3 video/make.py --video export.mp4 --rec-start-ms 1791170000000 --state state.json --out final.mp4

--rec-start-ms is the wall-clock time (epoch ms) of the recording's first frame.
--state is a saved copy of GET /api/state taken after the run.
--speed 40:95:2.5 plays source seconds 40 to 95 at 2.5x (repeatable), to fit the three-minute limit.
Needs macOS (say, afconvert), ffmpeg, and Google Chrome for drawing the caption images.
"""
import argparse, json, os, re, subprocess, time, wave
from datetime import datetime

VOICE, RATE = "Samantha", "178"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H, FPS = 1920, 1080, 30
REVEAL_GAP = 0.42  # the page shows log entries one at a time, this far apart


def usd(cents):
    return f"${round(cents / 100):,}"


def reveal_times(state, rec_start_ms):
    """When each log entry appeared on screen, in seconds from the start of the recording."""
    out, prev = [], -1e9
    round_id = state["round"]["id"]
    for e in state["events"]:
        if e["round_id"] not in (None, round_id):
            continue
        at = datetime.fromisoformat(e["at"].replace("Z", "+00:00")).timestamp() * 1000
        t = max((at - rec_start_ms) / 1000 + 0.5, prev + REVEAL_GAP)  # +0.5s: the page polls the server
        prev = t
        out.append((t, e))
    return out


def script(state, shown):
    """The narration lines as (earliest time, text). Lines whose moment never happened are left out."""
    def first(kind, nth=0):
        hits = [t for t, e in shown if e["kind"] == kind and e["round_id"] is not None]
        return hits[nth] if len(hits) > nth else None

    rnd, inv, legs = state["round"], state["invoices"], state["legs"]
    held = sum(i["open"] for i in inv if i["status"] in ("held", "disputed"))
    paid = sum(l["amount"] for l in legs if l["kind"] == "payout" and l["status"] == "done" and l["round_id"] == rnd["id"])
    cancelled = rnd["gross"] - rnd["left"]
    round_start = next((t for t, e in shown if e["round_id"] is not None), None)
    paid_times = [t for t, e in shown if e["kind"] == "paid"]

    lines = [
        (1.0, f"Six small businesses owe each other {usd(rnd['gross'])} in unpaid invoices. Each one is waiting to be paid before it can pay."),
        (None, "A lot of that debt runs in circles, so it can cancel without anyone paying. Each business has an AI agent that follows its owner's instructions."),
        (round_start, "Step one. The agents check every invoice against its paperwork."),
        (first("hold"), "This invoice asks for $4,800, but the purchase order says $3,800. Its delivery note even tells an AI reviewer to approve it. Held back."),
        (first("dispute"), "Kite's agent knows that stock arrived water-damaged. It refuses to settle that invoice."),
        (first("loop"), "Step two is plain code, no AI. Debts that run in a loop cancel, and no money moves."),
        (first("propose"), "Step three. One business can pay another directly, and the one in the middle drops out. That changes who relies on whom, so the agents negotiate."),
        (first("counter"), "This agent will take the new payer only if it pays faster."),
    ]
    if first("nodeal") is not None:
        lines.append((first("nodeal"), "The other agent checks what its owner allows. It can't promise that, so there is no deal, and OFFSET tries another route."))
    lines += [
        (first("settled"), "Every agreed change is written to the real PayPal invoices. If one write fails, all of them are reversed."),
        (first("done"), f"{usd(cancelled)} of debt is cancelled with no money moved. Nobody's net position changed."),
        (first("pay"), "Now the only money that has to move: one PayPal payout per business."),
        (paid_times[0] if paid_times else None, "PayPal confirms each payment, and each invoice is marked paid."),
        (paid_times[-1] + 1.5 if paid_times else None, f"{usd(paid)} of real money settled {usd(rnd['gross'] - held)} of invoices. OFFSET: agents clear what cancels, and PayPal moves only what's left."),
    ]
    # A line with no trigger of its own follows the line before it. A line whose moment never came is dropped.
    out = []
    for i, (t, text) in enumerate(lines):
        if t is None and i != 1:
            continue
        out.append((t, text))
    return out


def speak(text, path):
    subprocess.run(["say", "-v", VOICE, "-r", RATE, "-o", path, "--data-format=LEI16@44100", text], check=True)
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def captions_for(text, start, duration):
    """Splits a line into sentence-sized captions, each on screen for its share of the speaking time."""
    parts = [p.strip() for p in re.split(r"(?<=[.:])\s+", text) if p.strip()]
    total = sum(len(p) for p in parts)
    out, t = [], start
    for p in parts:
        d = duration * len(p) / total
        out.append((t, t + d, p))
        t += d
    return out


def draw_caption(text, png, workdir):
    html = os.path.join(workdir, "caption.html")
    safe = text.replace("&", "&amp;").replace("<", "&lt;")
    with open(html, "w") as f:
        f.write(f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;width:{W}px;height:{H}px;background:transparent;overflow:hidden}}
.c{{position:absolute;left:0;right:0;bottom:56px;display:flex;justify-content:center}}
.c span{{max-width:1560px;padding:14px 32px;border-radius:20px;background:rgba(0,20,53,.92);color:#fff;
font:600 38px/1.3 -apple-system,"SF Pro Display","Helvetica Neue",sans-serif;text-align:center}}
</style><div class="c"><span>{safe}</span></div>""")
    if os.path.exists(png):
        os.remove(png)
    # Headless Chrome writes the image and then sometimes fails to exit, so it is stopped once the file is there.
    proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={workdir}/chrome-profile",
                             f"--window-size={W},{H}", "--default-background-color=00000000", f"--screenshot={png}", f"file://{html}"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        if os.path.exists(png) and os.path.getsize(png) > 0:
            break
        time.sleep(0.1)
    time.sleep(0.3)
    proc.kill()
    if not os.path.exists(png):
        raise RuntimeError(f"Chrome did not draw the caption: {text}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--rec-start-ms", type=float, required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speed", action="append", default=[], help="start:end:factor in source seconds")
    ap.add_argument("--end", type=float, help="cut the source here (seconds)")
    args = ap.parse_args()

    workdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
    os.makedirs(workdir, exist_ok=True)
    state = json.load(open(args.state))
    shown = reveal_times(state, args.rec_start_ms)

    src_len = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", args.video]))
    end = min(args.end or src_len, src_len)
    fast = sorted((float(a), float(b), float(f)) for a, b, f in (s.split(":") for s in args.speed))

    # Source time -> output time, after the sped-up stretches.
    pieces, cursor = [], 0.0
    for a, b, f in fast:
        if a > cursor:
            pieces.append((cursor, a, 1.0))
        pieces.append((a, min(b, end), f))
        cursor = b
    if cursor < end:
        pieces.append((cursor, end, 1.0))

    def warp(t):
        out = 0.0
        for a, b, f in pieces:
            if t <= a:
                break
            out += (min(t, b) - a) / f
        return out

    # Lay the lines out in order: each starts at its moment (after speed-ups), never before the last one ends.
    timeline, clock = [], 0.0
    for n, (t, text) in enumerate(script(state, shown)):
        wav = os.path.join(workdir, f"line{n:02d}.wav")
        dur = speak(text, wav)
        start = max(warp(t) if t is not None else clock, clock)
        timeline.append((start, dur, text, wav))
        clock = start + dur + 0.3
    total = max(warp(end), clock + 0.5)

    # One audio track with every line in place.
    rate = 44100
    track = bytearray(int(total * rate) * 2)
    for start, dur, text, wav in timeline:
        with wave.open(wav) as w:
            data = w.readframes(w.getnframes())
        at = int(start * rate) * 2
        track[at:at + len(data)] = data[: len(track) - at]
    voice = os.path.join(workdir, "voice.wav")
    with wave.open(voice, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(track))

    caps = [c for start, dur, text, _ in timeline for c in captions_for(text, start, dur)]
    inputs, chain = ["-i", args.video, "-i", voice], []
    segs = []
    for i, (a, b, f) in enumerate(pieces):
        chain.append(f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{f}[s{i}]")
        segs.append(f"[s{i}]")
    chain.append(f"{''.join(segs)}concat=n={len(segs)}:v=1:a=0,fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0xF7F5F0,tpad=stop_mode=clone:stop_duration={max(0.0, total - warp(end)):.2f}[v0]")
    last = "[v0]"
    for n, (a, b, text) in enumerate(caps):
        png = os.path.join(workdir, f"cap{n:02d}.png")
        draw_caption(text, png, workdir)
        inputs += ["-i", png]
        chain.append(f"{last}[{n + 2}:v]overlay=0:0:enable='between(t,{a:.2f},{b:.2f})'[v{n + 1}]")
        last = f"[v{n + 1}]"

    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(chain),
                    "-map", last, "-map", "1:a", "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", args.out], check=True)

    for start, dur, text, _ in timeline:
        print(f"{start:6.1f}s  {dur:4.1f}s  {text}")
    print(f"\n{args.out}: {total:.1f}s" + ("  OVER THREE MINUTES" if total >= 180 else ""))


if __name__ == "__main__":
    main()

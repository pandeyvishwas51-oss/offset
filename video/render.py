#!/usr/bin/env python3
"""Renders a Recordly screen recording of one OFFSET run with zooms that follow the story.

Recordly keeps a raw recording plus a project file that lists zoom regions. This writes that project file
from the run's own log (zoom on the agents while they negotiate, on the totals when the round ends, ...)
and asks Recordly to export it, with no clicking in its editor.

    python3 video/render.py --recording ~/Library/.../recording-1791170000000.mp4 --state state.json --out zoomed.mp4

Needs macOS and Recordly installed. Recordly must not already be running.
"""
import argparse, glob, json, os, re, subprocess, time, uuid

from make import reveal_times

RECORDLY = "/Applications/Recordly.app/Contents/MacOS/Recordly"
# Where things sit on the full-screen demo page, as fractions of the screen.
AGENTS, GRAPH, BOTH, TOTALS = (0.70, 0.60), (0.34, 0.60), (0.50, 0.62), (0.50, 0.28)

EDITOR = {
    "wallpaper": "/wallpapers/tahoe-light.jpg", "shadowIntensity": 0.67, "backgroundBlur": 0,
    "zoomMotionBlur": 0.35, "zoomTemporalMotionBlur": 0.35, "zoomMotionBlurSampleCount": 13, "zoomMotionBlurShutterFraction": 0.94,
    "connectZooms": True, "zoomInDurationMs": 450, "zoomInOverlapMs": 200, "zoomOutDurationMs": 450,
    "connectedZoomGapMs": 1500, "connectedZoomDurationMs": 1000, "zoomInEasing": "recordly", "zoomOutEasing": "recordly",
    "connectedZoomEasing": "glide", "showCursor": True, "loopCursor": False, "cursorStyle": "tahoe", "cursorSize": 2.5,
    "cursorSmoothing": 0.67, "zoomSmoothness": 0.5, "zoomClassicMode": False, "cursorMotionBlur": 0.6,
    "cursorClickEffect": "none", "cursorClickBounce": 2, "cursorClickBounceDuration": 350, "cursorSway": 0.4,
    "borderRadius": 8, "padding": {"top": 5, "bottom": 5, "left": 5, "right": 5, "linked": True},
    "cropRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
    "trimRegions": [], "speedRegions": [], "annotationRegions": [], "audioRegions": [], "autoCaptions": [],
    "aspectRatio": "16:9", "exportEncodingMode": "balanced", "exportQuality": "medium", "mp4FrameRate": 30, "exportFormat": "mp4",
}


def zooms(shown, length_ms):
    """Zoom regions as (start s, end s, depth, focus). Depth 1 is 1.25x, depth 2 is 1.5x."""
    def first(kind):
        return next((t for t, e in shown if e["kind"] == kind and e["round_id"] is not None), None)

    out = []
    def add(a, b, depth, focus):
        if a is not None and b is not None and b - a > 1.5:
            out.append((a, b, depth, focus))

    round_start = next((t for t, e in shown if e["round_id"] is not None), None)
    checks = min((t for t in (first("hold"), first("dispute")) if t is not None), default=None)
    paid = [t for t, e in shown if e["kind"] == "paid"]
    if round_start:
        add(9.5, round_start - 1.0, 2, AGENTS)              # "each business has an AI agent"
    add(checks, first("loop"), 2, AGENTS)                    # the paperwork check and the disputed invoice
    add(first("loop"), first("propose"), 2, GRAPH)           # loops cancelling on the graph
    add(first("propose"), first("settled"), 1, BOTH)         # the negotiation: graph and agents together
    add(first("done"), (first("pay") or length_ms / 1000) - 0.5, 2, TOTALS)
    if paid:
        add(first("pay"), paid[-1] + 1.0, 1, BOTH)
        add(paid[-1] + 1.5, length_ms / 1000 - 0.5, 2, TOTALS)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--recording", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    recording = os.path.abspath(os.path.expanduser(args.recording))
    rec_start_ms = float(re.search(r"recording-(\d+)\.mp4$", recording).group(1))
    length_ms = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", recording])) * 1000
    shown = reveal_times(json.load(open(args.state)), rec_start_ms)

    # Start from the settings Recordly itself last saved, when there are any, so no field it expects is missing.
    saved = sorted(glob.glob(os.path.expanduser("~/Library/Application Support/Recordly/recordings/Projects/*.recordly")))
    editor = {**(json.load(open(saved[-1]))["editor"] if saved else {}), **EDITOR}
    editor["clipRegions"] = [{"id": "clip-1", "startMs": 0, "endMs": int(length_ms), "speed": 1}]
    editor["zoomRegions"] = [
        {"id": f"zoom-{n + 1}", "startMs": int(a * 1000), "endMs": int(b * 1000), "depth": depth, "focus": {"cx": focus[0], "cy": focus[1]}, "mode": "manual"}
        for n, (a, b, depth, focus) in enumerate(zooms(shown, length_ms))
    ]
    workdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
    os.makedirs(workdir, exist_ok=True)
    project = os.path.join(workdir, "offset.recordly")
    json.dump({"version": 2, "videoPath": recording, "editor": editor, "projectId": str(uuid.uuid4())}, open(project, "w"), indent=1)
    for z in editor["zoomRegions"]:
        print(f"zoom {z['startMs'] / 1000:6.1f}s to {z['endMs'] / 1000:6.1f}s  depth {z['depth']}  at {z['focus']}")

    out = os.path.abspath(args.out)
    if os.path.exists(out):
        os.remove(out)
    # Recordly's own unattended export mode: it renders the project and writes the file, then is stopped here.
    env = dict(os.environ, RECORDLY_SMOKE_EXPORT="1", RECORDLY_SMOKE_EXPORT_INPUT=recording, RECORDLY_SMOKE_EXPORT_PROJECT=project,
               RECORDLY_SMOKE_EXPORT_OUTPUT=out, RECORDLY_SMOKE_EXPORT_QUALITY="medium", RECORDLY_SMOKE_EXPORT_FPS="30",
               RECORDLY_SMOKE_EXPORT_ENCODING_MODE="balanced")
    proc = subprocess.Popen([RECORDLY], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline, size = time.time() + 1200, -1
    while time.time() < deadline:
        time.sleep(4)
        now = os.path.getsize(out) if os.path.exists(out) else 0
        if now > 0 and now == size:  # the file has stopped growing
            break
        size = now
    proc.terminate()
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        raise SystemExit("Recordly did not write the export.")
    print(out)


if __name__ == "__main__":
    main()

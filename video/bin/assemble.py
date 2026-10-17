"""Cut the captured session into clips, add voice and captions, and encode the final video.

Inputs (from capture.py and cards.py): work/frames, work/frames.json, work/events.json,
work/aN.aiff, work/zoom_log.png, work/cards/*.png.  Output: final/recall-radar-demo.mp4.
"""
import json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cards import caption_png  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "work")
CLIPS = os.path.join(WORK, "clips")
FINAL = os.path.join(ROOT, "final")
os.makedirs(CLIPS, exist_ok=True)
os.makedirs(FINAL, exist_ok=True)
FPS = 30
XF = 0.3          # crossfade seconds
VOICE_GAIN_DB = None


def run(cmd):
    print("+", " ".join(cmd[:6]), "...", flush=True)
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        print(r.stderr[-4000:])
        raise SystemExit(f"command failed: {cmd[0]}")
    return r


def frames_of(sec):
    return int(round(sec * FPS))


ev = json.load(open(os.path.join(WORK, "events.json")))
fr = json.load(open(os.path.join(WORK, "frames.json")))
T0 = fr[0][1]  # session time 0 = first screencast frame


def E(name, idx=None):
    for e in ev:
        if e["name"] == name and (idx is None or e.get("idx") == idx):
            return e
    raise KeyError((name, idx))


def t(name, idx=None):
    return E(name, idx)["t"] - T0


def ans(idx):
    return E("answer", idx)


# ---------- 1. session video from screencast frames ----------
SESSION = os.path.join(WORK, "session.mkv")
if not os.path.exists(SESSION):
    lst = os.path.join(WORK, "frames.txt")
    with open(lst, "w") as fh:
        for i, (n, ts, _) in enumerate(fr):
            nxt = fr[i + 1][1] if i + 1 < len(fr) else ts + 0.5
            fh.write(f"file 'frames/f{n:06d}.jpg'\nduration {max(nxt - ts, 0.001):.6f}\n")
        fh.write(f"file 'frames/f{fr[-1][0]:06d}.jpg'\n")
    run(["ffmpeg", "-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", lst,
         "-vf", "scale=1920:1080:flags=lanczos,fps=30,format=yuv420p",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-g", "30", SESSION])


# ---------- 2. voice loudness ----------
def loudness(path):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"],
                       stderr=subprocess.PIPE, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1])


VOICE_GAIN_DB = -16.0 - loudness(ans(1)["aiff"])
print("voice gain dB", round(VOICE_GAIN_DB, 2))

# Final answer repeats answer 1, so only its first sentence is voiced (same TTS settings).
a_last = ans(8)
first_sentence = re.match(r"(.+?\.)\s", a_last["text"]).group(1)
A8S = os.path.join(WORK, "a8_first.aiff")
run(["say", "-v", "Samantha", "-r", "185", "-o", A8S, first_sentence])
A8S_DUR = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                         "-of", "csv=p=0", A8S]).decode())

# ---------- 3. clip builders ----------
cap_cache = {}


def cap(text):
    if text not in cap_cache:
        cap_cache[text] = caption_png(text, f"cap{len(cap_cache):02d}.png")
    return cap_cache[text]


def build_clip(name, dur, video_src, captions=(), voices=(), fade_in_black=0.0, fade_out_black=0.0):
    """video_src: ("session", start) or ("image", path).  captions: (text, start, end) local.
    voices: (aiff path, local start)."""
    n = frames_of(dur)
    dur = n / FPS
    cmd = ["ffmpeg", "-y", "-hide_banner"]
    if video_src[0] == "session":
        cmd += ["-ss", f"{video_src[1]:.3f}", "-t", f"{dur + 0.5:.3f}", "-i", SESSION]
    else:
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur + 0.5:.3f}", "-i", video_src[1]]
    inputs = 1
    fc = ["[0:v]setpts=PTS-STARTPTS,fps=30,format=yuv420p[v0]"]
    cur = "v0"
    for i, (text, a, b) in enumerate(captions):
        b = min(b, dur)
        d = b - a
        if d <= 0.3:
            continue
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", cap(text)]
        k = inputs
        inputs += 1
        fc.append(f"[{k}:v]format=rgba,fade=in:st=0:d=0.18:alpha=1,fade=out:st={d - 0.18:.3f}:d=0.18:alpha=1,"
                  f"setpts=PTS-STARTPTS+{a:.3f}/TB[c{i}]")
        fc.append(f"[{cur}][c{i}]overlay=0:0:eof_action=pass:format=auto[v{i + 1}c]")
        cur = f"v{i + 1}c"
    vf = [f"[{cur}]format=yuv420p"]
    if fade_in_black:
        vf.append(f"fade=in:st=0:d={fade_in_black}")
    if fade_out_black:
        vf.append(f"fade=out:st={dur - fade_out_black:.3f}:d={fade_out_black}")
    fc.append(",".join(vf) + "[vout]")
    # audio
    fc.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.4f}[sil]")
    amix_in = ["[sil]"]
    for j, (path, st) in enumerate(voices):
        cmd += ["-i", path]
        k = inputs
        inputs += 1
        fc.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0,"
                  f"volume={VOICE_GAIN_DB:.2f}dB,adelay={int(st * 1000)}:all=1[a{j}]")
        amix_in.append(f"[a{j}]")
    if len(amix_in) > 1:
        fc.append("".join(amix_in) + f"amix=inputs={len(amix_in)}:normalize=0:duration=first,atrim=0:{dur:.4f}[aout]")
    else:
        fc.append("[sil]anull[aout]")
    out = os.path.join(CLIPS, name + ".mkv")
    cmd += ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
            "-frames:v", str(n), "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-g", "30",
            "-c:a", "pcm_s16le", "-ar", "48000", out]
    run(cmd)
    return out, dur


clips = []
log = []


def add(name, dur, src, **kw):
    out, d = build_clip(name, dur, src, **kw)
    clips.append((out, d))
    log.append((name, d))


# --- cards
add("01_title", 5.0, ("image", os.path.join(WORK, "cards", "title.png")), fade_in_black=0.6)
add("02_problem", 6.0, ("image", os.path.join(WORK, "cards", "problem.png")))


def live(name, start, end, captions, voice_ids, voice_override=None):
    voices = []
    for i in voice_ids:
        a = ans(i)
        path = a["aiff"]
        if voice_override and i in voice_override:
            path = voice_override[i]
        voices.append((path, a["voice_start"] - T0 - start))
    loc = [(txt, a - start, b - start) for (txt, a, b) in captions]
    add(name, end - start, ("session", start), captions=loc, voices=voices)


PRE = 0.25  # lead-in before typing starts


def vend(i, pad=0.45):
    """Cut point: voice end plus a short pad, never later than the captured hold."""
    a = ans(i)
    return min(t("hold_end", i), a["voice_start"] - T0 + a["voice_dur"] + pad)


# Q1 Honda Accord
s = t("type_start", 1) - 0.5
a1 = ans(1)["t"] - T0
live("03_q1", s, vend(1), [
    ("A typed question goes to the live MCP server.", s + 0.3, a1 - 0.1),
    ("Voice: system text-to-speech, simulating Alexa+", a1 + 0.1, t("scroll_down", 1) + 1.6),
    ("One recall is read in full. The cards show the details.", t("scroll_down", 1) + 1.8, vend(1)),
], [1])

# Q2 "more" + scroll to the MCP log
s = t("type_start", 2) - PRE
live("04_q2_more", s, min(t("zoom_in") - 0.05, t("log_scroll") + 1.6), [
    ('Say "more" to hear the next two.', s + 0.2, vend(2) - 0.1),
], [2])

# MCP log at 1.5x (rendered by the browser at device scale factor 1.5)
add("05_log_zoom", 4.6, ("image", os.path.join(WORK, "zoom_log.png")),
    captions=[("Every answer is a real MCP tools/call over Streamable HTTP", 0.15, 4.6)])

# Q3 IKEA MALM
s = t("top_ready") - 0.05
live("06_q3_malm", s, vend(3), [
    ("Products come from the Consumer Product Safety Commission.", s + 0.3, vend(3)),
], [3])

# Q4 cucumbers
s = t("type_start", 4) - PRE
a4 = ans(4)["t"] - T0
live("07_q4_cucumbers", s, vend(4), [
    ("Food recalls come from FDA enforcement reports.", s + 0.2, a4 + 5.0),
    ('Serious recalls start with the word "Important."', a4 + 5.2, vend(4)),
], [4])

# Q5 UPPAbaby
s = t("type_start", 5) - PRE
live("08_q5_uppababy", s, vend(5), [
    ("Nothing listed? It still never says a product is safe.", s + 0.2, vend(5)),
], [5])

# Q6 ibuprofen
s = t("type_start", 6) - PRE
live("09_q6_ibuprofen", s, vend(6), [
    ("Medicine answers end with a pharmacist reminder.", s + 0.2, vend(6)),
], [6])

# Q7 follow-up question, Q8 "2018" (first sentence voiced, then the cards)
s = t("type_start", 7) - PRE
a8 = ans(8)["t"] - T0
end8 = max(a8 + 0.45 + A8S_DUR + 0.8, t("scroll_down", 8) + 1.1 + 1.6)
live("10_q7_q8_followup", s, end8, [
    ("No model year? It asks one short follow-up question.", s + 0.2, t("type_start", 8) + 0.6),
    ("Then it checks NHTSA for the 2018 model.", t("type_start", 8) + 0.8, end8),
], [7, 8], voice_override={8: A8S})

add("11_arch", 8.0, ("image", os.path.join(WORK, "cards", "arch.png")))
add("12_end", 5.0, ("image", os.path.join(WORK, "cards", "end.png")), fade_out_black=0.8)

# ---------- 4. final chain with 300 ms crossfades ----------
cmd = ["ffmpeg", "-y", "-hide_banner"]
for p, _ in clips:
    cmd += ["-i", p]
fc = []
vcur, acur = "[0:v]", "[0:a]"
acc = clips[0][1]
timeline = [(log[0][0], 0.0, clips[0][1])]
for k in range(1, len(clips)):
    off = acc - XF
    fc.append(f"{vcur}[{k}:v]xfade=transition=fade:duration={XF}:offset={off:.4f}[vx{k}]")
    fc.append(f"{acur}[{k}:a]acrossfade=d={XF}:c1=tri:c2=tri[ax{k}]")
    vcur, acur = f"[vx{k}]", f"[ax{k}]"
    timeline.append((log[k][0], off, off + clips[k][1]))
    acc = off + clips[k][1]
fc.append(f"{vcur}format=yuv420p[vout]")
fc.append(f"{acur}alimiter=limit=0.891:level=false[aout]")
OUT = os.path.join(FINAL, "recall-radar-demo.mp4")
cmd += ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
        "-r", "30", "-g", "60", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", OUT]
run(cmd)
with open(os.path.join(WORK, "timeline.json"), "w") as fh:
    json.dump(timeline, fh, indent=1)
for name, a, b in timeline:
    print(f"{name:22s} {a:7.2f} -> {b:7.2f}  ({b - a:5.2f}s)")
print("expected total", round(acc, 2))

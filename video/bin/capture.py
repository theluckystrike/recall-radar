"""Record the live Recall Radar simulator with the CDP screencast.

Writes work/frames/*.jpg, work/frames.json (frame timestamps), work/events.json
(answer times, voice files, scroll and zoom marks) and work/aN.aiff (voice).
Uses the existing agent Chrome on CDP port 9341; opens and closes only its own context.
"""
import asyncio, base64, json, os, re, shutil, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "work")
FRAMES = os.path.join(WORK, "frames")
URL = "https://recall-radar.lipmichal.workers.dev/"

frames = []          # (index, metadata timestamp, recv wall time)
events = []          # dicts with "name", "t" (wall time)


def mark(name, **kw):
    e = {"name": name, "t": time.time()}
    e.update(kw)
    events.append(e)
    print(f"{e['t']:.3f} {name} {kw if kw else ''}", flush=True)


async def say_to_file(text, path):
    proc = await asyncio.create_subprocess_exec("say", "-v", "Samantha", "-r", "185", "-o", path, text)
    rc = await proc.wait()
    if rc != 0:
        raise RuntimeError("say failed")
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
        stdout=asyncio.subprocess.PIPE)
    out, _ = await proc.communicate()
    return float(out.decode().strip())


SCROLL_JS = """
async ([target, ms]) => {
  const start = window.scrollY, delta = target - start, t0 = performance.now();
  const ease = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;
  await new Promise(res => {
    function step(now) {
      const p = Math.min(1, (now - t0) / ms);
      window.scrollTo(0, start + delta * ease(p));
      if (p < 1) requestAnimationFrame(step); else res();
    }
    requestAnimationFrame(step);
  });
  return window.scrollY;
}
"""


async def smooth_scroll(page, target, ms):
    return await page.evaluate(SCROLL_JS, [target, ms])


async def ask(page, text, idx, scroll_cards=True):
    old = (await page.inner_text("#transcript")).strip()
    await page.focus("#textInput")
    mark("type_start", q=text, idx=idx)
    await page.type("#textInput", text, delay=45)
    await page.wait_for_timeout(350)
    mark("enter", q=text, idx=idx)
    await page.press("#textInput", "Enter")
    await page.wait_for_function(
        "(o) => { const t = document.querySelector('#transcript').innerText.trim(); return t.length > 0 && t !== o; }",
        arg=old, polling=40, timeout=25000)
    t_ans = time.time()
    await page.wait_for_timeout(60)
    answer = (await page.inner_text("#transcript")).strip()
    ncards = await page.evaluate("document.querySelectorAll('#results .card, #results article, #results > *').length")
    aiff = os.path.join(WORK, f"a{idx}.aiff")
    dur = await say_to_file(answer, aiff)
    voice_start = t_ans + 0.45
    events.append({"name": "answer", "t": t_ans, "idx": idx, "q": text, "text": answer,
                   "cards": ncards, "aiff": aiff, "voice_start": voice_start, "voice_dur": dur})
    print(f"{t_ans:.3f} answer idx={idx} cards={ncards} dur={dur:.2f}\n   {answer}", flush=True)
    scrolled = False
    if scroll_cards and ncards > 0:
        await asyncio.sleep(max(0, t_ans + 2.4 - time.time()))
        top = await page.evaluate("document.querySelector('#transcript').getBoundingClientRect().top + window.scrollY")
        mark("scroll_down", idx=idx)
        await smooth_scroll(page, int(top - 14), 1100)
        scrolled = True
    end = voice_start + dur + 0.7
    await asyncio.sleep(max(0, end - time.time()))
    after = (await page.inner_text("#transcript")).strip()
    mark("hold_end", idx=idx, same_text=(after == answer))
    if scrolled:
        await smooth_scroll(page, 0, 800)
        await page.wait_for_timeout(350)
    return answer


async def main():
    if os.path.isdir(FRAMES):
        shutil.rmtree(FRAMES)
    os.makedirs(FRAMES)
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9341")
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page = await ctx.new_page()
        try:
            await page.goto(URL, wait_until="networkidle")
            # Hide the scrollbar only (cosmetic); no content is changed.
            await page.add_style_tag(content="html::-webkit-scrollbar{display:none} html{scrollbar-width:none}")
            await page.evaluate("document.fonts.ready")
            await page.wait_for_timeout(800)
            cdp = await ctx.new_cdp_session(page)

            def on_frame(params):
                n = len(frames)
                path = os.path.join(FRAMES, f"f{n:06d}.jpg")
                with open(path, "wb") as fh:
                    fh.write(base64.b64decode(params["data"]))
                frames.append((n, params["metadata"].get("timestamp"), time.time()))
                asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]}))

            cdp.on("Page.screencastFrame", on_frame)
            await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 90,
                                                    "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
            mark("rec_start")
            await page.wait_for_timeout(1800)

            await ask(page, "Is my 2018 Honda Accord recalled?", 1)
            await ask(page, "more", 2)
            # MCP log: scroll to it, then re-render at 1.5x (1280x720 CSS px at DPR 1.5 = 1920x1080).
            async def log_center(vh):
                r = await page.evaluate("(() => { const b = document.querySelector('#logPanel').getBoundingClientRect(); return [b.top + window.scrollY, b.height]; })()")
                return int(r[0] + r[1] / 2 - vh / 2)
            mark("log_scroll")
            await smooth_scroll(page, max(0, await log_center(1080)), 1000)
            await page.wait_for_timeout(1400)
            mark("zoom_in")
            await cdp.send("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 720, "deviceScaleFactor": 1.5, "mobile": False})
            await page.wait_for_timeout(250)
            await page.evaluate("y => window.scrollTo(0, y)", await log_center(720))
            await page.wait_for_timeout(500)
            mark("zoom_ready")
            shot = await cdp.send("Page.captureScreenshot", {"format": "png"})
            with open(os.path.join(WORK, "zoom_log.png"), "wb") as fh:
                fh.write(base64.b64decode(shot["data"]))
            await page.wait_for_timeout(1500)
            mark("zoom_out")
            await cdp.send("Emulation.setDeviceMetricsOverride", {"width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": False})
            await page.wait_for_timeout(200)
            await page.evaluate("window.scrollTo(0, 0)")
            await page.wait_for_timeout(700)
            mark("top_ready")
            await page.wait_for_timeout(300)

            await ask(page, "Is the IKEA MALM dresser recalled?", 3)
            await ask(page, "Any recalls on cucumbers?", 4)
            await ask(page, "Is the UPPAbaby high chair still safe?", 5)
            await ask(page, "Was my ibuprofen recalled?", 6)

            await ask(page, "Is my honda accord recalled?", 7)
            await ask(page, "2018", 8)
            mark("rec_end")
            await page.wait_for_timeout(300)
            await cdp.send("Page.stopScreencast")
            await page.wait_for_timeout(300)
        finally:
            await ctx.close()   # only our context; the shared browser stays up
    with open(os.path.join(WORK, "frames.json"), "w") as fh:
        json.dump(frames, fh)
    with open(os.path.join(WORK, "events.json"), "w") as fh:
        json.dump(events, fh, indent=1)
    print("frames:", len(frames))


asyncio.run(main())

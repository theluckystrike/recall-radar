"""UI QA for the Alexa+ simulator: real browser, real server, real government data. Usage: python3 test/qa_ui.py <base> <outdir>"""
import sys, time
from playwright.sync_api import sync_playwright

base, out = sys.argv[1], sys.argv[2]
utterances = ["is my 2018 honda accord recalled", "any recalls on peanut butter", "is the graco pack and play recalled"]
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9341")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "/", wait_until="networkidle")
    page.screenshot(path=f"{out}/01-idle-1280.png")
    for i, u in enumerate(utterances, 2):
        page.fill("#textInput", u)
        page.press("#textInput", "Enter")
        t = time.time()
        page.wait_for_function("document.querySelector('#results') && document.querySelector('#results').innerText.length > 40", timeout=15000)
        page.wait_for_timeout(800)
        print(f"{u!r}: rendered in {time.time()-t:.1f}s; log entries={page.locator('#logEntries > *').count()}")
        page.screenshot(path=f"{out}/{i:02d}-answer-1280.png", full_page=True)
    print("transcript:", page.inner_text("#transcript")[:300].replace("\n", " | "))
    print("log:", page.inner_text("#logEntries")[:400].replace("\n", " | "))
    m = ctx.new_page(); m.set_viewport_size({"width": 390, "height": 844})
    m.goto(base + "/", wait_until="networkidle")
    m.fill("#textInput", "was my ibuprofen recalled"); m.press("#textInput", "Enter")
    m.wait_for_function("document.querySelector('#results').innerText.length > 40", timeout=15000); m.wait_for_timeout(800)
    m.screenshot(path=f"{out}/10-mobile-390.png", full_page=True)
    overflow = m.evaluate("document.documentElement.scrollWidth > window.innerWidth")
    print("mobile horizontal overflow:", overflow)
    print("console errors:", errors[:5])
    ctx.close()

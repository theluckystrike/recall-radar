"""Multi-turn simulator QA: ask without a year, answer the year, then 'more', then a product query. Real browser, real data."""
import sys
from playwright.sync_api import sync_playwright
base, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("http://127.0.0.1:9341")
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    page = ctx.new_page(); errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base + "/", wait_until="networkidle")
    def turn(text, shot=None):
        before = page.inner_text("#transcript")
        page.fill("#textInput", text); page.press("#textInput", "Enter")
        page.wait_for_function("(b) => document.querySelector('#transcript').innerText !== b && document.querySelector('#transcript').innerText.length > 10", arg=before, timeout=15000)
        page.wait_for_timeout(700)
        print(f"> {text}\n  {page.inner_text('#transcript')}")
        if shot: page.screenshot(path=f"{out}/{shot}", full_page=True)
    turn("is my honda accord recalled")
    turn("2018", "20-vehicle-after-year.png")
    turn("more")
    turn("more")
    turn("is the ikea malm dresser recalled", "21-ikea.png")
    turn("any recalls on cucumbers", "22-cucumbers.png")
    turn("is my honda accord recalled")
    turn("2018 toyota camry", "23-camry-after-pending.png")
    turn("any recalls on zzqx eye drops")
    turn("more")
    turn("is zyrtec safe to take")
    turn("is the uppababy high chair still safe", "24-uppababy.png")
    print("MCP log entries:", page.locator("#logEntries > *").count(), "| errors:", errs[:3])
    ctx.close()

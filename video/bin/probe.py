import asyncio, sys
from playwright.async_api import async_playwright
URL="https://recall-radar.lipmichal.workers.dev/"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.connect_over_cdp("http://127.0.0.1:9341")
        ctx = await b.new_context(viewport={"width":1920,"height":1080}, device_scale_factor=1)
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.screenshot(path="work/probe0.png")
        old = await page.inner_text("#transcript")
        await page.type("#textInput", "Is my 2018 Honda Accord recalled?", delay=10)
        await page.press("#textInput", "Enter")
        await page.wait_for_function("(o)=>{const t=document.querySelector('#transcript').innerText.trim();return t && t!==o && document.querySelectorAll('#results > *').length>0}", arg=old, timeout=20000)
        await page.wait_for_timeout(800)
        await page.screenshot(path="work/probe1.png")
        await page.screenshot(path="work/probe1full.png", full_page=True)
        print(await page.inner_text("#transcript"))
        print(await page.evaluate("document.documentElement.scrollHeight"))
        for sel in ["#transcript","#results","#logPanel","#inputForm","#chips"]:
            print(sel, await page.evaluate(f"JSON.stringify(document.querySelector('{sel}').getBoundingClientRect())"))
        await ctx.close()
asyncio.run(main())

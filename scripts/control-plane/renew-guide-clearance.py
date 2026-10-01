"""Issue a fresh guide clearance in a real Chromium session on the worker's network."""

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import cv2
import nodriver


GUIDE_URL = "https://guide.fallensword.com/index.php?cmd=items&index=0"
GUIDE_LINK = re.compile(r'<a\b[^>]*href=["\'][^"\']*index\.php\?cmd=', re.I)
CLEARANCE = re.compile(r"^[A-Za-z0-9._-]{1,4096}$")
PROXY = re.compile(r"^socks5://127\.0\.0\.1:\d{1,5}$")
LABELS = ("Verify you are human", "Confirme que \u00e9 humano")
CHECKBOX_TEMPLATE = Path(__file__).with_name("guide-checkbox-template.png")


async def guide_is_loaded(tab):
    return bool(GUIDE_LINK.search(await tab.get_content()))


async def wait_for_guide(tab, seconds):
    for _ in range(seconds // 2):
        if await guide_is_loaded(tab):
            return True
        await asyncio.sleep(2)
    return await guide_is_loaded(tab)


async def find_verification_label(tab):
    for label in LABELS:
        element = await tab.find(label, timeout=10 if label == LABELS[0] else 3)
        if element:
            return element
    return None


async def click_verification(tab, profile_directory):
    screenshot_path = profile_directory / "challenge.png"
    await tab.save_screenshot(str(screenshot_path))
    screenshot = cv2.imread(str(screenshot_path), cv2.IMREAD_GRAYSCALE)
    checkbox_template = cv2.imread(str(CHECKBOX_TEMPLATE), cv2.IMREAD_GRAYSCALE)
    if screenshot is None or checkbox_template is None:
        raise FileNotFoundError("Guide challenge image is unavailable")
    matches = cv2.matchTemplate(screenshot, checkbox_template, cv2.TM_CCOEFF_NORMED)
    _, score, _, position = cv2.minMaxLoc(matches)
    if score >= 0.75:
        checkbox_x = position[0] + checkbox_template.shape[1] // 2
        checkbox_y = position[1] + checkbox_template.shape[0] // 2
        await tab.mouse_click(checkbox_x, checkbox_y)
        return

    label = await find_verification_label(tab)
    if not label:
        raise TimeoutError("Guide verification checkbox did not appear")
    await label.mouse_click()


async def renew():
    browser_path = os.environ.get("GG_GUIDE_CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
    if not browser_path:
        raise FileNotFoundError("Chromium is unavailable")

    browser_args = ["--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
                    "--disable-dev-shm-usage"]
    proxy = os.environ.get("GG_GUIDE_BROWSER_PROXY")
    if proxy:
        if not PROXY.fullmatch(proxy):
            raise ValueError("GG_GUIDE_BROWSER_PROXY must be a local SOCKS5 endpoint")
        browser_args.append(f"--proxy-server={proxy}")
    if os.environ.get("GG_GUIDE_BROWSER_OFFSCREEN") == "1":
        browser_args.append("--window-position=-32000,-32000")

    profile_directory = Path(tempfile.mkdtemp(prefix="gogon-guide-clearance-"))
    browser = None
    try:
        browser = await nodriver.start(
            browser_executable_path=browser_path,
            user_data_dir=profile_directory,
            browser_args=browser_args,
            headless=False,
            expert=False,
            sandbox=False if os.name == "posix" else True,
        )
        tab = await browser.get(GUIDE_URL)
        if not await wait_for_guide(tab, 8):
            for _ in range(2):
                await click_verification(tab, profile_directory)
                if await wait_for_guide(tab, 35):
                    break
            else:
                raise TimeoutError("Guide verification did not reach guide content")

        cookies = await browser.cookies.get_all()
        clearance = next((cookie.value for cookie in cookies if cookie.name == "cf_clearance"
                          and cookie.domain.lstrip(".") in ("fallensword.com", "guide.fallensword.com")), None)
        user_agent = await tab.evaluate("navigator.userAgent")
        if not clearance or not CLEARANCE.fullmatch(clearance):
            raise ValueError("Guide verification produced no usable clearance")
        if not isinstance(user_agent, str) or not 1 <= len(user_agent) <= 300 \
                or any(ord(character) < 32 or ord(character) == 127 for character in user_agent):
            raise ValueError("Guide browser produced an invalid user agent")
        print(json.dumps({"clearance": clearance, "userAgent": user_agent}), flush=True)
    finally:
        if browser is not None:
            browser.stop()
        await asyncio.sleep(1)
        for attempt in range(5):
            try:
                shutil.rmtree(profile_directory)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                await asyncio.sleep(1)


if __name__ == "__main__":
    nodriver.loop().run_until_complete(asyncio.wait_for(renew(), timeout=90))

"""Verify Chromium starts under Xvfb in the production container without network access."""

import asyncio
import shutil
import tempfile
from pathlib import Path

import cv2
import nodriver


async def main():
    if cv2.imread(str(Path(__file__).with_name("guide-checkbox-template.png"))) is None:
        raise FileNotFoundError("Guide checkbox template is unavailable")
    with tempfile.TemporaryDirectory(prefix="gogon-guide-smoke-") as profile_directory:
        browser = await nodriver.start(
            browser_executable_path=shutil.which("chromium"),
            user_data_dir=profile_directory,
            headless=False,
            sandbox=False,
            browser_args=["--disable-dev-shm-usage", "--no-first-run"],
        )
        try:
            tab = await browser.get("data:text/html,<title>guide-browser-ready</title>")
            if "guide-browser-ready" not in await tab.get_content():
                raise RuntimeError("Chromium did not load its smoke page")
        finally:
            browser.stop()
            await asyncio.sleep(1)


if __name__ == "__main__":
    nodriver.loop().run_until_complete(main())

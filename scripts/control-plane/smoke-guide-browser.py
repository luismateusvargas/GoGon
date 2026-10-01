"""Verify Chromium starts under Xvfb in the production container without network access."""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import nodriver
from nodriver.core import util


async def main():
    if cv2.imread(str(Path(__file__).with_name("guide-checkbox-template.png"))) is None:
        raise FileNotFoundError("Guide checkbox template is unavailable")
    with tempfile.TemporaryDirectory(prefix="gogon-guide-smoke-") as profile_directory:
        try:
            browser = await nodriver.start(
                browser_executable_path=shutil.which("chromium"),
                user_data_dir=profile_directory,
                headless=False,
                sandbox=False,
                browser_args=["--disable-dev-shm-usage", "--no-first-run"],
            )
        except Exception:
            for instance in util.get_registered_instances():
                process = instance._process
                if process and process.stderr:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                    message = (await process.stderr.read()).decode("utf-8", errors="replace")
                    print(message[-4000:], file=sys.stderr)
            raise
        try:
            tab = await browser.get("data:text/html,<title>guide-browser-ready</title>")
            if "guide-browser-ready" not in await tab.get_content():
                raise RuntimeError("Chromium did not load its smoke page")
        finally:
            browser.stop()
            await asyncio.sleep(1)


if __name__ == "__main__":
    nodriver.loop().run_until_complete(main())

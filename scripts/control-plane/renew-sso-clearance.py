"""Clear a HuntedCow SSO challenge in the worker's Chromium, returning short-lived cookies."""

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import nodriver
from challenge_browser import click_verification
from guide_browser_environment import prepare_browser_environment


CLEARANCE = re.compile(r"^[A-Za-z0-9._-]{1,4096}$")
PROXY = re.compile(r"^socks5://127\.0\.0\.1:\d{1,5}$")
ACCOUNT_PAGE = re.compile(r'<form\b[^>]*id=["\']m-login-form["\']', re.I)
COOKIE_NAMES = {"cf_clearance", "hcs_session_key"}
COOKIE_DOMAINS = {"huntedcow.com", ".huntedcow.com", "account.huntedcow.com"}


async def account_is_loaded(tab) -> bool:
    """Return whether the browser has reached the HuntedCow account form."""
    return bool(ACCOUNT_PAGE.search(await tab.get_content()))


async def wait_for_account(tab, seconds: int) -> bool:
    """Wait for an account page without treating the challenge page as success."""
    for _ in range(seconds // 2):
        if await account_is_loaded(tab):
            return True
        await asyncio.sleep(2)
    return await account_is_loaded(tab)


async def renew(entry_url: str) -> None:
    """Run verification, outputting only validated HuntedCow cookies and browser User-Agent."""
    parsed = urlparse(entry_url)
    if parsed.scheme != "https" or parsed.hostname not in ("huntedcow.com", "account.huntedcow.com") \
            or parsed.path != "/auth":
        raise ValueError("Invalid HuntedCow SSO entry URL")

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

    profile_directory = Path(tempfile.mkdtemp(prefix="gogon-sso-clearance-"))
    prepare_browser_environment(profile_directory)
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
        tab = await browser.get(entry_url)
        if not await wait_for_account(tab, 8):
            for _ in range(2):
                await click_verification(tab, profile_directory)
                if await wait_for_account(tab, 35):
                    break
            else:
                raise TimeoutError("HuntedCow verification did not reach the account form")

        cookies = await browser.cookies.get_all()
        selected = [{"name": cookie.name, "value": cookie.value, "domain": cookie.domain,
                     "path": cookie.path or "/", "secure": bool(cookie.secure)}
                    for cookie in cookies if cookie.name in COOKIE_NAMES and cookie.domain in COOKIE_DOMAINS]
        if not any(cookie["name"] == "cf_clearance" for cookie in selected) \
                or any(not CLEARANCE.fullmatch(cookie["value"]) for cookie in selected):
            raise ValueError("HuntedCow verification produced no usable clearance")
        user_agent = await tab.evaluate("navigator.userAgent")
        if not isinstance(user_agent, str) or not 1 <= len(user_agent) <= 300 \
                or any(ord(character) < 32 or ord(character) == 127 for character in user_agent):
            raise ValueError("HuntedCow browser produced an invalid user agent")
        print(json.dumps({"cookies": selected, "userAgent": user_agent}), flush=True)
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
    nodriver.loop().run_until_complete(asyncio.wait_for(renew(sys.argv[1]), timeout=90))

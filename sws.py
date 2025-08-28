"""Headless Firefox automation for Fallen Sword.

Logs into the Fallen Sword website using credentials stored in the
``FS_EMAIL`` and ``FS_PASSWORD`` environment variables, then keeps the

session alive. Every hour it refreshes the home page and, if the session has
expired (the game logs accounts out roughly every seven days), it re‑logs in
and reinjects the optional notification script.

If the ``GECKODRIVER_PATH`` environment variable is set, it will be used to
locate the ``geckodriver`` binary. This is helpful on systems where the driver
is not on ``PATH`` such as a fresh Windows installation.

The script exits with a clear error if ``geckodriver`` cannot be launched or if
``newsFeatures.js`` is not UTF-8 encoded. The CSS selectors used in ``login``
may require updating if the site changes.
"""

import logging
import os
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.service import Service


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)


LOGIN_URL = "https://account.huntedcow.com/auth?game=6"
HOME_URL = "https://www.fallensword.com/"
SCRIPT_PATH = Path("newsFeatures.js")

EMAIL = os.environ.get("FS_EMAIL")
PASSWORD = os.environ.get("FS_PASSWORD")
GECKODRIVER_PATH = os.environ.get("GECKODRIVER_PATH")


def login(driver: webdriver.Firefox) -> None:
    """Log in to the game."""
    logger.info("Navigating to login page: %s", LOGIN_URL)
    driver.get(LOGIN_URL)
    logger.info("Filling login form")
    driver.find_element(By.ID, "email").send_keys(EMAIL)
    driver.find_element(By.ID, "password").send_keys(PASSWORD)
    logger.info("Submitting login form")
    driver.find_element(By.ID, "auth-submit").click()
    if "Account Login" in driver.title:
        logger.warning("Login may have failed; still on login page")
    else:
        logger.info(
            "Login successful; page title: %s, url: %s", driver.title, driver.current_url
        )


SCRIPT_DEPENDENCIES = [Path("webhooks.js"), Path("utils.js"), SCRIPT_PATH]


def _read_script(path: Path) -> str:
    """Read a script file, removing import/export statements."""
    logger.debug("Reading script %s", path)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:  # pragma: no cover - unlikely
        raise SystemExit(
            f"Failed to read {path} as UTF-8: {exc}. Ensure the file is UTF-8 encoded."
        ) from exc

    cleaned: list[str] = []
    in_import = False
    for line in text.splitlines():
        stripped = line.lstrip()
        if in_import:
            if ";" in line:
                in_import = False
            continue
        if stripped.startswith("import"):
            in_import = ";" not in line
            continue
        if stripped.startswith("export "):
            line = line.replace("export ", "", 1)
        cleaned.append(line)
    return "\n".join(cleaned)


def inject_script(driver: webdriver.Firefox) -> None:
    """Inject the local notification script into the current page."""
    if not SCRIPT_PATH.exists():
        logger.info("Notification script %s not found; skipping", SCRIPT_PATH)
        return

    logger.info("Injecting notification script into page")
    source = "\n".join(_read_script(p) for p in SCRIPT_DEPENDENCIES if p.exists())
    driver.execute_script(source)
    # kick off the notification loop if available
    logger.info("Attempting to invoke initNews in browser")
    driver.execute_script(
        """
        if (typeof window.initNews === 'function') {
            console.log('sws.py: initNews invoked');
            window.initNews();
        } else {
            console.warn('sws.py: initNews not found');
        }
        """
    )


def keep_alive(driver: webdriver.Firefox) -> None:
    """Periodically refresh the page and re-log when needed."""
    logger.info("Entering keep-alive loop")
    inject_script(driver)
    while True:
        logger.info("Sleeping for one hour")
        time.sleep(3600)
        logger.info("Refreshing home page: %s", HOME_URL)
        driver.get(HOME_URL)
        if "Account Login" in driver.title:
            logger.info("Session expired; re-logging in")
            login(driver)
            inject_script(driver)
        else:
            logger.info("Session active; page title: %s", driver.title)


def main() -> None:
    logger.info("Starting headless Firefox script in %s", Path.cwd())
    options = Options()
    options.add_argument("-headless")
    service = Service(GECKODRIVER_PATH) if GECKODRIVER_PATH else Service()
    logger.info("Using geckodriver from %s", GECKODRIVER_PATH or "PATH")
    try:
        with webdriver.Firefox(service=service, options=options) as driver:
            logger.info("Firefox launched")
            login(driver)
            keep_alive(driver)
    except OSError as exc:
        path = GECKODRIVER_PATH or "PATH"
        raise SystemExit(
            f"Failed to launch geckodriver from {path}: {exc}. "
            "Ensure the driver matches your OS architecture."
        ) from exc
    finally:
        logger.info("Firefox session ended")


if __name__ == "__main__":
    if not EMAIL or not PASSWORD:
        raise SystemExit("FS_EMAIL and FS_PASSWORD must be set")
    main()

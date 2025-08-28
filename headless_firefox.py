"""Headless Firefox automation for Fallen Sword.

Logs into the Fallen Sword website using credentials stored in the
``FS_EMAIL`` and ``FS_PASSWORD`` environment variables, then keeps the
session alive. Every hour it refreshes the home page and, if the session has
expired (the game logs accounts out roughly every seven days), it re‑logs in
and reinjects the optional notification script.

The CSS selectors used in ``login`` may require updating if the site changes.
"""

import os
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By

LOGIN_URL = "https://account.huntedcow.com/auth?game=6"
HOME_URL = "https://www.fallensword.com/"
SCRIPT_PATH = Path("newsFeatures.js")

EMAIL = os.environ.get("FS_EMAIL")
PASSWORD = os.environ.get("FS_PASSWORD")


def login(driver: webdriver.Firefox) -> None:
    """Log in to the game."""
    driver.get(LOGIN_URL)
    driver.find_element(By.ID, "email").send_keys(EMAIL)
    driver.find_element(By.ID, "password").send_keys(PASSWORD)
    driver.find_element(By.ID, "auth-submit").click()


def inject_script(driver: webdriver.Firefox) -> None:
    """Inject the local notification script into the current page."""
    if SCRIPT_PATH.exists():
        driver.execute_script(SCRIPT_PATH.read_text())


def keep_alive(driver: webdriver.Firefox) -> None:
    """Periodically refresh the page and re-log when needed."""
    inject_script(driver)
    while True:
        time.sleep(3600)
        driver.get(HOME_URL)
        if "Account Login" in driver.title:
            login(driver)
            inject_script(driver)


def main() -> None:
    options = Options()
    options.add_argument("-headless")
    with webdriver.Firefox(options=options) as driver:
        login(driver)
        keep_alive(driver)


if __name__ == "__main__":
    if not EMAIL or not PASSWORD:
        raise SystemExit("FS_EMAIL and FS_PASSWORD must be set")
    main()

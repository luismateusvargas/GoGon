"""Give a short-lived Chromium process writable XDG paths inside its temporary profile."""

import os
from pathlib import Path


def prepare_browser_environment(profile_directory):
    profile = Path(profile_directory)
    for setting, directory_name in (
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_RUNTIME_DIR", "runtime"),
    ):
        directory = profile / directory_name
        directory.mkdir(mode=0o700)
        os.environ[setting] = str(directory)

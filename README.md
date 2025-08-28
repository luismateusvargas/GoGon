This is a notification script that runs in fallensword to send push notifications to discord.

Currently contains
 - Bounty board
 - Crates/Chests
 - Super Elite kills
 - Titan Spawns
 - Guild Relics Taken or Lost
 - Game news
 - Shoutbox in the news page
 - Ladder reset timer
 - Last Ladder ranking
 - Guild Conflict warnings (conflict started, conflict incoming attacks change)

This script does not contain any invasive feature and only notifies about the same thing players could do, just faster.

## Running `headless_firefox.py` on Windows 10

1. Install [Python 3](https://www.python.org/downloads/windows/) and ensure
   `python` is available in your `PATH`.
2. Install the [Firefox browser](https://www.mozilla.org/firefox/new/).
3. Download the Windows release of
   [`geckodriver`](https://github.com/mozilla/geckodriver/releases), extract
   `geckodriver.exe` and either place it in your `PATH` or set the
   `GECKODRIVER_PATH` environment variable to its full location.
4. Install the Python dependency:

   ```cmd
   pip install selenium
   ```

5. Set the `FS_EMAIL` and `FS_PASSWORD` environment variables with your Fallen
   Sword credentials. These can be set in the same Command Prompt session before
   running the script or through the System Properties interface.
6. From a Command Prompt in this repository's directory, run:

   ```cmd
   python headless_firefox.py
   ```

   The script will open a headless Firefox instance, log in to the game and
   refresh the session hourly.

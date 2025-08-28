// ==UserScript==
// @name         News
// @version      6.1.6
// @author       Zucomate
// @description  but I'm not done yet!
// @match        https://www.fallensword.com/index.php?cmd=points&subcmd=redeem
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      https://www.fallensword.com
// @connect      https://discord.com
// @connect      https://raw.githubusercontent.com
// ==/UserScript==

(async function () {
  'use strict';
  const scriptUrl =
    'https://raw.githubusercontent.com/Zucomate/fallenswordstuff/main/newsFeatures.js';
  const response = await fetch(scriptUrl);
  const scriptText = await response.text();
  const moduleUrl = URL.createObjectURL(
    new Blob([scriptText], { type: 'text/javascript' })
  );
  try {
    const { initNews } = await import(moduleUrl);
    initNews();
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
})();

# Catalog-sync fixtures (CAT-TASK-001)

Every guide HTML file here is **synthetic**. It was written from the selectors the supplied userscripts
in `reconciliation/scrappers/` rely on (`.tHeader b`, `td.tHeader[colspan="10"]`, `a[href*="item_id="]`,
`.creatureImg img`, `img[src*="stairways"]` and similar), not captured from guide.fallensword.com.
If a live page stops matching these shapes, capture a redacted page, add it here, and fix
`catalog/guideParsers.js` against it.

`cloudflare-challenge.html`, `game-login.html`, and `game-logged-out.json` use the published
Cloudflare interstitial markers, the game login signature `utils.js` already checks
(`id="hc-account-link"`), and the `{"s":false,"e":{...}}` envelope `secureFetch` treats as logged out.

No `fetchLocation` (game current-location) fixture exists: that response has never been captured,
so `catalog/contracts/gameLocation.js` stays unverified and observe_realm is refused (owner decision
2026-09-28). A captured fixture must strip player names, IDs, coordinates, and any account data.

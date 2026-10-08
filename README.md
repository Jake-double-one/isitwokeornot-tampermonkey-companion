# isitwokeornot-tampermonkey-companion

A [Tampermonkey](https://www.tampermonkey.net/) userscript that connects [isitwokeornot.com](https://isitwokeornot.com/) with your own **Seerr** ([Overseerr](https://overseerr.dev/)/[Jellyseerr](https://github.com/Fallenbagel/jellyseerr)), **Radarr**, and **Sonarr** instances — in both directions:

- **On isitwokeornot.com:** buttons to open or request the movie/show you're looking at directly in your Seerr/Radarr/Sonarr instance, without leaving the page.
- **On your Seerr instance:** a "Woke Score" row on the title page, showing the matching isitwokeornot.com score with a link straight to the full review.

Both sides share a single configuration.

## Features

### On isitwokeornot.com

- 🍿 **Open in Seerr** — deep-links to the title in your Seerr instance (falls back to a text search if no TMDB id is found).
- 🎬 **Search in Radarr** / 📺 **Search in Sonarr** — opens the "Add new" page pre-filled with the title.
- ⚡ **Request in Seerr now** — with a Seerr API key configured, request the title with a single click, right from isitwokeornot.com. The button first checks whether it's already available or requested, so you don't send duplicate requests.
- Hover buttons on grid/overview pages (home, search, "newly reviewed", people) and larger action buttons on the title detail page.
- Works with isitwokeornot.com's client-side (Next.js) navigation, so buttons stay in sync as you browse without full page reloads.

### On your Seerr instance

- Adds a **Woke Score** row next to the other ratings (TMDB, IMDb, Rotten Tomatoes, …) on a title's page, showing the isitwokeornot.com score and linking to the matching review.
- Looks the title up on isitwokeornot.com using its original title first (falling back to Seerr's display title), and cross-checks the IMDb id when available, so localized/translated titles in Seerr still resolve to the correct review instead of a false match.
- Colour-coded using WokeOrNot's own 5-tier scale, matching their site: 0–19% Not woke (green), 20–39% Slightly woke (lime), 40–59% Woke (amber), 60–79% Very woke (orange), 80–100% Super woke (rose).
- Results (including "no match found") are cached per title for 7 days, so revisiting or browsing back to a title doesn't re-query isitwokeornot.com every time. A page reload (F5/Ctrl+F5/Cmd+R) always fetches a fresh result for the title shown right after the reload — see [Woke Score caching](#woke-score-caching) below.
- Clicking the row's link to open the review on isitwokeornot.com adds UTM tracking parameters — see [UTM parameters on the Woke Score link](#utm-parameters-on-the-woke-score-link) below.

### Shared

- A settings dialog (gear icon, bottom-right, or via the Tampermonkey menu) to configure your instance URLs and API key — nothing is sent anywhere except the services you configure.
- Every feature can be toggled independently in the settings dialog.

## Installation

1. Install a userscript manager, e.g. [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`wokeornot-seerr-buttons.user.js`](./wokeornot-seerr-buttons.user.js) in this repository and click **Raw** — your userscript manager should pick it up and offer to install it. Alternatively, copy the file's contents into a new userscript.
3. Visit [isitwokeornot.com](https://isitwokeornot.com/) and click the ⚙️ button in the bottom-right corner (or use the Tampermonkey menu) to configure your Seerr/Radarr/Sonarr URLs.
4. **Optional, for the Seerr-side Woke Score row only:** in the Tampermonkey dashboard, go to **"Installierte Userscripts"** and click on this script to open **its own page** — **not** the dashboard's global **"Einstellungen"** tab in the main toolbar (that one only has update-check/general options; it has no match fields and isn't specific to this script at all). On this script's own page, find **"User matches"** and add your own Seerr URL there, e.g. `https://seerr.my-domain.com/*`. Do this through "User matches", **not** by editing the `@match` line in the script's source — see [Why does the Seerr row need an extra match, and why here?](#why-does-the-seerr-row-need-an-extra-match-and-why-here) below for why, and for the equivalent step in other userscript managers. Without this step, everything on isitwokeornot.com still works — only the Woke Score row inside Seerr needs it.

## Configuration

Open the settings dialog (⚙️ button, or the Tampermonkey menu command "Seerr/Radarr/Sonarr settings") and fill in the services you use. All fields are optional — buttons and rows only appear for the services you've configured.

| Field | Description |
| --- | --- |
| **Seerr URL** | Base URL of your Overseerr/Jellyseerr instance, e.g. `https://seerr.example.com` (no trailing slash). Also used to detect when you're on your own Seerr instance, to show the Woke Score row. |
| **Seerr API key** | Optional. Found in Seerr under *Settings → General*. Enables the "Request in Seerr now" one-click button. Without it, the "Open in Seerr" button still works and opens the title in the Seerr web UI. |
| **Radarr URL** | Base URL of your Radarr instance, e.g. `http://192.168.1.10:7878`. |
| **Sonarr URL** | Base URL of your Sonarr instance, e.g. `http://192.168.1.10:8989`. |
| **WokeOrNot: show buttons on the detail page** | Toggles the large action buttons shown on a title's own page on isitwokeornot.com. |
| **WokeOrNot: show hover buttons on overview pages** | Toggles the small hover buttons on cards on home/search/browse pages on isitwokeornot.com. |
| **Seerr: show the Woke Score row** | Toggles the Woke Score row on the title page in Seerr. |

Settings are stored locally via Tampermonkey's `GM_setValue`/`GM_getValue` storage and are never transmitted anywhere except to the isitwokeornot.com and Seerr/Radarr/Sonarr URLs involved in each feature.

> **Note:** Radarr and Sonarr are typically only reachable on your local network or via a reverse proxy/VPN. Make sure the configured URL is reachable from the browser where the userscript runs.

## How it works

**On isitwokeornot.com:**
- TMDB and IMDb ids for a title are resolved by fetching the title's own detail page (same-origin request) and extracting the ids embedded in the page. Results are cached locally so each title is only resolved once.
- "Open in Seerr" and the Radarr/Sonarr search links use those ids (or fall back to a plain title search) to build deep links — no API key required.
- "Request in Seerr now" additionally calls the Seerr REST API (`/api/v1/...`) directly from your browser using the configured API key, to check availability and submit the request.

**On your Seerr instance:**
- The title's TMDB id is read straight from Seerr's own URL, then its original title, display title, and IMDb id are fetched from Seerr's local API (using your existing, already-authenticated browser session — no separate credentials needed).
- The script searches isitwokeornot.com for each title candidate (original title first) until it finds a result whose IMDb id matches (when known), then extracts the score from that page and renders the Woke Score row.

### Woke Score caching

Every resolved score (and every "no match found" result) is cached locally per `mediaType:tmdbId`, using Tampermonkey's `GM_setValue`/`GM_getValue` storage, for **7 days**. Revisiting a title, or navigating back to it while browsing, reads from this cache instead of hitting isitwokeornot.com again.

The cache is bypassed once per **page reload** (F5, Ctrl+F5, Cmd+R, the browser's reload button, …), for whichever title happens to be showing right after that reload — that one gets a fresh lookup, and every other title visited afterwards in the same tab (via Seerr's normal in-app navigation) uses the cache again. There's no standard web API that lets a script tell a cache-busting hard reload (Ctrl+F5) apart from a normal one (F5); bypassing the cache on any reload is a deliberate trade-off that favours fresher-than-needed data over stale data.

To clear the cache immediately, use the Tampermonkey menu command **"🗑️ Clear Woke Score cache"** (shown while on your Seerr instance).

### UTM parameters on the Woke Score link

The Woke Score row's link to isitwokeornot.com (both while it's still loading and once a score is found) has these query parameters appended:

```
?utm_source=seerr-tampermonkey&utm_medium=referral&utm_campaign=media-fact
```

This is standard [UTM tracking](https://en.wikipedia.org/wiki/UTM_parameters): it tells isitwokeornot.com's own analytics that the visit came from this script, rather than from a regular link or search result — the same mechanism virtually every site uses to see where its traffic comes from. It's added client-side only, to that one outbound link; it does not change what's requested, does not add tracking anywhere else in the script, and carries no personal data — just those three fixed, constant values. If you'd rather not send it, strip the query string after following the link, or remove the `withUtmParams()` call in the script's source.

### Auto-updates

The script declares `@updateURL`/`@downloadURL` pointing at this repository's `main` branch, so Tampermonkey can check for and install new versions on its own (Dashboard → **Utilities** tab → **"Check for userscript updates"**, or automatically if that setting is enabled). Two things make this safe:

- **Your settings are never at risk.** The Seerr/Radarr/Sonarr URLs, API key, and the Woke Score cache all live in `GM_setValue` storage, which is entirely separate from the script's source code — an update replaces the code, never this storage.
- **Your Seerr match is never at risk either**, but only because it's added via Tampermonkey's "User matches" (see below) rather than by hand-editing the script — see why below.

### Why does the Seerr row need an extra match, and why here?

The script only declares `@match https://isitwokeornot.com/*` in its source. The Seerr-side "Woke Score" row is the one exception that needs the script to also run on your own Seerr instance — but that URL is only known once you've entered it in the settings dialog, and a userscript's `@match` list is fixed metadata that Tampermonkey reads *before* any of the script's code runs, while `GM_getValue` (how the script reads your saved settings) is only available once the script is already running on a matched page. There's no point at which the script could read its own config to decide where it's allowed to run — that would be the script granting itself access, which userscript managers deliberately don't allow.

Two ways exist to add that second domain:

1. **Edit `@match` in the script's own source.** This works, but the next auto-update (see above) downloads a fresh copy of the file and overwrites it, silently reverting the edit and quietly disabling the Seerr row again.
2. **Add it as a "User match" on the script's own page** — Dashboard → **"Installierte Userscripts"** → click this script to open its own page → **"User matches"**. This is the recommended approach, and it's a per-script setting: it is **not** the dashboard's global **"Einstellungen"** tab (that tab is shared across every installed script and has no match fields — easy to land on by mistake, since both are just called "Settings"/"Einstellungen"). User matches are stored in Tampermonkey's own local database, entirely separate from the script's source code, so they're untouched by updates. This is the same reason your saved settings above survive updates too: anything stored outside the script file does, anything inside it doesn't.

Declaring `@match *://*/*` in the source ("run on every page load, and immediately return if it's not one of ours") would sidestep needing a second match at all, but means Tampermonkey injects the script into every single tab you open — unnecessary and needlessly broad for what's actually two specific sites.

The script's own site check (matching `location.hostname`/`origin` against isitwokeornot.com and your configured Seerr URL) still runs on top of either approach, so adding a broader Seerr match pattern than necessary (e.g. a wildcard subdomain) is harmless — the script still only activates on the exact origin you configured.

Violentmonkey and other userscript managers offer an equivalent (their own UI for match/include rules kept separate from the script source, outside its editor) — check your manager's documentation for the exact name and location if you're not using Tampermonkey.

## Compatibility

Targets `isitwokeornot.com` and your configured Seerr instance. The script relies on their current markup (e.g. `data-browse-title-id`, `data-title-detail-link`, Seerr's `.media-ratings`/`.media-fact` layout) and page structure, so future site/app redesigns may require an update.

## License

Released under the [MIT License](./LICENSE). This script has no third-party dependencies; it only uses the standard Tampermonkey/Greasemonkey `GM_*` APIs (`GM_getValue`, `GM_setValue`, `GM_registerMenuCommand`, `GM_xmlhttpRequest`, `GM_addStyle`) provided by the userscript manager. The embedded icon is the isitwokeornot.com logo, used solely to label the Woke Score row it displays inside Seerr.

isitwokeornot.com, Seerr/Overseerr/Jellyseerr, Radarr, and Sonarr are trademarks of their respective owners. This project is an independent, unofficial companion script and is not affiliated with any of them.

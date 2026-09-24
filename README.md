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

### Shared

- A settings dialog (gear icon, bottom-right, or via the Tampermonkey menu) to configure your instance URLs and API key — nothing is sent anywhere except the services you configure.
- Every feature can be toggled independently in the settings dialog.

## Installation

1. Install a userscript manager, e.g. [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`wokeornot-seerr-buttons.user.js`](./wokeornot-seerr-buttons.user.js) in this repository and click **Raw** — your userscript manager should pick it up and offer to install it. Alternatively, copy the file's contents into a new userscript.
3. Visit [isitwokeornot.com](https://isitwokeornot.com/) and click the ⚙️ button in the bottom-right corner (or use the Tampermonkey menu) to configure your Seerr/Radarr/Sonarr URLs.
4. **Optional, for the Seerr-side Woke Score row only:** open the script in the Tampermonkey dashboard (**Dashboard → this script → Edit**) and replace the placeholder `@match https://seerr.example.com/*` line (right below the fixed isitwokeornot.com one) with your own Seerr URL, e.g.:
   ```
   // @match        https://seerr.my-domain.com/*
   ```
   Save (Ctrl+S). See [Why does the Seerr row need an extra `@match` line?](#why-does-the-seerr-row-need-an-extra-match-line) below for why this can't be filled in automatically. Without this step, everything on isitwokeornot.com still works — only the Woke Score row inside Seerr needs it.

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

### Why does the Seerr row need an extra `@match` line?

The script declares two `@match` lines: a fixed one for `https://isitwokeornot.com/*`, and a placeholder one for Seerr (`https://seerr.example.com/*`) that you replace with your own Seerr URL. It would be convenient if the second line could just be filled in from the Seerr URL you already enter in the settings dialog — but it can't: a userscript's `@match` list is fixed metadata that Tampermonkey reads *before* any of the script's code runs, while `GM_getValue` (which is how the script reads your saved settings) is only available once the script is already running on a matched page. There's no point at which the script could read its own config to decide where it's allowed to run — that would be the script granting itself access, which userscript managers deliberately don't allow. Declaring `@match *://*/*` ("run on every page load, and immediately return if it's not one of ours") sidesteps that, but means Tampermonkey injects the script into every single tab you open, which is unnecessary and needlessly broad. Instead, you edit that one placeholder line yourself (see [Installation](#installation) above) — a one-time, thirty-second edit that keeps the script scoped to only the two sites it actually needs.

The script's own site check (matching `location.hostname`/`origin` against isitwokeornot.com and your configured Seerr URL) still runs on top of this, so adding a broader Seerr `@match` pattern than necessary (e.g. a wildcard subdomain) is harmless — the script still only activates on the exact origin you configured.

## Compatibility

Targets `isitwokeornot.com` and your configured Seerr instance. The script relies on their current markup (e.g. `data-browse-title-id`, `data-title-detail-link`, Seerr's `.media-ratings`/`.media-fact` layout) and page structure, so future site/app redesigns may require an update.

## License

Released under the [MIT License](./LICENSE). This script has no third-party dependencies; it only uses the standard Tampermonkey/Greasemonkey `GM_*` APIs (`GM_getValue`, `GM_setValue`, `GM_registerMenuCommand`, `GM_xmlhttpRequest`, `GM_addStyle`) provided by the userscript manager. The embedded icon is the isitwokeornot.com logo, used solely to label the Woke Score row it displays inside Seerr.

isitwokeornot.com, Seerr/Overseerr/Jellyseerr, Radarr, and Sonarr are trademarks of their respective owners. This project is an independent, unofficial companion script and is not affiliated with any of them.

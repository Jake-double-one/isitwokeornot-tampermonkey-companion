# isitwokeornot-tampermonkey-companion

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds quick-access buttons to [isitwokeornot.com](https://isitwokeornot.com/), letting you open or request the movie/show you're looking at directly in your own **Seerr** ([Overseerr](https://overseerr.dev/)/[Jellyseerr](https://github.com/Fallenbagel/jellyseerr)), **Radarr**, or **Sonarr** instance — without leaving the page.

## Features

- 🍿 **Open in Seerr** — deep-links to the title in your Seerr instance (falls back to a text search if no TMDB id is found).
- 🎬 **Search in Radarr** / 📺 **Search in Sonarr** — opens the "Add new" page pre-filled with the title.
- ⚡ **Request in Seerr now** — with a Seerr API key configured, request the title with a single click, right from isitwokeornot.com. The button first checks whether it's already available or requested, so you don't send duplicate requests.
- Hover buttons on grid/overview pages (home, search, "newly reviewed", people) and larger action buttons on the title detail page.
- A settings dialog (gear icon, bottom-right, or via the Tampermonkey menu) to configure your instance URLs and API key — nothing is sent anywhere except the services you configure.
- Works with isitwokeornot.com's client-side (Next.js) navigation, so buttons stay in sync as you browse without full page reloads.

## Installation

1. Install a userscript manager, e.g. [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`wokeornot-seerr-buttons.user.js`](./wokeornot-seerr-buttons.user.js) in this repository and click **Raw** — your userscript manager should pick it up and offer to install it. Alternatively, copy the file's contents into a new userscript.
3. Visit [isitwokeornot.com](https://isitwokeornot.com/) and click the ⚙️ button in the bottom-right corner (or use the Tampermonkey menu) to configure your Seerr/Radarr/Sonarr URLs.

## Configuration

Open the settings dialog (⚙️ button, or the Tampermonkey menu command "Seerr/Radarr/Sonarr settings") and fill in the services you use. All fields are optional — buttons only appear for the services you've configured.

| Field | Description |
| --- | --- |
| **Seerr URL** | Base URL of your Overseerr/Jellyseerr instance, e.g. `https://seerr.example.com` (no trailing slash). |
| **Seerr API key** | Optional. Found in Seerr under *Settings → General*. Enables the "Request in Seerr now" one-click button. Without it, the "Open in Seerr" button still works and opens the title in the Seerr web UI. |
| **Radarr URL** | Base URL of your Radarr instance, e.g. `http://192.168.1.10:7878`. |
| **Sonarr URL** | Base URL of your Sonarr instance, e.g. `http://192.168.1.10:8989`. |
| **Show buttons on the detail page** | Toggles the large action buttons shown on a title's own page. |
| **Show hover buttons on overview pages** | Toggles the small hover buttons on cards on home/search/browse pages. |

Settings are stored locally via Tampermonkey's `GM_setValue`/`GM_getValue` storage and are never transmitted anywhere except to the Seerr/Radarr/Sonarr URLs you configure yourself.

> **Note:** Radarr and Sonarr are typically only reachable on your local network or via a reverse proxy/VPN. Make sure the configured URL is reachable from the browser where the userscript runs.

## How it works

- TMDB and IMDb ids for a title are resolved by fetching the title's own detail page (same-origin request) and extracting the ids embedded in the page. Results are cached locally so each title is only resolved once.
- "Open in Seerr" and the Radarr/Sonarr search links use those ids (or fall back to a plain title search) to build deep links — no API key required.
- "Request in Seerr now" additionally calls the Seerr REST API (`/api/v1/...`) directly from your browser using the configured API key, to check availability and submit the request.

## Compatibility

Targets `https://isitwokeornot.com/*`. The script relies on the site's current markup (e.g. `data-browse-title-id`, `data-title-detail-link`) and page structure, so future site redesigns may require an update.

## License

Released under the [MIT License](./LICENSE). This script has no third-party dependencies; it only uses the standard Tampermonkey/Greasemonkey `GM_*` APIs (`GM_getValue`, `GM_setValue`, `GM_registerMenuCommand`, `GM_xmlhttpRequest`, `GM_addStyle`) provided by the userscript manager.

isitwokeornot.com, Seerr/Overseerr/Jellyseerr, Radarr, and Sonarr are trademarks of their respective owners. This project is an independent, unofficial companion script and is not affiliated with any of them.

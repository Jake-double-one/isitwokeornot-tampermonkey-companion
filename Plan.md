# Plan

Ideas we want to keep track of but haven't built yet.

## Settings export / import

A menu command (and/or buttons in the ⚙️ dialog) to export the saved settings (Seerr/Radarr/Sonarr URLs, toggles; the Seerr API key only on request) as JSON, and import them again.

Why: settings live in Tampermonkey's per-script storage. They survive normal updates, but are lost when the script is reinstalled as a new entry — which happened once when v2.6.0 renamed the script. An export would be a cheap backup.

## TasteDive follow-ups

The first version adds search buttons to the movie/show rows (overview pages and the "like" lists). Possible next steps:

- Buttons for the main title on a `/movies/like/…` or `/shows/like/…` page itself, not just the rows listed on it.
- Exact deep links instead of a title search: TasteDive has no TMDB id, but with a Seerr API key we could look the title (plus year) up via Seerr's search API and link straight to the title.
- Show the IsItWokeOrNot Woke Score on TasteDive rows, reusing the Seerr-side lookup and cache.

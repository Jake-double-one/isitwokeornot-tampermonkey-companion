// ==UserScript==
// @name         WokeOrNot ⇄ Seerr / Radarr / Sonarr Integration
// @namespace    https://local.userscripts/wokeornot-seerr
// @version      2.2.1
// @description  On isitwokeornot.com: buttons to open/request a title in your own Seerr (Overseerr/Jellyseerr), Radarr or Sonarr. On your Seerr instance: shows the WokeOrNot "Woke Score" as its own row on the title page. Both share one configuration.
// @author       Jake-double-one
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
//
// This script needs to run on two different sites: isitwokeornot.com (fixed)
// and your own Seerr instance (its URL is only known once you've configured
// it in the settings dialog below). Tampermonkey can't match a domain that
// isn't known until runtime, so @match is intentionally left as "run
// everywhere" and the script itself checks the current site on every page
// load, doing nothing at all on any site that isn't one of the two above.
// @match        *://*/*
// ==/UserScript==

/**
 * @typedef {Object} ScriptConfig
 * @property {string} seerrUrl             Base URL of Seerr, e.g. "https://seerr.example.com"
 * @property {string} seerrApiKey          Optional Seerr API key, enables one-click requesting
 * @property {string} radarrUrl            Base URL of Radarr, e.g. "http://192.168.1.10:7878"
 * @property {string} sonarrUrl            Base URL of Sonarr, e.g. "http://192.168.1.10:8989"
 * @property {boolean} showOnGridPages     Show hover buttons on card/grid pages
 * @property {boolean} showOnDetailPage    Show action buttons on the title detail page
 * @property {boolean} showWokeScoreOnSeerr Show the "Woke Score" row on the Seerr title page
 */

/**
 * @typedef {Object} MediaIds
 * @property {('movie'|'tv'|null)} tmdbType
 * @property {(string|null)} tmdbId
 * @property {(string|null)} imdbId
 */

(function () {
  'use strict';

  /* =========================================================================
   * 1) CONSTANTS
   * ========================================================================= */

  const WOKEORNOT_HOST = 'isitwokeornot.com';
  const WOKEORNOT_ORIGIN = `https://${WOKEORNOT_HOST}`;
  const WOKE_TYPE_FOR_MEDIA = { movie: 'MOVIE', tv: 'TV_SHOW' };

  const STORAGE_KEYS = {
    CONFIG: 'wsrConfig',
    ID_CACHE: 'wsrIdCache',
    SEERR_SCORE_CACHE: 'wsrSeerrScoreCache'
  };

  const SEERR_SCORE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /** @type {ScriptConfig} */
  const DEFAULT_CONFIG = {
    seerrUrl: '',
    seerrApiKey: '',
    radarrUrl: '',
    sonarrUrl: '',
    showOnGridPages: true,
    showOnDetailPage: true,
    showWokeScoreOnSeerr: true
  };

  // Overseerr/Jellyseerr media availability status codes (from their public API).
  const SEERR_STATUS = Object.freeze({
    UNKNOWN: 1,
    PENDING: 2,
    PROCESSING: 3,
    PARTIALLY_AVAILABLE: 4,
    AVAILABLE: 5,
    DELETED: 6
  });

  const SELECTORS = {
    CARD: '[data-browse-title-id]',
    CARD_LINK: 'a[data-title-detail-link]',
    DETAIL_WRAP: '.wsr-detail-wrap',
    SCORE_ROW: 'a[data-wsr-score-row]'
  };

  const LOCATION_CHANGE_EVENT = 'wsr:locationchange';
  const DEBUG = false;

  function log(...args) {
    if (DEBUG) console.log('[WokeOrNot]', ...args);
  }

  /* =========================================================================
   * 2) CONFIG STORAGE
   * ========================================================================= */

  /** @returns {ScriptConfig} */
  function getConfig() {
    const stored = GM_getValue(STORAGE_KEYS.CONFIG, null);
    if (!stored) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    } catch (err) {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** @param {ScriptConfig} config */
  function saveConfig(config) {
    GM_setValue(STORAGE_KEYS.CONFIG, JSON.stringify(config));
  }

  /** @param {ScriptConfig} config */
  function isConfigured(config) {
    return Boolean(config.seerrUrl || config.radarrUrl || config.sonarrUrl);
  }

  function stripTrailingSlash(url) {
    return (url || '').trim().replace(/\/+$/, '');
  }

  /* =========================================================================
   * 3) SITE DETECTION
   * ========================================================================= */

  function isWokeOrNotSite() {
    return location.hostname === WOKEORNOT_HOST;
  }

  /** @param {ScriptConfig} config */
  function isSeerrSite(config) {
    if (!config.seerrUrl) return false;
    try {
      return new URL(config.seerrUrl).origin === location.origin;
    } catch (err) {
      return false;
    }
  }

  /* =========================================================================
   * 4) UTILITIES
   * ========================================================================= */

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ ...options, onload: resolve, onerror: reject, ontimeout: reject });
    });
  }

  function showToast(message, duration = 3500) {
    document.querySelector('.wsr-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'wsr-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  function createLink({ className, href, label }) {
    const a = document.createElement('a');
    a.className = className;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  }

  function createButton({ className, label, title, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    if (title) btn.title = title;
    btn.textContent = label;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Wires up a "click once to arm, click again to confirm" pattern on a
   * button, so a single accidental click can never trigger `onConfirmed`.
   * The button's label switches to `confirmLabel` after the first click and
   * reverts to `originalLabel` automatically if not confirmed in time.
   */
  function armConfirmClick(buttonEl, { originalLabel, confirmLabel, confirmClassName, timeoutMs = 4000, onConfirmed }) {
    let confirmTimer = null;

    function reset() {
      clearTimeout(confirmTimer);
      confirmTimer = null;
      buttonEl.classList.remove(confirmClassName);
      buttonEl.textContent = originalLabel;
    }

    buttonEl.addEventListener('click', () => {
      if (confirmTimer) {
        reset();
        onConfirmed();
        return;
      }
      buttonEl.classList.add(confirmClassName);
      buttonEl.textContent = confirmLabel;
      confirmTimer = setTimeout(reset, timeoutMs);
    });
  }

  /* =========================================================================
   * 5) SHARED STYLES (settings dialog, toast, floating button, setup banner)
   * ========================================================================= */

  function injectSharedStyles() {
    GM_addStyle(`
      /* --- Setup banner, shown until at least one URL is configured --- */
      .wsr-banner {
        position: relative;
        max-width: 1100px;
        margin: 10px auto 0;
        padding: 10px 40px 10px 14px;
        background: #eef2ff;
        border: 1px solid #c7d2fe;
        color: #312e81;
        border-radius: 10px;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .wsr-banner button.wsr-link {
        background: #4f46e5;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .wsr-banner .wsr-close {
        position: absolute;
        top: 6px;
        right: 8px;
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        color: #4338ca;
      }

      /* --- Settings dialog --- */
      .wsr-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, .55);
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .wsr-modal {
        background: #fff;
        color: #111;
        border-radius: 12px;
        width: 100%;
        max-width: 460px;
        padding: 20px;
        max-height: 90vh;
        overflow: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .wsr-modal h2 { margin: 0 0 12px; font-size: 18px; }
      .wsr-field { margin-bottom: 12px; }
      .wsr-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      .wsr-field small { display: block; color: #666; font-size: 11px; margin-top: 3px; }
      .wsr-field input[type="text"],
      .wsr-field input[type="password"] {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 13px;
      }
      .wsr-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 10px; }
      .wsr-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      .wsr-modal-actions button {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid #ccc;
      }
      .wsr-modal-actions .wsr-save { background: #4f46e5; color: #fff; border-color: #4f46e5; }

      /* --- Toast notifications --- */
      .wsr-toast {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #111827;
        color: #fff;
        padding: 10px 16px;
        border-radius: 8px;
        font-size: 13px;
        z-index: 100001;
        box-shadow: 0 4px 14px rgba(0, 0, 0, .35);
        max-width: 90vw;
        text-align: center;
      }

      /* --- Floating settings button --- */
      .wsr-fab {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 9999;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #1f2937;
        color: #fff;
        border: none;
        cursor: pointer;
        font-size: 18px;
        box-shadow: 0 3px 10px rgba(0, 0, 0, .35);
      }
    `);
  }

  function addFloatingSettingsButton() {
    if (document.querySelector('.wsr-fab')) return;
    document.body.appendChild(createButton({
      className: 'wsr-fab',
      label: '⚙️',
      title: 'Seerr/Radarr/Sonarr settings',
      onClick: openSettingsDialog
    }));
  }

  /* =========================================================================
   * 6) SETTINGS DIALOG (shared by both modes)
   * ========================================================================= */

  function openSettingsDialog() {
    const config = getConfig();
    const backdrop = document.createElement('div');
    backdrop.className = 'wsr-modal-backdrop';
    backdrop.innerHTML = `
      <div class="wsr-modal">
        <h2>⚙️ Seerr / Radarr / Sonarr Settings</h2>

        <div class="wsr-field">
          <label for="wsr-seerrUrl">Seerr URL (Overseerr/Jellyseerr)</label>
          <input type="text" id="wsr-seerrUrl" placeholder="https://seerr.example.com" value="${config.seerrUrl}">
          <small>No trailing slash, e.g. https://seerr.example.com. Used both for the WokeOrNot buttons and to detect your Seerr instance for the Woke Score row.</small>
        </div>

        <div class="wsr-field">
          <label for="wsr-seerrApiKey">Seerr API key (optional)</label>
          <input type="password" id="wsr-seerrApiKey" placeholder="Enables the 'Request now' button" value="${config.seerrApiKey}">
          <small>Found in Seerr under Settings → General. Lets you request titles with one click, without opening Seerr.</small>
        </div>

        <div class="wsr-field">
          <label for="wsr-radarrUrl">Radarr URL</label>
          <input type="text" id="wsr-radarrUrl" placeholder="http://192.168.1.10:7878" value="${config.radarrUrl}">
        </div>

        <div class="wsr-field">
          <label for="wsr-sonarrUrl">Sonarr URL</label>
          <input type="text" id="wsr-sonarrUrl" placeholder="http://192.168.1.10:8989" value="${config.sonarrUrl}">
        </div>

        <label class="wsr-checkbox">
          <input type="checkbox" id="wsr-showDetail" ${config.showOnDetailPage ? 'checked' : ''}>
          WokeOrNot: show buttons on the title detail page
        </label>

        <label class="wsr-checkbox">
          <input type="checkbox" id="wsr-showGrid" ${config.showOnGridPages ? 'checked' : ''}>
          WokeOrNot: show hover buttons on overview pages (home, search, newly reviewed, people)
        </label>

        <label class="wsr-checkbox">
          <input type="checkbox" id="wsr-showSeerrRow" ${config.showWokeScoreOnSeerr ? 'checked' : ''}>
          Seerr: show the Woke Score row on the title page
        </label>

        <div class="wsr-modal-actions">
          <button type="button" class="wsr-cancel">Cancel</button>
          <button type="button" class="wsr-save">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
    backdrop.querySelector('.wsr-cancel').addEventListener('click', () => backdrop.remove());
    backdrop.querySelector('.wsr-save').addEventListener('click', () => {
      const field = (id) => backdrop.querySelector(`#${id}`);
      saveConfig({
        seerrUrl: stripTrailingSlash(field('wsr-seerrUrl').value),
        seerrApiKey: field('wsr-seerrApiKey').value.trim(),
        radarrUrl: stripTrailingSlash(field('wsr-radarrUrl').value),
        sonarrUrl: stripTrailingSlash(field('wsr-sonarrUrl').value),
        showOnDetailPage: field('wsr-showDetail').checked,
        showOnGridPages: field('wsr-showGrid').checked,
        showWokeScoreOnSeerr: field('wsr-showSeerrRow').checked
      });
      backdrop.remove();
      showToast('Settings saved – reloading …', 1500);
      setTimeout(() => location.reload(), 400);
    });
  }

  /* =========================================================================
   * 7) WOKEORNOT MODE — STYLES
   * ========================================================================= */

  function injectWokeOrNotStyles() {
    GM_addStyle(`
      /* --- Hover overlay on cards (home, search, newly reviewed, people, ...) --- */
      ${SELECTORS.CARD} { position: relative; }
      .wsr-overlay {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 45;
        display: flex;
        gap: 6px;
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity .15s ease, transform .15s ease;
        pointer-events: none;
      }
      ${SELECTORS.CARD}:hover .wsr-overlay,
      ${SELECTORS.CARD}:focus-within .wsr-overlay {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .wsr-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, .3);
        background: rgba(15, 23, 42, .85);
        color: #fff;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(0, 0, 0, .35);
        text-decoration: none;
      }
      .wsr-btn:hover { filter: brightness(1.15); }
      .wsr-btn.wsr-loading { opacity: .55; cursor: progress; }
      .wsr-btn.wsr-seerr     { background: #7c3aed; }
      .wsr-btn.wsr-arr-movie { background: #ffc230; color: #111; }
      .wsr-btn.wsr-arr-tv    { background: #2e6da4; }

      /* --- Large action buttons on the detail page --- */
      .wsr-detail-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 4px;
        width: 100%;
      }
      .wsr-detail-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        border: 1px solid rgba(0, 0, 0, .12);
        cursor: pointer;
        text-decoration: none;
        color: #fff;
        transition: filter .15s ease, transform .1s ease;
      }
      .wsr-detail-btn:hover { filter: brightness(1.08); }
      .wsr-detail-btn:active { transform: scale(.97); }
      .wsr-detail-btn.wsr-seerr     { background: #7c3aed; }
      .wsr-detail-btn.wsr-arr-movie { background: #ffc230; color: #111; }
      .wsr-detail-btn.wsr-arr-tv    { background: #2e6da4; }
      .wsr-detail-btn.wsr-request   { background: #059669; }
      .wsr-detail-btn.wsr-request.wsr-confirm { background: #dc2626; }
      .wsr-detail-btn[disabled] { opacity: .5; cursor: not-allowed; pointer-events: none; }
    `);
  }

  /* =========================================================================
   * 8) WOKEORNOT MODE — MEDIA ID EXTRACTION & URL BUILDERS
   * ========================================================================= */

  /**
   * Finds the TMDB id/type and IMDb id embedded in a WokeOrNot page's HTML
   * source. WokeOrNot renders these values into the page source (via the
   * "where to watch" provider data and the visible IMDb rating badge) even
   * when they aren't always present as a clickable link, so a plain regex
   * over the raw HTML text is the most reliable way to pick them up.
   *
   * @param {string} html
   * @returns {MediaIds}
   */
  function extractIdsFromHtml(html) {
    const tmdbMatch = html.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d+)/i);
    return {
      tmdbType: tmdbMatch ? tmdbMatch[1] : null,
      tmdbId: tmdbMatch ? tmdbMatch[2] : null,
      imdbId: imdbMatch ? imdbMatch[1] : null
    };
  }

  /** @returns {('movie'|'tv'|null)} */
  function mediaTypeFromPath(pathname) {
    if (pathname.startsWith('/movie/')) return 'movie';
    if (pathname.startsWith('/tv/')) return 'tv';
    return null;
  }

  /**
   * Builds the target URL for Seerr (Overseerr/Jellyseerr).
   * Prefers a direct TMDB deep link; falls back to a text search.
   */
  function buildSeerrUrl(config, mediaType, ids, title) {
    const base = stripTrailingSlash(config.seerrUrl);
    if (!base) return null;
    if (ids.tmdbId) return `${base}/${mediaType}/${ids.tmdbId}`;
    if (title) return `${base}/search?query=${encodeURIComponent(title)}`;
    return null;
  }

  /**
   * Builds the target URL for Radarr (movies) or Sonarr (TV shows).
   * Opens the "Add new" page with the search term pre-filled via the
   * `term` query parameter, preferring tmdb:/imdb: id lookups over a
   * plain title search.
   */
  function buildArrUrl(config, mediaType, ids, title) {
    const base = stripTrailingSlash(mediaType === 'movie' ? config.radarrUrl : config.sonarrUrl);
    if (!base) return null;

    let term = null;
    if (ids.tmdbId) term = `tmdb:${ids.tmdbId}`;
    else if (ids.imdbId) term = `imdb:${ids.imdbId}`;
    else if (title) term = title;
    if (!term) return null;

    return `${base}/add/new?term=${encodeURIComponent(term)}`;
  }

  /* =========================================================================
   * 9) WOKEORNOT MODE — ID CACHE (grid cards don't expose ids up front)
   * ========================================================================= */

  const idCache = {
    /** @type {Map<string, MediaIds>} */
    memory: new Map(),

    readPersisted() {
      try {
        return JSON.parse(GM_getValue(STORAGE_KEYS.ID_CACHE, '{}'));
      } catch (err) {
        return {};
      }
    },

    writePersisted(entries) {
      GM_setValue(STORAGE_KEYS.ID_CACHE, JSON.stringify(entries));
    },

    /** @returns {MediaIds|null} */
    get(pathname) {
      if (this.memory.has(pathname)) return this.memory.get(pathname);
      const persisted = this.readPersisted();
      if (persisted[pathname]) {
        this.memory.set(pathname, persisted[pathname]);
        return persisted[pathname];
      }
      return null;
    },

    /** @param {MediaIds} ids */
    set(pathname, ids) {
      this.memory.set(pathname, ids);
      const persisted = this.readPersisted();
      persisted[pathname] = ids;
      this.writePersisted(persisted);
    },

    clear() {
      this.memory.clear();
      this.writePersisted({});
    }
  };

  /**
   * Loads a title's detail page in the background (same origin, so a plain
   * fetch() works without any CORS setup) to determine its TMDB/IMDb id.
   * Results are cached indefinitely per path.
   *
   * @param {string} pathname
   * @returns {Promise<MediaIds>}
   */
  async function resolveIdsForPath(pathname) {
    const cached = idCache.get(pathname);
    if (cached) return cached;

    try {
      const response = await fetch(pathname, { credentials: 'same-origin' });
      const html = await response.text();
      const ids = extractIdsFromHtml(html);
      idCache.set(pathname, ids);
      return ids;
    } catch (err) {
      return { tmdbType: null, tmdbId: null, imdbId: null };
    }
  }

  /* =========================================================================
   * 10) WOKEORNOT MODE — SEERR API: STATUS CHECK + DIRECT REQUEST
   * ========================================================================= */

  /**
   * Checks whether a title is already available/requested in Seerr, and if
   * not, submits a new request — all via the Seerr API, without ever opening
   * the Seerr UI. Requires a configured Seerr URL + API key and a TMDB id.
   */
  async function requestInSeerr(config, mediaType, tmdbId, buttonEl) {
    const base = stripTrailingSlash(config.seerrUrl);
    const originalLabel = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = '⏳ Checking status …';

    try {
      const statusResponse = await gmRequest({
        method: 'GET',
        url: `${base}/api/v1/${mediaType}/${tmdbId}`,
        headers: { 'X-Api-Key': config.seerrApiKey }
      });

      if (statusResponse.status >= 200 && statusResponse.status < 300) {
        const data = JSON.parse(statusResponse.responseText);
        const status = data?.mediaInfo?.status ?? null;
        if (status && status >= SEERR_STATUS.PENDING && status <= SEERR_STATUS.AVAILABLE) {
          buttonEl.textContent = '✅ Already available / requested';
          showToast('This title is already available or requested in Seerr.');
          return;
        }
      }

      buttonEl.textContent = '⏳ Sending request …';
      const payload = mediaType === 'tv'
        ? { mediaType: 'tv', mediaId: Number(tmdbId), seasons: 'all' }
        : { mediaType: 'movie', mediaId: Number(tmdbId) };

      const requestResponse = await gmRequest({
        method: 'POST',
        url: `${base}/api/v1/request`,
        headers: { 'X-Api-Key': config.seerrApiKey, 'Content-Type': 'application/json' },
        data: JSON.stringify(payload)
      });

      if (requestResponse.status >= 200 && requestResponse.status < 300) {
        buttonEl.textContent = '✅ Requested!';
        showToast('Request sent to Seerr successfully.');
      } else {
        buttonEl.disabled = false;
        buttonEl.textContent = originalLabel;
        showToast(`Request failed (HTTP ${requestResponse.status}). Check the Seerr URL/API key.`);
      }
    } catch (err) {
      buttonEl.disabled = false;
      buttonEl.textContent = originalLabel;
      showToast('Could not reach Seerr. Check the URL/API key.');
    }
  }

  /* =========================================================================
   * 11) WOKEORNOT MODE — DETAIL PAGE (/movie/... or /tv/...)
   * ========================================================================= */

  // Path currently being resolved, to avoid duplicate concurrent fetches
  // triggered by overlapping MutationObserver callbacks.
  let pendingDetailPath = null;

  function findDetailInsertionPoint() {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    // The <h1> sits inside a title wrapper, whose parent is the full title/
    // actions row ("Where to watch" / "Add to Watchlist" live next to it).
    return h1.parentElement?.parentElement || h1.parentElement || h1;
  }

  function getDetailTitle() {
    const h1 = document.querySelector('h1');
    return h1 ? h1.textContent.trim() : document.title.replace(/\s*\|.*$/, '').trim();
  }

  /**
   * Injects the action buttons on a title's detail page.
   *
   * The media ids are deliberately NOT read from the live DOM
   * (document.documentElement.innerHTML). Next.js doesn't reliably clean up
   * old <script> hydration payloads when navigating client-side between
   * titles, so a regex over the live DOM can end up matching the TMDB id of
   * the PREVIOUSLY visited title. Instead, we fetch a fresh, isolated copy of
   * the current URL (the same helper used for grid cards) — that guarantees
   * the ids always match the title currently being viewed.
   */
  async function injectDetailPageButtons() {
    const config = getConfig();
    if (!config.showOnDetailPage) return;

    const pathAtStart = location.pathname;
    const mediaType = mediaTypeFromPath(pathAtStart);
    if (!mediaType) return;

    const existingWrap = document.querySelector(SELECTORS.DETAIL_WRAP);
    if (existingWrap && existingWrap.dataset.path === pathAtStart) return;
    if (pendingDetailPath === pathAtStart) return;

    const insertionPoint = findDetailInsertionPoint();
    if (!insertionPoint) {
      setTimeout(injectDetailPageButtons, 300); // DOM not ready yet, retry shortly
      return;
    }

    // Remove the previous title's button block right away so its (now
    // outdated) state can't be confused with the new title.
    existingWrap?.remove();

    pendingDetailPath = pathAtStart;
    const ids = await resolveIdsForPath(pathAtStart);
    pendingDetailPath = null;

    // Bail out if the user has already navigated elsewhere while we waited
    // for the fetch — the next call for the new path will take over.
    if (location.pathname !== pathAtStart) return;

    const title = getDetailTitle();
    const wrap = document.createElement('div');
    wrap.className = 'wsr-detail-wrap';
    wrap.dataset.path = pathAtStart;

    const seerrHref = buildSeerrUrl(config, mediaType, ids, title);
    if (seerrHref) {
      wrap.appendChild(createLink({ className: 'wsr-detail-btn wsr-seerr', href: seerrHref, label: '🍿 Open in Seerr' }));
    }

    const arrHref = buildArrUrl(config, mediaType, ids, title);
    if (arrHref) {
      const isMovie = mediaType === 'movie';
      wrap.appendChild(createLink({
        className: `wsr-detail-btn ${isMovie ? 'wsr-arr-movie' : 'wsr-arr-tv'}`,
        href: arrHref,
        label: isMovie ? '🎬 Search in Radarr' : '📺 Search in Sonarr'
      }));
    }

    if (config.seerrUrl && config.seerrApiKey && ids.tmdbId) {
      const requestLabel = '⚡ Request in Seerr now';
      const requestBtn = createButton({
        className: 'wsr-detail-btn wsr-request',
        label: requestLabel
      });
      armConfirmClick(requestBtn, {
        originalLabel: requestLabel,
        confirmLabel: '❓ Really? Click to confirm',
        confirmClassName: 'wsr-confirm',
        onConfirmed: () => requestInSeerr(config, mediaType, ids.tmdbId, requestBtn)
      });
      wrap.appendChild(requestBtn);
    }

    if (wrap.children.length === 0) return;

    // Re-check the insertion point in case React replaced it while we waited.
    const target = insertionPoint.isConnected ? insertionPoint : findDetailInsertionPoint();
    target?.insertAdjacentElement('afterend', wrap);
  }

  /* =========================================================================
   * 12) WOKEORNOT MODE — GRID / CARD PAGES
   * ========================================================================= */

  function createOverlayButton({ className, label, title, getHref }) {
    const btn = createButton({ className: `wsr-btn ${className} wsr-loading`, label, title });
    btn.disabled = true;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const href = getHref();
      if (href) window.open(href, '_blank', 'noopener');
    });
    return btn;
  }

  function activateOverlayButton(btn, href, missingUrlHint) {
    btn.classList.remove('wsr-loading');
    if (href) {
      btn.disabled = false;
    } else {
      btn.title = `${btn.title} (${missingUrlHint})`;
    }
  }

  function processCard(card) {
    if (card.dataset.wsrDone) return;
    card.dataset.wsrDone = '1';

    const link = card.querySelector(SELECTORS.CARD_LINK);
    if (!link) return;

    const href = link.getAttribute('href') || '';
    const mediaType = mediaTypeFromPath(href);
    if (!mediaType) return;

    const titleGuess = (link.querySelector('img')?.alt || '').replace(/\s*\(\d{4}\).*$/, '').trim();
    const isMovie = mediaType === 'movie';

    let resolvedArrHref = null;
    let resolvedSeerrHref = null;

    const arrBtn = createOverlayButton({
      className: isMovie ? 'wsr-arr-movie' : 'wsr-arr-tv',
      label: isMovie ? '🎬' : '📺',
      title: isMovie ? 'Search in Radarr' : 'Search in Sonarr',
      getHref: () => resolvedArrHref
    });

    const seerrBtn = createOverlayButton({
      className: 'wsr-seerr',
      label: '🍿',
      title: 'Open in Seerr',
      getHref: () => resolvedSeerrHref
    });

    const overlay = document.createElement('div');
    overlay.className = 'wsr-overlay';
    overlay.append(arrBtn, seerrBtn);
    card.appendChild(overlay);

    let hasResolved = false;
    async function resolveAndActivate() {
      if (hasResolved) return;
      hasResolved = true;

      const config = getConfig();
      const ids = await resolveIdsForPath(href);

      resolvedArrHref = buildArrUrl(config, mediaType, ids, titleGuess);
      resolvedSeerrHref = buildSeerrUrl(config, mediaType, ids, titleGuess);

      activateOverlayButton(arrBtn, resolvedArrHref, `${isMovie ? 'Radarr' : 'Sonarr'} URL not configured`);
      activateOverlayButton(seerrBtn, resolvedSeerrHref, 'Seerr URL not configured');
    }

    // Resolve the ids lazily on hover/focus intent to avoid fetching every
    // card on the page up front; results are cached after the first lookup.
    card.addEventListener('mouseenter', resolveAndActivate, { once: true });
    card.addEventListener('focusin', resolveAndActivate, { once: true });
  }

  function processVisibleCards() {
    const config = getConfig();
    if (!config.showOnGridPages) return;
    document.querySelectorAll(SELECTORS.CARD).forEach(processCard);
  }

  /* =========================================================================
   * 13) WOKEORNOT MODE — SETUP BANNER
   * ========================================================================= */

  function maybeShowSetupBanner() {
    const config = getConfig();
    if (isConfigured(config)) return;
    if (sessionStorage.getItem('wsrBannerDismissed')) return;
    if (document.querySelector('.wsr-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'wsr-banner';
    banner.innerHTML = `
      <span>🔌 Connect WokeOrNot to your own Seerr / Radarr / Sonarr setup.</span>
      <button type="button" class="wsr-link">Set up now</button>
      <button type="button" class="wsr-close" aria-label="Dismiss">×</button>
    `;
    banner.querySelector('.wsr-link').addEventListener('click', openSettingsDialog);
    banner.querySelector('.wsr-close').addEventListener('click', () => {
      sessionStorage.setItem('wsrBannerDismissed', '1');
      banner.remove();
    });

    (document.querySelector('main') || document.body).prepend(banner);
  }

  /**
   * Runs (or re-runs, after a client-side navigation) all WokeOrNot-side
   * features for whichever page is currently showing.
   */
  function refreshWokeOrNotPage() {
    if (mediaTypeFromPath(location.pathname)) {
      injectDetailPageButtons();
    }
    processVisibleCards();
    maybeShowSetupBanner();
  }

  /* =========================================================================
   * 14) SEERR MODE — "Woke Score" row on the title page
   * ========================================================================= */

  // Small inline SVG badge for the row's leading icon (a "W" monogram in
  // WokeOrNot's teal accent colour). Deliberately NOT a base64-encoded
  // raster image: a giant base64 blob is one bit-flip away from silently
  // becoming a corrupt image (which is exactly what happened here — a
  // previous version shipped with a broken PNG). This SVG is plain, human
  // readable text, so it can't be silently mangled the same way, and it
  // avoids an external image request (no mixed-content/CSP issue either).
  const WOKE_ICON_DATA_URL = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" rx="6" fill="#0d9488"/>' +
    '<text x="12" y="17" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">W</text>' +
    '</svg>'
  );


  /** Reads the movie/tv id straight from Seerr's own URL — Seerr addresses
   *  every title by its TMDB id, so this is exact, with no guessing needed. */
  function getSeerrRouteInfo() {
    const match = location.pathname.match(/^\/(movie|tv)\/(\d+)/);
    if (!match) return null;
    return { mediaType: match[1], tmdbId: match[2] };
  }

  function cleanTitle(raw) {
    return raw.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  }

  // Last-resort title guess from the page itself, only used if Seerr's own
  // API can't be reached for some reason.
  function getFallbackTitleFromDom() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content?.trim()) return cleanTitle(og.content.trim());
    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) return cleanTitle(h1.textContent.trim());
    return cleanTitle(document.title.split(' - ')[0].trim());
  }

  /**
   * Fetches this title's own metadata straight from Seerr's local API
   * (same-origin request, authenticated automatically via the browser's
   * existing session cookie — no API key needed here). This gives us the
   * ORIGINAL title, which is what WokeOrNot's search actually indexes, plus
   * the IMDb id as a way to confirm a WokeOrNot search result is the right
   * title rather than a similarly-named one.
   */
  async function fetchSeerrMediaMeta(mediaType, tmdbId) {
    try {
      const response = await fetch(`/api/v1/${mediaType}/${tmdbId}`, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const data = await response.json();
      const originalTitle = mediaType === 'movie' ? (data.originalTitle || data.title) : (data.originalName || data.name);
      const displayTitle = mediaType === 'movie' ? data.title : data.name;
      const imdbId = data.imdbId || data.externalIds?.imdbId || null;
      return { originalTitle, displayTitle, imdbId };
    } catch (err) {
      log('Could not read Seerr media metadata:', err);
      return null;
    }
  }

  function extractWokeScore(html) {
    let match = html.match(/Woke score (\d+)%/i);
    if (match) return parseInt(match[1], 10);
    match = html.match(/text-4xl[^>]*>(\d{1,3})%/i);
    if (match) return parseInt(match[1], 10);
    match = html.match(/aria-label="[^"]*?(\d{1,3})%/i);
    if (match) return parseInt(match[1], 10);
    return null;
  }

  async function findWokeOrNotUrl(title, mediaType) {
    const wokeType = WOKE_TYPE_FOR_MEDIA[mediaType];
    const searchUrl = `${WOKEORNOT_ORIGIN}/search?q=${encodeURIComponent(title)}&type=${wokeType}`;
    const response = await gmRequest({ method: 'GET', url: searchUrl });
    if (!(response.status >= 200 && response.status < 300) || !response.responseText) return null;
    const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
    const match = doc.querySelector(`a[href^="/${mediaType}/"]`);
    return match ? WOKEORNOT_ORIGIN + match.getAttribute('href') : null;
  }

  /**
   * Tries each candidate title against WokeOrNot's search, in order, until
   * one leads to a page whose IMDb id matches the title being viewed in
   * Seerr (when both are known). Trying the ORIGINAL title first is what
   * fixes the common case where Seerr shows a localized title WokeOrNot
   * doesn't know: e.g. Seerr's German "Dark Matter – Der Zeitenläufer"
   * search found nothing on WokeOrNot, while the original "Dark Matter"
   * matches directly.
   */
  async function resolveWokeScore(mediaType, titleCandidates, seerrImdbId) {
    const tried = new Set();
    for (const rawTitle of titleCandidates) {
      const title = (rawTitle || '').trim();
      if (!title || tried.has(title.toLowerCase())) continue;
      tried.add(title.toLowerCase());

      const pageUrl = await findWokeOrNotUrl(title, mediaType);
      if (!pageUrl) {
        log('No search result for title:', title);
        continue;
      }

      const pageResponse = await gmRequest({ method: 'GET', url: pageUrl });
      if (!(pageResponse.status >= 200 && pageResponse.status < 300) || !pageResponse.responseText) {
        log('WokeOrNot page unreachable:', pageUrl);
        continue;
      }

      const html = pageResponse.responseText;
      const ids = extractIdsFromHtml(html);
      if (seerrImdbId && ids.imdbId && ids.imdbId !== seerrImdbId) {
        log('IMDb id mismatch, likely the wrong title — skipping:', pageUrl);
        continue;
      }

      const score = extractWokeScore(html);
      if (score === null) {
        log('Could not find a score on the page:', pageUrl);
        continue;
      }

      return { score, url: pageUrl };
    }
    return null;
  }

  function seerrColorForScore(score) {
    if (score <= 33) return { bg: '#ecfdf5', fg: '#047857' }; // green
    if (score <= 66) return { bg: '#fffbeb', fg: '#b45309' }; // amber
    return { bg: '#fff1f2', fg: '#be123c' };                  // red
  }
  const SEERR_NEUTRAL_COLOR = { bg: 'transparent', fg: 'inherit' };

  function withUtmParams(url) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('utm_source', 'seerr-tampermonkey');
      parsed.searchParams.set('utm_medium', 'referral');
      parsed.searchParams.set('utm_campaign', 'media-fact');
      return parsed.toString();
    } catch (err) {
      return url;
    }
  }

  // Built with the same "media-fact" class Seerr itself uses for rows like
  // "Original Title" or "Status", so width/spacing/alignment match automatically.
  function buildSeerrScoreRow() {
    const row = document.createElement('a');
    row.className = 'media-fact';
    row.setAttribute('data-wsr-score-row', 'true');
    row.target = '_blank';
    row.rel = 'noreferrer';
    row.style.textDecoration = 'none';
    row.style.borderRadius = '8px';
    row.style.transition = 'background 0.2s ease';

    const label = document.createElement('span');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-weight:600;';

    const icon = document.createElement('img');
    icon.src = WOKE_ICON_DATA_URL;
    icon.alt = 'Woke or Not';
    icon.style.cssText = 'width:18px;height:18px;border-radius:4px;display:inline-block;flex-shrink:0;';

    const labelText = document.createElement('span');
    labelText.textContent = 'Woke Score';
    label.append(icon, labelText);

    const value = document.createElement('span');
    value.className = 'media-fact-value';
    value.style.fontWeight = '700';
    value.textContent = '…';

    row.append(label, value);
    return { row, labelText, value };
  }

  function setSeerrRowState(refs, state, href) {
    const { row, labelText, value } = refs;
    row.href = withUtmParams(href);
    const color = state.type === 'score' ? seerrColorForScore(state.score) : SEERR_NEUTRAL_COLOR;
    row.style.background = color.bg;
    labelText.style.color = color.fg;
    value.style.color = color.fg;
    value.textContent = state.type === 'score' ? `${state.score}%` : (state.message || '…');
  }

  /**
   * Caches resolved (and "no match found") Woke Scores per title, keyed by
   * `mediaType:tmdbId`, so revisiting a title doesn't re-query WokeOrNot
   * every time. Entries expire after SEERR_SCORE_CACHE_TTL_MS.
   */
  const seerrScoreCache = {
    read() {
      try {
        return JSON.parse(GM_getValue(STORAGE_KEYS.SEERR_SCORE_CACHE, '{}'));
      } catch (err) {
        return {};
      }
    },

    write(entries) {
      GM_setValue(STORAGE_KEYS.SEERR_SCORE_CACHE, JSON.stringify(entries));
    },

    /** @returns {({found:boolean, score?:number, url:string}|null)} */
    get(key) {
      const entry = this.read()[key];
      if (!entry) return null;
      if (Date.now() - entry.timestamp > SEERR_SCORE_CACHE_TTL_MS) return null;
      return entry;
    },

    set(key, value) {
      const entries = this.read();
      // Drop expired entries opportunistically so storage doesn't grow forever.
      for (const [k, v] of Object.entries(entries)) {
        if (Date.now() - v.timestamp > SEERR_SCORE_CACHE_TTL_MS) delete entries[k];
      }
      entries[key] = { ...value, timestamp: Date.now() };
      this.write(entries);
    },

    clear() {
      this.write({});
    }
  };

  // The Navigation Timing API can tell us this page load was a reload
  // (F5/Ctrl+F5/Cmd+R) rather than an SPA route change or a fresh visit, but
  // it cannot tell a normal reload apart from a cache-busting hard reload —
  // no standard web API exposes that distinction. Treating every reload as a
  // "please refresh" signal is a deliberate, user-requested trade-off: it
  // bypasses the cache a little more often than strictly necessary, but
  // never serves stale data past a reload. The flag is consumed once, for
  // whichever title is showing right after the reload; titles visited via
  // later SPA navigation in the same tab use the cache normally again.
  let seerrReloadBypassAvailable = (() => {
    try {
      return performance.getEntriesByType('navigation')[0]?.type === 'reload';
    } catch (err) {
      return false;
    }
  })();

  function consumeSeerrReloadBypass() {
    if (!seerrReloadBypassAvailable) return false;
    seerrReloadBypassAvailable = false;
    return true;
  }

  let seerrLastKey = null;
  // Path currently being resolved. Guards against the duplicate-row bug seen
  // on a slow/cold page load (e.g. Ctrl+F5): before `ratingsRow` is found and
  // this fetch is started, several MutationObserver bursts can each pass the
  // "no row yet, no lock yet" check while the FIRST run is still awaiting its
  // network calls, each starting its own fetch and inserting its own row.
  // Setting this synchronously, before any `await`, closes that window.
  let seerrPendingKey = null;

  async function runSeerrWokeScoreRow() {
    const route = getSeerrRouteInfo();
    if (!route) return;

    const key = location.pathname;
    if (key === seerrPendingKey) return; // already resolving this title
    if (key === seerrLastKey && document.querySelector(SELECTORS.SCORE_ROW)) return;

    const ratingsRow = document.querySelector('.media-ratings');
    if (!ratingsRow) {
      log('.media-ratings not found yet, will retry as the page keeps rendering.');
      return;
    }

    document.querySelectorAll(SELECTORS.SCORE_ROW).forEach((el) => el.remove());
    seerrLastKey = key;

    const cacheKey = `${route.mediaType}:${route.tmdbId}`;
    const cached = consumeSeerrReloadBypass() ? null : seerrScoreCache.get(cacheKey);
    if (cached) {
      log('Using cached Woke Score for', cacheKey, cached);
      const refs = buildSeerrScoreRow();
      if (cached.found) {
        setSeerrRowState(refs, { type: 'score', score: cached.score }, cached.url);
      } else {
        setSeerrRowState(refs, { type: 'error', message: 'No match found' }, cached.url);
      }
      ratingsRow.insertAdjacentElement('afterend', refs.row);
      return;
    }

    seerrPendingKey = key;

    try {
      const meta = await fetchSeerrMediaMeta(route.mediaType, route.tmdbId);
      if (location.pathname !== key) return; // navigated away while fetching

      const fallbackTitle = getFallbackTitleFromDom();
      const titleCandidates = meta ? [meta.originalTitle, meta.displayTitle, fallbackTitle] : [fallbackTitle];
      log('Route:', route, '| candidates:', titleCandidates);

      const wokeType = WOKE_TYPE_FOR_MEDIA[route.mediaType];
      const fallbackSearchUrl = `${WOKEORNOT_ORIGIN}/search?q=${encodeURIComponent(titleCandidates[0] || '')}&type=${wokeType}`;

      const refs = buildSeerrScoreRow();
      setSeerrRowState(refs, { type: 'pending' }, fallbackSearchUrl);
      ratingsRow.insertAdjacentElement('afterend', refs.row);

      const result = await resolveWokeScore(route.mediaType, titleCandidates, meta?.imdbId || null);
      if (location.pathname !== key) return; // navigated away while fetching

      if (result) {
        setSeerrRowState(refs, { type: 'score', score: result.score }, result.url);
        seerrScoreCache.set(cacheKey, { found: true, score: result.score, url: result.url });
        log('Score:', result.score, '%', result.url);
      } else {
        setSeerrRowState(refs, { type: 'error', message: 'No match found' }, fallbackSearchUrl);
        seerrScoreCache.set(cacheKey, { found: false, url: fallbackSearchUrl });
      }
    } finally {
      if (seerrPendingKey === key) seerrPendingKey = null;
    }
  }

  /* =========================================================================
   * 15) SPA NAVIGATION (both WokeOrNot and Seerr are client-routed apps)
   * ========================================================================= */

  function patchHistoryForNavigationEvents() {
    const dispatchLocationChange = () => window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      dispatchLocationChange();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      dispatchLocationChange();
      return result;
    };
    window.addEventListener('popstate', dispatchLocationChange);
  }

  /* =========================================================================
   * 16) BOOTSTRAP
   * ========================================================================= */

  function init() {
    const config = getConfig();
    const onWokeOrNot = isWokeOrNotSite();
    const onSeerr = isSeerrSite(config);
    if (!onWokeOrNot && !onSeerr) return; // unrelated site, do nothing

    injectSharedStyles();
    if (onWokeOrNot) injectWokeOrNotStyles();

    addFloatingSettingsButton();
    GM_registerMenuCommand('⚙️ Seerr/Radarr/Sonarr settings', openSettingsDialog);
    if (onWokeOrNot) {
      GM_registerMenuCommand('🗑️ Clear id cache', () => {
        idCache.clear();
        showToast('Cache cleared.');
      });
    }
    if (onSeerr) {
      GM_registerMenuCommand('🗑️ Clear Woke Score cache', () => {
        seerrScoreCache.clear();
        showToast('Woke Score cache cleared.');
      });
    }

    function refreshCurrentPage() {
      if (onWokeOrNot) {
        refreshWokeOrNotPage();
      } else if (getConfig().showWokeScoreOnSeerr) {
        runSeerrWokeScoreRow();
      }
    }

    patchHistoryForNavigationEvents();
    window.addEventListener(LOCATION_CHANGE_EVENT, () => {
      // Small delay to let React finish re-rendering the new route.
      setTimeout(refreshCurrentPage, 250);
    });

    // Debounced: React can trigger many DOM mutations in quick succession,
    // no need to re-scan the page on every single one of them.
    const handleMutations = debounce(refreshCurrentPage, 120);
    new MutationObserver(handleMutations).observe(document.body, { childList: true, subtree: true });

    refreshCurrentPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

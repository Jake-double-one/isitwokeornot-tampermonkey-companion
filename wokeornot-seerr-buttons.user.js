// ==UserScript==
// @name         WokeOrNot ⇄ Seerr / Radarr / Sonarr Integration
// @namespace    https://local.userscripts/wokeornot-seerr
// @version      2.1.0
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
    ID_CACHE: 'wsrIdCache'
  };

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

  // WokeOrNot's own logo, embedded so the row doesn't depend on an external
  // image request (also avoids a mixed-content/CSP issue on Seerr's page).
  const WOKE_ICON_DATA_URL =
    'data:image/png;base64,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';


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
    seerrPendingKey = key;
    seerrLastKey = key;

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
        log('Score:', result.score, '%', result.url);
      } else {
        setSeerrRowState(refs, { type: 'error', message: 'No match found' }, fallbackSearchUrl);
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

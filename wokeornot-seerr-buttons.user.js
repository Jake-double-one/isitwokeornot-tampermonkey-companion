// ==UserScript==
// @name         WokeOrNot → Seerr / Radarr / Sonarr Buttons
// @namespace    https://local.userscripts/wokeornot-seerr
// @version      1.1.0
// @description  Adds buttons on isitwokeornot.com to open or request the current movie/show in your own Seerr (Overseerr/Jellyseerr), Radarr or Sonarr instance.
// @author       Jake-double-one
// @match        https://isitwokeornot.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

/**
 * @typedef {Object} ScriptConfig
 * @property {string} seerrUrl          Base URL of Seerr, e.g. "https://seerr.example.com"
 * @property {string} seerrApiKey       Optional Seerr API key, enables one-click requesting
 * @property {string} radarrUrl         Base URL of Radarr, e.g. "http://192.168.1.10:7878"
 * @property {string} sonarrUrl         Base URL of Sonarr, e.g. "http://192.168.1.10:8989"
 * @property {boolean} showOnGridPages  Show hover buttons on card/grid pages
 * @property {boolean} showOnDetailPage Show action buttons on the title detail page
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
    showOnDetailPage: true
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
    DETAIL_WRAP: '.wsr-detail-wrap'
  };

  const LOCATION_CHANGE_EVENT = 'wsr:locationchange';

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
   * 3) STYLES
   * ========================================================================= */

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
    .wsr-detail-btn[disabled] { opacity: .5; cursor: not-allowed; pointer-events: none; }

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

  /* =========================================================================
   * 4) MEDIA ID EXTRACTION & URL BUILDERS
   * ========================================================================= */

  /**
   * Finds the TMDB id/type and IMDb id embedded in a page's HTML source.
   *
   * WokeOrNot renders these values into the page source (via the "where to
   * watch" provider data and the visible IMDb rating badge) even when they
   * aren't always present as a clickable link, so a plain regex over the raw
   * HTML text is the most reliable way to pick them up.
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
   * 5) ID CACHE (grid cards don't expose their TMDB/IMDb id up front)
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
   * 6) TOAST NOTIFICATIONS
   * ========================================================================= */

  function showToast(message, duration = 3500) {
    document.querySelector('.wsr-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'wsr-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  /* =========================================================================
   * 7) SEERR API: STATUS CHECK + DIRECT REQUEST
   * ========================================================================= */

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ ...options, onload: resolve, onerror: reject, ontimeout: reject });
    });
  }

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
   * 8) SHARED BUTTON FACTORIES
   * ========================================================================= */

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

  /* =========================================================================
   * 9) DETAIL PAGE (/movie/... or /tv/...)
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
      const requestBtn = createButton({
        className: 'wsr-detail-btn wsr-request',
        label: '⚡ Request in Seerr now'
      });
      requestBtn.addEventListener('click', () => requestInSeerr(config, mediaType, ids.tmdbId, requestBtn));
      wrap.appendChild(requestBtn);
    }

    if (wrap.children.length === 0) return;

    // Re-check the insertion point in case React replaced it while we waited.
    const target = insertionPoint.isConnected ? insertionPoint : findDetailInsertionPoint();
    target?.insertAdjacentElement('afterend', wrap);
  }

  /* =========================================================================
   * 10) GRID / CARD PAGES (home, search, newly reviewed, people, ...)
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
   * 11) SETUP BANNER (shown until at least one target URL is configured)
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

  /* =========================================================================
   * 12) SETTINGS DIALOG
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
          <small>No trailing slash, e.g. https://seerr.example.com</small>
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
          Show buttons on the detail page
        </label>

        <label class="wsr-checkbox">
          <input type="checkbox" id="wsr-showGrid" ${config.showOnGridPages ? 'checked' : ''}>
          Show hover buttons on overview pages (home, search, newly reviewed, people)
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
        showOnGridPages: field('wsr-showGrid').checked
      });
      backdrop.remove();
      showToast('Settings saved – reloading …', 1500);
      setTimeout(() => location.reload(), 400);
    });
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

  GM_registerMenuCommand('⚙️ Seerr/Radarr/Sonarr settings', openSettingsDialog);
  GM_registerMenuCommand('🗑️ Clear id cache', () => {
    idCache.clear();
    showToast('Cache cleared.');
  });

  /* =========================================================================
   * 13) SPA NAVIGATION (Next.js client-side routing)
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

  function runForCurrentPage() {
    if (mediaTypeFromPath(location.pathname)) {
      injectDetailPageButtons();
    }
    processVisibleCards();
    maybeShowSetupBanner();
    addFloatingSettingsButton();
  }

  /* =========================================================================
   * 14) UTILITIES
   * ========================================================================= */

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  /* =========================================================================
   * 15) BOOTSTRAP
   * ========================================================================= */

  function init() {
    patchHistoryForNavigationEvents();

    window.addEventListener(LOCATION_CHANGE_EVENT, () => {
      // Small delay to let React finish re-rendering the new route.
      setTimeout(runForCurrentPage, 250);
    });

    // Debounced: React can trigger many DOM mutations in quick succession,
    // no need to re-scan the page on every single one of them.
    const handleMutations = debounce(() => {
      processVisibleCards();
      const mediaType = mediaTypeFromPath(location.pathname);
      const hasCurrentWrap = document.querySelector(`${SELECTORS.DETAIL_WRAP}[data-path="${location.pathname}"]`);
      if (mediaType && !hasCurrentWrap) injectDetailPageButtons();
    }, 120);

    new MutationObserver(handleMutations).observe(document.body, { childList: true, subtree: true });

    runForCurrentPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

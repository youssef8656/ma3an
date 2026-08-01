/**
 * MA3AN Camp Teams — shared data layer
 * ------------------------------------------------------------
 * Include this on every page, AFTER page-transitions.js:
 *
 *   <script src="page-transitions.js"></script>
 *   <script src="ma3an-data.js"></script>
 *
 * What it does:
 *  - Talks to the Google Apps Script backend (Code.gs) for login,
 *    registration, and reading/writing a camper's data.
 *  - Remembers who's logged in (in localStorage) so every page can
 *    ask "who is this?" without re-fetching or relying on URL params.
 *  - Caches "public" data — the list of teams, the list of games, and
 *    who's on each team/game — for a short time so pages don't all
 *    hammer the sheet with requests.
 *
 * Set SCRIPT_URL below to your deployed Web App URL (see
 * sheets-backend/README.md). Nothing will work until you do.
 *
 * Every page can then use the small API below instead of fake/
 * hardcoded data:
 *
 *   MA3AN.getSession()            -> logged-in user's data, or null
 *   MA3AN.isLoggedIn()            -> true/false
 *   MA3AN.requireLogin()          -> bounces to login.html if not logged in
 *   MA3AN.login(email, password)  -> logs in, stores session
 *   MA3AN.register(fields)        -> creates account, stores session
 *   MA3AN.logout()                -> clears session, back to login.html
 *   MA3AN.refreshProfile()        -> re-fetches the current user's row
 *   MA3AN.updateContact(fields)   -> edits mobile/parent info
 *   MA3AN.joinTeam(team)          -> join/switch team
 *   MA3AN.joinGame(game)          -> sign up for a game
 *   MA3AN.leaveGame(game)         -> drop a game
 *   MA3AN.getPublicData()         -> { teams, games, teamRosters, gameRosters }
 */
(function (global) {
  'use strict';

  // ---- CONFIGURE THIS ------------------------------------------------
  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby8h8IJy_D8WdQpm82O7omEMe7TRrpJbqvbUQUwpm_b_FWbx_MEmbwFtahqihIXxRZ2nA/exec'; // e.g. 'https://script.google.com/macros/s/AKfycb.../exec'

  // Camp dates — used for "Days Until Camp" / the countdown on the
  // dashboard. Change these if the camp dates move.
  const CAMP_START = new Date('2026-08-20T09:00:00');
  const CAMP_END = new Date('2026-08-24T17:00:00');
  const CAMP_DATE_LABEL = 'Aug 20 - Aug 24, 2026';

  // Max members per team, used only for the "FULL" / "N spots left"
  // display on sports.html — not enforced by the backend.
  const TEAM_CAPACITY = 24;
  // ---------------------------------------------------------------------

  const SESSION_KEY = 'ma3an_session';
  const PUBLIC_KEY = 'ma3an_public_cache';
  const PUBLIC_TTL_MS = 60 * 1000; // re-fetch teams/games/rosters at most once a minute

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage full/unavailable — fail quietly */ }
  }

  /**
   * Generic POST to the backend. `action` becomes data.action; the
   * script's doPost() switches on it. Uses text/plain to dodge CORS
   * preflight, per Code.gs's expectations.
   */
  async function apiPost(action, payload) {
    if (!SCRIPT_URL) {
      return { success: false, error: 'SCRIPT_URL is not set in ma3an-data.js yet.' };
    }
    try {
      const res = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      });
      return await res.json();
    } catch (err) {
      return { success: false, error: 'Network error: ' + err.message };
    }
  }

  /** Generic GET to the backend. `params` is a plain object of query params. */
  async function apiGet(params) {
    if (!SCRIPT_URL) {
      return { success: false, error: 'SCRIPT_URL is not set in ma3an-data.js yet.' };
    }
    try {
      const qs = new URLSearchParams(params || {}).toString();
      const res = await fetch(SCRIPT_URL + (qs ? '?' + qs : ''));
      return await res.json();
    } catch (err) {
      return { success: false, error: 'Network error: ' + err.message };
    }
  }

  // ============ SESSION (who's logged in) ============

  function getSession() {
    return readJSON(SESSION_KEY);
  }

  function setSession(profile) {
    writeJSON(SESSION_KEY, profile);
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function isLoggedIn() {
    const s = getSession();
    return !!(s && s.email);
  }

  /**
   * Call at the top of any page that requires a logged-in camper.
   * If nobody's logged in, sends them to login.html with a `next=`
   * param so login.html can send them back afterwards.
   * Returns the session if present, otherwise null (and has already
   * redirected, so calling code can just `return` on null).
   */
  function requireLogin() {
    const s = getSession();
    if (!s || !s.email) {
      const next = encodeURIComponent('../' + location.pathname.split('/').pop() + location.search);
      location.href = 'auth/login.html?next=' + next;
      return null;
    }
    return s;
  }

  function logout() {
    clearSession();
    localStorage.removeItem(PUBLIC_KEY);
    location.href = 'auth/login.html';
  }

  // ============ AUTH ============

  /** Logs in and stores the returned profile as the current session. */
  async function login(email, password) {
    const res = await apiPost('login', { email: email, password: password });
    if (res.success && res.profile) {
      setSession(res.profile);
    }
    return res;
  }

  /**
   * Registers a new camper. `fields` may include: email, password,
   * fullName, age, mobile, parentGuardianName, parentPhone, grade,
   * gender, team. On success, stores the new profile as the session
   * (so the camper is auto-logged-in right after signing up).
   */
  async function register(fields) {
    const res = await apiPost('register', fields);
    if (res.success && res.profile) {
      setSession(res.profile);
    }
    return res;
  }

  /** Re-fetches the logged-in camper's row and refreshes the session. */
  async function refreshProfile() {
    const s = getSession();
    if (!s || !s.email) return { success: false, error: 'Not logged in.' };
    const res = await apiGet({ action: 'getProfile', email: s.email });
    if (res.success && res.profile) {
      setSession(res.profile);
    }
    return res;
  }

  // ============ EDITING YOUR OWN DATA ============

  async function updateContact(fields) {
    const s = getSession();
    if (!s || !s.email) return { success: false, error: 'Not logged in.' };
    const res = await apiPost('updateContact', Object.assign({ email: s.email }, fields));
    if (res.success) await refreshProfile();
    return res;
  }

  async function joinTeam(team) {
    const s = getSession();
    if (!s || !s.email) return { success: false, error: 'Not logged in.' };
    const res = await apiPost('joinTeam', { email: s.email, name: s.fullName, team: team });
    if (res.success) await refreshProfile();
    return res;
  }

  async function joinGame(game) {
    const s = getSession();
    if (!s || !s.email) return { success: false, error: 'Not logged in.' };
    return apiPost('joinGame', { email: s.email, name: s.fullName, game: game });
  }

  async function leaveGame(game) {
    const s = getSession();
    if (!s || !s.email) return { success: false, error: 'Not logged in.' };
    return apiPost('leaveGame', { email: s.email, game: game });
  }

  // ============ PUBLIC DATA (teams, games, rosters) ============

  /**
   * Returns { teams: [...names], games: [...names],
   *           teamRosters: {Red:[...names]}, gameRosters: {Soccer:[...names]} }
   * Cached for PUBLIC_TTL_MS so switching between pages doesn't refetch
   * every time. Pass `true` to force a fresh fetch (e.g. right after
   * joining a team/game, when you want the new roster to show up).
   */
  async function getPublicData(forceRefresh) {
    if (!forceRefresh) {
      const cached = readJSON(PUBLIC_KEY);
      if (cached && Date.now() - cached.fetchedAt < PUBLIC_TTL_MS) {
        return cached.data;
      }
    }
    const res = await apiGet({ action: 'getPublicData' });
    if (res.success) {
      writeJSON(PUBLIC_KEY, { fetchedAt: Date.now(), data: res });
      return res;
    }
    // Fall back to stale cache (if any) rather than nothing, e.g. if
    // the network briefly fails.
    const stale = readJSON(PUBLIC_KEY);
    return stale ? stale.data : res;
  }

  // ============ MEDIA (photo links, public to view) ============

  /** Returns [{ id, url, displayUrl, caption, addedAt }, ...], newest first. No caching — media.html always wants the freshest list. */
  async function getMedia() {
    return apiGet({ action: 'getMedia' });
  }

  // ============ ADMIN ============

  async function adminGetAllProfiles(adminKey) {
    return apiGet({ action: 'getAllProfiles', adminKey: adminKey });
  }

  async function adminAddPoints(adminKey, email, delta) {
    return apiPost('addPoints', { adminKey: adminKey, email: email, delta: delta });
  }

  /** Adds/subtracts points from a WHOLE team's score at once (independent of individual campers' points). */
  async function adminAddTeamPoints(adminKey, team, delta) {
    return apiPost('addTeamPoints', { adminKey: adminKey, team: team, delta: delta });
  }

  /** Adds a Google Drive photo link (any normal share link) to media.html, with an optional caption. */
  async function adminAddMedia(adminKey, url, caption) {
    return apiPost('addMedia', { adminKey: adminKey, url: url, caption: caption });
  }

  /** Removes a photo by its `id` (from getMedia()'s response). */
  async function adminDeleteMedia(adminKey, id) {
    return apiPost('deleteMedia', { adminKey: adminKey, id: id });
  }

  global.MA3AN = {
    // camp dates
    CAMP_START, CAMP_END, CAMP_DATE_LABEL,
    // team display config
    TEAM_CAPACITY,
    // session
    getSession, setSession, clearSession, isLoggedIn, requireLogin, logout,
    // auth
    login, register, refreshProfile,
    // self-service edits
    updateContact, joinTeam, joinGame, leaveGame,
    // shared/public data
    getPublicData, getMedia,
    // admin
    adminGetAllProfiles, adminAddPoints, adminAddTeamPoints, adminAddMedia, adminDeleteMedia,
    // low-level, in case a page needs a custom call
    apiGet, apiPost,
  };
})(window);
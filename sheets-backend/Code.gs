/**
 * MA3AN Camp Teams — Google Sheets "backend" (v2 — real login)
 * ==============================================================
 *
 * This script manages FOUR tabs in your spreadsheet (all created
 * automatically the first time they're needed, with the header row
 * and default rows shown below):
 *
 * 1) Users  — one row per camper/account:
 *    Email address | Password | Full Name | Age | Mobile Number |
 *    Parent/Guardian Name | Parent/Guardian Phone Number | Grade |
 *    Gender | Team | Switches Remaining | Points
 *
 *    (Switches Remaining / Points are extra bookkeeping fields the
 *    site uses — team-selection.html for switching teams, admin.html
 *    for points — appended after the columns you asked for.)
 *
 * 2) Teams — one column per team, camper names listed below:
 *    Red         | Yellow      | Blue        | Green
 *    Amira H.    | Sara T.     | Youssef K.  | Nadine R.
 *    Omar S.     |             | Layla M.    |
 *    (kept in sync automatically whenever a camper joins/switches
 *    a team — see handleJoinTeam)
 *
 * 3) Games — one column per game, signed-up camper names below:
 *    Chairball   | Dodgeball   | Soccer      | Big Game | Pool Time
 *    Amira H.    | Omar S.     | Sara T.     |          |
 *    (kept in sync automatically whenever a camper joins/leaves a
 *    game — see handleJoinGame / handleLeaveGame)
 *
 * 4) GameSignups — who's signed up for which game (many-to-many,
 *    one row per email+game pair):
 *    Email | Full Name | Game
 *
 * Passwords are stored SHA-256 hashed (not plaintext), but this is
 * still a lightweight, no-real-auth system — good enough for a camp
 * sign-up site, not for anything sensitive.
 *
 * Deploy this as a Web App — see README.md for steps.
 */

const USERS_SHEET_NAME = 'Users';
const TEAMS_SHEET_NAME = 'Teams';
const GAMES_SHEET_NAME = 'Games';
const GAME_SIGNUPS_SHEET_NAME = 'GameSignups';

const DEFAULT_TEAMS = ['Red', 'Yellow', 'Blue', 'Green'];
const DEFAULT_GAMES = ['Chairball', 'Dodgeball', 'Soccer', 'Big Game', 'Pool Time'];

// Simple shared-secret gate for admin actions (adding points, listing
// everyone). This is NOT real authentication — anyone with this string
// can use the admin endpoints. Change it before deploying.
const ADMIN_KEY = 'change-me-1234';

// Users sheet columns, in order. Keep this in sync with the header
// row below if you ever change it.
const USER_FIELDS = [
  'email', 'password', 'fullName', 'age', 'mobile',
  'parentGuardianName', 'parentPhone', 'grade', 'gender', 'team',
  'switchesRemaining', 'points'
];
const USER_HEADER_ROW = [
  'Email address', 'Password', 'Full Name', 'Age', 'Mobile Number',
  'Parent/Guardian Name', 'Parent/Guardian Phone Number', 'Grade',
  'Gender', 'Team', 'Switches Remaining', 'Points'
];

/**
 * Handles POST requests from ma3an-data.js. Routes on `action`:
 *   - action:"register"      -> create a new account
 *   - action:"login"         -> check email+password, return profile
 *   - action:"updateContact" -> update mobile / parent info
 *   - action:"joinTeam"      -> join/switch a camper's team
 *   - action:"joinGame"      -> sign up for a game
 *   - action:"leaveGame"     -> drop a game
 *   - action:"addPoints"     -> [ADMIN] add/subtract a camper's points
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'No data received.' });
    }

    const data = JSON.parse(e.postData.contents);
    const action = data.action || '';

    switch (action) {
      case 'register':       return handleRegister(data);
      case 'login':          return handleLogin(data);
      case 'updateContact':  return handleUpdateContact(data);
      case 'joinTeam':       return handleJoinTeam(data);
      case 'joinGame':
      case 'joinSport':      return handleJoinGame(data);   // 'joinSport' kept as an alias
      case 'leaveGame':
      case 'leaveSport':     return handleLeaveGame(data);  // 'leaveSport' kept as an alias
      case 'addPoints':      return handleAddPoints(data);
      default:
        return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

/**
 * Handles GET requests.
 *   ?action=getProfile&email=...        -> one camper's profile (no password)
 *   ?action=getPublicData                -> { teams, games, teamRosters, gameRosters, teamScores }
 *   ?action=getTeamRosters               -> { Red:[names], Blue:[...], ... }
 *   ?action=getSportRosters               -> alias of getGameRosters (back-compat)
 *   ?action=getGameRosters                -> { Soccer:[names], Dodgeball:[...], ... }
 *   ?action=getAllProfiles&adminKey=...  -> [ADMIN] every camper (for admin.html)
 *   (no params)                          -> health check
 */
function doGet(e) {
  const action = e.parameter && e.parameter.action;

  if (action === 'getProfile') return handleGetProfile(e.parameter.email);
  if (action === 'getPublicData') return handleGetPublicData();
  if (action === 'getTeamRosters') return handleGetTeamRosters();
  if (action === 'getGameRosters' || action === 'getSportRosters') return handleGetGameRosters();
  if (action === 'getAllProfiles') return handleGetAllProfiles(e.parameter.adminKey);

  return jsonResponse({ status: 'MA3AN registration API is running.' });
}

function checkAdminKey(key) {
  return ADMIN_KEY && key === ADMIN_KEY;
}

/* ============================================================
   Auth — register & login
============================================================ */

/**
 * Creates a new account. Required: email, password, fullName.
 * Optional: age, mobile, parentGuardianName, parentPhone, grade,
 * gender, team. Rejects duplicate emails. Stores a hashed password.
 * Returns { success:true, profile: {...no password...} } so the
 * frontend can log the camper in immediately after signing up.
 */
function handleRegister(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  const password = (data.password || '').toString();
  const fullName = (data.fullName || data.name || '').toString().trim();

  if (!email || !password || !fullName) {
    return jsonResponse({ success: false, error: 'Email, password, and full name are required.' });
  }
  if (!isValidEmail(email)) {
    return jsonResponse({ success: false, error: 'Please provide a valid email address.' });
  }
  if (password.length < 8) {
    return jsonResponse({ success: false, error: 'Password must be at least 8 characters.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getUsersSheet();
    const rows = sheet.getDataRange().getValues();
    const emailCol = USER_FIELDS.indexOf('email');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        return jsonResponse({ success: false, error: 'This email is already registered.' });
      }
    }

    const newRow = USER_FIELDS.map(field => {
      if (field === 'email') return email;
      if (field === 'password') return hashPassword(password);
      if (field === 'fullName') return fullName;
      if (field === 'age') return (data.age || '').toString().trim();
      if (field === 'mobile') return (data.mobile || '').toString().trim();
      if (field === 'parentGuardianName') return (data.parentGuardianName || '').toString().trim();
      if (field === 'parentPhone') return (data.parentPhone || '').toString().trim();
      if (field === 'grade') return (data.grade || '').toString().trim();
      if (field === 'gender') return (data.gender || '').toString().trim();
      if (field === 'team') return (data.team || '').toString().trim();
      if (field === 'switchesRemaining') return 3;
      if (field === 'points') return 0;
      return '';
    });
    sheet.appendRow(newRow);

    return jsonResponse({ success: true, profile: rowToProfile(newRow) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Checks email+password against the Users sheet. Returns the
 * camper's profile (without the password) on success.
 */
function handleLogin(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  const password = (data.password || '').toString();

  if (!email || !password) {
    return jsonResponse({ success: false, error: 'Email and password are required.' });
  }

  const sheet = getUsersSheet();
  const rows = sheet.getDataRange().getValues();
  const emailCol = USER_FIELDS.indexOf('email');
  const passwordCol = USER_FIELDS.indexOf('password');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][emailCol]).toLowerCase() === email) {
      const stored = String(rows[i][passwordCol]);
      if (stored !== hashPassword(password)) {
        return jsonResponse({ success: false, error: 'Incorrect email or password.' });
      }
      return jsonResponse({ success: true, profile: rowToProfile(rows[i]) });
    }
  }

  return jsonResponse({ success: false, error: 'Incorrect email or password.' });
}

/** Turns a Users row array into a profile object, with password removed. */
function rowToProfile(row) {
  const profile = {};
  USER_FIELDS.forEach((field, idx) => {
    if (field === 'password') return; // never send this to the frontend
    profile[field] = row[idx];
  });
  return profile;
}

/* ============================================================
   Profile — read & edit
============================================================ */

function handleGetProfile(email) {
  email = (email || '').toString().trim().toLowerCase();
  if (!email) {
    return jsonResponse({ success: false, error: 'Missing email parameter.' });
  }

  const sheet = getUsersSheet();
  const rows = sheet.getDataRange().getValues();
  const emailCol = USER_FIELDS.indexOf('email');

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][emailCol]).toLowerCase() === email) {
      return jsonResponse({ success: true, profile: rowToProfile(rows[i]) });
    }
  }

  return jsonResponse({ success: false, error: 'No account found for this email.' });
}

/**
 * Updates fields on a camper's existing Users row: mobile,
 * parentGuardianName, parentPhone, age, grade, gender. This is what
 * camp-registration.html calls after signup to fill in the rest of
 * a camper's details (only fields present in the request are
 * touched — anything omitted is left as-is). Email/password/
 * fullName/team are NOT editable here: email+password only change
 * via register/login, and team changes go through joinTeam so the
 * switch-limit logic stays correct.
 */
function handleUpdateContact(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  if (!email) {
    return jsonResponse({ success: false, error: 'Missing email.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getUsersSheet();
    const rows = sheet.getDataRange().getValues();
    const emailCol = USER_FIELDS.indexOf('email');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        const rowNum = i + 1;
        ['mobile', 'parentGuardianName', 'parentPhone', 'age', 'grade', 'gender'].forEach(field => {
          if (data[field] !== undefined && data[field] !== null) {
            const col = USER_FIELDS.indexOf(field);
            sheet.getRange(rowNum, col + 1).setValue(String(data[field]).trim());
          }
        });
        return jsonResponse({ success: true, profile: rowToProfile(sheet.getRange(rowNum, 1, 1, USER_FIELDS.length).getValues()[0]) });
      }
    }
    return jsonResponse({ success: false, error: 'No account found for this email.' });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   Teams — join/switch a team, list rosters
============================================================ */

/**
 * Sets (or switches) a camper's team.
 * - First time picking a team: free, no switch consumed.
 * - Changing to a different team later: consumes one of the
 *   camper's remaining switches (default 3), refused once at 0.
 */
function handleJoinTeam(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  const team = (data.team || '').toString().trim();

  if (!email) {
    return jsonResponse({ success: false, error: 'Missing email.' });
  }
  const validTeams = getTeamsList();
  if (validTeams.indexOf(team) === -1) {
    return jsonResponse({ success: false, error: 'Unknown team: ' + team });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getUsersSheet();
    const rows = sheet.getDataRange().getValues();
    const emailCol = USER_FIELDS.indexOf('email');
    const teamCol = USER_FIELDS.indexOf('team');
    const switchesCol = USER_FIELDS.indexOf('switchesRemaining');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        const rowNum = i + 1;
        const currentTeam = rows[i][teamCol];
        const fullName = rows[i][USER_FIELDS.indexOf('fullName')];
        let switchesRemaining = Number(rows[i][switchesCol]);
        if (isNaN(switchesRemaining)) switchesRemaining = 3;

        if (currentTeam === team) {
          return jsonResponse({ success: true, team: team, switchesRemaining: switchesRemaining });
        }
        if (currentTeam) { // already had a team -> this is a real switch
          if (switchesRemaining <= 0) {
            return jsonResponse({ success: false, error: 'No switches remaining.', switchesRemaining: 0 });
          }
          switchesRemaining--;
        }

        sheet.getRange(rowNum, teamCol + 1).setValue(team);
        sheet.getRange(rowNum, switchesCol + 1).setValue(switchesRemaining);

        // Keep the pivoted Teams sheet (one column per team) in sync.
        const teamsSheet = getTeamsSheet();
        if (currentTeam) removeFromColumn(teamsSheet, currentTeam, fullName);
        appendToColumn(teamsSheet, team, fullName);

        return jsonResponse({ success: true, team: team, switchesRemaining: switchesRemaining });
      }
    }
    return jsonResponse({ success: false, error: 'No account found for this email.' });
  } finally {
    lock.releaseLock();
  }
}

/** Returns { Red: ["Name1","Name2"], Yellow: [...], ... } read straight from the Teams sheet's columns. */
function handleGetTeamRosters() {
  return jsonResponse({ success: true, rosters: readRosterSheet(getTeamsSheet()) });
}

/* ============================================================
   Games — join/leave a game, list rosters
============================================================ */

/**
 * Adds a camper to a game's roster. A camper can join multiple games
 * (one row per email+game pair); joining the same game twice is a
 * no-op rather than a duplicate row.
 */
function handleJoinGame(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  const name = (data.name || data.fullName || '').toString().trim();
  const game = (data.game || data.sport || '').toString().trim();

  if (!email || !game) {
    return jsonResponse({ success: false, error: 'Email and game are required.' });
  }
  const validGames = getGamesList();
  if (validGames.indexOf(game) === -1) {
    return jsonResponse({ success: false, error: 'Unknown game: ' + game });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getGameSignupsSheet();
    const rows = sheet.getDataRange().getValues();

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).toLowerCase() === email && rows[i][2] === game) {
        return jsonResponse({ success: true }); // already joined
      }
    }
    sheet.appendRow([email, name, game]);

    // Keep the pivoted Games sheet (one column per game) in sync.
    appendToColumn(getGamesSheet(), game, name);

    return jsonResponse({ success: true });
  } finally {
    lock.releaseLock();
  }
}

/** Removes a camper from a game's roster. */
function handleLeaveGame(data) {
  const email = (data.email || '').toString().trim().toLowerCase();
  const game = (data.game || data.sport || '').toString().trim();

  if (!email || !game) {
    return jsonResponse({ success: false, error: 'Email and game are required.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getGameSignupsSheet();
    const rows = sheet.getDataRange().getValues();

    for (let i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][0]).toLowerCase() === email && rows[i][2] === game) {
        sheet.deleteRow(i + 1);
      }
    }

    // Keep the pivoted Games sheet (one column per game) in sync.
    const fullName = getFullNameByEmail(email);
    if (fullName) removeFromColumn(getGamesSheet(), game, fullName);

    return jsonResponse({ success: true });
  } finally {
    lock.releaseLock();
  }
}

/** Returns { "Soccer": ["Name1", ...], "Dodgeball": [...], ... } read straight from the Games sheet's columns. */
function handleGetGameRosters() {
  return jsonResponse({ success: true, rosters: readRosterSheet(getGamesSheet()) });
}

/* ============================================================
   Public data — one call for everything a page needs that isn't
   private to a specific camper (teams, games, and both rosters).
============================================================ */
function handleGetPublicData() {
  const teamRosters = JSON.parse(handleGetTeamRosters().getContent()).rosters;
  const gameRosters = JSON.parse(handleGetGameRosters().getContent()).rosters;
  return jsonResponse({
    success: true,
    teams: getTeamsList(),
    games: getGamesList(),
    teamRosters: teamRosters,
    gameRosters: gameRosters,
    teamScores: getTeamScores(),
  });
}

/**
 * Returns { Red: 120, Yellow: 80, Blue: 95, Green: 60 } — total points
 * per team, summed across every camper on that team. This is safe to
 * expose publicly (no emails/passwords/personal info), and is what
 * powers the dashboard's "Scoreboard" / "Your Standing" cards.
 */
function getTeamScores() {
  const sheet = getUsersSheet();
  const rows = sheet.getDataRange().getValues();
  const teamCol = USER_FIELDS.indexOf('team');
  const pointsCol = USER_FIELDS.indexOf('points');

  const scores = {};
  getTeamsList().forEach(t => scores[t] = 0);

  for (let i = 1; i < rows.length; i++) {
    const team = rows[i][teamCol];
    if (!team || !scores.hasOwnProperty(team)) continue;
    let points = Number(rows[i][pointsCol]);
    if (isNaN(points)) points = 0;
    scores[team] += points;
  }
  return scores;
}

/* ============================================================
   Admin — add points, list every camper (used by admin.html)
============================================================ */
function handleAddPoints(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }

  const email = (data.email || '').toString().trim().toLowerCase();
  const delta = Number(data.delta);

  if (!email) return jsonResponse({ success: false, error: 'Missing email.' });
  if (isNaN(delta) || delta === 0) {
    return jsonResponse({ success: false, error: 'Provide a non-zero numeric "delta".' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getUsersSheet();
    const rows = sheet.getDataRange().getValues();
    const emailCol = USER_FIELDS.indexOf('email');
    const pointsCol = USER_FIELDS.indexOf('points');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        const rowNum = i + 1;
        let current = Number(rows[i][pointsCol]);
        if (isNaN(current)) current = 0;
        const updated = current + delta;
        sheet.getRange(rowNum, pointsCol + 1).setValue(updated);
        return jsonResponse({ success: true, points: updated });
      }
    }
    return jsonResponse({ success: false, error: 'No camper found with that email.' });
  } finally {
    lock.releaseLock();
  }
}

function handleGetAllProfiles(adminKey) {
  if (!checkAdminKey(adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }

  const sheet = getUsersSheet();
  const rows = sheet.getDataRange().getValues();
  const nameCol = USER_FIELDS.indexOf('fullName');
  const emailCol = USER_FIELDS.indexOf('email');
  const teamCol = USER_FIELDS.indexOf('team');
  const pointsCol = USER_FIELDS.indexOf('points');

  const profiles = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][emailCol]) continue;
    let points = Number(rows[i][pointsCol]);
    if (isNaN(points)) points = 0;
    profiles.push({
      name: rows[i][nameCol] || '(no name)',
      email: rows[i][emailCol],
      team: rows[i][teamCol] || '',
      points: points,
    });
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({ success: true, profiles: profiles });
}

/* ============================================================
   Sheet getters — create each tab (with headers/defaults) the
   first time it's needed.
============================================================ */
function getUsersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
    sheet.appendRow(USER_HEADER_ROW);
  }
  return sheet;
}

function getTeamsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TEAMS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TEAMS_SHEET_NAME);
    sheet.appendRow(DEFAULT_TEAMS); // one column per team; names are appended below as campers join
  }
  return sheet;
}

function getGamesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(GAMES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(GAMES_SHEET_NAME);
    sheet.appendRow(DEFAULT_GAMES); // one column per game; names are appended below as campers sign up
  }
  return sheet;
}

function getGameSignupsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(GAME_SIGNUPS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(GAME_SIGNUPS_SHEET_NAME);
    sheet.appendRow(['Email', 'Full Name', 'Game']);
  }
  return sheet;
}

/** Reads the Teams sheet's header row (row 1) into an array of team names. */
function getTeamsList() {
  const sheet = getTeamsSheet();
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const list = headers.map(h => String(h).trim()).filter(Boolean);
  return list.length ? list : DEFAULT_TEAMS.slice();
}

/** Reads the Games sheet's header row (row 1) into an array of game names. */
function getGamesList() {
  const sheet = getGamesSheet();
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const list = headers.map(h => String(h).trim()).filter(Boolean);
  return list.length ? list : DEFAULT_GAMES.slice();
}

/**
 * Reads a "pivoted" roster sheet — header row (row 1) = category
 * names (team or game names), each column below = the members in
 * that category — into { CategoryName: ["Name1", "Name2", ...] }.
 * Blank cells are skipped, so ragged columns (different roster
 * sizes) are fine.
 */
function readRosterSheet(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const lastRow = sheet.getLastRow();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  const rosters = {};
  headers.forEach(h => {
    const header = String(h).trim();
    if (header) rosters[header] = [];
  });

  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    headers.forEach((h, c) => {
      const header = String(h).trim();
      if (!header) return;
      for (let r = 0; r < data.length; r++) {
        const name = data[r][c];
        if (name) rosters[header].push(name);
      }
    });
  }
  return rosters;
}

/**
 * Appends `value` to the first empty cell below the header named
 * `headerName` in `sheet` — a no-op if `value` is already listed
 * anywhere in that column (avoids duplicate entries) or if
 * `headerName` doesn't match any column.
 */
function appendToColumn(sheet, headerName, value) {
  if (!value) return;
  const col = findColumnByHeader(sheet, headerName);
  if (col === -1) return;

  const lastRow = sheet.getLastRow();
  let values = [];
  if (lastRow >= 2) {
    values = sheet.getRange(2, col, lastRow - 1, 1).getValues().map(r => r[0]);
  }
  if (values.some(v => String(v).trim() === String(value).trim())) return; // already listed

  let targetIdx = values.findIndex(v => v === '' || v === null || v === undefined);
  if (targetIdx === -1) targetIdx = values.length;
  sheet.getRange(2 + targetIdx, col).setValue(value);
}

/**
 * Removes `value` from the column named `headerName` in `sheet`,
 * shifting the remaining names up so switching/leaving doesn't
 * leave a gap in the middle of the roster.
 */
function removeFromColumn(sheet, headerName, value) {
  if (!value) return;
  const col = findColumnByHeader(sheet, headerName);
  if (col === -1) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, col, lastRow - 1, 1);
  const values = range.getValues().map(r => r[0]);
  const idx = values.findIndex(v => String(v).trim() === String(value).trim());
  if (idx === -1) return;

  values.splice(idx, 1);
  values.push('');
  range.setValues(values.map(v => [v]));
}

/** Finds the 1-based column index whose header (row 1) matches `name`. Returns -1 if not found. */
function findColumnByHeader(sheet, name) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let c = 0; c < headers.length; c++) {
    if (String(headers[c]).trim() === String(name).trim()) return c + 1;
  }
  return -1;
}

/** Looks up a camper's full name from the Users sheet by email. */
function getFullNameByEmail(email) {
  email = (email || '').toString().trim().toLowerCase();
  if (!email) return '';
  const sheet = getUsersSheet();
  const rows = sheet.getDataRange().getValues();
  const emailCol = USER_FIELDS.indexOf('email');
  const nameCol = USER_FIELDS.indexOf('fullName');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][emailCol]).toLowerCase() === email) return rows[i][nameCol];
  }
  return '';
}

/* ============================================================
   One-time migration — run manually from the Apps Script editor
   if you already had data in the old single-column Teams/Games
   sheets. Rebuilds them into the new "one column per team/game"
   layout using whatever's currently in Users/GameSignups. Safe to
   re-run; it just rebuilds both sheets from scratch each time.

   To run: open this project in script.google.com, pick
   "migrateToRosterSheets" from the function dropdown at the top,
   then click Run.
============================================================ */
function migrateToRosterSheets() {
  rebuildTeamsSheetFromUsers();
  rebuildGamesSheetFromSignups();
}

function rebuildTeamsSheetFromUsers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldSheet = ss.getSheetByName(TEAMS_SHEET_NAME);

  // If the old sheet still looks like the single-column format
  // (one column, a list of team names), preserve those names as the
  // new headers instead of assuming DEFAULT_TEAMS — in case you'd
  // added/renamed teams.
  let teamNames = DEFAULT_TEAMS.slice();
  if (oldSheet && oldSheet.getLastColumn() <= 1 && oldSheet.getLastRow() >= 2) {
    const old = oldSheet.getRange(2, 1, oldSheet.getLastRow() - 1, 1)
      .getValues().map(r => String(r[0]).trim()).filter(Boolean);
    if (old.length) teamNames = old;
  }
  if (oldSheet) ss.deleteSheet(oldSheet);

  const sheet = ss.insertSheet(TEAMS_SHEET_NAME);
  sheet.appendRow(teamNames);

  const usersSheet = getUsersSheet();
  const rows = usersSheet.getDataRange().getValues();
  const nameCol = USER_FIELDS.indexOf('fullName');
  const teamCol = USER_FIELDS.indexOf('team');

  for (let i = 1; i < rows.length; i++) {
    const team = String(rows[i][teamCol] || '').trim();
    const name = rows[i][nameCol];
    if (team && name) appendToColumn(sheet, team, name);
  }
}

function rebuildGamesSheetFromSignups() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldSheet = ss.getSheetByName(GAMES_SHEET_NAME);

  let gameNames = DEFAULT_GAMES.slice();
  if (oldSheet && oldSheet.getLastColumn() <= 1 && oldSheet.getLastRow() >= 2) {
    const old = oldSheet.getRange(2, 1, oldSheet.getLastRow() - 1, 1)
      .getValues().map(r => String(r[0]).trim()).filter(Boolean);
    if (old.length) gameNames = old;
  }
  if (oldSheet) ss.deleteSheet(oldSheet);

  const sheet = ss.insertSheet(GAMES_SHEET_NAME);
  sheet.appendRow(gameNames);

  const signupsSheet = getGameSignupsSheet();
  const rows = signupsSheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const name = rows[i][1];
    const game = String(rows[i][2] || '').trim();
    if (game && name) appendToColumn(sheet, game, name);
  }
}

/* ============================================================
   Utilities
============================================================ */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** SHA-256 hashes a password so it isn't stored in plaintext in the sheet. */
function hashPassword(password) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password);
  return bytes.map(b => {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
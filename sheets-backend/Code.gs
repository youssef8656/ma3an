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
 *    Gender | Team | Switches Remaining | Points | Member ID
 *
 *    (Switches Remaining / Points / Member ID are extra bookkeeping
 *    fields the site uses — team-selection.html for switching teams,
 *    admin.html for points, check-in.html for attendance — appended
 *    after the columns you asked for. Member ID is a short random
 *    code assigned automatically the first time each camper logs in
 *    or registers; it's what their check-in QR code encodes.)
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
 * 5) Team's Score — one column per team, ONE data row holding a
 *    direct whole-team point bonus (separate from individual campers'
 *    points), adjustable from admin.html:
 *    Red | Blue | Yellow | Green
 *    50  | -10  | 0      | 20
 *    (A team's final score, shown on the dashboard/scoreboard, is the
 *    sum of every camper's individual points on that team PLUS this
 *    bonus row — see getTeamScores().)
 *
 * 6) Media — admin-curated Google Drive links for media.html, now
 *    supporting images, PDFs, and PowerPoint files, not just photos:
 *    Google Drive URL | Caption | Added At | Kind
 *    Kind is auto-detected when the admin adds the link (image / pdf
 *    / pptx / other) — nothing to fill in by hand.
 *
 * 7) Attendance — one row per check-in event, newest last:
 *    Member ID | Email | Full Name | Team | Date | Time
 *    (written by handleCheckIn — admin.html's QR/code scanner. At
 *    most one row per camper per calendar date; scanning the same
 *    camper again the same day is a no-op, not a duplicate.)
 *
 * 8) Attendance Schedule — the full list of camp session dates/times,
 *    used only to compute each camper's "% attended" on check-in.html.
 *    Edit this tab directly to match your real schedule:
 *    Date | Time
 *    2026-08-20 | 10:00 AM
 *    2026-08-21 | 11:30 AM
 *
 * 9) Announcements — admin posts shown as a feed on schedule.html:
 *    ID | Title | Message | Posted At | Expires At (blank = forever)
 *    A post with a blank Expires At column stays up indefinitely; one
 *    with a date in that column stops showing after that date.
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
const TEAM_SCORES_SHEET_NAME = "Team's Score";
const MEDIA_SHEET_NAME = 'Media';
const ATTENDANCE_SHEET_NAME = 'Attendance';
const ATTENDANCE_SCHEDULE_SHEET_NAME = 'Attendance Schedule';
const ANNOUNCEMENTS_SHEET_NAME = 'Announcements';

const DEFAULT_TEAMS = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6', 'Team 7', 'Team 8', 'Team 9', 'Team 10', 'Team 11', 'Team 12', 'Team 13', 'Team 14', 'Team 15'];
const DEFAULT_GAMES = ['Chairball', 'Dodgeball', 'Soccer', 'Big Game', 'Pool Time'];

// Simple shared-secret gate for admin actions (adding points, listing
// everyone). This is NOT real authentication — anyone with this string
// can use the admin endpoints. Change it before deploying.
const ADMIN_KEY = 'admin123';

// Users sheet columns, in order. Keep this in sync with the header
// row below if you ever change it.
const USER_FIELDS = [
  'email', 'password', 'fullName', 'age', 'mobile',
  'parentGuardianName', 'parentPhone', 'grade', 'gender', 'team',
  'switchesRemaining', 'points', 'memberId'
];
const USER_HEADER_ROW = [
  'Email address', 'Password', 'Full Name', 'Age', 'Mobile Number',
  'Parent/Guardian Name', 'Parent/Guardian Phone Number', 'Grade',
  'Gender', 'Team', 'Switches Remaining', 'Points', 'Member ID'
];

/**
 * Handles POST requests from ma3an-data.js. Routes on `action`:
 *   - action:"register"      -> create a new account
 *   - action:"login"         -> check email+password, return profile
 *   - action:"updateContact" -> update mobile / parent info
 *   - action:"joinTeam"      -> join/switch a camper's team
 *   - action:"setCamperTeam" -> [ADMIN] assign/reassign a camper's team, no restrictions
 *   - action:"joinGame"      -> sign up for a game
 *   - action:"leaveGame"     -> drop a game *   - action:"addPoints"     -> [ADMIN] add/subtract one camper's points
 *   - action:"addTeamPoints" -> [ADMIN] add/subtract a whole team's score directly
 *   - action:"addMedia"      -> [ADMIN] add a photo link to the Media page
 *   - action:"deleteMedia"   -> [ADMIN] remove a photo link
 *   - action:"checkIn"       -> [ADMIN] mark a camper present (by scanned/typed code)
 *   - action:"addAnnouncement"    -> [ADMIN] publish an announcement to the Schedule page
 *   - action:"deleteAnnouncement" -> [ADMIN] remove an announcement
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
      case 'setCamperTeam':  return handleSetCamperTeam(data);
      case 'joinGame':
      case 'joinSport':      return handleJoinGame(data);   // 'joinSport' kept as an alias
      case 'leaveGame':
      case 'leaveSport':     return handleLeaveGame(data);  // 'leaveSport' kept as an alias
      case 'addPoints':      return handleAddPoints(data);
      case 'addTeamPoints':  return handleAddTeamPoints(data);
      case 'addMedia':       return handleAddMedia(data);
      case 'deleteMedia':    return handleDeleteMedia(data);
      case 'checkIn':        return handleCheckIn(data);
      case 'addAnnouncement':    return handleAddAnnouncement(data);
      case 'deleteAnnouncement': return handleDeleteAnnouncement(data);
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
 *   ?action=getMedia                     -> [{ id, url, displayUrl, caption, addedAt }, ...] (public)
 *   ?action=getAttendance&email=...      -> { memberId, records, schedule, percentage } for one camper
 *   ?action=getAnnouncements             -> [{ id, title, message, postedAt, expiresAt }, ...] (public, only non-expired)
 *   (no params)                          -> health check
 */
function doGet(e) {
  const action = e.parameter && e.parameter.action;

  if (action === 'getProfile') return handleGetProfile(e.parameter.email);
  if (action === 'getPublicData') return handleGetPublicData();
  if (action === 'getTeamRosters') return handleGetTeamRosters();
  if (action === 'getGameRosters' || action === 'getSportRosters') return handleGetGameRosters();
  if (action === 'getAllProfiles') return handleGetAllProfiles(e.parameter.adminKey);
  if (action === 'getMedia') return handleGetMedia();
  if (action === 'getAttendance') return handleGetAttendance(e.parameter.email);
  if (action === 'getAnnouncements') return handleGetAnnouncements();

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
      if (field === 'memberId') return generateMemberId(sheet);
      return '';
    });

    const rowNum = sheet.getLastRow() + 1;
    // Force plain-text format for fields prone to being mangled by
    // Sheets' auto-detection (phone numbers losing a leading 0, or
    // being misread as a date/number) BEFORE writing the row.
    ['mobile', 'parentPhone', 'grade'].forEach(field => {
      sheet.getRange(rowNum, USER_FIELDS.indexOf(field) + 1).setNumberFormat('@');
    });
    sheet.getRange(rowNum, 1, 1, newRow.length).setValues([newRow]);

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
      ensureMemberId(sheet, i, rows[i]);
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

/**
 * Accounts created before the check-in feature existed won't have a
 * memberId yet. This assigns one on the fly (and writes it back to
 * the sheet) the next time that camper logs in or loads their
 * profile, so nobody needs a manual migration step.
 */
function ensureMemberId(sheet, rowIndex, rowArray) {
  const col = USER_FIELDS.indexOf('memberId');
  if (rowArray[col]) return rowArray[col];
  const id = generateMemberId(sheet);
  sheet.getRange(rowIndex + 1, col + 1).setValue(id);
  rowArray[col] = id;
  return id;
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
      ensureMemberId(sheet, i, rows[i]);
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
            // Force plain-text format first for fields prone to being
            // mangled by Sheets' auto-detection (phone numbers losing
            // a leading 0, or being misread as a date/number).
            if (field === 'mobile' || field === 'parentPhone' || field === 'grade') {
              sheet.getRange(rowNum, col + 1).setNumberFormat('@');
            }
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
/**
 * Sets a camper's team — one time only. Team switching is turned
 * off: once `team` is set on a camper's row, calling this again with
 * a different team is rejected (calling it again with the SAME team
 * is a harmless no-op, not an error).
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

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        const rowNum = i + 1;
        const currentTeam = rows[i][teamCol];
        const fullName = rows[i][USER_FIELDS.indexOf('fullName')];

        if (currentTeam === team) {
          return jsonResponse({ success: true, team: team });
        }
        if (currentTeam) {
          return jsonResponse({ success: false, error: 'Team switching is turned off — your team is already set.' });
        }

        sheet.getRange(rowNum, teamCol + 1).setValue(team);

        // Keep the pivoted Teams sheet (one column per team) in sync.
        const teamsSheet = getTeamsSheet();
        appendToColumn(teamsSheet, team, fullName);

        return jsonResponse({ success: true, team: team });
      }
    }
    return jsonResponse({ success: false, error: 'No account found for this email.' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * [ADMIN] Assigns (or reassigns) a camper's team directly — no
 * switch-lock, no restrictions. This is how teams get set now that
 * there's no self-service team-picker page: the admin manages team
 * assignments from admin.html. Pass team: '' to unassign a camper
 * from their team entirely.
 */
function handleSetCamperTeam(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }

  const email = (data.email || '').toString().trim().toLowerCase();
  const team = (data.team || '').toString().trim();
  if (!email) {
    return jsonResponse({ success: false, error: 'Missing email.' });
  }
  if (team && getTeamsList().indexOf(team) === -1) {
    return jsonResponse({ success: false, error: 'Unknown team: ' + team });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getUsersSheet();
    const rows = sheet.getDataRange().getValues();
    const emailCol = USER_FIELDS.indexOf('email');
    const teamCol = USER_FIELDS.indexOf('team');
    const nameCol = USER_FIELDS.indexOf('fullName');

    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][emailCol]).toLowerCase() === email) {
        const rowNum = i + 1;
        const currentTeam = rows[i][teamCol];
        const fullName = rows[i][nameCol];

        if (currentTeam === team) {
          return jsonResponse({ success: true, team: team });
        }

        sheet.getRange(rowNum, teamCol + 1).setValue(team);

        const teamsSheet = getTeamsSheet();
        if (currentTeam) removeFromColumn(teamsSheet, currentTeam, fullName);
        if (team) appendToColumn(teamsSheet, team, fullName);

        return jsonResponse({ success: true, team: team });
      }
    }
    return jsonResponse({ success: false, error: 'No account found for this email.' });
  } finally {
    lock.releaseLock();
  }
}
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
 * per team. This is the SUM of two things: every camper's individual
 * points on that team (admin.html's per-camper +/- controls), PLUS a
 * direct whole-team bonus/penalty from the "Team's Score" sheet
 * (admin.html's per-team +/- controls, e.g. for awarding a whole team
 * points after winning a group activity). Safe to expose publicly (no
 * emails/passwords/personal info) — powers the dashboard's
 * "Scoreboard" / "Your Standing" cards.
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

  const bonuses = getTeamBonuses();
  Object.keys(bonuses).forEach(team => {
    if (scores.hasOwnProperty(team)) scores[team] += bonuses[team];
  });

  return scores;
}

/**
 * [ADMIN] Adds (or subtracts, with a negative delta) points directly
 * to/from a WHOLE team's score at once — e.g. "Green team won the Big
 * Game, +50" — independent of any individual camper's points. Stored
 * in the "Team's Score" sheet.
 */
function handleAddTeamPoints(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }

  const team = (data.team || '').toString().trim();
  const delta = Number(data.delta);

  if (getTeamsList().indexOf(team) === -1) {
    return jsonResponse({ success: false, error: 'Unknown team: ' + team });
  }
  if (isNaN(delta) || delta === 0) {
    return jsonResponse({ success: false, error: 'Provide a non-zero numeric "delta".' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getTeamScoresSheet();
    const col = findColumnByHeader(sheet, team);
    if (col === -1) {
      return jsonResponse({ success: false, error: 'Team column not found in the "Team\'s Score" sheet.' });
    }
    const cell = sheet.getRange(2, col);
    let current = Number(cell.getValue());
    if (isNaN(current)) current = 0;
    const updated = current + delta;
    cell.setValue(updated);

    return jsonResponse({ success: true, team: team, teamBonus: updated, teamScores: getTeamScores() });
  } finally {
    lock.releaseLock();
  }
}

/** Reads the "Team's Score" sheet's one data row into { Red: 50, Blue: -10, ... }. */
function getTeamBonuses() {
  const sheet = getTeamScoresSheet();
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const values = sheet.getRange(2, 1, 1, lastCol).getValues()[0];

  const bonuses = {};
  headers.forEach((h, i) => {
    const header = String(h).trim();
    if (!header) return;
    let v = Number(values[i]);
    if (isNaN(v)) v = 0;
    bonuses[header] = v;
  });
  return bonuses;
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
   Media — admin-curated Google Drive links, shown on media.html.
   Supports images, PDFs, and PowerPoint files (not just photos).
   Public to read (just links, nothing private); admin-key gated to
   add/remove.
============================================================ */

/** Public: returns every media item, newest first. */
function handleGetMedia() {
  const sheet = getMediaSheet();
  const rows = sheet.getDataRange().getValues();

  const media = [];
  for (let i = 1; i < rows.length; i++) {
    const url = rows[i][0];
    if (!url) continue;
    const kind = rows[i][3] || detectDriveFileKind(url);
    media.push({
      id: i + 1, // the actual sheet row number, used to delete later
      url: url,
      kind: kind, // 'image' | 'pdf' | 'pptx' | 'other'
      displayUrl: toDriveThumbnailUrl(url),
      previewUrl: toDrivePreviewUrl(url),
      caption: rows[i][1] || '',
      addedAt: rows[i][2] || '',
    });
  }
  media.reverse();
  return jsonResponse({ success: true, media: media });
}

/** [ADMIN] Adds one Google Drive link — image, PDF, or PowerPoint file (any normal "share" link works). */
function handleAddMedia(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }
  const url = (data.url || '').toString().trim();
  const caption = (data.caption || '').toString().trim();
  if (!url) {
    return jsonResponse({ success: false, error: 'Missing file URL.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getMediaSheet();
    const kind = detectDriveFileKind(url);
    const rowNum = sheet.getLastRow() + 1;

    // Force Caption (col 2) to plain-text before writing — same
    // "5pm becomes a Date" issue as Announcements can happen here too.
    sheet.getRange(rowNum, 2).setNumberFormat('@');
    sheet.getRange(rowNum, 1, 1, 4).setValues([[url, caption, new Date(), kind]]);

    return jsonResponse({ success: true, kind: kind });
  } finally {
    lock.releaseLock();
  }
}

/** [ADMIN] Removes one photo by its row id (the `id` field from getMedia). */
function handleDeleteMedia(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }
  const id = Number(data.id);
  if (!id || id < 2) {
    return jsonResponse({ success: false, error: 'Missing or invalid photo id.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getMediaSheet();
    if (id > sheet.getLastRow()) {
      return jsonResponse({ success: false, error: 'That photo no longer exists.' });
    }
    sheet.deleteRow(id);
    return jsonResponse({ success: true });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Pulls the file ID out of any common Google Drive "share" link
 * shape (.../file/d/FILE_ID/view, ?id=FILE_ID, open?id=FILE_ID).
 * Returns '' if the URL doesn't look like a Drive link at all.
 */
function extractDriveFileId(url) {
  const patterns = [/\/file\/d\/([^/]+)/, /[?&]id=([^&]+)/];
  for (const p of patterns) {
    const m = String(url).match(p);
    if (m && m[1]) return m[1];
  }
  return '';
}

/**
 * Turns a Google Drive "share" link into Drive's universal thumbnail
 * URL — this works for images, PDFs, AND PowerPoint/Slides files
 * (Drive renders the first slide as the thumbnail for presentations),
 * so it's used as the display image for every kind of media item,
 * not just photos. Requires the file to be shared "Anyone with the
 * link can view" — falls back to the original URL if it doesn't look
 * like a Drive link at all.
 */
function toDriveThumbnailUrl(url) {
  const id = extractDriveFileId(url);
  return id ? 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000' : url;
}

/**
 * Turns a Google Drive "share" link into a URL that works directly
 * in an <img src>. Falls back to the original URL untouched if it
 * doesn't look like a Drive link (e.g. a direct image URL from
 * elsewhere).
 */
function toDriveImageUrl(url) {
  const id = extractDriveFileId(url);
  return id ? 'https://lh3.googleusercontent.com/d/' + id : url;
}

/**
 * Turns a Google Drive "share" link into Drive's embeddable preview
 * URL — works for PDFs and PowerPoint/Office files as well as
 * images, and is safe to use in an <iframe> or just as a normal link
 * (it opens Drive's built-in viewer). Falls back to the original URL
 * if it doesn't look like a Drive link.
 */
function toDrivePreviewUrl(url) {
  const id = extractDriveFileId(url);
  return id ? 'https://drive.google.com/file/d/' + id + '/preview' : url;
}

/**
 * Figures out whether a Drive link points at an image, a PDF, a
 * PowerPoint file, or something else, using DriveApp (runs with the
 * deploying admin's Drive access, so this only works for files that
 * admin can open — e.g. shared "Anyone with the link" or owned by
 * them). Falls back to 'other' if the file can't be inspected (link
 * not shared with the script's account, isn't a Drive link, etc.) —
 * it still gets added, just without a detected type.
 */
function detectDriveFileKind(url) {
  const id = extractDriveFileId(url);
  if (!id) return 'other';
  try {
    const mimeType = DriveApp.getFileById(id).getMimeType();
    if (mimeType.indexOf('image/') === 0) return 'image';
    if (mimeType === 'application/pdf') return 'pdf';
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.google-apps.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint'
    ) return 'pptx';
    return 'other';
  } catch (err) {
    return 'other'; // not accessible to the script's account, or some other lookup failure
  }
}

/* ============================================================
   Attendance — check-in.html shows every camper a personal QR
   code (their Member ID); admin.html scans it (or an admin types
   the code manually) to mark that camper present.
============================================================ */

/**
 * [ADMIN] Marks one camper present "today". Looks the camper up by
 * their Member ID (what the QR code encodes / what's typed manually).
 * Scanning the same camper twice on the same calendar date is a
 * no-op, not a duplicate row — so it's safe to re-scan by accident.
 */
function handleCheckIn(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }

  const code = (data.code || '').toString().trim().toUpperCase();
  if (!code) {
    return jsonResponse({ success: false, error: 'Missing member code.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const usersSheet = getUsersSheet();
    const rows = usersSheet.getDataRange().getValues();
    const idCol = USER_FIELDS.indexOf('memberId');
    const nameCol = USER_FIELDS.indexOf('fullName');
    const emailCol = USER_FIELDS.indexOf('email');
    const teamCol = USER_FIELDS.indexOf('team');

    let match = null;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][idCol]).toUpperCase() === code) { match = rows[i]; break; }
    }
    if (!match) {
      return jsonResponse({ success: false, error: 'No camper found with that code.' });
    }

    const now = new Date();
    const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'h:mm a');

    const attendanceSheet = getAttendanceSheet();
    const attRows = attendanceSheet.getDataRange().getValues();
    let alreadyToday = false;
    for (let i = 1; i < attRows.length; i++) {
      if (String(attRows[i][0]).toUpperCase() === code && attRows[i][4] === dateStr) {
        alreadyToday = true;
        break;
      }
    }
    if (!alreadyToday) {
      attendanceSheet.appendRow([code, match[emailCol], match[nameCol], match[teamCol], dateStr, timeStr]);
    }

    return jsonResponse({
      success: true,
      alreadyCheckedIn: alreadyToday,
      member: { fullName: match[nameCol], team: match[teamCol], date: dateStr, time: timeStr },
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * One camper's own attendance history + attendance percentage, for
 * check-in.html. Percentage = distinct dates that camper checked in
 * on, divided by the total number of dates in the "Attendance
 * Schedule" sheet (0% if that sheet has no rows yet).
 */
function handleGetAttendance(email) {
  email = (email || '').toString().trim().toLowerCase();
  if (!email) {
    return jsonResponse({ success: false, error: 'Missing email parameter.' });
  }

  const usersSheet = getUsersSheet();
  const userRows = usersSheet.getDataRange().getValues();
  const emailCol = USER_FIELDS.indexOf('email');
  const idCol = USER_FIELDS.indexOf('memberId');

  let memberId = '';
  for (let i = 1; i < userRows.length; i++) {
    if (String(userRows[i][emailCol]).toLowerCase() === email) {
      memberId = ensureMemberId(usersSheet, i, userRows[i]);
      break;
    }
  }
  if (!memberId) {
    return jsonResponse({ success: false, error: 'No account found for this email.' });
  }

  const attendanceSheet = getAttendanceSheet();
  const attRows = attendanceSheet.getDataRange().getValues();
  const records = [];
  for (let i = 1; i < attRows.length; i++) {
    if (String(attRows[i][0]).toUpperCase() === memberId.toUpperCase()) {
      records.push({ date: attRows[i][4], time: attRows[i][5] });
    }
  }
  records.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const scheduleSheet = getAttendanceScheduleSheet();
  const schedRows = scheduleSheet.getDataRange().getValues();
  const schedule = [];
  for (let i = 1; i < schedRows.length; i++) {
    if (schedRows[i][0]) schedule.push({ date: schedRows[i][0], time: schedRows[i][1] || '' });
  }

  const attendedDates = new Set(records.map(r => String(r.date)));
  const percentage = schedule.length
    ? Math.round((attendedDates.size / schedule.length) * 100)
    : 0;

  return jsonResponse({
    success: true,
    memberId: memberId,
    records: records,
    schedule: schedule,
    percentage: percentage,
  });
}

/** Generates a short, unique, easy-to-type code like "K7QX2M" for a camper's QR/check-in code. */
function generateMemberId(sheet) {
  const idCol = USER_FIELDS.indexOf('memberId');
  const existing = new Set(
    sheet.getDataRange().getValues().slice(1).map(r => String(r[idCol]).toUpperCase()).filter(Boolean)
  );
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to type by hand
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (existing.has(id));
  return id;
}

/* ============================================================
   Announcements — admin posts shown as a feed on schedule.html.
   Each post either stays up forever or auto-hides after a date the
   admin picks.
============================================================ */

/** Public: every announcement that hasn't expired yet, newest first. */
function handleGetAnnouncements() {
  const sheet = getAnnouncementsSheet();
  const rows = sheet.getDataRange().getValues();
  const now = new Date();

  const posts = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, title, message, postedAt, expiresAt] = rows[i];
    if (!id) continue;
    if (expiresAt) {
      const exp = new Date(expiresAt);
      if (!isNaN(exp) && exp < now) continue; // expired — skip it
    }
    posts.push({
      id: id,
      title: title,
      message: message,
      postedAt: postedAt,
      expiresAt: expiresAt || null,
    });
  }
  posts.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  return jsonResponse({ success: true, announcements: posts });
}

/**
 * [ADMIN] Publishes a new announcement. `expiresAt` is optional —
 * omit it (or send an empty string) for a post that stays up
 * forever; otherwise send a date (e.g. "2026-08-25") and it'll stop
 * showing on schedule.html after that date.
 */
function handleAddAnnouncement(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }
  const title = (data.title || '').toString().trim();
  const message = (data.message || '').toString().trim();
  const expiresAt = (data.expiresAt || '').toString().trim();

  if (!title || !message) {
    return jsonResponse({ success: false, error: 'Title and message are required.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAnnouncementsSheet();
    const id = 'A' + new Date().getTime();
    const rowNum = sheet.getLastRow() + 1;

    // Force Title (col 2) and Message (col 3) to plain-text format
    // BEFORE writing — otherwise Sheets auto-converts text that looks
    // like a time/date/number (e.g. "5pm", "3/4", "10") into a real
    // Date value, which reads back as a garbled timestamp later.
    sheet.getRange(rowNum, 2, 1, 2).setNumberFormat('@');
    sheet.getRange(rowNum, 1, 1, 5).setValues([[id, title, message, new Date(), expiresAt || '']]);

    return jsonResponse({ success: true, id: id });
  } finally {
    lock.releaseLock();
  }
}

/** [ADMIN] Removes an announcement by its id. */
function handleDeleteAnnouncement(data) {
  if (!checkAdminKey(data.adminKey)) {
    return jsonResponse({ success: false, error: 'Invalid admin key.' });
  }
  const id = (data.id || '').toString().trim();
  if (!id) {
    return jsonResponse({ success: false, error: 'Missing announcement id.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getAnnouncementsSheet();
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === id) {
        sheet.deleteRow(i + 1);
        return jsonResponse({ success: true });
      }
    }
    return jsonResponse({ success: false, error: 'That announcement no longer exists.' });
  } finally {
    lock.releaseLock();
  }
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

/**
 * One column per team, ONE data row (row 2) holding that team's
 * direct point bonus (added/subtracted as a whole via admin.html,
 * separate from individual campers' points). Starts at 0 for every
 * team.
 */
function getTeamScoresSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TEAM_SCORES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TEAM_SCORES_SHEET_NAME);
    const teams = getTeamsList();
    sheet.appendRow(teams);
    sheet.appendRow(teams.map(() => 0));
  }
  return sheet;
}

/** Media links for media.html: URL | Caption | Added At | Kind (image/pdf/pptx/other) — one row per item. */
function getMediaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEDIA_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MEDIA_SHEET_NAME);
    sheet.appendRow(['Google Drive URL', 'Caption', 'Added At', 'Kind']);
  }
  return sheet;
}

/** One row per check-in event: Member ID | Email | Full Name | Team | Date | Time. */
function getAttendanceSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET_NAME);
    sheet.appendRow(['Member ID', 'Email', 'Full Name', 'Team', 'Date', 'Time']);
  }
  return sheet;
}

/**
 * The full list of camp session dates/times — edit this tab directly
 * to match your real schedule. Only used to compute "% attended".
 * Seeded with placeholder example dates so the sheet isn't empty;
 * replace these with your actual camp dates.
 */
function getAttendanceScheduleSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ATTENDANCE_SCHEDULE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SCHEDULE_SHEET_NAME);
    sheet.appendRow(['Date', 'Time']);
    sheet.appendRow(['2026-08-20', '10:00 AM']);
    sheet.appendRow(['2026-08-21', '11:30 AM']);
    sheet.appendRow(['2026-08-22', '2:00 PM']);
    sheet.appendRow(['2026-08-23', '4:00 PM']);
    sheet.appendRow(['2026-08-24', '10:00 AM']);
    sheet.appendRow(['2026-08-25', '11:30 AM']);
    sheet.appendRow(['2026-08-26', '2:00 PM']);
    sheet.appendRow(['2026-08-27', '4:00 PM']);
  }
  return sheet;
}

/** One row per announcement: ID | Title | Message | Posted At | Expires At (blank = never). */
function getAnnouncementsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ANNOUNCEMENTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ANNOUNCEMENTS_SHEET_NAME);
    sheet.appendRow(['ID', 'Title', 'Message', 'Posted At', 'Expires At (blank = forever)']);
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
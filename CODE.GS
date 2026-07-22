/* ═══════════════════════════════════════════════════════════════
   HAMRO AFNAI v4.0 FINAL — Complete Google Apps Script Backend
   Flow: Signup → Auto-Trial (24h) → Payment → Admin Verify → Permanent
   Admin login shares endpoint, opens separate admin world.
   Offline-first: Once paid, access never removed.
   ═══════════════════════════════════════════════════════════════ */

/* ── ADMIN CREDENTIALS ───────────────────────────────────────── */
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD_DEFAULT = "ChangeMe123!";   // ⚠️ CHANGE THIS IMMEDIATELY (via admin.html's Change Password, or edit here before first deploy)

// The admin password can be changed at runtime (see adminChangePassword),
// so it can't live in a plain `const` — this reads the current value from
// PropertiesService, falling back to the default above until it's changed.
function getAdminPassword_() {
  const stored = PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD");
  return stored || ADMIN_PASSWORD_DEFAULT;
}

/* ── SHEET CONFIG ── */
const USERS_SHEET     = "Users";
const PAYMENTS_SHEET  = "Payments";
const SETTINGS_SHEET  = "Settings";
const LOGS_SHEET      = "Logs";

const USER_HEADERS = [
  "username", "passHash", "name", "email", "mobile",
  "contact", "contactType", "status", "createdAt", "approvedAt",
  "role", "trialExpiresAt", "paymentStatus", "permanentAccess",
  "accessType", "accessExpiresAt", "sessionToken", "sessionTokenExpiresAt"
];

const PAYMENT_HEADERS = [
  "username", "name", "email", "mobile", "txId", "remarks",
  "status", "rejectionReason", "screenshotUrl", "submittedAt", "reviewedAt"
];

const SETTINGS_HEADERS = ["key", "value"];
const LOG_HEADERS = ["timestamp", "admin", "action", "target", "details"];

const TRIAL_HOURS = 24;

/* ═══════════════════════════════════════════════════════════════
   ENTRY POINTS — Bulletproof
   ═══════════════════════════════════════════════════════════════ */

function doGet(e) {
  if (!e || typeof e !== 'object') {
    return jsonResponse({
      success: false,
      error: "Invalid request: no event object. Use the deployed Web App URL (/exec)."
    });
  }
  if (!e.parameter) {
    return jsonResponse({
      success: false,
      error: "No parameters. Use the /exec deployment URL with ?action=..."
    });
  }

  const action = (e.parameter.action || "").trim().toLowerCase();
  let result;

  try {
    switch (action) {
      // ── HEALTH CHECK ──
      case "ping":                result = { success: true, pong: true }; break;

      // ── AUTH ──
      case "login":              result = handleLogin(e.parameter); break;
      case "signup":             result = handleSignup(e.parameter); break;
      case "checksession":       result = checkSession(e.parameter); break;

      // ── PAYMENT ──
      case "submitpayment":      result = submitPayment(e.parameter); break;
      case "getpaymentstatus":   result = getPaymentStatus(e.parameter); break;
      case "getsettings":        result = getSettings(); break;
      case "getfile":            result = handleGetFile(e.parameter); break;

      // ── ADMIN WORLD ──
      case "adminlogin":         result = adminLogin(e.parameter); break;
      case "adminchangepassword": result = adminChangePassword(e.parameter); break;
      case "adminlistusers":     result = adminListUsers(e.parameter); break;
      case "adminlistpayments":  result = adminListPayments(e.parameter); break;
      case "adminreviewpayment": result = adminReviewPayment(e.parameter); break;
      case "admingrantaccess":   result = adminGrantAccess(e.parameter); break;
      case "adminupdateuser":    result = adminUpdateUser(e.parameter); break;
      case "admindeleteuser":    result = adminDeleteUser(e.parameter); break;
      case "admindeletepayment": result = adminDeletePayment(e.parameter); break;
      case "adminupdatesettings":result = adminUpdateSettings(e.parameter); break;
      case "adminupdatesettingsbatch": result = adminUpdateSettingsBatch(e.parameter); break;
      case "adminstats":         result = adminStats(e.parameter); break;
      case "adminlistlogs":      result = adminListLogs(e.parameter); break;

      default:
        result = {
          success: false,
          error: "Unknown action: '" + action + "'. Valid: ping, login, signup, checkSession, submitPayment, getPaymentStatus, getSettings, getFile, adminLogin, adminChangePassword, adminListUsers, adminListPayments, adminReviewPayment, adminGrantAccess, adminUpdateUser, adminDeleteUser, adminDeletePayment, adminUpdateSettings, adminUpdateSettingsBatch, adminStats, adminListLogs"
        };
    }
  } catch (err) {
    console.error("doGet ERROR [" + action + "]:", err);
    result = { success: false, error: "Server error: " + (err.message || err.toString()) };
  }

  return jsonResponse(result);
}

function doPost(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      const payload = JSON.parse(e.postData.contents);
      e.parameter = e.parameter || {};
      for (const key in payload) {
        if (payload.hasOwnProperty(key)) {
          e.parameter[key] = payload[key];
        }
      }
    } catch (parseErr) {
      console.log("doPost: JSON parse failed, using raw parameters");
    }
  }
  return doGet(e);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════════════════════════════════════════════
   SETUP
   ═══════════════════════════════════════════════════════════════ */

function setup() {
  getUsersSheet_();
  getPaymentsSheet_();
  getSettingsSheet_();
  initDefaultSettings_();
  const ss = getSpreadsheet_();
  Logger.log("✅ Setup complete. Spreadsheet URL: " + ss.getUrl());
  return "Setup complete. Spreadsheet created/verified.";
}

function getSpreadsheet_() {
  let ssId = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  let spreadsheet;
  if (ssId) {
    try {
      spreadsheet = SpreadsheetApp.openById(ssId);
    } catch (e) {
      spreadsheet = null;
      console.log("Could not open existing spreadsheet, creating new one.");
    }
  }
  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create("HAMRO AFNAI v4.0");
    PropertiesService.getScriptProperties().setProperty("SHEET_ID", spreadsheet.getId());
  }
  return spreadsheet;
}

function getUsersSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(USERS_SHEET);
    sheet.appendRow(USER_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, USER_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#4285f4")
      .setFontColor("white");
    // Mobile is column 5 (USER_HEADERS index 4) — force plain text so a
    // digit-only value like "9812345678" is never auto-typed as a Number.
    sheet.getRange(2, 5, sheet.getMaxRows() - 1, 1).setNumberFormat("@");
  }
  return sheet;
}

function getPaymentsSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(PAYMENTS_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PAYMENTS_SHEET);
    sheet.appendRow(PAYMENT_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, PAYMENT_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#34a853")
      .setFontColor("white");
  }
  return sheet;
}

function getSettingsSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SETTINGS_SHEET);
    sheet.appendRow(SETTINGS_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SETTINGS_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#fbbc04")
      .setFontColor("white");
  }
  return sheet;
}

function getLogsSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(LOGS_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOGS_SHEET);
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length)
      .setFontWeight("bold")
      .setBackground("#9c27b0")
      .setFontColor("white");
  }
  return sheet;
}

// Records one row per admin action. admin.html's "Activity Logs" tab
// (LOGS module) has always called action=adminListLogs to read this, but
// nothing ever wrote to it and the action didn't exist on the backend —
// so the tab was permanently empty. Called from every admin mutation
// below. Kept best-effort: a logging failure should never break the
// action itself.
function logAction_(admin, action, target, details) {
  try {
    getLogsSheet_().appendRow([new Date().toISOString(), admin || ADMIN_USERNAME, action || "", target || "", details || ""]);
  } catch (err) {
    console.error("logAction_ failed:", err);
  }
}

// Returns logs newest-first; admin.html paginates/filters client-side.
function adminListLogs(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const sheet = getLogsSheet_();
  const data = sheet.getDataRange().getValues();
  const logs = [];
  for (let i = 1; i < data.length; i++) {
    logs.push({
      timestamp: data[i][0],
      admin: data[i][1],
      action: data[i][2],
      target: data[i][3],
      details: data[i][4]
    });
  }
  logs.reverse();
  return { success: true, logs };
}

function initDefaultSettings_() {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) existingKeys.add(String(data[i][0]));
  }

  const defaults = [
    ["qrCodeUrl", ""],
    ["contactPhone", "9863200285"],
    ["paymentAmount", "100"],
    ["paymentInstructions", "Scan the QR code and submit your transaction ID for verification."],
    ["trialHours", "24"],
    ["appName", "HAMRO AFNAI"]
  ];

  defaults.forEach(([key, value]) => {
    if (!existingKeys.has(key)) {
      sheet.appendRow([key, value]);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function hashPass_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0")).join("");
}

// Plain unsalted SHA-256 (the original hashPass_ above) means two users
// with the same password get the identical stored hash, and the whole
// Users sheet is crackable in one pass with a rainbow table if it's ever
// exposed. New passwords are hashed as "salt:sha256(salt+password)"
// instead. verifyPassword_ below still accepts the old bare-hash format
// for existing accounts and silently upgrades them to the salted format
// on their next successful login — nobody gets locked out, and every
// password converges to the stronger scheme over time.
function makeSalt_() {
  return Utilities.getUuid().replace(/-/g, "");
}

function hashPassSalted_(password, salt) {
  return hashPass_(salt + password);
}

// Returns {ok: true/false}. On success via the legacy unsalted scheme,
// also returns upgradedHash — the caller should write that back over the
// stored hash so this account is on the salted scheme from now on.
function verifyPassword_(password, storedHash) {
  const s = String(storedHash || "");
  const sep = s.indexOf(":");
  if (sep === -1) {
    if (s !== hashPass_(password)) return { ok: false };
    const salt = makeSalt_();
    return { ok: true, upgradedHash: salt + ":" + hashPassSalted_(password, salt) };
  }
  const salt = s.slice(0, sep);
  const hash = s.slice(sep + 1);
  return { ok: hash === hashPassSalted_(password, salt) };
}

// Session tokens live in columns 17/18 (0-indexed 16/17) of the Users
// sheet — see USER_HEADERS. 30-day expiry matches how long the frontend
// otherwise keeps a session cached in localStorage before requiring a
// fresh login.
const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function issueUserToken_(sheet, rowIndex) {
  const token = Utilities.getUuid();
  const expires = Date.now() + USER_TOKEN_TTL_MS;
  sheet.getRange(rowIndex, 17).setValue(token);
  sheet.getRange(rowIndex, 18).setValue(String(expires));
  return token;
}

// found.row is the raw row array from findUserRow_ (0-indexed) — token is
// row[16], expiry is row[17].
function verifyUserToken_(found, token) {
  if (!token) return false;
  const storedToken = found.row[16];
  const expires = Number(found.row[17] || 0);
  if (!storedToken || storedToken !== token) return false;
  if (!expires || Date.now() > expires) return false;
  return true;
}

function findUserRow_(sheet, username) {
  if (!username) return null;
  const data = sheet.getDataRange().getValues();
  const target = String(username).toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().trim() === target) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

// Generic column lookup, used by handleSignup to dedupe email/mobile —
// findUserRow_ above only ever checked column 0 (username), so two
// accounts could previously share the same email or phone number and
// each grab their own fresh 24h trial.
function findUserByField_(sheet, colIndex, value) {
  if (!value) return null;
  const data = sheet.getDataRange().getValues();
  const target = String(value).toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]).toLowerCase().trim() === target) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function rowToUser_(row) {
  return {
    username: row[0] || "",
    name: row[2] || "",
    email: row[3] || "",
    mobile: String(row[4] || ""),
    contact: row[5] || "",
    contactType: row[6] || "",
    status: row[7] || "trial",
    createdAt: row[8] || "",
    approvedAt: row[9] || "",
    role: row[10] || "user",
    trialExpiresAt: row[11] || "",
    paymentStatus: row[12] || "none",
    permanentAccess: row[13] === "true" || row[13] === true || false,
    // "permanent" | "yearly" | "" — set by adminGrantAccess. Only meaningful
    // when permanentAccess/status="active" is true.
    accessType: row[14] || "",
    // Only set (and only checked) when accessType === "yearly".
    accessExpiresAt: row[15] || ""
  };
}

function checkAdmin_(p) {
  if (p.adminUser === ADMIN_USERNAME && p.adminPass === getAdminPassword_()) return true;
  if (!p.adminToken) return false;
  const props = PropertiesService.getScriptProperties();
  const storedToken = props.getProperty("ADMIN_TOKEN");
  const expiresAt = Number(props.getProperty("ADMIN_TOKEN_EXPIRES") || 0);
  if (!storedToken || p.adminToken !== storedToken) return false;
  if (Date.now() > expiresAt) return false;
  return true;
}

// Persists the token adminLogin() just issued so checkAdmin_() can validate
// it on every later request. 24h lifetime matches admin.html's own
// client-side `expires: Date.now() + 86400000` used for the localStorage
// session — keep both in sync if either changes.
function issueAdminToken_(token) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("ADMIN_TOKEN", token);
  props.setProperty("ADMIN_TOKEN_EXPIRES", String(Date.now() + 24 * 60 * 60 * 1000));
}

// A "yearly" grant is stored as permanentAccess=true + accessType="yearly"
// + accessExpiresAt=<date>. Once that date passes, downgrade back to
// "expired" so the person is routed to the payment/renewal screen again.
// Permanent grants (accessType="permanent" or accessExpiresAt empty) never expire.
function checkYearlyExpiry_(sheet, found, user, status) {
  if (user.accessType === "yearly" && user.accessExpiresAt) {
    const expiresAt = new Date(user.accessExpiresAt);
    if (!isNaN(expiresAt) && new Date() > expiresAt) {
      sheet.getRange(found.rowIndex, 8).setValue("expired");
      sheet.getRange(found.rowIndex, 14).setValue("false");
      user.permanentAccess = false;
      return "expired";
    }
  }
  return status;
}

function getOrCreateFolder_(folderName) {
  const iter = DriveApp.getFoldersByName(folderName);
  if (iter.hasNext()) return iter.next();
  return DriveApp.createFolder(folderName);
}

/* ═══════════════════════════════════════════════════════════════
   AUTH API
   ═══════════════════════════════════════════════════════════════ */

function handleLogin(p) {
  const username = String(p.username || "").trim();
  const password = p.password || "";

  if (!username || !password) {
    return { success: false, error: "Enter username and password." };
  }

  // ── ADMIN WORLD ──
  if (username === ADMIN_USERNAME && password === getAdminPassword_()) {
    return {
      success: true,
      isAdmin: true,
      adminToken: hashPass_(ADMIN_USERNAME + getAdminPassword_() + new Date().getTime()),
      user: { username: ADMIN_USERNAME, name: "Administrator", role: "admin" },
      message: "Welcome to Admin World"
    };
  }

  // ── USER WORLD ──
  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) {
    return { success: false, error: "No account found. Please sign up first." };
  }

  const row = found.row;
  const storedHash = row[1];
  const verify = verifyPassword_(password, storedHash);
  if (!verify.ok) {
    return { success: false, error: "Wrong password." };
  }
  if (verify.upgradedHash) {
    sheet.getRange(found.rowIndex, 2).setValue(verify.upgradedHash);
  }
  const sessionToken = issueUserToken_(sheet, found.rowIndex);

  let status = row[7];
  const trialExpiresAt = row[11] ? new Date(row[11]) : null;
  const now = new Date();

  // Auto-expire trial if past due
  if (status === "trial" && trialExpiresAt && now > trialExpiresAt) {
    status = "expired";
    sheet.getRange(found.rowIndex, 8).setValue("expired");
  }

  const user = rowToUser_(row);
  user.status = status;
  status = checkYearlyExpiry_(sheet, found, user, status);
  user.status = status;

  // Paid users = permanent OR active (non-expired) yearly access
  if (user.permanentAccess || status === "active") {
    return {
      success: true,
      user: user,
      token: sessionToken,
      permanentAccess: true,
      accessType: user.accessType || "permanent",
      accessExpiresAt: user.accessExpiresAt || "",
      message: user.accessType === "yearly"
        ? "Welcome back! Yearly access active."
        : "Welcome back! Permanent access active."
    };
  }

  // Trial active
  if (status === "trial") {
    const hoursLeft = Math.max(0, Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60)));
    return {
      success: true,
      user: user,
      token: sessionToken,
      isTrial: true,
      hoursLeft: hoursLeft,
      trialExpiresAt: user.trialExpiresAt,
      message: "You got 1-day free trial. Pay to get long-term access."
    };
  }

  // Expired or payment pending
  if (status === "expired" || status === "payment_pending") {
    const settings = getSettings();
    return {
      success: true,
      user: user,
      token: sessionToken,
      needsPayment: true,
      settings: settings.success ? settings.settings : {},
      message: "Your trial has expired. Please complete payment to continue."
    };
  }

  if (status === "rejected") {
    return { success: false, error: "Account rejected. Contact admin." };
  }

  return { success: true, user: user, token: sessionToken };
}

function handleSignup(p) {
  const username = String(p.username || "").trim();
  const password = p.password || "";
  const name = String(p.name || "").trim();
  const email = String(p.email || "").trim();
  const mobile = String(p.mobile || "").trim();
  const contact = email || mobile;
  const contactType = email ? "email" : (mobile ? "phone" : "other");

  if (!username || !password || !name || !email || !mobile) {
    return { success: false, error: "All fields required (username, password, name, email, mobile)." };
  }
  // admin.html renders username inside onclick="...('${username}')" handlers
  // (see USERS.renderPage, PAYMENTS.renderPage). HTML-escaping the *display*
  // text elsewhere doesn't protect that context — a quote or backslash in
  // the username could still break out of the inline JS string. Locking the
  // charset here removes that injection vector at the source, for every
  // username that will ever exist from this point on.
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
    return { success: false, error: "Username must be 3-30 characters: letters, numbers, dots, dashes, underscores only." };
  }
  if (password.length < 4) {
    return { success: false, error: "Password must be at least 4 characters." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Invalid email address." };
  }

  const sheet = getUsersSheet_();
  if (findUserRow_(sheet, username)) {
    return { success: false, error: "Username already taken." };
  }
  // email is column 3, mobile is column 4 in USER_HEADERS — see
  // findUserByField_ above for why this check exists.
  if (findUserByField_(sheet, 3, email)) {
    return { success: false, error: "An account with this email already exists. Please log in instead." };
  }
  if (findUserByField_(sheet, 4, mobile)) {
    return { success: false, error: "An account with this mobile number already exists. Please log in instead." };
  }

  const now = new Date();
  const trialExpiresAt = new Date(now.getTime() + TRIAL_HOURS * 60 * 60 * 1000);
  const salt = makeSalt_();

  sheet.appendRow([
    username,
    salt + ":" + hashPassSalted_(password, salt),
    name,
    email,
    mobile,
    contact,
    contactType,
    "trial",              // status
    now.toISOString(),    // createdAt
    now.toISOString(),    // approvedAt
    "user",               // role
    trialExpiresAt.toISOString(), // trialExpiresAt
    "none",               // paymentStatus
    "false"               // permanentAccess
  ]);

  const newRowIndex = sheet.getLastRow();
  const sessionToken = issueUserToken_(sheet, newRowIndex);

  return {
    success: true,
    isTrial: true,
    token: sessionToken,
    trialExpiresAt: trialExpiresAt.toISOString(),
    message: "Account created! You got 1-day free trial. Pay to get long-term access."
  };
}

function checkSession(p) {
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };

  // Previously this endpoint returned full account data (email, mobile,
  // trial/payment status) for any username with no proof of identity —
  // the frontend has sent a token here since it was written, but nothing
  // on this end ever checked it. That's fixed now: no valid token, no data.
  if (!verifyUserToken_(found, p.token)) {
    return { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };
  }

  const row = found.row;
  let status = row[7];
  const trialExpiresAt = row[11] ? new Date(row[11]) : null;
  const now = new Date();
  const permanentAccess = row[13] === "true" || row[13] === true;

  if (status === "trial" && trialExpiresAt && now > trialExpiresAt) {
    status = "expired";
    sheet.getRange(found.rowIndex, 8).setValue("expired");
  }

  const user = rowToUser_(row);
  user.status = status;
  status = checkYearlyExpiry_(sheet, found, user, status);
  user.status = status;

  if (user.permanentAccess || status === "active") {
    return {
      success: true,
      user: user,
      permanentAccess: true,
      accessType: user.accessType || "permanent",
      accessExpiresAt: user.accessExpiresAt || ""
    };
  }

  if (status === "trial") {
    const hoursLeft = Math.max(0, Math.ceil((trialExpiresAt - now) / (1000 * 60 * 60)));
    return { success: true, user: user, isTrial: true, hoursLeft: hoursLeft };
  }

  if (status === "expired" || status === "payment_pending") {
    const settings = getSettings();
    return { success: true, user: user, needsPayment: true, settings: settings.success ? settings.settings : {} };
  }

  return { success: true, user: user };
}

/* ═══════════════════════════════════════════════════════════════
   PAYMENT API
   ═══════════════════════════════════════════════════════════════ */

function submitPayment(p) {
  const username = String(p.username || "").trim();
  const name = String(p.name || "").trim();
  const email = String(p.email || "").trim();
  const mobile = String(p.mobile || "").trim();
  const txId = String(p.txId || "").trim();
  const remarks = String(p.remarks || "").trim();
  const screenshotData = p.screenshot || "";

  if (!username) return { success: false, error: "Username required." };
  if (!txId) return { success: false, error: "Transaction ID required." };

  // Update user status
  const userSheet = getUsersSheet_();
  const userFound = findUserRow_(userSheet, username);
  if (!userFound) return { success: false, error: "User not found." };

  // Without this, anyone could submit a payment record under someone
  // else's username — not enough to steal their access (admin still
  // reviews manually), but enough to spam a stranger's account into
  // payment_pending and mess with their status.
  if (!verifyUserToken_(userFound, p.token)) {
    return { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };
  }

  const currentStatus = userFound.row[7];
  if (currentStatus !== "expired" && currentStatus !== "payment_pending" && currentStatus !== "trial") {
    return { success: false, error: "Payment not required at this time." };
  }

  userSheet.getRange(userFound.rowIndex, 8).setValue("payment_pending");
  userSheet.getRange(userFound.rowIndex, 13).setValue("pending");

  // Handle payment record
  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();
  let existingRow = null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      existingRow = i + 1;
      break;
    }
  }

  const now = new Date().toISOString();
  let screenshotUrl = "";

  if (screenshotData && screenshotData.startsWith("data:image")) {
    try {
      const base64Data = screenshotData.split(",")[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), "image/png", username + "_payment.png");
      const folder = getOrCreateFolder_("PaymentScreenshots");
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      screenshotUrl = file.getDownloadUrl();
    } catch (e) {
      console.log("Screenshot upload failed: " + e.message);
    }
  } else if (screenshotData && screenshotData.startsWith("http")) {
    screenshotUrl = screenshotData;
  }

  if (existingRow) {
    if (name) sheet.getRange(existingRow, 2).setValue(name);
    if (email) sheet.getRange(existingRow, 3).setValue(email);
    if (mobile) sheet.getRange(existingRow, 4).setValue(mobile);
    sheet.getRange(existingRow, 5).setValue(txId);
    if (remarks) sheet.getRange(existingRow, 6).setValue(remarks);
    sheet.getRange(existingRow, 7).setValue("pending");
    sheet.getRange(existingRow, 8).setValue("");
    if (screenshotUrl) sheet.getRange(existingRow, 9).setValue(screenshotUrl);
    sheet.getRange(existingRow, 10).setValue(now);
  } else {
    sheet.appendRow([username, name, email, mobile, txId, remarks, "pending", "", screenshotUrl, now, ""]);
  }

  return {
    success: true,
    message: "Payment submitted successfully. Waiting for admin verification."
  };
}

function getPaymentStatus(p) {
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  // This returns email/mobile/txId and a link to the payment screenshot —
  // it needs the same proof-of-identity as checkSession, not just a
  // matching username string.
  const usersSheet = getUsersSheet_();
  const userFound = findUserRow_(usersSheet, username);
  if (!userFound) return { success: false, error: "User not found." };
  if (!verifyUserToken_(userFound, p.token)) {
    return { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };
  }

  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      return {
        success: true,
        payment: {
          username: data[i][0],
          name: data[i][1],
          email: data[i][2],
          mobile: String(data[i][3] || ""),
          txId: data[i][4],
          remarks: data[i][5],
          status: data[i][6],
          rejectionReason: data[i][7],
          screenshotUrl: data[i][8],
          submittedAt: data[i][9],
          reviewedAt: data[i][10]
        }
      };
    }
  }
  return { success: false, error: "No payment submission found." };
}

function getSettings() {
  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) settings[String(data[i][0])] = data[i][1];
  }
  return { success: true, settings };
}

// ── QUESTION-FILE PROXY ──
// app.js (QUIZ._fetch / CACHE.dl / CACHE.autoSync) downloads every question
// set through this single action instead of hitting Google Drive directly,
// because a plain https://drive.google.com/... link returns an HTML preview
// page in fetch(), not raw JSON. Reading the file server-side with DriveApp
// (running "as Me") sidesteps that entirely, and works even if the file's
// sharing is left at "Anyone with the link" or tighter, as long as the
// script owner's account can see it.
function handleGetFile(p) {
  const fileId = String(p.fileId || "").trim();
  if (!fileId) {
    return { success: false, error: "Missing fileId parameter." };
  }
  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    return {
      success: false,
      error: "Could not open Drive file '" + fileId + "'. Check the fileId in chapters-data.js and make sure the file hasn't been deleted or moved. (" + (err.message || err) + ")"
    };
  }
  let text;
  try {
    text = file.getBlob().getDataAsString("UTF-8");
  } catch (err) {
    return { success: false, error: "Could not read file contents: " + (err.message || err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: "File '" + file.getName() + "' is not valid JSON (" + (err.message || err) + "). Re-check the uploaded question file."
    };
  }
  return { success: true, result: parsed };
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN API — The Admin World
   ═══════════════════════════════════════════════════════════════ */

function adminLogin(p) {
  const username = String(p.username || "").trim();
  const password = p.password || "";
  if (username === ADMIN_USERNAME && password === getAdminPassword_()) {
    const token = hashPass_(ADMIN_USERNAME + getAdminPassword_() + new Date().getTime());
    issueAdminToken_(token);
    logAction_(ADMIN_USERNAME, "Admin Login", "", "");
    return {
      success: true,
      isAdmin: true,
      adminToken: token,
      user: { username: username, name: "Administrator", role: "admin" },
      message: "Welcome to Admin World"
    };
  }
  return { success: false, error: "Invalid admin credentials." };
}

// admin.html calls this then forces re-login (the old adminToken stays
// valid until it naturally expires — 24h — since it's independent of the
// password; that's an acceptable tradeoff for a single-admin panel).
function adminChangePassword(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const currentPassword = p.currentPassword || "";
  const newPassword = p.newPassword || "";
  if (currentPassword !== getAdminPassword_()) {
    return { success: false, error: "Current password is incorrect." };
  }
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: "New password must be at least 6 characters." };
  }
  PropertiesService.getScriptProperties().setProperty("ADMIN_PASSWORD", newPassword);
  logAction_(ADMIN_USERNAME, "Change Admin Password", "", "");
  return { success: true, message: "Password changed." };
}

function adminListUsers(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const sheet = getUsersSheet_();
  const data = sheet.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < data.length; i++) {
    users.push(rowToUser_(data[i]));
  }
  return { success: true, users };
}

function adminListPayments(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();
  const payments = [];

  // Verification here is manual (admin eyeballs the screenshot), so nothing
  // ever stopped two different usernames from submitting the exact same
  // transaction ID — e.g. someone resubmitting a real payer's txId hoping
  // it slips through review. We don't block it (a legit user's own retry
  // after a rejection reuses their own txId too), just surface it so the
  // reviewing admin can cross-check before approving.
  const txIdOwners = {};
  for (let i = 1; i < data.length; i++) {
    const txId = String(data[i][4] || "").trim().toLowerCase();
    const username = String(data[i][0] || "");
    if (!txId) continue;
    if (!txIdOwners[txId]) txIdOwners[txId] = new Set();
    txIdOwners[txId].add(username);
  }

  for (let i = 1; i < data.length; i++) {
    const txId = String(data[i][4] || "");
    const username = String(data[i][0] || "");
    const owners = txIdOwners[txId.trim().toLowerCase()];
    const sharedWith = owners ? [...owners].filter(u => u !== username) : [];
    payments.push({
      username: username,
      name: data[i][1],
      email: data[i][2],
      mobile: String(data[i][3] || ""),
      txId: txId,
      remarks: data[i][5],
      status: data[i][6],
      rejectionReason: data[i][7],
      screenshotUrl: data[i][8],
      submittedAt: data[i][9],
      reviewedAt: data[i][10],
      duplicateTxId: sharedWith.length > 0,
      duplicateTxIdUsers: sharedWith
    });
  }
  return { success: true, payments };
}

function adminReviewPayment(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };

  const username = String(p.username || "").trim();
  const status = String(p.status || "").trim();
  const rejectionReason = String(p.rejectionReason || "").trim();

  if (!username || !status) return { success: false, error: "Username and status required." };
  if (!["verified", "rejected", "pending"].includes(status)) {
    return { success: false, error: "Status must be verified, rejected, or pending." };
  }

  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();
  let paymentRow = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      paymentRow = i + 1;
      break;
    }
  }

  if (!paymentRow) return { success: false, error: "Payment not found." };

  sheet.getRange(paymentRow, 7).setValue(status);
  if (rejectionReason && status === "rejected") {
    sheet.getRange(paymentRow, 8).setValue(rejectionReason);
  }
  sheet.getRange(paymentRow, 11).setValue(new Date().toISOString());

  // Update user based on payment status
  const userSheet = getUsersSheet_();
  const userFound = findUserRow_(userSheet, username);
  if (userFound) {
    if (status === "verified") {
      userSheet.getRange(userFound.rowIndex, 8).setValue("active");
      userSheet.getRange(userFound.rowIndex, 13).setValue("verified");
      userSheet.getRange(userFound.rowIndex, 14).setValue("true"); // PERMANENT ACCESS
      userSheet.getRange(userFound.rowIndex, 10).setValue(new Date().toISOString());
      userSheet.getRange(userFound.rowIndex, 15).setValue("permanent"); // accessType
      userSheet.getRange(userFound.rowIndex, 16).setValue("");          // no expiry
    } else if (status === "rejected") {
      userSheet.getRange(userFound.rowIndex, 8).setValue("expired");
      userSheet.getRange(userFound.rowIndex, 13).setValue("rejected");
      userSheet.getRange(userFound.rowIndex, 14).setValue("false");
    }
  }

  logAction_(ADMIN_USERNAME, "Review Payment", username, "Status: " + status + (rejectionReason ? " (" + rejectionReason + ")" : ""));
  return { success: true, username, status };
}

// duration is either "permanent" (never expires)
// or "year" (expires exactly 365 days from now, then the person is routed
// back to the payment/renewal screen automatically on their next login or
// session check — see checkYearlyExpiry_()).
function adminGrantAccess(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };

  const username = String(p.username || "").trim();
  const duration = String(p.duration || "").trim(); // "permanent" | "year"
  if (!username) return { success: false, error: "Username required." };
  if (!["permanent", "year"].includes(duration)) {
    return { success: false, error: "Duration must be 'permanent' or 'year'." };
  }

  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };

  let expiresAtIso = "";
  if (duration === "year") {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    expiresAtIso = expiresAt.toISOString();
  }

  sheet.getRange(found.rowIndex, 8).setValue("active");           // status
  sheet.getRange(found.rowIndex, 10).setValue(new Date().toISOString()); // approvedAt
  sheet.getRange(found.rowIndex, 13).setValue("verified");        // paymentStatus
  sheet.getRange(found.rowIndex, 14).setValue("true");            // permanentAccess
  sheet.getRange(found.rowIndex, 15).setValue(duration === "year" ? "yearly" : "permanent"); // accessType
  sheet.getRange(found.rowIndex, 16).setValue(expiresAtIso);      // accessExpiresAt

  logAction_(ADMIN_USERNAME, "Grant Access", username, "Duration: " + duration);
  return { success: true, username, duration, accessExpiresAt: expiresAtIso };
}

// Column indices below follow USER_HEADERS: name=3, email=4, mobile=5,
// status=8, permanentAccess=14 (1-indexed sheet columns).
function adminUpdateUser(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const username = String(p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };

  const changes = [];
  if (p.name !== undefined) { sheet.getRange(found.rowIndex, 3).setValue(p.name); changes.push("name"); }
  if (p.email !== undefined) { sheet.getRange(found.rowIndex, 4).setValue(p.email); changes.push("email"); }
  if (p.mobile !== undefined) { sheet.getRange(found.rowIndex, 5).setValue(p.mobile); changes.push("mobile"); }
  if (p.status !== undefined && p.status !== "") { sheet.getRange(found.rowIndex, 8).setValue(p.status); changes.push("status→" + p.status); }
  if (p.permanentAccess !== undefined) {
    const val = (p.permanentAccess === true || p.permanentAccess === "true") ? "true" : "false";
    sheet.getRange(found.rowIndex, 14).setValue(val);
    changes.push("permanentAccess→" + val);
  }
  if (p.password) {
    if (String(p.password).length < 6) return { success: false, error: "Password must be at least 6 characters." };
    const salt = makeSalt_();
    sheet.getRange(found.rowIndex, 2).setValue(salt + ":" + hashPassSalted_(p.password, salt));
    changes.push("password reset");
  }

  logAction_(ADMIN_USERNAME, "Update User", username, changes.join(", "));
  return { success: true, username };
}

function adminDeleteUser(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const username = String(p.username || "").trim();
  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };
  sheet.deleteRow(found.rowIndex);
  logAction_(ADMIN_USERNAME, "Delete User", username, "");
  return { success: true, deleted: username };
}

function adminDeletePayment(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const username = String(p.username || "").trim();
  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      sheet.deleteRow(i + 1);
      logAction_(ADMIN_USERNAME, "Delete Payment", username, "");
      return { success: true, deleted: username };
    }
  }
  return { success: false, error: "Payment not found." };
}

function adminUpdateSettings(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const key = String(p.key || "").trim();
  const value = (p.value !== undefined) ? p.value : "";
  if (!key) return { success: false, error: "Setting key required." };

  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      logAction_(ADMIN_USERNAME, "Update Setting", key, "New value: " + value);
      return { success: true, key, value };
    }
  }
  sheet.appendRow([key, value]);
  logAction_(ADMIN_USERNAME, "Update Setting", key, "New value: " + value);
  return { success: true, key, value };
}

function adminUpdateSettingsBatch(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const incoming = p.settings;
  if (!Array.isArray(incoming) || !incoming.length) {
    return { success: false, error: "settings array required." };
  }

  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();
  const rowByKey = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) rowByKey[String(data[i][0])] = i + 1;
  }

  const applied = [];
  for (const s of incoming) {
    const key = String(s.key || "").trim();
    if (!key) continue;
    const value = (s.value !== undefined) ? s.value : "";
    if (rowByKey[key]) {
      sheet.getRange(rowByKey[key], 2).setValue(value);
    } else {
      sheet.appendRow([key, value]);
      rowByKey[key] = sheet.getLastRow();
    }
    applied.push(key);
  }

  logAction_(ADMIN_USERNAME, "Update Settings (batch)", applied.join(", "), "");
  return { success: true, updated: applied };
}

function adminStats(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };

  const userSheet = getUsersSheet_();
  const userData = userSheet.getDataRange().getValues();
  const paymentSheet = getPaymentsSheet_();
  const payData = paymentSheet.getDataRange().getValues();

  let totalUsers = 0, trialUsers = 0, activeUsers = 0, expiredUsers = 0, paymentPending = 0;
  for (let i = 1; i < userData.length; i++) {
    totalUsers++;
    const status = userData[i][7];
    if (status === "trial") trialUsers++;
    else if (status === "active") activeUsers++;
    else if (status === "expired") expiredUsers++;
    else if (status === "payment_pending") paymentPending++;
  }

  let totalPayments = 0, pendingPayments = 0, verifiedPayments = 0, rejectedPayments = 0;
  for (let i = 1; i < payData.length; i++) {
    totalPayments++;
    const status = payData[i][6];
    if (status === "pending") pendingPayments++;
    else if (status === "verified") verifiedPayments++;
    else if (status === "rejected") rejectedPayments++;
  }

  return {
    success: true,
    stats: {
      users: { total: totalUsers, trial: trialUsers, active: activeUsers, expired: expiredUsers, paymentPending: paymentPending },
      payments: { total: totalPayments, pending: pendingPayments, verified: verifiedPayments, rejected: rejectedPayments }
    }
  };
}

/* ═══════════════════════════════════════════════════════════════
   DEBUG / TEST — Run testAll() from the editor to verify everything
   ═══════════════════════════════════════════════════════════════ */

function testAll() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  HAMRO AFNAI v4.0 — FULL SYSTEM TEST");
  console.log("═══════════════════════════════════════════════════════");

  // 1. Setup
  console.log("\n[1/10] Running setup...");
  setup();
  console.log("✅ Setup complete");

  // 2. Signup
  console.log("\n[2/10] Testing signup...");
  const signupResult = handleSignup({
    username: "testuser",
    password: "testpass",
    name: "Test User",
    email: "test@example.com",
    mobile: "9800000000"
  });
  console.log("Signup:", JSON.stringify(signupResult));
  if (!signupResult.success) throw new Error("SIGNUP FAILED");

  // 3. Login during trial
  console.log("\n[3/10] Testing login (trial)...");
  const loginTrial = handleLogin({
    username: "testuser",
    password: "testpass"
  });
  console.log("Login (trial):", JSON.stringify(loginTrial));
  if (!loginTrial.success || !loginTrial.isTrial) throw new Error("TRIAL LOGIN FAILED");

  // 4. Admin login
  console.log("\n[4/10] Testing admin login...");
  const adminResult = adminLogin({
    username: "admin",
    password: "ChangeMe123!"
  });
  console.log("Admin login:", JSON.stringify(adminResult));
  if (!adminResult.success || !adminResult.isAdmin) throw new Error("ADMIN LOGIN FAILED");

  // 5. Admin list users
  console.log("\n[5/10] Testing admin list users...");
  const listUsers = adminListUsers({ adminUser: "admin", adminPass: "ChangeMe123!" });
  console.log("Users count:", listUsers.users.length);
  if (!listUsers.success) throw new Error("ADMIN LIST USERS FAILED");

  // 6. Simulate expired trial
  console.log("\n[6/10] Simulating trial expiration...");
  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, "testuser");
  const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
  sheet.getRange(found.rowIndex, 12).setValue(pastDate.toISOString());
  console.log("✅ Trial date set to past");

  // 7. Login after expiry
  console.log("\n[7/10] Testing login (expired)...");
  const loginExpired = handleLogin({
    username: "testuser",
    password: "testpass"
  });
  console.log("Login (expired):", JSON.stringify(loginExpired));
  if (!loginExpired.success || !loginExpired.needsPayment) throw new Error("EXPIRED LOGIN FAILED");

  // 8. Submit payment
  console.log("\n[8/10] Testing payment submission...");
  const payResult = submitPayment({
    username: "testuser",
    token: loginExpired.token,
    name: "Test User",
    email: "test@example.com",
    mobile: "9800000000",
    txId: "TXN123456",
    remarks: "Test payment"
  });
  console.log("Payment:", JSON.stringify(payResult));
  if (!payResult.success) throw new Error("PAYMENT SUBMIT FAILED");

  // 9. Admin verify payment
  console.log("\n[9/10] Testing admin verify payment...");
  const verifyResult = adminReviewPayment({
    adminUser: "admin",
    adminPass: "ChangeMe123!",
    username: "testuser",
    status: "verified"
  });
  console.log("Verify:", JSON.stringify(verifyResult));
  if (!verifyResult.success) throw new Error("ADMIN VERIFY FAILED");

  // 10. Login as permanent user
  console.log("\n[10/10] Testing login (permanent)...");
  const loginActive = handleLogin({
    username: "testuser",
    password: "testpass"
  });
  console.log("Login (active):", JSON.stringify(loginActive));
  if (!loginActive.success || !loginActive.permanentAccess) throw new Error("PERMANENT ACCESS LOGIN FAILED");

  // Stats
  console.log("\n[EXTRA] Admin stats...");
  const stats = adminStats({ adminUser: "admin", adminPass: "ChangeMe123!" });
  console.log("Stats:", JSON.stringify(stats));

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ ALL TESTS PASSED — SYSTEM READY");
  console.log("═══════════════════════════════════════════════════════");

  return "All tests passed. Check View → Logs for details.";
}

/**
 * Reset all data — USE WITH CAUTION
 */
function resetAll() {
  const ss = getSpreadsheet_();
  const sheets = ss.getSheets();
  sheets.forEach(sheet => {
    if (sheet.getName() !== USERS_SHEET && sheet.getName() !== PAYMENTS_SHEET && sheet.getName() !== SETTINGS_SHEET) {
      ss.deleteSheet(sheet);
    }
  });

  // Clear data rows (keep headers)
  [USERS_SHEET, PAYMENTS_SHEET, SETTINGS_SHEET].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
  });

  initDefaultSettings_();
  console.log("All data reset.");
  return "All data has been reset.";
}

/**
 * Quick diagnostic — run this to verify your deployment
 */
function diagnose() {
  console.log("═══ DIAGNOSTIC ═══");
  const ss = getSpreadsheet_();
  console.log("Spreadsheet URL:", ss.getUrl());
  console.log("Sheets:", ss.getSheets().map(s => s.getName()).join(", "));
  
  const u = getUsersSheet_();
  console.log("Users rows:", u.getLastRow());
  
  const p = getPaymentsSheet_();
  console.log("Payments rows:", p.getLastRow());
  
  const s = getSettingsSheet_();
  console.log("Settings rows:", s.getLastRow());
  
  const settings = getSettings();
  console.log("Settings:", JSON.stringify(settings));
  
  console.log("═══ END ═══");
  return "Diagnostic complete. Check logs.";
}

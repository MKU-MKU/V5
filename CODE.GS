/* ═══════════════════════════════════════════════════════════════
   HAMRO AFNAI v4.0 FINAL — Complete Google Apps Script Backend
   Flow: Signup → Auto-Trial (24h) → Payment → Admin Verify → Permanent
   Admin login shares endpoint, opens separate admin world.
   Offline-first: Once paid, access never removed.
   ═══════════════════════════════════════════════════════════════ */

/* ── ADMIN CREDENTIALS ───────────────────────────────────────── */
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "ChangeMe123!";   // ⚠️ CHANGE THIS IMMEDIATELY

/* ── SHEET CONFIG ── */
const USERS_SHEET     = "Users";
const PAYMENTS_SHEET  = "Payments";
const SETTINGS_SHEET  = "Settings";

const USER_HEADERS = [
  "username", "passHash", "name", "email", "mobile",
  "contact", "contactType", "status", "createdAt", "approvedAt",
  "role", "trialExpiresAt", "paymentStatus", "permanentAccess",
  "accessType", "accessExpiresAt"
];

const PAYMENT_HEADERS = [
  "username", "name", "email", "mobile", "txId", "remarks",
  "status", "rejectionReason", "screenshotUrl", "submittedAt", "reviewedAt"
];

const SETTINGS_HEADERS = ["key", "value"];

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
      // ── AUTH ──
      case "login":              result = handleLogin(e.parameter); break;
      case "signup":             result = handleSignup(e.parameter); break;
      case "checksession":       result = checkSession(e.parameter); break;

      // ── PAYMENT ──
      case "submitpayment":      result = submitPayment(e.parameter); break;
      case "getpaymentstatus":   result = getPaymentStatus(e.parameter); break;
      case "getsettings":        result = getSettings(); break;

      // ── ADMIN WORLD ──
      case "adminlogin":         result = adminLogin(e.parameter); break;
      case "adminlistusers":     result = adminListUsers(e.parameter); break;
      case "adminlistpayments":  result = adminListPayments(e.parameter); break;
      case "adminreviewpayment": result = adminReviewPayment(e.parameter); break;
      case "admingrantaccess":   result = adminGrantAccess(e.parameter); break;
      case "admindeleteuser":    result = adminDeleteUser(e.parameter); break;
      case "admindeletepayment": result = adminDeletePayment(e.parameter); break;
      case "adminupdatesettings":result = adminUpdateSettings(e.parameter); break;
      case "adminstats":         result = adminStats(e.parameter); break;

      default:
        result = {
          success: false,
          error: "Unknown action: '" + action + "'. Valid: login, signup, checkSession, submitPayment, getPaymentStatus, getSettings, adminLogin, adminListUsers, adminListPayments, adminReviewPayment, adminDeleteUser, adminDeletePayment, adminUpdateSettings, adminStats"
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

function rowToUser_(row) {
  return {
    username: row[0] || "",
    name: row[2] || "",
    email: row[3] || "",
    mobile: row[4] || "",
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
  return p.adminUser === ADMIN_USERNAME && p.adminPass === ADMIN_PASSWORD;
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
  const username = (p.username || "").trim();
  const password = p.password || "";

  if (!username || !password) {
    return { success: false, error: "Enter username and password." };
  }

  // ── ADMIN WORLD ──
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return {
      success: true,
      isAdmin: true,
      adminToken: hashPass_(ADMIN_USERNAME + ADMIN_PASSWORD + new Date().getTime()),
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
  if (storedHash !== hashPass_(password)) {
    return { success: false, error: "Wrong password." };
  }

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
      needsPayment: true,
      settings: settings.success ? settings.settings : {},
      message: "Your trial has expired. Please complete payment to continue."
    };
  }

  if (status === "rejected") {
    return { success: false, error: "Account rejected. Contact admin." };
  }

  return { success: true, user: user };
}

function handleSignup(p) {
  const username = (p.username || "").trim();
  const password = p.password || "";
  const name = (p.name || "").trim();
  const email = (p.email || "").trim();
  const mobile = (p.mobile || "").trim();
  const contact = email || mobile;
  const contactType = email ? "email" : (mobile ? "phone" : "other");

  if (!username || !password || !name || !email || !mobile) {
    return { success: false, error: "All fields required (username, password, name, email, mobile)." };
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

  const now = new Date();
  const trialExpiresAt = new Date(now.getTime() + TRIAL_HOURS * 60 * 60 * 1000);

  sheet.appendRow([
    username,
    hashPass_(password),
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

  return {
    success: true,
    isTrial: true,
    trialExpiresAt: trialExpiresAt.toISOString(),
    message: "Account created! You got 1-day free trial. Pay to get long-term access."
  };
}

function checkSession(p) {
  const username = (p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };

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
  const username = (p.username || "").trim();
  const name = (p.name || "").trim();
  const email = (p.email || "").trim();
  const mobile = (p.mobile || "").trim();
  const txId = (p.txId || "").trim();
  const remarks = (p.remarks || "").trim();
  const screenshotData = p.screenshot || "";

  if (!username) return { success: false, error: "Username required." };
  if (!txId) return { success: false, error: "Transaction ID required." };

  // Update user status
  const userSheet = getUsersSheet_();
  const userFound = findUserRow_(userSheet, username);
  if (!userFound) return { success: false, error: "User not found." };

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
  const username = (p.username || "").trim();
  if (!username) return { success: false, error: "Username required." };

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
          mobile: data[i][3],
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

/* ═══════════════════════════════════════════════════════════════
   ADMIN API — The Admin World
   ═══════════════════════════════════════════════════════════════ */

function adminLogin(p) {
  const username = (p.username || "").trim();
  const password = p.password || "";
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return {
      success: true,
      isAdmin: true,
      adminToken: hashPass_(ADMIN_USERNAME + ADMIN_PASSWORD + new Date().getTime()),
      user: { username: username, name: "Administrator", role: "admin" },
      message: "Welcome to Admin World"
    };
  }
  return { success: false, error: "Invalid admin credentials." };
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
  for (let i = 1; i < data.length; i++) {
    payments.push({
      username: data[i][0],
      name: data[i][1],
      email: data[i][2],
      mobile: data[i][3],
      txId: data[i][4],
      remarks: data[i][5],
      status: data[i][6],
      rejectionReason: data[i][7],
      screenshotUrl: data[i][8],
      submittedAt: data[i][9],
      reviewedAt: data[i][10]
    });
  }
  return { success: true, payments };
}

function adminReviewPayment(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };

  const username = (p.username || "").trim();
  const status = (p.status || "").trim();
  const rejectionReason = (p.rejectionReason || "").trim();

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

  return { success: true, username, status };
}

// Lets admin.html grant access directly, either "permanent" (never expires)
// or "year" (expires exactly 365 days from now, then the person is routed
// back to the payment/renewal screen automatically on their next login or
// session check — see checkYearlyExpiry_()).
function adminGrantAccess(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };

  const username = (p.username || "").trim();
  const duration = (p.duration || "").trim(); // "permanent" | "year"
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

  return { success: true, username, duration, accessExpiresAt: expiresAtIso };
}

function adminDeleteUser(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const username = (p.username || "").trim();
  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, username);
  if (!found) return { success: false, error: "User not found." };
  sheet.deleteRow(found.rowIndex);
  return { success: true, deleted: username };
}

function adminDeletePayment(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const username = (p.username || "").trim();
  const sheet = getPaymentsSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username.toLowerCase()) {
      sheet.deleteRow(i + 1);
      return { success: true, deleted: username };
    }
  }
  return { success: false, error: "Payment not found." };
}

function adminUpdateSettings(p) {
  if (!checkAdmin_(p)) return { success: false, error: "Admin auth failed." };
  const key = (p.key || "").trim();
  const value = (p.value !== undefined) ? p.value : "";
  if (!key) return { success: false, error: "Setting key required." };

  const sheet = getSettingsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { success: true, key, value };
    }
  }
  sheet.appendRow([key, value]);
  return { success: true, key, value };
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

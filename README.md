# HAMRO AFNAI — Smart Study Hub

Offline-first exam prep platform for Nepal Engineering (Level 5 / Level 7) and PSC/Loksewa, built as three static HTML pages + a shared backend on Google Apps Script + Google Sheets. No build step, no server framework — everything runs from static files plus one deployed Apps Script web app.

---

## 1. How it all fits together

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐
│ index.html  │─────▶│  user.html   │      │  admin.html  │
│  (Gateway)  │      │ (Study App)  │      │(Admin Panel) │
└──────┬──────┘      └──────┬───────┘      └──────┬───────┘
       │                    │                      │
       │ localStorage       │ loads                │ own login
       │ 'hau_session'      │ app.js               │ 'hau_admin'
       │                    │ chapters-data.js      │
       │                    │                       │
       └────────────────────┴───────────┬───────────┘
                                         │  action=...
                                         ▼
                              ┌───────────────────────┐
                              │      CODE.GS            │
                              │ (Google Apps Script)    │
                              │  Users / Payments /     │
                              │  Settings Google Sheet  │
                              └───────────┬─────────────┘
                                          │
                                          ▼
                              Google Drive (question JSON files,
                              referenced by fileId in chapters-data.js)
```

**The three pages never share code — only two things connect them:**
1. The same deployed Apps Script URL (`GAS_URL` in `index.html`/`admin.html`, `APP_CONFIG.APPS_URL` in `app.js`) — all three must point at the identical `/exec` URL.
2. The `hau_session` localStorage key, written only by `index.html`, read by `app.js` on `user.html`. (`admin.html` does **not** use this key — it has its own independent login, described below.)

---

## 2. How it runs (no build step)

This is plain HTML/CSS/JS — you don't compile or bundle anything.

1. **Deploy the backend once:**
   - Open [script.google.com](https://script.google.com), paste `CODE.GS` into a new Apps Script project.
   - Change `ADMIN_PASSWORD` in `CODE.GS` away from the default.
   - Deploy → New deployment → Web app → Execute as "Me" → Who has access "Anyone".
   - Copy the resulting `.../exec` URL.
2. **Wire the frontend to it:** paste that URL into all three places:
   - `index.html` → `const GAS_URL = "..."`
   - `admin.html` → `const GAS_URL = "..."`
   - `app.js` → `APP_CONFIG.APPS_URL`
3. **Host the files:** any static host works (GitHub Pages, Netlify, Firebase Hosting, or just open `index.html` locally for testing — though the service worker/PWA install only works over HTTPS or `localhost`).
4. **First run:** the Apps Script auto-creates the `Users`, `Payments`, and `Settings` sheets on first request — no manual sheet setup needed.
5. **Content:** question sets live as JSON files on Google Drive (shared "Anyone with the link"); their file IDs are registered in `chapters-data.js` — see §4 below.

---

## 3. What each file is responsible for

| File | Role | Loads / depends on |
|---|---|---|
| **`index.html`** | Gateway: signup, login, 24h trial countdown, payment submission (QR + TXN ID + screenshot), routes to `user.html` or `admin.html`. Owns the `hau_session` schema. | Standalone — talks directly to `CODE.GS`. No other local JS files. |
| **`admin.html`** | Admin panel: list/search users, approve or reject payments, edit global settings (payment amount, QR image, contact info), view stats, change admin password. Has its **own** login gate (`hau_admin` key) independent of `index.html`. | Standalone — talks directly to `CODE.GS`. No other local JS files. |
| **`user.html`** | The actual study app shell: all HTML structure/CSS for every view (home, quiz, bookmarks, timetable, offline cache, etc.), plus a small inline `<script>` "patch layer" at the bottom (search links, swipe gesture, bottom-nav wiring, PWA install button). | Loads `chapters-data.js`, then `app.js`, then its own inline script. |
| **`app.js`** | All application logic: session gate, quiz engine (flashcard + exam), bookmarks/flags/wrong-bank, progress tracking, streaks, timetable + alarms, offline cache manager, data export/import, PWA registration. This is the file you'll touch for almost any feature change. | Reads globals from `chapters-data.js` (`ChapterData`, `CH_NAMES`, `DRIVE`). Talks to `CODE.GS` for `checkSession` and `getFile` (question downloads). |
| **`chapters-data.js`** | Pure data: the list of levels/chapters/subtopics and their Google Drive file IDs. The only file you edit to add/rename/remove chapters or question sets — see the big comment block at the top of the file itself for step-by-step instructions. | None — pure data map, no logic. |
| **`quiz.js`** | ⚠️ **Not used.** Not referenced by any HTML file, and incompatible with the current app (duplicate `QUIZ`/`REV` names, calls `DATA.*` methods that don't exist in `app.js`). Currently a deprecation-notice stub. Safe to delete. | — |
| **`CODE.GS`** | Backend: all `action=...` endpoints (`login`, `signup`, `checkSession`, `submitPayment`, `getSettings`, `getFile`, and the `admin*` actions), user/payment storage in Google Sheets, password hashing. | Google Sheets (`Users`, `Payments`, `Settings`), Google Drive (for `getFile` and payment screenshots). |
| **`manifest.json`** | PWA metadata (name, icons, theme color, start URL) — lets the app be "installed" to a home screen. | Referenced by `user.html`'s `<link rel="manifest">`. |
| **`sw.js`** | Service worker: caches the app shell for offline use (stale-while-revalidate), and Drive/API responses (network-first with offline fallback). Also handles the timetable alarm notification messages. | Registered by `PWA.init()` in `app.js`. |

### Quick "which file do I touch?" guide

| I want to... | Edit this file |
|---|---|
| Add/rename a chapter, level, or question-file link | `chapters-data.js` **only** |
| Change how a quiz session behaves (timer length, question limit, shuffle, retry logic, exam auto-submit, scoring, results screen) | `app.js` → section `9. QUIZ ENGINE` |
| Add a new quiz mode (e.g. "timed sprint", "matching game") | `app.js` → new module alongside `QUIZ`/`PSY`, plus matching HTML in `user.html` |
| Change bookmarks / flags / wrong-bank behavior | `app.js` → section `8. REVIEW LISTS` |
| Change trial length, payment flow, or login/signup validation | `CODE.GS` (`TRIAL_HOURS`, `handleSignup`, `handleLogin`) **and** `index.html` (form/validation) |
| Change what happens when a session expires or how offline access is judged | `app.js` → section `4. AUTH` **and** `index.html`'s matching logic (keep both in sync — see §5) |
| Change the dashboard, streaks, or progress stats | `app.js` → sections `10a`–`10c` |
| Change the timetable or its alarms | `app.js` → section `10d` |
| Change offline caching behavior | `app.js` → section `10e`, and `sw.js` for the underlying cache strategy |
| Change visual styling of the study app | `user.html` `<style>` block (CSS variables at the top control the whole theme) |
| Change visual styling of login/payment screens | `index.html` `<style>` block |
| Change admin panel behavior | `admin.html` (self-contained, doesn't touch `app.js`) |
| Add a brand-new top-level view (like a new sidebar tab) | HTML section in `user.html`, sidebar link in `user.html`, a new module in `app.js`, and a case in `UI._goRaw()`'s view-switch |

---

## 4. Adding question content (no code changes needed)

1. Upload your question JSON to Google Drive → Share → "Anyone with the link".
2. Copy the file ID from the share link.
3. Open `chapters-data.js`, find the right `level` → chapter number in the `DRIVE` object, and add `"Your Label": "fileId"`.
4. New chapter or level? Follow the instructions in `chapters-data.js`'s own header comment.

Expected question JSON shape (flexible — `normQ()` in `app.js` accepts several variants):
```json
[
  {
    "q": "Question text",
    "options": ["A", "B", "C", "D"],
    "correct": 0,
    "explanation": "Why A is correct"
  }
]
```

---

## 5. Things to keep in sync across files (important!)

- **`GAS_URL` / `APP_CONFIG.APPS_URL`** — must be identical in `index.html`, `admin.html`, `app.js`.
- **`hau_session` shape** — `index.html` writes `{ type, username, name, email, mobile, token, access:{level, trialExpiresAt, permanent}, settings, lastVerified }`. `app.js`'s `AUTH` module reads/writes this exact shape. If you change one, change the other.
- **Access-level rules** (`permanent` / `trial` / `expired` / `pending`) — computed independently in `index.html`'s `handleUserAuth()` and `app.js`'s `AUTH._buildSession()`. They're written to mirror each other; if you change what counts as valid access in one, update the other the same way.

---

## 6. Full feature list

See the chat message alongside this file — every user-facing feature is listed there, grouped by category, for a one-by-one keep/modify/remove review.

/* ═══════════════════════════════════════════════════════════════
   QUIZ.JS — DEPRECATED, NOT LOADED BY ANY PAGE
   ───────────────────────────────────────────────────────────────
   This file is not referenced by index.html, admin.html, or
   user.html, so it currently does nothing. It's kept only as a
   historical reference and is NOT safe to add a <script> tag for:

     • It redeclares `const QUIZ` and `const REV`, both of which
       already exist natively inside app.js (the real quiz engine
       user.html actually uses).
     • It calls DATA.bookmarks() / DATA.flags() / DATA.wrong() /
       DATA.addWrong() / DATA.addHistory() / DATA.streak() /
       DATA.cache() / DATA.set() — none of these exist on app.js's
       DATA object (which only has exp/imp/clearQ/reset). Including
       this file would throw immediately.

   The quiz engine, bookmarks, flags, wrong-answer bank, and streak
   tracking all now live inside app.js. If you need to change quiz
   behavior, edit app.js — not this file.

   Recommendation: delete quiz.js from the repo once you've confirmed
   nothing external depends on it, to avoid future confusion.
═══════════════════════════════════════════════════════════════ */

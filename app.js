/* ═══════════════════════════════════════════════════════════════
   APP.JS — HAMRO AFNAI Smart Study Hub  (v3 — user.html only)
   ───────────────────────────────────────────────────────────────
   This file now assumes the person already signed in on index.html
   (trial + payment model). It reads the session index.html wrote
   to localStorage['hau_session'] (SAME key, SAME object shape as
   index.html) and verifies it via the same `checkSession` backend
   action index.html itself uses. There is no login/signup UI and
   no admin panel here — those live in index.html and admin.html
   respectively.

   SECTIONS:
     1. Config & constants        7. UI/ON/LOC/PSY (start quiz)
     2. App state (S)             9. REV (bookmarks/flagged/wrong)
     3. Utility functions        10. QUIZ engine
     4. AUTH (session gate only) 11. HOME/PROG/DATA/CACHE/TT
     5. PWA                      12. APP boot
     6. (admin panel removed — see admin.html)
═══════════════════════════════════════════════════════════════ */

/* ═══════════════ 1. CONFIG & CONSTANTS ═══════════════ */
const APP_CONFIG = {
  // ⚠️ Must be the SAME deployed Apps Script URL as GAS_URL in index.html
  // and admin.html (the trial+payment backend). If you redeploy the script
  // and get a new /exec URL, update it in all three places at once.
  APPS_URL: "https://script.google.com/macros/s/AKfycbwAhfyQm7NvxaNjgRm3oC9SdKwrfKNfjgDd-J0nYjYAhsU1d2PP2JfyMI30ol9AGSatyg/exec",
};
const APPS = APP_CONFIG.APPS_URL;

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// Optional labels for organizing Bookmarks — assign one per bookmarked question.
const BK_TAGS = ['Need Check','Interesting','Debating','Confusing','Formulae'];
// Spaced-repetition schedule for the Wrong Bank: after N consecutive correct
// answers, a question is due again after SR_INTERVALS[N-1] days. Once a
// question has been answered correctly SR_INTERVALS.length times in a row,
// it's considered mastered and drops out of the Wrong Bank entirely.
const SR_INTERVALS = [1, 3, 7, 14]; // days
const LS = {
  // ⚠️ Must be the EXACT SAME key as index.html's localStorage.setItem('hau_session', ...).
  // index.html is the only place that writes this key. Do not rename either side alone.
  USER:'hau_session',
  PROG:'ha_prog', BK:'ha_bk', FL:'ha_fl', WR:'ha_wr',
  QC:'ha_qc_', TT:'ha_tt', STK:'ha_stk',
  FORCED_OFFLINE:'ha_forced_off'
};

/* ═══════════════ 2. APP STATE ═══════════════ */
const S = {
  user: null,
  online: navigator.onLine,
  forcedOffline: _load('ha_forced_off', false),
  bk: _load(LS.BK, []),
  fl: _load(LS.FL, []),
  wr: _load(LS.WR, []),
  prog: _load(LS.PROG, {total:0,correct:0,sessions:[]}),
  tt: _load(LS.TT, {sessions:[]}),
  stk: _load(LS.STK, {days:[],last:''}),
  dpi: null,
  localQs: null,
  quiz: {qs:[],ans:[],mode:'',idx:0,timer:null,elapsed:0,left:0,active:false,ch:''}
};

/* ═══════════════ 3. UTILITIES ═══════════════ */
function _load(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d}}
function _save(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch{toast('⚠️ Storage full — some data not saved');return false}}
function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
// Optional math-formula rendering. Question banks can write LaTeX between
// $...$ (inline) or $$...$$ (block) and it'll render via KaTeX; plain-text
// questions (the vast majority of existing content, which already uses
// Unicode like π²EI/4L²) are completely unaffected since they contain no
// $ delimiters. Safe no-op if KaTeX hasn't loaded yet (e.g. first paint
// while offline) or failed to load at all.
function renderMath(el){
  if(!el || typeof window.renderMathInElement !== 'function') return;
  try{
    window.renderMathInElement(el, {
      delimiters: [
        {left:'$$', right:'$$', display:true},
        {left:'$', right:'$', display:false}
      ],
      throwOnError:false
    });
  }catch(e){ /* malformed LaTeX in a question shouldn't break the quiz */ }
}
function shuf(a){const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]]}return b}
function fmt(s){if(s<0)s=0;return`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}
function today(){return new Date().toISOString().slice(0,10)}
function isOk(sel,cor){
  if(sel===null||sel===undefined||cor===null||cor===undefined)return false;
  const s=String(sel).trim(),c=String(cor).trim();
  return(!isNaN(s)&&!isNaN(c)&&s!==''&&c!=='')?Number(s)===Number(c):s.toLowerCase()===c.toLowerCase();
}
function normQ(raw,fid){
  if(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.success === false){
    console.warn('[normQ] Server error for', fid, '—', raw.error);
    return [];
  }
  let a = Array.isArray(raw) ? raw
        : (raw?.questions || raw?.data || raw?.quiz || raw?.items || raw?.result || null);
  if(!Array.isArray(a) && a === null && raw && typeof raw === 'object'){
    const vals = Object.values(raw);
    if(vals.length && vals[0] && (vals[0].q || vals[0].question || vals[0].Question)){
      a = vals;
    }
  }
  if(!Array.isArray(a)){
    console.warn('[normQ] Unrecognised format for', fid, '— got:', typeof raw,
      Array.isArray(raw)?'array':JSON.stringify(raw).slice(0,120));
    return [];
  }
  const result = [];
  let skipped = 0;
  a.forEach((q,i)=>{
    if(!q || typeof q !== 'object'){ skipped++; return; }
    const text = q.q || q.question || q.Question || q.stem || q.ques || q.text || '';
    if(!text){ skipped++; return; }
    let options = q.options || q.opts || q.choices || q.Options;
    if(!Array.isArray(options)){
      const lettered = [q.a||q.A, q.b||q.B, q.c||q.C, q.d||q.D, q.e||q.E]
        .filter(x=>x!==undefined && x!==null && x!=='');
      if(lettered.length >= 2) options = lettered;
    }
    if(!Array.isArray(options) || options.length < 2){ skipped++; return; }
    let correct = q.correct !== undefined ? q.correct
                : q.answer  !== undefined ? q.answer
                : q.ans     !== undefined ? q.ans
                : q.Answer  !== undefined ? q.Answer : undefined;
    if(typeof correct === 'string' && /^[a-eA-E]$/.test(correct.trim())){
      correct = 'abcde'.indexOf(correct.trim().toLowerCase());
    }
    result.push({
      q: String(text).trim(),
      options: options.map(String),
      correct,
      explanation: q.explanation||q.explain||q.exp||q.solution||q.hint||'',
      fileId: fid||'local',
      uid: `${fid||'local'}_${i}`
    });
  });
  if(skipped>0) console.warn(`[normQ] ${skipped}/${a.length} questions skipped in ${fid} (missing text or options)`);
  if(!result.length) console.warn('[normQ] Zero valid questions from', fid, '— raw sample:', JSON.stringify(a[0]).slice(0,200));
  return result;
}
function toast(msg,dur=3200){
  const c=document.getElementById('toasts');
  if(!c)return;
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  c.appendChild(t);
  setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),300)},dur);
}
function openMod(title,html){
  document.getElementById('mtitle').textContent=title;
  document.getElementById('mbody').innerHTML=html;
  document.getElementById('mbg').classList.add('show');
}
function closeMod(){document.getElementById('mbg').classList.remove('show')}
function qs(params){return Object.entries(params).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}
async function netFetch(url, opts, timeoutMs=20000){
  if(S.forcedOffline) throw new Error('OFFLINE');
  if(!S.online) throw new Error('OFFLINE');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, {...(opts||{}), signal:controller.signal});
    clearTimeout(timer);
    return res;
  }catch(err){
    clearTimeout(timer);
    if(err.name==='AbortError') throw new Error('Request timed out — the server is taking too long. Try again or check your connection.');
    throw err;
  }
}

/* ═══════════════ 4. AUTH — SESSION GATE ONLY ═══════════════
   No login/signup/admin here. index.html already handled sign-in,
   the 24h trial, and payment verification, and only sends someone
   to user.html once they have permanent OR trial access. This module
   just: (a) trusts the cached localStorage['hau_session'] if we're
   offline (as long as its access level still looks valid), and
   (b) re-validates with the server's `checkSession` action if we're
   online, exactly like index.html's own resumeUserSession() does.

   The session object read/written here is the SAME shape index.html
   uses — { type, username, name, email, mobile, token, access:{level,
   trialExpiresAt, permanent}, settings, lastVerified } — not the raw
   backend user row. If validation ever comes back expired/pending/
   rejected, we bounce back to index.html so it can show the right
   trial/payment/rejected state.
═══════════════════════════════════════════════════════════════ */
const AUTH = {
  async restore(){
    const u = _load(LS.USER, null);
    if(!u || u.type !== 'user' || !u.username){
      AUTH._bounce();
      return;
    }
    // Offline (or forced offline): trust the cached session IF its access
    // level still looks valid (permanent, or trial that hasn't expired yet).
    if(!S.online || S.forcedOffline){
      if(AUTH._isValidOffline(u)) AUTH._enter(u);
      else AUTH._bounce();
      return;
    }
    // Online: re-validate against the server, same contract index.html uses.
    try{
      const r = await netFetch(`${APPS}?${qs({action:'checkSession', token:u.token, username:u.username})}`, {redirect:'follow'});
      const res = await r.json();
      if(!res.success){ AUTH._bounce(); return; }
      const updated = AUTH._buildSession(u, res);
      _save(LS.USER, updated);
      if(updated.access.level === 'permanent' || updated.access.level === 'trial'){
        AUTH._enter(updated);
      } else {
        // Expired, pending, or rejected — index.html owns that UI.
        AUTH._bounce();
      }
    }catch{
      // Network hiccup — don't lock the person out if the cached session
      // still looks valid; only bounce if it's genuinely stale/expired.
      if(AUTH._isValidOffline(u)) AUTH._enter(u);
      else AUTH._bounce();
    }
  },

  // Same rule index.html itself uses to decide whether a cached session
  // is still good enough to study offline.
  _isValidOffline(u){
    const a = u.access || {};
    if(a.level === 'permanent') return true;
    if(a.level === 'trial' && a.trialExpiresAt) return new Date(a.trialExpiresAt) > Date.now();
    return false;
  },

  // Mirrors index.html's handleUserAuth() access-building logic exactly,
  // so both files always agree on what "permanent / trial / expired /
  // pending" means from the same checkSession response.
  _buildSession(prevSession, res){
    const user = res.user || {};
    const access = {
      level: res.permanentAccess || user.status === 'active' ? 'permanent'
             : res.isTrial ? 'trial'
             : res.needsPayment ? 'expired'
             : 'pending',
      trialExpiresAt: res.trialExpiresAt || user.trialExpiresAt,
      permanent: !!(res.permanentAccess || user.status === 'active'),
      accessType: res.accessType || user.accessType || 'permanent',
      accessExpiresAt: res.accessExpiresAt || user.accessExpiresAt || ''
    };
    return {
      ...prevSession,
      username: user.username || prevSession.username,
      name: user.name || prevSession.name,
      email: user.email || prevSession.email,
      mobile: user.mobile || prevSession.mobile,
      access,
      lastVerified: Date.now()
    };
  },

  _bounce(){
    window.location.href = 'index.html';
  },

  _enter(user){
    S.user = user;
    document.getElementById('sg').style.display='none';
    document.getElementById('app').classList.add('on');
    document.getElementById('uchip').textContent = '👤 ' + (user?.name||user?.username||'Student');
    AUTH._updateSidebarCard(user);
    if(!S.online) document.getElementById('offbar').classList.add('show');
    APP.init();
    TUTORIAL.maybeAutoOpen(user);
  },

  _updateSidebarCard(user){
    const nameEl = document.getElementById('sb-uname');
    const statusEl = document.getElementById('sb-ustatus');
    if(nameEl) nameEl.textContent = user?.name || user?.username || 'Student';
    if(statusEl){
      const a = user?.access || {};
      if(a.level==='permanent' && a.accessType==='yearly'){
        statusEl.textContent = a.accessExpiresAt ? `📅 Access until ${new Date(a.accessExpiresAt).toLocaleDateString()}` : '📅 Yearly access';
      } else if(a.level==='permanent'){
        statusEl.textContent = '✅ Permanent access';
      } else if(a.level==='trial'){
        statusEl.textContent = a.trialExpiresAt ? `⏳ Trial until ${new Date(a.trialExpiresAt).toLocaleString()}` : '⏳ Trial access';
      } else {
        statusEl.textContent = '—';
      }
    }
  },

  logout(){
    if(!confirm('Log out?'))return;
    localStorage.removeItem(LS.USER);
    window.location.href = 'index.html';
  },

  /* Light periodic re-check so a revoked account, or a trial that just
     ran out, doesn't keep studying indefinitely once back online. */
  _revalidateTimer:null,
  startPeriodicRecheck(){
    if(AUTH._revalidateTimer) clearInterval(AUTH._revalidateTimer);
    AUTH._revalidateTimer = setInterval(async ()=>{
      if(!S.online || S.forcedOffline || !S.user) return;
      try{
        const r = await netFetch(`${APPS}?${qs({action:'checkSession', token:S.user.token, username:S.user.username})}`, {redirect:'follow'});
        const res = await r.json();
        if(res.success){
          const updated = AUTH._buildSession(S.user, res);
          _save(LS.USER, updated);
          if(updated.access.level === 'permanent' || updated.access.level === 'trial'){
            S.user = updated;
          } else {
            AUTH._bounce();
          }
        }
      }catch{ /* ignore — don't punish for a flaky connection */ }
    }, 10*60*1000); // every 10 minutes
  }
};

/* ═══════════════ 5. PWA ═══════════════ */
const PWA = {
  init(){
    window.addEventListener('beforeinstallprompt', e=>{
      e.preventDefault(); S.dpi=e;
      const btn=document.getElementById('installBtn');
      if(btn) btn.style.display='';
    });
    window.addEventListener('appinstalled', ()=>{
      toast('📲 App installed!');
      const btn=document.getElementById('installBtn');
      if(btn) btn.style.display='none';
    });
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('./sw.js', {scope:'./'}).catch(()=>{});
    }
  },
  install(){
    if(S.dpi){ S.dpi.prompt(); S.dpi=null; const b=document.getElementById('installBtn'); if(b) b.style.display='none'; }
    else toast('Install option not available — try your browser\'s "Add to Home Screen" menu.');
  },
  toggleFullscreen(){
    if(!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(()=>toast('Fullscreen not supported here'));
    else document.exitFullscreen?.();
  }
};

/* ═══════════════ 6. UI ═══════════════ */
const UI = {
  cur: 'home',
  _goRaw(v){
    document.getElementById('quiz-wrap').style.display='none';
    document.querySelectorAll('.view').forEach(e=>e.classList.remove('on'));
    const el=document.getElementById('view-'+v);
    if(el)el.classList.add('on');
    document.querySelectorAll('.sb-item').forEach(e=>e.classList.remove('active'));
    const ni=document.getElementById('nav-'+v);
    if(ni)ni.classList.add('active');
    UI.cur=v;UI.sidebarClose();window.scrollTo(0,0);
    ({
      home:()=>HOME.render(),
      progress:()=>PROG.render(),
      offline:()=>CACHE.render(),
      bookmarks:()=>REV.renderList('bk'),
      flagged:()=>REV.renderList('fl'),
      wrong:()=>REV.renderList('wr'),
      timetable:()=>TT.render(),
      psycho:()=>PSY.init()
    })[v]?.();
  },
  go(v){
    if(S.quiz.active && document.getElementById('quiz-wrap').style.display !== 'none'){
      QUIZ._exitGuard(()=>UI._goRaw(v));
      return;
    }
    UI._goRaw(v);
  },
  sidebarToggle(){
    document.getElementById('sb').classList.toggle('open');
    document.getElementById('ov').classList.toggle('show');
  },
  sidebarClose(){
    document.getElementById('sb').classList.remove('open');
    document.getElementById('ov').classList.remove('show');
  },
  theme(){
    document.body.classList.toggle('light');
    _save('ha_theme', document.body.classList.contains('light')?'light':'dark');
  }
};

/* ═══════════════ 7a. (removed — Sidebar Quick Quiz) ═══════════════
   The sidebar's own Level→Chapter→Subtopic picker was removed in
   favor of the Online Study tab, which does the same job with a
   fuller layout and offline-cache-aware options. If you ever want
   a compact sidebar picker back, model it on the ON module below.
═══════════════════════════════════════════════════════════════ */

/* ═══════════════ 7b. ONLINE STUDY ═══════════════ */
const ON = {
  onLv(){
    const lv=document.getElementById('on-lv').value;
    const cs=document.getElementById('on-ch');
    cs.innerHTML='<option>📘 Select Chapter…</option>';cs.disabled=!lv;
    const bs=document.getElementById('on-bk');bs.innerHTML='<option>📚 Select Book…</option>';bs.disabled=true;
    const ts=document.getElementById('on-to');ts.innerHTML='<option>📑 Select Subtopic…</option>';ts.disabled=true;
    if(!lv)return;
    Object.entries(ChapterData.chapters(lv)).forEach(([k,n])=>{
      const fc=ChapterData.fileCount(lv,k);
      const o=document.createElement('option');o.value=k;o.textContent=`Ch${k}: ${n}${fc?'':' (coming soon)'}`;cs.appendChild(o);
    });
  },
  onCh(){
    const lv=document.getElementById('on-lv').value,ch=document.getElementById('on-ch').value;
    const bs=document.getElementById('on-bk');
    bs.innerHTML='<option>📚 Select Book…</option>';bs.disabled=true;
    const ts=document.getElementById('on-to');ts.innerHTML='<option>📑 Select Subtopic…</option>';ts.disabled=true;
    if(!lv||!ch)return;
    const books=ChapterData.books(lv,ch);
    if(!Object.keys(books).length){
      bs.innerHTML='<option>No books yet for this chapter</option>';
      toast('ℹ️ This chapter has no question files yet');
      return;
    }
    Object.keys(books).forEach(book=>{
      const fc=ChapterData.fileCount(lv,ch,book);
      const o=document.createElement('option');o.value=book;o.textContent=`${book}${fc?'':' (coming soon)'}`;bs.appendChild(o);
    });
    bs.disabled=false;
  },
  onBook(){
    const lv=document.getElementById('on-lv').value,ch=document.getElementById('on-ch').value,book=document.getElementById('on-bk').value;
    const ts=document.getElementById('on-to');
    ts.innerHTML='<option>📑 Select Subtopic…</option>';ts.disabled=true;
    if(!lv||!ch||!book)return;
    const files=ChapterData.files(lv,ch,book);
    if(!Object.keys(files).length){
      ts.innerHTML='<option>No files yet for this book</option>';
      toast('ℹ️ This book has no question files yet');
      return;
    }
    const isOfflineMode = !S.online || S.forcedOffline;
    let anyEnabled = false;
    Object.entries(files).forEach(([n,id])=>{
      if(!id)return;
      const cacheKey = `${lv}_${ch}_${book}_${n}`;
      const cached = _load(LS.QC+cacheKey, null);
      const isCached = cached && !(typeof cached==='object' && !Array.isArray(cached) && cached.success===false);
      const o=document.createElement('option');
      o.value=id;
      o.dataset.key=cacheKey;
      if(isOfflineMode && !isCached){
        o.textContent = `🔒 ${n} (not cached)`;
        o.disabled = true;
        o.style.color = 'var(--t3)';
      } else {
        o.textContent = isCached ? `📦 ${n}` : n;
        anyEnabled = true;
      }
      ts.appendChild(o);
    });
    ts.disabled=false;
    if(isOfflineMode && !anyEnabled){
      ts.innerHTML='<option>No cached files for this book</option>';
      toast('📡 You\'re offline — no cached files in this book. Cache them first while online.');
    }
  },
  start(mode){
    const ts=document.getElementById('on-to');
    const fid=ts.value,key=ts.options[ts.selectedIndex]?.dataset?.key;
    const ch=document.getElementById('on-ch').value,lv=document.getElementById('on-lv').value,book=document.getElementById('on-bk').value;
    if(!fid||!key){toast('Select a subtopic');return}
    const name=`${ChapterData.chapterName(lv,ch)} — ${book}`;
    QUIZ.load(fid,key,mode,name);
  }
};

/* ═══════════════ 7c. LOCAL FILE ═══════════════ */
const LOC = {
  onFile(){
    const f=document.getElementById('loc-file').files[0];if(!f)return;
    const r=new FileReader();
    r.onload=e=>{
      try{
        const qs2=normQ(JSON.parse(e.target.result),'local');
        if(!qs2.length){toast('❌ No valid questions found in file');return}
        S.localQs=qs2;
        const info=document.getElementById('loc-info');
        info.style.display='';info.textContent=`✅ ${qs2.length} questions loaded from "${f.name}"`;
        document.getElementById('loc-pr').disabled=false;
        document.getElementById('loc-ex').disabled=false;
        toast(`✅ ${qs2.length} questions ready`);
      }catch{toast('❌ Invalid JSON file')}
    };
    r.onerror=()=>toast('❌ Could not read file');
    r.readAsText(f);
  },
  start(mode){
    if(!S.localQs){toast('Load a JSON file first');return}
    QUIZ.startWith([...S.localQs],mode,'Local File');
  }
};

/* ═══════════════ 7d. PSYCHO MODE ═══════════════ */
const PSY = {
  LEVELS:[['level5','Level 5 — Diploma'],['level7','Level 7 — Civil Engineering'],['gk','General Knowledge']],
  init(){
    const box=document.getElementById('psy-levels');
    box.innerHTML = PSY.LEVELS.map(([lv,label])=>{
      const names=ChapterData.chapters(lv);
      const items=Object.entries(names).map(([k,n])=>{
        const fc=ChapterData.fileCount(lv,k);
        return `<div class="ch-item" onclick="this.querySelector('input').click()">
          <input type="checkbox" value="${k}" data-lv="${lv}" ${fc?'':'disabled'} onclick="event.stopPropagation();PSY._info()">
          <div class="ch-num">${k}</div>
          <div class="ch-name">${n}${fc?'':' <span style=\"color:var(--t3)\">(no files)</span>'}</div>
          <div class="ch-cnt">${fc}f</div>
        </div>`;
      }).join('');
      return `<div class="sb-lbl" style="margin-top:.7rem;display:flex;align-items:center;justify-content:space-between;padding-right:.2rem">
          <span>${label}</span>
          <span style="display:flex;gap:.3rem">
            <button class="btn btn-sm btn-c" style="font-size:.56rem;padding:.15rem .4rem" onclick="PSY.allLv('${lv}')">✅ All</button>
            <button class="btn btn-sm btn-r" style="font-size:.56rem;padding:.15rem .4rem" onclick="PSY.noneLv('${lv}')">✕</button>
          </span>
        </div>
        <div class="ch-list" id="psy-lv-${lv}">${items || '<div class="empty"><div class="empty-i">📚</div><p>No chapters yet</p></div>'}</div>`;
    }).join('');
    PSY._info();
  },
  all(){document.querySelectorAll('#psy-levels input:not(:disabled)').forEach(c=>c.checked=true);PSY._info()},
  none(){document.querySelectorAll('#psy-levels input').forEach(c=>c.checked=false);PSY._info()},
  allLv(lv){document.querySelectorAll(`#psy-lv-${lv} input:not(:disabled)`).forEach(c=>c.checked=true);PSY._info()},
  noneLv(lv){document.querySelectorAll(`#psy-lv-${lv} input`).forEach(c=>c.checked=false);PSY._info()},
  _info(){
    const n=document.querySelectorAll('#psy-levels input:checked').length;
    document.getElementById('psy-info').textContent=n?`${n} chapter${n>1?'s':''} selected — ready to load`:'Select at least 1 chapter to continue';
  },
  async start(type){
    const cbs=[...document.querySelectorAll('#psy-levels input:checked')];
    if(!cbs.length){toast('Select at least one chapter');return}
    const totalFiles = cbs.reduce((n,cb)=>n+ChapterData.chapterFileRefs(cb.dataset.lv,cb.value).length,0);
    QUIZ._showLoader(`Loading ${cbs.length} chapter${cbs.length>1?'s':''} (0/${totalFiles})…`);
    const all=[];
    let done=0,failed=0;
    for(const cb of cbs){
      const lv=cb.dataset.lv;
      const ch=cb.value;
      for(const ref of ChapterData.chapterFileRefs(lv,ch)){
        try{
          const raw=await QUIZ._fetch(ref.fid,ref.key);
          all.push(...normQ(raw,ref.fid));
          done++;
          document.getElementById('quiz-loader-msg').textContent=`Loading files (${done}/${totalFiles})…`;
        }catch{ failed++; }
      }
    }
    QUIZ._hideLoader();
    if(!all.length){toast('❌ No questions loaded. Cache data first if offline.',5000);return}
    if(failed>0) toast(`⚠️ ${failed} file${failed>1?'s':''} failed to load — starting with ${all.length} questions`);
    let qsArr=shuf(all);
    if(type==='exam')qsArr=qsArr.slice(0,100);
    if(type==='weak'){
      const wu=new Set(S.wr.map(w=>w.uid));
      const weak=qsArr.filter(q=>wu.has(q.uid));
      qsArr=weak.length?weak:qsArr.slice(0,50);
      if(!weak.length)toast('ℹ️ No wrong answers yet — showing 50 random instead');
    }
    QUIZ.startWith(qsArr,type==='exam'?'exam':'flashcard','⚡ Psycho Mode');
  }
};

/* ═══════════════ 8. REVIEW LISTS (bookmarks / flagged / wrong) ═══════════════ */
const REV = {
  _store(kind){ return kind==='bk'?S.bk : kind==='fl'?S.fl : S.wr; },
  _lsKey(kind){ return kind==='bk'?LS.BK : kind==='fl'?LS.FL : LS.WR; },
  _listEl(kind){ return kind==='bk'?'bk-list' : kind==='fl'?'fl-list' : 'wr-list'; },

  toggle(kind, question){
    const arr = REV._store(kind);
    const i = arr.findIndex(x=>x.uid===question.uid);
    if(i>-1){ arr.splice(i,1); toast(kind==='bk'?'⭐ Removed bookmark':'🚩 Removed flag'); }
    else { arr.push(kind==='bk' ? {...question, tag:''} : question); toast(kind==='bk'?'⭐ Bookmarked':'🚩 Flagged'); }
    _save(REV._lsKey(kind), arr);
    HOME.updateBadges();
    return i===-1;
  },
  has(kind, uid){ return REV._store(kind).some(x=>x.uid===uid); },
  getTag(uid){ return S.bk.find(x=>x.uid===uid)?.tag || ''; },
  setTag(uid, tag, questionObj){
    let item = S.bk.find(x=>x.uid===uid);
    if(!item && questionObj){ item = {...questionObj, tag: ''}; S.bk.push(item); }
    if(!item) return;
    item.tag = tag;
    _save(LS.BK, S.bk);
    REV.renderList('bk');
    HOME.updateBadges?.();
  },

  addWrong(question){
    const existing = S.wr.find(x=>x.uid===question.uid);
    if(existing){ existing._streak = 0; existing._nextDue = Date.now(); _save(LS.WR, S.wr); HOME.updateBadges(); return; }
    S.wr.push({...question, _streak:0, _nextDue: Date.now()});
    _save(LS.WR, S.wr);
    HOME.updateBadges();
  },
  removeWrong(uid){
    const i=S.wr.findIndex(x=>x.uid===uid);
    if(i>-1){ S.wr.splice(i,1); _save(LS.WR, S.wr); HOME.updateBadges(); }
  },
  // Call this instead of addWrong/removeWrong directly when scoring an
  // answer. A question only leaves the Wrong Bank once it's cleared every
  // step of the spaced-repetition schedule (SR_INTERVALS) — one lucky guess
  // doesn't clear it, and correctly-answered questions come back for review
  // at increasing intervals (1 day → 3 days → 7 days → 14 days) rather than
  // just "answer right twice in a row with no regard for timing."
  trackAnswer(question, isCorrect){
    if(isCorrect){
      const item = S.wr.find(x=>x.uid===question.uid);
      if(!item) return; // wasn't in the wrong bank, nothing to track
      item._streak = (item._streak||0) + 1;
      if(item._streak >= SR_INTERVALS.length){ REV.removeWrong(question.uid); }
      else {
        const days = SR_INTERVALS[item._streak - 1];
        item._nextDue = Date.now() + days*24*60*60*1000;
        _save(LS.WR, S.wr);
      }
    } else {
      REV.addWrong(question);
    }
  },
  // Items due for review now (or items with no schedule yet, e.g. carried
  // over from before this feature existed — treated as immediately due so
  // nothing old silently disappears from view).
  dueWrong(){ return S.wr.filter(x => (x._nextDue==null) || x._nextDue <= Date.now()); },
  dueCount(){ return REV.dueWrong().length; },

  renderList(kind){
    let arr = REV._store(kind);
    const el = document.getElementById(REV._listEl(kind));
    if(!el)return;
    if(!arr.length){
      el.innerHTML = `<div class="empty"><div class="empty-i">${kind==='bk'?'⭐':kind==='fl'?'🚩':'❌'}</div><p>Nothing here yet</p></div>`;
      return;
    }
    if(kind==='wr'){
      // Due-for-review items first, then items scheduled for later (soonest first).
      arr = [...arr].sort((a,b)=>(a._nextDue??0)-(b._nextDue??0));
    }
    el.innerHTML = arr.map((q,i)=>{
      const opts=(q.options||[]).map((o,j)=>{
        const c=String(j)===String(q.correct)||j===Number(q.correct);
        return `<div class="eo${c?' shc':''}">${String.fromCharCode(65+j)}) ${esc(o)}</div>`;
      }).join('');
      const tagPicker = kind==='bk' ? `
        <select class="sel-c" style="margin-top:.4rem;font-size:.7rem;padding:.25rem .4rem;width:auto" onchange="REV.setTag('${esc(q.uid||'')}', this.value)">
          <option value="">🏷 No tag</option>
          ${BK_TAGS.map(t=>`<option value="${t}" ${q.tag===t?'selected':''}>${t}</option>`).join('')}
        </select>` : '';
      let srBadge = '';
      if(kind==='wr'){
        const isDue = (q._nextDue==null) || q._nextDue<=Date.now();
        const streak = q._streak||0;
        if(isDue){ srBadge = `<span class="ctag tr" style="margin-left:.3rem">🔁 Due now</span>`; }
        else {
          const daysLeft = Math.ceil((q._nextDue-Date.now())/(24*60*60*1000));
          srBadge = `<span class="ctag ta" style="margin-left:.3rem">⏳ Due in ${daysLeft}d</span>`;
        }
        if(streak>0) srBadge += `<span class="ctag tg" style="margin-left:.3rem">✓×${streak}</span>`;
      }
      return `<div class="qcard" style="margin-bottom:.5rem">
        <div class="qm"><span class="qn mono">#${i+1}</span>
          ${q.tag ? `<span class="ctag ta" style="margin-left:.3rem">🏷 ${esc(q.tag)}</span>` : ''}
          ${srBadge}
          <button class="ib" onclick="REV._removeOne('${kind}','${esc(q.uid||'')}')">🗑</button>
        </div>
        <div class="qt" style="font-size:.82rem">${esc(q.q)}</div>
        <div style="margin-top:.3rem">${opts}</div>
        ${q.explanation?`<div class="expl show" style="margin-top:.45rem">${esc(q.explanation)}</div>`:''}
        ${tagPicker}
      </div>`;
    }).join('');
    renderMath(el);
  },
  _removeOne(kind, uid){
    const arr=REV._store(kind);
    const i=arr.findIndex(x=>x.uid===uid);
    if(i>-1){arr.splice(i,1);_save(REV._lsKey(kind),arr);REV.renderList(kind);HOME.updateBadges();}
  },
  clearAll(kind){
    if(!confirm('Clear this whole list?'))return;
    if(kind==='bk'){S.bk=[];_save(LS.BK,[]);}
    else if(kind==='fl'){S.fl=[];_save(LS.FL,[]);}
    else {S.wr=[];_save(LS.WR,[]);}
    REV.renderList(kind); HOME.updateBadges();
    toast('🗑 Cleared');
  },
  start(kind, mode, dueOnly){
    let arr = [...REV._store(kind)];
    if(kind==='wr' && dueOnly) arr = REV.dueWrong();
    if(!arr.length){toast(dueOnly?'Nothing due for review right now 🎉':'Nothing to study here yet');return}
    QUIZ.startWith(shuf(arr), mode, kind==='bk'?'⭐ Bookmarks':kind==='fl'?'🚩 Flagged':(dueOnly?'🔁 Wrong Bank (Due Today)':'❌ Wrong Bank'));
  }
};

/* ═══════════════ 9. QUIZ ENGINE ═══════════════ */
const QUIZ = {
  async _fetch(fileId, cacheKey, attempt=1){
    const ck = LS.QC + cacheKey;
    function _validCache(v){
      if(!v) return false;
      if(v && typeof v === 'object' && !Array.isArray(v) && v.success === false) return false;
      return true;
    }
    if(!S.online){
      const cached = _load(ck, null);
      if(_validCache(cached)) return cached;
      if(cached && !_validCache(cached)) throw new Error('Cached data is invalid (a previous network error was stored). Go online to refresh it.');
      throw new Error('You are offline and this set is not cached yet. Go to the Offline Cache tab to download it while online.');
    }
    try{
      const r = await netFetch(`${APPS}?${qs({action:'getFile', fileId})}`, {redirect:'follow'}, 25000);
      const text = await r.text();
      if(text.trim().startsWith('<')){
        throw new Error('Server returned an HTML page instead of JSON — the Apps Script may be down or requires re-authorisation.');
      }
      let data;
      try{ data = JSON.parse(text); }
      catch(pe){ throw new Error('Could not parse server response. The file may be corrupted or the server returned an unexpected format.'); }
      if(data && typeof data === 'object' && !Array.isArray(data) && data.success === true){
        if(data.result !== undefined) data = data.result;
        else if(data.data !== undefined) data = data.data;
        else if(data.questions !== undefined) data = data.questions;
      }
      if(data && typeof data === 'object' && !Array.isArray(data) && data.success === false){
        throw new Error(data.error || 'Server returned an error for this file.');
      }
      if(_validCache(data)){
        _save(ck, data);
      }
      return data;
    } catch(err){
      const cached = _load(ck, null);
      if(_validCache(cached)){ toast('📦 Loaded from cache (network error)'); return cached; }
      if(attempt < 2 && (err.message.includes('timed out') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))){
        toast('⚠️ Slow connection — retrying…');
        await new Promise(res => setTimeout(res, 1500));
        return QUIZ._fetch(fileId, cacheKey, attempt + 1);
      }
      throw err;
    }
  },

  async load(fileId, cacheKey, mode, chapterName){
    if(!S.online || S.forcedOffline){
      const ck = LS.QC + cacheKey;
      const cached = _load(ck, null);
      const isValid = cached && !(typeof cached === 'object' && !Array.isArray(cached) && cached.success === false);
      if(!isValid){
        QUIZ._showError('You are offline and this set is not cached yet. Go to the Offline Cache tab while online to download it.', null);
        return;
      }
    }
    QUIZ._showLoader('Connecting to server…');
    const msgTimer = setTimeout(()=>{
      QUIZ._showLoader('Still loading… (Apps Script may be warming up)');
    }, 5000);
    const msgTimer2 = setTimeout(()=>{
      QUIZ._showLoader('Taking longer than usual… please wait or check your connection.');
    }, 12000);
    try{
      const raw = await QUIZ._fetch(fileId, cacheKey);
      clearTimeout(msgTimer); clearTimeout(msgTimer2);
      const qsArr = normQ(raw, fileId);
      QUIZ._hideLoader();
      if(!qsArr.length){ toast('❌ No valid questions found in this file. Check the file format.'); return; }
      QUIZ.startWith(qsArr, mode, chapterName);
    } catch(err){
      clearTimeout(msgTimer); clearTimeout(msgTimer2);
      QUIZ._hideLoader();
      const msg = err.message==='OFFLINE'
        ? 'You are offline and this set is not cached. Download it first from the Offline Cache tab.'
        : err.message;
      QUIZ._showError(msg, ()=>QUIZ.load(fileId, cacheKey, mode, chapterName));
    }
  },

  _showError(msg, retryFn){
    let el = document.getElementById('quiz-error-card');
    if(!el){
      el = document.createElement('div');
      el.id = 'quiz-error-card';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1.5rem';
      document.body.appendChild(el);
    }
    el._retry = retryFn || null;
    el.innerHTML = `<div style="background:var(--c2);border:1px solid var(--bad-bd);border-radius:var(--r3);padding:1.4rem 1.5rem;max-width:380px;width:100%;box-shadow:var(--sh3)">
      <div style="font-size:1.4rem;margin-bottom:.5rem">❌</div>
      <div style="font-family:var(--fd);font-size:.92rem;font-weight:700;color:var(--ros);margin-bottom:.6rem">Failed to Load</div>
      <div style="font-size:.78rem;color:var(--t2);line-height:1.6;margin-bottom:1rem">${esc(msg)}</div>
      <div style="display:flex;gap:.5rem">
        <button id="quiz-err-retry" style="flex:1;padding:.58rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r1);color:#0F0A00;font-weight:700;font-size:.82rem;cursor:pointer;font-family:var(--ff)">🔄 Retry</button>
        <button onclick="document.getElementById('quiz-error-card').remove()" style="padding:.58rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.82rem;cursor:pointer;font-family:var(--ff)">✕ Close</button>
      </div>
    </div>`;
    el.style.display = 'flex';
    document.getElementById('quiz-err-retry').onclick = ()=>{ el.remove(); if(el._retry) el._retry(); };
  },

  _showLoader(msg){
    let el = document.getElementById('quiz-loader');
    if(!el){
      el = document.createElement('div');
      el.id = 'quiz-loader';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:1rem;backdrop-filter:blur(4px)';
      el.innerHTML = '<div style="width:44px;height:44px;border:4px solid rgba(255,255,255,.2);border-top-color:var(--neon,#00e5ff);border-radius:50%;animation:spin 0.8s linear infinite"></div><div id="quiz-loader-msg" style="color:#fff;font-size:.9rem;font-weight:600;text-align:center;padding:0 1.5rem"></div>';
      document.body.appendChild(el);
      if(!document.getElementById('quiz-loader-style')){
        const st = document.createElement('style');
        st.id = 'quiz-loader-style';
        st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st);
      }
    }
    document.getElementById('quiz-loader-msg').textContent = msg || 'Loading…';
    el.style.display = 'flex';
  },
  _hideLoader(){
    const el = document.getElementById('quiz-loader');
    if(el) el.style.display = 'none';
  },

  startWith(qsArr, mode, chapterName){
    if(!qsArr || !qsArr.length){ toast('No questions to study'); return; }
    QUIZ._stopTimer();
    if(qsArr.length > 20){
      QUIZ._showLimitPicker(qsArr, mode, chapterName);
      return;
    }
    QUIZ._doStart(qsArr, mode, chapterName);
  },

  _showLimitPicker(qsArr, mode, chapterName){
    if(document.getElementById('quiz-limit-modal')) return;
    const total = qsArr.length;
    const presets = [10,20,30,50].filter(n=>n<total);
    const modal = document.createElement('div');
    modal.id = 'quiz-limit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1.5rem;backdrop-filter:blur(4px)';
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.5rem;max-width:340px;width:100%;box-shadow:var(--sh3)">
        <div style="font-size:1.2rem;margin-bottom:.35rem">${mode==='exam'?'📝':'⚡'}</div>
        <div style="font-family:var(--fd);font-size:.92rem;font-weight:700;color:var(--t1);margin-bottom:.2rem">${esc(chapterName||'Quiz')}</div>
        <div style="font-size:.74rem;color:var(--t3);margin-bottom:1rem">${total} questions available — how many do you want to do?</div>
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
          ${presets.map(n=>`<button onclick="document.getElementById('qlm-inp').value=${n}" style="padding:.35rem .7rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.76rem;cursor:pointer;font-family:var(--ff)">${n}</button>`).join('')}
          <button onclick="document.getElementById('qlm-inp').value=${total}" style="padding:.35rem .7rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r1);color:var(--t2);font-size:.76rem;cursor:pointer;font-family:var(--ff)">All ${total}</button>
        </div>
        <input id="qlm-inp" type="number" min="1" max="${total}" value="${Math.min(20,total)}"
          style="width:100%;background:var(--c1);border:1.5px solid var(--b1);border-radius:var(--r2);padding:.5rem .75rem;color:var(--t1);font-size:.9rem;font-family:var(--ff);outline:none;box-sizing:border-box;margin-bottom:.6rem">
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;cursor:pointer;font-size:.8rem;color:var(--t2)">
          <input id="qlm-shuffle" type="checkbox" checked style="width:16px;height:16px;accent-color:var(--amb);cursor:pointer">
          🔀 Shuffle question order
        </label>
        <div style="display:flex;gap:.4rem">
          <button id="qlm-start" style="flex:1;padding:.62rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r2);color:#0F0A00;font-weight:700;font-size:.85rem;cursor:pointer;font-family:var(--ff)">Start →</button>
          <button onclick="document.getElementById('quiz-limit-modal').remove()" style="padding:.62rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-size:.83rem;cursor:pointer;font-family:var(--ff)">✕</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e=>{ if(e.target===modal) modal.remove(); });
    document.getElementById('qlm-start').onclick = ()=>{
      const n = Math.min(total, Math.max(1, parseInt(document.getElementById('qlm-inp').value)||total));
      const doShuffle = document.getElementById('qlm-shuffle').checked;
      modal.remove();
      const picked = doShuffle ? shuf(qsArr).slice(0,n) : qsArr.slice(0,n);
      QUIZ._doStart(picked, mode, chapterName, false);
    };
  },

  _doStart(qsArr, mode, chapterName, doShuffle=true){
    const modeLabel = mode==='exam' ? '📝 Exam' : '⚡ Flashcard';
    toast(`${modeLabel} — ${qsArr.length} question${qsArr.length!==1?'s':''} · ${chapterName||'Study'}`, 2500);
    S.quiz = {
      qs: doShuffle ? shuf(qsArr) : [...qsArr], ans: new Array(qsArr.length).fill(null),
      mode, idx:0, timer:null, elapsed:0,
      left: mode==='exam' ? qsArr.length*90 : 0,
      active:true, ch: chapterName||'Study', skipped:new Set(), shown:new Set()
    };
    document.getElementById('quiz-wrap').style.display='';
    document.querySelectorAll('.view').forEach(e=>e.classList.remove('on'));
    window.scrollTo(0,0); // previous view may have been scrolled down — reset so the quiz card isn't pushed below the fold
    try{
      if(mode==='exam'){
        document.getElementById('fc-wrap').style.display='none';
        document.getElementById('ex-wrap').style.display='';
        document.getElementById('res-wrap').style.display='none';
        QUIZ._renderExam();
      } else {
        document.getElementById('ex-wrap').style.display='none';
        document.getElementById('fc-wrap').style.display='';
        document.getElementById('res-wrap').style.display='none';
        QUIZ._renderFlashcard();
      }
    } catch(err){
      // Never leave a phantom "active" quiz that's blank on screen but still
      // blocks navigation with the exit-guard — undo the start cleanly.
      console.error('[QUIZ._doStart] render failed:', err);
      S.quiz.active = false;
      document.getElementById('quiz-wrap').style.display = 'none';
      toast('❌ Could not display this quiz — one of the questions may be malformed. Try a different set.', 5000);
      return;
    }
    QUIZ._startTimer();
  },

  daily(){
    const refs = ChapterData.allFileRefs();
    if(!refs.length){ toast('No content configured yet'); return; }
    toast('⏳ Building today\'s challenge…');
    (async()=>{
      const picks = shuf(refs).slice(0, Math.min(10, refs.length));
      const all = [];
      let failed = 0;
      for(const ref of picks){
        try{
          const raw = await QUIZ._fetch(ref.fid, ref.key);
          const qs2 = normQ(raw, ref.fid);
          all.push(...qs2);
        }catch(e){
          failed++;
          console.warn('[daily] Failed to load', ref.key, e.message);
        }
      }
      if(!all.length){ toast('❌ Could not load daily challenge — try caching data first'); return; }
      if(failed>0) toast(`⚠️ ${failed} file(s) failed — challenge uses ${all.length} questions`);
      const qsArr = shuf(all).slice(0,30);
      QUIZ.startWith(qsArr, 'flashcard', '🌟 Daily Challenge');
      STREAK.markToday();
    })();
  },

  // Adaptive Practice: builds a session weighted toward what you're
  // actually struggling with, rather than pure random content.
  // Priority order: (1) Wrong Bank items due today (spaced repetition),
  // (2) bookmarks tagged "Confusing" or "Need Check", (3) fresh random
  // questions to fill up to a reasonable session size. No network calls
  // needed for (1)/(2) — they're already stored locally.
  async adaptive(){
    const TARGET = 25;
    const seen = new Set();
    const pool = [];
    const addAll = list => { for(const q of list){ if(q && q.uid && !seen.has(q.uid)){ seen.add(q.uid); pool.push(q); } } };

    addAll(REV.dueWrong());
    addAll(S.bk.filter(q => q.tag==='Confusing' || q.tag==='Need Check'));

    if(pool.length >= TARGET){
      QUIZ.startWith(shuf(pool).slice(0,TARGET), 'flashcard', '🎯 Adaptive Practice');
      return;
    }

    const refs = ChapterData.allFileRefs();
    if(!refs.length){
      if(pool.length){ QUIZ.startWith(shuf(pool), 'flashcard', '🎯 Adaptive Practice'); return; }
      toast('No content configured yet'); return;
    }
    toast('⏳ Building your adaptive practice set…');
    const need = TARGET - pool.length;
    const picks = shuf(refs).slice(0, Math.min(8, refs.length));
    let failed = 0;
    for(const ref of picks){
      if(pool.length - (TARGET-need) >= need*2) break; // don't over-fetch once we clearly have enough
      try{
        const raw = await QUIZ._fetch(ref.fid, ref.key);
        addAll(normQ(raw, ref.fid));
      }catch(e){
        failed++;
        console.warn('[adaptive] Failed to load', ref.key, e.message);
      }
    }
    if(!pool.length){ toast('❌ Could not build a practice set — try caching data first'); return; }
    if(failed>0) toast(`⚠️ ${failed} file(s) failed — practice set uses what loaded`);
    QUIZ.startWith(shuf(pool).slice(0,TARGET), 'flashcard', '🎯 Adaptive Practice');
  },


  _startTimer(){
    QUIZ._stopTimer();
    S.quiz.timer = setInterval(()=>{
      if(!S.quiz.active)return;
      if(S.quiz.mode==='exam'){
        S.quiz.left--;
        const tEl=document.getElementById('ex-tmr'); if(tEl) tEl.textContent=fmt(S.quiz.left);
        if(S.quiz.left<=0){ toast('⏰ Time\'s up!'); QUIZ.submitExam(); }
      } else {
        S.quiz.elapsed++;
        const tEl=document.getElementById('fc-tmr'); if(tEl) tEl.textContent=fmt(S.quiz.elapsed);
      }
    },1000);
  },
  _stopTimer(){ if(S.quiz.timer){ clearInterval(S.quiz.timer); S.quiz.timer=null; } },

  quit(){
    QUIZ._exitGuard(()=>{ UI._goRaw('home'); });
  },

  _exitGuard(afterQuit){
    if(document.getElementById('quiz-exit-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'quiz-exit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:10000;padding:1.5rem;backdrop-filter:blur(4px)';
    const isExam = S.quiz.mode === 'exam';
    const answered = S.quiz.ans.filter(a=>a!==null).length;
    const total = S.quiz.qs.length;
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.5rem;max-width:340px;width:100%;box-shadow:var(--sh3)">
        <div style="font-size:1.3rem;margin-bottom:.4rem">⚠️</div>
        <div style="font-family:var(--fd);font-size:.95rem;font-weight:700;color:var(--t1);margin-bottom:.3rem">Leave this quiz?</div>
        <div style="font-size:.76rem;color:var(--t3);margin-bottom:1.1rem">${isExam ? answered+' of '+total+' answered' : 'Question '+(S.quiz.idx+1)+' of '+total} · ${S.quiz.ch}</div>
        <div style="display:flex;flex-direction:column;gap:.45rem">
          ${isExam ? '<button id="qem-finish" style="padding:.62rem;background:var(--ok-bg);border:1px solid var(--ok-bd);border-radius:var(--r2);color:var(--grn);font-weight:700;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left">✅ Submit & See Results — grade what I have answered so far</button>' : ''}
          <button id="qem-quit" style="padding:.62rem;background:var(--bad-bg);border:1px solid var(--bad-bd);border-radius:var(--r2);color:var(--ros);font-weight:700;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left">🚪 Quit — discard this session</button>
          <button id="qem-cancel" style="padding:.62rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-weight:600;font-size:.83rem;cursor:pointer;font-family:var(--ff);text-align:left">↩ Cancel — keep studying</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = ()=> modal.remove();
    if(isExam){
      document.getElementById('qem-finish').onclick = ()=>{ close(); QUIZ.submitExam(); };
    }
    document.getElementById('qem-quit').onclick = ()=>{
      close();
      QUIZ._stopTimer();
      S.quiz.active = false;
      document.getElementById('quiz-wrap').style.display = 'none';
      if(afterQuit) afterQuit();
    };
    document.getElementById('qem-cancel').onclick = close;
    modal.addEventListener('click', e=>{ if(e.target===modal) close(); });
  },

  /* ── FLASHCARD MODE ── */
  _renderFlashcard(){
    const q = S.quiz.qs[S.quiz.idx];
    if(!q)return;
    try{
      document.getElementById('fc-chip').textContent = '⚡ ' + S.quiz.ch;
      document.getElementById('fc-ctr').textContent = `${S.quiz.idx+1}/${S.quiz.qs.length}`;
      document.getElementById('fc-pf').style.width = `${((S.quiz.idx)/S.quiz.qs.length)*100}%`;
      document.getElementById('fc-qn').textContent = 'Q'+(S.quiz.idx+1);
      document.getElementById('fc-q').textContent = q.q;

      const isStarred = REV.has('bk', q.uid), isFlagged = REV.has('fl', q.uid);
      document.getElementById('fc-acts').innerHTML = `
        <button class="ib ${isStarred?'bk-on':''}" onclick="QUIZ._star()" title="Bookmark">⭐</button>
        <button class="ib ${isFlagged?'fl-on':''}" onclick="QUIZ._flag()" title="Flag">🚩</button>
        <button class="ib" onclick="SRCH.toggle()" title="Search (Ctrl+F)">🔍</button>
        <select class="sel-c" style="font-size:.68rem;padding:.2rem .35rem;width:auto" onchange="QUIZ._tagCurrent(this.value)">
          <option value="">🏷 Tag…</option>
          ${BK_TAGS.map(t=>`<option value="${t}" ${REV.getTag(q.uid)===t?'selected':''}>${t}</option>`).join('')}
        </select>
      `;

      const ansIdx = S.quiz.ans[S.quiz.idx];
      const answered = ansIdx !== null;
      const optsEl = document.getElementById('fc-opts');
      optsEl.innerHTML = q.options.map((opt,i)=>{
        let cls='eo';
        if(answered){
          const isCorrect = isOk(i, q.correct);
          const isSelected = i===ansIdx;
          if(isCorrect) cls += ' shc';
          else if(isSelected) cls += ' bad2';
        }
        return `<div class="${cls}" onclick="${answered?'':'QUIZ.fcAnswer('+i+')'}" style="${answered?'cursor:default;pointer-events:none':''}">
          <div class="ok">${String.fromCharCode(65+i)}</div><div>${esc(opt)}</div>
        </div>`;
      }).join('');

      const expl = document.getElementById('fc-expl');
      if(answered && q.explanation){ expl.textContent = q.explanation; expl.classList.add('show'); }
      else { expl.classList.remove('show'); expl.textContent=''; }

      document.getElementById('fc-hint').textContent = answered ? 'Use Next →' : 'Tap an option to answer';
      document.getElementById('fc-prev').disabled = S.quiz.idx===0;
      document.getElementById('fc-next').textContent = S.quiz.idx===S.quiz.qs.length-1 ? 'Finish ✔' : 'Next →';

      QUIZ._updateFcCounts();
      renderMath(document.getElementById('fc-wrap'));
    } catch(err){
      console.error('[QUIZ._renderFlashcard] question at idx', S.quiz.idx, 'failed to render:', err, q);
      toast('⚠️ Skipped a malformed question', 2000);
      if(S.quiz.idx < S.quiz.qs.length-1){ S.quiz.idx++; QUIZ._renderFlashcard(); }
      else QUIZ.fcFinish();
    }
  },
  _updateFcCounts(){
    let ok=0,bad=0,skip=0;
    S.quiz.ans.forEach((a,i)=>{
      if(a===null){ if(S.quiz.shown?.has(i)) skip++; return; }
      if(isOk(a, S.quiz.qs[i].correct)) ok++; else bad++;
    });
    document.getElementById('fc-ok').textContent=ok;
    document.getElementById('fc-bad').textContent=bad;
    document.getElementById('fc-skip').textContent=skip;
  },
  fcAnswer(i){
    if(S.quiz.ans[S.quiz.idx]!==null)return;
    S.quiz.ans[S.quiz.idx]=i;
    const q=S.quiz.qs[S.quiz.idx];
    const correct=isOk(i,q.correct);
    if(correct){ PROG.track(true); REV.trackAnswer(q, true); }
    else { PROG.track(false); REV.trackAnswer(q, false); }
    QUIZ._renderFlashcard();
  },
  fcNav(dir){
    if(!S.quiz.shown) S.quiz.shown=new Set();
    S.quiz.shown.add(S.quiz.idx);
    const next = S.quiz.idx+dir;
    if(next<0)return;
    if(next>=S.quiz.qs.length){ QUIZ.fcFinish(); return; }
    S.quiz.idx=next;
    QUIZ._renderFlashcard();
  },
  _star(){
    const q=S.quiz.qs[S.quiz.idx];
    REV.toggle('bk', q);
    QUIZ._renderFlashcard();
  },
  _flag(){
    const q=S.quiz.qs[S.quiz.idx];
    REV.toggle('fl', q);
    QUIZ._renderFlashcard();
  },
  _tagCurrent(tag){
    const q=S.quiz.qs[S.quiz.idx];
    if(!q) return;
    REV.setTag(q.uid, tag, q);
    QUIZ._renderFlashcard();
  },
  fcFinish(){
    QUIZ._stopTimer();
    S.quiz.active=false;
    STREAK.markToday();
    QUIZ._showResults();
  },

  /* ── EXAM MODE ── */
  _renderExam(){
    document.getElementById('ex-chip').textContent = '📝 ' + S.quiz.ch;
    document.getElementById('ex-ctr').textContent = `0/${S.quiz.qs.length}`;
    document.getElementById('ex-tmr').textContent = fmt(S.quiz.left);
    const el = document.getElementById('ex-qs');
    el.innerHTML = S.quiz.qs.map((q,qi)=>{
      const gq = encodeURIComponent(q.q.slice(0,120));
      return `
      <div class="eqc" id="eqc-${qi}">
        <div class="qm"><span class="qn mono">Q${qi+1}</span><a class="ib" href="https://www.google.com/search?q=${gq}" target="_blank" rel="noopener" title="Search on Google" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px">🔍</a></div>
        <div class="qt" style="font-size:.85rem">${esc(q.q)}</div>
        ${q.options.map((opt,oi)=>`
          <div class="eo" onclick="QUIZ.exAnswer(${qi},${oi})" id="eo-${qi}-${oi}">
            <div class="ok">${String.fromCharCode(65+oi)}</div><div>${esc(opt)}</div>
          </div>
        `).join('')}
      </div>
    `}).join('');
    renderMath(el);
  },
  exAnswer(qi, oi){
    if(!S.quiz.active)return;
    S.quiz.ans[qi]=oi;
    document.querySelectorAll(`#eqc-${qi} .eo`).forEach((e,i)=>e.classList.toggle('sel', i===oi));
    document.getElementById(`eqc-${qi}`).classList.add('answered');
    const answered = S.quiz.ans.filter(a=>a!==null).length;
    document.getElementById('ex-ctr').textContent = `${answered}/${S.quiz.qs.length}`;
    document.getElementById('ex-ans').textContent = answered;
    document.getElementById('ex-pf').style.width = `${(answered/S.quiz.qs.length)*100}%`;
  },
  submitExam(){
    if(!S.quiz.active)return;
    const unanswered = S.quiz.ans.filter(a=>a===null).length;
    if(unanswered>0 && S.quiz.left>0 && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`))return;
    QUIZ._stopTimer();
    S.quiz.active=false;
    STREAK.markToday();
    S.quiz.qs.forEach((q,qi)=>{
      document.querySelectorAll(`#eqc-${qi} .eo`).forEach((e,oi2)=>{
        e.style.pointerEvents='none';
        const correct = isOk(oi2,q.correct);
        if(correct) e.classList.add('shc');
        else if(oi2===S.quiz.ans[qi]) e.classList.add('bad2');
      });
      const correctPick = isOk(S.quiz.ans[qi], q.correct);
      PROG.track(correctPick);
      REV.trackAnswer(q, correctPick);
    });
    QUIZ._showResults();
  },

  /* ── RETRY ── */
  retryWrong(){
    const wrongIdx = S.quiz.qs.map((q,i)=>({q,i})).filter(({i})=>!isOk(S.quiz.ans[i], S.quiz.qs[i].correct));
    if(!wrongIdx.length){ toast('🎉 Nothing to retry — all correct!'); UI.go('home'); return; }
    QUIZ.startWith(wrongIdx.map(x=>x.q), 'flashcard', S.quiz.ch + ' (Retry)');
  },

  /* ── RESULTS ── */
  _showResults(){
    document.getElementById('fc-wrap').style.display='none';
    document.getElementById('ex-wrap').style.display='none';
    document.getElementById('res-wrap').style.display='';
    const total = S.quiz.qs.length;
    let correct=0;
    S.quiz.qs.forEach((q,i)=>{ if(isOk(S.quiz.ans[i], q.correct)) correct++; });
    const wrong = S.quiz.ans.filter((a,i)=> a!==null && !isOk(a,S.quiz.qs[i].correct)).length;
    const skipped = S.quiz.ans.filter(a=>a===null).length;
    const pct = total ? Math.round((correct/total)*100) : 0;

    document.getElementById('res-ring').style.setProperty('--p', pct+'%');
    document.getElementById('res-pct').textContent = pct+'%';
    document.getElementById('res-chap').textContent = S.quiz.ch;
    const grade = pct>=90?'🏆 Outstanding!':pct>=75?'🎯 Great job!':pct>=50?'👍 Keep practicing':'📚 Needs more review';
    document.getElementById('res-grade').textContent = grade;

    document.getElementById('res-stats').innerHTML = `
      <div class="sc"><div class="sv tcy">${total}</div><div class="sl">Total</div></div>
      <div class="sc"><div class="sv tc2">${correct}</div><div class="sl">Correct</div></div>
      <div class="sc"><div class="sv tb2">${wrong}</div><div class="sl">Wrong</div></div>
      <div class="sc"><div class="sv ta2">${skipped}</div><div class="sl">Skipped</div></div>
    `;

    document.getElementById('res-review').innerHTML = S.quiz.qs.map((q,i)=>{
      const a = S.quiz.ans[i];
      const correctPick = isOk(a,q.correct);
      return `<div class="qcard" style="border-left-color:${correctPick?'var(--ok)':'var(--bad)'}">
        <div class="qm"><span class="qn mono">Q${i+1}</span><span class="ctag ${correctPick?'tg':'tr'}">${correctPick?'Correct':a===null?'Skipped':'Wrong'}</span></div>
        <div class="qt" style="font-size:.82rem">${esc(q.q)}</div>
        ${q.options.map((opt,oi)=>{
          let cls='eo';
          if(isOk(oi,q.correct)) cls+=' shc';
          else if(oi===a) cls+=' bad2';
          return `<div class="${cls}" style="cursor:default;pointer-events:none"><div class="ok">${String.fromCharCode(65+oi)}</div><div>${esc(opt)}</div></div>`;
        }).join('')}
        ${q.explanation?`<div class="expl show">${esc(q.explanation)}</div>`:''}
      </div>`;
    }).join('');
    renderMath(document.getElementById('res-review'));

    if(pct>=70 && window.confetti){ confetti({particleCount:90,spread:75,origin:{y:0.6}}); }
    PROG.recordSession({chapter:S.quiz.ch, mode:S.quiz.mode, total, correct, wrong, skipped, pct, at:Date.now()});
  }
};

/* keyboard support during quizzes */
document.addEventListener('keydown', e=>{
  if(!S.quiz.active) return;
  if(document.getElementById('quiz-wrap').style.display==='none') return;
  if(e.key==='Escape'){ if(S.quiz.active) QUIZ.quit(); }
  if(S.quiz.mode!=='exam'){
    if(e.key==='ArrowRight') QUIZ.fcNav(1);
    if(e.key==='ArrowLeft') QUIZ.fcNav(-1);
    if(['1','2','3','4','5'].includes(e.key)){
      const i=Number(e.key)-1;
      if(S.quiz.qs[S.quiz.idx]?.options[i]!==undefined) QUIZ.fcAnswer(i);
    }
    const letterIdx = 'abcdABCD'.indexOf(e.key);
    if(letterIdx > -1){
      const i = letterIdx % 4;
      if(S.quiz.qs[S.quiz.idx]?.options[i]!==undefined) QUIZ.fcAnswer(i);
    }
  }
});

/* ═══════════════ 10a. PROGRESS TRACKING ═══════════════ */
const PROG = {
  track(correct){
    S.prog.total++;
    if(correct) S.prog.correct++;
    _save(LS.PROG, S.prog);
    HOME.updateStats();
  },
  recordSession(sess){
    S.prog.sessions.unshift(sess);
    S.prog.sessions = S.prog.sessions.slice(0,50);
    _save(LS.PROG, S.prog);
    HOME.render();
  },
  // Weighted average of recent session scores — recent sessions and
  // exam-mode sessions (closer to real exam conditions) count more than
  // old flashcard sessions. Needs at least 3 sessions to say anything
  // useful; confidence grows with sample size and shrinks with volatility.
  predict(){
    const sessions = S.prog.sessions.filter(s=>s.total>0).slice(0,20); // newest first
    if(sessions.length < 3) return null;
    let wSum=0, vSum=0;
    sessions.forEach((s,i)=>{
      const recencyW = 1 - (i/sessions.length)*0.5;   // 1.0 → 0.5 as sessions age
      const modeW = s.mode==='exam' ? 1.5 : 1.0;        // exam-mode counts more
      const w = recencyW * modeW;
      vSum += (s.pct||0) * w;
      wSum += w;
    });
    const predicted = Math.round(vSum/wSum);
    const pcts = sessions.map(s=>s.pct||0);
    const mean = pcts.reduce((a,b)=>a+b,0)/pcts.length;
    const variance = pcts.reduce((a,b)=>a+(b-mean)**2,0)/pcts.length;
    const stdDev = Math.round(Math.sqrt(variance));
    const confidence = sessions.length>=10 && stdDev<15 ? 'High' : sessions.length>=5 ? 'Medium' : 'Low';
    return { predicted, margin: Math.max(3,stdDev), confidence, sampleSize: sessions.length };
  },
  renderPredict(){
    const el = document.getElementById('predict-card');
    if(!el) return;
    const p = PROG.predict();
    if(!p){
      el.innerHTML = `<div class="card"><div class="card-hd"><h3>🎯 Predicted Exam Score</h3></div>
        <div class="empty"><div class="empty-i">🎯</div><p>Complete at least 3 quizzes (exam mode helps most) to unlock a prediction</p></div></div>`;
      return;
    }
    const cls = p.predicted>=70?'ok':p.predicted>=50?'amb':'bad';
    const barColor = p.predicted>=70?'var(--grn)':p.predicted>=50?'var(--amb)':'var(--ros)';
    const confColor = p.confidence==='High'?'tg':p.confidence==='Medium'?'ta':'tr';
    el.innerHTML = `<div class="card">
      <div class="card-hd"><h3>🎯 Predicted Exam Score</h3><span class="ctag ${confColor}">${p.confidence} confidence</span></div>
      <div style="display:flex;align-items:baseline;gap:.5rem;margin:.3rem 0 .5rem">
        <span style="font-size:2rem;font-weight:800;color:var(--t1);font-family:var(--fd)">${p.predicted}%</span>
        <span style="font-size:.76rem;color:var(--t3)">± ${p.margin}% · based on your last ${p.sampleSize} session${p.sampleSize!==1?'s':''}</span>
      </div>
      <div class="pb"><div class="pb-f" style="width:${p.predicted}%;background:${barColor}"></div></div>
      <div style="font-size:.7rem;color:var(--t3);margin-top:.55rem">Recent and exam-mode sessions count more. Not a guarantee — use it to gauge where you stand.</div>
    </div>`;
  },
  render(){
    PROG.renderPredict();
    const total=S.prog.total, correct=S.prog.correct, wrong=total-correct;
    const pct = total ? Math.round((correct/total)*100) : 0;
    document.getElementById('prog-stats').innerHTML = `
      <div class="sc"><div class="sv tcy">${total}</div><div class="sl">Answered</div></div>
      <div class="sc"><div class="sv tc2">${correct}</div><div class="sl">Correct</div></div>
      <div class="sc"><div class="sv tb2">${wrong}</div><div class="sl">Wrong</div></div>
      <div class="sc"><div class="sv ta2">${pct}%</div><div class="sl">Accuracy</div></div>
    `;
    const byChap = {};
    S.prog.sessions.forEach(s=>{
      const k=s.chapter||'Unknown';
      if(!byChap[k]) byChap[k]={correct:0,total:0,sessions:0,lastAt:0};
      byChap[k].correct+=s.correct||0;
      byChap[k].total+=s.total||0;
      byChap[k].sessions++;
      if((s.at||0)>byChap[k].lastAt) byChap[k].lastAt=s.at||0;
    });
    const chapEl = document.getElementById('chap-acc');
    const entries = Object.entries(byChap).sort((a,b)=>b[1].lastAt-a[1].lastAt);
    if(!entries.length){
      chapEl.innerHTML = '<div class="empty"><div class="empty-i">📊</div><p>Complete a quiz to see chapter breakdowns</p></div>';
    } else {
      const weak = entries.filter(([,d])=> d.total>=5 && d.total ? Math.round((d.correct/d.total)*100)<60 : false);
      const weakHtml = weak.length ? `
        <div style="background:var(--bad-bg);border:1px solid var(--bad-bd);border-radius:var(--r2);padding:.75rem 1rem;margin-bottom:.8rem">
          <div style="font-size:.72rem;font-weight:800;color:var(--ros);text-transform:uppercase;letter-spacing:.5px;margin-bottom:.4rem">⚠️ Weak Topics — needs attention</div>
          ${weak.map(([name,d])=>{
            const p=d.total?Math.round((d.correct/d.total)*100):0;
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.2rem 0;font-size:.76rem"><span style="color:var(--t2)">${esc(name)}</span><span class="ctag tr">${p}%</span></div>`;
          }).join('')}
          <div style="margin-top:.5rem;font-size:.7rem;color:var(--t3)">Tip: Use ❌ Wrong Bank to drill these topics</div>
        </div>` : '';
      chapEl.innerHTML = weakHtml + entries.map(([name,d])=>{
        const p = d.total ? Math.round((d.correct/d.total)*100) : 0;
        const cls = p>=70?'ok':p>=50?'amb':'bad';
        const barColor = p>=70?'var(--grn)':p>=50?'var(--amb)':'var(--ros)';
        return `<div class="pb-w">
          <div class="pb-l">
            <span style="font-size:.78rem">${esc(name)}</span>
            <div style="display:flex;align-items:center;gap:.35rem">
              <span style="font-size:.68rem;color:var(--t3)">${d.sessions} session${d.sessions!==1?'s':''} · ${d.correct}/${d.total}</span>
              <span class="ctag t${cls==='ok'?'g':cls==='amb'?'a':'r'}" style="font-size:.65rem">${p}%</span>
            </div>
          </div>
          <div class="pb"><div class="pb-f" style="width:${p}%;background:${barColor}"></div></div>
        </div>`;
      }).join('');
    }
  }
};
/* ═══════════════ 10b. STREAK ═══════════════ */
const STREAK = {
  markToday(){
    const t = today();
    if(!S.stk.days.includes(t)) S.stk.days.push(t);
    S.stk.last = t;
    S.stk.days = S.stk.days.slice(-60);
    _save(LS.STK, S.stk);
    HOME.render();
  },
  currentStreak(){
    let n=0; let d=new Date();
    while(true){
      const ds=d.toISOString().slice(0,10);
      if(S.stk.days.includes(ds)){ n++; d.setDate(d.getDate()-1); }
      else break;
    }
    return n;
  },
  renderBar(){
    const el = document.getElementById('sk-bar');
    if(!el)return;
    const days=[];
    const d=new Date();
    for(let i=6;i>=0;i--){
      const dd=new Date(d); dd.setDate(d.getDate()-i);
      days.push(dd.toISOString().slice(0,10));
    }
    el.innerHTML = days.map(ds=>{
      const done = S.stk.days.includes(ds);
      const isToday = ds===today();
      const label = new Date(ds).toLocaleDateString(undefined,{weekday:'short'})[0];
      return `<div class="sk-d ${done?'done':''} ${isToday?'today':''}">${label}</div>`;
    }).join('');
    document.getElementById('stk-tag').textContent = `🔥 ${STREAK.currentStreak()} day streak`;
  }
};

/* ═══════════════ 10c. HOME / DASHBOARD ═══════════════ */
const HOME = {
  render(){
    const h=new Date().getHours();
    const G=[
      {t:'Burning midnight oil?',i:'🌙',r:[0,5]},
      {t:'Good morning!',i:'🌅',r:[5,12]},
      {t:'Good afternoon!',i:'☀️',r:[12,17]},
      {t:'Good evening!',i:'🌆',r:[17,21]},
      {t:'Working late?',i:'🌙',r:[21,24]}
    ];
    const g=G.find(x=>h>=x.r[0]&&h<x.r[1])||G[1];
    const gt=document.getElementById('greeting-title'); if(gt) gt.textContent=g.t;
    const gi=document.getElementById('greeting-icon'); if(gi) gi.textContent=g.i;
    document.getElementById('greeting').textContent = `${S.user?.name||S.user?.username||'Student'} — Nepal Engineering & PSC exam prep.`;
    HOME.updateStats();
    HOME.updateBadges();
    STREAK.renderBar();
    HOME.renderRecent();
    HOME.tickClock();
  },
  updateStats(){
    const total=S.prog.total, correct=S.prog.correct, wrong=total-correct;
    const pct = total ? Math.round((correct/total)*100) : 0;
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
    set('hs-tot', total); set('hs-cor', correct); set('hs-wrg', wrong); set('hs-pct', pct+'%');
  },
  updateBadges(){
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
    const dueWr = REV.dueCount();
    set('bkc', S.bk.length); set('flc', S.fl.length); set('wrc', S.wr.length);
    const wrDueEl = document.getElementById('wrc-due');
    if(wrDueEl) wrDueEl.textContent = dueWr;
    const total = S.bk.length + S.fl.length + dueWr;
    const bnBadge = document.getElementById('bn-badge');
    if(bnBadge){
      if(total>0){ bnBadge.textContent = total>99?'99+':total; bnBadge.style.display=''; }
      else { bnBadge.style.display='none'; }
    }
  },
  renderRecent(){
    const el = document.getElementById('recent-sessions');
    if(!el)return;
    const sessions = S.prog.sessions.slice(0,6);
    if(!sessions.length){ el.innerHTML='<div class="empty"><div class="empty-i">📈</div><p>No sessions yet — start a quiz!</p></div>'; return; }
    const mIc=m=>m==='exam'?'📝':m==='flashcard'?'⚡':'📊';
    el.innerHTML = sessions.map(s=>{
      const ic=(s.chapter||'').includes('Wrong')?'❌':(s.chapter||'').includes('Daily')?'🌟':(s.chapter||'').includes('Bookmarks')?'⭐':mIc(s.mode);
      const cls=s.pct>=70?'tg':s.pct>=40?'ta':'tr';
      const dt=new Date(s.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return `<div class="sess-row"><span class="sess-ic">${ic}</span><div class="sess-info"><div class="sess-ch">${esc(s.chapter||'Study')}</div><div class="sess-ts">${dt}</div></div><span class="ctag ${cls}">${s.pct}%</span></div>`;
    }).join('');
  },
  _clockTimer:null,
  tickClock(){
    if(HOME._clockTimer) clearInterval(HOME._clockTimer);
    const tick=()=>{
      const now=new Date();
      const cl=document.getElementById('hclock'); if(cl) cl.textContent=now.toLocaleTimeString();
      const dt=document.getElementById('hdate'); if(dt) dt.textContent=now.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
      TT.renderCurrentSessionWidget('h-session');
    };
    tick();
    HOME._clockTimer=setInterval(tick,1000);
  }
};

/* ═══════════════ 10d. TIMETABLE ═══════════════ */
const TT = {
  add(){
    const day=Number(document.getElementById('tt-day').value);
    const name=document.getElementById('tt-name').value.trim();
    const start=document.getElementById('tt-s').value;
    const end=document.getElementById('tt-e').value;
    if(!name||!start||!end){ toast('Fill in all fields'); return; }
    S.tt.sessions.push({id:Date.now()+'', day, name, start, end});
    _save(LS.TT, S.tt);
    document.getElementById('tt-name').value='';
    TT.render();
    toast('✅ Session added');
  },
  remove(id){
    S.tt.sessions = S.tt.sessions.filter(s=>s.id!==id);
    _save(LS.TT, S.tt);
    TT.render();
  },
  _clockTimer:null,
  render(){
    if(TT._clockTimer) clearInterval(TT._clockTimer);
    const tick=()=>{
      const now=new Date();
      const cl=document.getElementById('tt-clock'); if(cl) cl.textContent=now.toLocaleTimeString();
      const dt=document.getElementById('tt-date'); if(dt) dt.textContent=now.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
      TT.renderCurrentSessionWidget('tt-now');
    };
    tick();
    TT._clockTimer=setInterval(tick,1000);

    const todayDay = new Date().getDay();
    const nowHHMM = new Date().toTimeString().slice(0,5);
    const todaySessions = S.tt.sessions.filter(s=>s.day===todayDay).sort((a,b)=>a.start.localeCompare(b.start));
    const todayEl = document.getElementById('tt-today');
    todayEl.innerHTML = todaySessions.length ? todaySessions.map(s=>{
      const isNow = s.start<=nowHHMM && nowHHMM<s.end;
      return `
      <div class="tt-row" style="${isNow?'background:rgba(245,166,35,.08);border-radius:8px;padding-left:.4rem':''}">
        <div class="tt-ti">${s.start}–${s.end}</div>
        <div class="tt-na">${isNow?'🔴 ':''}${esc(s.name)}</div>
        <button class="ib" onclick="TT.remove('${s.id}')">🗑</button>
      </div>
    `;}).join('') : '<div class="empty"><div class="empty-i">📅</div><p>Nothing scheduled today</p></div>';

    const weekEl = document.getElementById('tt-week');
    const todayIdx = new Date().getDay();
    weekEl.innerHTML = `
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <div style="display:grid;grid-template-columns:repeat(7,minmax(78px,1fr));gap:4px;margin-bottom:.5rem;min-width:560px">
        ${DAYS.map((d,i)=>`
          <div style="text-align:center;font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.6px;
            color:${i===todayIdx?'var(--neon)':'var(--t3)'};
            padding:.3rem .2rem;
            border-bottom:2px solid ${i===todayIdx?'var(--neon)':'var(--bd)'}">
            ${d.slice(0,3)}
          </div>
        `).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,minmax(78px,1fr));gap:4px;align-items:start;min-width:560px">
        ${DAYS.map((d,di)=>{
          const sess = S.tt.sessions.filter(s=>s.day===di).sort((a,b)=>a.start.localeCompare(b.start));
          const isToday = di===todayIdx;
          return `<div style="min-height:60px;background:${isToday?'rgba(0,229,255,.04)':'var(--bg1)'};border-radius:var(--r1);border:1px solid ${isToday?'rgba(0,229,255,.18)':'var(--bd)'};padding:.3rem .25rem">
            ${sess.length ? sess.map(s=>`
              <div style="background:${isToday?'rgba(0,229,255,.1)':'var(--surf2)'};border:1px solid ${isToday?'rgba(0,229,255,.25)':'var(--bd)'};border-radius:6px;padding:.28rem .35rem;margin-bottom:3px;cursor:default"
                title="${esc(s.name)} ${s.start}–${s.end}">
                <div style="font-size:.6rem;font-weight:700;color:${isToday?'var(--neon)':'var(--t3)'}">${s.start}</div>
                <div style="font-size:.65rem;font-weight:600;color:var(--t1);overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(s.name)}</div>
                <button onclick="TT.remove('${s.id}')" style="background:none;border:none;color:var(--t3);font-size:.65rem;cursor:pointer;padding:0;float:right">✕</button>
              </div>
            `).join('') : `<div style="text-align:center;color:var(--t3);font-size:.6rem;margin-top:.5rem">—</div>`}
          </div>`;
        }).join('')}
      </div>
      </div>
    `;
  },
  renderCurrentSessionWidget(elId){
    const el=document.getElementById(elId);
    if(!el)return;
    const now=new Date();
    const hhmm = now.toTimeString().slice(0,5);
    const todayDay = now.getDay();
    const active = S.tt.sessions.find(s=>s.day===todayDay && s.start<=hhmm && hhmm<s.end);
    const next = S.tt.sessions.filter(s=>s.day===todayDay && s.start>hhmm).sort((a,b)=>a.start.localeCompare(b.start))[0];
    if(active){
      el.innerHTML = `<div class="tt-now"><div class="tt-nl">Now</div><div class="tt-nn">${esc(active.name)}</div><div class="tt-nt">until ${active.end}</div></div>`;
    } else if(next){
      el.innerHTML = `<div class="tt-now"><div class="tt-nl">Next</div><div class="tt-nn">${esc(next.name)}</div><div class="tt-nt">starts ${next.start}</div></div>`;
    } else {
      el.innerHTML = `<div style="font-size:.74rem;color:var(--t3);text-align:center;padding:.4rem 0">No more sessions today</div>`;
    }
  },
  exportJ(){
    const blob=new Blob([JSON.stringify(S.tt,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='timetable.json';a.click();
  },
  importJ(){
    const inp=document.createElement('input');inp.type='file';inp.accept='.json';
    inp.onchange=()=>{
      const f=inp.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=e=>{
        try{
          const data=JSON.parse(e.target.result);
          if(data && Array.isArray(data.sessions)){ S.tt=data; _save(LS.TT,S.tt); TT.render(); toast('✅ Timetable imported'); }
          else toast('❌ Invalid timetable file');
        }catch{toast('❌ Invalid JSON')}
      };
      r.readAsText(f);
    };
    inp.click();
  }
};

/* ═══════════════ 10e. OFFLINE CACHE ═══════════════ */
const CACHE = {
  render(){
    const refs = ChapterData.allFileRefs();
    function _isCached(key){
      const v = _load(LS.QC+key, null);
      if(!v) return false;
      if(typeof v === 'object' && !Array.isArray(v) && v.success === false) return false;
      return true;
    }
    let cachedCount=0;
    refs.forEach(r=>{ if(_isCached(r.key)) cachedCount++; });
    const tag=document.getElementById('cache-tag');
    tag.textContent = cachedCount===refs.length && refs.length ? 'Fully cached' : cachedCount>0 ? 'Partially cached' : 'Not cached';
    tag.className = 'ctag ' + (cachedCount===refs.length && refs.length ? 'tg' : cachedCount>0 ? 'ta' : 'tr');
    document.getElementById('cache-txt').textContent = `${cachedCount} of ${refs.length} question sets cached on this device for offline use.`;

    const grid=document.getElementById('cache-grid');
    const levels = ChapterData.levels();
    grid.innerHTML = levels.map(lv=>{
      const lvRefs = refs.filter(r=>r.lv===lv);
      const lvCached = lvRefs.filter(r=>_isCached(r.key)).length;
      return `<div class="ci"><div class="ci-n">${esc(ChapterData.levelLabel(lv))}</div>
        <div class="ci-s"><div class="cd ${lvCached===lvRefs.length&&lvRefs.length?'y':'n'}"></div>${lvCached}/${lvRefs.length} cached</div></div>`;
    }).join('');
  },
  async dl(){
    const refs = ChapterData.allFileRefs();
    if(!refs.length){ toast('No content configured to cache'); return; }
    if(!S.online){ toast('❌ You need to be online to download the cache'); return; }
    const pb=document.getElementById('cpb'), pf=document.getElementById('cpf'), txt=document.getElementById('cptxt');
    pb.style.display='';
    let done=0, failed=0;
    for(const ref of refs){
      txt.textContent = `Caching: ${ref.name} (${done+1}/${refs.length})…`;
      pf.style.width = `${(done/refs.length)*100}%`;
      try{
        await QUIZ._fetch(ref.fid, ref.key);
      }catch(err){
        failed++;
        txt.textContent = `⚠️ Failed: ${ref.name} — retrying…`;
        try{ await new Promise(r=>setTimeout(r,2000)); await QUIZ._fetch(ref.fid, ref.key); failed--; }catch{}
      }
      done++;
      pf.style.width = `${(done/refs.length)*100}%`;
    }
    const ok = done - failed;
    txt.textContent = failed>0 ? `⚠️ Cached ${ok}/${refs.length} sets (${failed} failed — check connection)` : `✅ All ${done} sets cached successfully`;
    toast(failed>0 ? `⚠️ ${ok}/${refs.length} cached — ${failed} failed` : '✅ Offline cache complete');
    CACHE.render();
  },
  clr(){
    if(!confirm('Clear all cached question data? You will need internet to reload it.'))return;
    Object.keys(localStorage).filter(k=>k.startsWith(LS.QC)).forEach(k=>localStorage.removeItem(k));
    toast('🗑 Cache cleared');
    CACHE.render();
  },
  purgeStale(){
    let purged = 0;
    Object.keys(localStorage).filter(k=>k.startsWith(LS.QC)).forEach(k=>{
      try{
        const v = JSON.parse(localStorage.getItem(k));
        if(v && typeof v === 'object' && !Array.isArray(v) && v.success === false){
          localStorage.removeItem(k);
          purged++;
        }
      }catch{}
    });
    if(purged > 0){ toast(`🧹 Removed ${purged} stale error cache entry${purged>1?'s':''}`); CACHE.render(); }
    else toast('✅ No stale cache entries found');
  },

  // Runs quietly in the background right after login (see APP.init()).
  // Only fetches sets that aren't already cached (or whose cache entry
  // was a stored error), so this also picks up newly-added content
  // (new chapters/files in chapters-data.js) without a full re-download
  // every time, and without ever blocking the UI.
  async autoSync(){
    if(!S.online || S.forcedOffline) return;
    function isCached(key){
      const v = _load(LS.QC+key, null);
      return v && !(typeof v==='object' && !Array.isArray(v) && v.success===false);
    }
    const missing = ChapterData.allFileRefs().filter(r=>!isCached(r.key));
    if(!missing.length) return;
    CACHE._badge(`📦 Syncing 0/${missing.length}…`);
    let done=0;
    for(const ref of missing){
      try{ await QUIZ._fetch(ref.fid, ref.key); }catch{ /* skip failures quietly, retried next login */ }
      done++;
      CACHE._badge(`📦 Syncing ${done}/${missing.length}…`);
    }
    CACHE._badge(null);
    if(UI.cur==='offline') CACHE.render();
  },
  _badge(msg){
    let el = document.getElementById('cache-autobadge');
    if(msg===null){ if(el) el.style.display='none'; return; }
    if(!el){
      el = document.createElement('div');
      el.id = 'cache-autobadge';
      el.style.cssText = 'position:fixed;bottom:calc(var(--bn-h,0px) + 1rem + var(--safe-b,0px));right:1rem;background:var(--c2);border:1px solid var(--bd);border-radius:999px;padding:.4rem .8rem;font-size:.7rem;color:var(--t2);z-index:9998;box-shadow:var(--sh3);display:flex;align-items:center;gap:.4rem';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'flex';
  }
};

/* ═══════════════ 10f. DATA MANAGEMENT ═══════════════ */
const DATA = {
  exp(){
    const payload = { prog:S.prog, bk:S.bk, fl:S.fl, wr:S.wr, tt:S.tt, stk:S.stk, exportedAt:new Date().toISOString() };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='hamro-afnai-backup.json';a.click();
    toast('📤 Exported');
  },
  imp(){
    const inp=document.createElement('input');inp.type='file';inp.accept='.json';
    inp.onchange=()=>{
      const f=inp.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=e=>{
        try{
          const data=JSON.parse(e.target.result);
          if(data.prog){ S.prog=data.prog; _save(LS.PROG,S.prog); }
          if(data.bk){ S.bk=data.bk; _save(LS.BK,S.bk); }
          if(data.fl){ S.fl=data.fl; _save(LS.FL,S.fl); }
          if(data.wr){ S.wr=data.wr; _save(LS.WR,S.wr); }
          if(data.tt){ S.tt=data.tt; _save(LS.TT,S.tt); }
          if(data.stk){ S.stk=data.stk; _save(LS.STK,S.stk); }
          toast('✅ Data imported');
          HOME.render(); PROG.render();
        }catch{ toast('❌ Invalid backup file'); }
      };
      r.readAsText(f);
    };
    inp.click();
  },
  clearQ(){
    if(!confirm('Clear cached question downloads? Your progress/bookmarks stay intact.'))return;
    Object.keys(localStorage).filter(k=>k.startsWith(LS.QC)).forEach(k=>localStorage.removeItem(k));
    toast('🧹 Question cache cleared');
  },
  reset(){
    if(!confirm('⚠️ This deletes ALL progress, bookmarks, flags, wrong answers, and timetable on this device. Continue?'))return;
    if(!confirm('Are you absolutely sure? This cannot be undone.'))return;
    [LS.PROG,LS.BK,LS.FL,LS.WR,LS.TT,LS.STK].forEach(k=>localStorage.removeItem(k));
    toast('⚠️ All data reset');
    location.reload();
  }
};

/* ═══════════════ 11. APP BOOT ═══════════════ */
/* ═══════════════ TUTORIAL — first-login walkthrough ═══════════════
   Auto-opens once per account the first time that username reaches
   user.html (right after AUTH._enter — i.e. regardless of whether they
   got in as trial, permanent, or yearly). Re-openable anytime from the
   sidebar (Tools → Tutorial) or the Dashboard Quick Actions tile. */
const TUTORIAL = {
  _seenKey: 'ha_tut_seen',
  _steps: [
    {
      icon: '👋',
      title: 'Welcome to HAMRO AFNAI',
      body: `<p>This is your Smart Study Hub for Nepal Engineering (Level 5/7) and PSC/Loksewa prep. Once a chapter is cached it works fully offline — handy for load-shedding or weak signal.</p>`
    },
    {
      icon: '🔑',
      title: 'Your account status',
      body: `
        <p>Check the sidebar under your name for your current status:</p>
        <ul style="margin:0 0 0 1.1rem;padding:0">
          <li><b>⏳ Trial</b> — free access, counts down live. Pay anytime from the payment screen to go permanent.</li>
          <li><b>✅ Permanent</b> — verified, unlimited access forever, fully usable offline.</li>
          <li><b>📅 Yearly</b> — active until the renewal date shown in the sidebar.</li>
        </ul>
        <p style="margin-top:.5rem">Once you're Trial, Permanent, or active Yearly, you land straight here next time — no re-login needed on this device, even offline.</p>`
    },
    {
      icon: '🏠',
      title: 'Your Dashboard',
      body: `
        <p>The Dashboard (🏠) is home base:</p>
        <ul style="margin:0 0 0 1.1rem;padding:0">
          <li><b>🌟 Daily Challenge</b> — 30 mixed questions, keeps your streak alive.</li>
          <li><b>⚡ Adaptive Practice</b> — pulls the questions you're actually struggling with first.</li>
          <li>Quick stats and Quick Action tiles for everything else in the app.</li>
        </ul>`
    },
    {
      icon: '📚',
      title: 'Studying a chapter',
      body: `
        <p>Open <b>Online Study</b> or <b>Local File</b> from the sidebar, pick a chapter, choose how many questions and whether to shuffle, then pick a mode:</p>
        <ul style="margin:0 0 0 1.1rem;padding:0">
          <li><b>Practice</b> — instant feedback, no time pressure.</li>
          <li><b>📝 Exam</b> — timed, graded at the end.</li>
          <li><b>⚡ Flashcard</b> — quick flip-through review.</li>
        </ul>
        <p style="margin-top:.5rem">Shortcuts while answering: <b>A/B/C/D</b> or <b>1–5</b> to pick an option, <b>←/→</b> between cards, <b>Esc</b> to quit.</p>`
    },
    {
      icon: '⭐',
      title: 'Bookmarks, Flags & Wrong Bank',
      body: `
        <p>Tag any question while studying:</p>
        <ul style="margin:0 0 0 1.1rem;padding:0">
          <li><b>⭐ Bookmarks</b> — save with a label (Need Check, Interesting, Debating, Confusing, Formulae).</li>
          <li><b>🚩 Flagged</b> — a quick "come back to this" marker.</li>
          <li><b>❌ Wrong Bank</b> — anything you get wrong lands here automatically, and needs two correct answers in a row, spaced a few days apart, before it's considered mastered.</li>
        </ul>`
    },
    {
      icon: '📅',
      title: 'Timetable & Progress',
      body: `<p><b>Timetable</b> lets you block out study sessions by day/time — the Dashboard clock shows what's happening right now. <b>Progress</b> tracks your accuracy over time and predicts your likely exam marks from recent sessions.</p>`
    },
    {
      icon: '📦',
      title: 'Offline & installing the app',
      body: `
        <p>Chapters you open get cached automatically for offline use — check <b>Offline Cache</b> in the sidebar to manage what's stored on this device.</p>
        <p style="margin-top:.5rem">Tap the <b>📲</b> icon in the top bar to install HAMRO AFNAI to your home screen — it then opens like a normal app, even with no signal. You can reopen this tutorial anytime from the sidebar or the Dashboard's Quick Actions.</p>`
    }
  ],
  _idx: 0,

  // Called from AUTH._enter() on every successful entry into user.html.
  // Only actually opens the first time a given username reaches this
  // screen — status changing from trial→paid→permanent doesn't re-open it,
  // since it's the same account and they've already seen it.
  maybeAutoOpen(user) {
    if (!user || !user.username) return;
    const seen = _load(TUTORIAL._seenKey, {});
    if (seen[user.username]) return;
    setTimeout(() => TUTORIAL.open(), 600);
  },

  open() {
    if (document.getElementById('tut-modal')) return;
    TUTORIAL._idx = 0;
    const modal = document.createElement('div');
    modal.id = 'tut-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;z-index:10001;padding:1.2rem;backdrop-filter:blur(4px)';
    modal.innerHTML = `
      <div style="background:var(--c2);border:1px solid var(--bd);border-radius:var(--r3);padding:1.4rem;max-width:420px;width:100%;box-shadow:var(--sh3);max-height:88vh;display:flex;flex-direction:column">
        <div id="tut-dots" style="display:flex;gap:.3rem;margin-bottom:.9rem;justify-content:center"></div>
        <div style="flex:1;overflow-y:auto;min-height:0" id="tut-body"></div>
        <div style="display:flex;gap:.4rem;margin-top:1rem">
          <button id="tut-back" style="padding:.6rem .9rem;background:var(--b0);border:1px solid var(--b1);border-radius:var(--r2);color:var(--t2);font-size:.82rem;cursor:pointer;font-family:var(--ff)">← Back</button>
          <button id="tut-next" style="flex:1;padding:.62rem;background:linear-gradient(135deg,var(--amb2),var(--amb));border:none;border-radius:var(--r2);color:#0F0A00;font-weight:700;font-size:.85rem;cursor:pointer;font-family:var(--ff)">Next →</button>
        </div>
        <button id="tut-skip" style="margin-top:.55rem;background:none;border:none;color:var(--t3);font-size:.72rem;cursor:pointer;font-family:var(--ff);text-decoration:underline">Skip tutorial</button>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('tut-back').onclick = () => TUTORIAL._go(-1);
    document.getElementById('tut-next').onclick = () => TUTORIAL._go(1);
    document.getElementById('tut-skip').onclick = () => TUTORIAL._finish();
    TUTORIAL._render();
  },

  _go(dir) {
    const n = TUTORIAL._idx + dir;
    if (n < 0) return;
    if (n >= TUTORIAL._steps.length) { TUTORIAL._finish(); return; }
    TUTORIAL._idx = n;
    TUTORIAL._render();
  },

  _render() {
    const step = TUTORIAL._steps[TUTORIAL._idx];
    const body = document.getElementById('tut-body');
    if (!body) return;
    body.innerHTML = `
      <div style="font-size:1.6rem;margin-bottom:.3rem">${step.icon}</div>
      <div style="font-family:var(--fd);font-size:1rem;font-weight:700;color:var(--t1);margin-bottom:.5rem">${step.title}</div>
      <div style="font-size:.82rem;color:var(--t2);line-height:1.55">${step.body}</div>`;
    const dots = document.getElementById('tut-dots');
    if (dots) {
      dots.innerHTML = TUTORIAL._steps.map((_, i) =>
        `<div style="width:${i === TUTORIAL._idx ? '18px' : '6px'};height:6px;border-radius:3px;background:${i === TUTORIAL._idx ? 'var(--amb)' : 'var(--b1)'};transition:.2s"></div>`
      ).join('');
    }
    const backBtn = document.getElementById('tut-back');
    if (backBtn) backBtn.style.visibility = TUTORIAL._idx === 0 ? 'hidden' : 'visible';
    const nextBtn = document.getElementById('tut-next');
    if (nextBtn) nextBtn.textContent = TUTORIAL._idx === TUTORIAL._steps.length - 1 ? "Got it — let's study! →" : 'Next →';
  },

  _finish() {
    const modal = document.getElementById('tut-modal');
    if (modal) modal.remove();
    if (S.user && S.user.username) {
      const seen = _load(TUTORIAL._seenKey, {});
      seen[S.user.username] = true;
      _save(TUTORIAL._seenKey, seen);
    }
  }
};

const APP = {
  init(){
    if(_load('ha_theme','dark')==='light') document.body.classList.add('light');
    Object.keys(localStorage).filter(k=>k.startsWith(LS.QC)).forEach(k=>{
      try{
        const v=JSON.parse(localStorage.getItem(k));
        if(v && typeof v==='object' && !Array.isArray(v) && v.success===false) localStorage.removeItem(k);
      }catch{}
    });
    UI.go('home');
    CACHE.render();
    _updateNetBtn();
    _updateOfflineWarn();
    AUTH.startPeriodicRecheck();
    CACHE.autoSync();
  }
};

/* ── network status wiring ── */
function _updateOfflineWarn(){
  const el = document.getElementById('on-offline-warn');
  if(el) el.style.display = (S.online && !S.forcedOffline) ? 'none' : 'flex';
}
function _updateNetBtn(){
  const btn = document.getElementById('net-mode-btn');
  if(!btn) return;
  const effectivelyOnline = S.online && !S.forcedOffline;
  btn.textContent = effectivelyOnline ? '🟢' : '🔴';
  btn.title = effectivelyOnline
    ? 'Online mode — click to force offline'
    : S.forcedOffline
      ? 'Forced offline mode — click to go online'
      : 'Network offline — no connection';
  btn.style.color = effectivelyOnline ? 'var(--grn)' : 'var(--ros)';
  btn.style.borderColor = effectivelyOnline ? 'rgba(34,197,94,.35)' : 'var(--bad-bd)';
  btn.style.background = effectivelyOnline ? 'rgba(34,197,94,.08)' : 'var(--bad-bg)';
  btn.classList.toggle('forced', S.forcedOffline);
  const offbar = document.getElementById('offbar');
  if(offbar){
    if(!S.online){
      offbar.textContent = '📡 Network offline — serving from local cache';
      offbar.classList.add('show');
    } else if(S.forcedOffline){
      offbar.textContent = '🔴 Offline mode forced — network blocked by you';
      offbar.classList.add('show');
    } else {
      offbar.classList.remove('show');
    }
  }
}

/* ═══════════════ NET — manual online/offline toggle ═══════════════ */
const NET = {
  toggle(){
    if(!S.online && !S.forcedOffline){
      toast('📡 No network connection — connect to the internet first');
      return;
    }
    S.forcedOffline = !S.forcedOffline;
    _save(LS.FORCED_OFFLINE, S.forcedOffline);
    if(S.forcedOffline){
      toast('🔴 Offline mode on — all network requests blocked');
    } else {
      toast('🟢 Online mode restored — network requests allowed');
    }
    _updateNetBtn();
    _updateOfflineWarn();
  }
};
window.addEventListener('online', ()=>{
  S.online=true;
  _updateNetBtn();
  _updateOfflineWarn();
  if(!S.forcedOffline) toast('🌐 Back online');
  else toast('🌐 Network restored — still in forced offline mode');
});
window.addEventListener('offline', ()=>{
  const wasForcedOff = S.forcedOffline;
  S.online=false;
  if(!wasForcedOff){
    toast('📡 Network lost — switched to offline mode automatically');
  }
  _updateNetBtn();
  _updateOfflineWarn();
});

/* ── boot sequence ── */
document.addEventListener('DOMContentLoaded', ()=>{
  if(_load('ha_theme','dark')==='light') document.body.classList.add('light');
  PWA.init();
  AUTH.restore();
});

/* ═══════════════ EXPLICIT GLOBAL EXPOSURE ═══════════════ */
window.AUTH = AUTH;
window.NET = NET;
window.UI = UI;
window.ON = ON;
window.LOC = LOC;
window.PSY = PSY;
window.REV = REV;
window.QUIZ = QUIZ;
window.PWA = PWA;
window.PROG = PROG;
window.HOME = HOME;
window.STREAK = STREAK;
window.TT = TT;
window.CACHE = CACHE;
window.DATA = DATA;
window.TUTORIAL = TUTORIAL;
window.APP = APP;

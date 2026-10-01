'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch (e) {}

const PORT = +process.env.PORT || 3000;
let DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); }
catch (e) { console.log('WARNING: DATA_DIR ' + DATA + ' not writable (' + e.code + '). Using local ./data - data may be lost on redeploy. Attach a disk!'); DATA = path.join(__dirname, 'data'); fs.mkdirSync(DATA, { recursive: true }); }
const db = new DatabaseSync(path.join(DATA, 'gxplay.db'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, pw TEXT, bal REAL DEFAULT 0, code TEXT UNIQUE, ref_by TEXT, refs INTEGER DEFAULT 0, created INTEGER, last_login INTEGER, ip TEXT, blocked INTEGER DEFAULT 0, bets INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, verif TEXT DEFAULT '{}', note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, coin TEXT, network TEXT, tx_hash TEXT, status TEXT DEFAULT 'pending', created INTEGER, decided INTEGER, admin_note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, coin TEXT, network TEXT, address TEXT, status TEXT DEFAULT 'pending', created INTEGER, decided INTEGER, tx_hash TEXT DEFAULT '', admin_note TEXT DEFAULT '', disp_amount REAL, disp_cur TEXT);
CREATE TABLE IF NOT EXISTS addrs(id INTEGER PRIMARY KEY, user_id INTEGER, coin TEXT, network TEXT, address TEXT, UNIQUE(user_id,coin,network));
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, username TEXT UNIQUE, pw TEXT);
CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY, user_id INTEGER, game TEXT, bet REAL, state TEXT, status TEXT DEFAULT 'open', created INTEGER);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, detail TEXT);`);
for (const c of ['disp_amount REAL', 'disp_cur TEXT']) { try { db.exec('ALTER TABLE deposits ADD COLUMN ' + c); } catch (e) {} }
const q = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const getSet = k => (one('SELECT v FROM settings WHERE k=?', k) || {}).v;
const setSet = (k, v) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);
const log = (actor, action, detail = '') => run('INSERT INTO logs(ts,actor,action,detail) VALUES(?,?,?,?)', Date.now(), actor, action, String(detail).slice(0, 500));
let SECRET = process.env.SECRET || getSet('secret'); if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSet('secret', SECRET); }

// ---------- helpers ----------
const hash = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verify = (pw, h) => { try { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); } catch (e) { return false; } };
const sign = (p, ttl) => { const b = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + ttl })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const unsign = t => { try { const [b, s] = String(t).split('.'); const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; } catch (e) { return null; } };
const r2 = n => Math.round(n * 100) / 100;
const MIN_DEPOSIT = +process.env.MIN_DEPOSIT || 1, MIN_WITHDRAW = +process.env.MIN_WITHDRAW || 100;
const atomic = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } };
const hits = new Map();
const limited = (key, max, win) => { const n = Date.now(), a = (hits.get(key) || []).filter(t => n - t < win); a.push(n); hits.set(key, a); return a.length > max; };
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const genCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let s = ''; for (let i = 0; i < 8; i++) s += c[crypto.randomInt(c.length)]; if (!one('SELECT 1 x FROM users WHERE code=?', s)) return s; } };
async function notify(text) { const t = process.env.TELEGRAM_BOT_TOKEN || getSet('tg_token'), c = process.env.TELEGRAM_CHAT_ID || getSet('tg_chat'); if (!t || !c) return; try { await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c, text }) }); } catch (e) {} }
const pubUser = u => ({ id: u.id, name: u.name, email: u.email, bal: r2(u.bal), code: u.code, refs: u.refs, refBy: u.ref_by || null, created: u.created, stats: { bets: u.bets, wins: u.wins }, verif: JSON.parse(u.verif || '{}') });

// first admin
if (!one('SELECT 1 x FROM admins')) {
  const u = process.env.ADMIN_USER || 'admin', p = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  run('INSERT INTO admins(username,pw) VALUES(?,?)', u, hash(p));
  console.log(`\n=== ADMIN LOGIN CREATED ===\n user: ${u}\n pass: ${p}\n (login ke baad Settings me badal lein)\n===========================\n`);
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.woff2': 'font/woff2' };
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const readBody = req => new Promise((ok, no) => { let b = '', n = 0; req.on('data', d => { n += d.length; if (n > 1e6) { no(new HttpErr(413, 'Too large')); req.destroy(); } else b += d; }); req.on('end', () => { if (!b) return ok({}); try { ok(JSON.parse(b)); } catch (e) { no(new HttpErr(400, 'Bad JSON')); } }); });
const send = (res, s, o, h = {}) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(s, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h }); res.end(b); };
const str = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(c => c[0] === n)?.[1];
const ipOf = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();


// ---------- server-side games (outcomes are decided HERE, never in the browser) ----------
const rf = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32, ri = n => crypto.randomInt(n);
const MAX_BET = +process.env.MAX_BET || 100000;
const comb = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
const KT0 = { 1: [0, 3.8], 2: [0, 1.7, 5.2], 3: [0, 0, 2.5, 26], 4: [0, 0, 1.8, 6, 90], 5: [0, 0, 1.5, 4, 14, 300], 6: [0, 0, 1, 3, 9, 80, 700], 7: [0, 0, .5, 2.5, 6, 35, 300, 1000], 8: [0, 0, 0, 2, 4, 15, 120, 600, 1000], 9: [0, 0, 0, 1.5, 3, 10, 50, 300, 1000, 1000], 10: [0, 0, 0, 1.5, 2.5, 5, 30, 150, 600, 1000, 1000] };
const KT = {}; for (const n in KT0) { const t = KT0[n]; let rtp = 0; t.forEach((m, k) => rtp += comb(10, k) * comb(30, n - k) / comb(40, n) * m); KT[n] = t.map(m => Math.round(m * 0.98 / rtp * 100) / 100); }
const plMults = (rows, risk) => { const [a, b] = [[.5, 8], [.3, 30], [.1, 200]][risk], h = rows / 2, raw = [], pr = []; for (let i = 0; i <= rows; i++) { raw.push(a + b * Math.pow(Math.abs(i - h) / h, 3)); pr.push(comb(rows, i) / Math.pow(2, rows)); } const rtp = raw.reduce((t, v, i) => t + v * pr[i], 0); return raw.map(v => Math.round(v * 0.99 / rtp * 100) / 100); };
const W0 = [[1.5, 1.2, 1.5, 0, 1.5, 1.2, 1.2, 0, 1.5, 0], [0, 1.5, 0, 3, 0, 1.5, 0, 3, 0, 1.5], [0, 0, 0, 0, 0, 0, 0, 0, 0, 9.9]];
const whMults = r => { const a = W0[r], mean = a.reduce((x, y) => x + y, 0) / a.length; return a.map(v => Math.round(v * 0.99 / mean * 100) / 100); };
const minesMult = (n, p) => { let m = 1; for (let i = 0; i < p; i++) m *= (25 - i) / (25 - n - i); return m * 0.99; };
const crashAt = ms => Math.pow(1.012, Math.floor(ms / 50));

// slots: 3 reels x 3 rows, 5 paylines, bet split over the lines (RTP ~94.7%)
const SLOT_W = [30, 26, 20, 14, 8, 4], SLOT_P3 = [9, 14, 22, 45, 110, 450], SLOT_P2C = 2, SLOT_SUM = 102;
const SLOT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 4, 8], [6, 4, 2]];
const slotPick = () => { let r = ri(SLOT_SUM); for (let i = 0; i < 6; i++) { if ((r -= SLOT_W[i]) < 0) return i; } return 5; };
// Lucky Tiger: 3x3, 5 lines, tiger = wild, tiger respin (locked tigers, rising multiplier). RTP ~93-95%
const TG_W = [30, 26, 20, 14, 9, 4], TG_SUM = 103, TG_P3 = [1.65, 2.3, 3.6, 5.6, 13.5], TG_PW = 8, TG_FULL = 40, TG_MULT = [1, 2, 3, 5];
const tgPick = () => { let r = ri(TG_SUM); for (let i = 0; i < 6; i++) { if ((r -= TG_W[i]) < 0) return i; } return 5; };
function tgLines(g) { let m = 0; const cells = new Set(); for (const L of SLOT_LINES) { const c = L.map(i => g[i]), non = c.find(x => x !== 5); let x = 0; if (non === undefined) x = TG_PW; else if (c.every(v => v === non || v === 5)) x = TG_P3[non]; if (x) { m += x; L.forEach(i => cells.add(i)); } } return { m: m / 5, cells: [...cells] }; }
const balOf = id => one('SELECT bal FROM users WHERE id=?', id).bal;
const charge = (u, b) => run('UPDATE users SET bal=ROUND(bal-?,2) WHERE id=?', b, u.id);
const payout = (u, pay, win) => run('UPDATE users SET bal=ROUND(bal+?,2), bets=bets+1, wins=wins+? WHERE id=?', pay, win ? 1 : 0, u.id);
const betOf = (u, body, times = 1) => { const b = r2(+body.bet); if (!(b >= 1)) throw new HttpErr(400, 'Minimum bet is ₹1'); if (b > MAX_BET) throw new HttpErr(400, 'Maximum bet is ₹' + MAX_BET); if (b * times > balOf(u.id) + 1e-9) throw new HttpErr(400, 'Insufficient balance'); return b; };
const openRound = (u, game) => one("SELECT * FROM rounds WHERE user_id=? AND game=? AND status='open' ORDER BY id DESC", u.id, game);
const closeRound = id => run("UPDATE rounds SET status='closed' WHERE id=?", id);
const newRound = (u, game, bet, st) => run('INSERT INTO rounds(user_id,game,bet,state,created) VALUES(?,?,?,?,?)', u.id, game, bet, JSON.stringify(st), Date.now());

// settle a round the player abandoned (closed tab) so no stake is stuck
function settleStale(u, game) {
  const r = openRound(u, game); if (!r) return; const st = JSON.parse(r.state); closeRound(r.id);
  if (game === 'crash') { const m = Math.floor(crashAt(Date.now() - st.t0) * 100) / 100; if (m < st.crash) payout(u, r2(r.bet * m), true); else payout(u, 0, false); }
  else if (game === 'mines') { if (st.picked.length) payout(u, r2(r.bet * minesMult(st.n, st.picked.length)), true); else run('UPDATE users SET bal=ROUND(bal+?,2) WHERE id=?', r.bet, u.id); }
  else if (game === 'hilo') { if (st.n > 0) payout(u, r2(r.bet * st.m), true); else run('UPDATE users SET bal=ROUND(bal+?,2) WHERE id=?', r.bet, u.id); }
}

function gameApi(u, p, body) {
  if (limited('gm' + u.id, 240, 60e3)) throw new HttpErr(429, 'Slow down a little.');
  const g = p.split('/')[1], act = p.split('/')[2], out = extra => ({ ...extra, bal: r2(balOf(u.id)) });
  if (g === 'play') {
    if (act === 'slots') {
      const b = betOf(u, body), grid = Array.from({ length: 9 }, slotPick), wins = []; let m = 0;
      SLOT_LINES.forEach((L, li) => { const a = grid[L[0]], c = grid[L[1]], d = grid[L[2]]; let x = 0; if (a === c && c === d) x = SLOT_P3[a]; else if (a === 0 && c === 0) x = SLOT_P2C; if (x) { m += x; wins.push({ line: li, cells: x === SLOT_P2C && !(a === c && c === d) ? [L[0], L[1]] : L, x }); } });
      const mult = m / 5, pay = r2(b * mult); charge(u, b); payout(u, pay, pay > 0); return out({ grid, wins, mult, win: pay > 0, payout: pay });
    }
    if (act === 'tiger') {
      const b = betOf(u, body); let g = Array.from({ length: 9 }, tgPick), st = 0, total = 0; const stages = [];
      let r = tgLines(g); total += r.m * TG_MULT[0]; stages.push({ grid: g.slice(), mult: TG_MULT[0], pay: r.m * TG_MULT[0], cells: r.cells, locked: [] });
      while (st < 3) {
        const before = g.filter(x => x === 5).length; if (!before) break;
        const locked = g.map((x, i) => x === 5 ? i : -1).filter(i => i >= 0);
        g = g.map(x => x === 5 ? x : tgPick()); st++; r = tgLines(g);
        const after = g.filter(x => x === 5).length; let add = r.m * TG_MULT[st]; if (after === 9) add += TG_FULL / 5;
        total += add; stages.push({ grid: g.slice(), mult: TG_MULT[st], pay: add, cells: r.cells, locked, full: after === 9 });
        if (after === 9 || after === before) break;
      }
      const pay = r2(b * total); charge(u, b); payout(u, pay, pay > 0);
      return out({ stages, mult: total, win: pay > 0, payout: pay });
    }
    if (act === 'dice') {
      const b = betOf(u, body), over = !!body.over, t = Math.max(2, Math.min(98, +body.t || 50)), c = over ? 100 - t : t, mult = 99 / c;
      const roll = Math.floor(rf() * 10000) / 100, win = over ? roll > t : roll < t, pay = win ? r2(b * mult) : 0;
      charge(u, b); payout(u, pay, win); return out({ roll, win, mult, payout: pay });
    }
    if (act === 'limbo') {
      const b = betOf(u, body), t = Math.min(1e6, +body.target); if (!(t >= 1.01)) throw new HttpErr(400, 'Target must be at least 1.01×');
      const result = Math.min(1e6, Math.max(1, Math.floor(99 / (rf() * 100 + 1e-9) * 100) / 100)), win = result >= t, pay = win ? r2(b * t) : 0;
      charge(u, b); payout(u, pay, win); return out({ result, win, payout: pay });
    }
    if (act === 'coin') {
      const b = betOf(u, body), heads = rf() < .5, win = (body.pick === 'h') === heads, pay = win ? r2(b * 1.98) : 0;
      charge(u, b); payout(u, pay, win); return out({ heads, win, payout: pay });
    }
    if (act === 'keno') {
      const sel = [...new Set((Array.isArray(body.sel) ? body.sel : []).map(Number))].filter(x => Number.isInteger(x) && x >= 1 && x <= 40);
      if (!sel.length || sel.length > 10) throw new HttpErr(400, 'Pick 1–10 numbers');
      const b = betOf(u, body), d = new Set(); while (d.size < 10) d.add(1 + ri(40)); const draw = [...d], hits = draw.filter(x => sel.includes(x)).length, mult = KT[sel.length][hits], pay = r2(b * mult);
      charge(u, b); payout(u, pay, mult > 0); return out({ draw, hits, mult, win: mult > 0, payout: pay });
    }
    if (act === 'wheel') {
      const risk = [0, 1, 2].includes(+body.risk) ? +body.risk : 1, M = whMults(risk), b = betOf(u, body), i = ri(M.length), mult = M[i], pay = r2(b * mult);
      charge(u, b); payout(u, pay, mult > 0); return out({ index: i, mult, win: mult > 0, payout: pay });
    }
    if (act === 'plinko') {
      const rows = [8, 12, 16].includes(+body.rows) ? +body.rows : 12, risk = [0, 1, 2].includes(+body.risk) ? +body.risk : 1, n = Math.max(1, Math.min(25, +body.n | 0 || 1)), b = betOf(u, body, n), M = plMults(rows, risk), balls = [];
      charge(u, r2(b * n)); let total = 0;
      for (let k = 0; k < n; k++) { const dirs = Array.from({ length: rows }, () => rf() < .5), R = dirs.filter(Boolean).length, mult = M[R], pay = r2(b * mult); total += pay; balls.push({ dirs, mult }); payout(u, pay, mult >= 1); }
      return out({ balls, payout: r2(total) });
    }
  }
  if (g === 'crash') {
    if (act === 'start') {
      settleStale(u, 'crash'); const b = betOf(u, body), auto = +body.auto >= 1.01 ? Math.min(1e6, +body.auto) : 0;
      const crash = Math.max(1, Math.floor(99 / (rf() * 100 + 1e-9) * 100) / 100); charge(u, b);
      if (crash <= 1) { payout(u, 0, false); return out({ resolved: true, win: false, m: 1, crash }); }
      if (auto && auto < crash) { const pay = r2(b * auto); payout(u, pay, true); return out({ resolved: true, win: true, m: auto, crash, payout: pay }); }
      newRound(u, 'crash', b, { crash, t0: Date.now() }); return out({ resolved: false, balAfterBet: r2(balOf(u.id)) });
    }
    const r = openRound(u, 'crash'); if (!r) return out({ closed: true }); const st = JSON.parse(r.state), m = Math.floor(crashAt(Date.now() - st.t0) * 100) / 100;
    if (m >= st.crash) { closeRound(r.id); payout(u, 0, false); return out({ crashed: true, crash: st.crash }); }
    if (act === 'poll') return out({ m });
    if (act === 'cash') { closeRound(r.id); const pay = r2(r.bet * m); payout(u, pay, true); return out({ win: true, m, crash: st.crash, payout: pay }); }
  }
  if (g === 'mines') {
    if (act === 'start') {
      settleStale(u, 'mines'); const b = betOf(u, body), n = Math.max(1, Math.min(24, +body.mines | 0 || 3)), mines = new Set(); while (mines.size < n) mines.add(ri(25));
      charge(u, b); newRound(u, 'mines', b, { n, mines: [...mines], picked: [] }); return out({ balAfterBet: r2(balOf(u.id)) });
    }
    const r = openRound(u, 'mines'); if (!r) throw new HttpErr(400, 'No active game'); const st = JSON.parse(r.state);
    if (act === 'pick') {
      const i = +body.i; if (!Number.isInteger(i) || i < 0 || i > 24 || st.picked.includes(i)) throw new HttpErr(400, 'Invalid tile');
      if (st.mines.includes(i)) { closeRound(r.id); payout(u, 0, false); return out({ bomb: true, mines: st.mines }); }
      st.picked.push(i); const p = st.picked.length, mult = minesMult(st.n, p);
      if (p === 25 - st.n) { closeRound(r.id); const pay = r2(r.bet * mult); payout(u, pay, true); return out({ gem: true, p, done: true, mult, payout: pay, mines: st.mines }); }
      run('UPDATE rounds SET state=? WHERE id=?', JSON.stringify(st), r.id); return out({ gem: true, p, mult });
    }
    if (act === 'cash') {
      if (!st.picked.length) throw new HttpErr(400, 'Pick a tile first'); closeRound(r.id); const mult = minesMult(st.n, st.picked.length), pay = r2(r.bet * mult); payout(u, pay, true);
      return out({ done: true, p: st.picked.length, mult, payout: pay, mines: st.mines });
    }
  }
  if (g === 'hilo') {
    if (act === 'start') {
      settleStale(u, 'hilo'); const b = betOf(u, body), card = 1 + ri(13); charge(u, b); newRound(u, 'hilo', b, { r: card, m: 1, n: 0 }); return out({ card, balAfterBet: r2(balOf(u.id)) });
    }
    const r = openRound(u, 'hilo'); if (!r) throw new HttpErr(400, 'No active game'); const st = JSON.parse(r.state);
    if (act === 'guess') {
      const hi = body.d === 'h', p = hi ? (13 - st.r) / 13 : (st.r - 1) / 13; if (p === 0) throw new HttpErr(400, 'Not possible');
      const card = 1 + ri(13), win = hi ? card > st.r : card < st.r; st.r = card;
      if (!win) { closeRound(r.id); payout(u, 0, false); return out({ card, win: false }); }
      st.m *= 0.99 / p; st.n++; run('UPDATE rounds SET state=? WHERE id=?', JSON.stringify(st), r.id); return out({ card, win: true, m: st.m });
    }
    if (act === 'cash') { if (!st.n) throw new HttpErr(400, 'Make a guess first'); closeRound(r.id); const pay = r2(r.bet * st.m); payout(u, pay, true); return out({ m: st.m, payout: pay }); }
  }
  throw new HttpErr(404, 'Not found');
}

// ---------- user API ----------
async function userApi(req, res, p, body) {
  const m = req.method, ip = ipOf(req);
  const auth = () => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = unsign(t); const u = s && s.u ? one('SELECT * FROM users WHERE id=?', s.u) : null; if (!u || u.blocked) throw new HttpErr(401, 'Please log in again'); return u; };
  if (p === '/signup' && m === 'POST') {
    if (limited('su' + ip, 10, 3600e3)) throw new HttpErr(429, 'Too many attempts. Try later.');
    const name = str(body.name, 16), email = str(body.email).toLowerCase(), pw = typeof body.password === 'string' ? body.password : '', ref = str(body.ref, 10).toUpperCase();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new HttpErr(400, 'Username must be 3–16 characters: letters, numbers or _.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpErr(400, 'Enter a valid email address.');
    if (pw.length < 8 || pw.length > 100 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpErr(400, 'Password needs 8+ characters with a letter and a number.');
    if (one('SELECT 1 x FROM users WHERE name=?', name)) throw new HttpErr(409, 'Username already taken.');
    if (one('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpErr(409, 'Email already registered.');
    let refBy = null; if (ref) { const r = one('SELECT id,code FROM users WHERE code=?', ref); if (!r) throw new HttpErr(400, 'Referral code not found.'); refBy = r.code; run('UPDATE users SET refs=refs+1 WHERE id=?', r.id); }
    const id = run('INSERT INTO users(name,email,pw,code,ref_by,created,last_login,ip) VALUES(?,?,?,?,?,?,?,?)', name, email, hash(pw), genCode(), refBy, Date.now(), Date.now(), ip).lastInsertRowid;
    log('user:' + name, 'signup', email); notify(`🆕 New registration\nUser: ${name}\nEmail: ${email}\nIP: ${ip}${refBy ? '\nRef: ' + refBy : ''}`);
    return send(res, 200, { token: sign({ u: +id }, 30 * 864e5), user: pubUser(one('SELECT * FROM users WHERE id=?', id)) });
  }
  if (p === '/login' && m === 'POST') {
    if (limited('li' + ip, 20, 900e3)) throw new HttpErr(429, 'Too many attempts. Try in 15 minutes.');
    const id = str(body.id), u = one('SELECT * FROM users WHERE name=? OR email=?', id, id.toLowerCase());
    if (!u || !verify(String(body.password || ''), u.pw)) throw new HttpErr(401, 'Wrong username/email or password.');
    if (u.blocked) throw new HttpErr(403, 'This account is blocked. Contact support.');
    run('UPDATE users SET last_login=?, ip=? WHERE id=?', Date.now(), ip, u.id);
    return send(res, 200, { token: sign({ u: u.id }, 30 * 864e5), user: pubUser(u) });
  }
  if (p === '/config' && m === 'GET') {
    const d = {}; for (const r of q("SELECT k,v FROM settings WHERE k LIKE 'dep:%'")) d[r.k.slice(4)] = r.v;
    return send(res, 200, { depositAddresses: d, limits: { minDeposit: MIN_DEPOSIT, minWithdraw: MIN_WITHDRAW }, wdNote: getSet('wd_note') || '', wdMain: getSet('wd_main') || '', supportText: getSet('support_text') || '', lockTitle: getSet('lock_title') || '', lockMsg: getSet('lock_msg') || '' });
  }
  const u = auth();
  if (p === '/me' && m === 'GET') return send(res, 200, { user: pubUser(u) });
  if (p === '/stats' && m === 'PUT') return send(res, 200, {}); // stats are counted by the server
  if (p === '/verif' && m === 'PUT') { const v = JSON.stringify(body.verif || {}); if (v.length > 5000) throw new HttpErr(400, 'Too large'); run('UPDATE users SET verif=? WHERE id=?', v, u.id); log('user:' + u.name, 'verification', 'updated'); return send(res, 200, {}); }
  if (p === '/change-password' && m === 'POST') {
    const pw = String(body.password || ''); if (!verify(String(body.current || ''), u.pw)) throw new HttpErr(400, 'Current password is wrong.');
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpErr(400, 'New password needs 8+ characters with a letter and a number.');
    run('UPDATE users SET pw=? WHERE id=?', hash(pw), u.id); return send(res, 200, {});
  }
  if (p === '/wallet' && m === 'GET') return send(res, 200, { addresses: q('SELECT coin,network,address FROM addrs WHERE user_id=?', u.id), balance: r2(u.bal) });
  if (p === '/wallet/address' && m === 'PUT') {
    if (!verify(String(body.password || ''), u.pw)) throw new HttpErr(400, 'Account password is wrong.');
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(), a = str(body.address, 200);
    if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Enter a valid coin and network.');
    if (!/^[A-Za-z0-9:._-]{20,200}$/.test(a)) throw new HttpErr(400, 'Enter a valid wallet address.');
    run('INSERT INTO addrs(user_id,coin,network,address) VALUES(?,?,?,?) ON CONFLICT(user_id,coin,network) DO UPDATE SET address=excluded.address', u.id, coin, net, a);
    log('user:' + u.name, 'address', `${coin}/${net} ${a}`); return send(res, 200, {});
  }
  if (p === '/deposits' && m === 'POST') {
    if (limited('dp' + u.id, 10, 3600e3)) throw new HttpErr(429, 'Too many submissions. Try later.');
    const amt = +body.amount, tx = str(body.txHash, 200), coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase();
    const dAmt = +body.dispAmount, dCur = str(body.dispCur, 6).toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Choose a valid currency and network.');
    if (!(amt >= MIN_DEPOSIT && amt <= 1e8)) throw new HttpErr(400, amt > 0 ? 'Minimum deposit is ₹' + MIN_DEPOSIT + '.' : 'Enter a valid amount.');
    if (!/^[A-Za-z0-9:._-]{8,200}$/.test(tx)) throw new HttpErr(400, 'Enter the full transaction ID (TXID) without spaces.');
    if (one("SELECT 1 x FROM deposits WHERE lower(tx_hash)=lower(?) AND status!='rejected'", tx)) throw new HttpErr(409, 'This transaction was already submitted.');
    run('INSERT INTO deposits(user_id,amount,coin,network,tx_hash,created,disp_amount,disp_cur) VALUES(?,?,?,?,?,?,?,?)', u.id, r2(amt), coin, net, tx, Date.now(), Number.isFinite(dAmt) && dAmt > 0 ? dAmt : null, /^[A-Z]{3,4}$/.test(dCur) ? dCur : null);
    log('user:' + u.name, 'deposit-request', `₹${amt} ${coin}/${net}`); notify(`💰 Deposit request\nUser: ${u.name}\nAmount: ₹${amt}\n${coin}/${net}\nTX: ${tx}`);
    return send(res, 200, { message: 'Submitted. Your balance will be added after verification.' });
  }
  if (p === '/transactions' && m === 'GET') return send(res, 200, {
    deposits: q('SELECT id,amount,coin,network,tx_hash,status,created,decided,admin_note FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id),
    withdrawals: q('SELECT id,amount,coin,network,address,status,created,decided,tx_hash,admin_note FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id)
  });
  if (p === '/withdrawals' && m === 'POST') {
    if (limited('wda' + u.id, 30, 3600e3)) throw new HttpErr(429, 'Too many attempts. Try again later.');   // guards password guessing
    if (one('SELECT COUNT(*) c FROM withdrawals WHERE user_id=? AND created>?', u.id, Date.now() - 3600e3).c >= 5) throw new HttpErr(429, 'Too many withdrawal requests this hour. Try again later.');
    if (!verify(String(body.password || ''), u.pw)) throw new HttpErr(400, 'Account password is wrong.');
    const amt = r2(+body.amount), coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(), a = str(body.address, 200);
    const dAmt = +body.dispAmount, dCur = str(body.dispCur, 6).toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Choose a valid currency and network.');
    if (!/^[A-Za-z0-9:._-]{20,200}$/.test(a)) throw new HttpErr(400, 'Enter a valid wallet address.');
    if (!Number.isFinite(amt) || amt < MIN_WITHDRAW) throw new HttpErr(400, 'Minimum withdrawal is ₹' + MIN_WITHDRAW + '.');
    const id = atomic(() => {
      // hold the amount now; refunded automatically if the admin rejects
      if (!run('UPDATE users SET bal=ROUND(bal-?,2) WHERE id=? AND bal>=?', amt, u.id, amt).changes) throw new HttpErr(400, 'Insufficient balance.');
      const wid = run('INSERT INTO withdrawals(user_id,amount,coin,network,address,created,disp_amount,disp_cur) VALUES(?,?,?,?,?,?,?,?)', u.id, amt, coin, net, a, Date.now(), Number.isFinite(dAmt) && dAmt > 0 ? dAmt : null, /^[A-Z]{3,4}$/.test(dCur) ? dCur : null).lastInsertRowid;
      run('INSERT INTO addrs(user_id,coin,network,address) VALUES(?,?,?,?) ON CONFLICT(user_id,coin,network) DO NOTHING', u.id, coin, net, a);
      return +wid;
    });
    log('user:' + u.name, 'withdraw-request', `#${id} ₹${amt} ${coin}/${net} ${a}`); notify(`💸 Withdrawal request\nUser: ${u.name}\nAmount: ₹${amt}\n${coin}/${net}\nAddress: ${a}`);
    return send(res, 200, { id, bal: r2(balOf(u.id)), message: 'Withdrawal requested. The amount is on hold and will be sent after review.' });
  }
  if (m === 'POST' && /^\/(play|crash|mines|hilo)\//.test(p)) return send(res, 200, gameApi(u, p, body));
  throw new HttpErr(404, 'Not found');
}

// ---------- admin API ----------
async function adminApi(req, res, p, body, url) {
  const m = req.method, ip = ipOf(req);
  if (p === '/login' && m === 'POST') {
    if (limited('al' + ip, 8, 900e3)) throw new HttpErr(429, 'Too many attempts. Try in 15 minutes.');
    const a = one('SELECT * FROM admins WHERE username=?', str(body.username));
    if (!a || !verify(String(body.password || ''), a.pw)) { log('?', 'admin-login-failed', ip); throw new HttpErr(401, 'Wrong username or password.'); }
    log(a.username, 'admin-login', ip);
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': `gx_admin=${sign({ a: a.id }, 7 * 864e5)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
  }
  if (p === '/logout') return send(res, 200, {}, { 'Set-Cookie': 'gx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  const s = unsign(cookie(req, 'gx_admin')), adm = s && one('SELECT * FROM admins WHERE id=?', s.a);
  if (!adm) throw new HttpErr(401, 'Login required');
  if (m !== 'GET' && !String(req.headers['content-type'] || '').includes('json')) throw new HttpErr(400, 'Bad request');
  const A = adm.username, num = v => { const n = +v; if (!Number.isFinite(n)) throw new HttpErr(400, 'Invalid number'); return n; };
  let mt;
  if (p === '/summary') {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    return send(res, 200, {
      users: one('SELECT COUNT(*) c FROM users').c, today: one('SELECT COUNT(*) c FROM users WHERE created>=?', d0.getTime()).c, blocked: one('SELECT COUNT(*) c FROM users WHERE blocked=1').c,
      totalBal: r2(one('SELECT COALESCE(SUM(bal),0) s FROM users').s), pending: one("SELECT COUNT(*) c FROM deposits WHERE status='pending'").c, pendingW: one("SELECT COUNT(*) c FROM withdrawals WHERE status='pending'").c, paidOut: r2(one("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status='approved'").s), lastWd: one('SELECT COALESCE(MAX(id),0) m FROM withdrawals').m,
      approved: r2(one("SELECT COALESCE(SUM(amount),0) s FROM deposits WHERE status='approved'").s), lastUser: one('SELECT COALESCE(MAX(id),0) m FROM users').m, lastDep: one('SELECT COALESCE(MAX(id),0) m FROM deposits').m,
      recent: q('SELECT id,name,email,created FROM users ORDER BY id DESC LIMIT 5')
    });
  }
  if (p === '/users' && m === 'GET') {
    const s = '%' + str(url.searchParams.get('q')).replace(/[%_]/g, '') + '%';
    return send(res, 200, { users: q('SELECT id,name,email,bal,blocked,created,last_login,ip,refs,ref_by FROM users WHERE name LIKE ? OR email LIKE ? OR code LIKE ? ORDER BY id DESC LIMIT 500', s, s, s) });
  }
  if ((mt = p.match(/^\/users\/(\d+)$/))) {
    const id = +mt[1], u = one('SELECT * FROM users WHERE id=?', id); if (!u) throw new HttpErr(404, 'User not found');
    if (m === 'GET') return send(res, 200, { user: { ...u, pw: undefined, verif: JSON.parse(u.verif || '{}') }, addrs: q('SELECT coin,network,address FROM addrs WHERE user_id=?', id), deposits: q('SELECT * FROM deposits WHERE user_id=? ORDER BY id DESC', id), withdrawals: q('SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC', id), referred: q('SELECT name,created FROM users WHERE ref_by=?', u.code) });
    if (m === 'PATCH') {
      const name = str(body.name, 16), email = str(body.email).toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new HttpErr(400, 'Bad username'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpErr(400, 'Bad email');
      if (one('SELECT 1 x FROM users WHERE (name=? OR email=?) AND id!=?', name, email, id)) throw new HttpErr(409, 'Username/email already used');
      const bal = r2(num(body.bal)); run('UPDATE users SET name=?, email=?, bal=?, blocked=?, note=? WHERE id=?', name, email, bal, body.blocked ? 1 : 0, str(body.note, 500), id);
      log(A, 'user-edit', `${u.name}: bal ${u.bal}→${bal}, blocked ${u.blocked}→${body.blocked ? 1 : 0}`); return send(res, 200, {});
    }
    if (m === 'DELETE') { run('DELETE FROM addrs WHERE user_id=?', id); run('DELETE FROM deposits WHERE user_id=?', id); run('DELETE FROM withdrawals WHERE user_id=?', id); run('DELETE FROM users WHERE id=?', id); log(A, 'user-delete', u.name); return send(res, 200, {}); }
  }
  if ((mt = p.match(/^\/users\/(\d+)\/balance$/)) && m === 'POST') {
    const u = one('SELECT * FROM users WHERE id=?', +mt[1]); if (!u) throw new HttpErr(404, 'User not found');
    const d = r2(num(body.delta)); if (u.bal + d < 0) throw new HttpErr(400, 'Balance cannot go below 0'); run('UPDATE users SET bal=bal+? WHERE id=?', d, u.id);
    log(A, 'balance', `${u.name} ${d >= 0 ? '+' : ''}${d} ${str(body.reason)}`); return send(res, 200, {});
  }
  if ((mt = p.match(/^\/users\/(\d+)\/password$/)) && m === 'POST') {
    const pw = String(body.password || ''); if (pw.length < 8) throw new HttpErr(400, 'Min 8 characters'); const u = one('SELECT name FROM users WHERE id=?', +mt[1]); if (!u) throw new HttpErr(404, 'Not found');
    run('UPDATE users SET pw=? WHERE id=?', hash(pw), +mt[1]); log(A, 'user-password-reset', u.name); return send(res, 200, {});
  }
  if ((mt = p.match(/^\/users\/(\d+)\/address$/)) && m === 'PUT') {
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(), a = str(body.address, 200); if (!coin || !net) throw new HttpErr(400, 'Coin/network required');
    if (!a) run('DELETE FROM addrs WHERE user_id=? AND coin=? AND network=?', +mt[1], coin, net);
    else run('INSERT INTO addrs(user_id,coin,network,address) VALUES(?,?,?,?) ON CONFLICT(user_id,coin,network) DO UPDATE SET address=excluded.address', +mt[1], coin, net, a);
    log(A, 'user-address', `uid ${mt[1]} ${coin}/${net} ${a}`); return send(res, 200, {});
  }
  if (p === '/deposits' && m === 'GET') {
    const st = str(url.searchParams.get('status')); return send(res, 200, { deposits: q(`SELECT d.*, u.name FROM deposits d LEFT JOIN users u ON u.id=d.user_id ${st ? 'WHERE d.status=?' : 'WHERE ?=?'} ORDER BY d.id DESC LIMIT 500`, ...(st ? [st] : [1, 1])) });
  }
  if ((mt = p.match(/^\/deposits\/(\d+)\/(approve|reject)$/)) && m === 'POST') {
    const d = one('SELECT * FROM deposits WHERE id=?', +mt[1]); if (!d) throw new HttpErr(404, 'Not found'); if (d.status !== 'pending') throw new HttpErr(400, 'Already ' + d.status);
    const ok = mt[2] === 'approve', amt = ok && body.amount != null ? r2(num(body.amount)) : d.amount; if (ok && !(amt > 0)) throw new HttpErr(400, 'Bad amount');
    run('UPDATE deposits SET status=?, decided=?, amount=?, admin_note=? WHERE id=?', ok ? 'approved' : 'rejected', Date.now(), amt, str(body.note, 300), d.id);
    if (ok) run('UPDATE users SET bal=bal+? WHERE id=?', amt, d.user_id); log(A, 'deposit-' + mt[2], `#${d.id} ₹${amt}`); return send(res, 200, {});
  }
  if (p === '/withdrawals' && m === 'GET') {
    const st = str(url.searchParams.get('status')); return send(res, 200, { withdrawals: q(`SELECT w.*, u.name FROM withdrawals w LEFT JOIN users u ON u.id=w.user_id ${st ? 'WHERE w.status=?' : 'WHERE ?=?'} ORDER BY w.id DESC LIMIT 500`, ...(st ? [st] : [1, 1])) });
  }
  if ((mt = p.match(/^\/withdrawals\/(\d+)\/(approve|reject)$/)) && m === 'POST') {
    const ok = mt[2] === 'approve', note = str(body.note, 300), tx = str(body.txHash, 200);
    atomic(() => {
      const w = one('SELECT * FROM withdrawals WHERE id=?', +mt[1]); if (!w) throw new HttpErr(404, 'Not found'); if (w.status !== 'pending') throw new HttpErr(400, 'Already ' + w.status);
      run('UPDATE withdrawals SET status=?, decided=?, tx_hash=?, admin_note=? WHERE id=?', ok ? 'approved' : 'rejected', Date.now(), tx, note, w.id);
      if (!ok) run('UPDATE users SET bal=ROUND(bal+?,2) WHERE id=?', w.amount, w.user_id);   // refund the held amount
      log(A, 'withdraw-' + mt[2], `#${w.id} ₹${w.amount}${tx ? ' tx ' + tx : ''}`);
    });
    return send(res, 200, {});
  }
  if (p === '/deposit-addresses') {
    if (m === 'GET') return send(res, 200, { list: q("SELECT k,v FROM settings WHERE k LIKE 'dep:%' ORDER BY k").map(r => { const [c, n] = r.k.slice(4).split(':'); return { coin: c, network: n, address: r.v }; }) });
    const coin = str(body.coin, 12).toUpperCase(), net = str(body.network, 12).toUpperCase(); if (!/^[A-Z0-9]{2,12}$/.test(coin) || !/^[A-Z0-9]{2,12}$/.test(net)) throw new HttpErr(400, 'Bad coin/network');
    if (m === 'PUT') { const a = str(body.address, 200); if (a.length < 10) throw new HttpErr(400, 'Address too short'); setSet(`dep:${coin}:${net}`, a); log(A, 'deposit-address', `${coin}/${net} → ${a}`); return send(res, 200, {}); }
    if (m === 'DELETE') { run('DELETE FROM settings WHERE k=?', `dep:${coin}:${net}`); log(A, 'deposit-address-delete', `${coin}/${net}`); return send(res, 200, {}); }
  }
  if (p === '/settings') {
    if (m === 'GET') return send(res, 200, { admin: A, tg_token: getSet('tg_token') ? '••••' : '', tg_chat: getSet('tg_chat') || '', tgEnv: !!process.env.TELEGRAM_BOT_TOKEN, wd_note: getSet('wd_note') || '', wd_main: getSet('wd_main') || '', support_text: getSet('support_text') || '', lock_title: getSet('lock_title') || '', lock_msg: getSet('lock_msg') || '' });
    if (m === 'PUT' && 'support_text' in body) { setSet('support_text', str(body.support_text, 600)); log(A, 'settings', 'support-text'); return send(res, 200, {}); }
    if (m === 'PUT' && 'lock_msg' in body) { setSet('lock_title', str(body.lock_title, 60)); setSet('lock_msg', str(body.lock_msg, 400)); log(A, 'settings', 'game-unavailable-msg'); return send(res, 200, {}); }
    if (m === 'PUT' && 'wd_note' in body) { setSet('wd_note', str(body.wd_note, 600)); setSet('wd_main', str(body.wd_main, 400)); log(A, 'settings', 'withdraw-note'); return send(res, 200, {}); }
    if (m === 'PUT') { if (body.tg_token && !/^•+$/.test(body.tg_token)) setSet('tg_token', str(body.tg_token, 200)); if (body.tg_token === '') setSet('tg_token', ''); setSet('tg_chat', str(body.tg_chat, 50)); log(A, 'settings', 'telegram'); return send(res, 200, {}); }
  }
  if (p === '/test-notify' && m === 'POST') { await notify('✅ GXPLAY admin: test notification'); return send(res, 200, {}); }
  if (p === '/change-password' && m === 'POST') {
    if (!verify(String(body.current || ''), adm.pw)) throw new HttpErr(400, 'Current password wrong'); const pw = String(body.password || ''); if (pw.length < 8) throw new HttpErr(400, 'Min 8 characters');
    const nu = str(body.username, 30) || adm.username; run('UPDATE admins SET pw=?, username=? WHERE id=?', hash(pw), nu, adm.id); log(A, 'admin-password', ''); return send(res, 200, {});
  }
  if (p === '/logs') return send(res, 200, { logs: q('SELECT * FROM logs ORDER BY id DESC LIMIT 300') });
  if (p === '/export.csv') {
    const rows = q('SELECT id,name,email,bal,blocked,created,last_login,ip,ref_by FROM users ORDER BY id'), e = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"';
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=users.csv' });
    return res.end(['id,name,email,balance,blocked,created,last_login,ip,ref_by', ...rows.map(r => Object.values(r).map((v, i) => e(i === 5 || i === 6 ? (v ? new Date(v).toISOString() : '') : v)).join(','))].join('\n'));
  }
  throw new HttpErr(404, 'Not found');
}

// ---------- server ----------
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'); let p = decodeURIComponent(url.pathname);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
    if (p.startsWith('/api/') || p.startsWith('/admin/api/')) {
      const body = req.method === 'GET' ? {} : await readBody(req);
      try { return p.startsWith('/api/') ? await userApi(req, res, p.slice(4), body) : await adminApi(req, res, p.slice(10), body, url); }
      catch (e) { if (e instanceof HttpErr) return send(res, e.s, { error: e.message }); throw e; }
    }
    if (p === '/admin' || p === '/admin/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); return fs.createReadStream(path.join(__dirname, 'admin.html')).pipe(res); }
    if (p === '/') p = '/index.html';
    const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, e.s || 500, { error: e.s ? e.message : 'Server error' }); else res.end(); }
});
server.listen(PORT, () => console.log(`Website: http://localhost:${PORT}\nAdmin:   http://localhost:${PORT}/admin`));

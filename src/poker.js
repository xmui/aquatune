/* ============================================================================
 * AquaPoker — 6-max No-Limit Texas Hold'em (Increment 1: local table vs CPUs)
 *
 * Microsoft-styled to match Solitaire/Blackjack (.sol-card / .sol-titlebar /
 * .win95-btn / #006400 felt). Real-credit buy-in/cash-out. A clean seat-based
 * engine (blinds, no-limit betting, side pots, streets, showdown) that
 * Increment 2 will drive over Firebase for true multiplayer.
 *
 * Replaces the legacy heads-up heHoldem; exposes window.openHoldem().
 * ========================================================================== */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RED = new Set(['♥', '♦']);
const NSEATS = 6, BUYIN = 200, SB = 5, BB = 10;
const CPU_NAMES = ['Ace', 'Bluffy', 'Slowroll', 'Maverick', 'Nora', 'Chips', 'Duke', 'Vera'];

/* ---- deck + hand evaluation (ported from the legacy evaluator) ---------- */
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let i = 0; i < RANKS.length; i++) d.push({ s, r: RANKS[i], v: i + 2, red: RED.has(s) });
  for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
function eval5(cs) {
  const vs = cs.map(c => c.v).sort((a, b) => b - a);
  const suits = cs.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(vs)];
  let straight = false, shi = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { straight = true; shi = uniq[0]; }
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) { straight = true; shi = 5; } // wheel
  }
  const counts = {}; vs.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts).map(([v, n]) => ({ v: +v, n })).sort((a, b) => b.n - a.n || b.v - a.v);
  const tie = groups.reduce((acc, g) => acc * 100 + g.v, 0);
  let rank;
  if (straight && flush) rank = 8; else if (groups[0].n === 4) rank = 7; else if (groups[0].n === 3 && groups[1] && groups[1].n === 2) rank = 6;
  else if (flush) rank = 5; else if (straight) rank = 4; else if (groups[0].n === 3) rank = 3;
  else if (groups[0].n === 2 && groups[1] && groups[1].n === 2) rank = 2; else if (groups[0].n === 2) rank = 1; else rank = 0;
  return { rank, tie: (rank === 4 || rank === 8) ? shi : tie, name: HAND_NAMES[rank] };
}
function best7(cards) {
  if (cards.length < 5) return { rank: -1, tie: 0, name: '' };
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const h = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
      if (!best || h.rank > best.rank || (h.rank === best.rank && h.tie > best.tie)) best = h;
    }
  return best;
}
function cmpHand(x, y) { return x.rank !== y.rank ? x.rank - y.rank : x.tie - y.tie; }

/* ---- game state --------------------------------------------------------- */
let G = null;
let _creditMirror = null; // last stack value mirrored into your credits (your local seat)
// Mirror your seat's chips into your real account credits, applying only the
// poker-induced delta (so credits earned in other apps are preserved). Browser
// only; headless render (tests) skips this so engine assertions stay stack-pure.
function syncCreditsToStack() {
  if (typeof window === 'undefined' || typeof window.aqAddCredits !== 'function') return;
  const i = mySeatIdx();
  if (i < 0) { _creditMirror = null; return; }
  const st = G.seats[i].stack;
  if (_creditMirror == null) { _creditMirror = st; return; } // just sat — anchor, no delta
  if (st !== _creditMirror) { addCredits(st - _creditMirror); _creditMirror = st; }
}
function emptyGame() {
  return { seats: new Array(NSEATS).fill(null), board: [], deck: [], pot: 0, dealer: -1, sb: SB, bb: BB,
    street: 'idle', turn: -1, toCall: 0, minRaiseTo: BB, lastRaiseSize: BB, handNo: 0, msg: 'Take a seat and press Deal.', winners: [] };
}
function newSeat(o) { return Object.assign({ name: 'Player', isCpu: false, isYou: false, ownerId: null, stack: 0, hole: [], folded: false, allIn: false, bet: 0, contrib: 0, acted: false, sitOut: false }, o); }
function activeIdx() { return G.seats.map((s, i) => s && s.stack > 0 && !s.sitOut ? i : -1).filter(i => i >= 0); }
function inHandIdx() { return G.seats.map((s, i) => s && s.inHand ? i : -1).filter(i => i >= 0); }
function liveIdx() { return G.seats.map((s, i) => s && s.inHand && !s.folded ? i : -1).filter(i => i >= 0); }
function nextOccupied(from, pred) {
  for (let k = 1; k <= NSEATS; k++) { const i = (from + k) % NSEATS; const s = G.seats[i]; if (s && pred(s, i)) return i; }
  return -1;
}

/* ---- seating: buy in / cash out with real credits ---------------------- */
function credits() { return typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 100; }
function addCredits(n) { if (typeof window.aqAddCredits === 'function') window.aqAddCredits(n); }
function toastSafe(m) { if (typeof window.toast === 'function') window.toast(m); }

/* ---- multiplayer helpers (a room = one shared, host-authoritative table) -
   In a room the room host runs the engine and broadcasts state; guests render
   from it and send actions the host applies. Outside a room everything below
   is inert, so solo play is unchanged. */
function inRoom() { return typeof window !== 'undefined' && !!window._currentRoomId; }
function amHost() { return typeof window !== 'undefined' && !!window._isRoomHost; }
function myId() { return (typeof window !== 'undefined' && window._myUserId) || 'me'; }
function isMine(s) { return !!s && (inRoom() ? s.ownerId === myId() : s.isYou); }
function mySeatIdx() { return G ? G.seats.findIndex(isMine) : -1; }

function sitYou(idx) {
  if (G.seats[idx]) return;
  if (credits() < BB) { toastSafe('Not enough credits to play'); return; }
  // Nothing is "held" by the table: your seat stack simply mirrors your real
  // credits, and wins/losses flow straight to your account (see syncCreditsToStack).
  const buy = credits();
  const name = (typeof localStorage !== 'undefined' && localStorage.getItem('aq_username')) || 'You';
  if (inRoom() && !amHost()) {
    // guest: ask the host to seat me — the host's broadcast will show the seat
    if (window.pokerSendAction) window.pokerSendAction({ type: 'sit', seat: idx, name, buyin: buy });
    return;
  }
  G.seats[idx] = newSeat({ name, isYou: !inRoom(), ownerId: inRoom() ? myId() : null, stack: buy });
  render();
}
function standYou(idx) {
  const s = G.seats[idx]; if (!s || !isMine(s)) return;
  if (s.inHand && !s.folded && G.street !== 'idle' && G.street !== 'showdown') { toastSafe('Finish the hand first'); return; }
  // No cash-out needed — your credits already reflect your stack live.
  if (inRoom() && !amHost()) { if (window.pokerSendAction) window.pokerSendAction({ type: 'stand', seat: idx }); return; }
  G.seats[idx] = null; render();
}
// A competitive, non-busting stack for bots: match your (credit-mirrored) stack.
function botStack() {
  const i = mySeatIdx();
  const base = (i >= 0 && G.seats[i]) ? G.seats[i].stack : BUYIN;
  return Math.max(BB * 20, base);
}
function addCpu(idx, stack) {
  G.seats[idx] = newSeat({ name: CPU_NAMES[(Math.random() * CPU_NAMES.length) | 0], isCpu: true, stack: stack || botStack() });
}
// Bot management is available to the solo player and to the room host only.
function canManageBots() { return !inRoom() || amHost(); }
function addBotAt(idx) {
  if (!canManageBots() || idx == null || idx < 0 || idx >= NSEATS || G.seats[idx]) return;
  addCpu(idx); render();
}
function kickBot(idx) {
  const s = G.seats[idx];
  if (!s || !s.isCpu || !canManageBots()) return;
  if (s.inHand && !s.folded && G.street !== 'idle' && G.street !== 'showdown') { toastSafe('Finish the hand first'); return; }
  G.seats[idx] = null; render();
}

/* ---- hand flow ---------------------------------------------------------- */
function startHand() {
  // Re-sync your seat to your current credits (you may have earned/spent
  // elsewhere) so the table always reflects your real balance, and keep solo
  // bots stacked so they stay competitive and never bust out from under you.
  const me0 = mySeatIdx();
  if (me0 >= 0) { G.seats[me0].stack = credits(); _creditMirror = credits(); }
  if (!inRoom()) { const ref = botStack(); G.seats.forEach(s => { if (s && s.isCpu && s.stack < ref) s.stack = ref; }); }
  const seated = activeIdx();
  if (seated.length < 2) { G.msg = 'Need at least 2 players with chips.'; render(); return; }
  G.deck = makeDeck(); G.board = []; G.pot = 0; G.winners = []; G.handNo++;
  G.seats.forEach(s => { if (s) { s.hole = []; s.folded = false; s.allIn = false; s.bet = 0; s.contrib = 0; s.acted = false; s.inHand = s.stack > 0 && !s.sitOut; } });
  // dealer button moves to next seated player
  G.dealer = nextOccupied(G.dealer < 0 ? NSEATS - 1 : G.dealer, (s) => s.inHand);
  const order = seated;
  // blinds: heads-up → dealer is SB; else SB left of dealer, BB next
  let sbPos, bbPos;
  if (order.length === 2) { sbPos = G.dealer; bbPos = nextOccupied(G.dealer, s => s.inHand); }
  else { sbPos = nextOccupied(G.dealer, s => s.inHand); bbPos = nextOccupied(sbPos, s => s.inHand); }
  postBlind(sbPos, G.sb); postBlind(bbPos, G.bb);
  G.toCall = G.bb; G.minRaiseTo = G.bb * 2; G.lastRaiseSize = G.bb;
  // deal 2 hole cards each
  for (let r = 0; r < 2; r++) for (const i of inHandIdx()) G.seats[i].hole.push(G.deck.pop());
  publishHoles(); // host: deliver each player their own cards privately
  G.street = 'preflop';
  G.turn = nextOccupied(bbPos, s => s.inHand && !s.allIn);
  G.msg = 'Preflop — ' + seatName(G.turn) + ' to act.';
  render(); maybeCpu();
}
function postBlind(idx, amt) {
  const s = G.seats[idx]; const pay = Math.min(amt, s.stack);
  s.stack -= pay; s.bet = pay; s.contrib += pay; G.pot += pay; if (s.stack === 0) s.allIn = true;
}
function seatName(i) { return i >= 0 && G.seats[i] ? G.seats[i].name : '?'; }

function callAmount(idx) { return Math.max(0, G.toCall - G.seats[idx].bet); }
function legal(idx) {
  const s = G.seats[idx]; const toCall = callAmount(idx);
  const minTo = Math.max(G.minRaiseTo, G.toCall + G.lastRaiseSize);
  const maxTo = s.bet + s.stack; // all-in
  return { canCheck: toCall === 0, callAmt: Math.min(toCall, s.stack), canRaise: s.stack > toCall, minRaiseTo: Math.min(minTo, maxTo), maxRaiseTo: maxTo };
}
// action: 'fold' | 'check' | 'call' | 'raiseTo' (amount = total bet this street)
function applyAction(idx, action, amount) {
  const s = G.seats[idx]; if (!s || G.turn !== idx) return;
  const toCall = callAmount(idx);
  if (action === 'fold') { s.folded = true; s.acted = true; }
  else if (action === 'check') { if (toCall > 0) return; s.acted = true; }
  else if (action === 'call') { const pay = Math.min(toCall, s.stack); s.stack -= pay; s.bet += pay; s.contrib += pay; G.pot += pay; if (s.stack === 0) s.allIn = true; s.acted = true; }
  else if (action === 'raiseTo') {
    const target = Math.max(amount, G.toCall + 1); const add = Math.min(target - s.bet, s.stack);
    const raiseSize = (s.bet + add) - G.toCall;
    s.stack -= add; s.bet += add; s.contrib += add; G.pot += add; if (s.stack === 0) s.allIn = true;
    if (s.bet > G.toCall) { if (raiseSize >= G.lastRaiseSize) G.lastRaiseSize = raiseSize; G.toCall = s.bet; G.minRaiseTo = s.bet + G.lastRaiseSize; G.seats.forEach((p, i) => { if (p && p.inHand && !p.folded && !p.allIn && i !== idx) p.acted = false; }); }
    s.acted = true;
  }
  // win by everyone folding?
  if (liveIdx().length === 1) { return awardUncontested(); }
  // advance turn or street
  const next = nextToAct(idx);
  if (next === -1) endBettingRound(); else { G.turn = next; G.msg = seatName(next) + ' to act.'; render(); maybeCpu(); }
}
function nextToAct(from) {
  for (let k = 1; k <= NSEATS; k++) {
    const i = (from + k) % NSEATS; const s = G.seats[i];
    if (s && s.inHand && !s.folded && !s.allIn && (!s.acted || s.bet < G.toCall)) return i;
  }
  return -1;
}
function endBettingRound() {
  G.seats.forEach(s => { if (s) { s.bet = 0; s.acted = false; } });
  G.toCall = 0; G.minRaiseTo = G.bb; G.lastRaiseSize = G.bb;
  if (G.street === 'preflop') { G.board.push(G.deck.pop(), G.deck.pop(), G.deck.pop()); G.street = 'flop'; }
  else if (G.street === 'flop') { G.board.push(G.deck.pop()); G.street = 'turn'; }
  else if (G.street === 'turn') { G.board.push(G.deck.pop()); G.street = 'river'; }
  else { return showdown(); }
  // if ≤1 can still act (rest all-in), keep dealing to showdown
  const canAct = liveIdx().filter(i => !G.seats[i].allIn);
  if (canAct.length <= 1) { G.turn = -1; render(); setTimeout(endBettingRound, 700); return; }
  G.turn = nextOccupied(G.dealer, s => s.inHand && !s.folded && !s.allIn);
  G.msg = cap(G.street) + ' — ' + seatName(G.turn) + ' to act.';
  render(); maybeCpu();
}
function awardUncontested() {
  const w = liveIdx()[0]; G.seats[w].stack += G.pot;
  G.winners = [{ idx: w, amt: G.pot, name: 'wins' }];
  G.msg = seatName(w) + ' wins ' + G.pot + ' 🪙 (everyone folded).';
  G.street = 'showdown'; G.turn = -1; settleYou(); render();
}
// side pots from per-hand contributions
function buildSidePots() {
  const contenders = inHandIdx().map(i => ({ i, c: G.seats[i].contrib, folded: G.seats[i].folded }));
  const levels = [...new Set(contenders.filter(p => p.c > 0).map(p => p.c))].sort((a, b) => a - b);
  const pots = []; let prev = 0;
  for (const lvl of levels) {
    let amt = 0; const eligible = [];
    for (const p of contenders) { const take = Math.min(p.c, lvl) - prev; if (take > 0) amt += take; if (p.c >= lvl && !p.folded) eligible.push(p.i); }
    if (amt > 0) pots.push({ amt, eligible });
    prev = lvl;
  }
  return pots;
}
function showdown() {
  G.street = 'showdown'; G.turn = -1;
  const scores = {}; liveIdx().forEach(i => scores[i] = best7([...G.seats[i].hole, ...G.board]));
  const pots = buildSidePots(); const wonBy = {};
  for (const pot of pots) {
    const live = pot.eligible.filter(i => !G.seats[i].folded);
    if (!live.length) continue;
    let bestH = null; live.forEach(i => { if (!bestH || cmpHand(scores[i], bestH) > 0) bestH = scores[i]; });
    const winners = live.filter(i => cmpHand(scores[i], bestH) === 0);
    const share = Math.floor(pot.amt / winners.length); let rem = pot.amt - share * winners.length;
    winners.forEach(i => { const give = share + (rem-- > 0 ? 1 : 0); G.seats[i].stack += give; wonBy[i] = (wonBy[i] || 0) + give; });
  }
  G.winners = Object.entries(wonBy).map(([i, amt]) => ({ idx: +i, amt, hand: scores[+i].name }));
  G.msg = G.winners.map(w => seatName(w.idx) + ' wins ' + w.amt + ' 🪙 (' + w.hand + ')').join(' · ');
  settleYou(); render();
}
// reflect your seat's chips back into real credits when the hand ends
function settleYou() {
  if (typeof window.recordScore === 'function') { const you = G.seats.find(s => s && s.isYou); if (you) window.recordScore('holdem', you.stack, 'table chips'); }
  if (typeof window.aqGameXp === 'function') {
    const myIdx = G.seats.findIndex(s => s && s.isYou);
    const iWon = myIdx >= 0 && Array.isArray(G.winners) && G.winners.some(w => w.idx === myIdx);
    // Balanced toward ~40/min: you only win ~1/N hands, so winners pay well (scaled by the
    // pot you took, capped) while every hand still grants a small played trickle.
    if (myIdx >= 0) {
      const myWin = ((Array.isArray(G.winners) && G.winners.find(w => w.idx === myIdx)) || {}).amt || 0;
      const mult = iWon ? Math.min(16, 8 + myWin / (BB * 2)) : 3;
      window.aqGameXp('gambling', { played: true, won: iWon, luck: 0.4, mult });
    }
  }
}

/* ---- CPU ---------------------------------------------------------------- */
function maybeCpu() {
  if (G.turn < 0) return; const s = G.seats[G.turn];
  if (s && s.isCpu && !s.folded && !s.allIn) setTimeout(() => cpuAct(G.turn), 700 + Math.random() * 700);
}
function cpuAct(idx) {
  if (G.turn !== idx) return; const s = G.seats[idx]; const L = legal(idx);
  const strength = best7([...s.hole, ...G.board]).rank + (G.board.length === 0 ? handPreflop(s.hole) : 0);
  const r = Math.random();
  if (L.callAmt > 0 && strength < 1 && r < 0.55 && L.callAmt > s.stack * 0.15) { applyAction(idx, 'fold'); return; }
  if (L.canRaise && (strength >= 2 || (strength >= 1 && r < 0.4) || r < 0.12)) {
    const raiseTo = Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, Math.round((G.pot * (0.5 + r)) / G.bb) * G.bb));
    applyAction(idx, 'raiseTo', raiseTo); return;
  }
  if (L.canCheck) applyAction(idx, 'check'); else applyAction(idx, 'call');
}
function handPreflop(hole) { // rough preflop bump for CPU
  const [a, b] = hole; let s = 0; if (a.v === b.v) s += 1.5; if (a.v >= 12 || b.v >= 12) s += 0.6; if (a.s === b.s) s += 0.4; return s;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* (UI + window hookup appended below) */

/* ---- rendering (Microsoft-style felt table) ---------------------------- */
const POS = [ {x:50,y:90}, {x:14,y:70}, {x:14,y:25}, {x:50,y:6}, {x:86,y:25}, {x:86,y:70} ];
function el(t, c, html){ const e=document.createElement(t); if(c) e.className=c; if(html!=null) e.innerHTML=html; return e; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function cardEl(card, faceDown){
  const d=document.createElement('div'); d.className='sol-card pk-card'+(faceDown?' face-down':(card&&card.red?' red':' black'));
  if(!faceDown && card){ d.innerHTML=`<div class="sol-card-top">${card.r}</div><div class="sol-card-suit">${card.s}</div>`; }
  return d;
}
function render(){
  // In a room the host publishes every state change (placed before the headless
  // guard so it runs server-side/in tests too). Guests/solo never broadcast.
  if (inRoom() && amHost()) broadcastState();
  if (typeof document === 'undefined') return;
  syncCreditsToStack(); // keep your real credits mirroring your seat's chips
  pokerSounds();        // play table SFX off state transitions (host/guest/solo alike)
  const area=document.getElementById('holdem-area'); if(!area) return;
  // Defensive: never let a malformed state (e.g. a bad sync) blow away the window.
  if(!G || !Array.isArray(G.seats)){ return; }
  if(!Array.isArray(G.board)) G.board=[]; if(!Array.isArray(G.winners)) G.winners=[];
  area.innerHTML='';
  const table=el('div','pk-table');
  const center=el('div','pk-center');
  center.appendChild(el('div','pk-pot','Pot '+(G.pot||0)+' 🪙'));
  const board=el('div','pk-board');
  G.board.forEach(c=>board.appendChild(cardEl(c,false)));
  for(let k=G.board.length;k<5;k++) board.appendChild(el('div','pk-card pk-empty'));
  center.appendChild(board);
  table.appendChild(center);
  POS.forEach((p,i)=>table.appendChild(seatEl(i,p)));
  area.appendChild(table);
  area.appendChild(el('div','pk-msg', esc(G.msg)));
  area.appendChild(buildControls());
}
function seatEl(i,p){
  const s=G.seats[i]; const d=el('div','pk-seat'); d.style.left=p.x+'%'; d.style.top=p.y+'%';
  if(!s){
    const btns=el('div','pk-seatbtns');
    const b=el('button','win95-btn pk-sit','Sit'); b.onclick=()=>sitYou(i); btns.appendChild(b);
    if(canManageBots()){ const ab=el('button','win95-btn pk-addbot','+ Bot'); ab.title='Add a bot here'; ab.onclick=()=>addBotAt(i); btns.appendChild(ab); }
    d.appendChild(btns); return d;
  }
  if(isMine(s)) d.classList.add('you'); if(s.folded) d.classList.add('folded'); if(G.turn===i) d.classList.add('turn');
  if(G.winners.some(w=>w.idx===i)) d.classList.add('winner');
  const cards=el('div','pk-hole'); const showFace=isMine(s)||G.street==='showdown';
  // own cards may arrive privately (broadcast strips them); fall back to _myHole
  let hole=s.hole && s.hole.length ? s.hole : (isMine(s) && _myHole && _myHole.length ? _myHole : []);
  if(s.inHand){ const hh=hole.length?hole:[null,null]; hh.forEach(c=>cards.appendChild((c&&showFace)?cardEl(c,false):cardEl(null,true))); }
  d.appendChild(cards);
  d.appendChild(el('div','pk-name', esc(s.name)+(G.dealer===i?' <span class="pk-dealer">D</span>':'')));
  d.appendChild(el('div','pk-stack', s.stack+' 🪙'+(s.allIn?' · ALL-IN':'')));
  if(s.bet>0) d.appendChild(el('div','pk-bet', String(s.bet)));
  if(isMine(s) && (G.street==='idle'||G.street==='showdown')){ const lv=el('button','win95-btn pk-stand','Stand'); lv.onclick=()=>standYou(i); d.appendChild(lv); }
  // Table manager (solo player or room host) can kick a bot between hands.
  if(s.isCpu && canManageBots() && (G.street==='idle'||G.street==='showdown')){ const k=el('button','pk-kick','✕'); k.title='Kick bot'; k.onclick=()=>kickBot(i); d.appendChild(k); }
  return d;
}
function buildControls(){
  const bar=el('div','pk-controls'); const youIdx=G.seats.findIndex(isMine);
  if(G.street==='idle'||G.street==='showdown'){
    if(youIdx<0){ bar.appendChild(el('div','pk-wait','Take a seat to play.')); return bar; }
    if(inRoom() && !amHost()){ bar.appendChild(el('div','pk-wait','Waiting for the host to deal…')); return bar; }
    const deal=el('button','win95-btn','Deal'); deal.onclick=()=>{ ensureOpponents(); startHand(); }; bar.appendChild(deal);
    return bar;
  }
  if(youIdx<0 || G.turn!==youIdx){ bar.appendChild(el('div','pk-wait', G.turn>=0?('Waiting for '+esc(seatName(G.turn))+'…'):'Dealing…')); return bar; }
  const L=legal(youIdx);
  const fold=el('button','win95-btn','Fold'); fold.onclick=()=>act('fold'); bar.appendChild(fold);
  const cc=el('button','win95-btn', L.canCheck?'Check':('Call '+L.callAmt)); cc.onclick=()=>act(L.canCheck?'check':'call'); bar.appendChild(cc);
  if(L.canRaise){
    const sl=document.createElement('input'); sl.type='range'; sl.min=L.minRaiseTo; sl.max=L.maxRaiseTo; sl.step=G.bb;
    sl.value=Math.min(L.maxRaiseTo, Math.max(L.minRaiseTo, Math.round((G.pot||G.bb)/G.bb)*G.bb)); sl.className='pk-slider';
    const lbl=el('span','pk-raise-amt', String(sl.value)); sl.oninput=()=>{ lbl.textContent=sl.value; };
    const raise=el('button','win95-btn','Raise to'); raise.onclick=()=>act('raiseTo', +sl.value);
    const allin=el('button','win95-btn','All-in'); allin.onclick=()=>act('raiseTo', L.maxRaiseTo);
    bar.appendChild(sl); bar.appendChild(lbl); bar.appendChild(raise); bar.appendChild(allin);
  }
  return bar;
}
function sfx(n){ try { if (typeof window !== 'undefined' && window.pokerSfx) window.pokerSfx(n); } catch(e){} }
// Drive table sounds off state transitions so every client (host, guests, solo)
// hears the same thing from its own render. Diffed against the previous frame.
let _pkPrev = null;
function pokerSounds(){
  if (typeof window === 'undefined' || !window.pokerSfx || !G) return;
  const me = mySeatIdx();
  const cur = {
    street: G.street, boardLen: (G.board||[]).length, pot: G.pot||0, turn: G.turn,
    showdown: G.street === 'showdown',
    iWon: (G.winners||[]).some(w => w.idx === me),
  };
  const p = _pkPrev; _pkPrev = cur;
  if (!p) return;                                                   // first frame: just set baseline
  const freshDeal = p.street === 'idle' && cur.street === 'preflop';
  if (cur.boardLen > p.boardLen) sfx('card');                       // a community card hit the board
  else if (freshDeal) sfx('deal');                                  // a new hand was dealt
  if (cur.pot > p.pot && !freshDeal) sfx('chip');                   // chips went into the pot
  if (cur.showdown && !p.showdown) sfx(cur.iWon ? 'win' : 'card');  // showdown reveal
  if (cur.turn === me && me >= 0 && p.turn !== me && !cur.showdown && cur.street !== 'idle') sfx('turn');
}
function act(a, amt){
  if (a === 'fold') sfx('fold'); else if (a === 'check') sfx('check'); // instant feedback on your own action
  if (inRoom() && !amHost()) {
    if (window.pokerSendAction) {
      const msg = { type:'action', action:a };
      if (amt != null) msg.amount = amt;   // never send undefined — Firebase rejects it (the call/check/fold bug)
      window.pokerSendAction(msg);
    }
    return;
  }
  const i = mySeatIdx(); if (i >= 0) applyAction(i, a, amt);
}
function ensureOpponents(){ if(inRoom()) return; if(activeIdx().length<2){ for(const i of [2,3,4]){ if(!G.seats[i]) addCpu(i); } } }
function seedTable(){ addCpu(2); addCpu(3); addCpu(4); }

/* ---- multiplayer sync -------------------------------------------------- */
let _myHole = null; // this client's own hole cards, delivered privately by the host
const EMPTY_SEAT = '_'; // sentinel for an empty seat (see serializeForBroadcast)

// Publish state minus the deck (no undealt cards) and minus every seat's hole
// cards except revealed hands at showdown. Each player's own hole is delivered
// privately via pokerSetHoles → poker/hole/{ownerId}.
//
// Firebase RTDB drops nulls/empty arrays and turns a sparse array (our 6 seats
// with gaps) into an object — which would crash the receiver's render(). To
// survive the round-trip we keep the seats array DENSE (empty seats become a
// string sentinel) and always send board/winners as arrays; normalizeState()
// undoes all of this on the way in.
function serializeForBroadcast(g){
  const { deck, ...rest } = g;
  rest.seats = g.seats.map(s => {
    if (!s) return EMPTY_SEAT;
    const reveal = g.street === 'showdown' && s.inHand && !s.folded;
    return { ...s, hole: reveal ? (s.hole || []) : [] };
  });
  rest.board = g.board || [];
  rest.winners = g.winners || [];
  return rest;
}
// Rebuild a well-formed game from whatever Firebase handed back (array, object,
// missing keys, dropped empties). Always returns a length-NSEATS seats array.
function normalizeState(s){
  if (!s || typeof s !== 'object') return null;
  const seats = new Array(NSEATS).fill(null);
  const raw = s.seats;
  const put = (i, v) => { if (i >= 0 && i < NSEATS && v && v !== EMPTY_SEAT && typeof v === 'object') seats[i] = Object.assign({}, v, { hole: Array.isArray(v.hole) ? v.hole : [] }); };
  if (Array.isArray(raw)) raw.forEach((v, i) => put(i, v));
  else if (raw && typeof raw === 'object') Object.keys(raw).forEach(k => put(+k, raw[k]));
  s.seats = seats;
  s.board = Array.isArray(s.board) ? s.board : [];
  s.winners = Array.isArray(s.winners) ? s.winners : [];
  s.deck = [];
  return s;
}
function broadcastState(){ if (typeof window !== 'undefined' && window.pokerBroadcast) window.pokerBroadcast(serializeForBroadcast(G)); }
// Host pushes each in-hand player their own hole cards on a private path.
function publishHoles(){
  if (!(inRoom() && amHost() && typeof window !== 'undefined' && window.pokerSetHoles)) return;
  const map = {};
  for (const i of inHandIdx()) { const s = G.seats[i]; if (s && s.ownerId) map[s.ownerId] = s.hole; }
  window.pokerSetHoles(map);
}

function hostSeat(userId, idx, name, buyin){
  if (idx == null || idx < 0 || idx >= NSEATS || G.seats[idx]) return;        // seat taken/invalid
  if (G.seats.some(s => s && s.ownerId === userId)) return;                    // already seated
  G.seats[idx] = newSeat({ name: name || 'Player', ownerId: userId, stack: Math.max(0, buyin | 0) });
}
function hostStand(userId){
  const i = G.seats.findIndex(s => s && s.ownerId === userId);
  if (i < 0) return; const s = G.seats[i];
  if (s.inHand && !s.folded && G.street !== 'idle' && G.street !== 'showdown') return; // can't leave mid-hand
  G.seats[i] = null;
}
// Guest: replace local state from the host's broadcast and render.
function onPokerState(s){
  if (amHost()) return;                 // host is authoritative
  const ns = normalizeState(s);         // repair Firebase's array/null coercion
  if (!ns) return;
  G = ns;
  render();
}
// Guest: receive own hole cards privately (host wrote poker/hole/{myId}).
function onPokerHole(hole){ _myHole = Array.isArray(hole) ? hole : null; render(); }

// A guest promoted to host can't continue a hand it has no deck for, so abort
// the in-progress hand (refunding this hand's contributions) back to idle.
function abortHand(){
  if (!G) return;
  for (const s of G.seats) { if (!s) continue; s.stack += (s.contrib || 0); s.bet = 0; s.contrib = 0; s.folded = false; s.allIn = false; s.inHand = false; s.acted = false; s.hole = []; }
  G.pot = 0; G.board = []; G.street = 'idle'; G.turn = -1; G.winners = [];
  G.msg = 'Host changed — hand reset. Deal again.';
  render();
}
function onPokerBecomeHost(){
  if (!G) return;
  if (G.street !== 'idle' && G.street !== 'showdown') abortHand();
  else render(); // re-publish current idle state as the new authority
}
// Host: validate + apply a queued guest action, then render (which broadcasts).
function onPokerAction(a){
  if (!amHost() || !G || !a) return;
  if (a.type === 'sit') hostSeat(a.userId, a.seat, a.name, a.buyin);
  else if (a.type === 'stand') hostStand(a.userId);
  else if (a.type === 'action') {
    const i = G.seats.findIndex(s => s && s.ownerId === a.userId);
    if (i >= 0 && G.turn === i) { applyAction(i, a.action, a.amount); return; } // applyAction renders/broadcasts
  }
  render();
}

/* ---- entry ------------------------------------------------------------- */
let _pkInit=false;
function openHoldem(show=true){
  const w=document.getElementById('holdem-wrap'); if(!w) return;
  if(show===false){ w.classList.remove('open'); w.style.display='none'; return; }
  w.classList.add('open'); w.style.display='flex';
  if(window.OS&&window.OS.register){ window.OS.register('holdem'); window.OS.focus('holdem'); }
  if(!_pkInit){ _pkInit=true; G=emptyGame(); if(!inRoom()){ seedTable(); G.solo=true; } }
  else if(inRoom() && G && G.solo){ G=emptyGame(); } // drop a leftover solo table when entering a room (keeps room bots)
  render();
}
if (typeof window !== 'undefined') {
  window.openHoldem = openHoldem;
  window.onPokerState = onPokerState;
  window.onPokerAction = onPokerAction;
  window.onPokerHole = onPokerHole;
  window.onPokerBecomeHost = onPokerBecomeHost;
  window.AquaPoker = { _state: ()=>G, _eval5: eval5, _best7: best7, _sidePots: buildSidePots };
}
// node-testable engine handle (no effect in the browser bundle)
export const _engine = { eval5, best7, cmpHand, makeDeck, emptyGame, newSeat, addCpu, addBotAt, kickBot, canManageBots, sit: sitYou, stand: standYou, act, startHand, applyAction, legal, buildSidePots, onPokerState, onPokerAction, onPokerHole, onPokerBecomeHost, abortHand, hostSeat, serializeForBroadcast, getMyHole: () => _myHole, setG: g => { G = g; }, getG: () => G };

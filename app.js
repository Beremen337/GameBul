'use strict';
/* =========================================================================
   ОКОЛЕСИЦА — party-игра для друзей. Чистый P2P (WebRTC через PeerJS),
   без бэкенда: сайт можно выложить как статику на GitHub Pages.
   Один игрок ("хост") держит состояние партии и рассылает его остальным.
   ========================================================================= */

/* ---------------------------- КОНСТАНТЫ ---------------------------- */

const ROOM_PREFIX = 'okolesitsa-v1-';
const CANVAS_W = 800, CANVAS_H = 600;
const ROUND_TYPES = ['phrase', 'draw', 'meme'];
const MIN_PLAYERS = 3, MAX_PLAYERS = 8;

const AVATARS = ['🦊','🐸','🐙','🦄','🐼','🐵','🦖','🐝','🦥','🐳','🦩','🐨','🐷','🐢'];

const INSPIRE = [
  'Пингвин, который устал быть милым',
  'Тайное собрание офисных степлеров',
  'Бабушка учится дрифтовать',
  'Кот, укравший чужую личность',
  'Инопланетянин на техническом собеседовании',
  'Йога для холодильников',
  'Свадьба двух носков из разных пар',
  'Медведь сдаёт экзамен по вождению',
  'Заговор комнатных растений',
  'Экскурсия по внутренностям пылесоса',
  'Собеседование в подземный офис',
  'Улитка опаздывает на важную встречу',
  'Драка двух облаков за парковочное место',
  'Робот-пылесос ушёл в монастырь',
  'Тайная жизнь носков в стиральной машине',
  'Директор зоопарка просит прибавку у жирафа',
  'Суп, который считает себя супергероем',
  'Вторая жизнь сломанного зонтика',
];

const REACTIONS = ['😂','🔥','💀','👏','🤡','😱','❤️'];
const COLORS = ['#141414', '#ff5d5d', '#4fb6e8', '#ffc93c', '#6ec897', '#a081e0'];

const ROUND_LABELS = { phrase: 'Фраза', draw: 'Рисунок', meme: 'Мем' };

/* ---------------------------- УТИЛИТЫ ---------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------------------------- ЛОКАЛЬНОЕ СОСТОЯНИЕ ---------------------------- */

const S = {
  myId: null,
  myName: '',
  myEmoji: AVATARS[0],
  isHost: false,
  roomCode: null,
  currentTask: null,   // задача текущего раунда (для этого игрока)
  submitted: false,
  timerInterval: null,
  drawApi: null,       // API канваса рисования текущего раунда
};

/* ---------------------------- СЕТЬ (PeerJS) ---------------------------- */

const Net = {
  peer: null,
  conns: {},        // (только на хосте) id клиента -> DataConnection
  hostConn: null,    // (только на клиенте) DataConnection к хосту

  /** Хост создаёт комнату с коротким кодом. */
  createRoom(code) {
    return new Promise((resolve, reject) => {
      const fullId = ROOM_PREFIX + code;
      const peer = new Peer(fullId, {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com:3478' }
    ]
  }
});
      let settled = false;
      peer.on('open', (id) => {
        settled = true;
        this.peer = peer;
        peer.on('connection', (conn) => this._wireIncoming(conn));
        peer.on('error', (err) => this._onPeerError(err));
        resolve(id);
      });
      peer.on('error', (err) => {
        if (!settled) reject(err);
        else this._onPeerError(err);
      });
    });
  },

  /** Клиент подключается к комнате по коду. */
  joinRoom(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ debug: 0 });
      peer.on('open', () => {
        const conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'json' });
        let done = false;
        conn.on('open', () => {
          done = true;
          this.peer = peer;
          this.hostConn = conn;
          conn.on('data', (data) => Client.handleHostMsg(data));
          conn.on('close', () => Client.onHostLost());
          resolve(peer.id);
        });
        conn.on('error', (err) => { if (!done) reject(err); });
        peer.on('error', (err) => { if (!done) reject(err); });
        setTimeout(() => { if (!done) reject(new Error('timeout')); }, 12000);
      });
      peer.on('error', (err) => reject(err));
    });
  },

  _wireIncoming(conn) {
    conn.on('open', () => { this.conns[conn.peer] = conn; });
    conn.on('data', (data) => Host.handleClientMsg(conn.peer, data));
    conn.on('close', () => { delete this.conns[conn.peer]; Host.onPeerLeave(conn.peer); });
    conn.on('error', () => { delete this.conns[conn.peer]; Host.onPeerLeave(conn.peer); });
  },

  _onPeerError(err) {
    console.warn('peer error', err && err.type, err);
  },

  /** Хост -> конкретному игроку (или себе — тогда рендерим локально). */
  sendTo(id, msg) {
    if (id === S.myId) { Client.handleHostMsg(msg); return; }
    const c = this.conns[id];
    if (c && c.open) c.send(msg);
  },

  /** Хост -> все игроки. */
  broadcast(msg) {
    Object.keys(this.conns).forEach((id) => { if (this.conns[id].open) this.conns[id].send(msg); });
    Client.handleHostMsg(msg); // хост сам себе — та же логика рендера
  },

  /** Клиент -> хост. Если мы и есть хост — вызываем обработчик напрямую. */
  sendToHost(msg) {
    if (S.isHost) { Host.handleClientMsg(S.myId, msg); return; }
    if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  },
};

/* ---------------------------- ХОСТ: игровой движок ---------------------------- */

const Host = {
  players: [],       // {id, name, emoji, active}
  settings: { phrase: 45, draw: 75, meme: 45 },
  phase: 'lobby',    // lobby | playing | reveal | voting | results
  order: [],         // фиксированный порядок id на партию
  chains: [],
  round: 0,
  totalRounds: 0,
  pending: {},
  revealChain: 0,
  revealEntry: 0,
  votes: {},
  roundTimer: null,

  init(id, name, emoji) {
    this.players = [{ id, name, emoji, active: true }];
    this.phase = 'lobby';
  },

  addPlayer(id, name, emoji) {
    if (this.players.some((p) => p.id === id)) return;
    if (this.players.length >= MAX_PLAYERS) { Net.sendTo(id, { t: 'toast', msg: 'Комната заполнена (максимум 8 игроков).' }); return; }
    this.players.push({ id, name: name || 'Игрок', emoji: emoji || '❓', active: true });
  },

  onPeerLeave(id) {
    const p = this.players.find((pl) => pl.id === id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((pl) => pl.id !== id);
    } else {
      p.active = false;
      if (this.phase === 'playing' && this.pending[id] === undefined) {
        this.pending[id] = null; // синтезируем заглушку при подведении итога раунда
        this._maybeFinishRound();
      }
    }
    this.broadcastLobby();
  },

  broadcastLobby() {
    Net.broadcast({
      t: 'lobby',
      players: this.players.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, active: p.active })),
      settings: this.settings,
      hostId: this.players[0] ? this.players[0].id : null,
      canStart: this.players.length >= MIN_PLAYERS,
    });
  },

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    this.broadcastLobby();
  },

  handleClientMsg(fromId, msg) {
    switch (msg.t) {
      case 'join':
        this.addPlayer(fromId, msg.name, msg.emoji);
        this.broadcastLobby();
        break;
      case 'submit':
        this._onSubmit(fromId, msg.round, msg.payload);
        break;
      case 'reaction':
        Net.broadcast({ t: 'reactionFx', emoji: msg.emoji });
        break;
      case 'vote':
        this._onVote(fromId, msg.chainIndex);
        break;
      default:
        break;
    }
  },

  nameOf(id) {
    const p = this.players.find((pl) => pl.id === id);
    return p ? p.name : '???';
  },

  /* ---------- запуск партии ---------- */

  startGame() {
    const active = this.players.filter((p) => p.active !== false);
    if (active.length < MIN_PLAYERS) return;
    this.order = shuffle(active.map((p) => p.id));
    const n = this.order.length;
    this.chains = Array.from({ length: n }, () => []);
    this.round = 0;
    this.totalRounds = n;
    this.pending = {};
    this.phase = 'playing';
    this._startRound();
  },

  _durationFor(type) {
    return this.settings[type] || 45;
  },

  _chainIndexFor(playerIndex, round) {
    const n = this.order.length;
    return ((playerIndex - round) % n + n) % n;
  },

  _startRound() {
    this.pending = {};
    const type = ROUND_TYPES[this.round % 3];
    const durSec = this._durationFor(type);
    const deadline = Date.now() + durSec * 1000;

    this.order.forEach((pid, idx) => {
      const chainIdx = this._chainIndexFor(idx, this.round);
      const prev = this.round === 0 ? null : this.chains[chainIdx][this.round - 1];
      Net.sendTo(pid, {
        t: 'roundStart',
        task: {
          round: this.round,
          totalRounds: this.totalRounds,
          type,
          prev,
          deadline,
        },
      });
    });

    this._broadcastProgress();

    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this._finishRound(), durSec * 1000 + 2500);
  },

  _activeIds() {
    return this.order.filter((id) => {
      const p = this.players.find((pl) => pl.id === id);
      return p && p.active !== false;
    });
  },

  _onSubmit(fromId, round, payload) {
    if (this.phase !== 'playing' || round !== this.round) return;
    if (this.pending[fromId] !== undefined) return;
    this.pending[fromId] = payload;
    this._broadcastProgress();
    this._maybeFinishRound();
  },

  _maybeFinishRound() {
    const active = this._activeIds();
    const done = active.every((id) => this.pending[id] !== undefined);
    if (done) { clearTimeout(this.roundTimer); this._finishRound(); }
  },

  _broadcastProgress() {
    const active = this._activeIds();
    const done = active.filter((id) => this.pending[id] !== undefined).length;
    Net.broadcast({ t: 'progress', done, total: active.length });
  },

  _placeholder(type) {
    if (type === 'phrase') return { text: '(тут была тишина)' };
    if (type === 'draw') return { strokes: [] };
    return { top: '...', bottom: '(никто не успел)' };
  },

  _finishRound() {
    const type = ROUND_TYPES[this.round % 3];
    this.order.forEach((pid, idx) => {
      const chainIdx = this._chainIndexFor(idx, this.round);
      const raw = this.pending[pid];
      const placeholder = raw === undefined || raw === null;
      this.chains[chainIdx].push({
        type,
        authorId: pid,
        authorName: this.nameOf(pid),
        content: placeholder ? this._placeholder(type) : raw,
        placeholder,
      });
    });
    this.round++;
    if (this.round < this.totalRounds) this._startRound();
    else this._startReveal();
  },

  /* ---------- показ историй ---------- */

  _startReveal() {
    this.phase = 'reveal';
    this.revealChain = 0;
    this.revealEntry = 0;
    this._broadcastReveal();
  },

  _broadcastReveal() {
    const chain = this.chains[this.revealChain];
    Net.broadcast({
      t: 'revealState',
      chainIndex: this.revealChain,
      totalChains: this.chains.length,
      entryIndex: this.revealEntry,
      chainLength: chain.length,
      entry: chain[this.revealEntry],
    });
  },

  revealNext() {
    const chain = this.chains[this.revealChain];
    if (this.revealEntry < chain.length - 1) { this.revealEntry++; this._broadcastReveal(); return; }
    if (this.revealChain < this.chains.length - 1) { this.revealChain++; this.revealEntry = 0; this._broadcastReveal(); return; }
    this._startVoting();
  },

  revealPrev() {
    if (this.revealEntry > 0) { this.revealEntry--; this._broadcastReveal(); return; }
    if (this.revealChain > 0) { this.revealChain--; this.revealEntry = this.chains[this.revealChain].length - 1; this._broadcastReveal(); }
  },

  /* ---------- голосование ---------- */

  _startVoting() {
    this.phase = 'voting';
    this.votes = {};
    const options = this.chains.map((c, i) => ({
      index: i,
      title: (c[0] && c[0].content && c[0].content.text) || '???',
      firstAuthorId: c[0] ? c[0].authorId : null,
      firstAuthorName: c[0] ? c[0].authorName : '???',
    }));
    Net.broadcast({ t: 'voteState', options });
    clearTimeout(this.voteTimer);
    this.voteTimer = setTimeout(() => { if (this.phase === 'voting') this._finishVoting(); }, 45000);
  },

  _onVote(fromId, chainIndex) {
    if (this.phase !== 'voting') return;
    this.votes[fromId] = chainIndex;
    const active = this._activeIds();
    const done = Object.keys(this.votes).length;
    Net.broadcast({ t: 'voteProgress', done, total: active.length });
    if (active.every((id) => this.votes[id] !== undefined)) { clearTimeout(this.voteTimer); this._finishVoting(); }
  },

  _finishVoting() {
    clearTimeout(this.voteTimer);
    const tally = this.chains.map(() => 0);
    Object.values(this.votes).forEach((ci) => { if (tally[ci] !== undefined) tally[ci]++; });
    const ranking = this.chains
      .map((c, i) => ({ index: i, votes: tally[i], firstAuthorName: c[0] ? c[0].authorName : '???' }))
      .sort((a, b) => b.votes - a.votes);
    this.phase = 'results';
    Net.broadcast({ t: 'results', ranking });
  },

  playAgain() {
    this.phase = 'lobby';
    this.chains = [];
    this.round = 0;
    this.broadcastLobby();
  },
};

/* ---------------------------- КЛИЕНТ: рендер экранов ---------------------------- */

const Client = {
  latestLobby: null,

  handleHostMsg(msg) {
    switch (msg.t) {
      case 'lobby': this.renderLobby(msg); break;
      case 'roundStart': this.renderRound(msg.task); break;
      case 'progress': this.renderProgress(msg); break;
      case 'revealState': this.renderReveal(msg); break;
      case 'reactionFx': this.spawnReactionFx(msg.emoji); break;
      case 'voteState': this.renderVote(msg); break;
      case 'voteProgress': $('#vote-status').textContent = `Проголосовали: ${msg.done}/${msg.total}`; break;
      case 'results': this.renderResults(msg); break;
      case 'toast': toast(msg.msg); break;
      default: break;
    }
  },

  onHostLost() {
    toast('Связь с хостом потеряна. Обновите страницу, чтобы начать заново.', 6000);
  },

  /* ---------- лобби ---------- */

  renderLobby(msg) {
    this.latestLobby = msg;
    showScreen('screen-lobby');
    $('#room-code-display').textContent = S.roomCode || '----';

    const list = $('#player-list');
    list.innerHTML = msg.players.map((p) => `
      <li>
        <span class="p-emoji">${p.emoji}</span>
        <span>${escapeHtml(p.name)}${p.id === S.myId ? ' (ты)' : ''}</span>
        ${p.id === msg.hostId ? '<span class="p-tag">хост</span>' : ''}
        ${p.active === false ? '<span class="p-tag">отключился</span>' : ''}
      </li>
    `).join('');

    $('#host-settings').classList.toggle('hidden', !S.isHost);
    $('#lobby-waiting').classList.toggle('hidden', S.isHost);

    if (S.isHost) {
      $('#slider-write').value = msg.settings.phrase;
      $('#slider-draw').value = msg.settings.draw;
      $('#slider-meme').value = msg.settings.meme;
      $('#val-write').textContent = msg.settings.phrase;
      $('#val-draw').textContent = msg.settings.draw;
      $('#val-meme').textContent = msg.settings.meme;
      const btn = $('#btn-start');
      btn.disabled = !msg.canStart;
      btn.textContent = msg.canStart ? `Начать игру (${msg.players.length} игроков)` : 'Нужно хотя бы 3 игрока';
    }
  },

  /* ---------- раунд ---------- */

  renderRound(task) {
    S.currentTask = task;
    S.submitted = false;
    showScreen('screen-round');
    $('#waiting-overlay').classList.add('hidden');
    $('#submit-row').classList.remove('hidden');
    $('#round-label').textContent = `Раунд ${task.round + 1} / ${task.totalRounds} · ${ROUND_LABELS[task.type]}`;
    $('#round-progress-bar').style.width = `${Math.round(((task.round) / task.totalRounds) * 100)}%`;

    const area = $('#task-area');
    area.innerHTML = '';
    S.drawApi = null;

    if (task.type === 'phrase' && !task.prev) {
      area.appendChild(this._buildStartPhraseUI());
    } else if (task.type === 'phrase' && task.prev) {
      area.appendChild(this._buildReactPhraseUI(task.prev));
    } else if (task.type === 'draw') {
      area.appendChild(this._buildDrawUI(task.prev));
    } else if (task.type === 'meme') {
      area.appendChild(this._buildMemeUI(task.prev));
    }

    this._startTimer(task.deadline);
  },

  _buildStartPhraseUI() {
    const wrap = document.createElement('div');
    wrap.className = 'task-area';
    wrap.innerHTML = `
      <div class="prompt-card">
        <p class="prompt-label">Новая история</p>
        <p class="prompt-text">Напиши любую смешную или странную фразу — её будут рисовать вслепую.</p>
      </div>
      <button type="button" class="btn btn-secondary inspire-btn" id="btn-inspire">🎲 Подкинь идею</button>
      <textarea id="input-phrase" class="big-textarea" maxlength="140" placeholder="Например: жираф, который боится высоты"></textarea>
    `;
    wrap.querySelector('#btn-inspire').addEventListener('click', () => {
      wrap.querySelector('#input-phrase').value = INSPIRE[Math.floor(Math.random() * INSPIRE.length)];
    });
    return wrap;
  },

  _buildReactPhraseUI(prev) {
    const wrap = document.createElement('div');
    wrap.className = 'task-area';
    wrap.innerHTML = `
      <div class="prompt-card">
        <p class="prompt-label">Мем от ${escapeHtml(prev.authorName)}</p>
        <p class="prompt-text">${escapeHtml(prev.content.top)}</p>
        <p class="prompt-text">${escapeHtml(prev.content.bottom)}</p>
      </div>
      <textarea id="input-phrase" class="big-textarea" maxlength="140" placeholder="Опиши одной фразой, что вообще происходит"></textarea>
    `;
    return wrap;
  },

  _buildDrawUI(prev) {
    const wrap = document.createElement('div');
    wrap.className = 'task-area';
    wrap.innerHTML = `
      <div class="prompt-card">
        <p class="prompt-label">Нарисуй фразу от ${escapeHtml(prev.authorName)}</p>
        <p class="prompt-text">${escapeHtml(prev.content.text)}</p>
      </div>
      <div class="canvas-wrap">
        <canvas id="draw-canvas" class="draw-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
      </div>
      <div class="tool-row" id="tool-row"></div>
    `;
    const canvas = wrap.querySelector('#draw-canvas');
    const api = setupDrawCanvas(canvas);
    S.drawApi = api;

    const toolRow = wrap.querySelector('#tool-row');
    COLORS.forEach((c, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot' + (i === 0 ? ' selected' : '');
      dot.style.background = c;
      dot.addEventListener('click', () => {
        toolRow.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('selected'));
        dot.classList.add('selected');
        api.setColor(c);
      });
      toolRow.appendChild(dot);
    });
    const spacer = document.createElement('div');
    spacer.className = 'tool-spacer';
    toolRow.appendChild(spacer);
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button'; undoBtn.className = 'btn btn-ghost btn-small'; undoBtn.style.color = '#1c1a15'; undoBtn.style.borderColor = '#1c1a15';
    undoBtn.textContent = '↩️ Отменить';
    undoBtn.addEventListener('click', () => api.undo());
    toolRow.appendChild(undoBtn);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button'; clearBtn.className = 'btn btn-ghost btn-small'; clearBtn.style.color = '#1c1a15'; clearBtn.style.borderColor = '#1c1a15';
    clearBtn.textContent = '🗑 Очистить';
    clearBtn.addEventListener('click', () => api.clear());
    toolRow.appendChild(clearBtn);

    return wrap;
  },

  _buildMemeUI(prev) {
    const wrap = document.createElement('div');
    wrap.className = 'task-area';
    wrap.innerHTML = `
      <p class="prompt-label">Сделай мем из рисунка ${escapeHtml(prev.authorName)}а</p>
      <div class="meme-canvas-wrap">
        <canvas id="meme-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
        <div class="meme-cap top" id="cap-top"></div>
        <div class="meme-cap bottom" id="cap-bottom"></div>
      </div>
      <div class="meme-inputs">
        <input id="input-top" type="text" maxlength="60" placeholder="Верхняя надпись (необязательно)">
        <input id="input-bottom" type="text" maxlength="60" placeholder="Нижняя надпись">
      </div>
    `;
    const canvas = wrap.querySelector('#meme-canvas');
    renderStrokesToCanvas(canvas, prev.content.strokes || []);
    const top = wrap.querySelector('#input-top');
    const bottom = wrap.querySelector('#input-bottom');
    const capTop = wrap.querySelector('#cap-top');
    const capBottom = wrap.querySelector('#cap-bottom');
    top.addEventListener('input', () => { capTop.textContent = top.value; });
    bottom.addEventListener('input', () => { capBottom.textContent = bottom.value; });
    return wrap;
  },

  _startTimer(deadline) {
    clearInterval(S.timerInterval);
    const totalMs = Math.max(1, deadline - Date.now());
    const startTotal = totalMs;
    const ring = $('#timer-ring-fg');
    const CIRC = 107; // 2*pi*17
    const tick = () => {
      const remain = deadline - Date.now();
      const secs = Math.max(0, Math.ceil(remain / 1000));
      $('#timer-num').textContent = secs;
      const frac = Math.max(0, Math.min(1, remain / startTotal));
      ring.style.strokeDashoffset = String(CIRC * (1 - frac));
      ring.style.stroke = secs <= 10 ? 'var(--coral)' : 'var(--yellow)';
      if (remain <= 0) {
        clearInterval(S.timerInterval);
        if (!S.submitted) this.submitCurrent(true);
      }
    };
    tick();
    S.timerInterval = setInterval(tick, 200);
  },

  submitCurrent(auto) {
    if (S.submitted || !S.currentTask) return;
    S.submitted = true;
    clearInterval(S.timerInterval);
    const task = S.currentTask;
    let payload;
    if (task.type === 'draw') {
      payload = { strokes: S.drawApi ? S.drawApi.getStrokes() : [] };
    } else if (task.type === 'meme') {
      const top = $('#input-top'); const bottom = $('#input-bottom');
      payload = { top: top ? top.value.trim() : '', bottom: bottom ? (bottom.value.trim() || '...') : '...' };
    } else {
      const ta = $('#input-phrase');
      payload = { text: (ta ? ta.value.trim() : '') || (auto ? '...' : '') };
    }
    Net.sendToHost({ t: 'submit', round: task.round, payload });
    $('#submit-row').classList.add('hidden');
    $('#waiting-overlay').classList.remove('hidden');
    $('#waiting-text').textContent = auto ? 'Время вышло! Ждём остальных…' : 'Сдано! Ждём остальных…';
  },

  renderProgress(msg) {
    $('#waiting-count').textContent = `${msg.done} / ${msg.total} сдали`;
  },

  /* ---------- показ историй ---------- */

  renderReveal(msg) {
    showScreen('screen-reveal');
    $('#reveal-chain-label').textContent = `История ${msg.chainIndex + 1} / ${msg.totalChains}`;
    $('#reveal-step-label').textContent = `Шаг ${msg.entryIndex + 1} / ${msg.chainLength}`;

    const stage = $('#reveal-stage');
    stage.innerHTML = '';
    const entry = msg.entry;
    const card = document.createElement('div');
    card.className = 'reveal-card';

    if (!entry) {
      card.innerHTML = '<p class="reveal-phrase">…</p>';
    } else if (entry.type === 'phrase') {
      card.innerHTML = `
        <p class="reveal-author">${escapeHtml(entry.authorName)} написал(а)${entry.placeholder ? ' (не успел(а))' : ''}</p>
        <p class="reveal-phrase">${escapeHtml(entry.content.text)}</p>
      `;
    } else if (entry.type === 'draw') {
      card.innerHTML = `
        <p class="reveal-author">${escapeHtml(entry.authorName)} нарисовал(а)${entry.placeholder ? ' (не успел(а))' : ''}</p>
        <canvas class="reveal-canvas"></canvas>
      `;
      requestAnimationFrame(() => {
        const c = card.querySelector('canvas');
        c.width = CANVAS_W; c.height = CANVAS_H;
        renderStrokesToCanvas(c, entry.content.strokes || []);
      });
    } else if (entry.type === 'meme') {
      card.innerHTML = `
        <p class="reveal-author">${escapeHtml(entry.authorName)} придумал(а) подпись${entry.placeholder ? ' (не успел(а))' : ''}</p>
        <div class="meme-canvas-wrap reveal-meme">
          <canvas></canvas>
          <div class="meme-cap top">${escapeHtml(entry.content.top || '')}</div>
          <div class="meme-cap bottom">${escapeHtml(entry.content.bottom || '')}</div>
        </div>
      `;
      requestAnimationFrame(() => {
        const c = card.querySelector('canvas');
        c.width = CANVAS_W; c.height = CANVAS_H;
        renderStrokesToCanvas(c, entry.sourceStrokes || []);
      });
    }
    stage.appendChild(card);

    const reactionBar = $('#reaction-bar');
    if (!reactionBar.childElementCount) {
      reactionBar.innerHTML = REACTIONS.map((e) => `<button type="button" class="reaction-btn" data-e="${e}">${e}</button>`).join('');
      reactionBar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.reaction-btn');
        if (!btn) return;
        Net.sendToHost({ t: 'reaction', emoji: btn.dataset.e });
      });
    }

    $('#host-reveal-nav').classList.toggle('hidden', !S.isHost);
    $('#btn-reveal-prev').disabled = (msg.chainIndex === 0 && msg.entryIndex === 0);
  },

  spawnReactionFx(emoji) {
    const layer = $('#reaction-fx-layer');
    const span = document.createElement('span');
    span.className = 'fx-emoji';
    span.textContent = emoji;
    span.style.left = `${10 + Math.random() * 80}%`;
    layer.appendChild(span);
    setTimeout(() => span.remove(), 1900);
  },

  /* ---------- голосование ---------- */

  renderVote(msg) {
    showScreen('screen-vote');
    $('#vote-status').textContent = '';
    const grid = $('#vote-grid');
    grid.innerHTML = '';
    let picked = false;
    msg.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-opt';
      const mine = opt.firstAuthorId === S.myId;
      btn.disabled = mine;
      btn.innerHTML = `«${escapeHtml(opt.title)}»<small>${mine ? 'твоя история' : `начал(а) ${escapeHtml(opt.firstAuthorName)}`}</small>`;
      btn.addEventListener('click', () => {
        if (picked || mine) return;
        picked = true;
        grid.querySelectorAll('.vote-opt').forEach((b) => { b.disabled = true; });
        btn.classList.add('picked');
        Net.sendToHost({ t: 'vote', chainIndex: opt.index });
        $('#vote-status').textContent = 'Голос учтён, ждём остальных…';
      });
      grid.appendChild(btn);
    });
  },

  /* ---------- результаты ---------- */

  renderResults(msg) {
    showScreen('screen-results');
    const podium = $('#podium');
    podium.innerHTML = '';
    const top3 = msg.ranking.slice(0, 3);
    const medalClass = ['gold', 'silver', 'bronze'];
    const medalIcon = ['🥇', '🥈', '🥉'];
    top3.forEach((r, i) => {
      const slot = document.createElement('div');
      slot.className = `podium-slot ${medalClass[i]}`;
      slot.innerHTML = `
        <div class="podium-medal">${medalIcon[i]}</div>
        <div class="podium-name">${escapeHtml(r.firstAuthorName)}</div>
        <div class="podium-votes">${r.votes} ${pluralVotes(r.votes)}</div>
      `;
      podium.appendChild(slot);
    });
    $('#btn-play-again').classList.toggle('hidden', !S.isHost);
  },
};

function pluralVotes(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'голос';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'голоса';
  return 'голосов';
}

/* ---------------------------- РИСОВАНИЕ ---------------------------- */

function setupDrawCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;
  let color = COLORS[0];
  let drawing = false;

  function clearWhite() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function redraw() {
    clearWhite();
    strokes.forEach((s) => paintStroke(ctx, s));
  }
  function posFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  }
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    current = { color, width: 6, points: [posFromEvent(e)] };
    strokes.push(current);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !current) return;
    current.points.push(posFromEvent(e));
    redraw();
  });
  const stop = () => { drawing = false; current = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointerleave', stop);
  canvas.addEventListener('pointercancel', stop);

  clearWhite();

  return {
    getStrokes: () => strokes,
    setColor: (c) => { color = c; },
    undo: () => { strokes.pop(); redraw(); },
    clear: () => { strokes = []; redraw(); },
  };
}

function paintStroke(ctx, stroke) {
  if (!stroke.points || stroke.points.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    ctx.beginPath();
    ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
    return;
  }
  ctx.beginPath();
  stroke.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.stroke();
}

function renderStrokesToCanvas(canvas, strokes) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  (strokes || []).forEach((s) => paintStroke(ctx, s));
}

/* ---------------------------- ПОДКЛЮЧЕНИЕ РЕВОЛВЕР-МЕМА К РИСУНКУ ----------------------------
   Ведущий хранит рисунок и подпись как отдельные шаги истории. Чтобы на экране показа
   истории под мемом снова появился тот же рисунок, хост при рассылке revealState
   подмешивает сырые strokes из предыдущего шага прямо в entry. Делается здесь,
   а не в Host, чтобы не раздувать сетевой трафик лишним состоянием. */
(function patchHostRevealForMemeSource() {
  const orig = Host._broadcastReveal.bind(Host);
  Host._broadcastReveal = function () {
    const chain = this.chains[this.revealChain];
    const entry = chain[this.revealEntry];
    if (entry && entry.type === 'meme' && this.revealEntry > 0) {
      const drawEntry = chain[this.revealEntry - 1];
      entry.sourceStrokes = (drawEntry && drawEntry.content && drawEntry.content.strokes) || [];
    }
    orig();
  };
})();

/* ---------------------------- ГЛАВНЫЙ ЭКРАН / НАВИГАЦИЯ ---------------------------- */

function initAvatarPicker() {
  const grid = $('#avatar-picker');
  grid.innerHTML = AVATARS.map((a, i) => `<button type="button" class="avatar-opt${i === 0 ? ' selected' : ''}" data-a="${a}">${a}</button>`).join('');
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.avatar-opt');
    if (!btn) return;
    grid.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    S.myEmoji = btn.dataset.a;
  });
}

function readNameOrWarn() {
  const name = $('#input-name').value.trim();
  if (!name) { $('#home-error').textContent = 'Введи своё имя, чтобы начать.'; return null; }
  return name.slice(0, 18);
}

async function createRoomFlow() {
  const name = readNameOrWarn();
  if (!name) return;
  S.myName = name;
  $('#btn-create').disabled = true;
  $('#home-error').textContent = '';
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      const id = await Net.createRoom(code);
      S.myId = id;
      S.isHost = true;
      S.roomCode = code;
      Host.init(id, S.myName, S.myEmoji);
      Host.broadcastLobby();
      history.replaceState(null, '', `?room=${code}`);
      return;
    } catch (err) {
      lastErr = err;
      if (err && err.type !== 'unavailable-id') break;
    }
  }
  $('#btn-create').disabled = false;
  $('#home-error').textContent = 'Не удалось создать комнату. Проверь интернет-соединение и попробуй ещё раз.';
  console.error(lastErr);
}

async function joinRoomFlow() {
  const name = readNameOrWarn();
  if (!name) return;
  const code = $('#input-code').value.trim().toUpperCase();
  if (code.length !== 4) { $('#home-error').textContent = 'Код комнаты состоит из 4 символов.'; return; }
  S.myName = name;
  $('#btn-join').disabled = true;
  $('#home-error').textContent = '';
  try {
    const id = await Net.joinRoom(code);
    S.myId = id;
    S.isHost = false;
    S.roomCode = code;
    Net.sendToHost({ t: 'join', name: S.myName, emoji: S.myEmoji });
    history.replaceState(null, '', `?room=${code}`);
  } catch (err) {
    console.error(err);
    $('#home-error').textContent = 'Не получилось найти комнату. Проверь код и интернет.';
  } finally {
    $('#btn-join').disabled = false;
  }
}

function wireHome() {
  initAvatarPicker();
  $('#btn-create').addEventListener('click', createRoomFlow);
  $('#btn-join').addEventListener('click', joinRoomFlow);
  $('#input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) $('#input-code').value = room.toUpperCase().slice(0, 4);
}

function wireLobby() {
  $('#btn-copy-link').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${S.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована!');
    } catch (_) {
      toast(url, 5000);
    }
  });

  const sliders = [
    ['slider-write', 'val-write', 'phrase'],
    ['slider-draw', 'val-draw', 'draw'],
    ['slider-meme', 'val-meme', 'meme'],
  ];
  sliders.forEach(([sliderId, valId, key]) => {
    $('#' + sliderId).addEventListener('input', (e) => {
      $('#' + valId).textContent = e.target.value;
      Host.updateSettings({ [key]: Number(e.target.value) });
    });
  });

  $('#btn-start').addEventListener('click', () => Host.startGame());
}

function wireRound() {
  $('#btn-submit').addEventListener('click', () => Client.submitCurrent(false));
}

function wireReveal() {
  $('#btn-reveal-next').addEventListener('click', () => Host.revealNext());
  $('#btn-reveal-prev').addEventListener('click', () => Host.revealPrev());
}

function wireResults() {
  $('#btn-play-again').addEventListener('click', () => Host.playAgain());
}

function boot() {
  wireHome();
  wireLobby();
  wireRound();
  wireReveal();
  wireResults();
  showScreen('screen-home');
}

document.addEventListener('DOMContentLoaded', boot);

'use strict';

// ===== 기본 설정 =====
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // 480
const H = canvas.height;  // 720

const PLAYER_Y = H - 110;
const ROAD_L = 24;
const ROAD_R = W - 24;
const SQUAD_CAP = 150;

// 화면 크기에 맞춰 캔버스 스케일
function fitCanvas() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H) * 0.97;
  canvas.style.width = (W * s) + 'px';
  canvas.style.height = (H * s) + 'px';
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ===== 게임 상태 =====
let state = 'menu';   // menu | playing | clear | gameover
let level = 1;
let score = 0;
let clock = 0;        // 누적 게임 시간(버프 만료 판정용)
let time = 0;         // 현재 레벨 경과 시간
let lastTs = 0;

const player = {
  x: W / 2,
  targetX: W / 2,
  squad: 10,
  damage: 1,
  fireTimer: 0,
  rapidUntil: 0,
  dmgUntil: 0,
};

let bullets = [];
let enemies = [];
let gates = [];
let items = [];
let texts = [];
let particles = [];
let spawnTimer = 0;
let gateTimer = 0;
let bossSpawned = false;
let bossRef = null;

function levelCfg(n) {
  return {
    hp: 2 + (n - 1) * 2,
    speed: 42 + n * 6,
    spawnInterval: Math.max(0.35, 1.05 - n * 0.07),
    duration: 22 + n * 2,
    bossHp: 80 + n * 70,
  };
}

function startLevel(n) {
  level = n;
  time = 0;
  bullets = []; enemies = []; gates = []; items = []; texts = []; particles = [];
  spawnTimer = 1.0;
  gateTimer = 2.5;
  bossSpawned = false;
  bossRef = null;
  state = 'playing';
}

function resetGame() {
  score = 0;
  player.squad = 10;
  player.damage = 1;
  player.x = player.targetX = W / 2;
  player.rapidUntil = 0;
  player.dmgUntil = 0;
  startLevel(1);
}

// ===== 입력 =====
let dragging = false;
const keys = {};

function canvasX(e) {
  const r = canvas.getBoundingClientRect();
  return (e.clientX - r.left) * (W / r.width);
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'menu') { resetGame(); return; }
  if (state === 'clear') { player.squad = Math.min(SQUAD_CAP, player.squad + 5); startLevel(level + 1); return; }
  if (state === 'gameover') { resetGame(); return; }
  dragging = true;
  player.targetX = canvasX(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging && state === 'playing') player.targetX = canvasX(e);
});
window.addEventListener('pointerup', () => { dragging = false; });

window.addEventListener('keydown', (e) => { keys[e.key] = true; });
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

// ===== 부대 배치 =====
function squadPositions() {
  const n = Math.min(player.squad, 40);
  const pos = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 8);
    const col = i % 8;
    const rowCount = Math.min(8, n - row * 8);
    pos.push({
      x: player.x + (col - (rowCount - 1) / 2) * 16,
      y: PLAYER_Y + row * 15,
    });
  }
  return pos;
}

// ===== 스폰 =====
function spawnEnemy(cfg) {
  const roll = Math.random();
  let type = 'zombie';
  if (level >= 2 && roll < 0.15) type = 'tank';
  else if (roll < 0.35) type = 'runner';

  const base = {
    zombie: { r: 13, hpMul: 1.0, spdMul: 1.0, touch: 3, color: '#6fae4e' },
    runner: { r: 10, hpMul: 0.5, spdMul: 1.8, touch: 2, color: '#a4d65e' },
    tank:   { r: 19, hpMul: 3.0, spdMul: 0.6, touch: 8, color: '#3e7d3a' },
  }[type];

  const hp = Math.max(1, Math.round(cfg.hp * base.hpMul));
  enemies.push({
    type,
    x: ROAD_L + base.r + Math.random() * (ROAD_R - ROAD_L - base.r * 2),
    y: -30,
    r: base.r,
    hp, maxHp: hp,
    speed: cfg.speed * base.spdMul,
    touch: base.touch,
    color: base.color,
    wob: Math.random() * Math.PI * 2,
  });
}

function spawnBoss(cfg) {
  // 보스 체력은 현재 병력 화력에 맞춰 보정 (순삭/장기전 방지)
  const hp = Math.round(cfg.bossHp * (1 + player.squad / 25));
  bossRef = {
    type: 'boss',
    x: W / 2,
    y: -70,
    r: 46,
    hp, maxHp: hp,
    speed: 14 + level * 1.5,
    touch: 999,
    color: '#9b3fc0',
    wob: 0,
  };
  enemies.push(bossRef);
  bossSpawned = true;
  texts.push({ x: W / 2, y: 160, str: 'BOSS!', color: '#ff5577', life: 1.6, size: 40 });
}

function spawnGatePair() {
  function positive() {
    return Math.random() < 0.18
      ? { op: 'x', val: 2, hits: 0 }
      : { op: '+', val: 2 + Math.floor(Math.random() * 4), hits: 0 };
  }
  function negative() {
    return { op: '-', val: 3 + Math.floor(Math.random() * 6), hits: 0 };
  }
  let a = positive();
  let b = Math.random() < 0.65 ? negative() : positive();
  if (Math.random() < 0.5) [a, b] = [b, a];
  gates.push({ y: -40, h: 56, left: a, right: b, applied: false });
}

function dropItem(x, y) {
  const roll = Math.random();
  let type;
  if (roll < 0.34) type = 'rapid';
  else if (roll < 0.62) type = 'damage';
  else if (roll < 0.92) type = 'medic';
  else type = 'nuke';
  items.push({ type, x, y, r: 13 });
}

// ===== 업데이트 =====
function applyGateSide(side) {
  if (side.op === '+') {
    player.squad = Math.min(SQUAD_CAP, player.squad + side.val);
    texts.push({ x: player.x, y: PLAYER_Y - 50, str: '+' + side.val, color: '#5ecbff', life: 1, size: 28 });
  } else if (side.op === 'x') {
    player.squad = Math.min(SQUAD_CAP, player.squad * side.val);
    texts.push({ x: player.x, y: PLAYER_Y - 50, str: 'x' + side.val + '!', color: '#ffd84d', life: 1, size: 32 });
  } else {
    player.squad = Math.max(1, player.squad - side.val);
    texts.push({ x: player.x, y: PLAYER_Y - 50, str: '-' + side.val, color: '#ff6b6b', life: 1, size: 28 });
  }
}

function killEnemy(en) {
  score += en.type === 'boss' ? 500 : (en.type === 'tank' ? 30 : 10);
  for (let i = 0; i < (en.type === 'boss' ? 26 : 7); i++) {
    particles.push({
      x: en.x, y: en.y,
      vx: (Math.random() - 0.5) * 200,
      vy: (Math.random() - 0.5) * 200,
      life: 0.45,
      color: en.color,
      r: 2 + Math.random() * 3,
    });
  }
  if (en.type !== 'boss' && Math.random() < 0.10) dropItem(en.x, en.y);
}

function update(dt) {
  clock += dt;
  time += dt;
  const cfg = levelCfg(level);

  // --- 이동 ---
  const kspd = 460;
  if (keys['ArrowLeft'] || keys['a']) player.targetX = player.x - kspd * dt * 1.5;
  if (keys['ArrowRight'] || keys['d']) player.targetX = player.x + kspd * dt * 1.5;
  player.targetX = Math.max(ROAD_L + 30, Math.min(ROAD_R - 30, player.targetX));
  const diff = player.targetX - player.x;
  const maxMove = 620 * dt;
  player.x += Math.max(-maxMove, Math.min(maxMove, diff));

  // --- 사격 ---
  const baseInterval = Math.max(0.16, 0.5 - player.squad * 0.004);
  const interval = clock < player.rapidUntil ? baseInterval * 0.5 : baseInterval;
  player.fireTimer -= dt;
  if (player.fireTimer <= 0) {
    player.fireTimer = interval;
    const pos = squadPositions();
    const dmgMul = (clock < player.dmgUntil ? 2 : 1) * (1 + Math.max(0, player.squad - 40) * 0.04);
    for (const p of pos) {
      bullets.push({
        x: p.x + (Math.random() * 6 - 3),
        y: p.y - 8,
        vy: -540,
        dmg: player.damage * dmgMul,
        r: 3,
      });
    }
  }

  // --- 스폰 ---
  if (!bossSpawned) {
    if (time < cfg.duration) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnTimer = cfg.spawnInterval * (0.7 + Math.random() * 0.6);
        spawnEnemy(cfg);
      }
      gateTimer -= dt;
      if (gateTimer <= 0) {
        gateTimer = 6 + Math.random() * 3;
        spawnGatePair();
      }
    } else if (enemies.length === 0 || time > cfg.duration + 4) {
      spawnBoss(cfg);
    }
  }

  // --- 총알 ---
  for (const b of bullets) b.y += b.vy * dt;

  // 총알 vs 게이트 (게이트 강화/약화, 총알은 통과)
  for (const g of gates) {
    if (g.applied) continue;
    const top = g.y - g.h / 2, bot = g.y + g.h / 2;
    for (const b of bullets) {
      if (b.dead || b.gHit === g || b.y > bot || b.y < top) continue;
      const side = b.x < W / 2 ? g.left : g.right;
      b.gHit = g;
      side.hits++;
      if (side.hits % 12 === 0) {
        if (side.op === '+') side.val++;
        else if (side.op === '-' && side.val > 0) side.val--;
      }
    }
  }

  // 총알 vs 적
  for (const b of bullets) {
    if (b.dead) continue;
    for (const en of enemies) {
      if (en.hp <= 0) continue;
      const dx = b.x - en.x, dy = b.y - en.y;
      if (dx * dx + dy * dy < (en.r + b.r) * (en.r + b.r)) {
        en.hp -= b.dmg;
        b.dead = true;
        if (en.hp <= 0) killEnemy(en);
        break;
      }
    }
  }
  bullets = bullets.filter((b) => !b.dead && b.y > -20);
  enemies = enemies.filter((en) => en.hp > 0);

  // --- 적 이동 ---
  for (const en of enemies) {
    en.wob += dt * 6;
    en.y += en.speed * dt;
    // 플레이어 쪽으로 살짝 유도
    const pull = en.type === 'boss' ? 30 : 14;
    en.x += Math.max(-pull * dt, Math.min(pull * dt, player.x - en.x));
    en.x += Math.sin(en.wob) * 8 * dt;

    if (en.y + en.r >= PLAYER_Y - 4) {
      en.hp = 0;
      if (en.type === 'boss') {
        player.squad = 0;
      } else {
        player.squad -= en.touch;
        texts.push({ x: en.x, y: PLAYER_Y - 30, str: '-' + en.touch, color: '#ff6b6b', life: 0.8, size: 24 });
      }
    }
  }
  enemies = enemies.filter((en) => en.hp > 0);
  if (bossRef && bossRef.hp <= 0) bossRef = null;

  // --- 게이트 이동/적용 ---
  for (const g of gates) {
    g.y += 100 * dt;
    if (!g.applied && g.y + g.h / 2 >= PLAYER_Y) {
      g.applied = true;
      applyGateSide(player.x < W / 2 ? g.left : g.right);
    }
  }
  gates = gates.filter((g) => g.y - g.h / 2 < H + 20);

  // --- 아이템 ---
  for (const it of items) {
    it.y += 130 * dt;
    if (it.y > PLAYER_Y - 24 && Math.abs(it.x - player.x) < 58) {
      it.dead = true;
      if (it.type === 'rapid') {
        player.rapidUntil = clock + 8;
        texts.push({ x: it.x, y: it.y - 20, str: '연사 UP!', color: '#ffd84d', life: 1, size: 22 });
      } else if (it.type === 'damage') {
        player.dmgUntil = clock + 8;
        texts.push({ x: it.x, y: it.y - 20, str: '공격력 x2!', color: '#ff9b3d', life: 1, size: 22 });
      } else if (it.type === 'medic') {
        player.squad = Math.min(SQUAD_CAP, player.squad + 5);
        texts.push({ x: it.x, y: it.y - 20, str: '+5 병력', color: '#5eff8a', life: 1, size: 22 });
      } else {
        for (const en of enemies) {
          en.hp -= en.type === 'boss' ? 120 : 9999;
          if (en.hp <= 0) killEnemy(en);
        }
        enemies = enemies.filter((en) => en.hp > 0);
        if (bossRef && bossRef.hp <= 0) bossRef = null;
        texts.push({ x: W / 2, y: H / 2, str: 'NUKE!', color: '#ff5577', life: 1.2, size: 44 });
      }
    }
  }
  items = items.filter((it) => !it.dead && it.y < H + 20);

  // --- 파티클 / 텍스트 ---
  for (const p of particles) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const t of texts) { t.y -= 30 * dt; t.life -= dt; }
  texts = texts.filter((t) => t.life > 0);

  // --- 승패 판정 ---
  if (player.squad <= 0) {
    player.squad = 0;
    state = 'gameover';
    return;
  }
  if (bossSpawned && !bossRef && enemies.length === 0) {
    score += level * 200;
    state = 'clear';
  }
}

// ===== 렌더링 =====
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRoad() {
  ctx.fillStyle = '#23252e';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#3a3d49';
  ctx.fillRect(ROAD_L, 0, ROAD_R - ROAD_L, H);
  // 차선
  const off = (clock * 130) % 48;
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 4;
  ctx.setLineDash([22, 26]);
  ctx.lineDashOffset = -off;
  for (const lx of [W * 0.33, W * 0.5, W * 0.67]) {
    ctx.beginPath();
    ctx.moveTo(lx, -50);
    ctx.lineTo(lx, H + 50);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // 방어선
  ctx.strokeStyle = 'rgba(94,203,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ROAD_L, PLAYER_Y - 6);
  ctx.lineTo(ROAD_R, PLAYER_Y - 6);
  ctx.stroke();
}

function drawGate(g) {
  const halfW = (ROAD_R - ROAD_L) / 2 - 4;
  const sides = [
    { s: g.left, x: ROAD_L + 2 },
    { s: g.right, x: W / 2 + 2 },
  ];
  for (const { s, x } of sides) {
    const good = s.op !== '-';
    ctx.fillStyle = good ? 'rgba(80,160,255,0.30)' : 'rgba(255,80,80,0.30)';
    ctx.strokeStyle = good ? 'rgba(120,190,255,0.9)' : 'rgba(255,120,120,0.9)';
    ctx.lineWidth = 2;
    roundRect(x, g.y - g.h / 2, halfW, g.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.op + s.val, x + halfW / 2, g.y);
  }
}

function drawEnemy(en) {
  const bob = Math.sin(en.wob) * 2;
  ctx.fillStyle = en.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(en.x, en.y + bob, en.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 눈
  ctx.fillStyle = en.type === 'boss' ? '#ffdd33' : '#cc2222';
  const eo = en.r * 0.35;
  ctx.beginPath();
  ctx.arc(en.x - eo, en.y + bob - en.r * 0.15, en.r * 0.16, 0, Math.PI * 2);
  ctx.arc(en.x + eo, en.y + bob - en.r * 0.15, en.r * 0.16, 0, Math.PI * 2);
  ctx.fill();
  // HP 바 (보스 제외)
  if (en.type !== 'boss' && en.hp < en.maxHp) {
    const bw = en.r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(en.x - bw / 2, en.y - en.r - 9, bw, 4);
    ctx.fillStyle = '#5eff8a';
    ctx.fillRect(en.x - bw / 2, en.y - en.r - 9, bw * Math.max(0, en.hp / en.maxHp), 4);
  }
}

function drawSquad() {
  const pos = squadPositions();
  for (const p of pos) {
    ctx.fillStyle = '#3d7bd9';
    ctx.strokeStyle = '#1f4f9c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#8fc1ff';
    ctx.beginPath();
    ctx.arc(p.x, p.y - 2, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // 병력 수 배지
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(player.x - 26, PLAYER_Y - 36, 52, 22, 11);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(player.squad), player.x, PLAYER_Y - 25);
}

function drawItem(it) {
  const cfg = {
    rapid:  { c: '#ffd84d', t: '연사' },
    damage: { c: '#ff9b3d', t: '공격' },
    medic:  { c: '#5eff8a', t: '+5' },
    nuke:   { c: '#ff5577', t: '핵' },
  }[it.type];
  ctx.fillStyle = cfg.c;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#222';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.t, it.x, it.y);
}

function drawHUD() {
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(10, 10, 120, 32, 8);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 17px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('LEVEL ' + level, 22, 27);

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(W - 150, 10, 140, 32, 8);
  ctx.fill();
  ctx.fillStyle = '#ffd84d';
  ctx.textAlign = 'right';
  ctx.fillText(score.toLocaleString() + ' 점', W - 22, 27);

  // 버프 표시
  let bx = 14;
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'left';
  if (clock < player.rapidUntil) {
    ctx.fillStyle = '#ffd84d';
    ctx.fillText('연사 ' + Math.ceil(player.rapidUntil - clock) + 's', bx, 56);
    bx += 70;
  }
  if (clock < player.dmgUntil) {
    ctx.fillStyle = '#ff9b3d';
    ctx.fillText('공격x2 ' + Math.ceil(player.dmgUntil - clock) + 's', bx, 56);
  }

  // 보스 HP 바
  if (bossRef) {
    const bw = W - 120;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(60, 74, bw, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#e03a6c';
    const ratio = Math.max(0, bossRef.hp / bossRef.maxHp);
    if (ratio > 0) {
      roundRect(60, 74, Math.max(16, bw * ratio), 16, 8);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BOSS', W / 2, 82);
  }
}

function drawOverlay() {
  ctx.fillStyle = 'rgba(10,12,18,0.72)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (state === 'menu') {
    ctx.fillStyle = '#ffd84d';
    ctx.font = 'bold 52px sans-serif';
    ctx.fillText('LAST WAR', W / 2, H * 0.32);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('MINI', W / 2, H * 0.39);
    ctx.font = '17px sans-serif';
    ctx.fillStyle = '#aac6e8';
    ctx.fillText('드래그 또는 ←→ 키로 좌우 이동', W / 2, H * 0.52);
    ctx.fillText('게이트를 골라 병력을 불리고', W / 2, H * 0.565);
    ctx.fillText('좀비를 막아내세요!', W / 2, H * 0.61);
    ctx.fillStyle = '#5eff8a';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('▶ 클릭해서 시작', W / 2, H * 0.73);
  } else if (state === 'clear') {
    ctx.fillStyle = '#5eff8a';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('LEVEL ' + level + ' 클리어!', W / 2, H * 0.38);
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText('점수: ' + score.toLocaleString(), W / 2, H * 0.47);
    ctx.fillText('보너스 병력 +5', W / 2, H * 0.52);
    ctx.fillStyle = '#ffd84d';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('▶ 클릭해서 다음 레벨', W / 2, H * 0.65);
  } else if (state === 'gameover') {
    ctx.fillStyle = '#ff6b6b';
    ctx.font = 'bold 50px sans-serif';
    ctx.fillText('GAME OVER', W / 2, H * 0.38);
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText('도달 레벨: ' + level + '   점수: ' + score.toLocaleString(), W / 2, H * 0.48);
    ctx.fillStyle = '#ffd84d';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('▶ 클릭해서 다시 시작', W / 2, H * 0.62);
  }
}

function render() {
  drawRoad();
  for (const g of gates) if (!g.applied) drawGate(g);
  for (const it of items) drawItem(it);
  for (const en of enemies) drawEnemy(en);
  ctx.fillStyle = '#ffe27a';
  for (const b of bullets) {
    ctx.fillRect(b.x - 1.5, b.y - 6, 3, 9);
  }
  if (state !== 'menu') drawSquad();
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / 0.45);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (const t of texts) {
    ctx.globalAlpha = Math.min(1, t.life * 2);
    ctx.fillStyle = t.color;
    ctx.font = 'bold ' + t.size + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.str, t.x, t.y);
    ctx.globalAlpha = 1;
  }
  if (state !== 'menu') drawHUD();
  if (state !== 'playing') drawOverlay();
}

// ===== 메인 루프 =====
function loop(ts) {
  const dt = Math.min(0.033, (ts - lastTs) / 1000 || 0.016);
  lastTs = ts;
  if (state === 'playing') update(dt);
  else clock += dt; // 배경 애니메이션용
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ============================================================
// storage.js — 플레이어 데이터 JSON 파일 저장/불러오기
// ============================================================
import fs   from "fs";
import path from "path";
import { INITIAL_STATS, INITIAL_HIDDEN } from "./game.js";
import { ITEMS, 장착형 }                  from "./items.js";

const DATA_PATH = process.env.DATA_PATH ?? "./data/players.json";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 24);

// ── 내부 유틸 ────────────────────────────────────────────────

function ensureDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DATA_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, v));
}

// ── 플레이어 기본 CRUD ────────────────────────────────────────

export function getPlayer(accountId, displayName) {
  const data = load();
  if (!data[accountId]) {
    data[accountId] = {
      accountId,
      name:      displayName,
      stats:     { ...INITIAL_STATS },
      hidden:    { ...INITIAL_HIDDEN },
      gold:      500,
      inventory: [],
      equipped:  {},
      turn:      1,
      history:   [],
    };
    save(data);
  }
  return data[accountId];
}

export function updatePlayer(player) {
  const data             = load();
  data[player.accountId] = player;
  save(data);
}

export function getAllPlayers() {
  return Object.values(load());
}

export function processPlayer(accountId, applyFn) {
  const data = load();
  if (!data[accountId]) return null;
  const processed        = applyFn(data[accountId]);
  data[accountId]        = processed;
  save(data);
  return processed;
}

// ── 스케줄 봇용 ──────────────────────────────────────────────

// 마지막 history의 turn이 현재 turn - 1이면 이미 제출한 것
export function hasSubmittedThisTurn(accountId, displayName) {
  const player = getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  return last?.turn === player.turn - 1;
}

export function isEnded(accountId, displayName) {
  const player = getPlayer(accountId, displayName);
  return player.turn > MAX_TURNS;
}

// ── 무사수행 봇용 ─────────────────────────────────────────────

// 이번 턴 스케줄에 무사수행이 포함되어 있고 아직 결과가 없는 경우만 허용
export function canDoAdventure(accountId, displayName) {
  const player = getPlayer(accountId, displayName);
  const last   = player.history.at(-1);
  if (!last) return false;
  if (last.turn !== player.turn - 1) return false;
  if (!last.actions.includes("무사수행")) return false;
  if (last.adventureResult) return false; // 이미 완료
  return true;
}

// ── 상점 봇용 — 골드 ─────────────────────────────────────────

// 골드 충분 여부 확인
export function hasEnoughGold(accountId, displayName, amount) {
  return getPlayer(accountId, displayName).gold >= amount;
}

// 골드 직접 증감 (양수: 수입, 음수: 지출 / 마이너스 허용)
export function adjustGold(accountId, displayName, delta) {
  return processPlayer(accountId, (p) => ({
    ...p,
    gold: p.gold + delta,
  }));
}

// ── 상점 봇용 — 인벤토리 ─────────────────────────────────────

// 인벤토리에 아이템 보유 여부
export function hasItem(accountId, displayName, itemName) {
  return getPlayer(accountId, displayName).inventory.includes(itemName);
}

// 인벤토리에 아이템 추가
export function addItem(accountId, displayName, itemName) {
  return processPlayer(accountId, (p) => ({
    ...p,
    inventory: [...p.inventory, itemName],
  }));
}

// 인벤토리에서 아이템 제거 (첫 번째 일치 항목 1개만)
export function removeItem(accountId, displayName, itemName) {
  return processPlayer(accountId, (p) => {
    const inv = [...p.inventory];
    const idx = inv.indexOf(itemName);
    if (idx === -1) return p;
    inv.splice(idx, 1);
    return { ...p, inventory: inv };
  });
}

// 구매: 골드 차감 + 인벤토리 추가 (마이너스 허용)
export function buyItem(accountId, displayName, itemName) {
  const item = ITEMS[itemName];
  if (!item) return { ok: false, reason: "존재하지 않는 아이템입니다." };

  return processPlayer(accountId, (p) => ({
    ...p,
    gold:      p.gold - item.price,
    inventory: [...p.inventory, itemName],
  }));
}

// 판매: 장착 중이면 거부 / 인벤토리 제거 + 골드 추가
export function sellItem(accountId, displayName, itemName) {
  const item   = ITEMS[itemName];
  const player = getPlayer(accountId, displayName);

  if (!item) return { ok: false, reason: "존재하지 않는 아이템입니다." };

  const idx = player.inventory.indexOf(itemName);
  if (idx === -1) return { ok: false, reason: "인벤토리에 없는 아이템입니다." };

  if (Object.values(player.equipped).includes(itemName)) {
    return { ok: false, reason: `장착 중인 아이템입니다. 먼저 [제거/${item.slot}]을 해주세요.` };
  }

  const updated = processPlayer(accountId, (p) => {
    const inv = [...p.inventory];
    inv.splice(idx, 1);
    return { ...p, gold: p.gold + item.sellPrice, inventory: inv };
  });

  return { ok: true, updated };
}

// ── 상점 봇용 — 장착 ─────────────────────────────────────────

// 슬롯에 현재 장착된 아이템명 반환 (없으면 null)
export function getEquipped(accountId, displayName, slot) {
  return getPlayer(accountId, displayName).equipped[slot] ?? null;
}

// 장착: 인벤토리에 없으면 거부 / 동일 슬롯 자동 교체
export function equipItem(accountId, displayName, itemName) {
  const item   = ITEMS[itemName];
  const player = getPlayer(accountId, displayName);

  if (!item)                      return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (!장착형.has(item.category)) return { ok: false, reason: "장착할 수 없는 아이템입니다." };
  if (!player.inventory.includes(itemName)) {
    return { ok: false, reason: "인벤토리에 없는 아이템입니다." };
  }

  const prev    = player.equipped[item.slot] ?? null;
  const updated = processPlayer(accountId, (p) => ({
    ...p,
    equipped: { ...p.equipped, [item.slot]: itemName },
  }));

  return { ok: true, updated, prev };
}

// 제거: 슬롯명으로 해제
export function unequipSlot(accountId, displayName, slot) {
  const player = getPlayer(accountId, displayName);
  const item   = player.equipped[slot];

  if (!item) return { ok: false, reason: `'${slot}' 슬롯에 장착된 아이템이 없습니다.` };

  const updated = processPlayer(accountId, (p) => {
    const equipped = { ...p.equipped };
    delete equipped[slot];
    return { ...p, equipped };
  });

  return { ok: true, updated, removed: item };
}

// ── 상점 봇용 — 소비 아이템 사용 ─────────────────────────────

// 소비 아이템 사용: 인벤토리 제거 + 수치 적용
export function useItem(accountId, displayName, itemName, PUBLIC_STATS, HIDDEN_STATS) {
  const item   = ITEMS[itemName];
  const player = getPlayer(accountId, displayName);

  if (!item)                    return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (item.category !== "소비") return { ok: false, reason: "사용할 수 없는 아이템입니다." };

  const idx = player.inventory.indexOf(itemName);
  if (idx === -1) return { ok: false, reason: "인벤토리에 없는 아이템입니다." };

  const updated = processPlayer(accountId, (p) => {
    const stats  = { ...p.stats };
    const hidden = { ...p.hidden };
    const inv    = [...p.inventory];
    inv.splice(idx, 1);

    for (const [stat, delta] of Object.entries(item.use)) {
      if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
      else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
    }

    return { ...p, stats, hidden, inventory: inv };
  });

  return { ok: true, updated };
}

// ── 상점 봇용 — 음식 즉시 적용 ───────────────────────────────

export function eatFood(accountId, displayName, itemName, PUBLIC_STATS, HIDDEN_STATS) {
  const item   = ITEMS[itemName];
  const player = getPlayer(accountId, displayName);

  if (!item)                    return { ok: false, reason: "존재하지 않는 아이템입니다." };
  if (item.category !== "음식") return { ok: false, reason: "음식이 아닙니다." };
  if (player.gold < item.price) return { ok: false, reason: `골드가 부족합니다. (보유: ${player.gold}G / 필요: ${item.price}G)` };

  const updated = processPlayer(accountId, (p) => {
    const stats  = { ...p.stats };
    const hidden = { ...p.hidden };

    for (const [stat, delta] of Object.entries(item.use)) {
      if (PUBLIC_STATS.includes(stat))      stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
      else if (HIDDEN_STATS.includes(stat)) hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
    }

    return { ...p, stats, hidden, gold: p.gold - item.price };
  });

  return { ok: true, updated };
}

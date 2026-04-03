// ============================================================
// sheets.js — Google Sheets 전용 I/O 모듈
// ============================================================
import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID ?? "1IFa5Vnshhxiu8dfCwWStGl9hSOFQd6jV1GBS0bjTG0Y";

const SHEETS = {
  PLAYERS:  "Players",
  ACTIONS:  "Actions",
  ITEMS:    "Items",
  MONSTERS: "Monsters",
};

// 컬럼 정의
const PLAYER_COLS  = ["accountId","name","지능","매력","체력","감성","사회성","도덕성","야망","위험도","의존성","스트레스","평판","전투","골드","턴","인벤토리","장착"];
const ACTION_COLS  = ["행동명","카테고리","최소나이","골드","효과","설명"];
const ITEM_COLS    = ["아이템명","상점","가격","판매비율","슬롯","최소나이","효과","설명"];
const MONSTER_COLS = ["마물명","장소","종류","최소나이","HP","공격력","방어력","골드최소","골드최대","대화텍스트","설명"];

// ── 인증 ─────────────────────────────────────────────────────

let _client = null;

async function getClient() {
  if (_client) return _client;

  const credRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 없음");

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credRaw),
    scopes:      ["https://www.googleapis.com/auth/spreadsheets"],
  });

  _client = google.sheets({ version: "v4", auth });
  return _client;
}

// ── 공통 유틸 ─────────────────────────────────────────────────

// 행 배열 → 객체 변환
function rowToObj(cols, row) {
  const obj = {};
  for (let i = 0; i < cols.length; i++) {
    obj[cols[i]] = row[i] ?? "";
  }
  return obj;
}

// 객체 → 행 배열 변환
function objToRow(cols, obj) {
  return cols.map((col) => {
    const val = obj[col];
    if (val === undefined || val === null) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

// 시트 전체 읽기 (헤더 제외)
async function readSheet(sheetName) {
  const sheets   = await getClient();
  const res      = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${sheetName}!A2:Z`,
  });
  return res.data.values ?? [];
}

// 특정 행 업데이트 (1-based, 헤더 포함 → 데이터 행은 row+1)
async function updateRow(sheetName, rowIndex, values) {
  const sheets = await getClient();
  const range  = `${sheetName}!A${rowIndex + 1}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId:     SHEET_ID,
    range,
    valueInputOption:  "USER_ENTERED",
    requestBody:       { values: [values] },
  });
}

// 행 추가
async function appendRow(sheetName, values) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId:     SHEET_ID,
    range:             `${sheetName}!A1`,
    valueInputOption:  "USER_ENTERED",
    insertDataOption:  "INSERT_ROWS",
    requestBody:       { values: [values] },
  });
}

// ── Players ───────────────────────────────────────────────────

// 모든 플레이어 조회 → { accountId: player } 맵
export async function loadAllPlayers() {
  const rows = await readSheet(SHEETS.PLAYERS);
  const map  = {};

  for (const row of rows) {
    const obj = rowToObj(PLAYER_COLS, row);
    if (!obj.accountId) continue;

    map[obj.accountId] = {
      accountId: obj.accountId,
      name:      obj.name,
      stats: {
        지능: Number(obj.지능) || 0,
        매력: Number(obj.매력) || 0,
        체력: Number(obj.체력) || 0,
        감성: Number(obj.감성) || 0,
        사회성: Number(obj.사회성) || 0,
      },
      hidden: {
        도덕성:   Number(obj.도덕성)   || 0,
        야망:     Number(obj.야망)     || 0,
        위험도:   Number(obj.위험도)   || 0,
        의존성:   Number(obj.의존성)   || 0,
        스트레스: Number(obj.스트레스) || 0,
        평판:     Number(obj.평판)     || 0,
        전투:     Number(obj.전투)     || 0,
      },
      gold:      Number(obj.골드) || 0,
      turn:      Number(obj.턴)   || 1,
      inventory: safeParseJSON(obj.인벤토리, []),
      equipped:  safeParseJSON(obj.장착,    {}),
      history:   [],  // 시트에서는 history 미관리
    };
  }

  return map;
}

// 단일 플레이어 조회
export async function loadPlayer(accountId) {
  const map = await loadAllPlayers();
  return map[accountId] ?? null;
}

// 플레이어 저장 (있으면 업데이트, 없으면 추가)
export async function savePlayer(player) {
  const rows = await readSheet(SHEETS.PLAYERS);

  const row = objToRow(PLAYER_COLS, {
    accountId: player.accountId,
    name:      player.name,
    지능:      player.stats.지능,
    매력:      player.stats.매력,
    체력:      player.stats.체력,
    감성:      player.stats.감성,
    사회성:    player.stats.사회성,
    도덕성:    player.hidden.도덕성,
    야망:      player.hidden.야망,
    위험도:    player.hidden.위험도,
    의존성:    player.hidden.의존성,
    스트레스:  player.hidden.스트레스,
    평판:      player.hidden.평판,
    전투:      player.hidden.전투,
    골드:      player.gold,
    턴:        player.turn,
    인벤토리:  JSON.stringify(player.inventory),
    장착:      JSON.stringify(player.equipped),
  });

  const idx = rows.findIndex((r) => r[0] === player.accountId);

  if (idx === -1) {
    await appendRow(SHEETS.PLAYERS, row);
  } else {
    await updateRow(SHEETS.PLAYERS, idx + 1, row); // +1: 헤더 오프셋
  }
}

// ── Actions ───────────────────────────────────────────────────

export async function loadActions() {
  const rows    = await readSheet(SHEETS.ACTIONS);
  const actions = {};

  for (const row of rows) {
    const obj = rowToObj(ACTION_COLS, row);
    if (!obj.행동명) continue;

    actions[obj.행동명] = {
      category: obj.카테고리,
      minAge:   Number(obj.최소나이) || 8,
      gold:     Number(obj.골드)     || 0,
      effects:  safeParseJSON(obj.효과, {}),
      desc:     obj.설명,
    };
  }

  return actions;
}

// ── Items ─────────────────────────────────────────────────────

export async function loadItems() {
  const rows  = await readSheet(SHEETS.ITEMS);
  const items = {};

  for (const row of rows) {
    const obj = rowToObj(ITEM_COLS, row);
    if (!obj.아이템명) continue;

    const price      = Number(obj.가격)    || 0;
    const sellRatio  = Number(obj.판매비율) || 0.5;
    const effects    = safeParseJSON(obj.효과, {});
    const minAge     = Number(obj.최소나이) || 0;
    const slot       = obj.슬롯 || null;

    // 장착형 / 소비형 / 음식 자동 판별
    const category = slot
      ? (["무기","방패","의상","장신구"].includes(slot) ? slot : slot)
      : (obj.상점 === "레스토랑" ? "음식" : "소비");

    items[obj.아이템명] = {
      category,
      shop:      obj.상점,
      price,
      sellPrice: Math.floor(price * sellRatio),
      slot:      slot || undefined,
      minAge,
      effects,
      desc:      obj.설명,
      // 장착형이면 equip, 소비/음식이면 use
      ...(slot ? { equip: effects } : { use: effects }),
    };
  }

  return items;
}

// ── Monsters ──────────────────────────────────────────────────

export async function loadMonsters() {
  const rows     = await readSheet(SHEETS.MONSTERS);
  const monsters = {};

  for (const row of rows) {
    const obj = rowToObj(MONSTER_COLS, row);
    if (!obj.마물명) continue;

    monsters[obj.마물명] = {
      location:  obj.장소,
      type:      obj.종류,
      minAge:    Number(obj.최소나이) || 0,
      hp:        Number(obj.HP)       || 0,
      atk:       Number(obj.공격력)   || 0,
      def:       Number(obj.방어력)   || 0,
      goldMin:   Number(obj.골드최소) || 0,
      goldMax:   Number(obj.골드최대) || 0,
      dialogue:  obj.대화텍스트,
      desc:      obj.설명,
    };
  }

  return monsters;
}

// ── 유틸 ─────────────────────────────────────────────────────

function safeParseJSON(str, fallback) {
  if (!str || str === "") return fallback;
  try { return JSON.parse(str); }
  catch { return fallback; }
}

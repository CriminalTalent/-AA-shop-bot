// ============================================================
// shop.js — 상가 거리 봇
// ============================================================
import "dotenv/config";
import { createRestAPIClient, createStreamingAPIClient } from "masto";
import { PUBLIC_STATS, HIDDEN_STATS, buildStatusLine } from "./game.js";
import { ITEMS, SHOP_FILTER, 장착형, 소비형, drawTarot, buildTarotReading } from "./items.js";
import { getPlayer, processPlayer } from "./storage.js";

const BOT_TOKEN    = process.env.SHOP_TOKEN;
const INSTANCE_URL = process.env.MASTODON_URL;

if (!BOT_TOKEN || !INSTANCE_URL) {
  console.error(".env 설정 필요: MASTODON_URL, SHOP_TOKEN");
  process.exit(1);
}

const rest      = createRestAPIClient({ url: INSTANCE_URL, accessToken: BOT_TOKEN });
const streaming = createStreamingAPIClient({
  streamingApiUrl: INSTANCE_URL.replace(/\/$/, "") + "/api/v1/streaming",
  accessToken:     BOT_TOKEN,
});

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, v));
}

function parseTokens(content) {
  const plain   = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const matches = [...plain.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const parts = m[1].split("/");
    return { key: parts[0].trim(), value: parts[1]?.trim() ?? null };
  });
}

async function reply(notification, text) {
  const chunks  = splitText(text, 480);
  let   replyId = notification.status?.id;
  for (const chunk of chunks) {
    const status = await rest.v1.statuses.create({
      status:      `@${notification.account.acct} ${chunk}`,
      inReplyToId: replyId,
      visibility:  notification.status?.visibility ?? "unlisted",
    });
    replyId = status.id;
  }
}

function splitText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, limit));
    text = text.slice(limit);
  }
  return chunks;
}

// -- [상가/무기상] [상가/의상실] [상가/잡화점] --------------------
async function handleShopList(notification, shopName) {
  const filter = SHOP_FILTER[shopName];
  if (!filter) {
    await reply(notification, "상점명을 확인해주세요. (무기상 / 의상실 / 잡화점)");
    return;
  }

  const entries = Object.entries(ITEMS).filter(([, item]) => filter(item));
  const lines   = entries.map(([name, item]) => {
    const fx = 장착형.has(item.category)
      ? Object.entries(item.equip).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`).join(", ")
      : Object.entries(item.use).map(([s, d])   => `${s}${d > 0 ? "+" : ""}${d}`).join(", ");
    const tag = 장착형.has(item.category) ? `[${item.slot}]` : "[소비]";
    return `${tag} ${name} — ${item.price}G | ${fx}`;
  });

  await reply(notification, `[${shopName} 목록]\n${lines.join("\n")}`);
}

// -- [레스토랑] ---------------------------------------------------
async function handleRestaurant(notification) {
  const entries = Object.entries(ITEMS).filter(([, item]) => item.category === "음식");
  const lines   = entries.map(([name, item]) => {
    const fx = Object.entries(item.use).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`).join(", ");
    return `${name} — ${item.price}G | ${fx}`;
  });
  await reply(notification, `[레스토랑 메뉴]\n${lines.join("\n")}\n\n구매 즉시 효과 적용됩니다.`);
}

// -- [구매/이름] --------------------------------------------------
async function handleBuy(notification, accountId, displayName, itemName) {
  if (!itemName) { await reply(notification, "아이템명을 입력해주세요."); return; }

  const item = ITEMS[itemName];
  if (!item)  { await reply(notification, `'${itemName}'은(는) 없는 아이템입니다.`); return; }

  const player = getPlayer(accountId, displayName);
  if (player.gold < item.price) {
    await reply(notification, `골드가 부족합니다. (보유: ${player.gold}G / 필요: ${item.price}G)`);
    return;
  }

  // 음식 — 즉시 효과, 인벤토리 미저장
  if (item.category === "음식") {
    const updated = processPlayer(accountId, (p) => {
      const stats  = { ...p.stats };
      const hidden = { ...p.hidden };
      for (const [stat, delta] of Object.entries(item.use)) {
        if (PUBLIC_STATS.includes(stat))       stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
        else if (HIDDEN_STATS.includes(stat))  hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
      }
      return { ...p, stats, hidden, gold: p.gold - item.price };
    });

    const fx = Object.entries(item.use).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`).join(", ");
    await reply(notification, `[${itemName}] 식사 완료.\n-${item.price}G / ${fx}\n소지금: ${updated.gold}G`);
    return;
  }

  // 그 외 — 인벤토리 추가
  const updated = processPlayer(accountId, (p) => ({
    ...p,
    gold:      p.gold - item.price,
    inventory: [...p.inventory, itemName],
  }));

  await reply(notification, `[${itemName}] 구매 완료.\n-${item.price}G | 소지금: ${updated.gold}G`);
}

// -- [판매/이름] --------------------------------------------------
async function handleSell(notification, accountId, displayName, itemName) {
  if (!itemName) { await reply(notification, "아이템명을 입력해주세요."); return; }

  const item = ITEMS[itemName];
  if (!item) { await reply(notification, `'${itemName}'은(는) 없는 아이템입니다.`); return; }

  const player = getPlayer(accountId, displayName);
  const idx    = player.inventory.indexOf(itemName);
  if (idx === -1) { await reply(notification, `인벤토리에 '${itemName}'이(가) 없습니다.`); return; }

  if (Object.values(player.equipped).includes(itemName)) {
    await reply(notification, `장착 중인 아이템은 판매할 수 없습니다. 먼저 [제거/${item.slot}]을 해주세요.`);
    return;
  }

  const updated = processPlayer(accountId, (p) => {
    const inv = [...p.inventory];
    inv.splice(idx, 1);
    return { ...p, gold: p.gold + item.sellPrice, inventory: inv };
  });

  await reply(notification, `[${itemName}] 판매 완료.\n+${item.sellPrice}G | 소지금: ${updated.gold}G`);
}

// -- [사용/이름] --------------------------------------------------
async function handleUse(notification, accountId, displayName, itemName) {
  if (!itemName) { await reply(notification, "아이템명을 입력해주세요."); return; }

  const item = ITEMS[itemName];
  if (!item)                       { await reply(notification, `'${itemName}'은(는) 없는 아이템입니다.`); return; }
  if (item.category !== "소비")    { await reply(notification, `'${itemName}'은(는) 사용할 수 없는 아이템입니다.`); return; }

  const player = getPlayer(accountId, displayName);
  const idx    = player.inventory.indexOf(itemName);
  if (idx === -1) { await reply(notification, `인벤토리에 '${itemName}'이(가) 없습니다.`); return; }

  const updated = processPlayer(accountId, (p) => {
    const stats  = { ...p.stats };
    const hidden = { ...p.hidden };
    const inv    = [...p.inventory];
    inv.splice(idx, 1);

    for (const [stat, delta] of Object.entries(item.use)) {
      if (PUBLIC_STATS.includes(stat))       stats[stat]  = clamp(stats[stat]  + delta, 0, 100);
      else if (HIDDEN_STATS.includes(stat))  hidden[stat] = clamp(hidden[stat] + delta, 0, 100);
    }

    return { ...p, stats, hidden, inventory: inv };
  });

  const fx = Object.entries(item.use).map(([s, d]) => `${s}${d > 0 ? "+" : ""}${d}`).join(", ");
  await reply(notification, `[${itemName}] 사용 완료.\n변화: ${fx}\n\n${buildStatusLine(updated)}`);
}

// -- [장착/이름] --------------------------------------------------
async function handleEquip(notification, accountId, displayName, itemName) {
  if (!itemName) { await reply(notification, "아이템명을 입력해주세요."); return; }

  const item = ITEMS[itemName];
  if (!item)                       { await reply(notification, `'${itemName}'은(는) 없는 아이템입니다.`); return; }
  if (!장착형.has(item.category))  { await reply(notification, `'${itemName}'은(는) 장착할 수 없는 아이템입니다.`); return; }

  const player = getPlayer(accountId, displayName);
  if (!player.inventory.includes(itemName)) {
    await reply(notification, `인벤토리에 '${itemName}'이(가) 없습니다.`);
    return;
  }

  processPlayer(accountId, (p) => ({
    ...p,
    equipped: { ...p.equipped, [item.slot]: itemName },
  }));

  await reply(notification, `[${itemName}] 장착 완료. (슬롯: ${item.slot})`);
}

// -- [제거/슬롯명] ------------------------------------------------
async function handleUnequip(notification, accountId, displayName, slotName) {
  if (!slotName) { await reply(notification, "슬롯명을 입력해주세요."); return; }

  const player       = getPlayer(accountId, displayName);
  const equippedItem = player.equipped[slotName];

  if (!equippedItem) {
    await reply(notification, `'${slotName}' 슬롯에 장착된 아이템이 없습니다.`);
    return;
  }

  processPlayer(accountId, (p) => {
    const equipped = { ...p.equipped };
    delete equipped[slotName];
    return { ...p, equipped };
  });

  await reply(notification, `[${equippedItem}] 제거 완료.`);
}

// -- [주머니] -----------------------------------------------------
async function handlePocket(notification, accountId, displayName) {
  const player = getPlayer(accountId, displayName);

  const invLines = player.inventory.length > 0
    ? player.inventory.map((name) => {
        const isEquipped = Object.values(player.equipped).includes(name);
        return `  ${name}${isEquipped ? " [장착중]" : ""}`;
      }).join("\n")
    : "  없음";

  const equipLines = Object.entries(player.equipped).length > 0
    ? Object.entries(player.equipped).map(([slot, name]) => `  ${slot}: ${name}`).join("\n")
    : "  없음";

  await reply(notification,
    `[${player.name}] 주머니\n소지금: ${player.gold}G\n\n[인벤토리]\n${invLines}\n\n[장착 현황]\n${equipLines}`
  );
}

// -- [타로] -------------------------------------------------------
async function handleTarot(notification, displayName) {
  const cards   = drawTarot();
  const reading = buildTarotReading(displayName, cards);
  await reply(notification, reading);
}

// -- 명령 분기 ----------------------------------------------------
async function handleNotification(notification) {
  if (notification.type !== "mention")               return;
  if (!notification.status || !notification.account) return;

  const accountId   = notification.account.id;
  const acct        = notification.account.acct;
  const displayName = notification.account.displayName || acct;
  const tokens      = parseTokens(notification.status.content);

  if (tokens.length === 0) return;

  for (const token of tokens) {
    switch (token.key) {
      case "상가":     await handleShopList(notification, token.value);                       break;
      case "레스토랑": await handleRestaurant(notification);                                  break;
      case "구매":     await handleBuy(notification, accountId, displayName, token.value);    break;
      case "판매":     await handleSell(notification, accountId, displayName, token.value);   break;
      case "사용":     await handleUse(notification, accountId, displayName, token.value);    break;
      case "장착":     await handleEquip(notification, accountId, displayName, token.value);  break;
      case "제거":     await handleUnequip(notification, accountId, displayName, token.value); break;
      case "주머니":   await handlePocket(notification, accountId, displayName);              break;
      case "타로":     await handleTarot(notification, displayName);                          break;
      default:         await reply(notification, "알 수 없는 명령입니다.");                   break;
    }
  }
}

async function main() {
  const me = await rest.v1.accounts.verifyCredentials();
  console.log("상가 거리 봇 시작: @" + me.username);

  const stream = await streaming.user.subscribe();

  for await (const event of stream) {
    if (event.event !== "notification") continue;
    try {
      await handleNotification(event.payload);
      await rest.v1.notifications.dismiss({ id: event.payload.id });
    } catch (err) {
      console.error("알림 처리 오류:", err);
    }
  }
}

main().catch((err) => {
  console.error("봇 오류:", err);
  process.exit(1);
});

// ledger.js — 帳簿のドメインロジック。設計.md 4章に対応。
// このファイルは Storage(永続化)から独立させ、イベント配列から純粋に計算する。
(function () {

// ---- ID生成 ----
function newId(prefix = "") {
  const r = crypto.randomUUID();
  return prefix ? `${prefix}_${r}` : r;
}

// ---- 日時ヘルパー：JST基準 ----
function nowLocalISO() {
  const d = new Date();
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

function todayDateStr() {
  return nowLocalISO().slice(0, 10);
}

// Date オブジェクト → "YYYY-MM-DD"（ローカル日付。toISOString は使わない）。
// toISOString() は常に UTC に変換するため、JST(+9h)では日付が1日ずれる
// （日本時間 0:00〜8:59 台や、単に日付境界の扱いで「今日」が「昨日」になる）。
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- アイテム名の正規化 ----
// 同じアイテムが表記ゆれで別物として集計されるのを防ぐ。実際に発生した例：
//   "テックガント BOXIV [VIT]" / "テックガントBOXIV [VIT]" / "テックガントBOXⅣ[VIT]"
// NFKC 正規化により、全角ローマ数字(Ⅳ)は ASCII の "IV" に分解され、
// 全角英数字・全角括弧も半角に揃う。そのうえで空白を除去し、小文字に統一する。
//
// 重要：記録済みのイベント（buy / sell.list / 相場観測）は追記のみで書き換えない（設計方針1）。
// 正規化は「集計・照合するとき」に適用する。表示には元の表記をそのまま使う。
// 中黐点には字種が複数ある。NFKC は U+00B7(·) を U+30FB(・) に寄せないため、
// 「19thフォースネック·兵」と「19thフォースネック・兵」が別アイテムとして
// 集計されていた（実データで12組の重複を確認）。
// 一方、文字の脱落（アポフィカリック→アポフィリック）や濁点半濁点の違い
// （アバティア/アパティア）は本物の読み取り誤りであり、正規化で寄せてはいけない。
// 別アイテムを誤って統合する危険があるため、そちらは similarItemNames() で
// 保存前に気づかせる方針を取る。
const MIDDLE_DOTS = /[·‧・･]/g;
// 隅付き括弧【】と角括弧[]も混在する。ゲーム画面は【】だが読み取りが[]を返すことがあり、
// 「ルーンS[LUK+4]」と「ルーンS【LUK+4】」が別物として蓄積されていた。
// NFKC は変換しないため明示的に寄せる。実データで確認したところ、これで統合されるのは
// この1組だけで、別アイテムの衝突は起きない。
const BRACKETS_OPEN = /[【〔]/g;
const BRACKETS_CLOSE = /[】〕]/g;

function normalizeItemName(name) {
  if (!name) return "";
  return String(name)
    .normalize("NFKC")
    .replace(MIDDLE_DOTS, "・")
    .replace(BRACKETS_OPEN, "[")
    .replace(BRACKETS_CLOSE, "]")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 正規化しても一致しないが、字面が近い名前を探す。
// 読み取り誤りで生まれた別名を、保存前に利用者へ気づかせるための補助。
// 自動では直さない（別アイテムを統合する危険があるため）。
function similarItemNames(name, knownNames, maxDistance = 2) {
  const key = normalizeItemName(name);
  if (!key) return [];
  const seen = new Set();
  const out = [];
  for (const other of knownNames) {
    const k = normalizeItemName(other);
    if (!k || k === key || seen.has(k)) continue;
    // 長さが離れすぎているものは編集距離を測るまでもない
    if (Math.abs(k.length - key.length) > maxDistance) continue;
    // 短い名前どうしは誤検出が多いので対象外
    if (Math.max(k.length, key.length) <= 4) continue;
    const d = editDistance(key, k);
    if (d > 0 && d <= maxDistance) {
      seen.add(k);
      out.push({ name: other, distance: d });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function weekdayOf(dateStr) {
  // 0=日 ... 6=土
  return new Date(dateStr + "T00:00:00").getDay();
}

function isWeekend(dateStr) {
  const w = weekdayOf(dateStr);
  return w === 0 || w === 6;
}

// ---- 4.3 デイリークエスト報酬 ----
function questReward(dateStr) {
  return isWeekend(dateStr) ? 55 : 15;
}

// ---- 4.2 出品手数料。切り上げ（U-10 解消済み。当初「切り捨て」としていたが訂正） ----
function calcFee(price, qty, premiumActive) {
  if (premiumActive) return 0;
  const total = price * qty;
  if (total <= 0) return 0;
  return Math.ceil(total * 0.01);
}

// ---- 4.4 倉庫数 → 出品枠（U-03 / U-14 解消済み） ----
const STORAGE_SLOT_TABLE = [
  { min: 401, slots: 10 },
  { min: 301, slots: 8 },
  { min: 201, slots: 6 },
  { min: 101, slots: 4 },
  { min: 5, slots: 2 },
];

function slotsForStorage(count) {
  if (count == null) return null;
  for (const row of STORAGE_SLOT_TABLE) {
    if (count >= row.min) return row.slots;
  }
  return 0;
}

// ---- 取消（訂正）----
// 設計方針1「追記のみ、書き換えない」を守りながら記録を直すための仕組み。
// 間違った記録を消すのではなく、それを打ち消す void イベントを追記する。
// 簿記の訂正仕訳と同じ考え方で、「いつ何を直したか」が履歴に残る。
// UI 上は「編集」に見えるが、内部では void + 新しい記録の2本を追記している。
function voidedIds(events) {
  const s = new Set();
  for (const ev of events) {
    if (ev.type === "void" && ev.target_id) s.add(ev.target_id);
  }
  return s;
}

// 集計対象のイベント。取り消されたものと、取消記録そのものを除く。
function activeEvents(events) {
  const voided = voidedIds(events);
  return events.filter((e) => e.type !== "void" && !voided.has(e.id));
}

// ---- 相場観測の取り消し ----
// 同じ動画を誤って複数回取り込むと、実在しない量の観測が積み上がる（実際に3回取り込んで
// 38件の観測が100件に膨れた）。帳簿と同じく、消さずに打ち消す記録を追記して除外する。
// 取り込み1回分をまとめて取り消せるよう、対象は個々のidではなく取り込み時刻(batch_ts)。
function activeMarketObs(obs) {
  const voidedBatches = new Set();
  const voidedIds = new Set();
  for (const o of obs) {
    if (o.type !== "void") continue;
    if (o.target_batch) voidedBatches.add(o.target_batch);
    if (o.target_id) voidedIds.add(o.target_id);
  }
  return obs.filter(
    (o) => o.type !== "void" && !voidedBatches.has(o.ts) && !voidedIds.has(o.id)
  );
}

// 取り込み1回分ごとにまとめる。取り消し済みかどうかも返す。
function marketBatches(obs) {
  const voidedBatches = new Set();
  for (const o of obs) if (o.type === "void" && o.target_batch) voidedBatches.add(o.target_batch);
  const byTs = new Map();
  for (const o of obs) {
    if (o.type === "void") continue;
    if (!byTs.has(o.ts)) byTs.set(o.ts, { ts: o.ts, videoRef: o.video_ref, count: 0 });
    byTs.get(o.ts).count++;
  }
  return Array.from(byTs.values())
    .map((b) => ({ ...b, voided: voidedBatches.has(b.ts) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// ---- 相場の集計 ----
// 必ず単価（価格 ÷ 個数）で比べる。総額のまま比べると、まとめ売りが
// 「高い出品」に見えてしまう。実データで起きた例：
//   特殊コアⅥ[蒼穹]  150pt×1個 / 1400pt×14個
//   総額では 9.33倍のばらつきに見えるが、単価では 150pt と 100pt。
//   一番高く見えた出品が、実は一番安い。
//
// 検索結果の一覧は価格の安い順に並び、しかも全件は見えない
// （出品数30に対し表示8件など）。したがってここで得られるのは
// 「板全体の分布」ではなく「安い方から数件」である。買い判断には十分だが、
// 平均価格のような統計に使ってはいけない。
function unitPriceOf(obs) {
  const qty = obs.qty && obs.qty > 0 ? obs.qty : 1;
  return obs.price != null ? obs.price / qty : null;
}

function summarizeMarket(observations) {
  const byItem = new Map();
  for (const o of observations) {
    const key = normalizeItemName(o.item_id);
    if (!key) continue;
    if (!byItem.has(key)) byItem.set(key, { key, display: o.item_id, list: [] });
    byItem.get(key).list.push(o);
  }

  const rows = [];
  for (const { key, display, list } of byItem.values()) {
    const sorted = [...list].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const latestTs = sorted[sorted.length - 1].ts;
    const times = new Set(sorted.map((o) => o.ts));

    const units = sorted.map(unitPriceOf).filter((u) => u != null);
    units.sort((a, b) => a - b);

    // 最新の観測だけでの最安単価（今いくらで買えるか）
    const latestUnits = sorted.filter((o) => o.ts === latestTs).map(unitPriceOf).filter((u) => u != null);
    latestUnits.sort((a, b) => a - b);

    // まとめ売りが単品より安いか（単価の比較）
    const single = sorted.filter((o) => (o.qty || 1) === 1).map(unitPriceOf).filter((u) => u != null);
    const bundle = sorted.filter((o) => (o.qty || 1) > 1).map(unitPriceOf).filter((u) => u != null);
    const bundleDiscount =
      single.length && bundle.length ? 1 - Math.min(...bundle) / Math.min(...single) : null;

    rows.push({
      key,
      item: display,
      observations: sorted.length,
      timePoints: times.size,
      latestTs,
      minUnit: units.length ? units[0] : null,
      maxUnit: units.length ? units[units.length - 1] : null,
      latestMinUnit: latestUnits.length ? latestUnits[0] : null,
      listingCount: sorted[sorted.length - 1].listing_count ?? null,
      bundleDiscount,
    });
  }
  return rows.sort((a, b) => (a.latestTs < b.latestTs ? 1 : -1));
}

// ---- 購入の目的 ----
//
// 同じ「購入」でも、売るために仕入れたものと、自分で使うために買ったものは
// 性質が違う。粘土やチョコドリのような材料が在庫に混ざると、原価の引き当ても
// 損益も意味を失う。そこで購入時に目的を持たせる。
//
// 記録に purpose が無い古い購入は「在庫用」とみなす。これまでの動きを変えないため。
const BUY_PURPOSES = { stock: "在庫用", use: "消耗品・私用" };

function buyPurpose(ev) {
  return ev && ev.purpose === "use" ? "use" : "stock";
}

// 自分で使うために買った分の支出。実現損益には混ぜず、別に集計する。
// 売買の成績と、遊びに使った額を分けて追えるようにするため。
function personalSpending(events) {
  const byItem = new Map();
  let total = 0;
  for (const ev of activeEvents(events)) {
    if (ev.type !== "buy" || buyPurpose(ev) !== "use") continue;
    const key = normalizeItemName(ev.item_id);
    if (!byItem.has(key)) byItem.set(key, { item: ev.item_id, qty: 0, total: 0 });
    const r = byItem.get(key);
    r.qty += ev.qty || 0;
    r.total += ev.total_price || 0;
    total += ev.total_price || 0;
  }
  return { total, rows: [...byItem.values()].sort((a, b) => b.total - a.total) };
}

// ---- 取得原価（先入先出法） ----
//
// ゲーム内の購入はロット単位（例: 10個で12,777pt）で、1個あたりが割り切れない。
// そこで利用者は、端数を最後の1個に寄せる形で原価を割り振っている:
//
//   10個 総額12,777pt  →  1277 × 9個 + 1284 × 1個  =  12,777pt
//
// 基準単価は総額÷個数の切り捨て。最後の1個だけが残り全部を引き受ける。
// こうするとロットの総額と、割り振った原価の合計が1ptも狂わない。
// この関数はその割り振りを再現する。
function lotUnitCosts(total, qty) {
  if (!qty || qty <= 0) return [];
  const base = Math.floor(total / qty);
  const costs = new Array(qty - 1).fill(base);
  costs.push(total - base * (qty - 1));
  return costs;
}

// 品目ごとに、まだ倉庫に残っている1個ずつの原価を古い順に並べる。
//
// 出品すると倉庫から実際に消えるので、出品した時点で引き当てる。
// 取消・期限切れは倉庫に戻るので、引き当てなかったものとして扱う。
function remainingUnitCosts(events, itemName) {
  const key = normalizeItemName(itemName);
  const active = activeEvents(events);

  // 出品の最終状態を先に確定させる（取消・期限切れは消費しない）
  const status = new Map();
  for (const ev of active) {
    if (ev.type === "sell.list") status.set(ev.listing_id, "listed");
    else if (ev.type === "sell.sold") status.set(ev.listing_id, "sold");
    else if (ev.type === "sell.cancel") status.set(ev.listing_id, "canceled");
    else if (ev.type === "sell.expired") status.set(ev.listing_id, "expired");
  }

  const units = [];
  let consumed = 0;
  for (const ev of active) {
    if (normalizeItemName(ev.item_id) !== key) continue;
    if (ev.type === "buy") {
      if (buyPurpose(ev) === "use") continue; // 自分で使う分は売る在庫ではない
      for (const c of lotUnitCosts(ev.total_price, ev.qty)) units.push({ cost: c, ts: ev.ts });
    } else if (ev.type === "sell.list") {
      const st = status.get(ev.listing_id);
      if (st === "listed" || st === "sold") consumed += ev.qty || 0;
    }
  }
  return units.slice(consumed);
}

// 次に qty 個を出品するときの原価。
// ロットをまたぐ場合は1個あたりが揃わないので、合計を個数で割った値を返し、
// 内訳も添える（画面で見えるようにするため）。
function fifoCostOf(events, itemName, qty = 1) {
  const rest = remainingUnitCosts(events, itemName);
  if (!rest.length) return null; // 購入履歴なし、または在庫を出し切っている
  const take = rest.slice(0, qty);
  const total = take.reduce((a, b) => a + b.cost, 0);
  return {
    unitCost: total / take.length,
    totalCost: total,
    qtyTaken: take.length,
    short: qty - take.length, // 在庫が足りない数（ドロップ品など）
    parts: take.map((u) => u.cost),
    remainingQty: rest.length,
  };
}

// ---- 取得原価 ----
// 購入履歴から1個あたりの原価を求める（移動平均法）。
// atTs を指定すると、その時点までの購入だけで平均する。
// 出品時に unit_cost として記録に焼き付けるため、あとから買い増ししても
// 過去の損益が動かない。
function unitCostOf(events, itemName, atTs) {
  const key = normalizeItemName(itemName);
  let qty = 0;
  let total = 0;
  for (const ev of activeEvents(events)) {
    if (ev.type !== "buy") continue;
    if (buyPurpose(ev) === "use") continue; // 自分で使う分は原価に含めない
    if (atTs && ev.ts > atTs) continue;
    if (normalizeItemName(ev.item_id) !== key) continue;
    qty += ev.qty || 0;
    total += ev.total_price || 0;
  }
  if (qty <= 0) return null; // 購入履歴なし（ゲーム内で入手した等）
  return { unitCost: total / qty, qtyBought: qty, totalSpent: total };
}

// ---- 売却の由来 ----
//
// 同じ売却でも、買ってきた物を売るのと、自分で拾った物を売るのでは意味が違う。
// 転売は仕入れとの差額が利益だが、自力入手は売れた額がそのまま利益になる。
// これを混ぜると、どちらで稼いでいるのかが見えなくなる。
//
// purchase: 仕入れ品。原価は購入履歴から引き当てる。
// self:     自力入手（ドロップ、クエスト報酬など）。原価は0。
//
// 由来を持たない古い出品は、これまでどおり unit_cost の有無だけで判断する。
// 過去に遡って0と決めつけると、確定していた損益が動いてしまうため。
const SELL_ORIGINS = { purchase: "仕入れ品（転売）", self: "自力入手（ドロップ等）" };

// ---- 在庫 ----
//
// 仕入れた物は2つの状態のどちらかにある。
//
//   待機中: 倉庫にあり、まだ出品していない。出品枠が空くのを待っている。
//   出品中: バザーに並んでいる。倉庫からは消えている。
//
// 出品枠には上限があるので、在庫があっても並べられるとは限らない。
// どちらにどれだけあるかが見えないと、資金がどこで止まっているか分からない。
//
// 消耗品・私用として買った物はここに出さない。使った分を記録する仕組みが
// 無いため、買った量が減らずに残り続けて実態と合わなくなる。
function inventorySummary(events) {
  const active = activeEvents(events);

  // 出品の最終状態
  const listings = new Map();
  for (const ev of active) {
    if (ev.type === "sell.list") {
      listings.set(ev.listing_id, { ev, status: "listed" });
    } else if (["sell.sold", "sell.cancel", "sell.expired"].includes(ev.type)) {
      const l = listings.get(ev.listing_id);
      if (l) l.status = ev.type.split(".")[1];
    }
  }

  const byKey = new Map();
  const touch = (name) => {
    const key = normalizeItemName(name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        item: name, waiting: 0, waitingValue: 0,
        listed: 0, listedCost: 0, listedPrice: 0,
      });
    }
    return byKey.get(key);
  };

  // 待機中：先入先出で引き当てたあとに倉庫へ残っている分
  for (const ev of active) {
    if (ev.type !== "buy" || buyPurpose(ev) === "use") continue;
    const r = touch(ev.item_id);
    if (r.waiting === 0 && r.waitingValue === 0) {
      const rest = remainingUnitCosts(events, ev.item_id);
      r.waiting = rest.length;
      r.waitingValue = rest.reduce((a, b) => a + b.cost, 0);
    }
  }

  // 出品中：まだ売れても取り消されてもいない出品
  for (const { ev, status } of listings.values()) {
    if (status !== "listed") continue;
    const r = touch(ev.item_id);
    const qty = ev.qty || 1;
    r.listed += qty;
    r.listedCost += (ev.unit_cost != null ? ev.unit_cost : 0) * qty;
    r.listedPrice += (ev.price || 0) * qty;
  }

  const rows = [...byKey.values()]
    .filter((r) => r.waiting > 0 || r.listed > 0)
    .sort((a, b) => b.waitingValue + b.listedCost - (a.waitingValue + a.listedCost));

  const totals = rows.reduce(
    (a, r) => ({
      waiting: a.waiting + r.waiting,
      waitingValue: a.waitingValue + r.waitingValue,
      listed: a.listed + r.listed,
      listedCost: a.listedCost + r.listedCost,
      listedPrice: a.listedPrice + r.listedPrice,
    }),
    { waiting: 0, waitingValue: 0, listed: 0, listedCost: 0, listedPrice: 0 }
  );

  return { rows, totals };
}

// 品目ごとの、1個ずつの明細。
//
// 先入先出で引き当てを再現し、いま手元にある1個1個について
// 「いつ、いくらで仕入れたか」を出す。出品中のものも、どのロットから
// 出たのかを遡れば仕入れ日が分かる。
//
// 同じ品でも仕入れ値が違うので、どれを先に売るべきか、どれが高値掴みだったかは
// 平均では見えない。1個ずつ見えて初めて判断できる。
function inventoryDetail(events, itemName) {
  const key = normalizeItemName(itemName);
  const active = activeEvents(events);

  const listings = new Map();
  for (const ev of active) {
    if (ev.type === "sell.list") listings.set(ev.listing_id, { ev, status: "listed" });
    else if (["sell.sold", "sell.cancel", "sell.expired"].includes(ev.type)) {
      const l = listings.get(ev.listing_id);
      if (l) l.status = ev.type.split(".")[1];
    }
  }

  // 仕入れた1個ずつを古い順に並べる
  const units = [];
  for (const ev of active) {
    if (ev.type !== "buy" || buyPurpose(ev) === "use") continue;
    if (normalizeItemName(ev.item_id) !== key) continue;
    for (const cost of lotUnitCosts(ev.total_price, ev.qty)) {
      units.push({ boughtTs: ev.ts, cost, status: "waiting" });
    }
  }

  // 出品した順に、古いロットから割り当てる
  const consuming = [...listings.values()]
    .filter((l) => normalizeItemName(l.ev.item_id) === key)
    .filter((l) => l.status === "listed" || l.status === "sold")
    .sort((a, b) => (a.ev.ts < b.ev.ts ? -1 : 1));

  let i = 0;
  for (const { ev, status } of consuming) {
    for (let k = 0; k < (ev.qty || 1); k++) {
      if (i >= units.length) break; // 買った記録より多く出している（自力入手など）
      const u = units[i++];
      u.status = status; // listed または sold
      u.listedTs = ev.ts;
      u.price = ev.price;
      u.recordedCost = ev.unit_cost;
      u.origin = ev.origin || null;
    }
  }

  // 売れたものは手元に無いので外す
  return units.filter((u) => u.status !== "sold");
}

// ---- 実現損益 ----
// 売れた出品ごとに「売上 − 原価 − 出品手数料」を求める。
// 原価は、自力入手なら0。仕入れ品なら出品時に記録した unit_cost、
// 無い場合は購入履歴から補う。どれも無ければ「原価不明」として
// 損益の合計から外す（0と決めつけない）。
function computeProfit(events) {
  const active = activeEvents(events);
  const listings = new Map();
  for (const ev of active) {
    if (ev.type === "sell.list") listings.set(ev.listing_id, ev);
  }

  const rows = [];
  let totalProfit = 0;
  let totalRevenue = 0;
  let unknownCostCount = 0;
  let resaleProfit = 0;   // 仕入れて売った分
  let selfProfit = 0;     // 自力で入手して売った分
  let resaleCount = 0;
  let selfCount = 0;

  for (const ev of active) {
    if (ev.type !== "sell.sold") continue;
    const list = listings.get(ev.listing_id);
    const itemId = list ? list.item_id : "(不明)";
    const qty = ev.qty || 1;
    const revenue = (ev.price || 0) * qty;
    const fee = list ? list.fee || 0 : 0;

    const origin = list && list.origin ? list.origin : null;

    let unitCost = null;
    if (origin === "self") {
      unitCost = 0; // 自力入手に仕入れ値は無い
    } else {
      unitCost = list && list.unit_cost != null ? list.unit_cost : null;
      if (unitCost == null) {
        const derived = unitCostOf(events, itemId, list ? list.ts : ev.ts);
        if (derived) unitCost = derived.unitCost;
      }
    }

    const known = unitCost != null;
    const cost = known ? unitCost * qty : null;
    const profit = known ? revenue - cost - fee : null;

    totalRevenue += revenue;
    if (known) {
      totalProfit += profit;
      if (origin === "self") {
        selfProfit += profit;
        selfCount++;
      } else {
        resaleProfit += profit;
        resaleCount++;
      }
    } else {
      unknownCostCount++;
    }

    rows.push({ ts: ev.ts, itemId, qty, revenue, cost, fee, profit, known, origin });
  }

  rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return {
    rows, totalProfit, totalRevenue, unknownCostCount,
    resaleProfit, selfProfit, resaleCount, selfCount,
  };
}

// ---- 残高への影響額。type ごとに符号付きで返す。null は「影響なし」 ----
function balanceDelta(ev) {
  switch (ev.type) {
    case "income.quest":
    case "income.other":
      return ev.amount;
    case "buy":
      // 単価×個数ではなく総額を直接記録する（4.1参照）。
      // ゲームの購入確認画面が単価を出さず合計額しか見せないため、
      // 暗算を要求しない形に合わせた。
      return -ev.total_price;
    case "sell.list":
      return -ev.fee;
    case "sell.sold":
      return ev.price * ev.qty;
    case "spend.other":
      return -ev.amount;
    // 状態イベント・別勘定・検算アンカーは残高に影響しない
    case "sell.cancel":
    case "sell.expired":
    case "state.premium_pass":
    case "state.storage":
    case "spend.cash":
    case "balance.observed":
    case "void":
      return 0;
    default:
      console.warn("未知のイベント種別:", ev.type);
      return 0;
  }
}

// ---- 4.5 検算エンジン ----
// events は ts 昇順ソート済みを前提。
// 戻り値: { runningBalance: 各時点の帳簿残高, discrepancies: [...] }
function computeLedger(allEvents) {
  const events = activeEvents(allEvents); // 取り消された記録を除く
  let running = 0;
  let lastObserved = null; // { ts, balance, running時点 }
  let segmentDelta = 0;
  const discrepancies = [];
  const timeline = [];

  for (const ev of events) {
    const delta = balanceDelta(ev);
    running += delta;
    segmentDelta += delta;
    timeline.push({ ev, runningAfter: running });

    if (ev.type === "balance.observed") {
      if (lastObserved !== null) {
        const actualDelta = ev.balance - lastObserved.balance;
        const diff = actualDelta - segmentDelta;
        if (diff !== 0) {
          discrepancies.push({
            fromTs: lastObserved.ts,
            toTs: ev.ts,
            fromBalance: lastObserved.balance,
            toBalance: ev.balance,
            expectedDelta: segmentDelta,
            actualDelta,
            diff, // 正: 帳簿より実際が多い(記録漏れの収入) / 負: 記録漏れの支出
          });
        }
      } else {
        // 最初の observed は開始残高として無条件に受け入れる。
        // ここまでの帳簿イベント(通常は無いはず)との差は不問。
      }
      // 実測値を真値として running を較正する。乖離があっても記録(上の discrepancies)は残しつつ、
      // 表示上の残高は常に「最後に確認できた実測値＋その後の記録」に合わせる。
      // これを入れないと、balance.observed は検算にしか使われず、初回入力しても画面が0のまま動かない。
      running = ev.balance;
      lastObserved = { ts: ev.ts, balance: ev.balance };
      segmentDelta = 0;
    }
  }

  return {
    runningBalance: running,
    hasAnchor: lastObserved !== null,
    lastObserved,
    discrepancies,
    timeline,
  };
}

// ---- 出品の状態機械 ----
function computeListings(allEvents) {
  const events = activeEvents(allEvents);
  const listings = new Map(); // listing_id -> state

  for (const ev of events) {
    if (ev.type === "sell.list") {
      listings.set(ev.listing_id, {
        listing_id: ev.listing_id,
        item_id: ev.item_id,
        price: ev.price,
        qty: ev.qty,
        fee: ev.fee,
        listedAt: ev.ts,
        status: "listed",
      });
    } else if (ev.type === "sell.sold") {
      const l = listings.get(ev.listing_id);
      if (l) {
        l.status = "sold";
        l.soldAt = ev.ts;
        l.soldPrice = ev.price;
        l.soldQty = ev.qty;
      }
    } else if (ev.type === "sell.cancel") {
      const l = listings.get(ev.listing_id);
      if (l) {
        l.status = "canceled";
        l.closedAt = ev.ts;
      }
    } else if (ev.type === "sell.expired") {
      const l = listings.get(ev.listing_id);
      if (l) {
        l.status = "expired";
        l.closedAt = ev.ts;
      }
    }
  }
  return Array.from(listings.values());
}

function activeListings(events) {
  return computeListings(events).filter((l) => l.status === "listed");
}

// ---- 4.4 現在の倉庫数・出品枠 ----
function currentStorageCount(allEvents) {
  const events = activeEvents(allEvents);
  let latest = null;
  for (const ev of events) {
    if (ev.type === "state.storage") latest = ev;
  }
  return latest ? latest.count : null;
}

// ---- 4.2 現在のPREMIUMパス加入状態（指定日時点） ----
function isPremiumActiveAt(allEvents, atTs) {
  const events = activeEvents(allEvents);
  let latest = null;
  for (const ev of events) {
    if (ev.type === "state.premium_pass" && ev.ts <= atTs) latest = ev;
  }
  if (!latest || !latest.active) return false;
  if (latest.until && atTs > latest.until) return false;
  return true;
}

// ---- 4.3 デイリークエストの未記録日一覧 ----
// from(YYYY-MM-DD) から today までのうち income.quest が無い日を返す。
function missingQuestDays(allEvents, fromDateStr, toDateStr = todayDateStr()) {
  const events = activeEvents(allEvents);
  const recorded = new Set(
    events.filter((e) => e.type === "income.quest").map((e) => e.date)
  );
  const missing = [];
  let d = new Date(fromDateStr + "T00:00:00");
  const end = new Date(toDateStr + "T00:00:00");
  while (d <= end) {
    const ds = localDateStr(d);
    if (!recorded.has(ds)) {
      missing.push({ date: ds, amount: questReward(ds), weekend: isWeekend(ds) });
    }
    d.setDate(d.getDate() + 1);
  }
  return missing;
}

// ---- 4.7 現金支出・PREMIUMパスの実績 ----
function cashSpendTotal(allEvents, purpose = null) {
  const events = activeEvents(allEvents);
  return events
    .filter((e) => e.type === "spend.cash" && (!purpose || e.purpose === purpose))
    .reduce((sum, e) => sum + e.amount_jpy, 0);
}

function premiumFeeSavings(allEvents) {
  const events = activeEvents(allEvents);
  // PREMIUM加入期間中に本来かかったはずの手数料（=節約額）を、
  // sell.list イベントの fee=0 かつ当時premium有効だったものから逆算はできないため、
  // 「その時点でpremiumでなかったら課されていたはずの額」を全 sell.list に対して試算する。
  let savings = 0;
  for (const ev of events) {
    if (ev.type !== "sell.list") continue;
    if (!isPremiumActiveAt(events, ev.ts)) continue;
    const wouldBeFee = calcFee(ev.price, ev.qty, false);
    savings += wouldBeFee; // 実際に徴収された fee は 0 のはず
  }
  return savings;
}


window.Ledger = {
  newId,
  nowLocalISO,
  todayDateStr,
  localDateStr,
  normalizeItemName,
  similarItemNames,
  activeMarketObs,
  marketBatches,
  unitPriceOf,
  summarizeMarket,
  activeEvents,
  voidedIds,
  unitCostOf,
  BUY_PURPOSES,
  buyPurpose,
  personalSpending,
  fifoCostOf,
  remainingUnitCosts,
  lotUnitCosts,
  computeProfit,
  inventorySummary,
  inventoryDetail,
  SELL_ORIGINS,
  weekdayOf,
  isWeekend,
  questReward,
  calcFee,
  slotsForStorage,
  balanceDelta,
  computeLedger,
  computeListings,
  activeListings,
  currentStorageCount,
  isPremiumActiveAt,
  missingQuestDays,
  cashSpendTotal,
  premiumFeeSavings,
};

})();

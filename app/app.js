// app.js — UI配線。ドメインロジックは ledger.js、永続化は storage.js に分離。
// file:// で type="module" が CORS ブロックされるため、通常スクリプトとして
// 読み込み順（storage.js → ledger.js → app.js）に依存する。window.Storage / window.Ledger を参照する。
const {
  newId,
  nowLocalISO,
  todayDateStr,
  weekdayOf,
  questReward,
  calcFee,
  slotsForStorage,
  computeLedger,
  activeListings,
  currentStorageCount,
  isPremiumActiveAt,
  missingQuestDays,
  cashSpendTotal,
  premiumFeeSavings,
  localDateStr,
  normalizeItemName,
  similarItemNames,
  activeMarketObs,
  marketBatches,
  activeEvents,
  voidedIds,
  unitCostOf,
  fifoCostOf,
  computeProfit,
  inventorySummary,
  profitByDay,
  inventoryDetail,
  SELL_ORIGINS,
  BUY_PURPOSES,
  buyPurpose,
  personalSpending,
} = window.Ledger;

let EVENTS = []; // 全イベント（ts昇順）

// ---------------------------------------------------------------
// 読み取り専用モードかどうか。
//
// http(s) で開かれているとき（GitHub Pages など）は、データを書き戻す先が
// 無いので閲覧だけにする。file:// で開いたときはこれまでどおり記録できる。
//
// 起動処理より前に決まっている必要があるため、ここで宣言する。
const READ_ONLY =
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

// ---------------------------------------------------------------
// 接続
// ---------------------------------------------------------------
const connStatus = document.getElementById("conn-status");
const btnConnect = document.getElementById("btn-connect");
const appEl = document.getElementById("app");

async function setConnected(ok) {
  connStatus.textContent = ok ? "接続済み" : "未接続";
  connStatus.className = ok ? "connected" : "disconnected";
  appEl.hidden = !ok;
  btnConnect.textContent = ok ? "フォルダー再選択" : "ledger/data を開く";
}

let MARKET_OBS = []; // 相場観測（他人の情報。残高計算には使わない）

// 読み取り専用のときはローカルフォルダではなく HTTP からデータを読む
function dataSource() {
  return READ_ONLY ? HttpStorage : Storage;
}

async function loadAndRender() {
  const src = dataSource();
  EVENTS = await src.readAllEvents();
  MARKET_OBS = await src.readAllMarketObservations();
  ITEM_CATALOG = await src.readItems();
  renderAll();
}

// ---------------------------------------------------------------
// タブ切り替え：残高だけ常時表示し、他はクリックで切り替える。
// ---------------------------------------------------------------
document.getElementById("tab-nav").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".tab-btn");
  if (!btn) return;
  const target = btn.dataset.tab;

  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.tabPanel !== target;
  });
});

btnConnect.addEventListener("click", async () => {
  try {
    await Storage.pickDirectory();
    await setConnected(true);
    await loadAndRender();
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
});

(async function init() {
  if (READ_ONLY) {
    // フォルダを開く余地が無いので、接続の操作ごと隠して読み込みに入る
    btnConnect.hidden = true;
    connStatus.textContent = "読み取り専用";
    connStatus.className = "connected";
    appEl.hidden = false;
    try {
      await loadAndRender();
      applyReadOnly();
    } catch (e) {
      console.error(e);
      connStatus.textContent = "データを読み込めません";
      connStatus.className = "disconnected";
    }
    return;
  }

  const restored = await Storage.tryRestore();
  if (restored === true) {
    await setConnected(true);
    await loadAndRender();
  } else if (restored === "needs-permission") {
    connStatus.textContent = "再許可が必要（右のボタンを押してください）";
    connStatus.className = "disconnected";
  }
})();

// ---------------------------------------------------------------
// 記録の共通処理
// ---------------------------------------------------------------
async function record(event) {
  if (READ_ONLY) {
    alert("読み取り専用の画面です。記録はパソコンから行ってください。");
    return;
  }
  event.id = event.id || newId();
  event.ts = event.ts || nowLocalISO();
  await Storage.appendEvent(event);
  EVENTS.push(event);
  EVENTS.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  renderAll();
}

function itemNames() {
  // 表記ゆれのある候補が並ぶと入力時に選び間違えるので、正規化した鍵で重複を除く。
  // 表示は最初に見つかった表記を使う。
  const byKey = new Map();
  for (const e of EVENTS) {
    if ((e.type === "buy" || e.type === "sell.list") && e.item_id !== "(未記入)") {
      const key = normalizeItemName(e.item_id);
      if (!byKey.has(key)) byKey.set(key, e.item_id);
    }
  }
  const names = new Set(byKey.values());
  return Array.from(names).sort();
}

// 取り込み結果の品名を突き合わせるための、既知の品名一覧。
// 図鑑・相場・帳簿のすべてから集める。
function knownItemNames() {
  const set = new Set();
  for (const it of ITEM_CATALOG) if (it.display_name) set.add(it.display_name);
  for (const o of activeMarketObs(MARKET_OBS)) if (o.item_id) set.add(o.item_id);
  for (const e of activeEvents(EVENTS)) if (e.item_id && e.item_id !== "(未記入)") set.add(e.item_id);
  return Array.from(set);
}

// 「似た名前が既にある」という警告のセルを作る。
// 読み取り誤り（文字の脱落、濁点半濁点）は正規化では寄せられないため、
// 保存前に目で気づけるようにする。自動では直さない——別アイテムを
// 誤って統合すると、相場も原価も壊れるため。
function similarWarningCell(name, idx, fieldClass) {
  const hits = name ? similarItemNames(name, knownItemNames()) : [];
  if (hits.length === 0) return '<td class="muted">—</td>';
  const buttons = hits
    .slice(0, 3)
    .map(
      (h) =>
        '<button type="button" class="small secondary sim-fix" data-idx="' +
        idx +
        '" data-cls="' +
        fieldClass +
        '" data-name="' +
        escapeHtml(h.name) +
        '" title="この名前に置き換える">' +
        escapeHtml(h.name) +
        "</button>"
    )
    .join(" ");
  return '<td style="color:var(--danger)">似た名前あり<br />' + buttons + "</td>";
}

// 「似た名前」ボタンの共通配線。押した行の品名欄をその名前に置き換える。
function wireSimilarFix(tbody, rows, rerender) {
  tbody.querySelectorAll(".sim-fix").forEach((btn) =>
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      rows[idx].item_name = btn.dataset.name;
      rerender();
    })
  );
}

// ---------------------------------------------------------------
// 描画
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// 読み取り専用モード
//
// http(s) で開かれているとき（GitHub Pages など）は、データを書き戻す先が
// 無いので閲覧だけにする。file:// で開いたときはこれまでどおり記録できる。
//
// 中途半端に押せてしまうと、記録したつもりで消えるという最悪の壊れ方をする。
// 入力を全部止めたうえで、なぜ止まっているかを画面に出す。
// ---------------------------------------------------------------
function applyReadOnly() {
  if (!READ_ONLY) return;

  const banner = document.createElement("p");
  banner.className = "hint";
  banner.style.cssText = "margin:0 0 10px;padding:8px;border-radius:6px";
  banner.innerHTML =
    "<b>読み取り専用</b>：閲覧用に公開している画面です。記録するには、" +
    "パソコンで ledger/app/index.html を直接開いてください。";
  const main = document.querySelector("main");
  if (main) main.insertBefore(banner, main.firstChild);

  for (const form of document.querySelectorAll("form")) {
    form.addEventListener("submit", (ev) => ev.preventDefault());
    for (const el of form.querySelectorAll("input, select, textarea, button")) {
      el.disabled = true;
    }
  }

  // 入力専用の区画はまるごと隠す（見えていても何もできないため）
  for (const id of ["gemini-settings", "buy-ocr-drop", "quest-area"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
}

function renderAll() {
  renderBalance();
  renderQuests();
  renderListings();
  renderPremiumHint();
  renderStorageHint();
  renderPremiumRoi();
  renderLog();
  renderItemDatalist();
  renderMarketSummary();
  renderMarketBatches();
  renderItemCatalog();
  renderProfit();
  renderStock();
  renderProfitTrend();
}

// 1個ずつの明細を開閉する。同じ品でも仕入れ値が違うので、
// 平均だけ見ていても「どれを先に売るべきか」が判断できない。
function toggleStockDetail(tr, itemName) {
  if (tr.nextSibling && tr.nextSibling.dataset && tr.nextSibling.dataset.detailFor === itemName) {
    tr.nextSibling.remove();
    return;
  }
  const units = inventoryDetail(EVENTS, itemName);
  const n = (v) => Math.round(v).toLocaleString();

  const body = units
    .map((u, i) => {
      const waiting = u.status === "waiting";
      // 利ざやは、左に出しているロット単価そのものから求める。
      // 出品に焼き付けた unit_cost は丸めた平均（12,050ptの6個なら2008.3）なので、
      // これで引くと全行が同じ値になり、2,010ptの行だけ合わなくなる。
      // ロット単価で引けば、各行の利ざやの合計が原価合計とぴったり一致する。
      const margin = waiting || u.price == null ? null : u.price - u.cost;
      return (
        "<tr>" +
        "<td>" + (i + 1) + "</td>" +
        "<td>" + fmtDate(u.boughtTs) + "</td>" +
        "<td>" + n(u.cost) + "pt</td>" +
        "<td>" + (waiting ? '<b>待機中</b>' : "出品中") + "</td>" +
        "<td>" + (waiting ? "" : fmtDate(u.listedTs)) + "</td>" +
        "<td>" + (waiting ? "" : n(u.price) + "pt") + "</td>" +
        "<td>" + (margin == null ? "" : (margin >= 0 ? "+" : "") + n(margin) + "pt") + "</td>" +
        "</tr>"
      );
    })
    .join("");

  const td = document.createElement("td");
  td.colSpan = 8;
  td.innerHTML =
    '<table style="margin:4px 0"><thead><tr>' +
    "<th>#</th><th>仕入れ日</th><th>仕入れ値</th><th>状態</th><th>出品日</th><th>出品価格</th><th>利ざや</th>" +
    "</tr></thead><tbody>" + body + "</tbody></table>";

  const row = document.createElement("tr");
  row.dataset.detailFor = itemName;
  row.appendChild(td);
  tr.after(row);
}

// 日ごとの損益。棒は各日の利益を、その期間の最大値に対する割合で描く。
// 外部の描画ライブラリは使わない（file:// で開くため、読み込めない）。
function renderProfitTrend() {
  const el = document.getElementById("profit-trend");
  if (!el) return;

  const days = profitByDay(EVENTS);
  if (!days.length) {
    el.innerHTML = '<p class="muted">まだ売却の記録がありません。</p>';
    return;
  }

  const n = (v) => Math.round(v).toLocaleString();
  const max = Math.max(...days.map((d) => Math.abs(d.profit)), 1);
  const W = "日月火水木金土";

  const body = days
    .slice()
    .reverse()
    .map((d) => {
      const w = (Math.abs(d.profit) / max) * 100;
      const color = d.profit >= 0 ? "var(--ok)" : "var(--danger)";
      const bar =
        '<div style="background:' + color + ';height:10px;border-radius:2px;width:' + w.toFixed(1) + '%"></div>';
      return (
        "<tr>" +
        "<td>" + d.date + "（" + W[weekdayOf(d.date)] + "）</td>" +
        "<td>" + d.count + "</td>" +
        "<td>" + d.units + "</td>" +
        "<td>" + n(d.revenue) + "pt</td>" +
        "<td>" + (d.cost ? n(d.cost) + "pt" : "") + "</td>" +
        '<td style="color:' + color + '">' + (d.profit >= 0 ? "+" : "") + n(d.profit) + "pt</td>" +
        "<td>" + (d.margin == null ? "" : (d.margin * 100).toFixed(1) + "%") + "</td>" +
        "<td>" + n(d.cumulative) + "pt</td>" +
        '<td style="min-width:90px">' + bar + "</td>" +
        (d.unknown ? "<td>原価不明" + d.unknown + "件</td>" : "<td></td>") +
        "</tr>"
      );
    })
    .join("");

  const totalProfit = days[days.length - 1].cumulative;
  const totalRevenue = days.reduce((a, d) => a + d.revenue, 0);
  const best = days.reduce((a, d) => (d.profit > a.profit ? d : a), days[0]);
  const avg = totalProfit / days.length;

  el.innerHTML =
    '<p class="muted">' +
    days.length + "日間 / 売上 " + n(totalRevenue) + "pt / 利益 " + n(totalProfit) + "pt / " +
    "1日平均 " + n(avg) + "pt / 最良 " + best.date + "（" + n(best.profit) + "pt）</p>" +
    "<table><thead><tr>" +
    "<th>日付</th><th>売却</th><th>個数</th><th>売上</th><th>原価</th><th>利益</th><th>利益率</th><th>累計</th><th></th><th></th>" +
    "</tr></thead><tbody>" + body + "</tbody></table>";
}

// --- 在庫 ---
function renderStock() {
  const tbody = document.getElementById("stock-body");
  const summary = document.getElementById("stock-summary");
  if (!tbody || !summary) return;

  const { rows, totals } = inventorySummary(EVENTS);
  const n = (v) => Math.round(v).toLocaleString();

  const slots = slotsForStorage(currentStorageCount(EVENTS));
  const used = activeListings(EVENTS).length;
  const slotNote =
    slots == null
      ? ""
      : ` / 出品枠 ${used}/${slots}${used >= slots ? "（満杯。待機中は枠が空くまで並べられません）" : ""}`;

  summary.innerHTML =
    '<div class="balance-hero" style="margin-bottom:8px">' +
    '<span class="num">' + n(totals.waitingValue + totals.listedCost) + "</span>" +
    '<span class="unit">pt（仕入れ在庫の評価額）</span></div>' +
    '<p class="muted">待機中 ' + totals.waiting + "個 " + n(totals.waitingValue) + "pt / 出品中 " +
    totals.listed + "個 " + n(totals.listedCost) + "pt" + slotNote + "</p>" +
    '<p class="muted">出品中がすべて売れると ' + n(totals.listedPrice) + "pt の売上（差引 " +
    (totals.listedPrice - totals.listedCost >= 0 ? "+" : "") +
    n(totals.listedPrice - totals.listedCost) + "pt）</p>";

  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.item) + "</td>" +
      "<td>" + (r.waiting || "") + "</td>" +
      "<td>" + (r.waiting ? n(r.waitingValue) + "pt" : "") + "</td>" +
      "<td>" + (r.listed || "") + "</td>" +
      "<td>" + (r.listed ? n(r.listedCost) + "pt" : "") + "</td>" +
      "<td>" + (r.listed ? n(r.listedPrice) + "pt" : "") + "</td>" +
      "<td>" + (r.waiting + r.listed) + "</td>" +
      '<td><button class="small secondary" data-act="detail">明細</button></td>';

    tr.querySelector('[data-act="detail"]').addEventListener("click", () =>
      toggleStockDetail(tr, r.item)
    );
    tbody.appendChild(tr);
  }
}

// --- 残高・検算 ---
function renderBalance() {
  const result = computeLedger(EVENTS);
  document.getElementById("running-balance").textContent = result.hasAnchor
    ? result.runningBalance.toLocaleString()
    : "—（未入力）";

  const area = document.getElementById("discrepancy-area");
  area.innerHTML = "";
  if (result.discrepancies.length === 0) {
    if (result.lastObserved) {
      const ok = document.createElement("span");
      ok.className = "ok-badge";
      ok.textContent = "検算OK：帳簿と実測が一致しています";
      area.appendChild(ok);
    }
    return;
  }
  for (const d of result.discrepancies) {
    const div = document.createElement("div");
    div.className = "discrepancy";
    const sign = d.diff > 0 ? "+" : "";
    div.innerHTML =
      `<b>乖離 ${sign}${d.diff.toLocaleString()}pt</b> — ` +
      `${fmtDate(d.fromTs)}〜${fmtDate(d.toTs)} の間に記録漏れの可能性。` +
      `帳簿上の想定変動 ${d.expectedDelta.toLocaleString()}pt に対し、実測変動は ${d.actualDelta.toLocaleString()}pt でした。`;
    area.appendChild(div);
  }
}

document.getElementById("form-observed").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = document.getElementById("observed-balance");
  const balance = Number(input.value);
  await record({ type: "balance.observed", balance });
  input.value = "";
});

// --- デイリークエスト ---
function renderQuests() {
  const area = document.getElementById("quest-area");
  area.innerHTML = "";

  // どこまで遡るか。
  //
  // 残高の実測より前は遡らない。実測した残高には、それ以前の収入がすでに
  // 含まれているため。遡って記録しても意味がなく、二重計上に見えてしまう。
  //
  // 実測した当日も出さない。実測の前にこなしたのか後なのか記録からは
  // 分からず、押し間違いのもとになるため。翌日からにする。
  // 実測が無ければ最初の記録の日から。
  // ただし今日だけは必ず出す。今日の残高を実測した直後にデイリーを
  // こなすことがあり、それを記録できなくなると困るため。
  // そのうえで30日を上限にする（際限なく並べない）。
  const cap = new Date();
  cap.setDate(cap.getDate() - 29);

  let anchor = null;
  for (const ev of activeEvents(EVENTS)) {
    if (ev.type === "balance.observed") anchor = ev.ts;
  }
  if (!anchor) {
    const first = activeEvents(EVENTS)[0];
    anchor = first ? first.ts : null;
  }

  const today = todayDateStr();
  let fromStr = today;
  if (anchor) {
    const next = new Date(anchor.slice(0, 10) + "T12:00:00");
    next.setDate(next.getDate() + 1);
    const afterAnchor = localDateStr(next);
    const capDate = localDateStr(cap);
    fromStr = afterAnchor > capDate ? afterAnchor : capDate;
    if (fromStr > today) fromStr = today; // 今日は必ず出す
  }
  const missing = missingQuestDays(EVENTS, fromStr, today);

  if (missing.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = `${fromStr} 以降はすべて記録済みです。`;
    area.appendChild(p);
    return;
  }

  const info = document.createElement("p");
  info.className = "muted";
  info.textContent =
    `未記録 ${missing.length}日分（${fromStr} 以降）。クリックでその日を記録します（平日15pt / 土日55pt）。`;
  area.appendChild(info);

  for (const m of missing) {
    const label = document.createElement("label");
    label.className = "quest-day" + (m.weekend ? " weekend" : "");
    label.innerHTML =
      `<input type="checkbox" /> ${m.date}（${"日月火水木金土"[weekdayOf(m.date)]}）${m.amount}pt` +
      ` <button type="button" class="small secondary" data-skip="${m.date}" title="この日はやらなかった">×</button>`;
    label.querySelector("input").addEventListener("change", async (e) => {
      if (!e.target.checked) return;
      await record({
        type: "income.quest",
        ts: m.date + "T21:00:00+09:00",
        date: m.date,
        amount: m.amount,
      });
    });
    // こなさなかった日を一覧から外す。記録を消すのではなく
    // 「やらなかった」という事実を1本足して、以後表示しない。
    label.querySelector("[data-skip]").addEventListener("click", async (ev) => {
      ev.preventDefault();
      await record({
        type: "quest.skip",
        ts: m.date + "T23:59:59+09:00",
        date: m.date,
      });
    });
    area.appendChild(label);
  }
}

// --- 購入 ---
document.getElementById("form-buy").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  // アイテム名は空欄を許容する（急いでいて記録できない場合。後から
  // events/*.jsonl の item_id を直接書き換えて補完できる。UIでの編集は作らない）。
  const item_id = document.getElementById("buy-item").value.trim() || "(未記入)";
  const total_price = Number(document.getElementById("buy-price").value);
  const qty = Number(document.getElementById("buy-qty").value);
  const purpose = document.getElementById("buy-purpose").value;
  await record({ type: "buy", item_id, total_price, qty, purpose });
  ev.target.reset();
  document.getElementById("buy-qty").value = 1;
});

// --- 購入OCR：スクリーンショットから品名・総額・個数を仮読み取りする ---
// 完全自動入力はしない。誤読の事故を避けるため、必ずフォームへの仮入力に留め、
// ユーザーが目で見て確認・修正してから「記録」を押す前提。
// Gemini APIキーが設定されていれば画像理解モデルを優先し、失敗時のみ
// Tesseract(文字認識のみ)にフォールバックする。
const ocrDrop = document.getElementById("buy-ocr-drop");
const ocrFileInput = document.getElementById("buy-ocr-file");
const ocrStatus = document.getElementById("buy-ocr-status");

function setOcrStatus(text) {
  ocrStatus.textContent = text;
}

async function runOcr(file) {
  const { key, model } = loadGeminiSettings();
  if (key && model) {
    setOcrStatus("Geminiで読み取り中…");
    try {
      const guess = await runGeminiOcr(file, key, model);
      applyStructuredGuess(guess);
      setOcrStatus(
        "Geminiの読み取り結果を仮入力しました。誤読の可能性があるので、記録前に必ず画面と見比べてください。"
      );
      return;
    } catch (e) {
      console.error(e);
      setOcrStatus(`Geminiでの読み取りに失敗しました（${e.message}）。Tesseractに切り替えます…`);
      // フォールバックへ続行
    }
  }
  await runTesseractOcr(file);
}

async function runTesseractOcr(file) {
  if (typeof Tesseract === "undefined") {
    setOcrStatus("OCRライブラリの読み込みに失敗しました（ネット接続を確認してください）。手入力してください。");
    return;
  }
  setOcrStatus("Tesseractで読み取り中…（初回はネットから言語データを取得するため時間がかかります）");
  try {
    const result = await Tesseract.recognize(file, "jpn+eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setOcrStatus(`読み取り中… ${Math.round((m.progress || 0) * 100)}%`);
        }
      },
    });
    const text = result.data.text || "";
    applyOcrGuess(text);
  } catch (e) {
    console.error(e);
    setOcrStatus("読み取りに失敗しました。手入力してください。");
  }
}

// --- Gemini 連携 ---
const GEMINI_KEY_STORAGE = "choco-ledger-gemini-key";
const GEMINI_MODEL_STORAGE = "choco-ledger-gemini-model";

function loadGeminiSettings() {
  try {
    return {
      key: localStorage.getItem(GEMINI_KEY_STORAGE) || "",
      model: localStorage.getItem(GEMINI_MODEL_STORAGE) || "",
    };
  } catch (e) {
    return { key: "", model: "" }; // localStorage 不可の環境（プライベートモード等）
  }
}

function saveGeminiKey(key) {
  try { localStorage.setItem(GEMINI_KEY_STORAGE, key); } catch (e) { /* 無視 */ }
}
function saveGeminiModel(model) {
  try { localStorage.setItem(GEMINI_MODEL_STORAGE, model); } catch (e) { /* 無視 */ }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // "data:image/png;base64,XXXX" の後半のみ
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function runGeminiOcr(file, apiKey, model) {
  const base64 = await fileToBase64(file);
  const prompt =
    "これはオンラインゲーム「チョコットランド」のバザー(アイテム売買)画面のスクリーンショットです。" +
    "購入または出品操作に関する、アイテム名・合計金額(pt単位の数字のみ)・個数を読み取ってください。" +
    "以下のJSON形式のみを出力し、他の文章は一切含めないでください。" +
    "合計金額はカンマ区切り表記(例:1,389)から数字だけを抽出してください。" +
    "個数が読み取れない場合は1としてください。読み取れない項目は null にしてください。";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: file.type || "image/png", data: base64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              item_name: { type: "string", nullable: true },
              total_price: { type: "number", nullable: true },
              qty: { type: "number", nullable: true },
            },
          },
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? " " + body.slice(0, 200) : ""}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("応答にテキストが含まれていません");
  return parseGeminiJson(text);
}

// --- 動画からフレームを切り出す（ブラウザー内で完結）---
//
// 当初は Gemini Files API に動画をアップロードしていたが、Google 側の処理が
// state: FAILED で終わることがあり、原因がこちらから見えなかった。
// アップロード・状態確認・サーバー側処理という失敗要因を丸ごと外すため、
// <video> と <canvas> でローカルに静止画を取り出し、画像として送る方式に変えた。
// Node 側の extract-icons.mjs も元から同じ方式（ffmpeg でフレーム抽出）で、
// そちらでは問題が出ていない。
//
// 送るのは JPEG。1枚あたり数十KBに収まり、インライン送信の上限に十分収まる。
async function extractFramesFromVideo(file, onProgress, { maxFrames = 40, quality = 0.8, stepSec = 0.5 } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () =>
        reject(new Error("動画を読み込めませんでした（ブラウザーが対応していない形式の可能性）"));
    });

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("動画の長さを取得できませんでした");
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    // 画面が変わったかの判定用。32x32 の灰色縮小版どうしを比べる。
    const sig = document.createElement("canvas");
    sig.width = 32;
    sig.height = 32;
    const sigCtx = sig.getContext("2d", { willReadFrequently: true });

    const signatureOf = () => {
      sigCtx.drawImage(video, 0, 0, 32, 32);
      const d = sigCtx.getImageData(0, 0, 32, 32).data;
      const g = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) {
        g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      }
      return g;
    };
    const diffRatio = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) n++;
      return n / a.length;
    };

    const seek = (t) =>
      new Promise((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("動画のシークに失敗しました"));
        video.currentTime = t;
      });

    // 画面が安定している区間を見つけ、その中央のフレームを選ぶ。
    //
    // 一定間隔で拾うと、表示が数秒しかない画面を構造的に取りこぼす。
    // 実測（99秒の動画、検索結果画面20種類）：
    //   4.96秒間隔で20枚      → 8/20 (40%)
    //   切り替わり時点を24枚  → 8/20 (40%)  切り替わりの瞬間ばかり残り無意味
    //   区間の中央を選ぶ      → 20/20 (100%)
    // 切り替わった「瞬間」ではなく、切り替わった後の「落ち着いた画面」を撮る必要がある。
    const sigs = [];
    const total = Math.ceil(duration / stepSec);
    for (let i = 0; i * stepSec < duration; i++) {
      const t = 0.4 + i * stepSec;
      if (t >= duration) break;
      if (i % 20 === 0) onProgress?.(`画面の切り替わりを検出中… ${i}/${total}`);
      await seek(t);
      sigs.push({ t, sig: signatureOf() });
    }

    // 連続して似ているものを1区間にまとめる
    const runs = [];
    let startI = 0;
    for (let i = 1; i < sigs.length; i++) {
      if (diffRatio(sigs[i - 1].sig, sigs[i].sig) > 0.06) {
        runs.push([startI, i - 1]);
        startI = i;
      }
    }
    if (sigs.length) runs.push([startI, sigs.length - 1]);

    // 各区間の中央。上限を超えるときは、長く映っていた区間を優先して残す
    // （短く映った画面ほど取りこぼしやすいが、上限内に収める必要があるため）。
    let picked = runs
      .map(([a, b]) => ({ t: sigs[Math.round((a + b) / 2)].t, len: b - a + 1 }))
      .sort((x, y) => y.len - x.len)
      .slice(0, maxFrames)
      .map((x) => x.t)
      .sort((a, b) => a - b);
    if (picked.length === 0) picked = [0.4];

    const frames = [];
    for (let i = 0; i < picked.length; i++) {
      onProgress?.(`フレームを切り出し中… ${i + 1}/${picked.length}`);
      await seek(picked[i]);
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      frames.push(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    }

    if (frames.length === 0) throw new Error("フレームを1枚も切り出せませんでした");
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.src = "";
  }
}

// 一時的な失敗を再試行する fetch。
// Gemini の Files API は、アップロードした動画の処理中に 500 を返すことがある
// （実際に「状態確認に失敗 HTTP 500」で止まった）。1回の失敗で諦めると、
// 待てば成功する処理まで落ちる。5xx と 429 だけを対象にし、
// 400/403/404 のような「待っても直らない」失敗は即座に返す。
async function fetchRetry(url, options = {}, { tries = 4, label = "" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // 待っても直らない種類はそのまま返す（呼び出し側で本文を読ませる）
      if (res.status < 500 && res.status !== 429) return res;
      const body = await res.text().catch(() => "");
      lastErr = new Error(
        (label ? label + ": " : "") + "HTTP " + res.status + (body ? " " + body.slice(0, 200) : "")
      );
    } catch (e) {
      // 通信断など
      lastErr = new Error((label ? label + ": " : "") + e.message);
    }
    if (i < tries - 1) {
      const waitMs = 1500 * Math.pow(2, i); // 1.5s → 3s → 6s
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Gemini の構造化出力スキーマ（OpenAPI サブセット）。
// 形式を文章で頼むと、モデルが説明文の擬似JSON（"price": number など）を
// そのまま真似て壊れた JSON を返すことがある。実際に
// 「Expected ',' or '}' after property value」で失敗した。
// 型はスキーマで強制し、プロンプトには意味の説明だけを書く。
const MARKET_SCHEMA = {
  type: "object",
  properties: {
    listings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_name: { type: "string" },
          price: { type: "number" },
          qty: { type: "number", nullable: true },
          remaining_days: { type: "number", nullable: true },
          enhancement_level: { type: "number", nullable: true },
          core_code: { type: "string", nullable: true },
          listing_count: { type: "number", nullable: true },
        },
        required: ["item_name", "price"],
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_name: { type: "string" },
          category: { type: "string", nullable: true },
          level_range: { type: "string", nullable: true },
          stats: {
            type: "array",
            items: {
              type: "object",
              properties: { stat: { type: "string" }, value: { type: "number" } },
              required: ["stat", "value"],
            },
          },
          special_core_tier: { type: "string", nullable: true },
        },
        required: ["item_name"],
      },
    },
  },
  required: ["listings", "items"],
};

// 応答の JSON 解析。壊れていたら生の応答を添えて投げる（原因を推測させないため）。
function parseGeminiJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const head = String(text).slice(0, 300).replace(/\s+/g, " ");
    throw new Error(e.message + " ／ 応答の冒頭: " + head);
  }
}

async function analyzeMarketVideo(file, apiKey, model, onProgress) {
  const frames = await extractFramesFromVideo(file, onProgress);
  onProgress?.(`Geminiが${frames.length}枚のフレームを解析中…（数十秒かかることがあります）`);

  const prompt =
    "これはオンラインゲーム「チョコットランド」の冒険者バザー(アイテム売買)画面を、" +
    "一定間隔で切り出した連続する静止画です。時系列順に並んでいます。" +
    "画面は主に3種類あります。無関係な画面（ローディング中の「商品の一覧を取得中です…」等）は無視してください。" +
    "(a)カテゴリ一覧画面：アイテムのアイコン・名前が並ぶ。価格は無いが、レベル帯（例:Lv.85~）や" +
    "赤字のステータスタグ（例:DEF +190, POW +25, REVIVE）が見えることがある。" +
    "(b)検索結果画面：アイテム名の上に「価格」「購入」「残り時間」が1件ずつ並ぶ。" +
    "画面上部にそのアイテムのレベル帯・全ステータス（例:ATK +777 POW +60 INT +30 VIT +50）が見える。" +
    "この2種類の画面から、次の2系統の情報を抽出してください。" +
    "\n\n【listings：価格の記録。(b)の画面からのみ】" +
    "1つの出品につき1件。アイテム名(item_name)、価格(price)、出品個数(qty)、" +
    "残り日数(remaining_days)、装備の強化レベル(enhancement_level)。" +
    "各出品アイコンには紛らわしい数字が複数あります。混同しないよう注意してください：" +
    "・強化レベル(enhancement_level)は、アイコンの**上辺に重なる小さな濃色の楕円バッジ**に" +
    "**算用数字だけ**で書かれています（例:「10」「20」）。個数ではありません。" +
    "**このバッジが見えない出品の enhancement_level は必ず null にしてください。**" +
    "強化されていない装備の方が多く、バッジが無いのが普通の状態です。推測で値を入れないでください。" +
    "・**アイコンの周りにあるローマ数字は強化レベルではありません。** 具体的には：" +
    "アイコン内の「Ⅳ」等は品名の一部（例「タフネステックガント Ⅳ」）であり、" +
    "アイコン下の「0518 Ⅲ」「0398 Ⅵ」のような数字＋ローマ数字は装着中の特殊コアの識別番号です。" +
    "どちらも enhancement_level とは無関係です。" +
    "・**特殊コアの識別番号は core_code に、見えたままの文字列で入れてください**" +
    "（例:「0518 Ⅲ」「0135 Ⅱ」）。この表示が無い出品は特殊コアが付いていないので core_code は null です。" +
    "コアの有無は価値を大きく変えるため、必ず区別してください。" +
    "Ⅲ を 3、Ⅴ を 5、Ⅵ を 6 のように読み替えて強化レベルに入れることは、絶対にしないでください。" +
    "・アイコン下の「×1」「×10」のような表記が実際の出品個数(qty)です。" +
    "全画像を通して出品をできるだけすべて洗い出してください。" +
    "重複の扱いに注意してください：連続する画像に**同じ画面がそのまま写り続けている**場合、" +
    "そこに並ぶ出品は同一のものなので1件として数えます。" +
    "しかし**1つの画面の中に同じ価格の出品が複数行並んでいる**場合、それらは別々の出品者による" +
    "別々の出品です。価格・個数・残り日数が全く同じでも、行の数だけ列挙してください。まとめてはいけません。" +
    "\n\n画面上部には「出品数」としてそのアイテムの総出品件数が表示されます。" +
    "一覧に見えている行数より多いことがあります（スクロールしないと全部は見えないため）。" +
    "この総数を listing_count として、その画面で見えた各出品に同じ値を入れてください。" +
    "\n\n【items：アイテム図鑑の情報。(a)(b)どちらの画面からでも。価格や個数は含めない】" +
    "登場したアイテムごとに1件。アイテム名(item_name)、" +
    "種別(category：装備／消費アイテム／特殊コア等、判断できる範囲で)、" +
    "レベル帯(level_range：例「Lv.85~」)、" +
    "ステータス(stats：ATK/DEF/POW/INT/VIT/MAT/SPD/LUK/HP/SP/MOV など、画面に出ているものだけ)、" +
    "特殊コアの階級(special_core_tier：特殊コアの場合のみ。例「Ⅵ【蒼玉】」)。" +
    "\n\nprice はカンマ区切り表記(例:1,389)から数字だけを抽出してください。" +
    "読み取れない・存在しない項目は null または空配列にしてください。";

  const res = await fetchRetry(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              ...frames.map((b64) => ({ inline_data: { mime_type: "image/jpeg", data: b64 } })),
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: MARKET_SCHEMA,
        },
      }),
    },
    { tries: 3, label: "フレームの解析" }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? " " + body.slice(0, 200) : ""}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error("応答にテキストが含まれていません" + (reason ? "（finishReason: " + reason + "）" : ""));
  }
  const parsed = parseGeminiJson(text);
  return {
    listings: Array.isArray(parsed.listings) ? parsed.listings : [],
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function fetchGeminiModels(apiKey) {
  const models = [];
  let pageToken = "";
  do {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}` +
      `&pageSize=100${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? " " + body.slice(0, 200) : ""}`);
    }
    const data = await res.json();
    for (const m of data.models || []) {
      // generateContent に対応するモデルのみ（embedding専用等は除く）。画像対応かは
      // 一覧APIの情報だけでは確実に判別できないため、選択は利用者に委ねる。
      if ((m.supportedGenerationMethods || []).includes("generateContent")) {
        models.push({ name: m.name, displayName: m.displayName || m.name });
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return models;
}

function applyStructuredGuess(guess) {
  if (guess.item_name) document.getElementById("buy-item").value = guess.item_name;
  if (guess.total_price != null) document.getElementById("buy-price").value = guess.total_price;
  if (guess.qty != null) document.getElementById("buy-qty").value = guess.qty;
}

// --- Gemini 設定UI配線 ---
const geminiKeyInput = document.getElementById("gemini-key");
const geminiModelSelect = document.getElementById("gemini-model");
const geminiFetchBtn = document.getElementById("gemini-fetch-models");
const geminiStatus = document.getElementById("gemini-status");

(function initGeminiSettings() {
  const { key, model } = loadGeminiSettings();
  if (key) geminiKeyInput.value = key;
  if (model) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model.replace(/^models\//, "");
    opt.selected = true;
    geminiModelSelect.innerHTML = "";
    geminiModelSelect.appendChild(opt);
  }
})();

geminiKeyInput.addEventListener("change", () => saveGeminiKey(geminiKeyInput.value.trim()));

geminiFetchBtn.addEventListener("click", async () => {
  const key = geminiKeyInput.value.trim();
  if (!key) {
    geminiStatus.textContent = "先にAPIキーを入力してください。";
    return;
  }
  saveGeminiKey(key);
  geminiStatus.textContent = "モデル一覧を取得中…";
  try {
    const models = await fetchGeminiModels(key);
    geminiModelSelect.innerHTML = "";
    if (models.length === 0) {
      geminiModelSelect.innerHTML = '<option value="">(該当モデルなし)</option>';
      geminiStatus.textContent = "取得できましたが、利用可能なモデルが見つかりませんでした。";
      return;
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = `${m.displayName}（${m.name.replace(/^models\//, "")}）`;
      geminiModelSelect.appendChild(opt);
    }
    const { model: savedModel } = loadGeminiSettings();
    if (savedModel && models.some((m) => m.name === savedModel)) {
      geminiModelSelect.value = savedModel;
    } else {
      saveGeminiModel(geminiModelSelect.value);
    }
    geminiStatus.textContent = `${models.length}件のモデルを取得しました。画像入力を試すモデルを選んでください（vision非対応のモデルだとエラーになります）。`;
  } catch (e) {
    console.error(e);
    geminiStatus.textContent = `モデル一覧の取得に失敗しました（${e.message}）。キーが正しいか確認してください。`;
  }
});

geminiModelSelect.addEventListener("change", () => saveGeminiModel(geminiModelSelect.value));

// 荒い見出し：完璧な構造化抽出はしない。フォームへの「たたき台」を作るだけ。
function applyOcrGuess(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 金額候補：「1,389pt」のような数字+pt表記のうち最大値を総額とみなす
  // （個数×単価の内訳より、確認ダイアログの合計額が最大値になりやすいため）。
  const priceMatches = [...rawText.matchAll(/([0-9][0-9,]*)\s*pt/gi)].map((m) =>
    Number(m[1].replace(/,/g, ""))
  );
  if (priceMatches.length) {
    document.getElementById("buy-price").value = Math.max(...priceMatches);
  }

  // 個数候補：「×10個」「x10」のような表記
  const qtyMatch = rawText.match(/[×xX]\s*(\d+)\s*個?/);
  if (qtyMatch) {
    document.getElementById("buy-qty").value = Number(qtyMatch[1]);
  }

  // 品名候補：数字だけの行・UI文言（購入/キャンセル/OK等）を除いた最初の行。
  const uiWords = /^(OK|購入しますか|購入する|購入|キャンセル|閉じる|とじる|所持|価格|残り時間)/;
  const nameCandidate = lines.find(
    (l) => !/^\d/.test(l) && !uiWords.test(l) && !/^[0-9,pt×xX個日\s]+$/i.test(l)
  );
  if (nameCandidate) {
    document.getElementById("buy-item").value = nameCandidate;
  }

  setOcrStatus(
    "読み取り完了。数字・品名は誤読することがあるので、記録前に必ず画面と見比べてください。" +
      (nameCandidate ? "" : "（品名は自動で判定できませんでした。手入力してください）")
  );
}

ocrDrop.addEventListener("click", () => ocrFileInput.click());
ocrDrop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") ocrFileInput.click();
});
ocrFileInput.addEventListener("change", () => {
  if (ocrFileInput.files[0]) runOcr(ocrFileInput.files[0]);
});
ocrDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  ocrDrop.classList.add("dragover");
});
ocrDrop.addEventListener("dragleave", () => ocrDrop.classList.remove("dragover"));
ocrDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  ocrDrop.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) runOcr(file);
});
// 取引タブが開いていれば、ドロップゾーンにフォーカスしていなくても
// 画面のどこでの Ctrl+V でも拾う（画像以外のペーストは無視するので、
// テキスト入力欄への貼り付けと衝突しない）。
document.addEventListener("paste", (e) => {
  const tradePanel = document.querySelector('.tab-panel[data-tab-panel="trade"]');
  if (!tradePanel || tradePanel.hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) runOcr(item.getAsFile());
});

// --- 出品 ---
const listFeeInput = document.getElementById("list-fee");
let feeManuallyEdited = false;
listFeeInput.addEventListener("input", () => (feeManuallyEdited = true));

// 原価は購入履歴から先入先出で自動で埋める。手で直したらそちらを尊重する。
let costManuallyEdited = false;
const listCostInput = document.getElementById("list-cost");
listCostInput.addEventListener("input", () => (costManuallyEdited = true));

function updateSuggestedCost() {
  const originSel = document.getElementById("list-origin");
  const note0 = document.getElementById("list-cost-note");

  // 自力入手に仕入れ値は無い。原価欄を0で固定し、触れないようにする。
  if (originSel && originSel.value === "self") {
    listCostInput.value = 0;
    listCostInput.disabled = true;
    if (note0) note0.textContent = "自力入手なので原価は0。売れた額がそのまま利益になります。";
    return;
  }
  listCostInput.disabled = false;

  if (costManuallyEdited) return;
  const name = document.getElementById("list-item").value.trim();
  const note = document.getElementById("list-cost-note");
  if (!name) {
    listCostInput.value = "";
    if (note) note.textContent = "";
    return;
  }
  const qty = Number(document.getElementById("list-qty").value) || 1;
  const c = fifoCostOf(EVENTS, name, qty);
  if (!c) {
    listCostInput.value = "";
    listCostInput.placeholder = "購入履歴なし";
    if (note) note.textContent = "購入記録がありません（ドロップ品なら空欄のままで構いません）。";
    return;
  }
  listCostInput.value = Math.round(c.unitCost * 10) / 10;
  listCostInput.placeholder = "";
  if (note) {
    const parts = c.parts.join(" + ");
    let text = `古いロットから ${parts} を引き当て（在庫 ${c.remainingQty}個）`;
    if (c.short > 0) text += ` ※${c.short}個ぶんは購入記録がありません`;
    note.textContent = text;
  }
}
document.getElementById("list-item").addEventListener("input", updateSuggestedCost);
document.getElementById("list-item").addEventListener("change", updateSuggestedCost);
document.getElementById("list-origin").addEventListener("change", () => {
  costManuallyEdited = false; // 由来を変えたら原価も出し直す
  updateSuggestedCost();
});
document.getElementById("list-qty").addEventListener("input", updateSuggestedCost);

function updateSuggestedFee() {
  if (feeManuallyEdited) return;
  const price = Number(document.getElementById("list-price").value) || 0;
  const qty = Number(document.getElementById("list-qty").value) || 1;
  const premium = isPremiumActiveAt(EVENTS, nowLocalISO());
  listFeeInput.value = calcFee(price, premium);
}
document.getElementById("list-price").addEventListener("input", updateSuggestedFee);

// 総額で入力するため、複数個のときに1個あたりがいくらか分からなくなる。
// 原価と見比べられないと利ざやの判断ができないので、その場に出す。
function updateListPriceNote() {
  const note = document.getElementById("list-price-note");
  if (!note) return;
  const total = Number(document.getElementById("list-price").value);
  const qty = Number(document.getElementById("list-qty").value) || 1;
  if (!total || qty <= 1) {
    note.textContent = "";
    return;
  }
  const each = total / qty;

  // 利ざやは合計から求める。1個あたりを丸めて個数で掛けると、ロット内の
  // 1個あたりが均一でないぶん合計と食い違う（242×6=1,452 と 1,450 のように）。
  // 合計を正として、1個あたりは平均であることが分かる形で添える。
  const name = document.getElementById("list-item").value.trim();
  const c = name ? fifoCostOf(EVENTS, name, qty) : null;
  let costTotal = null;
  if (!costManuallyEdited && c && c.short === 0) {
    costTotal = c.totalCost;
  } else {
    const unit = Number(listCostInput.value);
    if (unit) costTotal = unit * qty;
  }

  let margin = "";
  if (costTotal != null) {
    const m = total - costTotal;
    const per = m / qty;
    margin =
      `　利ざや 全体${Math.round(m).toLocaleString()}pt` +
      `（1個あたり平均 ${(Math.round(per * 10) / 10).toLocaleString()}pt）`;
  }
  note.textContent =
    `1個あたり ${Math.round(each).toLocaleString()}pt（${total.toLocaleString()} ÷ ${qty}個）${margin}`;
}
document.getElementById("list-price").addEventListener("input", updateListPriceNote);
document.getElementById("list-qty").addEventListener("input", updateListPriceNote);
document.getElementById("list-item").addEventListener("change", updateListPriceNote);
document.getElementById("list-qty").addEventListener("input", updateSuggestedFee);

document.getElementById("form-list").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const item_id = document.getElementById("list-item").value.trim();
  const price = Number(document.getElementById("list-price").value);
  const qty = Number(document.getElementById("list-qty").value);
  const fee = Number(listFeeInput.value) || 0;
  if (!item_id) return;

  // 出品枠が埋まっているのに記録できてしまうと、帳簿とゲームが黙ってずれる。
  // 実際に1件そうなった（2026-09-13、9件目が通ってしまった）ので、記録の前に確認を挟む。
  // ゲーム側で先に枠が空いている場合もあるため、止めずに確認だけにする。
  const slotsTotal = slotsForStorage(currentStorageCount(EVENTS));
  const slotsUsed = activeListings(EVENTS).length;
  if (slotsTotal != null && slotsUsed >= slotsTotal) {
    const ok = confirm(
      "出品枠が埋まっています（" + slotsUsed + " / " + slotsTotal + "）。\n" +
        "このまま記録すると、帳簿の出品数がゲームより多くなります。\n\n" +
        "ゲーム内で期限切れや取消が起きているなら、先にその記録を入れてください。\n" +
        "それでも記録しますか？"
    );
    if (!ok) return;
  }

  // 原価は出品時点の値を焼き付ける。あとから買い増ししても過去の損益が動かない。
  const costRaw = listCostInput.value.trim();
  const unit_cost = costRaw === "" ? null : Number(costRaw);
  const origin = document.getElementById("list-origin").value;
  if (!origin) {
    alert("由来を選んでください（仕入れ品か、自力入手か）。");
    return;
  }
  // 原価の合計も焼き付ける。
  //
  // unit_cost は入力欄の表示に合わせて小数1桁に丸めている。まとめ出品で
  // これを個数で掛けると、ロットの総額とわずかにずれる（12,050ptの6個なら
  // 2008.3×6 = 12,049.8）。端数を1ptも狂わせない方式を保つため、
  // 先入先出で求めた正確な合計を別に持たせる。
  // 原価を手で直したときは、その値を尊重して個数を掛ける。
  let total_cost = null;
  if (origin === "self") {
    total_cost = 0;
  } else if (!costManuallyEdited) {
    const c = fifoCostOf(EVENTS, item_id, qty);
    if (c && c.short === 0) total_cost = c.totalCost;
  }
  if (total_cost == null && unit_cost != null) total_cost = unit_cost * qty;

  await record({
    type: "sell.list",
    item_id,
    price,
    qty,
    fee,
    unit_cost: origin === "self" ? 0 : unit_cost,
    total_cost,
    origin,
    listing_id: newId("lst"),
  });
  ev.target.reset();
  document.getElementById("list-qty").value = 1;
  feeManuallyEdited = false;
  listFeeInput.value = "";
  costManuallyEdited = false;
  listCostInput.value = "";
  listCostInput.disabled = false;
  document.getElementById("list-origin").value = "";
});

function renderPremiumHint() {
  const active = isPremiumActiveAt(EVENTS, nowLocalISO());
  document.getElementById("premium-hint").textContent = active
    ? "現在PREMIUMパス加入中：手数料は0pt。"
    : "現在PREMIUMパス未加入：手数料は出品額の1%（切り上げ）。1pt以上の出品には最低1ptの手数料がかかる。";
}

// --- 出品中一覧 ---
function renderListings() {
  const listings = activeListings(EVENTS);
  const tbody = document.getElementById("listings-body");
  tbody.innerHTML = "";
  for (const l of listings) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(l.item_id)}</td>
      <td>${l.price.toLocaleString()}pt</td>
      <td>${l.qty}</td>
      <td>${l.fee.toLocaleString()}pt</td>
      <td>${fmtDate(l.listedAt)}</td>
      <td><span class="pill listed">出品中</span></td>
      <td>
        <button class="small" data-act="sold">売却</button>
        <button class="small secondary" data-act="cancel">取消</button>
        <button class="small secondary" data-act="expired">期限切れ</button>
      </td>`;
    tr.querySelector('[data-act="sold"]').addEventListener("click", () =>
      record({ type: "sell.sold", listing_id: l.listing_id, price: l.price, qty: l.qty })
    );
    tr.querySelector('[data-act="cancel"]').addEventListener("click", () =>
      record({ type: "sell.cancel", listing_id: l.listing_id })
    );
    tr.querySelector('[data-act="expired"]').addEventListener("click", () =>
      record({ type: "sell.expired", listing_id: l.listing_id })
    );
    tbody.appendChild(tr);
  }

  const storageCount = currentStorageCount(EVENTS);
  const totalSlots = slotsForStorage(storageCount);
  const area = document.getElementById("slots-area");
  if (totalSlots == null) {
    area.innerHTML = `<p class="muted">倉庫数が未設定です。下の「状態」で登録すると出品枠が表示されます。</p>`;
    return;
  }
  const used = listings.length;
  let bar = `<div class="slots-bar">`;
  for (let i = 0; i < totalSlots; i++) {
    bar += `<div class="slot ${i < used ? "used" : ""}"></div>`;
  }
  bar += `</div>`;
  area.innerHTML =
    `<p class="muted">出品枠 ${used} / ${totalSlots}（所持倉庫 ${storageCount}個）</p>` + bar;
}

// --- 状態：PREMIUMパス・倉庫 ---
document.getElementById("form-premium").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const active = document.getElementById("premium-active").value === "true";
  const until = document.getElementById("premium-until").value || null;
  await record({
    type: "state.premium_pass",
    active,
    until: until ? until + "T23:59:59+09:00" : null,
    season: until || null,
  });
});

document.getElementById("form-storage").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const count = Number(document.getElementById("storage-count").value);
  await record({ type: "state.storage", count });
});

function renderStorageHint() {
  const count = currentStorageCount(EVENTS);
  const el = document.getElementById("storage-hint");
  if (count == null) {
    el.textContent = "";
    return;
  }
  const slots = slotsForStorage(count);
  el.textContent = `現在 ${count}個 → 出品枠 ${slots}。倉庫は公式サイトで購入（5個250円 / 20個1,000円）。`;
}

// --- 現金支出 ---
document.getElementById("form-cash").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const purpose = document.getElementById("cash-purpose").value;
  const amount_jpy = Number(document.getElementById("cash-amount").value);
  await record({ type: "spend.cash", purpose, amount_jpy, currency: "JPY" });
  ev.target.reset();
});

function renderPremiumRoi() {
  const el = document.getElementById("premium-roi-hint");
  const spent = cashSpendTotal(EVENTS, "premium_pass");
  const saved = premiumFeeSavings(EVENTS);
  if (spent === 0 && saved === 0) {
    el.textContent = "PREMIUMパスの支出・節約実績はまだありません。";
    return;
  }
  const diff = saved - spent;
  const verdict =
    diff >= 0
      ? `手数料の節約だけで元が取れています（+${diff.toLocaleString()}相当、下限判定）。`
      : `手数料の節約分だけでは ${Math.abs(diff).toLocaleString()} 分届いていません（他の特典込みで判断してください）。`;
  el.textContent = `支出 ${spent.toLocaleString()}円 / 手数料節約 ${saved.toLocaleString()}pt。${verdict}`;
}

// --- 損益 ---
function renderProfit() {
  const tbody = document.getElementById("profit-body");
  const summary = document.getElementById("profit-summary");
  if (!tbody || !summary) return;

  const p = computeProfit(EVENTS);
  const sign = (n) => (n >= 0 ? "+" : "");

  summary.innerHTML =
    '<div class="balance-hero" style="margin-bottom:8px">' +
    '<span class="num" style="color:' +
    (p.totalProfit >= 0 ? "var(--ok)" : "var(--danger)") +
    '">' +
    sign(p.totalProfit) +
    Math.round(p.totalProfit).toLocaleString() +
    '</span><span class="unit">pt（実現損益）</span></div>' +
    '<p class="muted">内訳: 転売 ' +
    sign(p.resaleProfit) + Math.round(p.resaleProfit).toLocaleString() +
    "pt（" + p.resaleCount + "件） / 自力入手 " +
    sign(p.selfProfit) + Math.round(p.selfProfit).toLocaleString() +
    "pt（" + p.selfCount + "件）</p>" +
    '<p class="muted">売上 ' +
    p.totalRevenue.toLocaleString() +
    "pt / 売却 " +
    p.rows.length +
    "件" +
    (p.unknownCostCount
      ? " / <b>原価不明 " + p.unknownCostCount + "件は合計に含まれていない</b>"
      : "") +
    "</p>";

  // 私用の支出は売買の成績とは別のものなので、混ぜずに並べて見せる。
  const ps = document.getElementById("personal-spending");
  if (ps) {
    const sp = personalSpending(EVENTS);
    if (!sp.total) {
      ps.innerHTML = "";
    } else {
      ps.innerHTML =
        '<p class="muted" style="margin-top:10px">自分で使った分 <b>' +
        sp.total.toLocaleString() +
        "pt</b>（上の実現損益には含めていない）</p>" +
        '<table><thead><tr><th>アイテム</th><th>個数</th><th>支出</th></tr></thead><tbody>' +
        sp.rows
          .map(
            (r) =>
              "<tr><td>" + escapeHtml(r.item) + "</td><td>" + r.qty +
              "</td><td>" + r.total.toLocaleString() + "pt</td></tr>"
          )
          .join("") +
        "</tbody></table>";
    }
  }

  tbody.innerHTML = "";
  for (const r of p.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + fmtDate(r.ts) + "</td>" +
      "<td>" + escapeHtml(r.itemId) + "</td>" +
      "<td>" + r.qty + "</td>" +
      "<td>" + r.revenue.toLocaleString() + "pt</td>" +
      "<td>" + (r.known ? Math.round(r.cost).toLocaleString() + "pt" : "<span class='muted'>不明</span>") + "</td>" +
      "<td>" + r.fee.toLocaleString() + "pt</td>" +
      "<td>" +
      (r.known
        ? "<b style=\"color:" + (r.profit >= 0 ? "var(--ok)" : "var(--danger)") + "\">" +
          sign(r.profit) + Math.round(r.profit).toLocaleString() + "pt</b>"
        : "<span class='muted'>—</span>") +
      "</td>";
    tbody.appendChild(tr);
  }
}

// --- ログ ---
function renderLog() {
  const tbody = document.getElementById("log-body");
  tbody.innerHTML = "";
  const showVoided = document.getElementById("log-show-voided").checked;
  const voided = voidedIds(EVENTS);

  // void 記録そのものは一覧に出さない（何を取り消したかは対象行の打ち消し線で分かる）
  let list = EVENTS.filter((e) => e.type !== "void");
  if (!showVoided) list = list.filter((e) => !voided.has(e.id));

  // 種別で絞る。古い購入を訂正したいのに一覧から溢れて届かない、ということが
  // 起きたため、探し方を用意する。値は "a|b" で複数の種別をまとめて指す。
  const typeSel = document.getElementById("log-filter-type");
  const wanted = typeSel && typeSel.value ? typeSel.value.split("|") : null;
  if (wanted) list = list.filter((e) => wanted.includes(e.type));

  // 用途で絞る。用途を持つのは購入だけなので、指定すると購入だけが残る。
  const purposeSel = document.getElementById("log-filter-purpose");
  const wantedPurpose = purposeSel ? purposeSel.value : "";
  if (wantedPurpose) {
    list = list.filter((e) => e.type === "buy" && buyPurpose(e) === wantedPurpose);
  }

  const total = list.length;
  const limitSel = document.getElementById("log-limit");
  const limit = limitSel ? Number(limitSel.value) : 40;
  const shown = limit > 0 ? list.slice(-limit) : list;

  const countEl = document.getElementById("log-count");
  if (countEl) {
    countEl.textContent =
      total === shown.length
        ? `${total}件（すべて表示）`
        : `${total}件のうち新しい${shown.length}件を表示`;
  }

  for (const e of shown.reverse()) {
    const isVoided = voided.has(e.id);
    const tr = document.createElement("tr");
    if (isVoided) tr.style.textDecoration = "line-through";
    if (isVoided) tr.style.opacity = "0.55";

    let tdActions = "";
    if (READ_ONLY) {
      tdActions = "";
    } else if (isVoided) {
      tdActions = '<span class="muted">取消済</span>';
    } else if (EDITABLE_TYPES.has(e.type)) {
      tdActions =
        '<button class="small secondary" data-act="edit">訂正</button> ' +
        '<button class="small secondary" data-act="void">取消</button>';
    } else if (VOIDABLE_TYPES.has(e.type)) {
      // 値は直せないが、取り消せば出品の状態が前に戻る
      tdActions = '<button class="small secondary" data-act="void">取消</button>';
    }

    tr.innerHTML =
      "<td>" + fmtDate(e.ts) + "</td><td>" + e.type + "</td><td>" +
      describeEvent(e) + "</td><td>" + tdActions + "</td>";

    const edit = tr.querySelector('[data-act="edit"]');
    if (edit) edit.addEventListener("click", () => openEditRow(tr, e));
    const del = tr.querySelector('[data-act="void"]');
    if (del) del.addEventListener("click", () => voidEvent(e, "取消"));

    tbody.appendChild(tr);
  }
}

// 値を直せる記録。
//
// 売却も対象に入れる。売れていないものを売れたことにする押し間違いは実際に
// 起きるし、そのままだと架空の売上と利益が残り続ける（19,999ptの誤記録が
// 実際に発生した）。
const EDITABLE_TYPES = new Set([
  "buy", "income.quest", "quest.skip", "income.other", "spend.other", "spend.cash", "balance.observed",
  "sell.sold",
]);

// 値は持たないが取り消せる記録。
//
// 取り消すと出品の状態が前に戻る（売却を取り消せば出品中に復帰する）。
// 状態は記録から毎回組み立てているので、1本無効にするだけで整合が取れる。
const VOIDABLE_TYPES = new Set(["sell.cancel", "sell.expired"]);

// 各種別の編集対象フィールド（ラベル, キー, 数値か）
const EDIT_FIELDS = {
  "buy": [
    ["アイテム名", "item_id", false],
    ["総額(pt)", "total_price", true],
    ["個数", "qty", true],
    ["用途", "purpose", false, BUY_PURPOSES], // 4番目があるときは選択肢になる
  ],
  "sell.sold": [["総額(pt)", "price", true], ["個数", "qty", true]],
  "income.quest": [["金額(pt)", "amount", true]],
  "quest.skip": [["日付", "date", false]],
  "income.other": [["金額(pt)", "amount", true], ["内容", "source", false]],
  "spend.other": [["金額(pt)", "amount", true], ["理由", "reason", false]],
  "spend.cash": [["金額(円)", "amount_jpy", true], ["用途", "purpose", false]],
  "balance.observed": [["残高(pt)", "balance", true]],
};

// 取り消し記録を追記する。元の記録は消さない（設計方針1）。
async function voidEvent(ev, reason) {
  if (!confirm("この記録を取り消します。よろしいですか。\n\n" + describeEvent(ev).replace(/<[^>]*>/g, ""))) return;
  await record({ type: "void", target_id: ev.id, reason });
}

// 行をその場で編集フォームに変える。保存すると void + 新記録の2本を追記する。
function openEditRow(tr, ev) {
  const fields = EDIT_FIELDS[ev.type] || [];
  const td = document.createElement("td");
  td.colSpan = 4;
  td.innerHTML =
    '<div class="row" style="padding:6px 0">' +
    fields
      .map(([label, key, isNum, choices]) => {
        const head = '<div class="field"><label>' + label + "</label>";
        if (choices) {
          // 用途のように決まった値しか取らないものは、打ち間違えないよう選択にする
          const cur = ev.type === "buy" && key === "purpose" ? buyPurpose(ev) : ev[key];
          const opts = Object.entries(choices)
            .map(
              ([v, text]) =>
                '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + text + "</option>"
            )
            .join("");
          return head + '<select data-k="' + key + '">' + opts + "</select></div>";
        }
        return (
          head +
          '<input type="' + (isNum ? "number" : "text") + '" data-k="' + key + '" ' +
          (isNum ? 'step="0.1" ' : "") +
          'value="' + escapeHtml(ev[key] == null ? "" : String(ev[key])) + '" /></div>'
        );
      })
      .join("") +
    '<button class="small" data-act="save">保存</button>' +
    '<button class="small secondary" data-act="cancel">やめる</button>' +
    "</div>";

  const row = document.createElement("tr");
  row.appendChild(td);
  tr.replaceWith(row);

  td.querySelector('[data-act="cancel"]').addEventListener("click", renderLog);
  td.querySelector('[data-act="save"]').addEventListener("click", async () => {
    const next = { ...ev };
    delete next.id;
    for (const inp of td.querySelectorAll("input[data-k], select[data-k]")) {
      const k = inp.dataset.k;
      const isNum = inp.type === "number";
      next[k] = isNum ? Number(inp.value) : inp.value.trim();
    }
    // 元の ts は残す（事象の発生時刻を勝手に動かさない）
    next.ts = ev.ts;
    await record({ type: "void", target_id: ev.id, reason: "訂正" });
    await record(next);
  });
}

document.getElementById("log-show-voided").addEventListener("change", renderLog);
document.getElementById("log-filter-type").addEventListener("change", renderLog);
document.getElementById("log-filter-purpose").addEventListener("change", renderLog);
document.getElementById("log-limit").addEventListener("change", renderLog);

// 売却や取消の記録は listing_id しか持たない。どの出品のことか分からないと
// 訂正する行を選べないので、出品の記録から品名を引いて添える。
function listedItemName(listingId) {
  if (!listingId) return "(不明)";
  for (const ev of EVENTS) {
    if (ev.type === "sell.list" && ev.listing_id === listingId) {
      return escapeHtml(ev.item_id || "(未記入)");
    }
  }
  return "(出品の記録が見つかりません)";
}

function describeEvent(e) {
  switch (e.type) {
    case "balance.observed": return `残高 ${e.balance.toLocaleString()}pt`;
    case "income.quest": return `デイリークエスト +${e.amount}pt（${e.date}）`;
    case "quest.skip": return `デイリークエスト 未実施（${e.date}）`;
    case "buy": {
      const use = buyPurpose(e) === "use" ? "・私用" : "";
      return `購入${use}: ${escapeHtml(e.item_id)} ×${e.qty}（総額${e.total_price}pt）`;
    }
    case "sell.list": {
      const o = e.origin === "self" ? "・自力入手" : e.origin === "purchase" ? "・仕入れ品" : "";
      const each = e.qty > 1 ? `（1個${Math.round(e.price / e.qty).toLocaleString()}pt）` : "";
      return `出品${o}: ${escapeHtml(e.item_id)} ×${e.qty} 総額${e.price.toLocaleString()}pt${each}（手数料${e.fee}pt）`;
    }
    case "sell.sold": return `売却: ${listedItemName(e.listing_id)} ×${e.qty} 総額${e.price.toLocaleString()}pt`;
    case "sell.cancel": return `出品を取消: ${listedItemName(e.listing_id)}`;
    case "sell.expired": return `出品が期限切れ: ${listedItemName(e.listing_id)}`;
    case "sell.cancel": return `出品取消`;
    case "sell.expired": return `期限切れ`;
    case "spend.cash": return `現金支出 ¥${e.amount_jpy}（${e.purpose}）`;
    case "state.premium_pass": return `PREMIUMパス ${e.active ? "加入" : "未加入"}${e.until ? " 〜" + fmtDate(e.until) : ""}`;
    case "state.storage": return `倉庫 ${e.count}個`;
    default: return "";
  }
}

function renderItemDatalist() {
  const dl = document.getElementById("item-names");
  dl.innerHTML = "";
  for (const name of itemNames()) {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  }
}

// ---------------------------------------------------------------
// util
// ---------------------------------------------------------------
function fmtDate(ts) {
  if (!ts) return "";
  return ts.replace("T", " ").slice(0, 16);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------
// 常時表示の電卓。Storage/Ledger に依存せず、未接続でも動く。
// ---------------------------------------------------------------
(function initCalculator() {
  const display = document.getElementById("calc-display");
  const calcEl = document.getElementById("calculator");
  const toggleBtn = document.getElementById("calc-toggle");
  const applyBtn = document.getElementById("calc-apply");

  let current = "0";
  let previous = null;
  let pendingOp = null;
  let justEvaluated = false;

  function render() {
    display.value = current;
  }

  function inputDigit(d) {
    if (justEvaluated) {
      current = d;
      justEvaluated = false;
    } else {
      current = current === "0" ? d : current + d;
    }
    render();
  }

  function inputDot() {
    if (justEvaluated) {
      current = "0.";
      justEvaluated = false;
      return render();
    }
    if (!current.includes(".")) current += ".";
    render();
  }

  function backspace() {
    current = current.length > 1 ? current.slice(0, -1) : "0";
    render();
  }

  function clearAll() {
    current = "0";
    previous = null;
    pendingOp = null;
    justEvaluated = false;
    render();
  }

  function applyPending() {
    if (pendingOp == null || previous == null) return;
    const a = Number(previous);
    const b = Number(current);
    let result;
    switch (pendingOp) {
      case "+": result = a + b; break;
      case "-": result = a - b; break;
      case "*": result = a * b; break;
      case "/": result = b === 0 ? NaN : a / b; break;
    }
    // 浮動小数の誤差(0.1+0.2 など)を丸めて吸収する。
    current = String(Math.round((result + Number.EPSILON) * 1e8) / 1e8);
  }

  function inputOperator(op) {
    if (pendingOp != null && !justEvaluated) {
      applyPending();
      render();
    }
    previous = current;
    pendingOp = op;
    justEvaluated = true; // 次の数字入力で上書きさせる
  }

  function evaluate() {
    applyPending();
    pendingOp = null;
    previous = null;
    justEvaluated = true;
    render();
  }

  document.querySelector(".calc-grid").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-calc]");
    if (!btn) return;
    const key = btn.dataset.calc;
    if (key === "C") clearAll();
    else if (key === "back") backspace();
    else if (key === ".") inputDot();
    else if (key === "=") evaluate();
    else if (["+", "-", "*", "/"].includes(key)) inputOperator(key);
    else inputDigit(key);
  });

  // --- 開閉。状態は localStorage に覚えさせる。 ---
  const COLLAPSE_KEY = "choco-ledger-calc-collapsed";
  function setCollapsed(collapsed) {
    calcEl.classList.toggle("collapsed", collapsed);
    toggleBtn.textContent = collapsed ? "＋" : "－";
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) { /* 無視 */ }
  }
  toggleBtn.addEventListener("click", () => {
    setCollapsed(!calcEl.classList.contains("collapsed"));
  });
  try {
    if (localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
  } catch (e) { /* 無視 */ }

  // --- 「フォーカス中の入力欄へ反映」：電卓自身以外の直近フォーカスされた
  // number入力を覚えておき、そこへ計算結果を書き込む。 ---
  let lastFocusedInput = null;
  document.addEventListener("focusin", (ev) => {
    if (ev.target.matches('input[type="number"]') && !calcEl.contains(ev.target)) {
      lastFocusedInput = ev.target;
    }
  });
  applyBtn.addEventListener("click", () => {
    if (!lastFocusedInput || !document.body.contains(lastFocusedInput)) {
      setOcrStatusSafe("反映先の入力欄が見つかりません。金額欄などをクリックしてから電卓を使ってください。");
      return;
    }
    lastFocusedInput.value = current;
    lastFocusedInput.dispatchEvent(new Event("input", { bubbles: true }));
    lastFocusedInput.focus();
  });

  // buy-ocr-status が無いタブでも呼べるよう安全に。
  function setOcrStatusSafe(text) {
    const el = document.getElementById("buy-ocr-status");
    if (el) el.textContent = text;
  }

  render();
})();

// ---------------------------------------------------------------
// 相場タブ：バザー録画からの取り込み。
// ---------------------------------------------------------------
// 相場タブの配線（2026-09-12 保留）
// 利用者の判断で相場タブを UI から外した。処理は消していないので、
// index.html のパネルを戻せばそのまま動く。
// 要素が存在するかどうかで判定しているため、HTML を戻すだけで復帰する。
const marketDrop = document.getElementById("market-video-drop");
const MARKET_TAB_ENABLED = marketDrop !== null;
const marketFileInput = document.getElementById("market-video-file");
const marketStatusEl = document.getElementById("market-status");
const marketReviewTable = document.getElementById("market-review-table");
const marketReviewBody = document.getElementById("market-review-body");
const marketSaveBtn = document.getElementById("market-save-btn");
const itemReviewTable = document.getElementById("item-review-table");
const itemReviewBody = document.getElementById("item-review-body");
const itemSaveBtn = document.getElementById("item-save-btn");

let pendingMarketRows = []; // 解析結果（保存前のレビュー中データ）
let pendingItemRows = []; // アイテム図鑑候補（保存前のレビュー中データ）
let ITEM_CATALOG = []; // 蓄積済みのアイテム図鑑（items.json）

function setMarketStatus(text) {
  if (!marketStatusEl) return;
  marketStatusEl.textContent = text;
}

async function handleMarketVideo(file) {
  const { key, model } = loadGeminiSettings();
  if (!key || !model) {
    setMarketStatus("先に「取引」タブでGemini APIキーとモデルを設定してください。");
    return;
  }
  marketReviewTable.hidden = true;
  marketSaveBtn.hidden = true;
  itemReviewTable.hidden = true;
  itemSaveBtn.hidden = true;
  try {
    const already = marketBatches(MARKET_OBS).filter((b) => b.videoRef === file.name && !b.voided);
    if (already.length) {
      const ok = confirm(
        "この動画は既に " + already.length + " 回取り込まれています（" +
          already.map((b) => fmtDate(b.ts) + " " + b.count + "件").join(" / ") +
          "）。もう一度取り込むと観測が二重に積み上がります。続けますか。" +
          "（過去の取り込みは下の「取り込み履歴」から取り消せます）"
      );
      if (!ok) {
        setMarketStatus("取り込みを中止しました。");
        return;
      }
    }
    const { listings, items } = await analyzeMarketVideo(file, key, model, setMarketStatus);
    pendingMarketRows = listings.map((r) => ({
      item_name: r.item_name || "",
      price: r.price ?? null,
      qty: r.qty ?? null,
      remaining_days: r.remaining_days ?? null,
      enhancement_level: r.enhancement_level ?? null,
      core_code: r.core_code ?? null,
      listing_count: r.listing_count ?? null,
      video_ref: file.name,
      checked: true,
    }));
    pendingItemRows = items.map((r) => ({
      item_name: r.item_name || "",
      category: r.category ?? null,
      level_range: r.level_range ?? null,
      stats: Array.isArray(r.stats) ? r.stats : [],
      special_core_tier: r.special_core_tier ?? null,
      video_ref: file.name,
      checked: true,
    }));
    renderMarketReview();
    renderItemReview();
    setMarketStatus(
      `出品候補 ${pendingMarketRows.length}件、図鑑候補 ${pendingItemRows.length}件を検出しました。` +
        "内容を確認し、不要な行のチェックを外してから、それぞれ保存してください。"
    );
  } catch (e) {
    console.error(e);
    setMarketStatus(`解析に失敗しました（${e.message}）。`);
  }
}

function renderMarketReview() {
  if (!marketReviewBody) return;
  marketReviewBody.innerHTML = "";
  if (pendingMarketRows.length === 0) {
    marketReviewTable.hidden = true;
    marketSaveBtn.hidden = true;
    return;
  }
  pendingMarketRows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" ${row.checked ? "checked" : ""} data-idx="${i}" class="mr-check" /></td>
      <td><input type="text" value="${escapeHtml(row.item_name)}" data-idx="${i}" data-field="item_name" class="mr-field" style="width:100%" /></td>
      <td><input type="number" value="${row.price ?? ""}" data-idx="${i}" data-field="price" class="mr-field" style="width:80px" /></td>
      <td><input type="number" value="${row.qty ?? ""}" data-idx="${i}" data-field="qty" class="mr-field" style="width:60px" /></td>
      <td><input type="number" value="${row.remaining_days ?? ""}" data-idx="${i}" data-field="remaining_days" class="mr-field" style="width:60px" /></td>
      <td><input type="number" value="${row.enhancement_level ?? ""}" data-idx="${i}" data-field="enhancement_level" class="mr-field" style="width:60px" placeholder="装備のみ" /></td>
      <td><input type="text" value="${escapeHtml(row.core_code || "")}" data-idx="${i}" data-field="core_code" class="mr-field" style="width:80px" placeholder="コアなし" /></td>
      <td><input type="number" value="${row.listing_count ?? ""}" data-idx="${i}" data-field="listing_count" class="mr-field" style="width:60px" /></td>
      ${similarWarningCell(row.item_name, i, "mr")}
    `;
    marketReviewBody.appendChild(tr);
  });
  marketReviewBody.querySelectorAll(".mr-check").forEach((el) =>
    el.addEventListener("change", (e) => {
      pendingMarketRows[Number(e.target.dataset.idx)].checked = e.target.checked;
    })
  );
  marketReviewBody.querySelectorAll(".mr-field").forEach((el) =>
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const val = e.target.value;
      const isText = field === "item_name" || field === "core_code";
      pendingMarketRows[idx][field] = isText ? val || null : val === "" ? null : Number(val);
    })
  );
  wireSimilarFix(marketReviewBody, pendingMarketRows, renderMarketReview);
  marketReviewTable.hidden = false;
  marketSaveBtn.hidden = false;
}

if (MARKET_TAB_ENABLED) marketSaveBtn.addEventListener("click", async () => {
  const toSave = pendingMarketRows.filter((r) => r.checked && r.item_name && r.price != null);
  if (toSave.length === 0) {
    setMarketStatus("保存対象がありません（品名・価格が必要です）。");
    return;
  }
  const ts = nowLocalISO();
  setMarketStatus(`${toSave.length}件を保存中…`);
  // 1件ずつ保存するとファイル全体の読み書きが件数分繰り返され、目に見えて遅い。
  // まとめて1回で書く。
  await Storage.appendMarketObservations(
    toSave.map((row) => ({
      id: newId("mkt"),
      ts,
      source: "screen-recording",
      video_ref: row.video_ref,
      item_id: row.item_name,
      price: row.price,
      qty: row.qty,
      remaining_days: row.remaining_days,
      enhancement_level: row.enhancement_level,
      core_code: row.core_code,
      listing_count: row.listing_count,
    }))
  );
  MARKET_OBS = await Storage.readAllMarketObservations();
  renderMarketSummary();
  setMarketStatus(`${toSave.length}件を保存しました。`);
  pendingMarketRows = [];
  marketReviewTable.hidden = true;
  marketSaveBtn.hidden = true;
});

// --- アイテム図鑑候補のレビュー ---
function renderItemReview() {
  if (!itemReviewBody) return;
  itemReviewBody.innerHTML = "";
  if (pendingItemRows.length === 0) {
    itemReviewTable.hidden = true;
    itemSaveBtn.hidden = true;
    return;
  }
  pendingItemRows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const statsText = row.stats.map((s) => `${s.stat}+${s.value}`).join(" ");
    tr.innerHTML = `
      <td><input type="checkbox" ${row.checked ? "checked" : ""} data-idx="${i}" class="ir-check" /></td>
      <td><input type="text" value="${escapeHtml(row.item_name)}" data-idx="${i}" data-field="item_name" class="ir-field" style="width:100%" /></td>
      <td><input type="text" value="${escapeHtml(row.category || "")}" data-idx="${i}" data-field="category" class="ir-field" style="width:80px" /></td>
      <td><input type="text" value="${escapeHtml(row.level_range || "")}" data-idx="${i}" data-field="level_range" class="ir-field" style="width:70px" /></td>
      <td><input type="text" value="${escapeHtml(statsText)}" data-idx="${i}" data-field="stats_text" class="ir-field" style="width:100%" placeholder="ATK+777 POW+60" /></td>
      <td><input type="text" value="${escapeHtml(row.special_core_tier || "")}" data-idx="${i}" data-field="special_core_tier" class="ir-field" style="width:90px" /></td>
      ${similarWarningCell(row.item_name, i, "ir")}
    `;
    itemReviewBody.appendChild(tr);
  });
  itemReviewBody.querySelectorAll(".ir-check").forEach((el) =>
    el.addEventListener("change", (e) => {
      pendingItemRows[Number(e.target.dataset.idx)].checked = e.target.checked;
    })
  );
  itemReviewBody.querySelectorAll(".ir-field").forEach((el) =>
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const val = e.target.value;
      if (field === "stats_text") {
        // "ATK+777 POW+60" のような手直し文字列を再パースする
        pendingItemRows[idx].stats = val
          .split(/\s+/)
          .filter(Boolean)
          .map((tok) => {
            const m = tok.match(/^([A-Za-z]+)\+?(-?\d+)$/);
            return m ? { stat: m[1], value: Number(m[2]) } : null;
          })
          .filter(Boolean);
      } else {
        pendingItemRows[idx][field] = val || null;
      }
    })
  );
  wireSimilarFix(itemReviewBody, pendingItemRows, renderItemReview);
  itemReviewTable.hidden = false;
  itemSaveBtn.hidden = false;
}

// 既存の図鑑エントリを壊さず、空欄だけ埋める形でマージする。
// 「投げれば投げるほど良くなる」を実現する核心部分：
// 良い情報を後から来た薄い情報で上書きしない。
function mergeItemIntoCatalog(catalog, incoming, videoRef, ts) {
  // 照合は正規化した鍵で行う。id には鍵を、display_name には最初に見た表記を入れる。
  const key = normalizeItemName(incoming.item_name);
  const idx = catalog.findIndex((it) => normalizeItemName(it.id) === key);
  const sourceEntry = `${videoRef} (${ts})`;

  if (idx === -1) {
    catalog.push({
      id: key,
      display_name: incoming.item_name,
      category: incoming.category || null,
      level_range: incoming.level_range || null,
      stats: incoming.stats && incoming.stats.length ? incoming.stats : [],
      special_core_tier: incoming.special_core_tier || null,
      last_seen: ts,
      sources: [sourceEntry],
    });
    return "added";
  }

  const existing = catalog[idx];
  let enriched = false;
  if (!existing.category && incoming.category) { existing.category = incoming.category; enriched = true; }
  if (!existing.level_range && incoming.level_range) { existing.level_range = incoming.level_range; enriched = true; }
  if (!existing.special_core_tier && incoming.special_core_tier) { existing.special_core_tier = incoming.special_core_tier; enriched = true; }
  if ((!existing.stats || existing.stats.length === 0) && incoming.stats && incoming.stats.length) {
    existing.stats = incoming.stats;
    enriched = true;
  }
  existing.last_seen = ts;
  if (!existing.sources) existing.sources = [];
  if (!existing.sources.includes(sourceEntry)) existing.sources.push(sourceEntry);
  return enriched ? "enriched" : "seen-again";
}

if (MARKET_TAB_ENABLED) itemSaveBtn.addEventListener("click", async () => {
  const toSave = pendingItemRows.filter((r) => r.checked && r.item_name);
  if (toSave.length === 0) {
    setMarketStatus("図鑑に保存する対象がありません（品名が必要です）。");
    return;
  }
  const ts = nowLocalISO();
  let added = 0, enriched = 0, seenAgain = 0;
  for (const row of toSave) {
    const result = mergeItemIntoCatalog(ITEM_CATALOG, row, row.video_ref, ts);
    if (result === "added") added++;
    else if (result === "enriched") enriched++;
    else seenAgain++;
  }
  await Storage.writeItems(ITEM_CATALOG);
  renderItemCatalog();
  setMarketStatus(
    `図鑑を更新しました（新規${added}件・情報を追加${enriched}件・変化なし${seenAgain}件）。`
  );
  pendingItemRows = [];
  itemReviewTable.hidden = true;
  itemSaveBtn.hidden = true;
});

function renderItemCatalog() {
  const tbody = document.getElementById("item-catalog-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  const sorted = [...ITEM_CATALOG].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  for (const it of sorted) {
    const statsText = (it.stats || []).map((s) => `${s.stat}+${s.value}`).join(" ");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(it.display_name)}</td>
      <td>${escapeHtml(it.category || "—")}</td>
      <td>${escapeHtml(it.level_range || "—")}</td>
      <td>${escapeHtml(statsText || "—")}</td>
      <td>${escapeHtml(it.special_core_tier || "—")}</td>
      <td>${(it.sources || []).length}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderMarketBatches() {
  const el = document.getElementById("market-batches");
  if (!el) return;
  const batches = marketBatches(MARKET_OBS);
  if (batches.length === 0) {
    el.innerHTML = '<p class="muted">まだ取り込みがありません。</p>';
    return;
  }
  el.innerHTML =
    '<table><thead><tr><th>取り込み日時</th><th>動画</th><th>件数</th><th></th></tr></thead><tbody>' +
    batches
      .map(
        (b) =>
          '<tr' + (b.voided ? ' style="text-decoration:line-through;opacity:.55"' : "") + ">" +
          "<td>" + fmtDate(b.ts) + "</td>" +
          "<td>" + escapeHtml(b.videoRef || "—") + "</td>" +
          "<td>" + b.count + "件</td>" +
          "<td>" +
          (b.voided
            ? '<span class="muted">取消済</span>'
            : '<button class="small secondary" data-void-batch="' + b.ts + '">取り消す</button>') +
          "</td></tr>"
      )
      .join("") +
    "</tbody></table>";

  el.querySelectorAll("[data-void-batch]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ts = btn.dataset.voidBatch;
      if (!confirm("この取り込み分の観測をすべて取り消します。よろしいですか。")) return;
      await Storage.appendMarketObservation({
        id: newId("mkv"),
        ts: nowLocalISO(),
        type: "void",
        target_batch: ts,
        reason: "取り込みの取り消し",
      });
      MARKET_OBS = await Storage.readAllMarketObservations();
      renderMarketSummary();
      renderMarketBatches();
      setMarketStatus("取り込み1回分を取り消しました。");
    })
  );
}

function renderMarketSummary() {
  const tbody = document.getElementById("market-summary-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  const rows = summarizeMarket(activeMarketObs(MARKET_OBS));
  const fmtUnit = (u) => (u == null ? "—" : Math.round(u).toLocaleString() + "pt");

  for (const r of rows) {
    const spread = r.minUnit && r.maxUnit && r.minUnit > 0 ? r.maxUnit / r.minUnit : null;
    const discount =
      r.bundleDiscount != null && r.bundleDiscount > 0.05
        ? '<span style="color:var(--ok)">まとめ買いで' + Math.round(r.bundleDiscount * 100) + "%安</span>"
        : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(r.item) + "</td>" +
      '<td><b>' + fmtUnit(r.latestMinUnit) + "</b></td>" +
      "<td>" + fmtUnit(r.minUnit) + " 〜 " + fmtUnit(r.maxUnit) +
      (spread && spread >= 2 ? ' <span class="muted">(' + spread.toFixed(1) + "倍)</span>" : "") +
      "</td>" +
      "<td>" + (r.listingCount ?? "—") + "</td>" +
      "<td>" + r.observations + "件 / " + r.timePoints + "時点</td>" +
      "<td>" + fmtDate(r.latestTs) + "</td>" +
      "<td>" + discount + "</td>";
    tbody.appendChild(tr);
  }

  // 時点が1つしかない間は「相場」ではなく「今の値段」でしかない。
  // それを取り違えると判断を誤るので、状態を明示する。
  const note = document.getElementById("market-summary-note");
  if (note) {
    const maxTimes = rows.reduce((m, r) => Math.max(m, r.timePoints), 0);
    note.innerHTML =
      maxTimes <= 1
        ? '<span style="color:var(--danger)">観測が1時点しかないため、これは「相場」ではなく' +
          "「その時点で見えた最安値」です。高いか安いかを判断するには、日を変えて何度か取り込んでください。</span>"
        : '<span class="muted">最大 ' + maxTimes + " 時点の観測があります。時点が増えるほど相場の判断に使えます。</span>";
  }
}

if (MARKET_TAB_ENABLED) ocrDropLikeHandlers(marketDrop, marketFileInput, handleMarketVideo);

// buy-ocr-drop / market-video-drop 共通のドラッグ&ドロップ・貼り付け・クリック配線。
function ocrDropLikeHandlers(dropEl, fileInputEl, onFile) {
  dropEl.addEventListener("click", () => fileInputEl.click());
  dropEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInputEl.click();
  });
  fileInputEl.addEventListener("change", () => {
    if (fileInputEl.files[0]) onFile(fileInputEl.files[0]);
  });
  dropEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropEl.classList.add("dragover");
  });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}
document.addEventListener("paste", (e) => {
  const marketPanel = document.querySelector('.tab-panel[data-tab-panel="market"]');
  if (!marketPanel || marketPanel.hidden) return;
  const item = [...(e.clipboardData?.items || [])].find(
    (i) => i.type.startsWith("video/") || i.type.startsWith("image/")
  );
  if (item) handleMarketVideo(item.getAsFile());
});

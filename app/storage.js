// storage.js — File System Access API によるデータ永続化層。
// ledger/data/ 配下のファイルを直接読み書きする。設計.md 6.1 参照。

const DB_NAME = "choco-ledger";
const DB_STORE = "handles";
const DIR_KEY = "dataDir";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const Storage = {
  _dirHandle: null,

  // 起動時：前回許可したフォルダーハンドルの復元を試みる。
  async tryRestore() {
    const handle = await idbGet(DIR_KEY);
    if (!handle) return false;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      this._dirHandle = handle;
      return true;
    }
    // 再許可はユーザー操作が必要なため、ここでは要求しない。
    this._dirHandle = handle;
    return "needs-permission";
  },

  async requestPermission() {
    if (!this._dirHandle) return false;
    const perm = await this._dirHandle.requestPermission({ mode: "readwrite" });
    return perm === "granted";
  },

  // ユーザー操作から呼ぶ：ledger/data フォルダーを選ばせる。
  async pickDirectory() {
    const handle = await window.showDirectoryPicker({
      mode: "readwrite",
      startIn: "documents",
    });
    this._dirHandle = handle;
    await idbSet(DIR_KEY, handle);
    return handle;
  },

  isConnected() {
    return !!this._dirHandle;
  },

  async _getSubHandle(path, { create = true } = {}) {
    const parts = path.split("/").filter(Boolean);
    let dir = this._dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    }
    return { dir, name: parts[parts.length - 1] };
  },

  async readText(path) {
    try {
      const { dir, name } = await this._getSubHandle(path, { create: false });
      const fileHandle = await dir.getFileHandle(name, { create: false });
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      if (e.name === "NotFoundError") return null;
      throw e;
    }
  },

  async writeText(path, text) {
    const { dir, name } = await this._getSubHandle(path, { create: true });
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  },

  async appendLine(path, line) {
    return this.appendLines(path, [line]);
  },

  // 複数行を1回の読み書きで追記する。
  //
  // appendLine は「全部読む→連結→全部書く」という実装で、真の追記ではない
  // （File System Access API に追記モードが無いため）。1件ずつ呼ぶと件数の
  // 二乗でファイル入出力が増える。実際、相場86件の保存で 69KB のファイルを
  // 86回読み書きしており、目に見えて遅かった。
  async appendLines(path, lines) {
    if (!lines || lines.length === 0) return;
    const existing = (await this.readText(path)) || "";
    const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
    await this.writeText(path, existing + sep + lines.join("\n") + "\n");
  },

  // events/ 配下の全 .jsonl ファイル名を列挙。
  async listEventFiles() {
    const dir = await this._dirHandle.getDirectoryHandle("events", { create: true });
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".jsonl")) names.push(name);
    }
    return names.sort();
  },

  async readAllEvents() {
    const files = await this.listEventFiles();
    const events = [];
    for (const name of files) {
      const text = await this.readText(`events/${name}`);
      if (!text) continue;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          events.push(JSON.parse(t));
        } catch (e) {
          console.error("イベント行の解析に失敗:", name, t, e);
        }
      }
    }
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return events;
  },

  async appendEvent(event) {
    const ym = event.ts.slice(0, 7); // "2026-09"
    await this.appendLine(`events/${ym}.jsonl`, JSON.stringify(event));
    await this.writeIndex();
  },

  // HTTP ではディレクトリの一覧が取れない。スマホから読むときのために、
  // どの月のファイルがあるかを index.json に書き出しておく。
  // 記録のたびに更新するので、書き忘れて古くなることがない。
  async writeIndex() {
    try {
      const index = {
        events: await this.listEventFiles(),
        market: await this.listMarketFiles(),
        generated: new Date().toISOString(),
      };
      await this.writeText("index.json", JSON.stringify(index, null, 2));
    } catch (e) {
      console.error("index.json の更新に失敗:", e);
    }
  },

  async readItems() {
    const text = await this.readText("items.json");
    return text ? JSON.parse(text) : [];
  },

  async writeItems(items) {
    await this.writeText("items.json", JSON.stringify(items, null, 2));
  },

  // --- 相場観測（他人の情報）。events/ とは別の場所に置く（設計方針2）。 ---
  async listMarketFiles() {
    const dir = await this._dirHandle.getDirectoryHandle("market", { create: true });
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(".jsonl")) names.push(name);
    }
    return names.sort();
  },

  async readAllMarketObservations() {
    const files = await this.listMarketFiles();
    const obs = [];
    for (const name of files) {
      const text = await this.readText(`market/${name}`);
      if (!text) continue;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          obs.push(JSON.parse(t));
        } catch (e) {
          console.error("相場観測行の解析に失敗:", name, t, e);
        }
      }
    }
    obs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return obs;
  },

  async appendMarketObservation(obs) {
    await this.appendMarketObservations([obs]);
  },

  // 複数の相場観測をまとめて保存する。取り込み1回分は同じ ts を共有するため
  // 実際には1ファイルに収まるが、汎用のため年月ごとに振り分けてから書く。
  async appendMarketObservations(list) {
    if (!list || list.length === 0) return;
    const byMonth = new Map();
    for (const obs of list) {
      const ym = obs.ts.slice(0, 7);
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(JSON.stringify(obs));
    }
    for (const [ym, lines] of byMonth) {
      await this.appendLines(`market/${ym}.jsonl`, lines);
    }
  },
};

window.Storage = Storage;

// ---------------------------------------------------------------
// 読み取り専用ストレージ（HTTP 経由）
//
// スマホから見るため。File System Access API はスマホのブラウザーに無いので、
// ローカルフォルダは開けない。かわりに、同じ場所に置いてあるデータファイルを
// HTTP で取りに行く。
//
// HTTP ではディレクトリの一覧が取れないため、どの月のファイルがあるかを
// data/index.json に書いておき、それを見る。書き込み系は一切持たない。
// ---------------------------------------------------------------
const HttpStorage = {
  base: "../data",
  _index: null,

  async _json(path) {
    const res = await fetch(`${this.base}/${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} を取得できません (HTTP ${res.status})`);
    return res.json();
  },

  async _text(path) {
    const res = await fetch(`${this.base}/${path}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} を取得できません (HTTP ${res.status})`);
    return res.text();
  },

  async _list(kind) {
    if (!this._index) this._index = await this._json("index.json");
    return this._index[kind] || [];
  },

  async _readJsonl(dir, kind) {
    const out = [];
    for (const name of await this._list(kind)) {
      const text = await this._text(`${dir}/${name}`);
      if (!text) continue;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch (e) {
          console.error("行の解析に失敗:", name, t, e);
        }
      }
    }
    return out;
  },

  async readAllEvents() {
    const events = await this._readJsonl("events", "events");
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return events;
  },

  async readAllMarketObservations() {
    return this._readJsonl("market", "market");
  },

  async readItems() {
    const text = await this._text("items.json");
    return text ? JSON.parse(text) : [];
  },
};

window.HttpStorage = HttpStorage;

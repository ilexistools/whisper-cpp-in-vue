// src/lib/persist.js
// Persistência robusta (IndexedDB) com autosave, múltiplas sessões e sessão ativa.

export function createPersist(opts) {
  const {
    getTranscriptHtml,
    getNLines,
    getModel,
    getLanguage,
    getWasRecording,

    setTranscriptHtml,
    setNLines,
    setModel,
    setLanguage,

    onBanner,
    onPersistUI,
  } = opts || {};

  const PERSIST = {
    DB_NAME: "whisper_stream_persist",
    DB_VER: 1,
    STORE_SESS: "sessions",
    STORE_META: "meta",
    META_KEY_ACTIVE: "activeSessionId",
    AUTOSAVE_MS: 1000,
    MAX_SESSIONS: 25,
  };

  let db = null;
  let ready = false;
  let activeSessionId = null;

  let autosaveTimer = null;
  let autosaveDirty = false;
  let lastSavedHash = "";

  function nowISO() {
    return new Date().toISOString();
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
      return "—";
    }
  }

  function shortId(id) {
    if (!id) return "—";
    return id.length <= 10 ? id : id.slice(0, 6) + "…" + id.slice(-4);
  }

  function ui(patch) {
    try {
      onPersistUI && onPersistUI(patch);
    } catch {}
  }

  function banner(msg) {
    try {
      onBanner && onBanner(msg);
    } catch {}
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(PERSIST.DB_NAME, PERSIST.DB_VER);

      req.onupgradeneeded = () => {
        const d = req.result;

        if (!d.objectStoreNames.contains(PERSIST.STORE_SESS)) {
          const os = d.createObjectStore(PERSIST.STORE_SESS, { keyPath: "id" });
          os.createIndex("updatedAt", "updatedAt", { unique: false });
        }

        if (!d.objectStoreNames.contains(PERSIST.STORE_META)) {
          d.createObjectStore(PERSIST.STORE_META, { keyPath: "key" });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode = "readonly") {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  }

  function idbGet(storeName, key) {
    return new Promise((resolve, reject) => {
      const os = tx(storeName, "readonly");
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(storeName, value) {
    return new Promise((resolve, reject) => {
      const os = tx(storeName, "readwrite");
      const req = os.put(value);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function idbDelete(storeName, key) {
    return new Promise((resolve, reject) => {
      const os = tx(storeName, "readwrite");
      const req = os.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAllSessions() {
    return new Promise((resolve, reject) => {
      const os = tx(PERSIST.STORE_SESS, "readonly");
      const idx = os.index("updatedAt");
      const req = idx.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        resolve(all);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function newSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  }

  async function trimOldSessions() {
    const all = await idbGetAllSessions();
    if (all.length <= PERSIST.MAX_SESSIONS) return;

    const toRemove = all.slice(PERSIST.MAX_SESSIONS);
    for (const s of toRemove) {
      await idbDelete(PERSIST.STORE_SESS, s.id);
    }
  }

  async function refreshSessionsUI() {
    const all = await idbGetAllSessions();
    const uiSessions = all.map((s) => ({
      id: s.id,
      title: s.title || shortId(s.id),
      updatedAt: s.updatedAt || null,
      model: s.model || null,
      isActive: s.id === activeSessionId,
    }));

    ui({ sessions: uiSessions });
  }

  async function setActiveSession(id) {
    activeSessionId = id;
    await idbPut(PERSIST.STORE_META, {
      key: PERSIST.META_KEY_ACTIVE,
      value: id,
      updatedAt: nowISO(),
    });

    ui({
      activeSessionLabel: shortId(activeSessionId),
    });

    await refreshSessionsUI();
  }

  async function createNewSession(makeActive = true) {
    const id = newSessionId();

    const sess = {
      id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      title: `Sessão ${new Date().toLocaleString()}`,
      transcriptHTML: "",
      nLines: 0,
      model: getModel?.() || null,
      language: getLanguage?.() || "pt",
      wasRecording: false,
    };

    await idbPut(PERSIST.STORE_SESS, sess);

    if (makeActive) await setActiveSession(id);

    await trimOldSessions();
    await refreshSessionsUI();

    ui({
      lastSaveLabel: "—",
      lastModelLabel: sess.model || "—",
      activeSessionLabel: shortId(activeSessionId),
    });

    return id;
  }

  async function restoreSessionById(id) {
    const sess = await idbGet(PERSIST.STORE_SESS, id);
    if (!sess) {
      banner("Nenhuma sessão encontrada para recuperar.");
      return false;
    }

    if (sess.language) setLanguage?.(sess.language);
    if (sess.model) setModel?.(sess.model);

    setTranscriptHtml?.(sess.transcriptHTML || "");
    setNLines?.(Number.isFinite(sess.nLines) ? sess.nLines : 0);

    ui({
      lastSaveLabel: fmtTime(sess.updatedAt),
      lastModelLabel: sess.model || "—",
      activeSessionLabel: shortId(activeSessionId),
    });

    if (sess.wasRecording) {
      banner("Recuperado! A sessão anterior estava gravando. Clique em Iniciar para continuar (o navegador exige interação).");
    } else {
      banner("Sessão recuperada. Você pode continuar normalmente.");
    }

    return true;
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function markDirty() {
    autosaveDirty = true;
  }

  async function autosaveNow(reason = "autosave") {
    if (!ready || !activeSessionId) return;
    if (!autosaveDirty && reason === "autosave") return;

    const html = getTranscriptHtml?.() || "";
    const n = getNLines?.() ?? 0;
    const m = getModel?.() || "";
    const lang = getLanguage?.() || "pt";
    const rec = getWasRecording?.() ? "1" : "0";

    const h = simpleHash(html + "|" + n + "|" + m + "|" + lang + "|" + rec);
    if (h === lastSavedHash && reason === "autosave") {
      autosaveDirty = false;
      return;
    }

    const sess = await idbGet(PERSIST.STORE_SESS, activeSessionId);
    if (!sess) return;

    sess.transcriptHTML = html;
    sess.nLines = Number.isFinite(n) ? n : sess.nLines;
    sess.model = m || sess.model || null;
    sess.language = lang || sess.language || "pt";
    sess.updatedAt = nowISO();
    sess.wasRecording = !!getWasRecording?.();

    await idbPut(PERSIST.STORE_SESS, sess);

    lastSavedHash = h;
    autosaveDirty = false;

    ui({
      lastSaveLabel: fmtTime(sess.updatedAt),
      lastModelLabel: sess.model || "—",
      activeSessionLabel: shortId(activeSessionId),
    });

    await refreshSessionsUI();
  }

  function scheduleAutosave() {
    if (!ready) return;
    markDirty();
    if (autosaveTimer) return;

    autosaveTimer = setTimeout(async () => {
      autosaveTimer = null;
      try {
        await autosaveNow("autosave");
      } catch {
        ui({ persistState: "erro ao salvar (tentaremos novamente)" });
      }
    }, PERSIST.AUTOSAVE_MS);
  }

  async function deleteSession(id) {
    await idbDelete(PERSIST.STORE_SESS, id);

    // se apagou a ativa, cria outra ativa
    if (id === activeSessionId) {
      activeSessionId = null;
      await idbDelete(PERSIST.STORE_META, PERSIST.META_KEY_ACTIVE);

      await createNewSession(true);
      banner("Sessão apagada. Uma nova sessão ativa foi criada.");
    }

    await refreshSessionsUI();
    scheduleAutosave();
  }

  async function init() {
    try {
      ui({ persistState: "abrindo banco…" });

      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }

      db = await idbOpen();
      ready = true;

      ui({ persistState: "ativo" });

      const meta = await idbGet(PERSIST.STORE_META, PERSIST.META_KEY_ACTIVE);
      activeSessionId = meta?.value || null;

      if (!activeSessionId) {
        await createNewSession(true);
      } else {
        const existing = await idbGet(PERSIST.STORE_SESS, activeSessionId);
        if (!existing) await createNewSession(true);
      }

      ui({
        activeSessionLabel: shortId(activeSessionId),
        lastModelLabel: getModel?.() || "—",
        lastSaveLabel: "—",
      });

      await refreshSessionsUI();

      // tenta recuperar sessão ativa (continuidade)
      await restoreSessionById(activeSessionId);

      ui({ persistState: "ativo" });

      return true;
    } catch (e) {
      ready = false;
      ui({ persistState: "indisponível (sem IndexedDB)" });
      banner("Atenção: IndexedDB não disponível. Sem persistência robusta.");
      // eslint-disable-next-line no-console
      console.error("Persist init failed:", e);
      return false;
    }
  }

  function getActiveSessionId() {
    return activeSessionId;
  }

  function setLastModel(m) {
    ui({ lastModelLabel: m || "—" });
  }

  return {
    init,
    scheduleAutosave,
    autosaveNow,
    createNewSession,
    restoreSessionById,
    deleteSession,
    setActiveSession,
    getActiveSessionId,
    setLastModel,
  };
}

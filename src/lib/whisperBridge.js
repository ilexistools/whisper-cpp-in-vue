// src/lib/whisperBridge.js
// Ponte entre Vue e os scripts padrão do whisper.cpp (helpers.js + libstream.js)
// Estratégia ORIGINAL do stream.wasm + compatível com App.vue
// Ajuste: NÃO limita linhas e EVITA duplicação de trechos repetidos

export function createWhisperBridge(opts) {
  const {
    onBanner,
    onStatus,
    onTimer,
    onTranscriptHtml,
    onPartialText,
    onDebug,
    onModelProgress,
    onModelLoaded,
    onModelError,
    getLanguage,
    persist,
  } = opts || {};

  // -----------------------------
  // Estado (igual ao exemplo)
  // -----------------------------
  let context = null;

  // buffers
  let audio = null;
  let audio0 = null;

  // whisper instance
  let instance = null;

  // transcript
  let transcribedAll = "";
  let nLines = 0; // agora é só contador (opcional)
  let intervalUpdate = null;

  // model
  let model_whisper = null;

  // -----------------------------
  // Constantes ORIGINAIS (stream.wasm)
  // -----------------------------
  const kSampleRate = 16000;
  const kRestartRecording_s = 120;
  const kIntervalAudio_ms = 5000;

  let mediaRecorder = null;
  let doRecording = false;
  let startTime = 0;

  window.AudioContext = window.AudioContext || window.webkitAudioContext;
  window.OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  // -----------------------------
  // Anti-duplicação (NOVO)
  // -----------------------------
  let lastAppended = "";              // último trecho anexado
  const recentWindow = [];            // janela de trechos recentes
  const RECENT_MAX = 12;              // tamanho da janela (pequeno, eficiente)

  function normalizeChunk(s) {
    // normalização leve pra comparar sem “enganos” por espaço/pontuação
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/<br\s*\/?>/gi, "<br>")
      .trim();
  }

  function shouldAppend(chunkRaw) {
    const chunk = normalizeChunk(chunkRaw);
    if (!chunk || chunk.length < 2) return false;

    const last = normalizeChunk(lastAppended);

    // 1) idêntico ao último -> ignora
    if (chunk === last) return false;

    // 2) apareceu recentemente -> ignora (evita eco curto)
    for (const r of recentWindow) {
      if (chunk === r) return false;
    }

    // 3) alguns builds devolvem texto cumulativo (crescendo)
    //    Se o chunk começa com o último, tenta anexar só o sufixo novo.
    //    Ex: last="oi" chunk="oi tudo bem" => anexa "tudo bem"
    if (last && chunk.startsWith(last) && chunk.length > last.length + 1) {
      const suffix = chunk.slice(last.length).trim();
      if (suffix.length > 0) {
        // substitui o conteúdo bruto por só o sufixo (sem perder o HTML <br>)
        return { ok: true, append: suffix };
      }
    }

    return { ok: true, append: chunkRaw };
  }

  function pushRecent(chunkRaw) {
    const c = normalizeChunk(chunkRaw);
    if (!c) return;
    recentWindow.push(c);
    while (recentWindow.length > RECENT_MAX) recentWindow.shift();
  }

  // -----------------------------
  // Helpers UI
  // -----------------------------
  function dbg(msg) {
    try { onDebug && onDebug(String(msg)); } catch {}
  }

  function banner(msg) {
    try { onBanner && onBanner(String(msg)); } catch {}
  }

  function formatMMSS(ms) {
    const s0 = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s0 / 60);
    const s = s0 % 60;
    return String(m).padStart(2, "0") + "m " + String(s).padStart(2, "0") + "s";
  }

  function emitStatus() {
    try { onStatus && onStatus({ isRunning: !!doRecording }); } catch {}
  }

  function emitTimer() {
    try { onTimer && onTimer(doRecording ? formatMMSS(Date.now() - startTime) : "00m 00s"); } catch {}
  }

  function emitTranscript() {
    try {
      const val = transcribedAll && transcribedAll.length ? transcribedAll : "[A transcrição vai aparecer aqui]";
      onTranscriptHtml && onTranscriptHtml(val);
    } catch {}
  }

  function scheduleAutosave() {
    try { persist && persist.scheduleAutosave && persist.scheduleAutosave(); } catch {}
  }

  // -----------------------------
  // stopRecording (igual ao exemplo)
  // -----------------------------
  function stopRecording() {
    try {
      if (window.Module && window.Module.set_status) window.Module.set_status("paused");
    } catch {}

    doRecording = false;
    audio0 = null;
    audio = null;
    context = null;

    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch {}

    mediaRecorder = null;

    emitStatus();
    emitTimer();
    scheduleAutosave();
  }

  // -----------------------------
  // startRecording (estratégia ORIGINAL)
  // -----------------------------
  function startRecording() {
    if (!context) {
      context = new AudioContext({
        sampleRate: kSampleRate,
        channelCount: 1,
        echoCancellation: false,
        autoGainControl: true,
        noiseSuppression: true,
      });
    }

    try {
      if (window.Module && window.Module.set_status) window.Module.set_status("");
    } catch {}

    doRecording = true;
    startTime = Date.now();

    emitStatus();
    emitTimer();
    scheduleAutosave();

    let chunks = [];
    let stream = null;

    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(function (s) {
        stream = s;
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = function (e) {
          chunks.push(e.data);

          const blob = new Blob(chunks, { type: "audio/ogg; codecs=opus" });
          const reader = new FileReader();

          reader.onload = function () {
            const buf = new Uint8Array(reader.result);

            if (!context) return;

            context.decodeAudioData(
              buf.buffer,
              function (audioBuffer) {
                const offlineContext = new OfflineAudioContext(
                  audioBuffer.numberOfChannels,
                  audioBuffer.length,
                  audioBuffer.sampleRate
                );

                const source = offlineContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(offlineContext.destination);
                source.start(0);

                offlineContext.startRendering().then(function (renderedBuffer) {
                  audio = renderedBuffer.getChannelData(0);

                  const audioAll = new Float32Array(audio0 == null ? audio.length : audio0.length + audio.length);
                  if (audio0 != null) audioAll.set(audio0, 0);
                  audioAll.set(audio, audio0 == null ? 0 : audio0.length);

                  if (instance && window.Module && window.Module.set_audio) {
                    window.Module.set_audio(instance, audioAll);
                  }
                });
              },
              function () {
                audio = null;
              }
            );
          };

          reader.readAsArrayBuffer(blob);
        };

        mediaRecorder.onstop = function () {
          if (doRecording) {
            setTimeout(function () {
              startRecording();
            }, 0);
          }
        };

        mediaRecorder.start(kIntervalAudio_ms);
      })
      .catch(function (err) {
        dbg("js: error getting audio stream: " + err);
        banner("Erro ao acessar microfone. Verifique permissões.");
        doRecording = false;
        emitStatus();
      });

    const interval = setInterval(function () {
      if (!doRecording) {
        clearInterval(interval);

        try { if (mediaRecorder) mediaRecorder.stop(); } catch {}
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch {}

        mediaRecorder = null;
        scheduleAutosave();
        return;
      }

      if (audio != null && audio.length > kSampleRate * kRestartRecording_s) {
        clearInterval(interval);

        audio0 = audio;
        audio = null;

        try { if (mediaRecorder) mediaRecorder.stop(); } catch {}
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch {}

        scheduleAutosave();
      }

      emitTimer();
    }, 100);
  }

  // -----------------------------
  // init / instance
  // -----------------------------
  function ensureInstance() {
    if (instance) return true;
    if (!window.Module || !window.Module.init) return false;

    const lang = (getLanguage && getLanguage()) || "pt";
    instance = window.Module.init("whisper.bin", lang);

    if (instance) {
      dbg("js: whisper initialized, instance: " + instance);
      return true;
    }
    return false;
  }

  // -----------------------------
  // start / stop
  // -----------------------------
  function start() {
    if (!model_whisper) {
      banner("Carregue um modelo primeiro.");
      return false;
    }

    if (!ensureInstance()) {
      dbg("js: failed to initialize whisper");
      banner("Falha ao inicializar Whisper (veja Debug).");
      return false;
    }

    if (intervalUpdate) {
      clearInterval(intervalUpdate);
      intervalUpdate = null;
    }

    startRecording();

    intervalUpdate = setInterval(function () {
      try {
        const transcribed = window.Module && window.Module.get_transcribed ? window.Module.get_transcribed() : null;

        if (transcribed != null && transcribed.length > 1) {
          const decision = shouldAppend(transcribed);

          if (decision && decision.ok) {
            const toAppend = decision.append;

            // mantém HTML com <br> no final (como você já usa na UI)
            transcribedAll += toAppend + "<br>";
            nLines++;

            lastAppended = toAppend;
            pushRecent(toAppend);

            // partial (opcional na UI)
            try { onPartialText && onPartialText(""); } catch {}

            scheduleAutosave();
          }
        }

        emitTranscript();
        emitStatus();
        emitTimer();
      } catch (e) {
        dbg(String(e.stack || e));
      }
    }, 100);

    banner("Gravando…");
    return true;
  }

  function stop() {
    stopRecording();

    if (intervalUpdate) {
      clearInterval(intervalUpdate);
      intervalUpdate = null;
    }

    banner("Parado.");
    emitTranscript();
    scheduleAutosave();
  }

  // -----------------------------
  // Transcript helpers
  // -----------------------------
  function clearTranscript() {
    transcribedAll = "";
    nLines = 0;
    lastAppended = "";
    recentWindow.length = 0;
    try { onPartialText && onPartialText(""); } catch {}
    emitTranscript();
    scheduleAutosave();
  }

  function setTranscriptHtml(html) {
    transcribedAll = html || "";
  }

  function getTranscriptHtml() {
    return transcribedAll;
  }

  function getNLines() {
    return nLines;
  }

  function setNLines(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) nLines = n;
  }

  // -----------------------------
  // Cache (helpers.js define clearCache())
  // -----------------------------
  function clearCache() {
    if (typeof window.clearCache === "function") {
      window.clearCache();
      dbg("js: clearCache called");
    } else {
      dbg("js: clearCache not available");
    }
  }

  // -----------------------------
  // Model loading (helpers.js loadRemote + FS)
  // -----------------------------
  function storeFS(fname, buf) {
    try {
      window.Module && window.Module.FS_unlink && window.Module.FS_unlink(fname);
    } catch {}

    try {
      window.Module && window.Module.FS_createDataFile && window.Module.FS_createDataFile("/", fname, buf, true, true);
    } catch (e) {
      dbg("FS_createDataFile failed: " + String(e.stack || e));
    }

    dbg("storeFS: stored model: " + fname + " size: " + (buf ? buf.length : "?"));
    banner('Modelo carregado: "' + model_whisper + '". Você já pode clicar em Iniciar.');

    try { persist && persist.setLastModel && persist.setLastModel(model_whisper); } catch {}
    scheduleAutosave();

    try { onModelLoaded && onModelLoaded(); } catch {}
  }

  function loadWhisper(model) {
    if (typeof window.loadRemote !== "function") {
      dbg("helpers.js not loaded? loadRemote missing");
      banner("helpers.js não carregou (loadRemote ausente).");
      try { onModelError && onModelError(); } catch {}
      return;
    }

    const urls = {
      "tiny.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
      "tiny": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
      "base.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
      "base": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
      "small.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
      "small": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
      "tiny-en-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin",
      "tiny-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
      "base-en-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
      "base-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
      "small-en-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin",
      "small-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    };

    const sizes = {
      "tiny.en": 75,
      "tiny": 75,
      "base.en": 142,
      "base": 142,
      "small.en": 466,
      "small": 466,
      "tiny-en-q5_1": 31,
      "tiny-q5_1": 31,
      "base-en-q5_1": 57,
      "base-q5_1": 57,
      "small-en-q5_1": 181,
      "small-q5_1": 181,
    };

    const url = urls[model];
    const dst = "whisper.bin";
    const size_mb = sizes[model];

    if (!url) {
      banner("Modelo inválido: " + model);
      try { onModelError && onModelError(); } catch {}
      return;
    }

    model_whisper = model;

    banner("Baixando modelo: " + model + " (" + size_mb + " MB)...");
    scheduleAutosave();

    const cbProgress = function (p) {
      try { onModelProgress && onModelProgress(p); } catch {}
    };

    const cbCancel = function () {
      banner("Download do modelo cancelado.");
      try { onModelError && onModelError(); } catch {}
    };

    window.loadRemote(
      url,
      dst,
      size_mb,
      cbProgress,
      function (_dst, buf) { storeFS(_dst, buf); },
      cbCancel,
      dbg
    );
  }

  function init() {
    emitTranscript();
    emitStatus();
    emitTimer();
  }

  function getModel() {
    return model_whisper;
  }

  function setModel(m) {
    if (m) model_whisper = m;
  }

  return {
    init,
    start,
    stop,
    loadWhisper,
    clearCache,
    clearTranscript,

    getModel,
    setModel,

    getNLines,
    setNLines,

    setTranscriptHtml,
    getTranscriptHtml,
  };
}

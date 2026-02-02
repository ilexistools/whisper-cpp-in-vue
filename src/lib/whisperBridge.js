// src/lib/whisperBridge.js
// Ponte entre Vue e os scripts padrao do whisper.cpp (helpers.js + libstream.js)

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

  // audio context
  let context = null;

  // audio buffers
  let audio = null;
  let audio0 = null;

  // whisper instance
  let instance = null;

  // estado transcript
  let transcribedAll = "";
  let nLines = 0;
  let intervalUpdate = null;

  // model
  let model_whisper = null;

  // recording
  const kSampleRate = 16000;
  const kRestartRecording_s = 120;
  const kIntervalAudio_ms = 5000;

  let mediaRecorder = null;
  let doRecording = false;
  let startTime = 0;

  window.AudioContext = window.AudioContext || window.webkitAudioContext;
  window.OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  function dbg(msg) {
    try {
      onDebug && onDebug(msg);
    } catch (e) {}
  }

  function setBanner(msg) {
    try {
      onBanner && onBanner(msg);
    } catch (e) {}
  }

  function formatMMSS(ms) {
    const s0 = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s0 / 60);
    const s = s0 % 60;
    return String(m).padStart(2, "0") + "m " + String(s).padStart(2, "0") + "s";
  }

  function emitStatus() {
    try {
      onStatus && onStatus({ isRunning: !!doRecording });
    } catch (e) {}
  }

  function emitTimer() {
    try {
      onTimer && onTimer(doRecording ? formatMMSS(Date.now() - startTime) : "00m 00s");
    } catch (e) {}
  }

  function emitTranscript() {
    try {
      onTranscriptHtml && onTranscriptHtml(transcribedAll && transcribedAll.length ? transcribedAll : "[A transcricao vai aparecer aqui]");
    } catch (e) {}
  }

  function scheduleAutosave() {
    try {
      persist && persist.scheduleAutosave && persist.scheduleAutosave();
    } catch (e) {}
  }

  function stopRecording() {
    try {
      if (window.Module && window.Module.set_status) window.Module.set_status("paused");
    } catch (e) {}

    doRecording = false;
    audio0 = null;
    audio = null;
    context = null;

    emitStatus();
    emitTimer();
    scheduleAutosave();
  }

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
    } catch (e) {}

    doRecording = true;
    startTime = Date.now();

    emitStatus();
    emitTimer();
    scheduleAutosave();

    var chunks = [];
    var stream = null;

    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(function(s) {
        stream = s;
        mediaRecorder = new MediaRecorder(stream);

        mediaRecorder.ondataavailable = function(e) {
          chunks.push(e.data);

          var blob = new Blob(chunks, { type: "audio/ogg; codecs=opus" });
          var reader = new FileReader();

          reader.onload = function() {
            var buf = new Uint8Array(reader.result);

            if (!context) return;

            context.decodeAudioData(
              buf.buffer,
              function(audioBuffer) {
                var offlineContext = new OfflineAudioContext(
                  audioBuffer.numberOfChannels,
                  audioBuffer.length,
                  audioBuffer.sampleRate
                );
                var source = offlineContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(offlineContext.destination);
                source.start(0);

                offlineContext.startRendering().then(function(renderedBuffer) {
                  audio = renderedBuffer.getChannelData(0);

                  var audioAll = new Float32Array(audio0 == null ? audio.length : audio0.length + audio.length);
                  if (audio0 != null) audioAll.set(audio0, 0);
                  audioAll.set(audio, audio0 == null ? 0 : audio0.length);

                  if (instance && window.Module && window.Module.set_audio) {
                    window.Module.set_audio(instance, audioAll);
                  }
                });
              },
              function() {
                audio = null;
              }
            );
          };

          reader.readAsArrayBuffer(blob);
        };

        mediaRecorder.onstop = function() {
          if (doRecording) {
            setTimeout(function() { startRecording(); }, 0);
          }
        };

        mediaRecorder.start(kIntervalAudio_ms);
      })
      .catch(function(err) {
        dbg("js: error getting audio stream: " + err);
        setBanner("Erro ao acessar microfone. Confira permissoes.");
      });

    var interval = setInterval(function() {
      if (!doRecording) {
        clearInterval(interval);

        try {
          if (mediaRecorder) mediaRecorder.stop();
        } catch (e) {}

        try {
          if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        } catch (e) {}

        mediaRecorder = null;

        scheduleAutosave();
        return;
      }

      // restart por janela grande
      if (audio != null && audio.length > kSampleRate * kRestartRecording_s) {
        clearInterval(interval);

        audio0 = audio;
        audio = null;

        try {
          if (mediaRecorder) mediaRecorder.stop();
        } catch (e) {}

        try {
          if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
        } catch (e) {}

        scheduleAutosave();
      }

      emitTimer();
    }, 100);
  }

  function ensureInstance() {
    if (instance) return true;
    if (!window.Module || !window.Module.init) return false;

    var lang = (getLanguage && getLanguage()) || "pt";
    instance = window.Module.init("whisper.bin", lang);
    if (instance) {
      dbg("js: whisper initialized, instance: " + instance);
      return true;
    }
    return false;
  }

  function start() {
    if (!model_whisper) {
      setBanner("Carregue um modelo primeiro.");
      return false;
    }

    if (!ensureInstance()) {
      dbg("js: failed to initialize whisper");
      setBanner("Falha ao inicializar Whisper (veja Debug).");
      return false;
    }

    startRecording();

    if (intervalUpdate) {
      clearInterval(intervalUpdate);
      intervalUpdate = null;
    }

    intervalUpdate = setInterval(function() {
      try {
        var transcribed = window.Module && window.Module.get_transcribed ? window.Module.get_transcribed() : null;
        if (transcribed != null && transcribed.length > 1) {
          transcribedAll += transcribed + "<br>";
          nLines++;

          // mantem ultimas 10 linhas (mesmo comportamento do exemplo)
          if (nLines > 10) {
            var i = transcribedAll.indexOf("<br>");
            if (i > 0) {
              transcribedAll = transcribedAll.substring(i + 4);
              nLines--;
            }
          }

          scheduleAutosave();
        }

        var status = (window.Module && window.Module.get_status) ? window.Module.get_status() : "";
        var hidden = document.getElementById("state-status");
        if (hidden) hidden.innerHTML = status;

        emitTranscript();
        emitStatus();
        emitTimer();
      } catch (e) {
        dbg(String(e.stack || e));
      }
    }, 100);

    return true;
  }

  function stop() {
    stopRecording();
    emitTranscript();
    scheduleAutosave();
  }

  function clearTranscript() {
    transcribedAll = "";
    nLines = 0;
    if (onPartialText) onPartialText("");
    emitTranscript();
    scheduleAutosave();
  }

  function clearCache() {
    if (typeof window.clearCache === "function") {
      window.clearCache();
      dbg("js: clearCache called");
    }
  }

  function storeFS(fname, buf) {
    // do exemplo: grava o modelo no FS do Emscripten
    try {
      if (window.Module && window.Module.FS_unlink) window.Module.FS_unlink(fname);
    } catch (e) {}

    if (window.Module && window.Module.FS_createDataFile) {
      window.Module.FS_createDataFile("/", fname, buf, true, true);
    }

    dbg("storeFS: stored model: " + fname + " size: " + buf.length);

    // habilita runtime
    model_whisper = model_whisper || "custom";
    scheduleAutosave();

    setBanner("Modelo carregado: " + model_whisper + ". Você já pode clicar em Iniciar.");
    
    // Notifica que o modelo foi carregado
    try {
      if (onModelLoaded) onModelLoaded();
    } catch (e) {}
  }

  function loadWhisper(model) {
    // usa helpers.js: loadRemote(url, dst, sizeMB, cbProgress, cbReady, cbCancel, print)
    if (typeof window.loadRemote !== "function") {
      dbg("helpers.js not loaded? loadRemote missing");
      setBanner("helpers.js não carregou (loadRemote ausente).");
      return;
    }

    // URLs corretas do repositorio HuggingFace
    var urls = {
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
      "small-q5_1": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin"
    };

    var sizes = {
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
      "small-q5_1": 181
    };

    var url = urls[model];
    var dst = "whisper.bin";
    var size_mb = sizes[model];

    if (!url) {
      setBanner("Modelo invalido: " + model);
      return;
    }

    model_whisper = model;
    try {
      if (persist && persist.setLastModel) persist.setLastModel(model);
    } catch (e) {}

    var cbProgress = function(p) {
      dbg("model progress: " + Math.round(100 * p) + "%");
      try {
        if (onModelProgress) onModelProgress(p);
      } catch (e) {}
    };

    var cbCancel = function() {
      setBanner("Download do modelo cancelado.");
      dbg("model download canceled");
      try {
        if (onModelError) onModelError();
      } catch (e) {}
    };

    setBanner("Baixando modelo: " + model + " (" + size_mb + " MB)...");

    window.loadRemote(
      url,
      dst,
      size_mb,
      cbProgress,
      function(dst, buf) { storeFS(dst, buf); },
      cbCancel,
      dbg
    );

    scheduleAutosave();
  }

  function init() {
    // inicializa labels e transcript do persist (se ja recuperou)
    emitTranscript();
    emitStatus();
    emitTimer();
  }

  function getModel() {
    return model_whisper;
  }

  function setModel(m) {
    model_whisper = m || model_whisper;
  }

  function getNLines() {
    return nLines;
  }

  function setNLines(v) {
    var n = Number(v);
    if (Number.isFinite(n) && n >= 0) nLines = n;
  }

  function setTranscriptHtml(html) {
    transcribedAll = html || "";
  }

  function getTranscriptHtml() {
    return transcribedAll;
  }

  return {
    init: init,
    start: start,
    stop: stop,
    loadWhisper: loadWhisper,
    clearCache: clearCache,
    clearTranscript: clearTranscript,
    getModel: getModel,
    setModel: setModel,
    getNLines: getNLines,
    setNLines: setNLines,
    setTranscriptHtml: setTranscriptHtml,
    getTranscriptHtml: getTranscriptHtml
  };
}
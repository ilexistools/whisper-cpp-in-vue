<script setup>
import { onMounted, ref, computed, watch } from "vue";
import { loadScript } from "./lib/loadScripts";
import { createPersist } from "./lib/persist";
import { createWhisperBridge } from "./lib/whisperBridge";

const drawer = ref(false);

const isRunning = ref(false);
const statusText = computed(function() { return isRunning.value ? "Gravando" : "Parado"; });
const bannerMsg = ref("Clique em Configurações para carregar um modelo e começar a transcrição em tempo real.");

const language = ref("pt");
const selectedModel = ref("tiny-q5_1");
const modelLoading = ref(false);
const modelProgress = ref(0);

const modelOptions = [
  { title: "Tiny Q5.1 (31 MB) - Multilíngue, rápido", value: "tiny-q5_1" },
  { title: "Tiny (75 MB) - Multilíngue", value: "tiny" },
  { title: "Tiny.en Q5.1 (31 MB) - Inglês, rápido", value: "tiny-en-q5_1" },
  { title: "Tiny.en (75 MB) - Inglês", value: "tiny.en" },
  { title: "Base Q5.1 (57 MB) - Multilíngue, melhor", value: "base-q5_1" },
  { title: "Base (142 MB) - Multilíngue", value: "base" },
  { title: "Base.en Q5.1 (57 MB) - Inglês, melhor", value: "base-en-q5_1" },
  { title: "Base.en (142 MB) - Inglês", value: "base.en" },
  { title: "Small Q5.1 (181 MB) - Multilíngue, alta qualidade", value: "small-q5_1" },
  { title: "Small (466 MB) - Multilíngue, alta qualidade", value: "small" },
  { title: "Small.en Q5.1 (181 MB) - Inglês, alta qualidade", value: "small-en-q5_1" },
  { title: "Small.en (466 MB) - Inglês, alta qualidade", value: "small.en" }
];

const transcriptHtml = ref("[A transcrição vai aparecer aqui]");
const partialText = ref("");

const timerLabel = ref("00m 00s");

const debugText = ref("");

const persistState = ref("inicializando...");
const activeSessionLabel = ref("-");
const lastSaveLabel = ref("-");
const lastModelLabel = ref("-");

const sessions = ref([]);
const selectedSessionId = ref(null);

let persist = null;
let bridge = null;

const DEBUG_LIMIT = 200000;

function appendDebug(line) {
  const s = String(line != null ? line : "");
  debugText.value += (debugText.value ? "\n" : "") + s;

  if (debugText.value.length > DEBUG_LIMIT) {
    debugText.value = debugText.value.slice(-DEBUG_LIMIT);
  }
}

function clearCache() {
  try {
    if (bridge && bridge.clearCache) bridge.clearCache();
    bannerMsg.value = "Cache limpo.";
  } catch (e) {
    appendDebug(String(e.stack || e));
  }
}

function loadSelectedModel() {
  try {
    modelLoading.value = true;
    modelProgress.value = 0;
    if (bridge && bridge.loadWhisper) bridge.loadWhisper(selectedModel.value);
    var modelName = modelOptions.find(function(m) { return m.value === selectedModel.value; });
    bannerMsg.value = "Carregando modelo: " + (modelName ? modelName.title : selectedModel.value) + "...";
  } catch (e) {
    modelLoading.value = false;
    modelProgress.value = 0;
    appendDebug(String(e.stack || e));
    bannerMsg.value = "Erro ao carregar modelo (veja o Debug).";
  }
}

function onStart() {
  const ok = bridge && bridge.start ? bridge.start() : false;
  if (!ok) bannerMsg.value = "Falha ao iniciar. Carregue um modelo primeiro.";
}

function onStop() {
  if (bridge && bridge.stop) bridge.stop();
}

function clearTranscript() {
  if (bridge && bridge.clearTranscript) bridge.clearTranscript();
  if (persist && persist.scheduleAutosave) persist.scheduleAutosave();
}

function exportTranscript() {
  const tmp = document.createElement("div");
  tmp.innerHTML = transcriptHtml.value || "";
  const text = (tmp.innerText || "").trim();
  if (!text) return;

  if (persist && persist.autosaveNow) {
    persist.autosaveNow("manual").catch(function() {});
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "transcricao.txt";
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

async function recoverLast() {
  const id = persist && persist.getActiveSessionId ? persist.getActiveSessionId() : null;
  if (!id) return;
  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão ativa recuperada.";
}

async function newSession() {
  if (isRunning.value) onStop();

  transcriptHtml.value = "[A transcrição vai aparecer aqui]";
  partialText.value = "";
  timerLabel.value = "00m 00s";

  await persist.createNewSession(true);
  selectedSessionId.value = persist.getActiveSessionId ? persist.getActiveSessionId() : null;

  bannerMsg.value = "Nova sessão criada. Você pode começar do zero.";
}

async function deleteSession() {
  const id = selectedSessionId.value || (persist && persist.getActiveSessionId ? persist.getActiveSessionId() : null);
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.deleteSession(id);

  selectedSessionId.value = persist.getActiveSessionId ? persist.getActiveSessionId() : null;

  transcriptHtml.value = "[A transcrição vai aparecer aqui]";
  partialText.value = "";
  timerLabel.value = "00m 00s";

  bannerMsg.value = "Sessão apagada.";
}

async function loadSelectedSession() {
  const id = selectedSessionId.value;
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão carregada.";
}

async function makeSelectedActive() {
  const id = selectedSessionId.value;
  if (!id) return;

  if (isRunning.value) onStop();

  await persist.setActiveSession(id);
  await persist.restoreSessionById(id);
  bannerMsg.value = "Sessão selecionada definida como ativa.";
}

async function initWhisperRuntime() {
  window.Module = {
    print: appendDebug,
    printErr: appendDebug,
    setStatus: function(t) {
      appendDebug("js: " + t);
    },
    preRun: function() { appendDebug("js: Preparing ..."); },
    postRun: function() { appendDebug("js: Initialized successfully!"); },
    monitorRunDependencies: function() {}
  };

  if (typeof window.dbVersion === "undefined") window.dbVersion = 1;
  if (typeof window.dbName === "undefined") window.dbName = "whisper.ggerganov.com";

  appendDebug("js: Loading helpers.js...");
  await loadScript("/helpers.js");
  appendDebug("js: helpers.js loaded");

  appendDebug("js: Loading libstream.js (WASM)...");
  await loadScript("/libstream.js");
  appendDebug("js: libstream.js loaded");

  appendDebug("js: Loading stream.js...");
  await loadScript("/stream.js");
  appendDebug("js: stream.js loaded");

  if (window.Module) {
    appendDebug("js: Module object available");
    if (window.Module.init) {
      appendDebug("js: Module.init available");
    }
  }

  persistState.value = "ativo";
}

onMounted(async function() {
  try {
    await initWhisperRuntime();

    persist = createPersist({
      getTranscriptHtml: function() { return transcriptHtml.value; },
      getNLines: function() { return bridge && bridge.getNLines ? bridge.getNLines() : 0; },
      getModel: function() { return bridge && bridge.getModel ? bridge.getModel() : null; },
      getLanguage: function() { return language.value; },
      getWasRecording: function() { return isRunning.value; },

      setTranscriptHtml: function(html) {
        transcriptHtml.value = html && html.length ? html : "[A transcrição vai aparecer aqui]";
        if (bridge && bridge.setTranscriptHtml) bridge.setTranscriptHtml(html);
      },
      setNLines: function(n) { if (bridge && bridge.setNLines) bridge.setNLines(n); },
      setModel: function(m) {
        if (m) lastModelLabel.value = m;
        if (bridge && bridge.setModel) bridge.setModel(m);
      },
      setLanguage: function(l) {
        if (l) language.value = l;
      },

      onBanner: function(m) { bannerMsg.value = m; },
      onPersistUI: function(p) {
        if (p.persistState != null) persistState.value = p.persistState;
        if (p.activeSessionLabel != null) activeSessionLabel.value = p.activeSessionLabel;
        if (p.lastSaveLabel != null) lastSaveLabel.value = p.lastSaveLabel;
        if (p.lastModelLabel != null) lastModelLabel.value = p.lastModelLabel;
        if (p.sessions != null) sessions.value = p.sessions;
      }
    });

    await persist.init();

    bridge = createWhisperBridge({
      onBanner: function(m) { bannerMsg.value = m; },
      onStatus: function(s) { isRunning.value = s.isRunning; },
      onTimer: function(t) { timerLabel.value = t; },
      onTranscriptHtml: function(html) { transcriptHtml.value = html && html.length ? html : "[A transcrição vai aparecer aqui]"; },
      onPartialText: function(t) { partialText.value = t || ""; },
      onDebug: appendDebug,
      onModelProgress: function(p) { modelProgress.value = Math.round(p * 100); },
      onModelLoaded: function() { 
        modelLoading.value = false; 
        modelProgress.value = 100;
        drawer.value = false;
      },
      onModelError: function() {
        modelLoading.value = false;
        modelProgress.value = 0;
      },
      getLanguage: function() { return language.value; },
      persist: persist
    });

    bridge.init();

    selectedSessionId.value = persist.getActiveSessionId ? persist.getActiveSessionId() : null;
    lastModelLabel.value = bridge.getModel ? bridge.getModel() : "-";

    window.addEventListener("beforeunload", function() {
      try {
        if (persist && persist.autosaveNow) persist.autosaveNow("beforeunload");
      } catch (e) {}
    });
  } catch (e) {
    persistState.value = "erro";
    bannerMsg.value = "Falha ao inicializar (verifique os arquivos em /public/).";
    appendDebug(String(e.stack || e));
  }
});

watch(language, function() {
  if (persist && persist.scheduleAutosave) persist.scheduleAutosave();
});
</script>

<template>
  <v-app style="background: #f5f7fb;">
    <v-main>
      <v-container class="py-4" style="max-width: 1320px;">
        <v-card
          class="overflow-hidden"
          rounded="xl"
          elevation="8"
          style="border: 1px solid #e5e7eb; min-height: calc(100vh - 32px); display: flex; flex-direction: column;"
        >
          <v-toolbar flat style="border-bottom: 1px solid #e5e7eb;">
            <div class="d-flex align-center ga-3 flex-wrap w-100">
              <div class="d-flex align-center ga-3 flex-wrap">
                <div class="text-h6 font-weight-black" style="margin-left:10px;">Transcrição em Tempo Real</div>

                <v-chip
                  size="small"
                  label
                  style="background:#e9fbf0; color:#15803d; border:1px solid #b7f0c9; font-weight:800;"
                >100% Local</v-chip>

                <v-chip
                  size="small"
                  label
                  style="background:#fff3d6; color:#b45309; border:1px solid #fde2a7; font-weight:800;"
                >STREAMING</v-chip>
              </div>

              <div class="flex-grow-1"></div>

              <v-chip
                label
                style="background:#f3f4f6; color:#374151; border:1px solid #e5e7eb; font-weight:800; margin-right:10px;"
              >
                <v-icon start size="12" :color="isRunning ? 'green' : 'grey'">mdi-circle</v-icon>
                {{ statusText }}
              </v-chip>
            </div>
          </v-toolbar>

          <div
            class="d-flex align-center justify-space-between flex-wrap ga-3 px-4 py-3"
            style="background:#f0f6ff; border-bottom:1px solid #dbeafe;"
          >
            <div class="d-flex align-center flex-wrap ga-2" style="color:#1f3b8a;">
              <v-chip
                size="small"
                label
                style="background:#e8f1ff; color:#1d4ed8; border:1px solid #c7ddff; font-weight:900;"
              >INÍCIO</v-chip>
              <span style="font-size: 13px; font-weight: 700;">{{ bannerMsg }}</span>
            </div>

            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn color="black" variant="flat" @click="drawer = true">Configurações</v-btn>
            </div>
          </div>

          <div class="pa-4" style="flex: 1 1 auto; min-height: 0; display:flex; flex-direction:column; gap:12px;">
            <div class="d-flex align-center ga-2" style="color:#6b7280;">
              <v-icon size="18">mdi-dots-horizontal</v-icon>
              <span style="font-size:14px; font-weight:700;">
                Carregue um modelo e clique em Iniciar para começar a transcrição em tempo real
              </span>
            </div>

            <v-card
              variant="outlined"
              rounded="lg"
              style="border-color:#eef2f7; flex: 1 1 auto; min-height:0; overflow:auto;"
            >
              <v-card-text style="line-height:1.55; font-size:14px;">
                <div v-html="transcriptHtml" style="color:#111827;"></div>
                <div style="color:#6b7280; font-style:italic;">{{ partialText }}</div>
              </v-card-text>
            </v-card>

            <div style="display:none">
              <span id="state-status">not started</span>
            </div>
          </div>

          <div
            class="d-flex align-center justify-space-between flex-wrap ga-3 px-4 py-3"
            style="border-top:1px solid #e5e7eb; background:#fbfcfe;"
          >
            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn
                icon
                variant="outlined"
                size="large"
                @click="onStart"
                style="border-radius:999px; width:42px; height:42px;"
                title="Iniciar"
              >
                <v-icon :color="isRunning ? 'red' : 'grey'">mdi-circle</v-icon>
              </v-btn>

              <v-btn variant="outlined" :disabled="!isRunning" @click="onStop">Parar</v-btn>

              <v-chip label variant="outlined" style="font-variant-numeric: tabular-nums; font-weight:800; color:#6b7280;">
                {{ timerLabel }}
              </v-chip>
            </div>

            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn variant="outlined" @click="clearTranscript">Limpar</v-btn>
              <v-btn variant="outlined" @click="exportTranscript">Exportar</v-btn>
              <v-btn icon variant="outlined" @click="drawer = true" title="Configurações">
                <v-icon>mdi-cog</v-icon>
              </v-btn>
            </div>
          </div>
        </v-card>

        <v-navigation-drawer 
          v-model="drawer" 
          location="right" 
          temporary 
          width="420"
        >
          <div style="display: flex; flex-direction: column; height: 100vh;">
            <div class="d-flex align-center justify-space-between px-4 py-3" style="border-bottom:1px solid #e5e7eb; flex-shrink: 0;">
              <div class="text-subtitle-2 font-weight-black">Configurações</div>
              <v-btn variant="outlined" size="small" @click="drawer=false">Fechar</v-btn>
            </div>

            <div class="pa-4" style="flex: 1; overflow-y: auto; background:#fbfcfe;">
              
              <!-- MODELO -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="font-weight-black mb-3" style="font-size:14px;">Modelo Whisper</div>
                  
                  <v-select
                    v-model="selectedModel"
                    :items="modelOptions"
                    :disabled="modelLoading"
                    variant="outlined"
                    density="comfortable"
                    label="Selecione o modelo"
                    class="mb-3"
                  />
                  
                  <!-- Barra de progresso -->
                  <div v-if="modelLoading" class="mb-3">
                    <div class="d-flex justify-space-between mb-1" style="font-size: 12px; color: #6b7280;">
                      <span>Baixando modelo...</span>
                      <span>{{ modelProgress }}%</span>
                    </div>
                    <v-progress-linear
                      :model-value="modelProgress"
                      color="primary"
                      height="8"
                      rounded
                    />
                  </div>
                  
                  <div class="d-flex ga-2 flex-wrap">
                    <v-btn 
                      color="black" 
                      variant="flat" 
                      @click="loadSelectedModel"
                      :loading="modelLoading"
                      :disabled="modelLoading"
                    >
                      <v-icon start>mdi-download</v-icon>
                      {{ modelLoading ? 'Carregando...' : 'Carregar Modelo' }}
                    </v-btn>
                    <v-btn variant="outlined" @click="clearCache" :disabled="modelLoading">Limpar Cache</v-btn>
                  </div>
                  
                  <div class="mt-3" style="font-size:11px; color:#6b7280; line-height:1.4;">
                    <b>Dica:</b> Modelos Q5.1 são menores e mais rápidos. 
                    Modelos "multilíngue" suportam português e outros idiomas.
                    Modelos ".en" são otimizados apenas para inglês.
                  </div>
                </v-card-text>
              </v-card>

              <!-- IDIOMA -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="font-weight-black mb-2" style="font-size:13px;">Idioma da Transcrição</div>
                  <v-select
                    v-model="language"
                    :items="[
                      { title:'Português', value:'pt' },
                      { title:'English', value:'en' }
                    ]"
                    variant="outlined"
                    density="comfortable"
                  />
                </v-card-text>
              </v-card>

              <!-- PERSISTÊNCIA -->
              <v-card variant="outlined" rounded="lg" class="mb-4">
                <v-card-text>
                  <div class="d-flex justify-space-between align-start ga-2 mb-3">
                    <div>
                      <div class="font-weight-black" style="font-size:13px;">Persistência</div>
                      <div style="color:#6b7280; font-size:11px;">Salvamento automático</div>
                    </div>
                    <v-chip size="small" :color="persistState === 'ativo' ? 'success' : 'warning'">
                      {{ persistState }}
                    </v-chip>
                  </div>

                  <div style="display:grid; gap:6px; font-size:12px; color:#6b7280;">
                    <div class="d-flex justify-space-between">
                      <span>Sessão ativa</span><b style="color:#111827;">{{ activeSessionLabel }}</b>
                    </div>
                    <div class="d-flex justify-space-between">
                      <span>Último autosave</span><b style="color:#111827;">{{ lastSaveLabel }}</b>
                    </div>
                    <div class="d-flex justify-space-between">
                      <span>Modelo</span><b style="color:#111827;">{{ lastModelLabel }}</b>
                    </div>
                  </div>

                  <v-divider class="my-3" />

                  <div class="d-flex ga-2 flex-wrap mb-3">
                    <v-btn variant="outlined" size="small" @click="recoverLast">Recuperar</v-btn>
                    <v-btn variant="outlined" size="small" @click="newSession">Nova</v-btn>
                    <v-btn variant="outlined" size="small" color="error" @click="deleteSession">Apagar</v-btn>
                  </div>

                  <v-select
                    v-model="selectedSessionId"
                    :items="sessions.map(function(s) { return {
                      title: (s.title || s.id) + (s.isActive ? ' (ativa)' : ''),
                      value: s.id
                    }; })"
                    variant="outlined"
                    density="compact"
                    label="Sessões salvas"
                    class="mb-2"
                  />

                  <div class="d-flex ga-2 flex-wrap">
                    <v-btn variant="text" size="small" @click="loadSelectedSession">Carregar</v-btn>
                    <v-btn variant="text" size="small" @click="makeSelectedActive">Definir ativa</v-btn>
                  </div>
                </v-card-text>
              </v-card>

            </div>
          </div>
        </v-navigation-drawer>
      </v-container>
    </v-main>
  </v-app>
</template>
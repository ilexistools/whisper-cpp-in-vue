# Whisper Vuetify - Transcrição em Tempo Real

Aplicação Vue.js + Vuetify para transcrição de áudio em tempo real usando Whisper.cpp (WASM).

## Pré-requisitos

1. Node.js 18+ instalado
2. Os arquivos WASM do whisper.cpp na pasta `public/`:
   - `coi-serviceworker.js`
   - `helpers.js`
   - `libstream.js`
   - `libstream.worker.js`
   - `stream.js`

## Instalação

```bash
# Instalar dependências
npm install

# Rodar em desenvolvimento
npm run dev

# Build para produção
npm run build
```

## Estrutura esperada da pasta `public/`

```
public/
├── coi-serviceworker.js   # Service worker para COOP/COEP headers
├── helpers.js             # Funções auxiliares (loadRemote, etc.)
├── libstream.js           # Módulo WASM compilado
├── libstream.worker.js    # Web Worker para threading
└── stream.js              # Interface JavaScript para o WASM
```

## Importante

Os arquivos `libstream.js` e `libstream.worker.js` são os módulos WASM compilados do whisper.cpp.
Você pode obtê-los:

1. Compilando o whisper.cpp com Emscripten
2. Baixando de https://whisper.ggerganov.com/stream/

## Como funciona

1. O usuário carrega um modelo (clicando em "Carregar Modelo")
2. O modelo é baixado do HuggingFace e cacheado no IndexedDB
3. O usuário clica em "Iniciar" para começar a gravação
4. O áudio é processado pelo Whisper em tempo real
5. A transcrição aparece na tela

## Modelos disponíveis

- `tiny-q5_1` - ~31MB, multilíngue, mais rápido
- `tiny.en` - ~75MB, apenas inglês
- `base-q5_1` - ~57MB, multilíngue, melhor qualidade
- `base.en` - ~142MB, apenas inglês

## Persistência

As transcrições são salvas automaticamente no IndexedDB do navegador,
permitindo recuperação após refresh ou crash.

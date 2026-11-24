// Interfaz: panel en Shadow DOM que se abre con el botón de la extensión.
// Sin innerHTML (WhatsApp Web usa Trusted Types): todo el DOM se crea con createElement.
(() => {
  const WAAS = (window.WAAS = window.WAAS || {});
  const log = (lvl, ev, data) => WAAS.log(lvl, ev, data);
  const FRAME = 1 / 30;     // paso del ajuste fino
  const MIN_LEN = 0.3;      // duración mínima del tramo

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
  .overlay { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; }
  .panel { --bg:#ffffff; --fg:#111b21; --muted:#667781; --card:#f0f2f5; --line:#d1d7db; --accent:#00a884; --accent-fg:#fff;
           --ok:#25d366; --ok-bg:rgba(37,211,102,.18); --warn:#d29a00; --warn-bg:rgba(240,180,0,.2); --no:#8696a0; --err:#d13b3b;
           width: min(680px, 96vw); max-height: 94vh; overflow: auto; background: var(--bg); color: var(--fg);
           border-radius: 14px; padding: 18px 20px 14px; box-shadow: 0 12px 48px rgba(0,0,0,.45); font-size: 14px; }
  .panel.dark { --bg:#111b21; --fg:#e9edef; --muted:#8696a0; --card:#202c33; --line:#2a3942; --ok-bg:rgba(37,211,102,.22); --warn-bg:rgba(240,180,0,.22); }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  h2 { margin: 0; font-size: 19px; }
  .muted { color: var(--muted); font-size: 12px; }
  section { background: var(--card); border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  section.off { opacity: .45; pointer-events: none; }
  h3 { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  h3 .n { display: inline-flex; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: var(--accent-fg); align-items: center; justify-content: center; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
  .grow { flex: 1; }
  button { font: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  .act { padding: 8px 16px; border-radius: 18px; border: none; background: var(--accent); color: var(--accent-fg); font-weight: 600; }
  .sec { padding: 5px 11px; border-radius: 14px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font-size: 12.5px; }
  .icon { width: 28px; padding: 4px 0; text-align: center; }
  .close { background: none; border: none; font-size: 22px; color: var(--muted); line-height: 1; }
  input[type=text] { width: 200px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; margin: 4px 0 10px; }
  input[type=number] { width: 78px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  select { padding: 4px 6px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  video { display: block; width: 100%; max-height: 260px; background: #000; border-radius: 8px; }
  .track { position: relative; height: 34px; margin: 12px 8px 6px; background: var(--line); border-radius: 6px; cursor: pointer; touch-action: none; user-select: none; }
  .track .sel { position: absolute; top: 0; bottom: 0; background: rgba(0,168,132,.35); border-top: 2px solid var(--accent); border-bottom: 2px solid var(--accent); pointer-events: none; }
  .track .handle { position: absolute; top: -5px; bottom: -5px; width: 14px; margin-left: -7px; background: var(--accent); border-radius: 4px; cursor: ew-resize; }
  .track .handle::after { content: ""; position: absolute; left: 4px; top: 10px; bottom: 10px; width: 4px; border-left: 1px solid rgba(255,255,255,.8); border-right: 1px solid rgba(255,255,255,.8); }
  .track .ph { position: absolute; top: -8px; bottom: -8px; width: 2px; margin-left: -1px; background: var(--fg); pointer-events: none; }
  .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin: 0 8px; }
  .trim { display: grid; grid-template-columns: auto auto 1fr; gap: 6px 10px; align-items: center; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  .seg button { border: none; padding: 5px 12px; background: var(--bg); color: var(--fg); font-size: 12.5px; }
  .seg button.on { background: var(--accent); color: var(--accent-fg); }
  table.grid { border-collapse: separate; border-spacing: 3px; margin: 6px 0; font-size: 11.5px; }
  table.grid th { color: var(--muted); font-weight: 600; padding: 2px 4px; text-align: center; }
  table.grid th.side { text-align: right; }
  table.grid td button { width: 52px; padding: 5px 0; border-radius: 6px; border: 1px solid transparent; font-size: 11.5px; background: transparent; color: var(--no); }
  table.grid td button.ok { background: var(--ok-bg); color: var(--fg); }
  table.grid td button.baja { background: var(--warn-bg); color: var(--fg); }
  table.grid td button.no, table.grid td button.fuera { cursor: default; opacity: .6; }
  table.grid td button.sel { border-color: var(--fg); font-weight: 700; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }
  .stale { color: var(--warn); font-size: 12.5px; font-weight: 600; }
  .bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin-top: 8px; }
  .bar > div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  .status { font-size: 13px; margin: 6px 0 0; min-height: 18px; }
  .status.err { color: var(--err); font-weight: 600; }
  .result { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .result img { width: 150px; height: 150px; object-fit: contain; border-radius: 8px; background: repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 50% / 18px 18px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
  .logbox { max-height: 150px; overflow: auto; font: 11px/1.35 ui-monospace, Consolas, monospace; background: var(--bg); padding: 6px 8px; border-radius: 6px; white-space: pre-wrap; margin-top: 6px; }
  .logbox .e { color: var(--err); } .logbox .w { color: var(--warn); }
  `;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") el.className = v;
        else if (k === "style") el.style.cssText = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  function attachStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      log("warn", "ui:estilos-fallback", e);
      root.append(h("style", { textContent: CSS }));
    }
  }

  function download(blob, name) {
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  async function saveLog() {
    const stored = await WAAS.getStoredLog();
    const entries = stored && stored.length ? stored : WAAS.entries;
    const content = JSON.stringify({ exportado: new Date().toISOString(), version: WAAS.VERSION, ua: navigator.userAgent, entradas: entries }, null, 1);
    const blob = new Blob([content], { type: "application/json" });
    const name = "registro-stickers-con-sonido-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json";
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Registro JSON", accept: { "application/json": [".json"] } }] });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        log("info", "registro:guardado", { nombre: handle.name, entradas: entries.length });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        log("warn", "registro:selector-fallo", e);
      }
    }
    download(blob, name);
    log("info", "registro:descargado", { nombre: name, entradas: entries.length });
  }
  WAAS.saveLog = saveLog;

  const fmtT = (t) => (t >= 60 ? Math.floor(t / 60) + ":" + (t % 60).toFixed(2).padStart(5, "0") : t.toFixed(2) + " s");
  const fmtB = (b) => (b >= 1e6 ? (b / 1e6).toFixed(2) + " MB" : Math.round(b / 1000) + " KB");
  const isDark = () => {
    try {
      return document.body.classList.contains("dark") || document.documentElement.classList.contains("dark") ||
        matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) { return false; }
  };

  function mount() {
    if (document.getElementById("waas-root")) return;
    const host = h("div", { id: "waas-root" });
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    attachStyles(root);

    const st = {
      file: null, meta: null, start: 0, end: 0, playhead: 0, mode: "ajustar",
      an: null, anKey: null, sel: null, result: null, busy: false, abort: null, urls: [],
      stopAt: null,
    };
    let fileUrl = null;

    // ------------------------------------------------------------ 1. Video
    const fileInput = h("input", { type: "file", accept: "video/*,.mov,.mp4,.webm,.mkv", style: "display:none" });
    const pickBtn = h("button", { class: "act", textContent: "Elegir video…" });
    const fileInfo = h("span", { class: "muted" }, "Cualquier video con sonido.");
    const sec1 = h("section", null, h("h3", null, h("span", { class: "n" }, "1"), "Video"), h("div", { class: "row" }, pickBtn, fileInfo, fileInput));

    // ------------------------------------------------------------ 2. Tramo
    const video = h("video", { playsInline: true, preload: "auto" });
    const selBar = h("div", { class: "sel" });
    const hS = h("div", { class: "handle", title: "Inicio del tramo (arrastra)" });
    const hE = h("div", { class: "handle", title: "Fin del tramo (arrastra)" });
    const ph = h("div", { class: "ph" });
    const track = h("div", { class: "track", title: "Haz clic o arrastra para moverte por el video" }, selBar, ph, hS, hE);
    const tLeft = h("span"), tRight = h("span");
    const times = h("div", { class: "times" }, tLeft, tRight);
    const playSegBtn = h("button", { class: "sec", textContent: "▶ Tramo" });
    const playCurBtn = h("button", { class: "sec", textContent: "▶ Desde el cursor" });
    const playEndBtn = h("button", { class: "sec", textContent: "▶ Final del tramo" });
    const curLbl = h("span", { class: "muted grow", style: "text-align:right" });
    const startNum = h("input", { type: "number", min: 0, step: 0.01 });
    const endNum = h("input", { type: "number", min: 0, step: 0.01 });
    const mkStep = (txt, title, fn) => h("button", { class: "sec icon", textContent: txt, title, onclick: fn });
    const startCur = h("button", { class: "sec", textContent: "⤓ cursor", title: "Usar la posición del cursor como inicio" });
    const endCur = h("button", { class: "sec", textContent: "⤓ cursor", title: "Usar la posición del cursor como fin" });
    const lenLbl = h("span", { class: "muted" });
    const trim = h("div", { class: "trim" },
      h("span", null, "Inicio"),
      h("span", { class: "row", style: "margin:0" }, mkStep("−", "Un cuadro antes", () => setStart(st.start - FRAME)), startNum, mkStep("+", "Un cuadro después", () => setStart(st.start + FRAME))),
      h("span", { class: "row", style: "margin:0" }, startCur),
      h("span", null, "Fin"),
      h("span", { class: "row", style: "margin:0" }, mkStep("−", "Un cuadro antes", () => setEnd(st.end - FRAME)), endNum, mkStep("+", "Un cuadro después", () => setEnd(st.end + FRAME))),
      h("span", { class: "row", style: "margin:0" }, endCur, lenLbl));
    const sec2 = h("section", { class: "off" },
      h("h3", null, h("span", { class: "n" }, "2"), "Tramo"),
      video, track, times,
      h("div", { class: "row" }, playSegBtn, playCurBtn, playEndBtn, curLbl),
      trim,
      h("div", { class: "muted", style: "margin-top:6px" }, "Arrastra las asas verdes: el video muestra el cuadro donde quedan. Haz clic o arrastra en la barra para mover el cursor."));

    // ------------------------------------------------------------ 3. Formato
    const segAjustar = h("button", { textContent: "Ajustar (bordes transparentes)", class: "on" });
    const segRecortar = h("button", { textContent: "Recortar (llenar el cuadro)" });
    const calcBtn = h("button", { class: "act", textContent: "Calcular opciones" });
    const calcInfo = h("span", { class: "muted" }, "Lee el tramo una vez y estima el peso de cada combinación.");
    const staleLbl = h("div", { class: "stale", style: "display:none" }, "El tramo o el encuadre cambiaron: vuelve a calcular las opciones.");
    const gridHost = h("div");
    const selLbl = h("div", { class: "row", style: "font-weight:600" });
    const legend = h("div", { class: "legend" },
      h("span", null, h("i", { style: "background:var(--ok-bg);border:1px solid var(--ok)" }), "cabe"),
      h("span", null, h("i", { style: "background:var(--warn-bg);border:1px solid var(--warn)" }), "cabe bajando la calidad"),
      h("span", null, h("i", { style: "border:1px solid var(--line)" }), "✕ supera 1 MB (WhatsApp lo rechaza)"),
      h("span", null, "★ recomendada · valores en KB"));
    const SYNC_KEY = "waas-compensacion-ms";
    let savedSync = 0;
    try { const v = localStorage.getItem(SYNC_KEY); if (v != null && !isNaN(+v)) savedSync = +v; } catch (e) { /* sin almacenamiento */ }
    const syncNum = h("input", { type: "number", min: 0, max: 1000, step: 10, value: savedSync });
    syncNum.addEventListener("change", () => { try { localStorage.setItem(SYNC_KEY, String(+syncNum.value || 0)); } catch (e) { /* ignorar */ } });
    const advanced = h("details", null, h("summary", null, "Avanzado"),
      h("div", { class: "row" }, h("span", null, "Compensar desfase (ms)"), syncNum,
        h("span", { class: "muted" }, "Normalmente 0. Si en algún celular el audio va atrasado, la imagen esperará este tiempo.")));
    const sec3 = h("section", { class: "off" },
      h("h3", null, h("span", { class: "n" }, "3"), "Formato"),
      h("div", { class: "row" }, h("span", null, "Encuadre"), h("span", { class: "seg" }, segAjustar, segRecortar)),
      h("div", { class: "row" }, calcBtn, calcInfo),
      staleLbl, gridHost, selLbl, legend, advanced);

    // ------------------------------------------------------------ 4. Crear y enviar
    const META_KEY = "waas-metadatos";
    let savedMeta = {};
    try { savedMeta = JSON.parse(localStorage.getItem(META_KEY) || "{}") || {}; } catch (e) { /* sin almacenamiento */ }
    const packInput = h("input", { type: "text", maxLength: 128, placeholder: "Ej.: Mis memes", value: savedMeta.paquete || "" });
    const authorInput = h("input", { type: "text", maxLength: 128, placeholder: "Ej.: tu nombre o apodo", value: savedMeta.autor || "" });
    const saveMeta = () => { try { localStorage.setItem(META_KEY, JSON.stringify({ paquete: packInput.value, autor: authorInput.value })); } catch (e) { /* ignorar */ } };
    packInput.addEventListener("change", saveMeta);
    authorInput.addEventListener("change", saveMeta);
    const metaBox = h("div", null,
      h("div", { class: "muted" }, "Datos del sticker (opcional): WhatsApp los muestra debajo del sticker. Se recuerdan."),
      h("div", { class: "meta" }, h("span", null, "Paquete"), packInput, h("span", null, "Autor"), authorInput));
    const createBtn = h("button", { class: "act", textContent: "Crear sticker" });
    const cancelBtn = h("button", { class: "sec", textContent: "Cancelar", style: "display:none" });
    const barIn = h("div");
    const bar = h("div", { class: "bar" }, barIn);
    const status = h("div", { class: "status" });
    const resImg = h("img", { alt: "vista previa del sticker" });
    const resAudio = h("audio", { controls: true });
    const resInfo = h("div", { class: "muted", style: "max-width:380px" });
    const destSel = h("select", null,
      h("option", { value: "abierto-solo", textContent: "Enviar al chat abierto" }),
      h("option", { value: "abierto", textContent: "Enviar al chat abierto y abrir Reenviar" }),
      h("option", { value: "propio", textContent: "Guardar en mi chat (Tú) y abrir Reenviar" }));
    const sendBtn = h("button", { class: "act", textContent: "Enviar" });
    const dlBtn = h("button", { class: "sec", textContent: "Descargar .webp y .ogg" });
    const result = h("div", { style: "display:none" },
      h("div", { class: "result" }, resImg, h("div", null, resAudio, resInfo)),
      h("div", { class: "row", style: "margin-top:10px" }, destSel, sendBtn, dlBtn));
    const sec4 = h("section", { class: "off" },
      h("h3", null, h("span", { class: "n" }, "4"), "Crear y enviar"),
      metaBox,
      h("div", { class: "row" }, createBtn, cancelBtn), bar, status, result);

    // ------------------------------------------------------------ herramientas
    const logBox = h("div", { class: "logbox" });
    const tools = h("details", null, h("summary", null, "Herramientas de prueba (registro, diagnóstico)"),
      h("div", { class: "row" },
        h("button", { class: "sec", textContent: "Diagnóstico", onclick: () => WAAS.wa.diagnose().catch((e) => log("error", "diagnostico:error", e)) }),
        h("button", { class: "sec", textContent: "Guardar registro…", onclick: () => saveLog().catch((e) => log("error", "registro:error", e)) }),
        h("button", { class: "sec", textContent: "Ver registro completo", onclick: () => window.postMessage({ __waas: "openLog" }, location.origin) })),
      logBox);

    const closeBtn = h("button", { class: "close", title: "Cerrar", textContent: "×" });
    const panel = h("div", { class: "panel" },
      h("header", null, h("div", null, h("h2", null, "Stickers con sonido"), h("div", { class: "muted" }, "Versión " + WAAS.VERSION + " · todo se procesa en tu navegador · máximo 1 MB por sticker")), closeBtn),
      sec1, sec2, sec3, sec4, tools);
    const overlay = h("div", { class: "overlay", style: "display:none" }, panel);
    root.append(overlay);

    // ------------------------------------------------------------ registro visible
    const showEntry = (e) => {
      logBox.append(h("div", { class: e.level === "error" ? "e" : e.level === "warn" ? "w" : "" },
        e.ts.slice(11, 19) + " " + e.event + (e.data != null ? " " + JSON.stringify(e.data).slice(0, 260) : "")));
      while (logBox.childNodes.length > 200) logBox.firstChild.remove();
      logBox.scrollTop = logBox.scrollHeight;
    };
    WAAS.entries.slice(-30).forEach(showEntry);
    WAAS.onLog(showEntry);

    // ------------------------------------------------------------ utilidades de estado
    const setStatus = (txt, frac, isErr) => {
      status.textContent = txt || "";
      status.className = "status" + (isErr ? " err" : "");
      if (frac != null) barIn.style.width = Math.round(frac * 100) + "%";
    };
    const off = () => (st.meta ? st.meta.offset || 0 : 0);
    const D = () => (st.meta ? st.meta.duration : 0);
    const key = () => `${st.start.toFixed(3)}|${st.end.toFixed(3)}|${st.mode}`;
    const refresh = () => {
      const has = !!st.meta;
      const fresh = !!st.an && st.anKey === key();
      sec2.classList.toggle("off", !has || st.busy);
      sec3.classList.toggle("off", !has);
      staleLbl.style.display = st.an && !fresh ? "" : "none";
      gridHost.style.opacity = st.an && !fresh ? ".35" : "";
      gridHost.style.pointerEvents = st.an && !fresh ? "none" : "";
      sec4.classList.toggle("off", !(fresh && st.sel) && !st.result);
      pickBtn.disabled = st.busy;
      calcBtn.disabled = st.busy || !has;
      segAjustar.disabled = segRecortar.disabled = st.busy;
      createBtn.disabled = st.busy || !(fresh && st.sel);
      sendBtn.disabled = st.busy || !st.result;
      cancelBtn.style.display = st.busy ? "" : "none";
      segAjustar.classList.toggle("on", st.mode === "ajustar");
      segRecortar.classList.toggle("on", st.mode === "recortar");
    };
    const setBusy = (b) => { st.busy = b; refresh(); };
    const revoke = () => { st.urls.forEach((u) => URL.revokeObjectURL(u)); st.urls = []; };

    // ------------------------------------------------------------ línea de tiempo
    const layout = () => {
      const d = D() || 1;
      const pct = (t) => Math.max(0, Math.min(100, (t / d) * 100)) + "%";
      selBar.style.left = pct(st.start);
      selBar.style.width = Math.max(0, ((st.end - st.start) / d) * 100) + "%";
      hS.style.left = pct(st.start);
      hE.style.left = pct(st.end);
      ph.style.left = pct(st.playhead);
      tLeft.textContent = "0 s";
      tRight.textContent = fmtT(D());
      curLbl.textContent = "cursor " + fmtT(st.playhead);
      if (root.activeElement !== startNum) startNum.value = st.start.toFixed(2);
      if (root.activeElement !== endNum) endNum.value = st.end.toFixed(2);
      lenLbl.textContent = "duración " + fmtT(st.end - st.start);
    };
    // Saltos encadenados: el siguiente se pide cuando terminó el anterior (arrastre fluido).
    let seeking = false, pendingSeek = null;
    const seekTo = (t) => { pendingSeek = t; if (!seeking) doSeek(); };
    const doSeek = () => {
      if (pendingSeek == null) return;
      const t = pendingSeek; pendingSeek = null; seeking = true;
      st.playhead = t;
      video.currentTime = off() + t;
      layout();
    };
    video.addEventListener("seeked", () => { seeking = false; if (pendingSeek != null) doSeek(); });

    const trimChanged = () => { layout(); refresh(); };
    const setStart = (t, seek = true) => {
      st.start = Math.max(0, Math.min(t, st.end - MIN_LEN));
      trimChanged();
      if (seek) { stopPlayback(); seekTo(st.start); }
    };
    const setEnd = (t, seek = true) => {
      st.end = Math.min(D(), Math.max(t, st.start + MIN_LEN));
      trimChanged();
      if (seek) { stopPlayback(); seekTo(Math.max(st.start, st.end - FRAME)); }
    };

    const tAt = (ev) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * D();
    };
    let drag = null;
    track.addEventListener("pointerdown", (ev) => {
      if (!st.meta || st.busy) return;
      drag = ev.target === hS ? "s" : ev.target === hE ? "e" : "p";
      track.setPointerCapture(ev.pointerId);
      stopPlayback();
      applyDrag(ev);
    });
    track.addEventListener("pointermove", (ev) => { if (drag) applyDrag(ev); });
    const endDrag = () => { drag = null; };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    const applyDrag = (ev) => {
      const t = tAt(ev);
      if (drag === "s") setStart(t);
      else if (drag === "e") setEnd(t);
      else seekTo(t);
    };
    startNum.addEventListener("change", () => setStart(+startNum.value || 0));
    endNum.addEventListener("change", () => setEnd(+endNum.value || 0));
    startCur.addEventListener("click", () => setStart(st.playhead));
    endCur.addEventListener("click", () => setEnd(st.playhead));

    // ------------------------------------------------------------ reproducción del tramo
    let raf = 0;
    const tick = () => {
      st.playhead = Math.max(0, video.currentTime - off());
      layout();
      if (st.stopAt != null && video.currentTime >= off() + st.stopAt) { stopPlayback(); return; }
      if (!video.paused) raf = requestAnimationFrame(tick);
    };
    const stopPlayback = () => {
      cancelAnimationFrame(raf);
      if (!video.paused) video.pause();
      st.stopAt = null;
    };
    const playRange = (from, to) => {
      if (!video.paused) { stopPlayback(); return; }
      st.stopAt = to;
      video.muted = false;
      seeking = false; pendingSeek = null;
      video.currentTime = off() + from;
      video.play().then(() => { raf = requestAnimationFrame(tick); }).catch((e) => log("warn", "ui:reproducir", e));
    };
    playSegBtn.addEventListener("click", () => playRange(st.start, st.end));
    playCurBtn.addEventListener("click", () => playRange(st.playhead >= st.start && st.playhead < st.end - 0.1 ? st.playhead : st.start, st.end));
    playEndBtn.addEventListener("click", () => playRange(Math.max(st.start, st.end - 2), st.end));

    // ------------------------------------------------------------ 1. elegir video
    pickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      stopPlayback();
      if (st.an) { WAAS.release(st.an); st.an = null; }
      st.sel = null; st.result = null; result.style.display = "none"; gridHost.textContent = ""; selLbl.textContent = "";
      revoke();
      setStatus("", 0);
      fileInfo.textContent = "Leyendo " + f.name + "…";
      setBusy(true);
      try {
        const meta = await WAAS.probeVideo(f);
        st.file = f; st.meta = meta;
        if (fileUrl) URL.revokeObjectURL(fileUrl);
        fileUrl = URL.createObjectURL(f);
        video.src = fileUrl;
        st.start = 0; st.end = Math.min(meta.duration, 10); st.playhead = 0;
        video.addEventListener("loadeddata", () => { seekTo(0); }, { once: true });
        fileInfo.textContent = `${f.name} · ${fmtT(meta.duration)} · ${meta.width}×${meta.height}`;
        calcInfo.textContent = "Lee el tramo una vez y estima el peso de cada combinación.";
        log("info", "ui:video-elegido", { nombre: f.name, tipo: f.type, bytes: f.size, ...meta });
      } catch (e) {
        log("error", "ui:video-error", e);
        fileInfo.textContent = "No se pudo leer: " + e.message;
        st.file = null; st.meta = null;
      }
      setBusy(false);
      layout();
    });

    // ------------------------------------------------------------ 3. encuadre y opciones
    segAjustar.addEventListener("click", () => { st.mode = "ajustar"; refresh(); });
    segRecortar.addEventListener("click", () => { st.mode = "recortar"; refresh(); });

    const renderGrid = () => {
      gridHost.textContent = "";
      const an = st.an;
      if (!an) return;
      const L = WAAS.limits;
      const thead = h("tr", null, h("th", { class: "side" }, "px \\ fps"), L.FPS_LIST.map((f) => h("th", null, String(f))));
      const rows = L.SIDES.map((side) => h("tr", null, h("th", { class: "side" }, String(side)), L.FPS_LIST.map((fps) => {
        const c = an.cells.find((x) => x.side === side && x.fps === fps);
        const isAuto = an.auto && an.auto.side === side && an.auto.fps === fps;
        const isSel = st.sel && st.sel.side === side && st.sel.fps === fps;
        const can = !!c && (c.estado === "ok" || c.estado === "baja");
        const label = !c || c.estado === "fuera" ? "·" : c.estado === "no" ? "✕" : (isAuto ? "★" : "") + Math.round(c.est / 1000);
        const title = !c || c.estado === "fuera" ? "No disponible para este tramo"
          : c.estado === "no" ? `≈ ${fmtB(c.estMin)} aun con la calidad mínima: supera 1 MB`
          : c.estado === "baja" ? `≈ ${fmtB(c.est)} con la calidad normal: se bajará la calidad para que quepa`
          : `≈ ${fmtB(c.est)}`;
        return h("td", null, h("button", {
          class: (c ? c.estado : "fuera") + (isSel ? " sel" : ""), textContent: label, title, disabled: !can,
          onclick: () => { st.sel = { side, fps }; renderGrid(); refresh(); },
        }));
      })));
      gridHost.append(h("table", { class: "grid" }, thead, rows));
      const c = st.sel && an.cells.find((x) => x.side === st.sel.side && x.fps === st.sel.fps);
      selLbl.textContent = c ? `Elegido: ${c.side} px · ${c.fps} fps · ≈ ${fmtB(c.est)}${c.estado === "baja" ? " (con menos calidad)" : ""}` : "Ninguna combinación cabe en 1 MB: acorta el tramo.";
    };

    calcBtn.addEventListener("click", async () => {
      if (!st.file) return;
      stopPlayback();
      if (st.an) { WAAS.release(st.an); st.an = null; }
      st.sel = null; st.result = null; result.style.display = "none"; gridHost.textContent = ""; selLbl.textContent = "";
      st.abort = new AbortController();
      setBusy(true);
      const k = key();
      try {
        const an = await WAAS.run("analizar", () => WAAS.analyze({
          file: st.file, start: st.start, duration: st.end - st.start, mode: st.mode,
          onProgress: (t, f) => { calcInfo.textContent = t; setStatus("", f); }, signal: st.abort.signal,
        }));
        st.an = an; st.anKey = k;
        st.sel = an.auto ? { side: an.auto.side, fps: an.auto.fps } : null;
        calcInfo.textContent = `Listo en ${(an.ms / 1000).toFixed(1)} s. Elige una casilla (★ = recomendada).`;
        renderGrid();
      } catch (e) {
        calcInfo.textContent = e.name === "AbortError" ? "Cancelado" : "Error: " + e.message;
      }
      setStatus("", 0);
      setBusy(false);
    });

    // ------------------------------------------------------------ 4. crear y enviar
    createBtn.addEventListener("click", async () => {
      if (!st.an || !st.sel) return;
      stopPlayback();
      st.abort = new AbortController();
      setBusy(true);
      result.style.display = "none";
      try {
        const res = await WAAS.run("crear", () => WAAS.create(st.an, {
          side: st.sel.side, fps: st.sel.fps, syncMs: +syncNum.value || 0,
          packName: packInput.value, publisher: authorInput.value,
          onProgress: (t, f) => setStatus(t, f), signal: st.abort.signal,
        }));
        st.result = res;
        revoke();
        const u1 = URL.createObjectURL(res.webp), u2 = URL.createObjectURL(res.ogg);
        st.urls.push(u1, u2);
        resImg.src = u1; resAudio.src = u2;
        const i = res.info;
        resInfo.textContent = `${fmtT(i.duracion)} · ${i.lado} px · ${i.fps} fps · calidad ${Math.round(i.calidad * 100)} · sticker ${fmtB(i.webpBytes)} (estimado ${fmtB(i.estimado || 0)}) · audio ${fmtB(i.oggBytes)} a ${i.audioKbps} kbps`;
        result.style.display = "";
        setStatus("Sticker listo. Revisa la vista previa y envíalo.", 1);
      } catch (e) {
        setStatus(e.name === "AbortError" ? "Cancelado" : "Error: " + e.message, 0, e.name !== "AbortError");
      }
      setBusy(false);
    });
    cancelBtn.addEventListener("click", () => { if (st.abort) st.abort.abort(); });

    sendBtn.addEventListener("click", async () => {
      if (!st.result) return;
      setBusy(true);
      const dest = destSel.value;
      try {
        // Aplica el paquete y el autor escritos ahora (pueden haber cambiado después de crear).
        const i = st.result.info;
        if (packInput.value.trim() !== (i.paquete || "") || authorInput.value.trim() !== (i.autor || "")) {
          st.result.webp = await WAAS.retagWebp(st.result.webp, { packName: packInput.value, publisher: authorInput.value, soundSha: i.soundSha256 });
          i.paquete = packInput.value.trim(); i.autor = authorInput.value.trim();
          log("info", "metadatos:actualizados", { paquete: i.paquete, autor: i.autor, webpBytes: st.result.webp.size });
        }
        saveMeta();
        await WAAS.run("enviar", () => WAAS.wa.publish(st.result, {
          destino: dest === "propio" ? "propio" : "abierto",
          abrirReenviar: dest !== "abierto-solo",
          onProgress: (t) => setStatus(t),
        }));
        setStatus(dest === "abierto-solo" ? "Enviado." : "Enviado. Elige en el diálogo los chats a los que reenviarlo.", 1);
        overlay.style.display = "none";
      } catch (e) {
        setStatus("Error al enviar: " + e.message, 0, true);
      }
      setBusy(false);
    });
    dlBtn.addEventListener("click", () => {
      if (!st.result) return;
      const base = (st.file && st.file.name.replace(/\.[^.]+$/, "")) || "sticker";
      download(st.result.webp, base + ".webp");
      download(st.result.ogg, base + ".ogg");
      log("info", "ui:descarga-archivos", { base });
    });

    // ------------------------------------------------------------ abrir / cerrar
    const open = () => { panel.classList.toggle("dark", isDark()); overlay.style.display = ""; log("info", "ui:abrir", null); };
    const close = () => { if (st.busy) return; stopPlayback(); overlay.style.display = "none"; };
    const toggle = () => (overlay.style.display === "none" ? open() : close());
    window.addEventListener("message", (ev) => {
      if (ev.source === window && ev.data && ev.data.__waas === "togglePanel") toggle();
    });
    WAAS.togglePanel = toggle;
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    refresh();
    layout();
    log("info", "ui:montada", null);
    window.postMessage({ __waas: "uiReady" }, location.origin);
  }

  WAAS.mountUI = mount;
})();

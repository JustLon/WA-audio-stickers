// Conversión en el navegador: video, GIF o imagen + audio -> sticker WebP + audio Ogg/Opus (formato de WhatsApp).
// No depende de WhatsApp; usa <video>, ImageDecoder (GIF), canvas (WebP), WebAudio y WebCodecs.
(() => {
  const WAAS = (window.WAAS = window.WAAS || {});
  const log = (lvl, ev, data) => (WAAS.log ? WAAS.log(lvl, ev, data) : console.log(ev, data));

  const SIDE = 512;                    // lado máximo (WhatsApp usa 512; más grande no se ve mejor y pesa 4 veces más)
  const MAX_STICKER_BYTES = 1_000_000; // el servidor de WhatsApp rechaza stickers más pesados (HTTP 413)
  const SAFE_BYTES = 900_000;          // margen para la estimación (verde = estimado ≤ 900 KB)
  const MAX_AUDIO_BYTES = 1_000_000;   // límite de WhatsApp Web para el audio del sticker
  const SAMPLE_RATE = 48000;
  const CAPTURE_MEM_BYTES = 320e6;     // memoria máxima para los cuadros capturados (10 s a 30 fps caben a 512 px)
  const SIDES = [512, 448, 384, 320, 256, 224, 192, 160, 128, 96, 64];
  const FPS_LIST = [30, 25, 20, 15, 12, 10, 8, 6, 5];
  const Q_MIN = 0.15;
  // Calidad WebP por lado: con menos píxeles conviene comprimir menos.
  const Q_BY_SIDE = { 512: 0.75, 448: 0.7, 384: 0.65, 320: 0.6, 256: 0.55, 224: 0.55, 192: 0.5, 160: 0.5, 128: 0.45, 96: 0.45, 64: 0.4 };

  // Preferencia para la opción automática: la fluidez pesa más que la resolución (en pantalla un
  // sticker es pequeño), pero sin bajar de ~160 px salvo que no quede otra.
  // Más de 20 fps casi no suma (solo desempata); bajar de 192 px penaliza.
  const FPS_SCORE = { 30: 101, 25: 100.5, 20: 100, 15: 80, 12: 55, 10: 40, 8: 25, 6: 12, 5: 5 };
  function score(side, fps) {
    return (FPS_SCORE[fps] || 0) + (40 * side) / 512 - (side < 192 ? (192 - side) / 3 : 0);
  }

  // fps de captura según la duración: lo que puede llegar a caber en 1 MB.
  function captureFpsFor(dur) {
    return dur <= 10 ? 30 : dur <= 20 ? 25 : dur <= 40 ? 20 : dur <= 80 ? 15 : 12;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const te = new TextEncoder();
  const ENCODE_CONCURRENCY = Math.max(2, Math.min(8, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4));

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException("Cancelado por el usuario", "AbortError");
  }

  function createCanvasPool(side, count = ENCODE_CONCURRENCY) {
    return Array.from({ length: Math.max(1, count) }, () => {
      const canvas = new OffscreenCanvas(side, side);
      return { canvas, ctx: canvas.getContext("2d") };
    });
  }

  async function runPool(items, pool, fn, signal) {
    const n = items.length;
    if (!n) return [];
    const results = new Array(n);
    let next = 0;
    const workers = Math.min(pool.length, n);
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      const slot = pool[w];
      while (true) {
        checkAbort(signal);
        const idx = next++;
        if (idx >= n) break;
        results[idx] = await fn(items[idx], idx, slot);
      }
    }));
    return results;
  }

  // ---------------------------------------------------------------- video
  const videoMetaCache = new WeakMap(); // File -> { duration, offset, width, height }

  function loadVideo(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      const url = URL.createObjectURL(file);
      const timer = setTimeout(() => reject(new Error("Tiempo agotado cargando el video")), 30000);
      v.onloadeddata = async () => {
        clearTimeout(timer);
        const cached = videoMetaCache.get(file);
        if (cached) {
          v._waasOffset = cached.offset;
          resolve(v);
          return;
        }
        // Algunos videos recortados conservan marcas de tiempo que no empiezan en 0
        // (p. ej. empiezan en 130 s). Chrome se posiciona en el primer cuadro: ese es el desfase.
        v._waasOffset = Number.isFinite(v.currentTime) ? v.currentTime : 0;
        if (v.readyState < 4) {
          await new Promise((r) => { const t = setTimeout(r, 5000); v.addEventListener("canplaythrough", () => { clearTimeout(t); r(); }, { once: true }); });
        }
        // Chrome solo corrige la duración cuando llega al final del archivo: se salta al final
        // mientras la duración siga creciendo, y luego se vuelve al inicio.
        const seekWait = (t) => new Promise((r) => {
          const to = setTimeout(r, 3000);
          v.addEventListener("seeked", () => { clearTimeout(to); r(); }, { once: true });
          v.currentTime = t;
        });
        const initialDuration = v.duration;
        for (let i = 0; i < 8 && Number.isFinite(v.duration); i++) {
          const d = v.duration;
          await seekWait(Math.max(0, d - 0.01));
          await sleep(40);
          if (!(v.duration > d + 0.01)) break;
        }
        await seekWait(v._waasOffset);
        if (v.duration !== initialDuration) log("info", "video:duracion-corregida", { inicial: initialDuration, final: v.duration, desfase: v._waasOffset });
        videoMetaCache.set(file, { duration: v.duration - v._waasOffset, offset: v._waasOffset, width: v.videoWidth, height: v.videoHeight });
        resolve(v);
      };
      v.onerror = () => {
        clearTimeout(timer);
        const e = v.error;
        reject(new Error("El navegador no pudo leer el video" + (e ? ` (código ${e.code}: ${e.message || "formato no soportado"})` : "")));
      };
      v.src = url;
      v._waasUrl = url;
    });
  }

  function seek(v, t) {
    return new Promise((resolve, reject) => {
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return resolve();
      const timer = setTimeout(() => { v.removeEventListener("seeked", done); reject(new Error(`Tiempo agotado buscando el segundo ${t.toFixed(2)}`)); }, 8000);
      function done() { clearTimeout(timer); resolve(); }
      v.addEventListener("seeked", done, { once: true });
      v.currentTime = t;
    });
  }

  // Dimensiones de cualquier fuente dibujable: <video>, VideoFrame (GIF/WebCodecs) o ImageBitmap (imagen).
  const srcW = (s) => s.videoWidth || s.displayWidth || s.width;
  const srcH = (s) => s.videoHeight || s.displayHeight || s.height;

  function drawFrame(ctx, v, mode, side, rotation = 0) {
    const rw = srcW(v), rh = srcH(v);
    const swap = rotation === 90 || rotation === 270;
    const vw = swap ? rh : rw, vh = swap ? rw : rh;
    ctx.clearRect(0, 0, side, side);
    const s = mode === "recortar" ? Math.max(side / vw, side / vh) : Math.min(side / vw, side / vh);
    if (!rotation) {
      const w = vw * s, h = vh * s;
      ctx.drawImage(v, (side - w) / 2, (side - h) / 2, w, h);
    } else {
      const dw = rw * s, dh = rh * s;
      ctx.save();
      ctx.translate(side / 2, side / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(v, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
  }

  async function probeVideo(file) {
    if (videoMetaCache.has(file)) return videoMetaCache.get(file);
    const v = await loadVideo(file);
    try {
      const offset = v._waasOffset || 0;
      const meta = { duration: v.duration - offset, offset, width: v.videoWidth, height: v.videoHeight };
      videoMetaCache.set(file, meta);
      return meta;
    } finally {
      URL.revokeObjectURL(v._waasUrl);
    }
  }

  const FP_SIDE = 16;
  function makeSnapper(side, mode, rotation = 0) {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext("2d");
    const fpCanvas = new OffscreenCanvas(FP_SIDE, FP_SIDE);
    const fpCtx = fpCanvas.getContext("2d", { willReadFrequently: true });
    const canTransfer = typeof canvas.transferToImageBitmap === "function";
    return (v) => {
      drawFrame(ctx, v, mode, side, rotation);
      fpCtx.clearRect(0, 0, FP_SIDE, FP_SIDE);
      fpCtx.drawImage(canvas, 0, 0, FP_SIDE, FP_SIDE);
      const raw = fpCtx.getImageData(0, 0, FP_SIDE, FP_SIDE).data;
      const fp = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength >>> 2);
      if (canTransfer) {
        const bmp = canvas.transferToImageBitmap();
        return { bmp, bmpPromise: Promise.resolve(bmp), fp, used: false };
      }
      return { bmpPromise: createImageBitmap(canvas), fp, used: false };
    };
  }

  // Captura reproduciendo el video y tomando cada cuadro mostrado (requestVideoFrameCallback).
  // Es mucho más rápida que saltar cuadro por cuadro en videos largos.
  function captureByPlayback(v, t0, dur, fps, side, mode, onProgress, signal) {
    return new Promise((resolve, reject) => {
      if (typeof v.requestVideoFrameCallback !== "function") return reject(new Error("sin requestVideoFrameCallback"));
      const n = Math.max(1, Math.round(dur * fps));
      const T = Array.from({ length: n }, (_, k) => t0 + (k + 0.5) / fps);
      const tEnd = t0 + dur;
      const slots = new Array(n);
      const snap = makeSnapper(side, mode);
      let next = 0, last = null, pendingFirst = 0, done = false, presented = 0;
      // El elemento se adjunta al documento (casi invisible) para que Chrome componga sus cuadros.
      v.style.cssText = "position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.01;pointer-events:none;z-index:-1";
      document.body.appendChild(v);
      let watchdog = setTimeout(() => finish(new Error("La reproducción no entregó cuadros")), 4000);
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        v.pause();
        v.remove();
        if (err) {
          for (const s of new Set(slots.filter(Boolean).concat(last ? [last] : []))) s.bmpPromise.then((b) => b.close());
          return reject(err);
        }
        while (next < n && last) slots[next++] = last;
        if (last) last.used = true;
        resolve({ slots, presented });
      };
      const cb = (now, meta) => {
        if (done) return;
        if (signal && signal.aborted) return finish(new DOMException("Cancelado por el usuario", "AbortError"));
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(new Error("La reproducción se detuvo")), 4000);
        presented++;
        const mt = meta.mediaTime;
        // Los puntos de muestreo anteriores a este cuadro pertenecen al cuadro previo.
        while (next < n && T[next] < mt - 1e-4) {
          if (last) { slots[next++] = last; last.used = true; } else { pendingFirst++; next++; }
        }
        if (last && !last.used) last.bmpPromise.then((b) => b.close());
        last = snap(v);
        if (pendingFirst) { for (let i = 0; i < pendingFirst; i++) slots[i] = last; last.used = true; pendingFirst = 0; }
        if (onProgress && presented % 10 === 0) onProgress(`Leyendo cuadros ${next}/${n}`, next / n);
        if (next >= n || mt >= tEnd || v.ended) return finish();
        v.requestVideoFrameCallback(cb);
      };
      v.addEventListener("ended", () => finish(), { once: true });
      seek(v, t0).then(() => {
        v.requestVideoFrameCallback(cb);
        v.playbackRate = 1;
        return v.play();
      }).catch((e) => finish(e));
    });
  }

  // Captura saltando cuadro por cuadro (respaldo, más lenta pero no depende de la reproducción).
  async function captureBySeeking(v, t0, dur, fps, side, mode, onProgress, signal) {
    const n = Math.max(1, Math.round(dur * fps));
    const snap = makeSnapper(side, mode);
    const maxT = Math.max(0, v.duration - 0.001);
    const slots = [];
    for (let i = 0; i < n; i++) {
      checkAbort(signal);
      // Se toma el cuadro en la mitad de cada intervalo: si el salto cae justo en el borde entre
      // dos cuadros, el navegador a veces devuelve el anterior y se pierden cuadros.
      await seek(v, Math.min(t0 + (i + 0.5) / fps, maxT));
      const s = snap(v);
      s.used = true;
      slots.push(s);
      if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress(`Leyendo cuadros ${i + 1}/${n}`, (i + 1) / n);
    }
    return { slots, presented: n };
  }

  // ---------------------------------------------------------------- WebCodecs + demuxer MP4 ligero
  // Decodifica la pista de video de un MP4/MOV secuencialmente con VideoDecoder (sin hacer seek
  // cuadro por cuadro). Solo lee la caja moov y el tramo exacto de mdat necesario.
  function mp4Tag(u8, off) {
    return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
  }
  function mp4ReadU64(dv, off) {
    return dv.getUint32(off) * 4294967296 + dv.getUint32(off + 4);
  }
  function mp4ReadI64(dv, off) {
    return dv.getInt32(off) * 4294967296 + dv.getUint32(off + 4);
  }
  function mp4IterBoxes(u8, dv, start, end) {
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = dv.getUint32(pos);
      const type = mp4Tag(u8, pos + 4);
      let hdr = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = mp4ReadU64(dv, pos + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdr || pos + size > end) break;
      boxes.push({ type, start: pos + hdr, end: pos + size });
      pos += size;
    }
    return boxes;
  }
  const mp4Find = (boxes, type) => boxes.find((b) => b.type === type);

  function mp4ParseCodec(u8, dv, stsd) {
    const entryStart = stsd.start + 8;
    if (entryStart + 86 > stsd.end) return null;
    const entrySize = dv.getUint32(entryStart);
    const fmt = mp4Tag(u8, entryStart + 4);
    const width = dv.getUint16(entryStart + 32);
    const height = dv.getUint16(entryStart + 34);
    const subBoxes = mp4IterBoxes(u8, dv, entryStart + 86, Math.min(stsd.end, entryStart + entrySize));
    const hex2 = (x) => x.toString(16).padStart(2, "0");

    if (fmt === "avc1" || fmt === "avc3") {
      const avcc = mp4Find(subBoxes, "avcC");
      if (!avcc || avcc.end - avcc.start < 4) return null;
      const desc = u8.slice(avcc.start, avcc.end);
      const codec = `${fmt}.${hex2(desc[1])}${hex2(desc[2])}${hex2(desc[3])}`;
      return { codec, description: desc, codedWidth: width, codedHeight: height };
    }
    if (fmt === "hvc1" || fmt === "hev1") {
      const hvcc = mp4Find(subBoxes, "hvcC");
      if (!hvcc || hvcc.end - hvcc.start < 23) return null;
      const desc = u8.slice(hvcc.start, hvcc.end);
      const space = ["", "A", "B", "C"][(desc[1] >> 6) & 3] || "";
      const tier = (desc[1] & 0x20) ? "H" : "L";
      const profileIdc = desc[1] & 0x1f;
      let compat = 0;
      for (let i = 0; i < 4; i++) {
        let b = desc[2 + i], rev = 0;
        for (let k = 0; k < 8; k++) rev = (rev << 1) | ((b >> k) & 1);
        compat = (compat * 256) + rev;
      }
      const level = desc[12];
      const codec = `${fmt}.${space}${profileIdc}.${compat.toString(16).toUpperCase()}.${tier}${level}`;
      return { codec, description: desc, codedWidth: width, codedHeight: height };
    }
    if (fmt === "vp09") {
      const vpcc = mp4Find(subBoxes, "vpcC");
      if (!vpcc || vpcc.end - vpcc.start < 8) return null;
      const p = vpcc.start + 4; // fullbox header
      const profile = String(u8[p]).padStart(2, "0");
      const level = String(u8[p + 1]).padStart(2, "0");
      const depth = String(u8[p + 2] >> 4).padStart(2, "0");
      return { codec: `vp09.${profile}.${level}.${depth}`, codedWidth: width, codedHeight: height };
    }
    if (fmt === "av01") {
      const av1c = mp4Find(subBoxes, "av1C");
      if (!av1c || av1c.end - av1c.start < 4) return null;
      const p = av1c.start;
      const profile = (u8[p + 1] >> 5) & 7;
      const level = String(u8[p + 1] & 0x1f).padStart(2, "0");
      const tier = (u8[p + 2] & 0x80) ? "H" : "M";
      const highBit = (u8[p + 2] & 0x40) ? 1 : 0;
      const twelve = (u8[p + 2] & 0x20) ? 1 : 0;
      const depth = highBit ? (twelve ? "12" : "10") : "08";
      return { codec: `av01.${profile}.${level}${tier}.${depth}`, codedWidth: width, codedHeight: height };
    }
    return null;
  }

  function mp4Rotation(dv, tkhd) {
    const ver = dv.getUint8(tkhd.start);
    const matOff = tkhd.start + (ver === 1 ? 52 : 40);
    if (matOff + 20 > tkhd.end) return 0;
    const a = dv.getInt32(matOff) / 65536;
    const b = dv.getInt32(matOff + 4) / 65536;
    const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    return ((deg % 360) + 360) % 360;
  }

  async function parseMp4Video(file) {
    // Lee solo los encabezados de cajas de nivel superior para localizar ftyp y moov.
    let pos = 0, moovRange = null, isMp4 = false;
    while (pos + 8 <= file.size) {
      const hdrBuf = await file.slice(pos, Math.min(file.size, pos + 16)).arrayBuffer();
      if (hdrBuf.byteLength < 8) break;
      const dv = new DataView(hdrBuf);
      const u8 = new Uint8Array(hdrBuf);
      let size = dv.getUint32(0);
      const type = mp4Tag(u8, 4);
      let hdr = 8;
      if (size === 1) {
        if (hdrBuf.byteLength < 16) break;
        size = mp4ReadU64(dv, 8);
        hdr = 16;
      } else if (size === 0) {
        size = file.size - pos;
      }
      if (size < hdr || pos + size > file.size) break;
      if (type === "ftyp") isMp4 = true;
      if (type === "moov") { moovRange = { start: pos + hdr, end: pos + size }; break; }
      pos += size;
    }
    if (!isMp4 || !moovRange) return null;

    const moovBuf = await file.slice(moovRange.start, moovRange.end).arrayBuffer();
    const u8 = new Uint8Array(moovBuf);
    const dv = new DataView(moovBuf);
    const moovBoxes = mp4IterBoxes(u8, dv, 0, u8.length);
    const mvhd = mp4Find(moovBoxes, "mvhd");
    let movieTimescale = 1000;
    if (mvhd) {
      const ver = u8[mvhd.start];
      movieTimescale = dv.getUint32(mvhd.start + (ver === 1 ? 20 : 12)) || 1000;
    }

    for (const trak of moovBoxes.filter((b) => b.type === "trak")) {
      const trakBoxes = mp4IterBoxes(u8, dv, trak.start, trak.end);
      const mdia = mp4Find(trakBoxes, "mdia");
      if (!mdia) continue;
      const mdiaBoxes = mp4IterBoxes(u8, dv, mdia.start, mdia.end);
      const hdlr = mp4Find(mdiaBoxes, "hdlr");
      if (!hdlr || mp4Tag(u8, hdlr.start + 8) !== "vide") continue;

      const mdhd = mp4Find(mdiaBoxes, "mdhd");
      const minf = mp4Find(mdiaBoxes, "minf");
      if (!mdhd || !minf) continue;
      const mdhdVer = u8[mdhd.start];
      const timescale = dv.getUint32(mdhd.start + (mdhdVer === 1 ? 20 : 12));
      if (!timescale) continue;

      const minfBoxes = mp4IterBoxes(u8, dv, minf.start, minf.end);
      const stbl = mp4Find(minfBoxes, "stbl");
      if (!stbl) continue;
      const stblBoxes = mp4IterBoxes(u8, dv, stbl.start, stbl.end);

      const stsd = mp4Find(stblBoxes, "stsd");
      const stts = mp4Find(stblBoxes, "stts");
      const stsc = mp4Find(stblBoxes, "stsc");
      const stsz = mp4Find(stblBoxes, "stsz");
      const stco = mp4Find(stblBoxes, "stco");
      const co64 = mp4Find(stblBoxes, "co64");
      if (!stsd || !stts || !stsc || !stsz || (!stco && !co64)) continue;

      const codecInfo = mp4ParseCodec(u8, dv, stsd);
      if (!codecInfo) continue;

      // Lista de edición (elst): compensa desfases de inicio del primer cuadro.
      let editShiftSec = 0;
      const edts = mp4Find(trakBoxes, "edts");
      if (edts) {
        const elst = mp4Find(mp4IterBoxes(u8, dv, edts.start, edts.end), "elst");
        if (elst) {
          const ver = u8[elst.start];
          const count = dv.getUint32(elst.start + 4);
          let p = elst.start + 8;
          for (let i = 0; i < count; i++) {
            const segDur = ver === 1 ? mp4ReadU64(dv, p) : dv.getUint32(p);
            const mediaTime = ver === 1 ? mp4ReadI64(dv, p + 8) : dv.getInt32(p + 4);
            p += ver === 1 ? 20 : 12;
            if (mediaTime < 0) editShiftSec += segDur / movieTimescale;
            else { editShiftSec -= mediaTime / timescale; break; }
          }
        }
      }

      const tkhd = mp4Find(trakBoxes, "tkhd");
      const rotation = tkhd ? mp4Rotation(dv, tkhd) : 0;

      // Tamaños de muestra (stsz)
      const uniformSize = dv.getUint32(stsz.start + 4);
      const sampleCount = dv.getUint32(stsz.start + 8);
      if (!sampleCount) continue;
      const sizes = new Uint32Array(sampleCount);
      if (uniformSize) sizes.fill(uniformSize);
      else for (let i = 0; i < sampleCount; i++) sizes[i] = dv.getUint32(stsz.start + 12 + i * 4);

      // Desplazamientos de chunks (stco / co64)
      const chunkBox = stco || co64;
      const chunkCount = dv.getUint32(chunkBox.start + 4);
      const chunkOffsets = new Float64Array(chunkCount);
      if (stco) for (let i = 0; i < chunkCount; i++) chunkOffsets[i] = dv.getUint32(stco.start + 8 + i * 4);
      else for (let i = 0; i < chunkCount; i++) chunkOffsets[i] = mp4ReadU64(dv, co64.start + 8 + i * 8);

      // Muestras por chunk (stsc) -> offset exacto de cada muestra
      const stscCount = dv.getUint32(stsc.start + 4);
      const offsets = new Float64Array(sampleCount);
      let sIdx = 0;
      for (let i = 0; i < stscCount && sIdx < sampleCount; i++) {
        const firstChunk = dv.getUint32(stsc.start + 8 + i * 12) - 1;
        const perChunk = dv.getUint32(stsc.start + 12 + i * 12);
        const nextChunk = i + 1 < stscCount ? dv.getUint32(stsc.start + 8 + (i + 1) * 12) - 1 : chunkCount;
        for (let c = firstChunk; c < nextChunk && c < chunkCount && sIdx < sampleCount; c++) {
          let off = chunkOffsets[c];
          for (let k = 0; k < perChunk && sIdx < sampleCount; k++) {
            offsets[sIdx] = off;
            off += sizes[sIdx];
            sIdx++;
          }
        }
      }

      // Tiempos de decodificación (stts)
      const dts = new Float64Array(sampleCount);
      const durs = new Float64Array(sampleCount);
      const sttsCount = dv.getUint32(stts.start + 4);
      let tAcc = 0, si = 0;
      for (let i = 0; i < sttsCount && si < sampleCount; i++) {
        const cnt = dv.getUint32(stts.start + 8 + i * 8);
        const delta = dv.getUint32(stts.start + 12 + i * 8);
        for (let k = 0; k < cnt && si < sampleCount; k++) {
          dts[si] = tAcc;
          durs[si] = delta;
          tAcc += delta;
          si++;
        }
      }

      // Desfase de composición (ctts, necesario para B-frames)
      const pts = new Float64Array(sampleCount);
      const ctts = mp4Find(stblBoxes, "ctts");
      if (ctts) {
        const ver = u8[ctts.start];
        const cnt = dv.getUint32(ctts.start + 4);
        let ci = 0;
        for (let i = 0; i < cnt && ci < sampleCount; i++) {
          const n = dv.getUint32(ctts.start + 8 + i * 8);
          const off = ver === 1 ? dv.getInt32(ctts.start + 12 + i * 8) : dv.getUint32(ctts.start + 12 + i * 8);
          for (let k = 0; k < n && ci < sampleCount; k++) { pts[ci] = dts[ci] + off; ci++; }
        }
      } else {
        pts.set(dts);
      }

      // Keyframes (stss). Si no existe stss, todos los cuadros son keyframes.
      const isKey = new Uint8Array(sampleCount);
      const stss = mp4Find(stblBoxes, "stss");
      if (stss) {
        const cnt = dv.getUint32(stss.start + 4);
        for (let i = 0; i < cnt; i++) {
          const idx = dv.getUint32(stss.start + 8 + i * 4) - 1;
          if (idx >= 0 && idx < sampleCount) isKey[idx] = 1;
        }
      } else {
        isKey.fill(1);
      }

      // Normalizar PTS a segundos desde el primer cuadro presentado (igual que <video> con _waasOffset).
      let minPts = Infinity;
      for (let i = 0; i < Math.min(sampleCount, 32); i++) if (pts[i] < minPts) minPts = pts[i];
      const basePts = Number.isFinite(minPts) ? minPts / timescale + editShiftSec : 0;
      const ptsSec = new Float64Array(sampleCount);
      const durSec = new Float64Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        ptsSec[i] = pts[i] / timescale + editShiftSec - basePts;
        durSec[i] = durs[i] / timescale;
      }

      return { codecInfo, rotation, sampleCount, offsets, sizes, ptsSec, durSec, isKey };
    }
    return null;
  }

  async function captureByWebCodecs(file, start, dur, fps, side, mode, onProgress, signal) {
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
      throw new Error("sin VideoDecoder");
    }
    const track = await parseMp4Video(file);
    if (!track) throw new Error("contenedor no MP4");
    const cfg = { ...track.codecInfo, hardwareAcceleration: "prefer-hardware" };
    let sup = await VideoDecoder.isConfigSupported(cfg);
    if (!sup.supported) {
      cfg.hardwareAcceleration = "no-preference";
      sup = await VideoDecoder.isConfigSupported(cfg);
    }
    if (!sup.supported) throw new Error("codec no soportado por VideoDecoder: " + cfg.codec);

    const n = Math.max(1, Math.round(dur * fps));
    const T = Array.from({ length: n }, (_, k) => start + (k + 0.5) / fps);
    const tEnd = start + dur;

    // Buscar el último keyframe en o antes de start, y el último cuadro necesario para tEnd.
    let kfIdx = 0;
    for (let i = 0; i < track.sampleCount; i++) {
      if (track.isKey[i] && track.ptsSec[i] <= start + 0.002) kfIdx = i;
      if (track.ptsSec[i] > start + 1.0 && i > kfIdx) break;
    }
    let endIdx = track.sampleCount - 1;
    for (let i = kfIdx; i < track.sampleCount; i++) {
      if (track.ptsSec[i] > tEnd + 0.25) { endIdx = Math.min(track.sampleCount - 1, i + 4); break; }
    }

    // Leer solo el rango de bytes del archivo que cubre [kfIdx..endIdx].
    let minOff = Infinity, maxEnd = 0;
    for (let i = kfIdx; i <= endIdx; i++) {
      const o = track.offsets[i], e = o + track.sizes[i];
      if (o < minOff) minOff = o;
      if (e > maxEnd) maxEnd = e;
    }
    checkAbort(signal);
    const chunkBuf = new Uint8Array(await file.slice(minOff, maxEnd).arrayBuffer());

    const snap = makeSnapper(side, mode, track.rotation);
    const slots = new Array(n);
    let next = 0, pendingFirst = 0, presented = 0;
    let pendingFrame = null, lastSnap = null, decError = null;

    const decoder = new VideoDecoder({
      output: (vf) => {
        presented++;
        if (decError || (signal && signal.aborted) || next >= n) { vf.close(); return; }
        const mt = vf.timestamp / 1e6;
        if (pendingFrame && T[next] < mt - 1e-4) {
          lastSnap = snap(pendingFrame);
          lastSnap.used = true;
          pendingFrame.close();
          pendingFrame = null;
          while (next < n && T[next] < mt - 1e-4) slots[next++] = lastSnap;
        } else if (!pendingFrame) {
          while (next < n && T[next] < mt - 1e-4) { pendingFirst++; next++; }
        }
        if (pendingFrame) { pendingFrame.close(); pendingFrame = null; }
        if (next >= n) { vf.close(); return; }
        pendingFrame = vf;
        if (pendingFirst) {
          lastSnap = snap(pendingFrame);
          lastSnap.used = true;
          pendingFrame.close();
          pendingFrame = null;
          for (let i = 0; i < pendingFirst; i++) slots[i] = lastSnap;
          pendingFirst = 0;
        }
        if (onProgress && (presented % 10 === 0 || next >= n)) {
          onProgress(`Leyendo cuadros ${next}/${n}`, next / n);
        }
      },
      error: (e) => { decError = e; },
    });

    try {
      decoder.configure(cfg);
      for (let i = kfIdx; i <= endIdx; i++) {
        checkAbort(signal);
        if (decError) throw decError;
        if (next >= n) break;
        const rel = track.offsets[i] - minOff;
        const data = chunkBuf.subarray(rel, rel + track.sizes[i]);
        decoder.decode(new EncodedVideoChunk({
          type: track.isKey[i] ? "key" : "delta",
          timestamp: Math.round(track.ptsSec[i] * 1e6),
          duration: Math.round(track.durSec[i] * 1e6),
          data,
        }));
        if (decoder.decodeQueueSize >= 16) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await decoder.flush();
      if (decError) throw decError;
      if (next < n && pendingFrame) {
        lastSnap = snap(pendingFrame);
        lastSnap.used = true;
        pendingFrame.close();
        pendingFrame = null;
      }
      while (next < n && lastSnap) slots[next++] = lastSnap;
      if (next < n) throw new Error("VideoDecoder no produjo suficientes cuadros");
      if (onProgress) onProgress(`Leyendo cuadros ${n}/${n}`, 1);
      return {
        slots,
        presented,
        width: track.rotation === 90 || track.rotation === 270 ? track.codecInfo.codedHeight : track.codecInfo.codedWidth,
        height: track.rotation === 90 || track.rotation === 270 ? track.codecInfo.codedWidth : track.codecInfo.codedHeight,
      };
    } catch (e) {
      for (const s of new Set(slots.filter(Boolean).concat(lastSnap ? [lastSnap] : []))) {
        if (s.bmp) s.bmp.close();
        else s.bmpPromise.then((b) => b.close());
      }
      throw e;
    } finally {
      if (pendingFrame) { try { pendingFrame.close(); } catch {} }
      try { decoder.close(); } catch {}
    }
  }

  // Por defecto intenta WebCodecs (decodificación secuencial sin saltos); si no aplica, usa <video>.
  async function captureFrames(file, start, dur, fps, side, mode, onProgress, signal, method = "webcodecs") {
    const t0 = performance.now();
    let res, metodo, width = 0, height = 0, duration = 0, offset = 0;

    if (method === "webcodecs") {
      try {
        metodo = "webcodecs";
        res = await captureByWebCodecs(file, start, dur, fps, side, mode, onProgress, signal);
        width = res.width;
        height = res.height;
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        log("info", "video:captura-respaldo", { fallo: "webcodecs", motivo: String(e && e.message || e) });
        res = null;
      }
    }

    if (!res) {
      let v = await loadVideo(file);
      try {
        if (!v.videoWidth || !v.videoHeight) throw new Error("El video no tiene imagen (¿es solo audio?)");
        offset = v._waasOffset || 0;
        width = v.videoWidth;
        height = v.videoHeight;
        duration = v.duration;
        const methods = method === "reproduccion" ? ["reproduccion", "saltos"] : ["saltos", "reproduccion"];
        for (let i = 0; i < methods.length; i++) {
          metodo = methods[i];
          try {
            res = metodo === "saltos"
              ? await captureBySeeking(v, offset + start, dur, fps, side, mode, onProgress, signal)
              : await captureByPlayback(v, offset + start, dur, fps, side, mode, onProgress, signal);
            break;
          } catch (e) {
            if ((e && e.name === "AbortError") || i === methods.length - 1) throw e;
            log("info", "video:captura-respaldo", { fallo: metodo, motivo: String(e && e.message || e) });
            URL.revokeObjectURL(v._waasUrl);
            v = await loadVideo(file);
          }
        }
      } finally {
        URL.revokeObjectURL(v._waasUrl);
        v.removeAttribute("src");
        v.load();
      }
    }

    // Resolver los bitmaps y deduplicar referencias.
    const frames = [];
    const cache = new Map();
    for (const s of res.slots) {
      if (!cache.has(s)) cache.set(s, { bmp: s.bmp || await s.bmpPromise, fp: s.fp });
      frames.push(cache.get(s));
    }
    let unique = 0;
    for (let i = 0; i < frames.length; i++) if (i === 0 || !sameBytes(frames[i].fp, frames[i - 1].fp)) unique++;
    log("info", "video:cuadros", { metodo, cuadros: frames.length, distintos: unique, mostrados: res.presented, fpsCaptura: fps, ladoCaptura: side, ms: Math.round(performance.now() - t0), ancho: width, alto: height, duracionVideo: duration, desfase: offset });
    if (offset > 0) log("info", "video:desfase", `El video empieza en ${offset.toFixed(3)} s; se compensó`);
    return frames;
  }

  // ---------------------------------------------------------------- GIF e imágenes
  // GIF, WebP animado y APNG se decodifican con ImageDecoder (WebCodecs): <video> no los abre.
  const animCache = new WeakMap(); // File -> { durs (ms por cuadro), width, height }

  function isAnimationFile(file) {
    return /^image\/(gif|webp|png|apng)$/i.test(file.type || "") || /\.(gif|webp|png|apng)$/i.test(file.name || "");
  }

  function imageType(file) {
    if (file.type && file.type.startsWith("image/")) return file.type;
    const ext = (file.name || "").split(".").pop().toLowerCase();
    return { gif: "image/gif", webp: "image/webp", png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg" }[ext] || "image/gif";
  }

  async function openDecoder(file) {
    if (typeof ImageDecoder === "undefined") throw new Error("Este navegador no puede leer GIF animados (falta ImageDecoder). Usa Chrome o Edge actualizados.");
    const type = imageType(file);
    if (!(await ImageDecoder.isTypeSupported(type))) throw new Error("El navegador no puede leer imágenes " + type);
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
    await dec.completed;
    await dec.tracks.ready;
    return dec;
  }

  // Duración de cada cuadro. Los navegadores muestran a 100 ms los cuadros de GIF que dicen durar
  // 10 ms o menos (muchos GIF viejos dicen 0); aquí se hace lo mismo para que se vea igual.
  async function probeAnimation(file) {
    if (animCache.has(file)) return animCache.get(file);
    const dec = await openDecoder(file);
    try {
      const track = dec.tracks.selectedTrack;
      const n = track ? track.frameCount : 1;
      const durs = [];
      let width = 0, height = 0;
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (!i) { width = image.displayWidth; height = image.displayHeight; }
        const ms = image.duration != null ? image.duration / 1000 : 0;
        durs.push(ms > 10 ? ms : 100);
        image.close();
      }
      const info = { frames: n, durs, duration: n > 1 ? durs.reduce((a, b) => a + b, 0) / 1000 : 0, width, height, animated: n > 1 };
      animCache.set(file, info);
      return info;
    } finally {
      dec.close();
    }
  }

  // Captura un GIF a fps fijo durante dur segundos (si dur supera al GIF, este se repite).
  async function captureAnimation(file, dur, fps, side, mode, onProgress, signal) {
    const t0 = performance.now();
    const info = await probeAnimation(file);
    const ends = [];
    let acc = 0;
    for (const d of info.durs) { acc += d; ends.push(acc); }
    const total = acc || 1;
    const n = Math.max(1, Math.round(dur * fps));
    const want = [];
    for (let i = 0; i < n; i++) {
      const t = (((i + 0.5) * 1000) / fps) % total;
      let k = 0;
      while (k < ends.length - 1 && ends[k] <= t) k++;
      want.push(k);
    }
    const needed = [...new Set(want)].sort((a, b) => a - b);
    const snap = makeSnapper(side, mode);
    const byIndex = new Map();
    const dec = await openDecoder(file);
    try {
      for (let j = 0; j < needed.length; j++) {
        checkAbort(signal);
        const { image } = await dec.decode({ frameIndex: needed[j] });
        const s = snap(image);
        image.close();
        byIndex.set(needed[j], { bmp: await s.bmpPromise, fp: s.fp });
        if (onProgress && (j % 5 === 0 || j === needed.length - 1)) onProgress(`Leyendo cuadros del GIF ${j + 1}/${needed.length}`, (j + 1) / needed.length);
      }
    } finally {
      dec.close();
    }
    const frames = want.map((k) => byIndex.get(k));
    log("info", "gif:cuadros", { cuadrosGif: info.frames, usados: needed.length, cuadros: frames.length, fpsCaptura: fps, ladoCaptura: side, duracionGif: info.duration, ms: Math.round(performance.now() - t0) });
    return frames;
  }

  // Imagen fija (JPG, PNG, WebP…). En un GIF se toma el primer cuadro.
  async function probeImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error("El navegador no pudo leer la imagen (" + (e && e.message ? e.message : e) + ")"); }
    const out = { width: bmp.width, height: bmp.height, animated: false };
    bmp.close();
    if (isAnimationFile(file) && typeof ImageDecoder !== "undefined") {
      try { out.animated = (await probeAnimation(file)).animated; } catch (e) { /* se usa como imagen fija */ }
    }
    return out;
  }

  async function captureImage(file, side, mode) {
    const bmp = await createImageBitmap(file);
    try {
      const s = makeSnapper(side, mode)(bmp);
      return { bmp: await s.bmpPromise, fp: s.fp };
    } finally {
      bmp.close();
    }
  }

  // Línea de tiempo del sticker: los cuadros capturados (que cubren capDur) se reparten en dur
  // segundos. Si dur es mayor, la animación se repite ("repetir") o se queda en su último cuadro.
  function fitTimeline(captured, capDur, dur, fps, fit) {
    const n = Math.max(1, Math.round(dur * fps));
    if (n === captured.length) return captured;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / fps;
      const tv = fit === "repetir" ? t % capDur : Math.min(t, capDur);
      out[i] = captured[Math.max(0, Math.min(captured.length - 1, Math.floor(tv * fps)))];
    }
    return out;
  }

  // ---------------------------------------------------------------- WebP
  function readChunks(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) !== "RIFF" || tag(8) !== "WEBP") throw new Error("El canvas no devolvió un WebP válido");
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = tag(i);
      const size = dv.getUint32(i + 4, true);
      chunks.push({ fourcc, data: bytes.subarray(i + 8, i + 8 + size) });
      i += 8 + size + (size & 1);
    }
    return chunks;
  }

  function chunk(fourcc, data) {
    const pad = data.length & 1;
    const out = new Uint8Array(8 + data.length + pad);
    out.set(te.encode(fourcc), 0);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  }

  function concat(parts) {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function u24(arr, off, v) { arr[off] = v & 255; arr[off + 1] = (v >> 8) & 255; arr[off + 2] = (v >> 16) & 255; }

  // Codifica un cuadro como WebP estático y devuelve los sub-chunks de imagen (ALPH + VP8 / VP8L).
  async function encodeStaticFrame(bitmap, quality, canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") throw new Error("Este navegador no puede generar WebP (devolvió " + blob.type + "). Usa Chrome o Edge.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Camino rápido sin copias: la mayoría de cuadros sin alfa son RIFF + WEBP + un solo chunk VP8/VP8L.
    if (bytes.length > 20) {
      const f0 = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (f0 === "VP8 " || f0 === "VP8L") {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sz = dv.getUint32(16, true);
        const end = 20 + sz + (sz & 1);
        if (end <= bytes.length) {
          return { payload: bytes.subarray(12, end), hasAlpha: f0 === "VP8L" };
        }
      }
    }
    const parts = readChunks(bytes).filter((c) => c.fourcc === "ALPH" || c.fourcc === "VP8 " || c.fourcc === "VP8L");
    if (!parts.some((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L")) throw new Error("WebP sin datos de imagen");
    const payload = concat(parts.map((c) => chunk(c.fourcc, c.data)));
    const hasAlpha = parts.some((c) => c.fourcc === "ALPH" || c.fourcc === "VP8L");
    return { payload, hasAlpha };
  }

  // Solo mide el peso exacto de los chunks de imagen (ALPH + VP8/VP8L) sin copiar ni concatenar.
  async function measureStaticFrameBytes(bitmap, quality, canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.type !== "image/webp") throw new Error("Este navegador no puede generar WebP (devolvió " + blob.type + "). Usa Chrome o Edge.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let total = 0, i = 12;
    while (i + 8 <= bytes.length) {
      const f = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      const sz = dv.getUint32(i + 4, true);
      const step = 8 + sz + (sz & 1);
      if (f === "ALPH" || f === "VP8 " || f === "VP8L") total += step;
      i += step;
    }
    return total;
  }

  function buildAnimatedWebp(frames, exif, side = SIDE) {
    // frames: [{payload, hasAlpha, durationMs}]
    const anyAlpha = frames.some((f) => f.hasAlpha);
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0) | (exif ? 0x08 : 0); // animación, alfa, EXIF
    u24(vp8x, 4, side - 1);
    u24(vp8x, 7, side - 1);
    const anim = new Uint8Array(6); // color de fondo 0 (transparente), bucle infinito
    const parts = [chunk("VP8X", vp8x), chunk("ANIM", anim)];
    for (const f of frames) {
      const hdr = new Uint8Array(16);
      u24(hdr, 0, 0); u24(hdr, 3, 0);
      u24(hdr, 6, side - 1); u24(hdr, 9, side - 1);
      u24(hdr, 12, Math.max(1, Math.min(0xffffff, f.durationMs)));
      hdr[15] = 0x02; // sin mezcla (cada cuadro reemplaza al anterior), sin descarte
      parts.push(chunk("ANMF", concat([hdr, f.payload])));
    }
    if (exif) parts.push(chunk("EXIF", exif));
    const body = concat(parts);
    const riff = new Uint8Array(12);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
    riff.set(te.encode("WEBP"), 8);
    return concat([riff, body]);
  }

  // WebP fijo (un solo cuadro, sin animación) con los metadatos de WhatsApp.
  function buildStillWebp(frame, exif, side = SIDE) {
    const vp8x = new Uint8Array(10);
    vp8x[0] = (frame.hasAlpha ? 0x10 : 0) | (exif ? 0x08 : 0);
    u24(vp8x, 4, side - 1);
    u24(vp8x, 7, side - 1);
    const body = concat([chunk("VP8X", vp8x), frame.payload].concat(exif ? [chunk("EXIF", exif)] : []));
    const riff = new Uint8Array(12);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, 4 + body.length, true);
    riff.set(te.encode("WEBP"), 8);
    return concat([riff, body]);
  }

  function exifWhatsApp(meta) {
    // Bloque TIFF big-endian con un único tag 0x5741 ("WA") que contiene el JSON (igual que WhatsApp).
    const js = te.encode(JSON.stringify(meta));
    const out = new Uint8Array(26 + js.length);
    const dv = new DataView(out.buffer);
    out.set([0x4d, 0x4d, 0x00, 0x2a], 0);
    dv.setUint32(4, 8);
    dv.setUint16(8, 1);
    dv.setUint16(10, 0x5741);
    dv.setUint16(12, 7);
    dv.setUint32(14, js.length);
    dv.setUint32(18, 26);
    dv.setUint32(22, 0);
    out.set(js, 26);
    return out;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Elige qué cuadros capturados usar para un fps y cuánto dura cada uno.
  function plan(nCaptured, dur, fps, captureFps) {
    const totalMs = Math.round(dur * 1000);
    const count = Math.max(1, Math.round(dur * fps));
    const out = [];
    for (let k = 0; k < count; k++) {
      const startMs = Math.round((k * 1000) / fps);
      const endMs = k === count - 1 ? totalMs : Math.min(totalMs, Math.round(((k + 1) * 1000) / fps));
      const idx = Math.min(nCaptured - 1, Math.round((k * captureFps) / fps));
      out.push({ idx, durationMs: Math.max(1, endMs - startMs) });
    }
    return out;
  }

  // Codifica el sticker para un lado y fps dados. Empieza en la calidad estimada que quepa
  // (evita una pasada entera desperdiciada en opciones amarillas) y codifica cuadros en paralelo.
  async function encodeWebp(an, side, fps, exifMetaOrPromise, { onProgress, signal, syncMs = 0, still = false }) {
    const { frames, dur, captureFps } = an;
    const p = plan(frames.length, dur, fps, captureFps);
    // Colapsar cuadros consecutivos idénticos una sola vez antes del bucle de calidades.
    const runs = [];
    const uniqueFrames = [];
    const seenFrame = new Set();
    let prevF = null;
    for (let k = 0; k < p.length; k++) {
      const f = frames[p[k].idx];
      if (runs.length && prevF && (f === prevF || sameBytes(f.fp, prevF.fp))) {
        runs[runs.length - 1].durationMs += p[k].durationMs;
        continue;
      }
      runs.push({ f, durationMs: p[k].durationMs });
      prevF = f;
      if (!seenFrame.has(f)) { seenFrame.add(f); uniqueFrames.push(f); }
    }

    const qStart = Q_BY_SIDE[side] || 0.5;
    const qList = [];
    for (let q = qStart; q >= Q_MIN - 1e-9; q -= 0.1) qList.push(+q.toFixed(2));
    if (qList[qList.length - 1] > Q_MIN) qList.push(Q_MIN);

    // Si ya tenemos muestra del análisis, saltar directo a la mayor calidad estimada que quepa.
    let startIdx = 0;
    if (an.sampleBytes && an.sampleBytes[side] && !still) {
      for (let i = 0; i < qList.length - 1; i++) {
        const est = (sampleAvg(an, side, qList[i]) + 32) * runs.length + 400;
        if (est <= MAX_STICKER_BYTES * 1.02) { startIdx = i; break; }
        startIdx = i + 1;
      }
    }

    const pool = createCanvasPool(side, Math.min(ENCODE_CONCURRENCY, uniqueFrames.length));
    const attempts = [];
    let best = null;
    let exifBytes = null;
    for (let i = startIdx; i < qList.length; i++) {
      const q = qList[i];
      // Con la muestra del análisis se salta directo a una calidad que probablemente quepa.
      if (best && an.sampleBytes && i < qList.length - 1) {
        const ratio = sampleAvg(an, side, q) / sampleAvg(an, side, best.q);
        if (ratio > 0 && best.bytes.length * ratio > MAX_STICKER_BYTES * 0.98) { attempts.push({ q, saltado: true, previsto: Math.round(best.bytes.length * ratio) }); continue; }
      }
      let encodedCount = 0;
      const encodedArr = await runPool(uniqueFrames, pool, async (f, _idx, slot) => {
        const enc = await encodeStaticFrame(f.bmp, q, slot.canvas, slot.ctx);
        encodedCount++;
        if (onProgress && (encodedCount % 8 === 0 || encodedCount === uniqueFrames.length)) {
          onProgress(`Codificando (${side} px, ${fps} fps, calidad ${Math.round(q * 100)}) ${encodedCount}/${uniqueFrames.length}`, 0.1 + 0.85 * (encodedCount / uniqueFrames.length));
        }
        return enc;
      }, signal);
      const cache = new Map();
      for (let u = 0; u < uniqueFrames.length; u++) cache.set(uniqueFrames[u], encodedArr[u]);

      const out = [];
      for (let r = 0; r < runs.length; r++) {
        const enc = cache.get(runs[r].f);
        const prev = out[out.length - 1];
        if (prev && sameBytes(prev.payload, enc.payload)) prev.durationMs += runs[r].durationMs;
        else out.push({ payload: enc.payload, hasAlpha: enc.hasAlpha, durationMs: runs[r].durationMs });
      }
      // Compensación de desfase: el primer cuadro se muestra syncMs más, para que la imagen espere al audio.
      if (syncMs > 0 && !still) out[0] = { ...out[0], durationMs: out[0].durationMs + syncMs };
      if (!exifBytes) exifBytes = exifWhatsApp(await exifMetaOrPromise);
      const bytes = still ? buildStillWebp(out[0], exifBytes, side) : buildAnimatedWebp(out, exifBytes, side);
      attempts.push({ q, bytes: bytes.length, cuadros: out.length });
      best = { bytes, side, fps, q, frames: out.length };
      if (bytes.length <= MAX_STICKER_BYTES) break;
    }
    log("info", "webp:intentos", { side, fps, intentos: attempts });
    if (!best || best.bytes.length > MAX_STICKER_BYTES) {
      throw new Error(`No cabe en 1 MB ni con la calidad mínima (${Math.round(best.bytes.length / 1000)} KB). Elige menos fps o menos resolución.`);
    }
    return best;
  }

  function sampleAvg(an, side, q) {
    const m = an.sampleBytes && an.sampleBytes[side];
    if (!m) return 0;
    if (m[q] != null) return m[q];
    // Interpolación lineal entre las calidades medidas.
    const qs = Object.keys(m).map(Number).sort((x, y) => x - y);
    if (q <= qs[0]) return m[qs[0]];
    if (q >= qs[qs.length - 1]) return m[qs[qs.length - 1]];
    for (let i = 0; i < qs.length - 1; i++) if (q >= qs[i] && q <= qs[i + 1]) {
      const t = (q - qs[i]) / (qs[i + 1] - qs[i]);
      return m[qs[i]] + t * (m[qs[i + 1]] - m[qs[i]]);
    }
    return 0;
  }

  // ---------------------------------------------------------------- audio
  // El audio decodificado se guarda por archivo: la forma de onda y la creación no lo decodifican dos veces.
  const audioCache = new WeakMap();
  function decodeAudioFile(file) {
    if (!audioCache.has(file)) {
      const p = (async () => {
        const buf = await file.arrayBuffer();
        try {
          const dctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
          return await dctx.decodeAudioData(buf);
        } catch (e) {
          const err = new Error("No se pudo leer el audio. ¿El archivo tiene sonido? (" + (e && e.message ? e.message : e) + ")");
          err.cause = e;
          throw err;
        }
      })();
      p.catch(() => audioCache.delete(file));
      audioCache.set(file, p);
    }
    return audioCache.get(file);
  }

  // Duración y forma de onda (picos por tramo) de un archivo de audio o de video.
  async function probeAudio(file, buckets = 1200) {
    const d = await decodeAudioFile(file);
    const chans = Array.from({ length: d.numberOfChannels }, (_, c) => d.getChannelData(c));
    const per = Math.max(1, Math.floor(d.length / buckets));
    const peaks = new Float32Array(Math.ceil(d.length / per));
    let max = 0;
    for (let b = 0; b < peaks.length; b++) {
      let p = 0;
      const end = Math.min(d.length, (b + 1) * per);
      for (const ch of chans) for (let i = b * per; i < end; i += 4) { const a = Math.abs(ch[i]); if (a > p) p = a; }
      peaks[b] = p;
      if (p > max) max = p;
    }
    return { duration: d.duration, channels: d.numberOfChannels, peaks, peakMax: max };
  }

  async function extractAudio(file, start, dur, fadeMs = 0) {
    const decoded = await decodeAudioFile(file);
    if (decoded.duration < start + 0.05) throw new Error(`El audio dura ${decoded.duration.toFixed(2)} s y el tramo empieza en ${start.toFixed(2)} s`);
    const len = Math.max(1, Math.round(dur * SAMPLE_RATE));
    const octx = new OfflineAudioContext(1, len, SAMPLE_RATE);
    const src = octx.createBufferSource();
    src.buffer = decoded;
    src.connect(octx.destination); // mezcla a mono
    src.start(0, start, dur);
    const rendered = await octx.startRendering();
    const pcm = rendered.getChannelData(0);
    // Fundido muy corto en los bordes: un corte a mitad de una onda suena como un "clic".
    if (fadeMs > 0) {
      const f = Math.min(Math.floor(pcm.length / 2), Math.round((fadeMs / 1000) * SAMPLE_RATE));
      for (let i = 0; i < f; i++) { const g = i / f; pcm[i] *= g; pcm[pcm.length - 1 - i] *= g; }
    }
    let peak = 0, sumsq = 0;
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; sumsq += pcm[i] * pcm[i]; }
    const rms = Math.sqrt(sumsq / pcm.length);
    log("info", "audio:pcm", { canalesOriginales: decoded.numberOfChannels, rateOriginal: decoded.sampleRate, duracionAudio: decoded.duration, muestras: pcm.length, pico: +peak.toFixed(4), rms: +rms.toFixed(4) });
    if (peak < 0.0005) log("warn", "audio:silencio", "El tramo elegido parece no tener sonido");
    return pcm;
  }

  async function encodeOpus(pcm, bitrate = 32000) {
    if (typeof AudioEncoder === "undefined") throw new Error("Este navegador no tiene WebCodecs (AudioEncoder). Usa Chrome o Edge actualizados.");
    const base = { codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate };
    const candidates = [
      { ...base, bitrateMode: "variable", opus: { frameDuration: 20000, complexity: 10, application: "voip", signal: "voice" } },
      { ...base, bitrateMode: "variable", opus: { frameDuration: 20000 } },
      base,
    ];
    let config = null;
    for (const c of candidates) {
      try { if ((await AudioEncoder.isConfigSupported(c)).supported) { config = c; break; } } catch (e) { /* probar siguiente */ }
    }
    if (!config) throw new Error("El navegador no puede codificar Opus con WebCodecs");
    const packets = [];
    let description = null;
    let encError = null;
    const enc = new AudioEncoder({
      output: (chunkOut, meta) => {
        const b = new Uint8Array(chunkOut.byteLength);
        chunkOut.copyTo(b);
        packets.push(b);
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          const d = meta.decoderConfig.description;
          description = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        }
      },
      error: (e) => { encError = e; },
    });
    enc.configure(config);
    const BLOCK = 960 * 50;
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const n = Math.min(BLOCK, pcm.length - i);
      const data = new Float32Array(pcm.subarray(i, i + n));
      const ad = new AudioData({ format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
    if (encError) throw encError;
    let preSkip = 312;
    if (description && description.length >= 12 && String.fromCharCode(...description.subarray(0, 8)) === "OpusHead") {
      preSkip = description[10] | (description[11] << 8);
    }
    return { packets, preSkip, config };
  }

  // Ogg (RFC 3533) + encapsulado Opus (RFC 7845)
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      t[i] = r >>> 0;
    }
    return t;
  })();
  function oggCrc(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return c >>> 0;
  }
  function oggPage(headerType, granule, serial, seq, packetList) {
    const lacing = [];
    for (const p of packetList) {
      let len = p.length;
      while (len >= 255) { lacing.push(255); len -= 255; }
      lacing.push(len);
    }
    if (lacing.length > 255) throw new Error("Página Ogg con demasiados segmentos");
    const dataLen = packetList.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + dataLen);
    const dv = new DataView(page.buffer);
    page.set(te.encode("OggS"), 0);
    page[4] = 0;
    page[5] = headerType;
    dv.setBigInt64(6, BigInt(granule), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packetList) { page.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc(page), true);
    return page;
  }
  function buildOggOpus(packets, preSkip, totalSamples) {
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const head = new Uint8Array(19);
    head.set(te.encode("OpusHead"), 0);
    head[8] = 1; head[9] = 1;
    new DataView(head.buffer).setUint16(10, preSkip, true);
    new DataView(head.buffer).setUint32(12, SAMPLE_RATE, true);
    const vendor = te.encode("WAAudioStickers");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(te.encode("OpusTags"), 0);
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    const pages = [oggPage(0x02, 0, serial, 0, [head]), oggPage(0x00, 0, serial, 1, [tags])];
    const finalGranule = preSkip + totalSamples;
    const PER_PAGE = 50; // ~1 s por página con cuadros de 20 ms
    let seq = 2;
    for (let i = 0; i < packets.length; i += PER_PAGE) {
      const group = packets.slice(i, i + PER_PAGE);
      const last = i + PER_PAGE >= packets.length;
      const granule = last ? finalGranule : Math.min(finalGranule, preSkip + (i + group.length) * 960);
      pages.push(oggPage(last ? 0x04 : 0x00, granule, serial, seq++, group));
    }
    return concat(pages);
  }

  async function sha256b64(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let s = "";
    for (const b of h) s += String.fromCharCode(b);
    return btoa(s);
  }

  async function verifyOgg(bytes) {
    try {
      const ctx = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer);
      return { ok: true, duracion: +buf.duration.toFixed(3) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  // ---------------------------------------------------------------- metadatos del sticker
  // WhatsApp muestra el nombre del paquete y el autor bajo el sticker. Los stickers con el mismo
  // paquete y autor comparten identificador (se calcula a partir de ambos) para agruparse.
  async function packIdFor(packName, publisher) {
    if (!packName && !publisher) return crypto.randomUUID();
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode("stickers-con-sonido|" + packName + "|" + publisher)));
    const x = Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
  }
  async function stickerMeta({ packName = "", publisher = "", soundSha }) {
    packName = String(packName || "").trim().slice(0, 128);
    publisher = String(publisher || "").trim().slice(0, 128);
    const meta = { "sticker-pack-id": await packIdFor(packName, publisher) };
    if (packName) meta["sticker-pack-name"] = packName;
    if (publisher) meta["sticker-pack-publisher"] = publisher;
    meta.emojis = ["🔊"];
    meta["sound-sha256"] = soundSha;
    return meta;
  }
  // Cambia los metadatos (EXIF) de un sticker ya creado sin volver a codificarlo.
  async function retagWebp(blob, { packName, publisher, soundSha }) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = readChunks(bytes).filter((c) => c.fourcc !== "EXIF");
    const vp8x = chunks.find((c) => c.fourcc === "VP8X");
    if (vp8x) { const d = new Uint8Array(vp8x.data); d[0] |= 0x08; vp8x.data = d; }
    const meta = await stickerMeta({ packName, publisher, soundSha });
    const body = concat([te.encode("WEBP")].concat(chunks.map((c) => chunk(c.fourcc, c.data)), [chunk("EXIF", exifWhatsApp(meta))]));
    const riff = new Uint8Array(8);
    riff.set(te.encode("RIFF"), 0);
    new DataView(riff.buffer).setUint32(4, body.length, true);
    return new Blob([concat([riff, body])], { type: "image/webp" });
  }

  // ---------------------------------------------------------------- API pública
  // Paso 1: captura el tramo una sola vez y estima cuánto pesaría cada combinación de
  // resolución y fps. Los cuadros quedan en memoria para crear el sticker sin recapturar.
  //
  // Fuentes:
  // - visual: { kind: "video" | "gif" | "image", file, start, dur }  (un GIF se usa completo: start 0)
  // - audio:  { file, start, dur }  (puede ser otro archivo; por defecto, el mismo video y tramo)
  // - fit, cuando la imagen y el audio duran distinto:
  //   "repetir"       el sticker dura lo que el audio y la animación se repite;
  //   "congelar"      el sticker dura lo que el audio y queda en el último cuadro;
  //   "independiente" cada uno conserva su duración (WhatsApp no exige que coincidan).
  // Si la animación es más larga que el audio, con "repetir"/"congelar" se corta al largo del audio.
  // Una imagen fija siempre dura lo que el audio.
  async function analyze({ file, start = 0, duration, mode = "ajustar", visual, audio, fit = "repetir", onProgress, signal }) {
    if (!visual) visual = { kind: "video", file, start, dur: duration };
    if (!audio) audio = { file: visual.file, start: visual.start, dur: visual.dur };
    const prog = onProgress || (() => {});
    const t0 = performance.now();
    const vDur = visual.kind === "image" ? audio.dur : visual.dur;
    const dur = visual.kind === "image" || fit !== "independiente" ? audio.dur : vDur; // duración del sticker
    const capDur = Math.min(vDur, dur);                                                // lo que se captura
    const base = { file: visual.file, start: visual.start || 0, visual, audio, fit, dur, vDur, mode };

    if (visual.kind === "image") {
      // Un solo cuadro que dura todo el audio: no hay combinaciones de fps que elegir.
      log("info", "analizar:parametros", { tipo: "imagen", archivo: visual.file.name, bytes: visual.file.size, duracionAudio: audio.dur, modo: mode });
      prog("Leyendo la imagen…", 0.3);
      const f = await captureImage(visual.file, SIDE, mode);
      const cells = SIDES.map((side) => ({ side, fps: 1, estado: "ok", score: side }));
      const an = { ...base, frames: [f], captureFps: 1, captureSide: SIDE, distinct: { 1: 1 }, cells, auto: cells[0], ms: Math.round(performance.now() - t0) };
      prog("Imagen lista", 1);
      return an;
    }

    const captureFps = captureFpsFor(dur);
    const slots = Math.ceil(capDur * captureFps);
    const captureSide = Math.max(64, Math.min(SIDE, Math.floor(Math.sqrt(CAPTURE_MEM_BYTES / (4 * slots)))));
    log("info", "analizar:parametros", {
      tipo: visual.kind, archivo: visual.file.name, bytes: visual.file.size, inicio: visual.start || 0, duracionImagen: vDur,
      audioAparte: audio.file !== visual.file, duracionAudio: audio.dur, ajuste: fit, duracionSticker: dur, modo: mode, captureFps, captureSide,
    });
    const capProg = (t, f) => prog(t, f * 0.8);
    const captured = visual.kind === "gif"
      ? await captureAnimation(visual.file, capDur, captureFps, captureSide, mode, capProg, signal)
      : await captureFrames(visual.file, visual.start || 0, capDur, captureFps, captureSide, mode, capProg, signal);
    const frames = fitTimeline(captured, capDur, dur, captureFps, fit);
    const sides = SIDES.filter((x) => x <= captureSide);
    const fpsList = FPS_LIST.filter((x) => x <= captureFps);
    // Cuadros distintos para cada fps (los repetidos se fusionan y casi no pesan).
    const distinct = {};
    for (const f of fpsList) {
      const p = plan(frames.length, dur, f, captureFps);
      let d = 0;
      for (let k = 0; k < p.length; k++) {
        const a = frames[p[k].idx], b = k ? frames[p[k - 1].idx] : null;
        if (!b || (a !== b && !sameBytes(a.fp, b.fp))) d++;
      }
      distinct[f] = d;
    }
    // Muestra: hasta 12 cuadros distintos repartidos por el tramo con desplazamiento áureo.
    // Se miden resoluciones ancla (cada 2 pasos, incluyendo extremos) en paralelo con un pool
    // de OffscreenCanvas y se interpolan en escala log-log las resoluciones intermedias.
    const uniq = [];
    for (let i = 0; i < frames.length; i++) if (!i || (frames[i] !== frames[i - 1] && !sameBytes(frames[i].fp, frames[i - 1].fp))) uniq.push(frames[i]);
    const M = Math.min(12, uniq.length);
    const sample = Array.from({ length: M }, (_, i) => uniq[Math.min(uniq.length - 1, Math.floor(((i + ((i * 0.618) % 1)) * uniq.length) / M))]);

    const anchorSides = sides.filter((_, i) => i === 0 || i === sides.length - 1 || i % 2 === 0);
    const sampleBytes = {};
    let done = 0;
    for (const side of anchorSides) {
      const pool = createCanvasPool(side, Math.min(ENCODE_CONCURRENCY, sample.length));
      sampleBytes[side] = {};
      const qs = Q_BY_SIDE[side] === Q_MIN ? [Q_MIN] : [Q_BY_SIDE[side], Q_MIN];
      for (const q of qs) {
        const sizes = await runPool(sample, pool, (f, _idx, slot) => measureStaticFrameBytes(f.bmp, q, slot.canvas, slot.ctx), signal);
        let sum = 0;
        for (let i = 0; i < sizes.length; i++) sum += sizes[i];
        sampleBytes[side][q] = sum / sizes.length;
      }
      prog("Calculando opciones…", 0.8 + (0.2 * ++done) / anchorSides.length);
    }
    // Interpolar en escala log-log las resoluciones intermedias (el peso WebP sigue una ley de potencia).
    const logInterp = (s, sHi, sLo, bHi, bLo) => {
      if (bHi <= 0 || bLo <= 0) return (bHi + bLo) / 2;
      const t = Math.log(s / sLo) / Math.log(sHi / sLo);
      return Math.exp(Math.log(bLo) + t * (Math.log(bHi) - Math.log(bLo)));
    };
    for (const side of sides) {
      if (sampleBytes[side]) continue;
      let sHi = anchorSides[0], sLo = anchorSides[anchorSides.length - 1];
      for (let i = 0; i < anchorSides.length - 1; i++) {
        if (anchorSides[i] >= side && anchorSides[i + 1] <= side) { sHi = anchorSides[i]; sLo = anchorSides[i + 1]; break; }
      }
      sampleBytes[side] = {
        [Q_BY_SIDE[side]]: logInterp(side, sHi, sLo, sampleBytes[sHi][Q_BY_SIDE[sHi]], sampleBytes[sLo][Q_BY_SIDE[sLo]]),
        [Q_MIN]: logInterp(side, sHi, sLo, sampleBytes[sHi][Q_MIN], sampleBytes[sLo][Q_MIN]),
      };
    }
    const overhead = 32; // cabecera ANMF + chunk
    const cells = [];
    for (const side of SIDES) for (const fps of FPS_LIST) {
      if (!sampleBytes[side] || distinct[fps] == null) { cells.push({ side, fps, estado: "fuera" }); continue; }
      const n = distinct[fps];
      const est = (sampleBytes[side][Q_BY_SIDE[side]] + overhead) * n + 400;
      const estMin = (sampleBytes[side][Q_MIN] + overhead) * n + 400;
      const estado = est <= SAFE_BYTES ? "ok" : estMin <= SAFE_BYTES ? "baja" : "no";
      cells.push({ side, fps, est: Math.round(est), estMin: Math.round(estMin), estado, score: score(side, fps) });
    }
    const pick = (st) => cells.filter((c) => c.estado === st).sort((x, y) => y.score - x.score)[0];
    const auto = pick("ok") || pick("baja") || null;
    const an = { ...base, frames, captureFps, captureSide, sampleBytes, distinct, cells, auto, ms: Math.round(performance.now() - t0) };
    log("info", "analizar:resultado", {
      ms: an.ms, captureFps, captureSide, distintos: distinct, muestra: M,
      auto: auto && { side: auto.side, fps: auto.fps, est: auto.est, estado: auto.estado },
      caben: cells.filter((c) => c.estado === "ok").length, conMenosCalidad: cells.filter((c) => c.estado === "baja").length,
    });
    prog("Opciones listas", 1);
    return an;
  }

  function release(an) {
    if (!an || !an.frames) return;
    for (const f of new Set(an.frames)) { try { f.bmp.close(); } catch (e) { /* ya cerrado */ } }
    an.frames = null;
  }

  // Paso 2: codifica el audio y el sticker con la combinación elegida.
  async function create(an, { side, fps, syncMs = 0, still = false, audio = null, onProgress, signal, packName = "", publisher = "" }) {
    if (!an || !an.frames) throw new Error("Primero calcula las opciones del tramo");
    syncMs = Math.max(0, Math.min(1000, Math.round(+syncMs || 0)));
    still = !!still && an.visual.kind === "image";
    const prog = onProgress || (() => {});
    const t0 = performance.now();
    const { dur } = an;
    // El audio puede cambiar después del análisis sin recalcular: con "independiente" no afecta a los cuadros.
    const A = audio || an.audio;
    if (an.visual.kind === "image" || an.fit !== "independiente") {
      if (Math.abs(A.dur - an.audio.dur) > 0.002) throw new Error("La duración del audio cambió: vuelve a calcular las opciones");
    }
    const cell = an.cells.find((c) => c.side === side && c.fps === fps);
    log("info", "crear:parametros", { side, fps, compensacionMs: syncMs, estatico: still, estimado: cell && cell.est, estado: cell && cell.estado });

    // Audio y WebP en paralelo: el hash del audio solo se necesita al armar el EXIF final.
    const bitrate = Math.max(12000, Math.min(32000, Math.floor((0.9 * MAX_AUDIO_BYTES * 8) / A.dur)));
    if ((bitrate / 8) * A.dur > 0.97 * MAX_AUDIO_BYTES) throw new Error(`Con ${Math.round(A.dur)} s el audio no cabe en 1 MB (límite de WhatsApp). Máximo unos ${Math.floor((0.9 * MAX_AUDIO_BYTES * 8) / 12000 / 60)} minutos.`);
    prog("Codificando audio y video…", 0.05);
    const audioPromise = (async () => {
      // Un audio aparte se corta donde el usuario quiera: se suaviza el corte para evitar clics.
      const pcm = await extractAudio(A.file, A.start, A.dur, A.file !== an.visual.file ? 8 : 0);
      checkAbort(signal);
      const { packets, preSkip, config } = await encodeOpus(pcm, bitrate);
      const ogg = buildOggOpus(packets, preSkip, pcm.length);
      if (ogg.length > MAX_AUDIO_BYTES) throw new Error(`El audio pesa ${Math.round(ogg.length / 1000)} KB (máximo 1000 KB)`);
      const soundSha = await sha256b64(ogg);
      const oggCheck = await verifyOgg(ogg);
      log(oggCheck.ok ? "info" : "error", "audio:ogg", { bytes: ogg.length, paquetes: packets.length, preSkip, config, verificacion: oggCheck, soundSha256: soundSha });
      if (!oggCheck.ok) throw new Error("El audio generado no se puede reproducir: " + oggCheck.error);
      const exifMeta = await stickerMeta({ packName, publisher, soundSha });
      return { ogg, soundSha, exifMeta };
    })();

    const [audioRes, w] = await Promise.all([
      audioPromise,
      encodeWebp(an, side, fps, audioPromise.then((a) => a.exifMeta), { onProgress: prog, signal, syncMs, still }),
    ]);
    const { ogg, soundSha, exifMeta } = audioRes;
    const info = {
      tipo: an.visual.kind, ajuste: an.fit,
      duracion: dur, duracionAudio: A.dur, segundosAudio: Math.max(1, Math.round(A.dur)),
      fps: an.visual.kind === "image" ? null : w.fps, calidad: w.q, lado: w.side, cuadros: w.frames, isAnimated: !still,
      compensacionMs: syncMs, webpBytes: w.bytes.length, estimado: cell && cell.est,
      oggBytes: ogg.length, audioKbps: Math.round(bitrate / 1000), soundSha256: soundSha, paquete: exifMeta["sticker-pack-name"] || "", autor: exifMeta["sticker-pack-publisher"] || "",
      msTotal: Math.round(performance.now() - t0),
    };
    log("info", "crear:resultado", info);
    prog("Listo", 1);
    return { webp: new Blob([w.bytes], { type: "image/webp" }), ogg: new Blob([ogg], { type: "audio/ogg; codecs=opus" }), info };
  }

  // Atajo (pruebas): analizar + elegir (automático o fijo) + crear.
  async function convert({ file, start = 0, duration, mode = "ajustar", visual, audio, fit, still = false, syncMs = 0, side = "auto", fps = "auto", onProgress, signal }) {
    const an = await analyze({ file, start, duration, mode, visual, audio, fit, onProgress, signal });
    try {
      let c = an.auto;
      if (side !== "auto" || fps !== "auto") {
        const ok = an.cells.filter((x) => (side === "auto" || x.side === +side) && (fps === "auto" || x.fps === +fps) && x.estado !== "no" && x.estado !== "fuera");
        c = ok.sort((x, y) => y.score - x.score)[0];
      }
      if (!c) throw new Error("Ninguna combinación cabe en 1 MB para este tramo");
      const r = await create(an, { side: c.side, fps: c.fps, syncMs, still, onProgress, signal });
      r.analysis = { auto: an.auto, cells: an.cells, ms: an.ms, captureFps: an.captureFps, captureSide: an.captureSide };
      return r;
    } finally {
      release(an);
    }
  }

  // Comprobaciones del navegador para el diagnóstico.
  async function capabilities() {
    const out = { offscreenCanvas: typeof OffscreenCanvas !== "undefined", webCodecsAudio: typeof AudioEncoder !== "undefined" };
    try {
      const c = new OffscreenCanvas(4, 4);
      c.getContext("2d").fillRect(0, 0, 2, 2);
      const b = await c.convertToBlob({ type: "image/webp", quality: 0.5 });
      out.webpEncode = b.type;
    } catch (e) { out.webpEncode = "error: " + e.message; }
    if (out.webCodecsAudio) {
      try { out.opus = (await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 })).supported; } catch (e) { out.opus = "error: " + e.message; }
    }
    return out;
  }

  WAAS.convert = convert;
  WAAS.probeVideo = probeVideo;
  WAAS.probeAudio = probeAudio;
  WAAS.probeImage = probeImage;
  WAAS.probeAnimation = probeAnimation;
  WAAS.isAnimationFile = isAnimationFile;
  WAAS.capabilities = capabilities;
  WAAS.analyze = analyze;
  WAAS.retagWebp = retagWebp;
  WAAS.create = create;
  WAAS.release = release;
  WAAS.limits = { SIDE, MAX_STICKER_BYTES, MAX_AUDIO_BYTES, SIDES, FPS_LIST };
  WAAS._internals = { buildOggOpus, buildAnimatedWebp, buildStillWebp, fitTimeline, exifWhatsApp, readChunks, plan, sha256b64, score };
})();

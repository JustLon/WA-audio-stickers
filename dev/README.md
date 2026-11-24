# Herramientas de desarrollo

Páginas para probar la extensión sin WhatsApp. Sírvelas desde la raíz del repositorio con un servidor local:

```sh
python3 -m http.server 8765
```

- `http://127.0.0.1:8765/dev/harness.html`: expone `testConvert(url, opciones)` y `testEstimate(url, opciones)`. Convierten un video (por ejemplo, uno servido desde una carpeta local) y comparan el peso estimado con el real.
- `http://127.0.0.1:8765/dev/ui-test.html`: monta el panel con Trusted Types obligatorio, como en WhatsApp Web. Ábrelo con `window.postMessage({ __waas: "togglePanel" }, location.origin)`.
- `calibracion/calibracion_desfase.mp4`: contador de milisegundos con un pitido en cada "0". Sirve para medir el desfase entre audio e imagen de un sticker en un celular. Se genera con `generar_calibracion.py`.

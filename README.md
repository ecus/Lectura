# Lectura

Lector de PDF para iPhone y iPad (y cualquier navegador) que muestra tus PDF como un libro:

- **Efecto de hoja real**: arrastra una esquina para doblar la página, desliza o toca los bordes.
- **Dos páginas** en el iPad horizontal, una en el iPhone (o elige tú en Ajustes).
- **Marcadores personalizados**: nombre, color, nota; aparecen como cinta en la página y en la barra.
- **Índice** del PDF y "Ir a la página".
- **Papel** blanco, sepia o modo noche. Sonido de hoja opcional.
- **Lupa** con pellizco y doble toque para letra pequeña.
- Recuerda la última página de cada libro. Todo se guarda **en tu dispositivo** y funciona **sin internet**.

## Instalar en iPhone / iPad

1. Abre la dirección de la app en **Safari**.
2. Toca **Compartir** → **Agregar a inicio**.
3. Abre *Lectura* desde el ícono y toca **Añadir PDF**.

> La app instalada y Safari guardan sus datos por separado: importa tus PDF desde la app instalada.

## Publicarla gratis (GitHub Pages)

En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
En un minuto estará en `https://<usuario>.github.io/Lectura/`.

## Desarrollo

Es una web estática sin compilación. Para probarla en local:

```sh
python3 -m http.server 8000
```

Librerías incluidas en `vendor/`: [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) y
[StPageFlip](https://github.com/Nodlik/StPageFlip) 2.0.7 (MIT).
Al cambiar archivos, sube `VERSION` en `sw.js` para que los dispositivos reciban la actualización.

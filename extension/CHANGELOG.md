# Cambios

## 0.1.3

- Folio pasa a llamarse **Overfree**, con logo nuevo (la «O» abierta y el cubículo 246). Los comandos y ajustes (`folio.*`) no cambian: tu configuración se conserva.

## 0.1.2

- Icono de Folio en la barra de actividad (como PlatformIO), con una vista *Acciones*: compilar, ver el PDF, SyncTeX, revisar, tablas, DOI, registro, limpiar y ajustes.

## 0.1.1

- SyncTeX: el doble clic en el PDF podía llevar al archivo equivocado (p. ej. al \input siguiente)
  cuando el párrafo terminaba justo antes de un \section o \input. Ahora manda el carácter pulsado.
- Barra del visor PDF: en paneles estrechos el número de página se partía en varias líneas y el buscador
  se cortaba.
- Pruebas de integración dentro de VS Code con TeX real (`npm run test:integration`).

## 0.1.0

Primera versión: compilación con el TeX del sistema (mismas pasadas que la app Folio, auxiliares en
`.folio/build`), errores traducidos en Problemas, visor PDF con SyncTeX en los dos sentidos, revisión
en vivo y del proyecto, tablas desde Excel/CSV, figuras al soltar imágenes y referencias por DOI.

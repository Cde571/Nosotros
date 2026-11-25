# NOSOTROS. 0.3

Un espacio privado para dos: agenda, compras, viajes, estados de ánimo, notas, ideas, películas y un widget para Windows. Interfaz oscura basada en la imagen de referencia y el HTML facilitado, con tipografía editorial, corcho y tonos terracota y oliva. Ambas ventanas de escritorio usan controles propios, sin barra blanca de Windows.

El [instalador de Windows x64](https://github.com/Cde571/Nosotros/releases/latest/download/Nosotros-Setup.exe) incluye la conexión a Supabase. Al abrir la app, crea el espacio desde **Ajustes** y comparte el código para que tu pareja se vincule.

## Ver el diseño en local

```powershell
npm ci
npm run dev
```

Abre [http://127.0.0.1:4173](http://127.0.0.1:4173). Usa **Ver ejemplo**, o abre [la vista ilustrativa](http://127.0.0.1:4173/?demo=1), para ver las tarjetas con contenido. Los datos del ejemplo no se guardan ni se envían a Supabase. **Mi espacio** vuelve a tus datos. El servidor solo escucha en este equipo y sirve la interfaz y sus assets, no el código de administración o los archivos SQL.

En **Buzón de notas**, **Añadir nota** abre el editor. También puedes partir de una nota de ejemplo y cambiar el título y el mensaje. Cada nota se edita desde el tablero o desde **Buzón** en la barra lateral, donde aparecen todas.

## Conectar la pareja

Una vez preconfigurado el servicio:

1. Cada persona elige su nombre, foto y estado en Ajustes. El perfil se guarda al cambiarlo.
2. La primera persona pulsa **Crear nuestro espacio y obtener código** y comparte el código.
3. La segunda introduce ese código y pulsa **Vincularme**. No necesita crear una contraseña. El código vence en 30 minutos y solo admite a una persona más.

Las fotos se recortan a JPEG de 160 × 160. Cada persona elige su propia foto desde su equipo. Los datos locales se copian al espacio al vincularse. Los cambios pendientes se conservan y se reintentan al reconectar. Realtime actualiza el tablero; la consulta periódica de respaldo ocurre cada 15 segundos mientras la ventana está visible. Las ediciones simultáneas se señalan para revisión, en lugar de sobrescribirse silenciosamente.

El acceso rápido usa una identidad anónima autenticada de Supabase guardada en este dispositivo. **Recuperar o proteger mi acceso** permite asociar un correo y contraseña a esa misma identidad, o iniciar sesión desde otro dispositivo. Si se elimina el perfil del dispositivo antes de asociar un correo, ese acceso no se podrá recuperar desde la app.

## Preparación única del servicio

La compilación de este repositorio incluye la conexión pública al proyecto **Nosotros** mediante `cloud-config.js`. Para vincular la pareja desde una instalación, basta con usar el flujo por código. Si necesitas configurar otro proyecto Supabase, usa el conector de Codex o un token de administración autorizado para aplicar el esquema. No compartas tokens administrativos.

Para automatizar la preparación, define `SUPABASE_PROJECT_REF` y `SUPABASE_ACCESS_TOKEN` en tu terminal y ejecuta:

```powershell
npm run setup:cloud
npm run build:native
```

El script comprueba las tablas existentes, aplica el esquema o la actualización, activa los accesos anónimos, verifica RLS y escribe únicamente URL y clave **públicas** en `cloud-config.js`. Nunca incluye el token de administración en el instalador. Se ejecuta una sola vez por el responsable del proyecto, no por cada integrante de la pareja.

Si usas SQL Editor en un proyecto nuevo, ejecuta `schema.sql` y `migration-0.2.sql`. A continuación, ejecuta las migraciones de `supabase/migrations` en orden. En un proyecto existente, aplica las migraciones que falten desde su versión actual. Activa los accesos anónimos en Supabase Auth y configura la URL y clave pública en `cloud-config.js` antes de compilar. Realtime avisa a los dos integrantes cuando alguien se vincula o actualiza una nota, foto o estado.

## Compilar Windows

Requiere Node.js, .NET Framework 4.x y WebView2 Runtime. Las dependencias de compilación WebView2 1.0.2903.40 deben estar extraídas en `webview2/` desde el [paquete oficial NuGet](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40).

```powershell
npm ci
npm run build:native
```

El instalador queda en `dist-native/Nosotros-Setup.exe`; no está firmado digitalmente. También puedes ejecutar `native-payload/Nosotros.exe --preview` para ver el diseño con datos ilustrativos en un perfil de prueba independiente. `--smoke` verifica la carga, un guardado local, la agenda y el control del widget, y escribe `native-payload/smoke-result.json`.

La variante Electron reutiliza el mismo cliente y funciona con `npm start` después de instalar su binario. En entornos que desactivan los scripts de instalación de npm, ejecuta `node node_modules/electron/install.js` para descargarlo desde el proveedor oficial. El instalador nativo no depende de Electron.

## Validación y límites

`npm test` ejecuta PostgreSQL en memoria con PGlite y comprueba vinculación, invitaciones vencidas y consumidas, límite de dos personas, acceso por pareja, privacidad de fotos, votos, cambios simultáneos y reintentos tras respuestas interrumpidas. También comprueba restauración de tokens y paginación del cliente. La prueba contra el proyecto real validó vinculación por código, avisos de Realtime, actualización de foto y estado, edición de notas en ambos sentidos y aislamiento de un tercer perfil.

La app guarda datos y sesión en el perfil de Windows. Quien tenga acceso a ese perfil puede acceder a su almacenamiento. El esquema limita la lectura a integrantes de la pareja y las escrituras pasan por funciones validadas. Las fotos de perfil se guardan en la base de datos del espacio. No hay cifrado de extremo a extremo. Los [assets y su procedencia](assets/README.md) se incluyen sin depender de servicios externos de imágenes o fuentes.

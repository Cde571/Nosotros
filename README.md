# NOSOTROS.

Un espacio digital privado para dos: calendario, compras, viajes, ideas, recuerdos y un widget para Windows.

## Descargar

[Nosotros-Setup.exe (Windows x64)](https://github.com/Cde571/Nosotros/releases/latest/download/Nosotros-Setup.exe)

Requiere Windows de 64 bits con Microsoft Edge WebView2 Runtime. El instalador no está firmado. La versión 0.1 permite trabajar localmente; la sincronización por internet requiere configurar Supabase.

## Vinculación de pareja

1. Crea un proyecto Supabase y ejecuta `schema.sql` una sola vez en SQL Editor.
2. En ambos equipos instala la aplicación, abre Ajustes y configura la misma URL y clave pública del proyecto (nunca la clave secreta).
3. Cada integrante crea una cuenta independiente e inicia sesión.
4. El primer integrante crea el espacio y genera un código de invitación de 30 minutos. El segundo lo introduce y el primero aprueba la solicitud.

La sincronización entre dos cuentas todavía no se ha validado de extremo a extremo. No introducir información sensible hasta revisar seguridad y copias de respaldo. La versión móvil no está incluida.

## Compilar en Windows

Requiere Node.js, npm, .NET Framework 4.x y WebView2 Runtime. Ejecuta `npm ci`, descarga el paquete NuGet Microsoft.Web.WebView2 versión 1.0.2903.40 desde nuget.org, extrae su contenido en la carpeta `webview2` y ejecuta `powershell -File build-native.ps1`. El resultado queda en `dist-native/`.

## Privacidad

El repositorio contiene código y esquema, no cuentas, datos personales, códigos de invitación ni claves de servidor. Los datos del usuario se guardan en su perfil local y, si configura la conexión, en su proyecto Supabase.

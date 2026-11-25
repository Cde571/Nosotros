// Run once by the app maintainer; no server credential is written to the app.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;

async function api(endpoint, method = "GET", body) {
  const response = await fetch(
    "https://api.supabase.com/v1/projects/" + ref + endpoint,
    {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  if (!response.ok)
    throw Error(
      "Supabase rechazó " +
        method +
        " " +
        endpoint +
        " (" +
        response.status +
        "). Revisa el proyecto y los permisos del token.",
    );
  return response.json();
}
async function query(sql, readOnly = false) {
  return api("/database/query", "POST", { query: sql, read_only: readOnly });
}
async function setup() {
  if (!/^[a-z0-9]{20}$/.test(ref || "") || !token)
    throw Error(
      "Define SUPABASE_PROJECT_REF y SUPABASE_ACCESS_TOKEN en tu terminal. El token debe autorizar este proyecto. No lo pegues en el chat ni en cloud-config.js.",
    );
  const tables = await query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('spaces','members','invites','items')",
    true,
  );
  if (tables.length !== 0 && tables.length !== 4)
    throw Error(
      "El proyecto tiene un esquema parcial. Revísalo antes de aplicar el esquema de Nosotros.",
    );
  let sql = "begin;\n";
  if (!tables.length)
    sql += fs.readFileSync(path.join(root, "schema.sql"), "utf8") + "\n";
  else {
    const columns = await query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='members'",
      true,
    );
    if (
      !["space_id", "user_id", "name", "approved"].every((name) =>
        columns.some((c) => c.column_name === name),
      )
    )
      throw Error(
        "Las tablas existentes no corresponden a Nosotros. Usa el proyecto de la aplicación.",
      );
  }
  sql += fs.readFileSync(path.join(root, "migration-0.2.sql"), "utf8") + "\n";
  for (const name of fs
    .readdirSync(path.join(root, "supabase/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql +=
      fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8") +
      "\n";
  sql += "commit;";
  await query(sql);
  const auth = await api("/config/auth", "PATCH", {
    external_anonymous_users_enabled: true,
  });
  if (auth.external_anonymous_users_enabled !== true)
    throw Error("Supabase no confirmó el acceso por código.");
  const keys = await api("/api-keys");
  const key =
    keys.find((k) => k.type === "publishable") ||
    keys.find((k) => k.name === "anon");
  if (!key?.api_key)
    throw Error(
      "Esquema aplicado. No se encontró una clave pública para configurar la app.",
    );
  if (key.api_key.startsWith("sb_secret_"))
    throw Error("Se rechazó una clave privada.");
  const verification = await query(
    "select relname,relrowsecurity from pg_class where oid in ('public.spaces'::regclass,'public.members'::regclass,'public.invites'::regclass,'public.items'::regclass,'public.pair_updates'::regclass)",
    true,
  );
  if (verification.length !== 5 || verification.some((t) => !t.relrowsecurity))
    throw Error("La verificación de privacidad no pasó.");
  const realtime = await query(
    "select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('items','pair_updates')",
    true,
  );
  if (realtime.length !== 2)
    throw Error("Supabase no confirmó Realtime para el tablero y los perfiles.");
  fs.writeFileSync(
    path.join(root, "cloud-config.js"),
    "// URL y clave públicas; el token de administración nunca se incluye.\nwindow.NOSOTROS_CLOUD = " +
      JSON.stringify({
        url: "https://" + ref + ".supabase.co",
        key: key.api_key,
      }) +
      ";\n",
  );
  console.log(
    "Esquema verificado, acceso por código habilitado y cloud-config.js preparado. Ejecuta npm run build:native para distribuirlo.",
  );
}
setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

const $ = (id) => document.getElementById(id);
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const defaults = window.NOSOTROS_CLOUD || {};
let cfg = { ...defaults, ...read("profile", {}) };
if (!cfg.url && defaults.url) Object.assign(cfg, defaults);
let session = read("session", null),
  user = null,
  space = null,
  rows = read("local", []),
  queue = read("queue", []);
let active = "home",
  editing = null,
  widget = false,
  subscribed = "",
  busy = false,
  syncAgain = false,
  online = false,
  realtime = false,
  known = new Set(),
  first = true;
const conflicts = new Map();
let syncing = null;
let demo = new URLSearchParams(location.search).has("demo"),
  demoRows = [],
  profileTimer,
  started = false,
  profileRevision = 0;
const cats = {
  home: ["Inicio", "home"],
  plan: ["Agenda", "calendar"],
  compra: ["Compras", "shopping"],
  viaje: ["Viajes", "travel"],
  idea: ["Ideas", "idea"],
  nota: ["Buzón", "note"],
  recuerdo: ["Ver juntos", "photo"],
  meta: ["Metas", "goal"],
};
const covers = ["orbita", "bosque", "verano", "viaje"];
const datefmt = new Intl.DateTimeFormat("es-CO", {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const dayfmt = new Intl.DateTimeFormat("es-CO", { weekday: "short" });
function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
    use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "icons.svg#" + name);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}
function button(label, action, cls) {
  const b = node("button", label, cls);
  b.type = "button";
  b.onclick = action;
  return b;
}
function toast(text, undo) {
  const el = $("toast");
  el.replaceChildren(node("span", text));
  if (undo) el.append(button("Deshacer", undo, "text-button"));
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 5000);
}
function msg(text) {
  $("message").textContent = text;
}
function items() {
  return demo ? demoRows : rows;
}
function persist() {
  store(space?.approved ? "cache:" + space.id : "local", rows);
  store("queue", queue);
}
function makeDemo() {
  const day = (offset, hour = "18:00") => {
    let d = new Date();
    d.setDate(d.getDate() + offset);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      "T" +
      hour
    );
  };
  const entries = [
    ["plan", "Cena sushi", 0, "Propuesta por ella · Una mesa para dos."],
    [
      "plan",
      "Ver película",
      1,
      "Palomitas, sofá y nuestra película pendiente.",
    ],
    ["plan", "Cine en pareja", 2, "Una cita que no se nos olvide."],
    ["plan", "Cocinar juntos", 3, "Elegimos la receta entre los dos."],
    ["compra", "Café", null, ""],
    ["compra", "Snacks para la peli", null, ""],
    ["compra", "Regalo para el gato", null, ""],
    [
      "viaje",
      "Escapada a Villa de Leyva",
      12,
      "Reservar hotel · Preparar maletas",
    ],
    [
      "nota",
      "No olvides tomar agüita, te amo.",
      null,
      "Un recordatorio con cariño.",
    ],
    ["idea", "Cena improvisada", null, ""],
    ["idea", "Tarde de juegos de mesa", null, ""],
    ...["Órbita", "El bosque", "Luz de verano", "Un viaje"].map((x) => [
      "recuerdo",
      x,
      null,
      "",
    ]),
  ];
  demoRows = entries.map(([kind, title, offset, detail], i) => ({
    id: "demo-" + i,
    kind,
    title,
    detail,
    day: offset === null ? "" : day(offset),
    done: i === 4 || i === 5,
    author: i % 2 ? "Él" : "Ella",
    votes: i === 9 ? ["demo-me", "demo-other"] : i === 10 ? ["demo-me"] : [],
    deleted: false,
    updated_at: new Date().toISOString(),
  }));
}
function render() {
  document.body.classList.toggle("demo-mode", demo);
  $("demoBanner").hidden = !demo;
  $("demoToggle").textContent = demo ? "Mi espacio" : "Ver ejemplo";
  renderPeople();
  $("today").textContent = datefmt.format(new Date());
  $("greeting").textContent = demo
    ? "Nuestra semana, a nuestra manera."
    : cfg.name
      ? "Hola, " + cfg.name + ". Este es su espacio."
      : "Nuestro pequeño mundo.";
  $("nav").replaceChildren(
    ...Object.entries(cats).map(([key, [label, symbol]]) => {
      const b = button(
        "",
        () => {
          active = key;
          render();
        },
        "nav-button" + (key === active ? " active" : ""),
      );
      b.append(icon(symbol), node("span", label));
      b.title = label;
      if (key === active) b.setAttribute("aria-current", "page");
      return b;
    }),
  );
  $("home").hidden = active !== "home";
  $("module").hidden = active === "home";
  const live = items()
    .filter((x) => !x.deleted && x.kind !== "latido")
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const plans = live
    .filter((x) => x.kind === "plan")
    .sort((a, b) => (a.day || "z").localeCompare(b.day || "z"));
  drawAgenda(plans);
  draw(
    "compras",
    live.filter((x) => x.kind === "compra"),
    "compra",
  );
  drawTrips(live.filter((x) => x.kind === "viaje"));
  const notes = live.filter((x) => x.kind === "nota");
  $("noteCount").textContent = notes.length + (notes.length === 1 ? " nota" : " notas");
  drawNotes("notas", notes);
  draw("ideas", live.filter((x) => x.kind === "idea"), "idea");
  drawPosters(live.filter((x) => x.kind === "recuerdo"));
  if (active !== "home") {
    $("moduleTitle").textContent = cats[active][0];
    $("moduleAdd").textContent = active === "nota" ? "+ Añadir nota" : "+ Añadir";
    if (active === "nota") drawNotes("moduleRows", notes);
    else draw("moduleRows", live.filter((x) => x.kind === active), active);
  }
  const upcoming = plans.find(
    (x) => !x.done && x.day && new Date(x.day) > new Date(),
  );
  $("nextTitle").textContent = upcoming?.title || "Algo bonito por planear";
  $("nextDetail").textContent =
    upcoming?.detail || "Las mejores historias empiezan con un plan.";
  count(upcoming);
  calendar(plans);
  updateStatus();
}
function empty(el, kind) {
  const copy = {
    plan: ["Su próxima historia empieza aquí.", "Proponer un plan"],
    compra: ["De café a antojos de medianoche.", "Añadir una compra"],
    viaje: ["Un lugar por descubrir, juntos.", "Planear una escapada"],
    idea: ["Ese «algún día» puede ser esta semana.", "Proponer una idea"],
    nota: ["Las palabras pequeñas también se quedan.", "Escribir una nota"],
    recuerdo: [
      "Su próxima maratón, en un solo lugar.",
      "Añadir para ver juntos",
    ],
    meta: ["Un sueño compartido empieza con un paso.", "Añadir una meta"],
  };
  const [text, cta] = copy[kind];
  const p = node("div", null, "empty");
  p.append(
    node("p", text),
    button(cta, () => edit(kind), "text-button"),
  );
  el.append(p);
}
function controls(x, showLabels = false) {
  const tools = node("div", null, "row-tools");
  const editButton = button(showLabels ? "Editar" : "✎", () => edit(x.kind, x));
  editButton.title = "Editar " + x.title;
  editButton.setAttribute("aria-label", editButton.title);
  const del = button(showLabels ? "Eliminar" : "×", () => {
    save({ ...x, deleted: true });
    toast("Elemento eliminado", () => {
      save({ ...x, deleted: false });
      toast("Elemento restaurado");
    });
  });
  del.title = "Eliminar " + x.title;
  del.setAttribute("aria-label", del.title);
  tools.append(editButton, del);
  return tools;
}
function check(x) {
  const b = button(
    x.done ? "✓" : "",
    () => save({ ...x, done: !x.done }),
    "check",
  );
  b.setAttribute(
    "aria-label",
    (x.done ? "Marcar pendiente: " : "Completar: ") + x.title,
  );
  b.setAttribute("aria-pressed", String(x.done));
  return b;
}
function draw(id, list, kind) {
  const el = $(id);
  el.replaceChildren();
  if (!list.length) return empty(el, kind);
  for (const x of list) {
    const row = node("article", null, "row" + (x.done ? " done" : ""));
    if (kind === "idea" && id === "ideas")
      row.append(node("span", "✦", "idea-symbol"));
    else row.append(check(x));
    const body = node("div", null, "body");
    body.append(node("strong", x.title));
    if (x.detail || x.day)
      body.append(
        node(
          "small",
          [x.day ? datefmt.format(new Date(x.day)) : "", x.detail]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    row.append(body);
    if (kind === "idea") {
      const votes = x.votes || [];
      const b = button(
        "♡ " + votes.length + "/2",
        () => vote(x),
        "text-button",
      );
      b.setAttribute(
        "aria-pressed",
        String(votes.includes(demo ? "demo-me" : user || "local")),
      );
      b.title = "Votar por " + x.title;
      row.append(b);
    }
    row.append(controls(x));
    el.append(row);
  }
}
function drawAgenda(list) {
  const el = $("agenda");
  el.replaceChildren();
  if (!list.length) return empty(el, "plan");
  list.forEach((x, i) => {
    const entry = node("article", null, "timeline-entry"),
      label = node("div", null, "day-label");
    if (x.day) {
      const date = new Date(x.day);
      label.append(
        node("small", dayfmt.format(date)),
        node("strong", date.getDate()),
      );
      if (date.toDateString() === new Date().toDateString())
        label.append(node("em", "Hoy"));
    } else label.append(node("small", "Por"), node("strong", "ti"));
    const card = node(
      "div",
      null,
      "event-card" +
        (i % 4 === 1 ? " ticket" : i % 4 === 2 ? " featured" : "") +
        (x.done ? " done" : ""),
    );
    card.append(node("strong", x.title));
    if (x.detail) card.append(node("p", x.detail, "sub"));
    const footer = node("div", null, "event-footer");
    footer.append(
      node("span", x.day ? x.day.slice(11, 16) : "Sin fecha", "sub"),
      check(x),
      controls(x),
    );
    card.append(footer);
    entry.append(label, card);
    el.append(entry);
  });
}
function drawTrips(list) {
  const el = $("viajes");
  el.replaceChildren();
  if (!list.length) {
    const img = node("img", null, "empty-art");
    img.src = "assets/villa-de-leyva.png";
    img.alt = "Inspiración para viajar: plaza colonial de Villa de Leyva";
    el.append(img);
    return empty(el, "viaje");
  }
  for (const x of list) {
    const trip = node("article", null, "trip");
    const cover = node("div", null, "trip-cover"),
      img = node("img");
    img.src = "assets/villa-de-leyva.png";
    img.alt = "Villa de Leyva, imagen de inspiración";
    const body = node("div");
    body.append(node("strong", x.title));
    const remaining = x.day
      ? Math.ceil((new Date(x.day) - new Date()) / 86400000)
      : null;
    body.append(
      node(
        "p",
        remaining === null
          ? "Por ponerle fecha"
          : remaining < 0
            ? "Una escapada para recordar"
            : remaining === 0
              ? "El viaje empieza hoy"
              : "Faltan " + remaining + " días",
      ),
    );
    cover.append(img, body);
    trip.append(cover);
    if (x.detail) trip.append(node("p", x.detail, "sub"));
    const tools = node("div", null, "trip-buttons");
    tools.append(
      button(x.done ? "✓ Completado" : "○ Por hacer", () =>
        save({ ...x, done: !x.done }),
      ),
      controls(x),
    );
    trip.append(tools);
    el.append(trip);
  }
}
function drawNotes(id, list) {
  const el = $(id);
  el.replaceChildren();
  if (!list.length) {
    const p = node("div", "Escribe algo para recordar o compartir.", "empty-note");
    p.append(button("Usar una nota de ejemplo", () => edit("nota", null, {
      title: "Un recordatorio con cariño",
      detail: "No olvides tomar agüita. Te amo.",
    })));
    return el.append(p);
  }
  for (const x of list) {
    const card = node("article", null, "sticky");
    card.append(node("strong", x.title));
    if (x.detail) card.append(node("p", x.detail, "note-body"));
    card.append(node("small", x.author), controls(x, true));
    el.append(card);
  }
}
function drawPosters(list) {
  const el = $("memories");
  el.replaceChildren();
  if (!list.length) {
    el.classList.add("empty-posters");
    covers.forEach((cover, i) => {
      const b = button("", () => edit("recuerdo"), "poster");
      b.title = "Añadir una película o serie";
      const img = node("img");
      img.src = "assets/" + cover + ".svg";
      img.alt = "Ilustración para su próxima película";
      b.append(img);
      el.append(b);
    });
    return;
  }
  el.classList.remove("empty-posters");
  for (const [i, x] of list.entries()) {
    const b = button(
      "",
      () => edit("recuerdo", x),
      "poster" + (x.done ? " done" : ""),
    );
    b.title = x.title;
    const img = node("img");
    img.src = "assets/" + covers[i % 4] + ".svg";
    img.alt = "";
    b.append(img, node("span", x.title));
    el.append(b);
  }
}
function count(p) {
  if (!p) {
    $("countdown").textContent = "—";
    return;
  }
  const n = Math.max(0, Math.floor((new Date(p.day) - Date.now()) / 60000));
  $("countdown").textContent =
    Math.floor(n / 1440) +
    "d " +
    Math.floor((n % 1440) / 60) +
    "h " +
    (n % 60) +
    "m";
}
function calendar(plans) {
  const now = new Date(),
    y = now.getFullYear(),
    m = now.getMonth(),
    cal = node("div", null, "cal");
  for (const label of ["L", "M", "M", "J", "V", "S", "D"])
    cal.append(node("span", label, "cal-day"));
  for (let i = 0; i < (new Date(y, m, 1).getDay() + 6) % 7; i++)
    cal.append(node("span"));
  for (let i = 1; i <= new Date(y, m + 1, 0).getDate(); i++) {
    const d =
        y +
        "-" +
        String(m + 1).padStart(2, "0") +
        "-" +
        String(i).padStart(2, "0"),
      b = button(i, () => {
        edit("plan");
        $("day").value = d + "T18:00";
      });
    b.title = "Planear el " + i;
    if (plans.some((x) => x.day.startsWith(d))) b.classList.add("marked");
    if (i === now.getDate()) b.classList.add("today");
    cal.append(b);
  }
  $("calendar").replaceChildren(cal);
}
function updateEditor() {
  const isNote = $("kind").value === "nota";
  $("editorTitle").textContent = isNote
    ? (editing ? "Editar nota" : "Nueva nota")
    : (editing ? "Editar momento" : "Nuevo momento");
  $("titleLabel").textContent = "Título";
  $("title").placeholder = isNote ? "Ponle un título a tu nota" : "Algo que les haga ilusión";
  $("detailLabel").textContent = isNote ? "Nota" : "Detalles";
  $("detail").placeholder = isNote ? "Escribe tu mensaje…" : "El lugar, un recordatorio, ese pequeño detalle…";
  $("dateField").hidden = isNote;
  $("editorSave").textContent = isNote ? "Guardar nota" : "Guardar momento";
}
function edit(kind, x, draft = x) {
  editing = x || null;
  $("kind").value = kind;
  $("title").value = draft?.title || "";
  $("day").value = x?.day || "";
  $("detail").value = draft?.detail || "";
  const conflict = conflicts.get(x?.id);
  $("editorError").textContent = conflict
    ? "Tu pareja guardó «" + conflict.title + "». Revisa tu versión antes de guardarla."
    : "";
  updateEditor();
  $("editor").showModal();
  $("title").focus();
}
function save(value) {
  const x = { ...value, updated_at: new Date().toISOString() };
  if (demo) {
    demoRows = demoRows.filter((i) => i.id !== x.id);
    demoRows.push(x);
    render();
    return;
  }
  if (space?.approved) {
    x.space_id = space.id;
    const previous = queue.find((i) => i.id === x.id);
    x.expected_version =
      conflicts.get(x.id)?.version ??
      previous?.expected_version ??
      x.version ??
      0;
    conflicts.delete(x.id);
    queue = queue.filter((i) => i.id !== x.id);
    queue.push(x);
  }
  rows = rows.filter((i) => i.id !== x.id);
  rows.push(x);
  persist();
  render();
  sync();
}
$("kind").onchange = updateEditor;
$("itemForm").onsubmit = (e) => {
  e.preventDefault();
  const title = $("title").value.trim();
  const kind = $("kind").value;
  if (!title) {
    $("editorError").textContent = kind === "nota" ? "Escribe un título para tu nota." : "Escribe un título para su momento.";
    return;
  }
  save({
    ...editing,
    id: editing?.id || crypto.randomUUID(),
    kind,
    title,
    day: kind === "nota" ? (editing?.kind === "nota" ? editing.day : "") : $("day").value,
    detail: $("detail").value.trim(),
    done: editing?.done || false,
    deleted: false,
    author: editing?.author || (demo ? "Ella" : cfg.name || "Yo"),
  });
  $("editor").close();
  toast(
    demo
      ? "Guardado solo en este ejemplo"
      : space?.approved
        ? "Guardado · preparando sincronización"
        : "Guardado en este equipo",
  );
};
async function vote(x) {
  if (demo) {
    const votes = new Set(x.votes || []);
    votes.has("demo-me") ? votes.delete("demo-me") : votes.add("demo-me");
    save({ ...x, votes: [...votes] });
    return;
  }
  if (!space?.approved) {
    const votes = (x.votes || []).includes("local") ? [] : ["local"];
    save({ ...x, votes });
    return;
  }
  try {
    await call("vote", { id: x.id });
    await sync();
  } catch (e) {
    toast(e.message);
  }
}
function avatar(person) {
  const el =
    person.photo &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(person.photo)
      ? node("img", null, "avatar")
      : node("span", (person.name || "♡").slice(0, 1).toUpperCase(), "avatar");
  if (el.tagName === "IMG") {
    el.src = person.photo;
    el.alt = person.name || "Foto de perfil";
  }
  return el;
}
function people() {
  if (demo)
    return [
      { id: "demo-me", name: "Ella", mood: "Extrañándote" },
      { id: "demo-other", name: "Él", mood: "Trabajando" },
    ];
  return [
    {
      id: user,
      name: cfg.name || "Tú",
      photo: cfg.photo,
      mood: cfg.mood || "Sin estado",
    },
    space?.members?.find((m) => m.id !== user && m.approved) || {
      name: "Tu pareja",
      mood: "Por vincular",
    },
  ];
}
function renderPeople() {
  const pair = people();
  $("topFaces").replaceChildren(...pair.map(avatar));
  $("sideFaces").replaceChildren(...pair.map(avatar));
  $("moodCards").replaceChildren(
    ...pair.map((p, i) => {
      const card = button(
        "",
        () =>
          i === 0
            ? settings()
            : toast(
                demo
                  ? "Cada persona comparte su propio estado."
                  : "Tu pareja elige su foto y su estado desde su equipo.",
              ),
        "mood-person",
      );
      card.setAttribute(
        "aria-label",
        i === 0 ? "Editar mi foto y estado" : "Estado de " + p.name,
      );
      card.append(
        avatar(p),
        node("strong", p.name),
        node("small", p.mood || "Sin estado"),
        node(
          "span",
          /Trabajando/.test(p.mood)
            ? "☕"
            : /descanso/.test(p.mood)
              ? "☁"
              : "❤️",
          "mood-emoji",
        ),
      );
      return card;
    }),
  );
  const since = demo
    ? new Date(Date.now() - 945 * 86400000)
    : cfg.anniversary ||
      space?.members?.find((m) => m.anniversary)?.anniversary;
  const d = since
    ? since instanceof Date
      ? since
      : new Date(since + "T00:00:00")
    : null;
  $("daysTogether").textContent = d
    ? Math.max(
        0,
        Math.floor(
          (new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) /
            86400000,
        ),
      )
    : "—";
  if (!d) {
    $("anniversaryText").textContent = "Su fecha, su comienzo.";
    return;
  }
  const next = new Date(new Date().getFullYear(), d.getMonth(), d.getDate());
  if (next < new Date().setHours(0, 0, 0, 0))
    next.setFullYear(next.getFullYear() + 1);
  const remaining = Math.ceil(
    (next - new Date().setHours(0, 0, 0, 0)) / 86400000,
  );
  $("anniversaryText").textContent =
    remaining === 0
      ? "Hoy celebramos nuestra historia."
      : "Siguiente aniversario: " + remaining + " días";
}
function updateStatus() {
  let text,
    state = "local";
  if (demo) text = "Vista de ejemplo";
  else if (busy) text = "Sincronizando…";
  else if (!cfg.url || !cfg.key) text = "Guardado en este equipo";
  else if (!user) text = "Por vincular";
  else if (!space) text = "Crea o une su espacio";
  else if (!space.approved) text = "Pendiente de aprobación";
  else if (!online) text = "Sin conexión · guardado local";
  else if (queue.some((x) => x.space_id === space.id))
    text = "Hay cambios pendientes";
  else if (cfg.profileDirty) text = "Perfil pendiente de sincronizar";
  else if (space.members.filter((m) => m.approved).length < 2)
    text = "Esperando a tu pareja";
  else if (realtime) {
    text = "Sincronizado en vivo";
    state = "live";
  } else {
    text = "Actualizado · reconectando";
    state = "polling";
  }
  $("status").textContent = text;
  $("status").dataset.state = state;
  $("shoppingStatus").textContent = demo
    ? "Lista de ejemplo"
    : state === "live"
      ? "Sincronizada en vivo"
      : "Una lista para los dos";
}
function settings() {
  if (demo) {
    toast("Puedes explorar este diseño. El perfil se configura en tu espacio.");
    return;
  }
  $("mood").value = cfg.mood || "Prefiero no compartir";
  for (const key of ["name", "anniversary", "url", "key"])
    $(key).value = cfg[key] || "";
  $("profilePreview").replaceChildren(
    avatar({ name: cfg.name, photo: cfg.photo }),
  );
  $("config").showModal();
  pairView();
}
function saveProfile() {
  cfg.name = $("name").value.trim();
  cfg.anniversary = $("anniversary").value;
  cfg.mood = $("mood").value;
  cfg.profileDirty = true;
  profileRevision++;
  store("profile", cfg);
  render();
  $("profilePreview").replaceChildren(
    avatar({ name: cfg.name, photo: cfg.photo }),
  );
  return sync();
}
async function publishProfile() {
  if (!cfg.profileDirty || !space?.approved || !user) return;
  const revision = profileRevision;
  try {
    await call("profile", {
      name: cfg.name || "Mi perfil",
      photo: cfg.photo || "",
      mood: cfg.mood || "",
      anniversary: cfg.anniversary || "",
    });
    if (revision === profileRevision) {
      cfg.profileDirty = false;
      store("profile", cfg);
    }
  } catch (e) {
    if ($("config").open) msg("Perfil guardado en este equipo. " + e.message);
  }
}
async function call(op, p = {}) {
  const r = await desktop.cloud(op, p);
  if (!r.ok) {
    const error = Error(r.error);
    error.code = r.code;
    throw error;
  }
  return r;
}
async function init() {
  if (!cfg.url || !cfg.key) return;
  const r = await call("init", { url: cfg.url, key: cfg.key, session });
  user = r.user;
  started = true;
  if (user) await sync();
}
async function ensureUser() {
  if (!cfg.url || !cfg.key)
    throw Error(
      "Falta conectar el servicio de Nosotros. Abre «Configuración del servicio» o usa el instalador preconfigurado.",
    );
  if (!started) await init();
  if (!user) {
    const r = await call("anonymous");
    user = r.user;
    session = r.session;
    store("session", session);
  }
}
async function withLoading(id, fn) {
  const b = $(id);
  if (b.disabled) return;
  b.disabled = true;
  try {
    await fn();
  } catch (e) {
    msg(
      /anonymous/i.test(e.message)
        ? "Activa los accesos anónimos en Supabase para vincular con código."
        : e.message,
    );
  } finally {
    b.disabled = false;
    updateStatus();
  }
}
function pairView() {
  const el = $("pairInfo");
  el.replaceChildren(
    node(
      "p",
      !cfg.url
        ? "Tu perfil se guarda en este equipo. La conexión de pareja está pendiente de configurar."
        : !space
          ? "Su espacio privado empieza con un código."
          : !space.approved
            ? "Tu solicitud está pendiente de aprobación."
            : "Espacio privado · " +
              space.members.filter((m) => m.approved).length +
              "/2 integrantes",
    ),
  );
  $("pairActions").hidden = !!space;
  $("invitePanel").hidden =
    !space?.owner || space.members.filter((m) => m.approved).length === 2;
  if (space?.owner)
    for (const member of space.members.filter((m) => !m.approved))
      el.append(
        button("Aprobar a " + member.name, () =>
          withLoading("create", async () => {
            await call("approve", { id: member.id });
            await sync();
          }),
        ),
      );
}
async function makeInvite() {
  const r = await call("invite");
  $("inviteCode").textContent = r.data;
  msg("Código listo. Compártelo solo con tu pareja.");
  pairView();
}
async function pair(op) {
  await saveProfile();
  await ensureUser();
  await call(op, {
    name: cfg.name || "Mi perfil",
    code: $("code").value.trim(),
  });
  cfg.profileDirty = true;
  store("profile", cfg);
  await syncing;
  await sync();
  if (op === "create") await makeInvite();
  else {
    if (space?.approved && online) {
      $("code").value = "";
      msg("Ya están conectados. Cada persona puede elegir su foto.");
      toast("Bienvenidos a su espacio compartido.");
    } else if (space?.approved) {
      msg("Vinculación guardada. La sincronización se reintentará al conectar.");
    }
  }
}
function sync() {
  if (!user || demo) return;
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = syncSpace().finally(() => {
    syncing = null;
    if (syncAgain) {
      syncAgain = false;
      setTimeout(sync, 100);
    }
  });
  return syncing;
}
async function syncSpace() {
  busy = true;
  updateStatus();
  const identity = user;
  try {
    const next = (await call("status")).data;
    if (user !== identity) return;
    if (!next?.approved) {
      space = next;
      online = false;
      pairView();
      return;
    }
    if (space?.id !== next.id) {
      rows = read("cache:" + next.id, []);
      known = new Set();
      first = true;
    }
    space = next;
    const importKey = "imported:" + cfg.url + ":" + space.id;
    if (!read(importKey, false)) {
      for (const old of read("local", []).filter((x) => !x.deleted)) {
        const x = {
          ...old,
          id: crypto.randomUUID(),
          space_id: space.id,
          expected_version: 0,
        };
        rows.push(x);
        queue.push(x);
      }
      store(importKey, true);
      persist();
    }
    await publishProfile();
    if (subscribed !== space.id) {
      await call("sub", { space: space.id });
      subscribed = space.id;
    }
    let conflict = false;
    for (const x of queue.filter((i) => i.space_id === space.id)) {
      try {
        const saved = (await call("save", { item: x })).data;
        queue = queue
          .filter((i) => i.id !== x.id || i.updated_at !== x.updated_at)
          .map((i) =>
            i.id === x.id ? { ...i, expected_version: saved.version } : i,
          );
        store("queue", queue);
      } catch (error) {
        if (error.code === "40001") {
          conflict = true;
          if (!conflicts.has(x.id))
            toast(
              "Tu pareja también editó «" +
                x.title +
                "». Abre el elemento para revisar.",
            );
          conflicts.set(x.id, { version: x.expected_version, title: x.title });
          continue;
        }
        throw error;
      }
    }
    const data = (await call("list", { space: space.id })).data || [];
    if (user !== identity) return;
    for (const x of data.filter((i) => i.kind === "latido")) {
      if (
        !first &&
        !known.has(x.id) &&
        (x.author_id ? x.author_id !== user : x.author !== cfg.name)
      ) {
        toast("♡ " + x.author + " está pensando en ti");
        desktop.notify("NOSOTROS.", "♡ " + x.author + " está pensando en ti");
      }
      known.add(x.id);
    }
    first = false;
    for (const remote of data)
      if (conflicts.has(remote.id)) conflicts.set(remote.id, remote);
    rows = data;
    for (const pending of queue.filter((i) => i.space_id === space.id)) {
      rows = rows.filter((i) => i.id !== pending.id);
      rows.push(pending);
    }
    online = true;
    persist();
    render();
    pairView();
    if (conflict && $("config").open)
      msg(
        "Hay una edición simultánea pendiente. Revisa el elemento antes de volver a guardar.",
      );
  } catch (e) {
    online = false;
    if ($("config").open) msg(e.message);
  } finally {
    busy = false;
    updateStatus();
  }
}
$("new").onclick = () => edit("plan");
$("moduleAdd").onclick = () => edit(active);
document
  .querySelectorAll("[data-add]")
  .forEach((b) => (b.onclick = () => edit(b.dataset.add)));
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
$("calendarToggle").onclick = () => {
  $("calendar").hidden = !$("calendar").hidden;
  $("calendarToggle").setAttribute(
    "aria-expanded",
    String(!$("calendar").hidden),
  );
};
$("widget").onclick = async () => {
  widget = !widget;
  await desktop.widget(widget);
  document.body.classList.toggle("widget-mode", widget);
  $("widget").setAttribute("aria-pressed", String(widget));
};
$("heart").onclick = async () => {
  if (demo) {
    toast("Toque de ejemplo · no se envió a nadie.");
  } else if (!space?.approved) {
    toast("Vincula a tu pareja para enviar un toque.");
    return;
  } else {
    save({
      id: crypto.randomUUID(),
      kind: "latido",
      title: "Pensando en ti",
      day: "",
      detail: "",
      author: cfg.name || "Tu pareja",
      done: false,
      deleted: false,
    });
    toast(
      online
        ? "Toque guardado para enviar."
        : "Sin conexión. El toque se enviará al reconectar.",
    );
  }
  $("heart").classList.add("pulse");
  setTimeout(() => $("heart").classList.remove("pulse"), 700);
};
$("roulette").onclick = () => {
  const options = items().filter(
    (x) => ["idea", "recuerdo"].includes(x.kind) && !x.deleted && !x.done,
  );
  if (!options.length)
    return toast("Añadan ideas o películas para elegir un plan.");
  const x = options[Math.floor(Math.random() * options.length)];
  toast("Elegido: " + x.title);
  edit("plan", null, { title: x.title, detail: x.detail });
};
$("settings").onclick = settings;
$("status").onclick = settings;
$("anniversaryBtn").onclick = settings;
$("localSave").onclick = () => {
  saveProfile();
  msg("Perfil guardado.");
};
for (const id of ["name", "anniversary", "mood"])
  $(id).addEventListener("change", () => {
    clearTimeout(profileTimer);
    profileTimer = setTimeout(saveProfile, 200);
  });
$("photo").onchange = async () => {
  const f = $("photo").files[0];
  if (!f) return;
  try {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
      f.size > 12000000
    )
      throw Error("Elige una foto JPG, PNG o WebP de hasta 12 MB.");
    const im = await createImageBitmap(f),
      c = document.createElement("canvas");
    c.width = c.height = 160;
    const s = Math.min(im.width, im.height);
    c.getContext("2d").drawImage(
      im,
      (im.width - s) / 2,
      (im.height - s) / 2,
      s,
      s,
      0,
      0,
      160,
      160,
    );
    im.close();
    cfg.photo = c.toDataURL("image/jpeg", 0.78);
    await saveProfile();
    msg("Foto guardada.");
  } catch (e) {
    msg(e.message);
  }
};
$("connect").onclick = () =>
  withLoading("connect", async () => {
    const url = new URL($("url").value.trim()),
      key = $("key").value.trim();
    if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co"))
      throw Error("Usa la URL HTTPS de tu proyecto Supabase.");
    if (!key || key.startsWith("sb_secret_"))
      throw Error("Usa la clave pública, nunca una clave secreta.");
    if (!key.startsWith("sb_publishable_")) {
      let payload;
      try {
        payload = JSON.parse(
          atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
        );
      } catch {
        throw Error("La clave pública no es válida.");
      }
      if (payload.role !== "anon")
        throw Error("Usa la clave anon, nunca service_role.");
    }
    if (cfg.url !== url.origin || cfg.key !== key) {
      session = null;
      user = null;
      space = null;
      subscribed = "";
      online = false;
      realtime = false;
      store("session", null);
      rows = read("local", []);
    }
    cfg.url = url.origin;
    cfg.key = key;
    store("profile", cfg);
    await init();
    render();
    pairView();
    msg("Servicio preparado. Crea su espacio o introduce el código.");
  });
$("create").onclick = () => withLoading("create", () => pair("create"));
$("join").onclick = () =>
  withLoading("join", async () => {
    if (!/^[A-Fa-f0-9]{16}$/.test($("code").value.trim()))
      throw Error(
        "El código debe tener los 16 caracteres que te compartió tu pareja.",
      );
    await pair("join");
  });
$("invite").onclick = () => withLoading("invite", makeInvite);
$("copyCode").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("inviteCode").textContent);
    msg("Código copiado.");
  } catch {
    msg("Selecciona el código y cópialo con Ctrl+C.");
  }
};
for (const op of ["signup", "login"])
  $(op).onclick = () =>
    withLoading(op, async () => {
      if (!$("email").value || !$("email").checkValidity())
        throw Error("Escribe un correo válido.");
      if ($("password").value.length < 8)
        throw Error("La contraseña debe tener al menos 8 caracteres.");
      if (!started) await init();
      const r = await call(op, {
        email: $("email").value.trim(),
        password: $("password").value,
      });
      user = r.user;
      session = r.session;
      store("session", session);
      subscribed = "";
      realtime = false;
      msg(
        op === "signup"
          ? "Revisa tu correo para confirmar el acceso."
          : "Sesión iniciada.",
      );
      await sync();
      pairView();
    });
$("logout").onclick = () =>
  withLoading("logout", async () => {
    await call("logout");
    session = null;
    user = null;
    space = null;
    subscribed = "";
    online = false;
    realtime = false;
    store("session", null);
    rows = read("local", []);
    render();
    pairView();
    msg("Sesión cerrada.");
  });
function toggleDemo() {
  demo = !demo;
  if (demo) makeDemo();
  active = "home";
  render();
  if (!demo) sync();
}
$("demoToggle").onclick = toggleDemo;
$("exitDemo").onclick = toggleDemo;
for (const [id, op] of [
  ["winClose", "close"],
  ["winMin", "min"],
  ["winMax", "max"],
])
  $(id).onclick = () => desktop.window?.(op);
$("titlebar").addEventListener("mousedown", (e) => {
  if (e.button === 0 && !e.target.closest("button")) desktop.window?.("drag");
});
$("titlebar").addEventListener("dblclick", (e) => {
  if (!e.target.closest("button")) desktop.window?.("max");
});
window.addEventListener("online", () => sync());
desktop.on("session", (s) => {
  session = s;
  store("session", s);
  if (!s && user) {
    user = null;
    space = null;
    online = false;
    realtime = false;
    subscribed = "";
    rows = read("local", []);
    render();
  }
});
desktop.on("changed", () => sync());
desktop.on("sync", (s) => {
  realtime = s === "LIVE";
  updateStatus();
  if (realtime) sync();
});
setInterval(() => {
  if (!document.hidden) sync();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) sync();
});
setInterval(() => {
  const upcoming = items()
    .filter(
      (x) =>
        x.kind === "plan" &&
        !x.done &&
        !x.deleted &&
        x.day &&
        new Date(x.day) > new Date(),
    )
    .sort((a, b) => a.day.localeCompare(b.day))[0];
  count(upcoming);
}, 30000);
if (demo) makeDemo();
render();
init().catch(() => {
  online = false;
  updateStatus();
});

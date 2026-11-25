window.createNosotrosPlayer = function (root, { search, loaded }) {
  const get = (name) => root.querySelector('[data-youtube="' + name + '"]');
  const form = get("form"), input = get("query"), player = get("player");
  const submit = get("submit"), status = get("status"), results = get("results");
  const open = get("open"), external = get("external");
  const valid = /^[A-Za-z0-9_-]{11}$/;
  let serial = 0;
  let selected = "";

  function videoId(value) {
    if (valid.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.port || url.username || url.password) return "";
      const [, kind, id] = url.pathname.split("/");
      const candidate = url.hostname === "youtu.be" ? kind :
        ["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)
          ? kind === "watch" ? url.searchParams.get("v") : ["shorts", "live", "embed"].includes(kind) ? id : ""
          : "";
      return valid.test(candidate || "") ? candidate : "";
    } catch {
      return "";
    }
  }

  function load(id) {
    if (!valid.test(id || "")) return;
    selected = id;
    const frame = document.createElement("iframe");
    frame.src = "https://www.youtube-nocookie.com/embed/" + id;
    frame.title = "Reproductor de YouTube";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow = "encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    player.replaceChildren(frame);
    open.hidden = false;
    status.textContent = "";
    loaded(id);
  }

  function reset(query = "", id = "") {
    ++serial;
    submit.disabled = false;
    input.value = query.slice(0, 120);
    results.replaceChildren();
    player.replaceChildren();
    status.textContent = "";
    open.hidden = external.hidden = true;
    selected = "";
    loaded("");
    load(id);
  }

  function decode(value) {
    return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'" })[entity],
    );
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query || submit.disabled) return;
    const id = videoId(query);
    results.replaceChildren();
    external.hidden = true;
    if (id) return load(id);
    if (/^https?:\/\//i.test(query)) {
      status.textContent = "Pega un enlace válido de YouTube.";
      return;
    }
    if (query.length < 2 || query.length > 120) {
      status.textContent = "Escribe entre 2 y 120 caracteres para buscar.";
      return;
    }
    external.onclick = () => desktop.openMedia("https://www.youtube.com/results?search_query=" + encodeURIComponent(query));
    const request = ++serial;
    submit.disabled = true;
    status.textContent = "Buscando en YouTube…";
    try {
      const response = await search(query);
      if (request !== serial) return;
      for (const video of response.data?.videos || []) {
        if (!valid.test(video.id || "") || typeof video.title !== "string") continue;
        const result = document.createElement("button");
        result.type = "button";
        result.textContent = decode(video.title) + (video.channel ? " · " + decode(video.channel) : "");
        result.onclick = () => load(video.id);
        results.append(result);
      }
      external.hidden = Boolean(results.children.length);
      status.textContent = results.children.length ? "Elige un resultado." : "No encontramos videos para esa búsqueda.";
    } catch (error) {
      if (request !== serial) return;
      const messages = {
        not_configured: "La búsqueda dentro de la app todavía está por activar.",
        pair_required: "Vincula a tu pareja para buscar aquí, o busca en YouTube.",
        session_required: "La sesión del espacio venció. Vuelve a abrir la app.",
        slow_down: "Espera unos segundos antes de volver a buscar.",
        daily_limit: "Se alcanzó el límite diario de búsquedas.",
      };
      external.hidden = false;
      status.textContent = messages[error.code] || "YouTube no respondió. Puedes buscar en su sitio.";
    } finally {
      if (request === serial) submit.disabled = false;
    }
  };
  open.onclick = () => desktop.openMedia("https://www.youtube.com/watch?v=" + selected);
  return { load, reset, status };
};

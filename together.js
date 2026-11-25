/* Shared reading, listening and watch room. Embedded playback stays with each provider. */
window.createTogether = function ({ call }) {
  const $ = (id) => document.getElementById(id);
  const work = /^\/works\/OL[0-9]{1,16}W$/;
  const movie = /^[0-9]{5,16}$/;
  const video = /^[A-Za-z0-9_-]{11}$/;
  let visible = false;
  let space = "";
  let paired = false;
  let room = {};
  let books = [];
  let clockOffset = 0;
  let lastSnapshot = 0;
  let refreshing = null;
  let refreshAgain = false;
  let selectedVideo = "";
  let documentPdf = null;
  let reading = null;
  let loadingBook = null;
  let loadSerial = 0;
  let renderSerial = 0;
  let painting = null;
  let page = 1;
  let following = false;
  let leading = false;
  let pageToShare = null;
  let publishing = false;
  let pdfModule;

  function button(name, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = name;
    el.onclick = action;
    return el;
  }

  function link(url) {
    desktop.openMedia(url);
  }

  function status(id, text) {
    $(id).textContent = text;
  }

  async function run(control, statusId, task) {
    if (control.disabled) return;
    control.disabled = true;
    try {
      await task();
    } catch (error) {
      status(
        statusId,
        error.message || "No se pudo completar. Inténtalo de nuevo.",
      );
    } finally {
      control.disabled = false;
      redrawRoom();
    }
  }

  function setContext(open, approvedSpace, hasPartner) {
    const changedSpace = space !== approvedSpace;
    const opening = open && !visible;
    visible = open;
    paired = hasPartner;
    if (changedSpace) {
      space = approvedSpace;
      musicPlayer.reset();
      room = {};
      books = [];
      lastSnapshot = 0;
      following = leading = false;
      pageToShare = null;
      if (reading?.id || loadingBook) closePdf();
      drawBooks();
      redrawRoom();
      status(
        "mediaConnection",
        space
          ? "Espacio compartido"
          : "Vincula a tu pareja para compartir desde ambos equipos.",
      );
    }
    if (!space && !$("mediaConnection").textContent)
      status(
        "mediaConnection",
        "Vincula a tu pareja para compartir desde ambos equipos.",
      );
    if ((changedSpace || opening) && visible) refresh();
  }

  function applyState(data, requestedSpace, started) {
    if (!data || requestedSpace !== space) return;
    const serverTime = Date.parse(data.server_now);
    if (!Number.isFinite(serverTime) || serverTime < lastSnapshot) return;
    lastSnapshot = serverTime;
    clockOffset = serverTime - (started + Date.now()) / 2;
    room = data.room || {};
    const nextBooks = data.books || [];
    if (JSON.stringify(nextBooks) !== JSON.stringify(books)) {
      books = nextBooks;
      drawBooks();
    }
    redrawRoom();
    if (following && visible) followRoom();
  }

  function refresh() {
    if (!visible || !space) return;
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    const requested = space;
    const started = Date.now();
    refreshing = call("together-state", { space: requested })
      .then(({ data }) => {
        if (requested !== space) return;
        applyState(data, requested, started);
        status("mediaConnection", "Espacio compartido");
      })
      .catch(() => {
        if (requested === space)
          status(
            "mediaConnection",
            "La sala compartida no respondió. Volveremos a comprobar la conexión.",
          );
      })
      .finally(() => {
        refreshing = null;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      });
    return refreshing;
  }

  async function action(name, value = null, targetPage = null) {
    const requested = space;
    if (!requested) throw Error("Vincula a tu pareja para compartir.");
    const started = Date.now();
    const { data } = await call("together-action", {
      space: requested,
      action: name,
      value,
      page: targetPage,
    });
    applyState(data, requested, started);
  }

  function drawBooks() {
    const list = $("sharedBooks");
    list.replaceChildren();
    for (const book of books) {
      if (book.catalog_key && !work.test(book.catalog_key)) continue;
      list.append(
        button(book.title, () => {
          if (book.catalog_key)
            link("https://openlibrary.org" + book.catalog_key);
          else {
            following = leading = false;
            pageToShare = null;
            openShared(book, 1);
          }
        }),
      );
    }
  }

  function redrawRoom() {
    $("readFollow").disabled = !space || !room.book_id;
    $("readFollow").setAttribute("aria-pressed", String(following));
    $("readFollow").textContent = following
      ? "Dejar de seguir"
      : "Seguir a mi pareja";
    $("readShare").disabled = !space || !reading?.id || following;
    $("readShare").setAttribute("aria-pressed", String(leading));
    $("readShare").textContent = leading
      ? "Dejar de compartir"
      : "Compartir mi página";
    $("musicShare").disabled = !space || !selectedVideo;
    $("musicPartner").hidden = !video.test(room.youtube_id || "");
    $("partyShare").disabled = !space;
    $("partyStart").disabled = !space || !movie.test(room.netflix_id || "");
    $("partyOpen").textContent = movie.test(room.netflix_id || "")
      ? "Abrir el título compartido"
      : "Abrir Netflix";
    tick();
  }

  function closePdf() {
    ++loadSerial;
    ++renderSerial;
    painting?.cancel();
    if (documentPdf) documentPdf.destroy().catch(() => {});
    documentPdf = reading = loadingBook = null;
    $("pdfPage").hidden = $("readControls").hidden = true;
    // Release a previous partner's pixels on sign-out or space change.
    $("readCanvas").width = 1;
    status("readTitle", "Lector PDF");
    status("readStatus", "Abre un PDF para empezar.");
  }

  async function openPdf(book, bytes, targetPage, request) {
    pdfModule ||= import("./pdfjs/build/pdf.mjs").then((pdf) => {
      pdf.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs/build/pdf.worker.mjs",
        location.href,
      ).href;
      return pdf;
    });
    const pdf = await pdfModule;
    if (request !== loadSerial) return false;
    const assets = new URL("pdfjs/", location.href);
    const next = await pdf.getDocument({
      data: bytes,
      cMapUrl: new URL("cmaps/", assets).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("standard_fonts/", assets).href,
      wasmUrl: new URL("wasm/", assets).href,
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
    if (request !== loadSerial) {
      await next.destroy();
      return false;
    }
    documentPdf = next;
    reading = book;
    status("readTitle", book.title);
    $("readControls").hidden = $("pdfPage").hidden = false;
    await renderPage(targetPage);
    redrawRoom();
    return true;
  }

  async function renderPage(target) {
    if (!documentPdf) return;
    const request = ++renderSerial;
    painting?.cancel();
    page = Math.min(documentPdf.numPages, Math.max(1, target));
    status("readPage", "Página " + page + " de " + documentPdf.numPages);
    $("readPrev").disabled = following || page === 1;
    $("readNext").disabled = following || page === documentPdf.numPages;
    if (leading && reading?.id) queuePage(reading.id, page);
    try {
      const pdfPage = await documentPdf.getPage(page);
      if (request !== renderSerial) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(
        1.6,
        Math.max(0.4, 950 / Math.max(base.width, base.height)),
      );
      const viewport = pdfPage.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.id = "readCanvas";
      canvas.setAttribute("aria-label", $("readPage").textContent + " del PDF");
      painting = pdfPage.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      });
      await painting.promise;
      if (request === renderSerial) {
        $("readCanvas").replaceWith(canvas);
        status(
          "readStatus",
          following ? "Siguiendo la lectura compartida." : "PDF abierto.",
        );
      }
    } catch (error) {
      if (
        request === renderSerial &&
        error.name !== "RenderingCancelledException"
      )
        status("readStatus", "No se pudo mostrar esta página.");
    }
  }

  async function openShared(book, targetPage) {
    if (loadingBook === book.id) return;
    closePdf();
    loadingBook = book.id;
    const request = loadSerial;
    status("readStatus", "Abriendo el PDF compartido…");
    try {
      const { data } = await call("together-pdf", { space, id: book.id });
      const opened = await openPdf(book, data, targetPage, request);
      if (opened && following && room.book_id === book.id && room.page !== page)
        renderPage(room.page);
    } catch {
      if (request === loadSerial)
        status("readStatus", "No se pudo abrir el PDF compartido.");
    } finally {
      if (request === loadSerial) loadingBook = null;
    }
  }

  function followRoom() {
    const book = books.find(
      (item) => item.id === room.book_id && !item.catalog_key,
    );
    if (!book || !Number.isInteger(room.page)) return;
    if (reading?.id !== book.id) openShared(book, room.page);
    else if (page !== room.page) renderPage(room.page);
  }

  async function queuePage(id, at) {
    pageToShare = { id, at, space };
    if (publishing) return;
    publishing = true;
    try {
      while (pageToShare && leading) {
        const next = pageToShare;
        pageToShare = null;
        if (next.space === space) await action("reading", next.id, next.at);
      }
    } catch {
      leading = false;
      pageToShare = null;
      status(
        "readStatus",
        "No se pudo compartir la página. Vuelve a activar la lectura compartida.",
      );
      redrawRoom();
    } finally {
      publishing = false;
    }
  }

  $("bookFile").onchange = async () => {
    const input = $("bookFile");
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw Error("Elige un PDF de hasta 20 MB.");
      const bytes = await file.arrayBuffer();
      if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-"))
        throw Error("El archivo seleccionado no parece ser un PDF.");
      following = leading = false;
      pageToShare = null;
      const originalSpace = space;
      closePdf();
      const request = loadSerial;
      const title =
        [...file.name.replace(/\.pdf$/i, "").trim()].slice(0, 160).join("") ||
        "Libro PDF";
      status("readStatus", "Abriendo el PDF…");
      if (!(await openPdf({ title }, bytes.slice(0), 1, request))) return;
      if (!originalSpace || originalSpace !== space) return;
      const id = crypto.randomUUID();
      status("readStatus", "Guardando en la biblioteca privada…");
      await call("together-add", { space, id, title, pdf: bytes });
      if (space === originalSpace && request === loadSerial) {
        reading = { id, title };
        status("readStatus", "PDF disponible para ambos.");
        redrawRoom();
      }
      refresh();
    } catch (error) {
      status(
        "readStatus",
        error.name === "PasswordException"
          ? "Este PDF requiere una contraseña. Elige una copia que puedas abrir en el lector."
          : error.message || "Este PDF no se pudo abrir o guardar.",
      );
    }
  };

  $("readFollow").onclick = () => {
    following = !following;
    leading = false;
    pageToShare = null;
    if (following) followRoom();
    if (documentPdf) renderPage(page);
    redrawRoom();
  };
  $("readShare").onclick = () => {
    leading = !leading;
    if (leading) queuePage(reading.id, page);
    else pageToShare = null;
    redrawRoom();
  };
  $("readPrev").onclick = () => renderPage(page - 1);
  $("readNext").onclick = () => renderPage(page + 1);

  $("bookSearch").onsubmit = (event) => {
    event.preventDefault();
    const results = $("bookResults");
    const query = $("bookQuery").value.trim();
    if (!query) return;
    run(event.submitter, "readStatus", async () => {
      results.textContent = "Buscando en Open Library…";
      try {
        const params = new URLSearchParams({
          q: query + " ebook_access:(public OR borrowable)",
          limit: "8",
          fields: "key,title,author_name,ebook_access",
        });
        const response = await fetch(
          "https://openlibrary.org/search.json?" + params,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) throw Error();
        const { docs } = await response.json();
        results.replaceChildren();
        for (const found of docs || []) {
          if (!work.test(found.key) || !found.title) continue;
          const row = document.createElement("div");
          row.className = "media-result";
          row.append(
            button(found.title, () =>
              link("https://openlibrary.org" + found.key),
            ),
          );
          if (space)
            row.append(
              button("Guardar", () =>
                run(row.lastChild, "readStatus", async () => {
                  await call("together-add", {
                    space,
                    id: crypto.randomUUID(),
                    title: [...found.title].slice(0, 160).join(""),
                    catalogKey: found.key,
                  });
                  status("readStatus", "Enlace guardado en la biblioteca.");
                  refresh();
                }),
              ),
            );
          results.append(row);
        }
        if (!results.children.length)
          results.textContent =
            "No encontramos ediciones digitales para esa búsqueda.";
      } catch {
        results.replaceChildren("El catálogo no respondió. ");
        results.append(
          button("Buscar en Open Library", () =>
            link(
              "https://openlibrary.org/search?q=" + encodeURIComponent(query),
            ),
          ),
        );
      }
    });
  };

  const musicPlayer = window.createNosotrosPlayer($("musicSearch").parentElement, {
    search: (query) => {
      if (!paired) throw Object.assign(Error(), { code: "pair_required" });
      return call("youtube-search", { space, query });
    },
    loaded: (id) => {
      selectedVideo = id;
      redrawRoom();
    },
  });
  $("musicShare").onclick = () =>
    run($("musicShare"), "musicStatus", async () => {
      await action("youtube", selectedVideo);
      status("musicStatus", "Canción compartida con tu pareja.");
      refresh();
    });
  $("musicPartner").onclick = () => {
    if (video.test(room.youtube_id || "")) musicPlayer.load(room.youtube_id);
  };

  function tick() {
    const time = Date.parse(room.starts_at);
    const left = Number.isFinite(time)
      ? Math.ceil((time - Date.now() - clockOffset) / 1000)
      : -30;
    $("partyTimer").hidden = left < -15;
    const text = left > 0 ? "Dale play en " + left + " s" : "Dale play ahora";
    if ($("partyTimer").textContent !== text) status("partyTimer", text);
  }

  $("partyForm").onsubmit = (event) => {
    event.preventDefault();
    run($("partyShare"), "partyStatus", async () => {
      const url = new URL($("partyLink").value);
      const id = /^\/(?:watch|title)\/([0-9]{5,16})\/?$/.exec(
        url.pathname,
      )?.[1];
      if (
        url.protocol !== "https:" ||
        !["netflix.com", "www.netflix.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        !id
      )
        throw Error("Pega un enlace de un título o episodio de Netflix.");
      await action("netflix", id);
      status(
        "partyStatus",
        "Título compartido. Ambos pueden abrirlo desde aquí.",
      );
      refresh();
    });
  };
  $("partyOpen").onclick = () =>
    link(
      movie.test(room.netflix_id || "")
        ? "https://www.netflix.com/watch/" + room.netflix_id
        : "https://www.netflix.com/browse",
    );
  $("partyStart").onclick = () =>
    run($("partyStart"), "partyStatus", async () => {
      await action("countdown");
      status("partyStatus", "Cuenta regresiva compartida.");
      refresh();
    });
  $("partyExtension").onclick = (event) => {
    event.preventDefault();
    link("https://www.teleparty.com/");
  };
  for (const tab of document.querySelectorAll("[data-media-tab]")) {
    tab.onclick = () => {
      for (const other of document.querySelectorAll("[data-media-tab]")) {
        const active = other === tab;
        other.setAttribute("aria-pressed", String(active));
        $("media-" + other.dataset.mediaTab).hidden = !active;
      }
    };
  }
  setInterval(() => {
    if (visible && !$("media-party").hidden) tick();
  }, 200);
  return { setContext, refresh };
};

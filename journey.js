window.createJourney = function ({ $, node, button, items, context, call, sync, flush, save, toast, navigate, editNote }) {
  const photos = new Map();
  const busy = new Set();
  let photoScope = "";
  let scheduling = null;
  let memory = null;
  let working = false;
  let localPhoto = "";

  function paired() {
    const { demo, space } = context();
    return Boolean(demo || (space?.approved && space.members.filter((member) => member.approved).length === 2));
  }

  function find(link, id) {
    return items().find((item) => item[link] === id && !item.deleted);
  }

  async function action(item, operation, details = {}) {
    const { demo, space, user } = context();
    if (demo) {
      if (operation === "accept") {
        save({ ...item, accepted_by: item.author_id === "demo-me" ? "demo-other" : "demo-me" });
      } else if (operation === "schedule") {
        const existing = items().find((plan) => plan.idea_id === item.id);
        save({ ...existing, id: existing?.id || crypto.randomUUID(), kind: "plan",
          title: item.title, detail: item.detail, day: details.day, idea_id: item.id,
          author: item.author, done: false, deleted: false });
      } else if (operation === "memory") {
        const previous = find("plan_id", item.id);
        save({ ...previous, id: previous?.id || crypto.randomUUID(), kind: "nota",
          title: details.title, detail: details.note, day: item.day, plan_id: item.id,
          author: item.author, memory_photo: details.photo, done: false, deleted: false });
      }
      return;
    }
    if (!paired()) throw Error("Vincula a tu pareja para usar este recorrido.");
    await flush(item.id);
    if (context().space?.id !== space.id || context().user !== user)
      throw Error("El espacio cambió. Vuelve a abrir la ficha.");
    const result = await call("journey", { space: space.id, id: item.id, action: operation, details });
    await sync();
    return result.data;
  }

  async function confirm(item, control, operation) {
    if (busy.has(item.id)) return;
    busy.add(item.id);
    control.disabled = true;
    try {
      await action(item, operation, { expected: item.version });
      toast(operation === "propose" ? "Propuesta lista para tu pareja." : "Confirmación guardada.");
    } catch (error) {
      toast(error.message);
      if (error.code === "40001") sync();
    } finally {
      busy.delete(item.id);
      control.disabled = false;
    }
  }

  function idea(item) {
    const menu = node("div", null, "journey-actions");
    const { demo, user } = context();
    const plan = find("idea_id", item.id);
    if (plan) {
      menu.append(button(plan.done ? "Ver plan completado" : "Ver en agenda", () => navigate("plan", plan.id), "text-button"));
    } else if (item.done) {
      return menu;
    } else if (item.accepted_by && paired()) {
      menu.append(node("small", "Los dos se apuntaron"),
        button("Poner fecha", () => openSchedule(item), "text-button"));
    } else if (paired()) {
      if (!item.author_id) {
        menu.append(button("Proponer a mi pareja", (event) => confirm(item, event.currentTarget, "propose"), "text-button"));
      } else if (item.author_id !== (demo ? "demo-me" : user) || demo) {
        menu.append(button(item.author_id === "demo-me" ? "Simular confirmación" : "Me apunto",
          (event) => confirm(item, event.currentTarget, "accept"), "text-button"));
      } else {
        menu.append(node("small", "Pendiente de tu pareja"));
      }
    }
    return menu;
  }

  function plan(item) {
    const record = find("plan_id", item.id);
    if (record) return button("Ver recuerdo", () => navigate("memoria", record.id), "text-button journey-cta");
    if (!item.done || !paired()) return null;
    return button("Guardar recuerdo", () => openMemory(item), "text-button journey-cta");
  }

  function highlights(ideas, notes, upcoming) {
    const el = $("journeyHighlights");
    el.replaceChildren();
    const { demo, user, space } = context();
    const partner = demo ? "demo-other" : space?.members.find((member) => member.id !== user && member.approved)?.id;
    const pending = partner && ideas.find((item) => item.author_id === partner && !item.done && !item.accepted_by && !find("idea_id", item.id));
    const last = partner && notes.find((item) => item.author_id === partner);
    function add(label, item, open) {
      if (!item) return;
      const row = node("div", null, "journey-highlight");
      row.append(node("small", label), button(item.title, open, "text-button"));
      el.append(row);
    }
    add("Siguiente plan", upcoming, () => navigate("plan", upcoming.id));
    add("Una propuesta por responder", pending, () => navigate("idea", pending.id));
    add("Última nota de tu pareja", last, () => editNote(last));
    $("journeyOverview").hidden = !el.children.length;
  }

  function openSchedule(item) {
    scheduling = item;
    $("scheduleForm").reset();
    $("scheduleError").textContent = "";
    $("scheduleIdea").textContent = item.title;
    $("scheduleDay").value = item.day || "";
    $("scheduleDialog").showModal();
    $("scheduleDay").focus();
  }

  $("scheduleForm").onsubmit = async (event) => {
    event.preventDefault();
    if (working || !scheduling) return;
    working = true;
    $("scheduleSave").disabled = true;
    $("scheduleDay").disabled = true;
    $("scheduleDialog").querySelector("[data-close]").disabled = true;
    $("scheduleError").textContent = "";
    try {
      const item = scheduling;
      const result = await action(item, "schedule", { day: $("scheduleDay").value });
      const created = result || find("idea_id", item.id);
      $("scheduleDialog").close();
      navigate("plan", created?.id);
      toast("Plan añadido a la agenda.");
    } catch (error) {
      $("scheduleError").textContent = error.message;
    } finally {
      working = false;
      $("scheduleSave").disabled = false;
      $("scheduleDay").disabled = false;
      $("scheduleDialog").querySelector("[data-close]").disabled = false;
    }
  };

  function clearPhotos() {
    const { demo, space, user } = context();
    const scope = demo ? "example" : String(space?.id) + "/" + String(user);
    if (scope === photoScope) return;
    for (const entry of photos.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    photos.clear();
    photoScope = scope;
  }

  function getPhoto(record) {
    clearPhotos();
    const key = record.memory_photo;
    const { demo, space } = context();
    if (!key) return Promise.resolve("");
    if (photos.has(key)) return photos.get(key).ready;
    if (demo || !space?.approved) return Promise.resolve("");
    const entry = {};
    entry.ready = call("memory-download", { space: space.id, plan: record.plan_id, photo: key }).then(({ data }) => {
      if (photos.get(key) !== entry) return "";
      entry.url = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
      return entry.url;
    }).catch(() => {
      if (photos.get(key) === entry) photos.delete(key);
      return "";
    });
    photos.set(key, entry);
    return entry.ready;
  }

  function showPhoto(image, record) {
    const photo = record?.memory_photo;
    image.dataset.photo = photo || "";
    image.hidden = true;
    image.removeAttribute("src");
    if (!photo) return;
    getPhoto(record).then((url) => {
      if (!url || image.dataset.photo !== photo || !image.isConnected) return;
      image.src = url;
      image.hidden = false;
    });
  }

  function gallery(element, records) {
    element.replaceChildren();
    if (!records.length) {
      const empty = node("div", null, "empty");
      empty.append(node("p", "Al completar un plan puedes guardar aquí una nota o una foto."),
        button("Ir a la agenda", () => navigate("plan"), "text-button"));
      element.append(empty);
      return;
    }
    for (const record of records) {
      const article = node("article", null, "memory-card");
      article.id = "journey-" + record.id;
      article.tabIndex = -1;
      const picture = node("img");
      picture.alt = "Foto de " + record.title;
      picture.loading = "lazy";
      article.append(picture);
      const content = node("div", null, "memory-card-content");
      if (record.day) {
        const date = new Date(record.day);
        if (Number.isFinite(date.getTime())) content.append(node("small", date.toLocaleDateString("es-CO", { dateStyle: "long" }), "muted"));
      }
      content.append(node("h2", record.title));
      if (record.detail) content.append(node("p", record.detail));
      const source = items().find(({ id, deleted }) => id === record.plan_id && !deleted);
      if (source?.done && paired())
        content.append(button("Editar recuerdo", () => openMemory(source), "text-button"));
      article.append(content);
      element.append(article);
      showPhoto(picture, record);
    }
  }

  function openMemory(source) {
    const record = find("plan_id", source.id);
    const { demo, space } = context();
    memory = { source, record, demo, space: space?.id, uploaded: null };
    $("memoryForm").reset();
    $("memoryDialogTitle").textContent = record ? "Editar recuerdo" : "Guardar recuerdo";
    $("memoryTitle").value = record?.title || source.title;
    $("memoryNote").value = record?.detail || "";
    $("memoryError").textContent = "";
    $("memoryRemovePhoto").hidden = !record?.memory_photo;
    showPhoto($("memoryPreview"), record);
    $("memoryDialog").showModal();
    $("memoryNote").focus();
  }

  function clearLocalPhoto() {
    if (localPhoto) URL.revokeObjectURL(localPhoto);
    localPhoto = "";
  }

  $("memoryPhoto").onchange = () => {
    if (!memory) return;
    const file = $("memoryPhoto").files[0];
    const preview = $("memoryPreview");
    clearLocalPhoto();
    memory.uploaded = null;
    $("memoryError").textContent = "";
    if (!file) {
      showPhoto(preview, memory.record);
      return;
    }
    memory.removePhoto = false;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 12000000) {
      $("memoryPhoto").value = "";
      $("memoryError").textContent = "Elige una foto JPG, PNG o WebP de hasta 12 MB.";
      showPhoto(preview, memory.record);
      return;
    }
    localPhoto = URL.createObjectURL(file);
    preview.dataset.photo = "";
    preview.src = localPhoto;
    preview.hidden = false;
    $("memoryRemovePhoto").hidden = false;
  };

  $("memoryRemovePhoto").onclick = () => {
    memory.removePhoto = true;
    memory.uploaded = null;
    $("memoryPhoto").value = "";
    clearLocalPhoto();
    showPhoto($("memoryPreview"), null);
    $("memoryPreview").dataset.photo = "";
    $("memoryRemovePhoto").hidden = true;
  };

  async function jpeg(file) {
    const image = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const canvas = node("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const drawing = canvas.getContext("2d");
    try {
      drawing.fillStyle = "#ffffff";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally {
      image.close();
    }
    const result = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!result || result.size > 2097152) throw Error("No pudimos preparar la foto. Prueba con una imagen más pequeña.");
    return result;
  }

  $("memoryForm").onsubmit = async (event) => {
    event.preventDefault();
    if (working || !memory) return;
    const draft = memory;
    const note = $("memoryNote").value.trim();
    const title = $("memoryTitle").value.trim();
    const file = $("memoryPhoto").files[0];
    let photo = draft.removePhoto ? null : draft.record?.memory_photo || null;
    if (!title || (!note && !file && !photo)) {
      $("memoryError").textContent = "Agrega un título y una nota o una foto.";
      return;
    }
    working = true;
    const fields = $("memoryForm").querySelectorAll("input, textarea, button");
    fields.forEach((field) => field.disabled = true);
    $("memoryError").textContent = "";
    try {
      if (file) {
        await flush(draft.source.id);
        if (context().demo !== draft.demo || context().space?.id !== draft.space)
          throw Error("El espacio cambió. Vuelve a abrir la ficha.");
        draft.uploaded ??= { id: crypto.randomUUID(), blob: await jpeg(file) };
        photo = draft.uploaded.id;
        if (draft.demo) {
          const url = URL.createObjectURL(draft.uploaded.blob);
          photos.set(photo, { url, ready: Promise.resolve(url) });
        } else {
          await call("memory-upload", { space: draft.space, plan: draft.source.id, photo,
            bytes: await draft.uploaded.blob.arrayBuffer() });
        }
      }
      const result = await action(draft.source, "memory", { title, note, photo, expected: draft.record?.version });
      $("memoryDialog").close();
      navigate("memoria", result?.id || find("plan_id", draft.source.id)?.id);
      toast("Recuerdo guardado.");
    } catch (error) {
      $("memoryError").textContent = error.message;
    } finally {
      working = false;
      fields.forEach((field) => field.disabled = false);
    }
  };

  for (const id of ["scheduleDialog", "memoryDialog"]) {
    $(id).addEventListener("cancel", (event) => {
      if (working) event.preventDefault();
    });
  }
  $("memoryDialog").addEventListener("close", () => {
    clearLocalPhoto();
    memory = null;
    showPhoto($("memoryPreview"), null);
    $("memoryPreview").dataset.photo = "";
    $("memoryPhoto").value = "";
  });

  return { idea, plan, highlights, gallery, clearPhotos };
};

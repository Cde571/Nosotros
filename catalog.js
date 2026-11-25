(() => {
  const imdb = /^tt\d{7,12}$/;
  const municipality = /^\d{1,8}$/;
  const api = "https://api-colombia.com/api/v1/";
  const mediaHosts = ["upload.wikimedia.org", "thumb.wikimedia.org"];
  let towns;

  const normalize = (value) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const poster = (id) =>
    imdb.test(id || "") ? "https://images.metahub.space/poster/small/" + id + "/img" : "";

  function wikiImage(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
          mediaHosts.includes(url.hostname) && url.pathname.startsWith("/wikipedia/commons/"))
        return url.origin + url.pathname;
    } catch {}
    return "";
  }

  async function json(url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (response.ok) return await response.json();
    } catch {}
    throw Error("El catálogo no respondió. Inténtalo de nuevo.");
  }

  async function films(query) {
    const answers = await Promise.allSettled(["movie", "series"].map((type) =>
      json("https://v3-cinemeta.strem.io/catalog/" + type + "/top/search=" + encodeURIComponent(query) + ".json"),
    ));
    if (answers.every((result) => result.status === "rejected")) throw answers[0].reason;
    const results = answers.flatMap((result) => result.value?.metas?.slice(0, 8) || []);
    const matches = new Map();
    for (const item of results) {
      if (!imdb.test(item.id || "") || typeof item.name !== "string" || !item.name.trim()) continue;
      matches.set(item.id, {
        title: item.name.slice(0, 160), id: item.id,
        subtitle: [String(item.releaseInfo || "").slice(0, 16), item.type === "series" ? "Serie" : "Película"].filter(Boolean).join(" · "),
      });
    }
    return [...matches.values()].sort((a, b) =>
      Number(normalize(b.title) === normalize(query)) - Number(normalize(a.title) === normalize(query)),
    ).slice(0, 8);
  }

  function loadTowns() {
    towns ??= Promise.all([json(api + "City"), json(api + "Department")]).then(([cities, departments]) => {
      const names = new Map(departments.map(({ id, name }) => [id, name]));
      const entries = cities.filter(({ id, name }) => municipality.test(id) && typeof name === "string");
      const appearances = new Map();
      for (const { name } of entries) {
        const key = normalize(name);
        appearances.set(key, (appearances.get(key) || 0) + 1);
      }
      return entries.map(({ id, name, departmentId, population }) => ({
        id: String(id), title: name.slice(0, 160), subtitle: (names.get(departmentId) || "Colombia").slice(0, 120),
        duplicate: appearances.get(normalize(name)) > 1, population: Number(population) || 0,
      }));
    }).catch((error) => { towns = null; throw error; });
    return towns;
  }

  function mediaWiki(host, params) {
    return json("https://" + host + "/w/api.php?" + new URLSearchParams({
      action: "query", format: "json", formatversion: "2", origin: "*", ...params,
    }));
  }

  async function findPhotos(cities) {
    const qualified = (x) => x.title + " (" + x.subtitle + ")";
    const names = [...new Set(cities.flatMap((x) => x.duplicate ? [qualified(x)] : [qualified(x), x.title]))];
    const result = await mediaWiki("es.wikipedia.org", {
      titles: names.join("|"), redirects: "1", prop: "pageimages|pageprops",
      ppprop: "disambiguation", pithumbsize: "480", pilicense: "free",
    });
    const pages = new Map((result.query?.pages || []).map((page) => [normalize(page.title), page]));
    for (const { from, to } of result.query?.redirects || []) {
      if (pages.has(normalize(to))) pages.set(normalize(from), pages.get(normalize(to)));
    }
    const matches = cities.map((city) => {
      const candidates = city.duplicate ? [qualified(city)] : [qualified(city), city.title];
      const page = candidates.map((name) => pages.get(normalize(name))).find((entry) =>
        entry && !Object.hasOwn(entry.pageprops || {}, "disambiguation") && wikiImage(entry.thumbnail?.source) && entry.pageimage,
      );
      return page ? { ...city, image: wikiImage(page.thumbnail.source), file: page.pageimage.slice(0, 240) } : city;
    });
    const files = matches.filter((entry) => entry.file).map((entry) => "File:" + entry.file);
    if (!files.length) return matches;
    const info = await mediaWiki("commons.wikimedia.org", {
      titles: files.join("|"), prop: "imageinfo", iiprop: "extmetadata",
      iiextmetadatafilter: "Artist|LicenseShortName",
    }).catch(() => null);
    const plain = (value) => (value || "").replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&").replace(/&(?:nbsp|#160);/g, " ").replace(/\s+/g, " ").trim();
    const credits = new Map((info?.query?.pages || []).map((page) => {
      const meta = page.imageinfo?.[0]?.extmetadata;
      return [normalize(page.title.replaceAll(" ", "_")),
        [plain(meta?.Artist?.value), plain(meta?.LicenseShortName?.value)].filter(Boolean).join(" · ").slice(0, 180)];
    }));
    return matches.map((entry) => entry.file
      ? { ...entry, credit: credits.get(normalize("File:" + entry.file.replaceAll(" ", "_"))) || "" }
      : entry);
  }

  async function destinations(query) {
    const term = normalize(query);
    const cities = (await loadTowns()).filter((x) => normalize(x.title).includes(term) ||
      normalize(x.title + " " + x.subtitle).startsWith(term));
    cities.sort((a, b) => {
      const rank = ({ title }) => normalize(title) === term ? 0 : normalize(title).startsWith(term) ? 1 : 2;
      return rank(a) - rank(b) || b.population - a.population || a.title.localeCompare(b.title, "es");
    });
    const matches = cities.slice(0, 6);
    if (!matches.length) return matches;
    return findPhotos(matches).catch(() => matches);
  }

  function imageFor(kind, data) {
    return kind === "recuerdo" ? poster(data?.id) : kind === "viaje" ? wikiImage(data?.image) : "";
  }

  function sourceFor(kind, data) {
    if (kind === "recuerdo" && imdb.test(data?.id || "")) return "https://www.imdb.com/title/" + data.id + "/";
    if (kind === "viaje" && data?.file && wikiImage(data.image)) return "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(data.file);
    return "";
  }

  window.NosotrosCatalog = { films, destinations, imageFor, sourceFor };
})();

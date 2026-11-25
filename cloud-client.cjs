// Shared by WebView2, local preview and Electron.
function createCloud(createClient, emit) {
  let client, channel, listener, session;
  const credentials = (value) =>
    value
      ? { access_token: value.access_token, refresh_token: value.refresh_token }
      : null;
  return async function cloud(op, p = {}) {
    try {
      if (op === "init") {
        if (channel && client) await client.removeChannel(channel);
        listener?.unsubscribe();
        client?.auth.stopAutoRefresh();
        channel = null;
        session = null;
        client = createClient(p.url, p.key, {
          auth: {
            persistSession: false,
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
        });
        listener = client.auth.onAuthStateChange((_event, value) => {
          session = value;
          emit("session", credentials(value));
        }).data.subscription;
        if (p.session) {
          const result = await client.auth.setSession(p.session);
          if (result.error) throw result.error;
          session = result.data.session;
        }
        return { ok: true, user: session?.user?.id || null };
      }
      if (!client)
        throw Error(
          "El servicio todavía no está configurado. Puedes usar la app en este equipo.",
        );
      let result;
      if (op === "anonymous") result = await client.auth.signInAnonymously();
      else if (op === "signup")
        result = session?.user?.is_anonymous
          ? await client.auth.updateUser({
              email: p.email,
              password: p.password,
            })
          : await client.auth.signUp({ email: p.email, password: p.password });
      else if (op === "login")
        result = await client.auth.signInWithPassword({
          email: p.email,
          password: p.password,
        });
      else if (op === "logout") {
        if (channel) await client.removeChannel(channel);
        channel = null;
        result = await client.auth.signOut();
      } else if (op === "status") result = await client.rpc("my_space");
      else if (op === "create")
        result = await client.rpc("create_space", { display: p.name });
      else if (op === "invite") result = await client.rpc("make_invite");
      else if (op === "join")
        result = await client.rpc("join_space", {
          invite_code: p.code,
          display: p.name,
        });
      else if (op === "profile")
        result = await client.rpc("update_profile", {
          display: p.name,
          avatar: p.photo,
          feeling: p.mood,
          since: p.anniversary,
        });
      else if (op === "approve")
        result = await client.rpc("approve_member", { member_id: p.id });
      else if (op === "list") {
        const data = [];
        for (let offset = 0; ; offset += 500) {
          result = await client
            .from("items")
            .select("*")
            .eq("space_id", p.space)
            .order("id")
            .range(offset, offset + 499);
          if (result.error) throw result.error;
          data.push(...result.data);
          if (result.data.length < 500) break;
        }
        return { ok: true, data };
      } else if (op === "save")
        result = await client.rpc("save_item", { payload: p.item });
      else if (op === "vote")
        result = await client.rpc("vote_item", { item_id: p.id });
      else if (op === "journey")
        result = await client.rpc("journey_action", {
          target: p.space,
          source: p.id,
          action: p.action,
          details: p.details,
        });
      else if (op === "memory-upload" || op === "memory-download") {
        const bucket = client.storage.from("nosotros-memories");
        const key = p.space + "/" + p.plan + "/" + p.photo + ".jpg";
        if (op === "memory-upload") {
          result = await bucket.upload(key, p.bytes, { contentType: "image/jpeg" });
          // A retry can find the same photo already uploaded after a lost response.
          if (String(result.error?.statusCode) === "409") return { ok: true };
        } else {
          result = await bucket.download(key);
          if (result.error) throw result.error;
          return { ok: true, data: await result.data.arrayBuffer() };
        }
      }
      else if (op === "youtube-search") {
        result = await client.functions.invoke("youtube-search", {
          body: { space: p.space, query: p.query },
          timeout: 20000,
        });
        if (result.error) {
          const context = result.error.context;
          const body = await context?.json?.().catch(() => null);
          return { ok: false, code: body?.code ?? "unavailable", error: "No pudimos buscar en YouTube." };
        }
      } else if (op === "together-state")
        result = await client.rpc("together_state", { target: p.space });
      else if (op === "together-action")
        result = await client.rpc("together_action", {
          target: p.space,
          action: p.action,
          value: p.value ?? null,
          page_number: p.page ?? null,
        });
      else if (op === "together-add") {
        const bucket = client.storage.from("nosotros-books");
        const path = p.space + "/" + p.id + ".pdf";
        if (p.pdf) {
          const upload = await bucket.upload(path, p.pdf, {
            contentType: "application/pdf",
          });
          if (upload.error) throw upload.error;
        }
        result = await client.rpc("together_add_book", {
          target: p.space,
          book: p.id,
          book_title: p.title,
          work_key: p.catalogKey ?? null,
        });
        // Only remove a file after a definite database rejection. A lost response
        // could mean the library entry was already committed.
        if (
          p.pdf &&
          result.error &&
          result.status >= 400 &&
          result.status < 500
        )
          await bucket.remove([path]);
      } else if (op === "together-pdf") {
        result = await client.storage
          .from("nosotros-books")
          .download(p.space + "/" + p.id + ".pdf");
        if (result.error) throw result.error;
        return { ok: true, data: await result.data.arrayBuffer() };
      } else if (op === "sub") {
        if (channel) await client.removeChannel(channel);
        channel = client
          .channel("space:" + p.space)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "items",
              filter: "space_id=eq." + p.space,
            },
            () => emit("changed", {}),
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "pair_updates",
              filter: "space_id=eq." + p.space,
            },
            () => emit("changed", {}),
          )
          .on("system", {}, ({ extension, status }) => {
            // The socket can join before Postgres is ready to deliver changes.
            if (extension === "postgres_changes") {
              emit("sync", status === "ok" ? "LIVE" : "CHANNEL_ERROR");
            }
          })
          .subscribe((status) => {
            if (status !== "SUBSCRIBED") emit("sync", status);
          });
        return { ok: true };
      } else throw Error("Operación inválida");
      if (result.error) throw result.error;
      if (["anonymous", "login", "signup"].includes(op)) {
        session = result.data.session || (op === "signup" ? session : null);
        return {
          ok: true,
          user: session?.user?.id || null,
          session: credentials(session),
        };
      }
      return { ok: true, data: result.data };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
        code: error.code,
      };
    }
  };
}
module.exports = { createCloud };

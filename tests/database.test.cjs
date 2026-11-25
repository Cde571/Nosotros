const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

test("two-person pairing, RLS, profile privacy, votes and offline conflicts", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create schema extensions;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
      create publication supabase_realtime;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (bucket_id text, name text, owner_id text);
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,anon;
      grant select,insert,delete on storage.objects to authenticated;`);
    // No extension is needed for the latest invite implementation.
    await db.exec(
      fs
        .readFileSync("schema.sql", "utf8")
        .replace(/create extension[^;]*;/, ""),
    );
    await db.exec(fs.readFileSync("migration-0.2.sql", "utf8"));
    for (const migration of fs
      .readdirSync("supabase/migrations")
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await db.exec(
        fs.readFileSync(path.join("supabase/migrations", migration), "utf8"),
      );
    }
    const [alice, bob, stranger, fourth] = Array.from(
      { length: 4 },
      randomUUID,
    );
    for (const id of [alice, bob, stranger, fourth])
      await db.query("insert into auth.users values ($1)", [id]);
    const as = async (id) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id || "",
      ]);
      await db.exec("set role " + (id ? "authenticated" : "anon"));
    };
    const rpc = async (sql, args = []) =>
      (await db.query(sql, args)).rows[0]?.value;
    await as(null);
    await assert.rejects(
      () => rpc("select public.create_space('Alice') as value"),
      /permission denied/,
    );
    await as(alice);
    const space = await rpc("select public.create_space('Alice') as value");
    assert.equal(
      await rpc("select public.create_space('Alice') as value"),
      space,
      "creating is idempotent",
    );
    const code = await rpc("select public.make_invite() as value");
    assert.match(code, /^[A-F0-9]{16}$/);
    await as(bob);
    assert.equal(
      await rpc("select public.join_space($1,'Bob') as value", [
        code.toLowerCase(),
      ]),
      space,
    );
    let status = await rpc("select public.my_space() as value");
    assert.equal(status.approved, true);
    assert.equal(status.members.length, 2);
    assert.equal(
      Number(
        await rpc(
          "select revision as value from public.pair_updates where space_id=$1",
          [space],
        ),
      ),
      2,
    );
    await assert.rejects(
      () => rpc("select public.make_invite() as value"),
      /creador/,
    );
    await as(stranger);
    assert.equal(
      (
        await db.query("select * from public.pair_updates where space_id=$1", [
          space,
        ])
      ).rows.length,
      0,
    );
    await assert.rejects(
      () => rpc("select public.join_space($1,'Third') as value", [code]),
      /inválido|completo/,
    );
    const otherSpace = await rpc(
      "select public.create_space('Other') as value",
    );
    assert.notEqual(otherSpace, space);
    const reserve = (target, who) =>
      rpc("select public.take_youtube_search($1,$2) as value", [target, who]);
    await assert.rejects(() => reserve(space, alice), /permission denied/);
    await db.exec("reset role; set role service_role");
    assert.equal(await reserve(space, stranger), "pair_required");
    assert.equal(await reserve(otherSpace, stranger), "pair_required");
    assert.equal(await reserve(space, alice), "allowed");
    assert.equal(await reserve(space, bob), "slow_down");
    await db.exec("reset role");
    await db.query(`update private.youtube_search_requests
      set requested_at = now() - interval '1 day' where space_id = $1`, [space]);
    await db.exec("set role service_role");
    assert.equal(await reserve(space, bob), "allowed");
    await as(stranger);
    const expired = await rpc("select public.make_invite() as value");
    await db.exec("reset role");
    await db.query(
      "update public.invites set expires=now()-interval '1 minute' where code=$1",
      [expired],
    );
    await as(fourth);
    await assert.rejects(
      () => rpc("select public.join_space($1,'Fourth') as value", [expired]),
      /inválido/,
    );
    await as(alice);
    await assert.rejects(
      () => rpc("select public.make_invite() as value"),
      /completo/,
    );
    const photo = "data:image/jpeg;base64,YWJj";
    await rpc(
      "select public.update_profile('Alice',$1,'Pensando en ti','2024-02-01') as value",
      [photo],
    );
    await assert.rejects(
      () =>
        rpc(
          "select public.update_profile('Alice','https://bad/photo','mood','') as value",
        ),
      /Foto inválida/,
    );
    const id = randomUUID(),
      payload = {
        id,
        space_id: space,
        kind: "idea",
        title: "Cena juntos",
        detail: "Cocinar algo rico",
        day: "",
        done: false,
        deleted: false,
        expected_version: 0,
      };
    const saved = await rpc(
      "select to_jsonb(public.save_item($1::jsonb)) as value",
      [JSON.stringify(payload)],
    );
    assert.equal(Number(saved.version), 1);
    assert.equal(saved.author_id, alice);
    assert.equal(saved.author, "Alice");
    const retried = await rpc(
      "select to_jsonb(public.save_item($1::jsonb)) as value",
      [JSON.stringify(payload)],
    );
    assert.equal(
      Number(retried.version),
      1,
      "interrupted responses can retry without a conflict",
    );
    await assert.rejects(
      () =>
        db.query("update public.items set title=$1 where id=$2", [
          "Bypass",
          id,
        ]),
      /permission denied/,
    );
    await as(stranger);
    assert.equal(
      (await db.query("select * from public.items where space_id=$1", [space]))
        .rows.length,
      0,
    );
    assert.equal(
      (await rpc("select public.my_space() as value")).members.some(
        (x) => x.photo === photo,
      ),
      false,
    );
    await assert.rejects(
      () =>
        rpc("select to_jsonb(public.save_item($1::jsonb)) as value", [
          JSON.stringify({ ...payload, title: "Intrusion" }),
        ]),
      /acceso/,
    );
    await assert.rejects(
      () => rpc("select to_jsonb(public.vote_item($1)) as value", [id]),
      /disponible/,
    );
    await as(bob);
    status = await rpc("select public.my_space() as value");
    assert.equal(status.members.find((x) => x.id === alice).photo, photo);
    assert.equal(
      Number(
        await rpc(
          "select revision as value from public.pair_updates where space_id=$1",
          [space],
        ),
      ),
      3,
    );
    const note = {
      ...payload,
      id: randomUUID(),
      kind: "nota",
      title: "Para los dos",
      detail: "Una nota de Bob",
    };
    const sharedNote = await rpc("select public.save_item($1) as value", [
      JSON.stringify(note),
    ]);
    await as(alice);
    assert.equal(
      await rpc("select detail as value from public.items where id=$1", [
        note.id,
      ]),
      note.detail,
    );
    await rpc("select public.save_item($1) as value", [
      JSON.stringify({
        ...note,
        detail: "También de Alice",
        expected_version: sharedNote.version,
      }),
    ]);
    await as(bob);
    assert.equal(
      await rpc("select detail as value from public.items where id=$1", [
        note.id,
      ]),
      "También de Alice",
    );
    const film = {
      ...payload,
      id: randomUUID(),
      kind: "recuerdo",
      title: "Interstellar",
    };
    const media = { id: "tt0816692", name: film.title, youtube: "zSWdZVtXT7E" };
    const saveMedia = (value) =>
      rpc("select public.save_item($1) as value", [JSON.stringify(value)]);
    const savedFilm = await saveMedia({ ...film, media });
    await as(alice);
    assert.deepEqual(
      await rpc("select media as value from public.items where id=$1", [film.id]),
      media,
    );
    const legacy = await saveMedia({ ...film, done: true, expected_version: savedFilm.version });
    assert.deepEqual(legacy.media, media);
    await assert.rejects(
      () => saveMedia({ ...film, media: { youtube: "invalid" }, expected_version: legacy.version }),
      /Ficha multimedia inválida/,
    );
    await assert.rejects(
      () => saveMedia({ ...film, done: true, media: null, expected_version: savedFilm.version }),
      /Tu pareja también editó/,
    );
    const unlinked = await saveMedia({ ...film, done: true, media: null, expected_version: legacy.version });
    assert.equal(unlinked.media, null);
    await as(bob);
    let voted = await rpc("select to_jsonb(public.vote_item($1)) as value", [
      id,
    ]);
    assert.deepEqual(voted.votes, [bob]);
    await as(alice);
    voted = await rpc("select to_jsonb(public.vote_item($1)) as value", [id]);
    assert.equal(voted.votes.length, 2);
    const revised = await rpc(
      "select to_jsonb(public.save_item($1::jsonb)) as value",
      [
        JSON.stringify({
          ...payload,
          title: "Cena y peli",
          expected_version: Number(voted.version),
        }),
      ],
    );
    assert.equal(revised.title, "Cena y peli");
    await as(bob);
    await assert.rejects(
      () =>
        rpc("select to_jsonb(public.save_item($1::jsonb)) as value", [
          JSON.stringify({
            ...payload,
            title: "Edición antigua",
            expected_version: 1,
          }),
        ]),
      (error) => error.code === "40001",
    );
    const deleted = await rpc(
      "select to_jsonb(public.save_item($1::jsonb)) as value",
      [
        JSON.stringify({
          ...payload,
          title: revised.title,
          deleted: true,
          expected_version: Number(revised.version),
        }),
      ],
    );
    assert.equal(deleted.deleted, true);
    await as(alice);
    assert.equal(
      (await db.query("select deleted from public.items where id=$1", [id]))
        .rows[0].deleted,
      true,
    );
    await as(null);
    await assert.rejects(
      () => rpc("select public.my_space() as value"),
      /permission denied/,
    );
    await assert.rejects(
      () => db.query("select * from public.items"),
      /permission denied/,
    );

    await as(alice);
    const proposal = await saveMedia({ ...payload, id: randomUUID(), title: "Paseo al parque" });
    const date = "2026-11-28T16:30";
    const journey = (source, action, details = {}) =>
      rpc("select public.journey_action($1,$2,$3,$4) as value",
        [space, source, action, JSON.stringify(details)]);
    await assert.rejects(() => journey(proposal.id, "accept", { expected: proposal.version }), /tu pareja/i);
    await assert.rejects(() => journey(proposal.id, "schedule", { day: date }), /se apunte/);
    await as(bob);
    const accepted = await journey(proposal.id, "accept", { expected: proposal.version });
    assert.equal(accepted.accepted_by, bob);
    const editedProposal = await saveMedia({ ...proposal, detail: "Llevar el picnic", expected_version: accepted.version });
    assert.equal(editedProposal.accepted_by, null);
    await assert.rejects(() => journey(proposal.id, "accept", { expected: proposal.version }), /propuesta cambió/);
    await journey(proposal.id, "accept", { expected: editedProposal.version });
    const plan = await journey(proposal.id, "schedule", { day: date });
    assert.equal(plan.idea_id, proposal.id);
    assert.equal(plan.day, date);
    assert.equal((await journey(proposal.id, "schedule", { day: "2026-11-29T17:30" })).id, plan.id);
    await assert.rejects(() => journey(plan.id, "memory", { title: "Picnic", note: "Hicimos un picnic" }), /Completa el plan/);
    await saveMedia({ ...plan, done: true, expected_version: plan.version });
    const memoryPhoto = randomUUID();
    const photoPath = space + "/" + plan.id + "/" + memoryPhoto + ".jpg";
    await assert.rejects(() => journey(plan.id, "memory", { title: "Picnic", photo: memoryPhoto }), /foto aún/);
    await db.query("insert into storage.objects values ('nosotros-memories',$1,$2)", [photoPath, bob]);
    const memory = await journey(plan.id, "memory", { title: "Picnic", photo: memoryPhoto });
    assert.equal(memory.plan_id, plan.id);
    assert.equal(memory.memory_photo, memoryPhoto);
    assert.equal((await journey(plan.id, "memory", { title: "Picnic", photo: memoryPhoto })).id, memory.id);
    await as(alice);
    assert.equal(await rpc("select count(*)::int as value from storage.objects where name=$1", [photoPath]), 1);
    const editedMemory = await journey(plan.id, "memory", { title: "Nuestro picnic", note: "Volveremos", photo: memoryPhoto, expected: memory.version });
    await assert.rejects(() => journey(plan.id, "memory", { title: "Otro título", photo: memoryPhoto, expected: memory.version }), /recuerdo cambió/);
    assert.equal(editedMemory.detail, "Volveremos");
    await as(stranger);
    await assert.rejects(() => journey(plan.id, "memory", { title: "Picnic", photo: memoryPhoto }), /Vincula/);
    assert.equal(await rpc("select count(*)::int as value from storage.objects where name=$1", [photoPath]), 0);

    await as(alice);
    const book = randomUUID();
    const objectPath = space + "/" + book + ".pdf";
    await db.query(
      "insert into storage.objects values ('nosotros-books',$1,$2)",
      [objectPath, alice],
    );
    await rpc("select public.together_add_book($1,$2,'Nuestro PDF',null)", [
      space,
      book,
    ]);
    assert.equal(
      (
        await rpc("select public.together_action($1,'reading',$2,3) as value", [
          space,
          book,
        ])
      ).room.page,
      3,
    );
    await as(bob);
    assert.equal(
      (await rpc("select public.together_state($1) as value", [space])).room
        .book_id,
      book,
    );
    assert.equal(
      (
        await db.query("select * from storage.objects where name=$1", [
          objectPath,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "delete from storage.objects where name=$1 returning name",
          [objectPath],
        )
      ).rows.length,
      0,
    );
    await rpc("select public.together_action($1,'netflix','80057281',null)", [
      space,
    ]);
    const countdown = await rpc(
      "select public.together_action($1,'countdown',null,null) as value",
      [space],
    );
    assert.equal(countdown.room.page, 3);
    assert.ok(
      Date.parse(countdown.room.starts_at) > Date.parse(countdown.server_now),
    );
    await rpc(
      "select public.together_action($1,'youtube','M7lc1UVf-VE',null)",
      [space],
    );
    await as(alice);
    assert.equal(
      (await rpc("select public.together_state($1) as value", [space])).room
        .youtube_id,
      "M7lc1UVf-VE",
    );
    await as(stranger);
    assert.equal(
      (
        await db.query("select * from storage.objects where name=$1", [
          objectPath,
        ])
      ).rows.length,
      0,
    );
    await assert.rejects(
      () => rpc("select public.together_state($1) as value", [space]),
      /Espacio no disponible/,
    );
    await assert.rejects(
      () =>
        db.query(
          "insert into storage.objects values ('nosotros-books',$1,$2)",
          [space + "/" + randomUUID() + ".pdf", stranger],
        ),
      /row-level security/,
    );
  } finally {
    await db.close();
  }
});

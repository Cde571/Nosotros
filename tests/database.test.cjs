const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

test("two-person pairing, RLS, profile privacy, votes and offline conflicts", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema extensions;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
      create publication supabase_realtime;`);
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
      Number(await rpc("select revision as value from public.pair_updates where space_id=$1", [space])),
      2,
    );
    await assert.rejects(
      () => rpc("select public.make_invite() as value"),
      /creador/,
    );
    await as(stranger);
    assert.equal(
      (await db.query("select * from public.pair_updates where space_id=$1", [space])).rows.length,
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
      Number(await rpc("select revision as value from public.pair_updates where space_id=$1", [space])),
      3,
    );
    const note = { ...payload, id: randomUUID(), kind: "nota", title: "Para los dos", detail: "Una nota de Bob" };
    const sharedNote = await rpc("select public.save_item($1) as value", [JSON.stringify(note)]);
    await as(alice);
    assert.equal(await rpc("select detail as value from public.items where id=$1", [note.id]), note.detail);
    await rpc("select public.save_item($1) as value", [JSON.stringify({ ...note, detail:"También de Alice", expected_version:sharedNote.version })]);
    await as(bob);
    assert.equal(await rpc("select detail as value from public.items where id=$1", [note.id]), "También de Alice");
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
  } finally {
    await db.close();
  }
});

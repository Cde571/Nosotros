const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCloud } = require("../cloud-client.cjs");

test("restored refreshed credentials are emitted and anonymous accounts keep their identity when protected", async () => {
  let callback,
    subscribedBeforeRestore = false,
    upgraded = false;
  const emitted = [];
  const current = {
    user: { id: "person-a", is_anonymous: true },
    access_token: "new-access",
    refresh_token: "new-refresh",
  };
  const client = {
    auth: {
      stopAutoRefresh() {},
      onAuthStateChange(fn) {
        callback = fn;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async setSession() {
        subscribedBeforeRestore = !!callback;
        callback("TOKEN_REFRESHED", current);
        return { data: { session: current } };
      },
      async updateUser() {
        upgraded = true;
        return { data: { user: current.user } };
      },
    },
  };
  const cloud = createCloud(
    () => client,
    (name, value) => emitted.push({ name, value }),
  );
  const result = await cloud("init", {
    url: "https://example.supabase.co",
    key: "public",
    session: { access_token: "old", refresh_token: "old" },
  });
  assert.equal(result.user, "person-a");
  assert.equal(subscribedBeforeRestore, true);
  assert.deepEqual(emitted[0], {
    name: "session",
    value: { access_token: "new-access", refresh_token: "new-refresh" },
  });
  const protectedAccount = await cloud("signup", {
    email: "test@example.test",
    password: "example-password",
  });
  assert.equal(upgraded, true);
  assert.equal(protectedAccount.user, "person-a");
});

test("reads paginate beyond the default API limit and preserve server errors", async () => {
  let pages = 0;
  const client = {
    auth: {
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    from() {
      const query = {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        async range() {
          pages++;
          return {
            data: Array.from({ length: pages < 3 ? 500 : 12 }, (_, i) => ({
              id: i,
            })),
          };
        },
      };
      return query;
    },
    async rpc() {
      return { error: { message: "Conflicto", code: "40001" } };
    },
  };
  const cloud = createCloud(
    () => client,
    () => {},
  );
  await cloud("init", { url: "url", key: "key" });
  assert.equal((await cloud("list", { space: "pair" })).data.length, 1012);
  assert.equal(pages, 3);
  assert.deepEqual(await cloud("save", { item: {} }), {
    ok: false,
    error: "Conflicto",
    code: "40001",
  });
});

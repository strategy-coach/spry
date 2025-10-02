import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { jsonStringifyReplacers } from "./json-stringify-aide.ts";

Deno.test("jsonStringifyReplacers", async (t) => {
  await t.step(
    "omits fields named 'password' anywhere (AND mode default)",
    () => {
      const data = {
        user: { id: 1, password: "secret", nested: { password: 2 } },
      };
      const replacer = jsonStringifyReplacers([
        (s) => s[s.length - 1] !== "password",
      ]);
      const out = JSON.parse(JSON.stringify(data, replacer));
      assertEquals(out.user.id, 1);
      assertFalse("password" in out.user);
      assertFalse("password" in out.user.nested);
    },
  );

  await t.step("replaces tokens while keeping others", () => {
    const data = { a: 1, token: "abc", nested: { token: "xyz" } };
    const replacer = jsonStringifyReplacers([
      (s) => (s.at(-1) === "token" ? { replaceWith: "****" } : undefined),
    ]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.a, 1);
    assertEquals(out.token, "****");
    assertEquals(out.nested.token, "****");
  });

  await t.step("OR mode keeps if any predicate keeps", () => {
    const data = { keepMe: 1, dropMe: 2 };
    const replacer = jsonStringifyReplacers(
      [
        (s) => s.at(-1) === "keepMe", // keep keepMe
        (s) => (s.at(-1) === "dropMe" ? false : undefined), // omit dropMe
      ],
      { mode: "any" },
    );
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.keepMe, 1);
    assertFalse("dropMe" in out);
  });

  await t.step("zero predicates is a no-op", () => {
    const data = { x: 1, y: { z: 2 } };
    const replacer = jsonStringifyReplacers([]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.x, 1);
    assertEquals(out.y.z, 2);
  });

  await t.step("replacement takes precedence over keep/omit", () => {
    const data = { secret: "s", visible: "v" };
    const replacer = jsonStringifyReplacers(
      [
        () => true, // keep rule
        (
          s,
        ) => (s.at(-1) === "secret"
          ? { replaceWith: "<redacted>" }
          : undefined),
      ],
      { mode: "all" },
    );
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.secret, "<redacted>");
    assertEquals(out.visible, "v");
  });
});

Deno.test("jsonStringifyReplacers with function and jq-like rules", async (t) => {
  await t.step("function rule: omits fields named 'password' anywhere", () => {
    const data = {
      user: { id: 1, password: "secret", nested: { password: 2 } },
    };
    const replacer = jsonStringifyReplacers([
      (s) => s[s.length - 1] !== "password",
    ]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.user.id, 1);
    assertFalse("password" in out.user);
    assertFalse("password" in out.user.nested);
  });

  await t.step("query rule: omit by exact path", () => {
    const data = { user: { ssn: "123-45-6789", profile: { ssn: "x" } } };
    const replacer = jsonStringifyReplacers([
      { query: ".user.ssn", action: "omit" },
    ]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertFalse("ssn" in out.user);
    assertEquals(out.user.profile.ssn, "x"); // only exact path omitted
  });

  await t.step("query rule: wildcard * single segment", () => {
    const data = { users: [{ id: 1, ssn: "a" }, { id: 2, ssn: "b" }] };
    const replacer = jsonStringifyReplacers([
      { query: "users.[].ssn", action: "omit" }, // [] treated as *
    ]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.users[0].id, 1);
    assertEquals(out.users[1].id, 2);
    assertFalse("ssn" in out.users[0]);
    assertFalse("ssn" in out.users[1]);
  });

  await t.step("query rule: deep wildcard ** multi-segment", () => {
    const data = {
      user: { a: { b: { public: true } }, public: false },
      other: { public: 1 },
    };
    const replacer = jsonStringifyReplacers([
      { query: "user.**.public", action: "keep" },
    ], { mode: "any" });
    const out = JSON.parse(JSON.stringify(data, replacer));
    // In OR mode: any keep retains the node; others may still stay unless another rule omits them.
    assert("user" in out);
    assert("public" in out.user);
    assert("public" in out.user.a.b);
    assert("other" in out); // not targeted => remains (no explicit omit)
  });

  await t.step("query rule: replacement wins", () => {
    const data = { token: "abc", nested: { token: "xyz" } };
    const replacer = jsonStringifyReplacers([
      { query: "token", action: "replace", with: () => "****" },
      { query: "**", action: "keep" }, // keep rule should not override replacement
    ]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out.token, "****");
    assertEquals(out.nested.token, "****");
  });

  await t.step("AND mode: any omit drops the value", () => {
    const data = { a: 1, b: 2 };
    const replacer = jsonStringifyReplacers([
      { query: "a", action: "keep" },
      { query: "a", action: "omit" },
    ], { mode: "all" });
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertFalse("a" in out);
    assertEquals(out.b, 2);
  });

  await t.step("zero rules → no-op", () => {
    const data = { x: 1, y: { z: 2 } };
    const replacer = jsonStringifyReplacers([]);
    const out = JSON.parse(JSON.stringify(data, replacer));
    assertEquals(out, data);
  });
});

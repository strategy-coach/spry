// path-tree_test.ts
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { pathTree, pathTreeSerializers } from "./path-tree.ts";

type Node = { path: string; caption: string };

// Async generator for nodes
async function* complexNodes(): AsyncGenerator<Node> {
  // root file
  yield { path: "/index.sql", caption: "App Home" };

  // top-level container (explicit)
  yield { path: "/spry", caption: "spry" };

  // file within top-level container
  yield { path: "/spry/index.sql", caption: "Spry BaaS" };

  // nested container (explicit)
  yield { path: "/spry/console", caption: "console" };

  // leaf files under console
  yield { path: "/spry/console/about.sql", caption: "About Spry Console" };
  yield { path: "/spry/console/index.sql", caption: "Spry Console" };

  // index files for sub-containers (containers NOT explicitly provided → must be synthesized)
  yield {
    path: "/spry/console/info-schema/index.sql",
    caption: "Spry Schema",
  };
  yield {
    path: "/spry/console/sqlpage-files/index.sql",
    caption: "SQLPage Files",
  };
  yield {
    path: "/spry/console/sqlpage-files/content.sql",
    caption: "SQLPage Files Content",
  };
  yield {
    path: "/spry/console/sqlpage-nav/index.sql",
    caption: "Spry Routes",
  };
}

Deno.test("buildPathTree — complex forest", async (t) => {
  const builder = await pathTree<Node, string>(complexNodes(), {
    nodePath: (n) => n.path,
    pathDelim: "/",
    synthesizeContainers: true,
    folderFirst: true,
    indexBasenames: ["index", "index.sql"],
  });

  const tree = builder.roots;

  // Helper to find a node by path in the built forest
  function find(path: string) {
    const want = builder.normalize(path);
    const stack = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.path === want) return n;
      for (const c of n.children) stack.push(c);
    }
    return undefined;
  }

  await t.step("roots and ordering (folders before files)", () => {
    // We expect two roots: /spry (container) and /index.sql (file)
    // Folder-first ordering ensures /spry comes before /index.sql.
    assertEquals(tree.length, 2);
    assertEquals(tree[0].path, "/spry");
    assertEquals(tree[1].path, "/index.sql");
  });

  await t.step("explicit containers vs synthesized containers", () => {
    const spry = find("/spry")!;
    const consoleDir = find("/spry/console")!;
    assert(spry, "expected explicit /spry container");
    assert(consoleDir, "expected explicit /spry/console container");
    assert(!spry.virtual, "explicit container should not be virtual");
    assert(!consoleDir.virtual, "explicit container should not be virtual");

    const infoSchema = find("/spry/console/info-schema")!;
    const sqlpageFiles = find("/spry/console/sqlpage-files")!;
    const sqlpageNav = find("/spry/console/sqlpage-nav")!;
    assert(
      infoSchema?.virtual,
      "info-schema should be synthesized as virtual",
    );
    assert(
      sqlpageFiles?.virtual,
      "sqlpage-files should be synthesized as virtual",
    );
    assert(
      sqlpageNav?.virtual,
      "sqlpage-nav should be synthesized as virtual",
    );
  });

  await t.step("parent/child relationships", () => {
    // container -> index file under it
    assert(find("/spry/index.sql"), "Spry BaaS should exist");
    assertEquals(find("/spry/index.sql")!.path, "/spry/index.sql");
    assertEquals(find("/spry/index.sql")!.children.length, 0);

    // info-schema dir contains its index
    const infoSchema = find("/spry/console/info-schema")!;
    assert(
      find("/spry/console/info-schema/index.sql"),
      "child index should exist",
    );
    assert(
      infoSchema.children.some((c) =>
        c.path === "/spry/console/info-schema/index.sql"
      ),
      "info-schema should contain its index",
    );

    // sqlpage-files dir contains index and content.sql
    const filesDir = find("/spry/console/sqlpage-files")!;
    assert(
      filesDir.children.some((c) =>
        c.path === "/spry/console/sqlpage-files/index.sql"
      ),
      "sqlpage-files should contain its index",
    );
    assert(
      filesDir.children.some((c) =>
        c.path === "/spry/console/sqlpage-files/content.sql"
      ),
      "sqlpage-files should contain content.sql",
    );

    // console dir contains about.sql, its own index, and the three synthesized subfolders
    const consoleDir = find("/spry/console")!;
    const childPaths = consoleDir.children.map((c) => c.path).sort();
    for (
      const needed of [
        "/spry/console/about.sql",
        "/spry/console/index.sql",
        "/spry/console/info-schema",
        "/spry/console/sqlpage-files",
        "/spry/console/sqlpage-nav",
      ]
    ) {
      assert(
        childPaths.includes(needed),
        `console should contain ${needed}`,
      );
    }
  });

  await t.step(
    "helper functions: normalize, dirname, basename, isContainerPath, isIndexFile",
    () => {
      assertEquals(
        builder.normalize(" //spry//console// "),
        "/spry/console",
      );
      assertEquals(
        builder.dirname("/spry/console/about.sql"),
        "/spry/console",
      );
      assertEquals(
        builder.basename("/spry/console/about.sql"),
        "about.sql",
      );
      assert(
        builder.isContainerPath("/spry/console"),
        "console is a container",
      );
      assert(
        !builder.isContainerPath("/spry/console/about.sql"),
        "about.sql is not a container",
      );
      assert(
        builder.isIndexFile("/spry/console/index.sql"),
        "index.sql is an index file",
      );
      assert(
        !builder.isIndexFile("/spry/console/about.sql"),
        "about.sql is not an index file",
      );
    },
  );

  await t.step(
    "pretty-printed tree (selected lines present, order sanity)",
    () => {
      const serializers = pathTreeSerializers(builder);
      const printed = serializers.asciiTreeText({ showPath: true });

      // Top-level roots: container then file
      const firstLine = printed.split("\n")[0];
      assertMatch(firstLine, /spry\s+\[\/spry\]$/);

      // Ensure some key lines are present
      const includes = [
        "├── spry [/spry]",
        "│   ├── console [/spry/console]",
        "│   │   ├── info-schema [/spry/console/info-schema]",
        "│   │   │   └── index.sql [/spry/console/info-schema/index.sql]",
        "│   │   ├── sqlpage-files [/spry/console/sqlpage-files]",
        "│   │   │   ├── content.sql [/spry/console/sqlpage-files/content.sql]",
        "│   │   │   └── index.sql [/spry/console/sqlpage-files/index.sql]",
        "│   │   ├── sqlpage-nav [/spry/console/sqlpage-nav]",
        "│   │   │   └── index.sql [/spry/console/sqlpage-nav/index.sql]",
        "│   │   ├── about.sql [/spry/console/about.sql]",
        "│   │   └── index.sql [/spry/console/index.sql]",
        "│   └── index.sql [/spry/index.sql]",
        "└── index.sql [/index.sql]",
      ];
      for (const line of includes) {
        assertStringIncludes(printed, line);
      }
    },
  );

  await t.step(
    "synthesizeContainers=false promotes orphans to roots",
    async () => {
      // Re-run with synthesis disabled and only provide deep files
      async function* onlyDeep(): AsyncGenerator<Node> {
        yield { path: "/a/b/c/index.sql", caption: "deep index" };
        yield { path: "/a/b/c/file.sql", caption: "deep file" };
      }
      const b2 = await pathTree<Node, string>(onlyDeep(), {
        nodePath: (n) => n.path,
        pathDelim: "/",
        synthesizeContainers: false,
        folderFirst: true,
        indexBasenames: ["index.sql"],
      });
      const forest2 = b2.roots;
      // Without synthesized containers, both deep paths become roots
      const paths = forest2.map((n) => n.path).sort();
      assertEquals(paths, ["/a/b/c/file.sql", "/a/b/c/index.sql"].sort());
    },
  );
});

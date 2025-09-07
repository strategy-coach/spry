import * as spn from "../notebook/sqlpage.ts";
import { literal } from "../../universal/sql-text.ts";

export class ShellSqlPages extends spn.TypicalSqlPageNotebook {
  private title: string;
  private logoImage: string;
  private favIcon: string;

  constructor(
    title: string = "Spry Web UI",
    logoImage: string = "surveilr-icon.png",
    favIcon: string = "favicon.ico",
  ) {
    super();
    this.title = title;
    this.logoImage = logoImage;
    this.favIcon = favIcon;
  }

  defaultShell() {
    return {
      component: "shell",
      title: this.title,
      icon: "",
      favicon: `https://www.surveilr.com/assets/brand/${this.favIcon}`,
      image: `https://www.surveilr.com/assets/brand/${this.logoImage}`,
      layout: "fluid",
      fixed_top_menu: true,
      link: "index.sql",
      menu_item: [
        { link: "index.sql", title: "Home" },
      ],
      javascript: [
        "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js",
        "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/sql.min.js",
        "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/handlebars.min.js",
        "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/languages/json.min.js",
      ],
      footer: `Resource Surveillance Web UI`,
    };
  }

  @spn.shell({ eliminate: true })
  "shell/shell.json"() {
    return JSON.stringify(this.defaultShell(), undefined, "  ");
  }

  @spn.shell({ eliminate: true })
  "shell/shell.sql"() {
    const selectNavMenuItems = (rootPath: string, caption: string) =>
      `json_object(
              'link', ${this.absoluteURL("")}||'${rootPath}',
              'title', ${literal(caption)},
              'submenu', (
                  SELECT json_group_array(
                      json_object(
                          'title', title,
                          'link', ${this.absoluteURL("/")}||link,
                          'description', description
                      )
                  )
                  FROM (
                      SELECT
                          COALESCE(abbreviated_caption, caption) as title,
                          COALESCE(url, path) as link,
                          description
                      FROM sqlpage_aide_navigation
                      WHERE namespace = 'prime' AND parent_path = '${rootPath}/index.sql'
                      ORDER BY sibling_order
                  )
              )
          ) as menu_item`;

    const handlers = {
      DEFAULT: (key: string, value: unknown) => `${literal(value)} AS ${key}`,
      menu_item: (key: string, items: Record<string, unknown>[]) =>
        items.map((item) => `${literal(JSON.stringify(item))} AS ${key}`),
      javascript: (key: string, scripts: string[]) => {
        const items = scripts.map((s) => `${literal(s)} AS ${key}`);
        items.push(selectNavMenuItems("/docs/index.sql", "Docs"));
        items.push(selectNavMenuItems("console", "Console"));
        return items;
      },
      footer: () =>
        // Dynamic SQL query to fetch the version directly in the footer
        `'Spry v0.0.1 Web UI (v' || sqlpage.version() || ') ' || ` +
        `'📄 [' || substr(sqlpage.path(), 2) || '](' || ${
          this.absoluteURL("/console/sqlpage-files/sqlpage-file.sql?path=")
        } || substr(sqlpage.path(), LENGTH(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX')) + 2 ) || ')' as footer`,
    };
    const shell = this.defaultShell();
    const sqlSelectExpr = Object.entries(shell).flatMap(([k, v]) => {
      switch (k) {
        case "menu_item":
          return handlers.menu_item(k, v as Record<string, unknown>[]);
        case "javascript":
          return handlers.javascript(k, v as string[]);
        case "footer":
          return handlers.footer();
        default:
          return handlers.DEFAULT(k, v);
      }
    });
    return `
      SELECT ${sqlSelectExpr.join(",\n       ")};
    `;
  }
}

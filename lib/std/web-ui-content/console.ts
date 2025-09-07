import * as spn from "../notebook/sqlpage.ts";
import { raw, SQL } from "../../universal/sql-text.ts";

// custom decorator that makes navigation for this notebook type-safe
export function consoleNav(
  route: Omit<spn.RouteConfig, "path" | "parentPath" | "namespace">,
) {
  return spn.navigationPrime({
    ...route,
    parentPath: "console/index.sql",
  });
}

export class ConsoleSqlPages extends spn.TypicalSqlPageNotebook {
  infoSchemaDDL() {
    // deno-fmt-ignore
    return SQL`
      -- ${raw`${this.tsProvenanceComment(import.meta.url)}`}}

      DROP TABLE IF EXISTS spry_table_info;
      CREATE TABLE spry_table_info AS
      SELECT tbl.name AS table_name, x.*
      FROM sqlite_schema AS tbl, pragma_table_xinfo(tbl.name) AS x;

      -- console_information_schema_* are convenience views
      -- built on top of spry_table_info (filled via pragma_table_xinfo).
      DROP VIEW IF EXISTS console_information_schema_table;
      CREATE VIEW console_information_schema_table AS
      SELECT
        tbl.name AS table_name,
        col.name AS column_name,
        col.type AS data_type,
        CASE WHEN col.pk > 0 THEN 'Yes' ELSE 'No' END AS is_primary_key,
        CASE WHEN col."notnull" = 1 THEN 'Yes' ELSE 'No' END AS is_not_null,
        col.dflt_value AS default_value,
        'console/info-schema/table.sql?name=' || tbl.name || '&stats=yes' as info_schema_web_ui_path,
        '[Content](console/info-schema/table.sql?name=' || tbl.name || '&stats=yes)' as info_schema_link_abbrev_md,
        '[' || tbl.name || ' (table) Schema](console/info-schema/table.sql?name=' || tbl.name || '&stats=yes)' as info_schema_link_full_md,
        'console/content/table/' || tbl.name || '.sql?stats=yes' as content_web_ui_path,
        '[Content]($SITE_PREFIX_URL/console/content/table/' || tbl.name || '.sql?stats=yes)' as content_web_ui_link_abbrev_md,
        '[' || tbl.name || ' (table) Content](console/content/table/' || tbl.name || '.sql?stats=yes)' as content_web_ui_link_full_md,
        tbl.sql as sql_ddl
      FROM sqlite_schema AS tbl
      JOIN spry_table_info AS col
        ON col.table_name = tbl.name
      WHERE tbl.type = 'table'
        AND tbl.name NOT LIKE 'sqlite_%'
        AND IFNULL(col.hidden, 0) = 0          -- show only visible columns from xinfo
      ORDER BY tbl.name, col.cid;

      -- Populate the view info using the helper table spry_table_info (no PRAGMAs in views)
      DROP VIEW IF EXISTS console_information_schema_view;
      CREATE VIEW console_information_schema_view AS
      SELECT
        vw.name AS view_name,
        col.name AS column_name,
        col.type AS data_type,
        '/console/info-schema/view.sql?name=' || vw.name || '&stats=yes' as info_schema_web_ui_path,
        '[Content](console/info-schema/view.sql?name=' || vw.name || '&stats=yes)' as info_schema_link_abbrev_md,
        '[' || vw.name || ' (view) Schema](console/info-schema/view.sql?name=' || vw.name || '&stats=yes)' as info_schema_link_full_md,
        '/console/content/view/' || vw.name || '.sql?stats=yes' as content_web_ui_path,
        '[Content]($SITE_PREFIX_URL/console/content/view/' || vw.name || '.sql?stats=yes)' as content_web_ui_link_abbrev_md,
        '[' || vw.name || ' (view) Content](console/content/view/' || vw.name || '.sql?stats=yes)' as content_web_ui_link_full_md,
        vw.sql as sql_ddl
      FROM sqlite_schema AS vw
      JOIN spry_table_info AS col
        ON col.table_name = vw.name
      WHERE vw.type = 'view'
        AND vw.name NOT LIKE 'sqlite_%'
        AND IFNULL(col.hidden, 0) = 0
      ORDER BY vw.name, col.cid;

      DROP VIEW IF EXISTS console_content_tabular;
      CREATE VIEW console_content_tabular AS
        SELECT 'table' as tabular_nature,
               table_name as tabular_name,
               info_schema_web_ui_path,
               info_schema_link_abbrev_md,
               info_schema_link_full_md,
               content_web_ui_path,
               content_web_ui_link_abbrev_md,
               content_web_ui_link_full_md
          FROM console_information_schema_table
        UNION ALL
        SELECT 'view' as tabular_nature,
               view_name as tabular_name,
               info_schema_web_ui_path,
               info_schema_link_abbrev_md,
               info_schema_link_full_md,
               content_web_ui_path,
               content_web_ui_link_abbrev_md,
               content_web_ui_link_full_md
          FROM console_information_schema_view;

      -- Populate the table with table column foreign keys
      DROP VIEW IF EXISTS console_information_schema_table_col_fkey;
      CREATE VIEW console_information_schema_table_col_fkey AS
      SELECT
          tbl.name AS table_name,
          f."from" AS column_name,
          f."from" || ' references ' || f."table" || '.' || f."to" AS foreign_key
      FROM sqlite_master tbl
      JOIN pragma_foreign_key_list(tbl.name) f
      WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%';

      -- Populate the table with table column indexes
      DROP VIEW IF EXISTS console_information_schema_table_col_index;
      CREATE VIEW console_information_schema_table_col_index AS
      SELECT
          tbl.name AS table_name,
          pi.name AS column_name,
          idx.name AS index_name
      FROM sqlite_master tbl
      JOIN pragma_index_list(tbl.name) idx
      JOIN pragma_index_info(idx.name) pi
      WHERE tbl.type = 'table' AND tbl.name NOT LIKE 'sqlite_%'; 

      -- Drop and create the table for storing navigation entries
      -- for testing only: DROP TABLE IF EXISTS sqlpage_aide_navigation;
      CREATE TABLE IF NOT EXISTS sqlpage_aide_navigation (
          path TEXT NOT NULL, -- the "primary key" within namespace
          caption TEXT NOT NULL, -- for human-friendly general-purpose name
          namespace TEXT NOT NULL, -- if more than one navigation tree is required
          parent_path TEXT, -- for defining hierarchy
          sibling_order INTEGER, -- orders children within their parent(s)
          url TEXT, -- for supplying links, if different from path
          title TEXT, -- for full titles when elaboration is required, default to caption if NULL
          abbreviated_caption TEXT, -- for breadcrumbs and other "short" form, default to caption if NULL
          description TEXT, -- for elaboration or explanation
          elaboration TEXT, -- optional attributes for e.g. { "target": "__blank" }
          -- TODO: figure out why Rusqlite does not allow this but sqlite3 does
          -- CONSTRAINT fk_parent_path FOREIGN KEY (namespace, parent_path) REFERENCES sqlpage_aide_navigation(namespace, path),
          CONSTRAINT unq_ns_path UNIQUE (namespace, parent_path, path)
      );
      DELETE FROM sqlpage_aide_navigation WHERE path LIKE 'console/%';
      DELETE FROM sqlpage_aide_navigation WHERE path LIKE 'index.sql';

      -- all @navigation decorated entries are automatically added to this.navigation
      ${this.upsertNavSQL(...Array.from(this.navigation.values()))}`;
  }

  /**
   * A SQLite "procedure" (SQL code block) which is always run when console UX is loaded
   * and may be run "manually" via web UI upon request. Treat this SQL block as a procedure
   * because it may be inserted into SQLPage as "commands", too.
   *
   * - Deletes `sqlpage_files` rows where `path` is 'console/content/%/%.auto.sql'.
   * - Generate default "content" pages in `sqlpage_files` for each table and view in the database.
   * - If no default 'console/content/<table|view>/<table-or-view-name>.sql exists, setup redirect to the auto-generated default content page.
   *   - if a page is inserted by another utility (custom page by an app/service) it's not replaced
   * @returns
   */
  infoSchemaContentDML() {
    // NOTE: we're not using sql`` on purpose since it seems to be mangling SQL
    //       when it's "included" (injected) into SQLPage /action/ pages.
    // TODO: add this same SQL block into a code_notebook_cell row too
    // deno-fmt-ignore
    return SQL`
      -- ${raw`${this.tsProvenanceComment(import.meta.url)}`}}

      -- the "auto-generated" tables will be in '*.auto.sql' with redirects
      DELETE FROM sqlpage_files WHERE path like 'console/content/table/%.auto.sql';
      DELETE FROM sqlpage_files WHERE path like 'console/content/view/%.auto.sql';
      INSERT OR REPLACE INTO sqlpage_files (path, contents)
        SELECT
            'console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql',
            'SELECT ''dynamic'' AS component, sqlpage.run_sql(''shell/shell.sql'') AS properties;

              SELECT ''breadcrumb'' AS component;
              SELECT ''Home'' as title,sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX'') || ''/'' AS link;
              SELECT ''Console'' as title,sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX'') || ''/console'' AS link;
              SELECT ''Content'' as title,sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX'') || ''/console/content'' AS link;
              SELECT ''' || tabular_name  || ' ' || tabular_nature || ''' as title, ''#'' AS link;

              SELECT ''title'' AS component, ''' || tabular_name || ' (' || tabular_nature || ') Content'' as contents;

              SET total_rows = (SELECT COUNT(*) FROM ' || tabular_name || ');
              SET limit = COALESCE($limit, 50);
              SET offset = COALESCE($offset, 0);
              SET total_pages = ($total_rows + $limit - 1) / $limit;
              SET current_page = ($offset / $limit) + 1;

              SELECT ''text'' AS component, ''' || info_schema_link_full_md || ''' AS contents_md
              SELECT ''text'' AS component,
                ''- Start Row: '' || $offset || ''\n'' ||
                ''- Rows per Page: '' || $limit || ''\n'' ||
                ''- Total Rows: '' || $total_rows || ''\n'' ||
                ''- Current Page: '' || $current_page || ''\n'' ||
                ''- Total Pages: '' || $total_pages as contents_md
              WHERE $stats IS NOT NULL;

              -- Display uniform_resource table with pagination
              SELECT ''table'' AS component,
                    TRUE AS sort,
                    TRUE AS search,
                    TRUE AS hover,
                    TRUE AS striped_rows,
                    TRUE AS small;
            SELECT * FROM ' || tabular_name || '
            LIMIT $limit
            OFFSET $offset;

            SELECT ''text'' AS component,
                (SELECT CASE WHEN $current_page > 1 THEN ''[Previous](?limit='' || $limit || ''&offset='' || ($offset - $limit) || '')'' ELSE '''' END) || '' '' ||
                ''(Page '' || $current_page || '' of '' || $total_pages || '') '' ||
                (SELECT CASE WHEN $current_page < $total_pages THEN ''[Next](?limit='' || $limit || ''&offset='' || ($offset + $limit) || '')'' ELSE '''' END)
                AS contents_md;'
        FROM console_content_tabular;

      INSERT OR IGNORE INTO sqlpage_files (path, contents)
        SELECT
            'console/content/' || tabular_nature || '/' || tabular_name || '.sql',
            'SELECT ''redirect'' AS component,sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX'') || ''/console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql'' AS link WHERE $stats IS NULL;\n' ||
            'SELECT ''redirect'' AS component,sqlpage.environment_variable(''SQLPAGE_SITE_PREFIX'') || ''/console/content/' || tabular_nature || '/' || tabular_name || '.auto.sql?stats='' || $stats AS link WHERE $stats IS NOT NULL;'
        FROM console_content_tabular;

      -- TODO: add \${this.upsertNavSQL(...)} if we want each of the above to be navigable through DB rows`;
  }

  @spn.navigationPrime({
    caption: "Home",
    title: "Spry BaaS Database",
    description: "Welcome to Spry Backend-as-a-Service (BaaS) Database",
  })
  @spn.shell({ breadcrumbsFromNavStmts: "no" })
  "index.sql"() {
    return SQL`
      SELECT 'list' AS component;
      SELECT caption as title, COALESCE(url, path) as link, description
        FROM sqlpage_aide_navigation
       WHERE namespace = 'prime' AND parent_path = 'index.sql'
       ORDER BY sibling_order;`;
  }

  @spn.navigationPrimeTopLevel({
    caption: "Spry Console",
    abbreviatedCaption: "Console",
    title: "Spry BaaS Console",
    description:
      "Explore Spry BaaS Database information schema and and SQLPage files",
    siblingOrder: 999,
  })
  "console/index.sql"() {
    return SQL`
      WITH console_navigation_cte AS (
          SELECT title, description
            FROM sqlpage_aide_navigation
           WHERE namespace = 'prime' AND path =${
      this.constructHomePath("console")
    }
      )
      SELECT 'list' AS component, title, description
        FROM console_navigation_cte;
      SELECT caption as title, ${
      this.absoluteURL("/")
    } || COALESCE(url, path) as link, description
        FROM sqlpage_aide_navigation
       WHERE namespace = 'prime' AND parent_path = ${
      this.constructHomePath("console")
    }
       ORDER BY sibling_order;`;
  }

  @consoleNav({
    caption: "Spry DB Information Schema",
    abbreviatedCaption: "Info Schema",
    description:
      "Explore Spry DB tables, columns, views, and other information schema documentation",
    siblingOrder: 1,
  })
  "console/info-schema/index.sql"() {
    // deno-fmt-ignore
    return SQL`
      SELECT 'title' AS component, 'Tables' as contents;
      SELECT 'table' AS component,
            'Table' AS markdown,
            'Column Count' as align_right,
            'Content' as markdown,
            TRUE as sort,
            TRUE as search;
      SELECT
          '[' || table_name || '](table.sql?name=' || table_name || ')' AS "Table",
          COUNT(column_name) AS "Column Count",
          REPLACE(content_web_ui_link_abbrev_md,'$SITE_PREFIX_URL',${this.absoluteURL("")}) as "Content"
      FROM console_information_schema_table
      GROUP BY table_name;

      SELECT 'title' AS component, 'Views' as contents;
      SELECT 'table' AS component,
            'View' AS markdown,
            'Column Count' as align_right,
            'Content' as markdown,
            TRUE as sort,
            TRUE as search;
      SELECT
          '[' || view_name || '](view.sql?name=' || view_name || ')' AS "View",
          COUNT(column_name) AS "Column Count",
          REPLACE(content_web_ui_link_abbrev_md,'$SITE_PREFIX_URL',${this.absoluteURL("")}) as "Content"
      FROM console_information_schema_view
      GROUP BY view_name;

      SELECT 'title' AS component, 'Migrations' as contents;
      SELECT 'table' AS component,
            'Table' AS markdown,
            'Column Count' as align_right,
            TRUE as sort,
            TRUE as search;
      SELECT from_state, to_state, transition_reason, transitioned_at
      FROM code_notebook_state
      ORDER BY transitioned_at;`;
  }

  // no @consoleNav since this is a "utility" page (not navigable)
  @spn.shell({ breadcrumbsFromNavStmts: "no" })
  "console/info-schema/table.sql"() {
    return SQL`
      ${this.activeBreadcrumbsSQL({ titleExpr: `$name || ' Table'` })}

      SELECT 'title' AS component, $name AS contents;
      SELECT 'table' AS component;
      SELECT
          column_name AS "Column",
          data_type AS "Type",
          is_primary_key AS "PK",
          is_not_null AS "Required",
          default_value AS "Default"
      FROM console_information_schema_table
      WHERE table_name = $name;

      SELECT 'title' AS component, 'Foreign Keys' as contents, 2 as level;
      SELECT 'table' AS component;
      SELECT
          column_name AS "Column Name",
          foreign_key AS "Foreign Key"
      FROM console_information_schema_table_col_fkey
      WHERE table_name = $name;

      SELECT 'title' AS component, 'Indexes' as contents, 2 as level;
      SELECT 'table' AS component;
      SELECT
          column_name AS "Column Name",
          index_name AS "Index Name"
      FROM console_information_schema_table_col_index
      WHERE table_name = $name;

      SELECT 'title' AS component, 'SQL DDL' as contents, 2 as level;
      SELECT 'code' AS component;
      SELECT 'sql' as language, (SELECT sql_ddl FROM console_information_schema_table WHERE table_name = $name) as contents;`;
  }

  // no @consoleNav since this is a "utility" page (not navigable)
  @spn.shell({ breadcrumbsFromNavStmts: "no" })
  "console/info-schema/view.sql"() {
    return SQL`
      ${this.activeBreadcrumbsSQL({ titleExpr: `$name || ' View'` })}

      SELECT 'title' AS component,
      $name AS contents;
      SELECT 'table' AS component;
      SELECT
          column_name AS "Column",
          data_type AS "Type"
      FROM console_information_schema_view
      WHERE view_name = $name;

      SELECT 'title' AS component, 'SQL DDL' as contents, 2 as level;
      SELECT 'code' AS component;
      SELECT 'sql' as language, (SELECT sql_ddl FROM console_information_schema_view WHERE view_name = $name) as contents;`;
  }

  @consoleNav({
    caption: "Spry SQLPage Files",
    abbreviatedCaption: "SQLPage Files",
    description:
      "Explore Spry SQLPage Files which govern the content of the web-UI",
    siblingOrder: 3,
  })
  "console/sqlpage-files/index.sql"() {
    // deno-fmt-ignore
    return SQL`
      SELECT 'title' AS component, 'SQLPage pages in sqlpage_files table' AS contents;
      SELECT 'table' AS component,
            'Path' as markdown,
            'Size' as align_right,
            TRUE as sort,
            TRUE as search;
         SELECT
        '[🚀](' || ${this.absoluteURL("/")} || path || ') [📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",
         LENGTH(contents) as "Size", last_modified
      FROM sqlpage_files
      ORDER BY path;`;
  }

  // no @consoleNav since this is a "utility" page (not navigable)
  @spn.shell({ breadcrumbsFromNavStmts: "no" })
  "console/sqlpage-files/sqlpage-file.sql"() {
    return SQL`
      ${this.activeBreadcrumbsSQL({ titleExpr: `$path || ' Path'` })}

      SELECT 'title' AS component, $path AS contents;
      SELECT 'text' AS component,
             '\`\`\`sql\n' || (select contents FROM sqlpage_files where path = $path) || '\n\`\`\`' as contents_md;`;
  }

  @consoleNav({
    caption: "Spry Data Tables Content SQLPage Files",
    abbreviatedCaption: "Content SQLPage Files",
    description:
      "Explore auto-generated Spry SQLPage Files which display content within tables",
    siblingOrder: 3,
  })
  "console/sqlpage-files/content.sql"() {
    // deno-fmt-ignore
    return SQL`
      SELECT 'title' AS component, 'SQLPage pages generated from tables and views' AS contents;
      SELECT 'text' AS component, '
        - \`*.auto.sql\` pages are auto-generated "default" content pages for each table and view defined in the database.
        - The \`*.sql\` companions may be auto-generated redirects to their \`*.auto.sql\` pair or an app/service might override the \`*.sql\` to not redirect and supply custom content for any table or view.
        - [View regenerate-auto.sql](' || ${this.absoluteURL("/console/sqlpage-files/sqlpage-file.sql?path=console/content/action/regenerate-auto.sql")
    } || ')
        ' AS contents_md;

      SELECT 'button' AS component, 'center' AS justify;
      SELECT ${this.absoluteURL("/console/content/action/regenerate-auto.sql")} AS link, 'info' AS color, 'Regenerate all "default" table/view content pages' AS title;

      SELECT 'title' AS component, 'Redirected or overriden content pages' as contents;
      SELECT 'table' AS component,
            'Path' as markdown,
            'Size' as align_right,
            TRUE as sort,
            TRUE as search;
            SELECT
        '[🚀](' || ${this.absoluteURL("/")} || path || ')[📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",

        LENGTH(contents) as "Size", last_modified
      FROM sqlpage_files
      WHERE path like 'console/content/%'
            AND NOT(path like 'console/content/%.auto.sql')
            AND NOT(path like 'console/content/action%')
      ORDER BY path;

      SELECT 'title' AS component, 'Auto-generated "default" content pages' as contents;
      SELECT 'table' AS component,
            'Path' as markdown,
            'Size' as align_right,
            TRUE as sort,
            TRUE as search;
          SELECT
            '[🚀](' || ${this.absoluteURL("/")} || path || ') [📄 ' || path || '](sqlpage-file.sql?path=' || path || ')' AS "Path",

        LENGTH(contents) as "Size", last_modified
      FROM sqlpage_files
      WHERE path like 'console/content/%.auto.sql'
      ORDER BY path;
      `;
  }

  @spn.shell({ eliminate: true })
  "console/content/action/regenerate-auto.sql"() {
    return SQL`
      ${this.infoSchemaContentDML()}

      -- ${raw`${this.tsProvenanceComment(import.meta.url)}`}
      SELECT 'redirect' AS component, sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || '/console/sqlpage-files/content.sql' as link WHERE $redirect is NULL;
      SELECT 'redirect' AS component, sqlpage.environment_variable('SQLPAGE_SITE_PREFIX') || $redirect as link WHERE $redirect is NOT NULL;
    `;
  }

  @consoleNav({
    caption: "Spry SQLPage Navigation",
    abbreviatedCaption: "SQLPage Navigation",
    description:
      "See all the navigation entries for the web-UI; TODO: need to improve this to be able to get details for each navigation entry as a table",
    siblingOrder: 3,
  })
  "console/sqlpage-nav/index.sql"() {
    return SQL`
      SELECT 'title' AS component, 'SQLPage navigation in sqlpage_aide_navigation table' AS contents;
      SELECT 'table' AS component, TRUE as sort, TRUE as search;
      SELECT path, caption, description FROM sqlpage_aide_navigation ORDER BY namespace, parent_path, path, sibling_order;`;
  }
}

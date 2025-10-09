---
siteName: Demo
sqlpage-conf:
  database_url: "sqlite://app.db"
  listen_on: "0.0.0.0:8080"
  web_root: "./"
  site_prefix: "/sqlpage"
  https_domain: "example.com"
  host: "example.com"
  allow_exec: true
  max_uploaded_file_size: 1048576
  environment: "development"
  oidc:
    issuer_url: "https://issuer.example/"
    client_id: "abc"
    client_secret: "shh"
---

## Intro

```sql HEAD
-- head at start
PRAGMA foreign_keys = ON;
```

```sql admin/index.sql { route: { caption: "test" } }
select 1;
-- this is the path: ${ctx.path}
-- this is the caption: ${ctx.route.caption}
```

```sql users/list.sql
select 2;
-- this is the path: ${ctx.path}
-- this is the cell: ${ctx.cell?.kind}
-- this is the frontmatter in the cell's notebook: ${JSON.stringify(ctx.cell.frontmatter)}
```

```sql debug.sql
-- site prefixed: ${ctx.sitePrefixed("'test'")}

-- site prefixed: ${ctx.partial("test")}

-- full context: ${JSON.stringify(ctx)}
```

The following `LAYOUT` will be prefixed across every SQLPage page because no
paths are provided (`sql LAYOUT` without path is same as `sql LAYOUT **/*`).

The `${ctx.path}` will be replaced with the path of the page. `${ctx.*}` are all
variables like `${ctx.route}`, etc.

```sql LAYOUT
-- global LAYOUT (defaults to **/*)
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${ctx.path}.auto.json');
-- add shell, etc. here
```

The following `LAYOUT` will be prefixed only for the admin paths:

```sql LAYOUT admin/**
-- admin/** LAYOUT
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${ctx.path}.auto.json');
-- add shell, etc. here
```

## Explanation

```sql HEAD
-- head 2, near TAIL
```

```sql TAIL
-- done
```

## Appendix

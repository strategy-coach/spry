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

```sql { kind: "head", name: "pragma" }
PRAGMA foreign_keys = ON;
```

```sql { role: "section-defaults" }
{ name: "defaults-ignored" }
```

```sql { kind: "page", path: "admin/index", route: { caption: "test" } }
select 1;
```

```sql { path: "users/list" }
select 2;
```

```sql { kind: "tail" }
-- done
```

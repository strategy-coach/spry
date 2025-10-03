# Policy Generator (HTML-First)

A simple static, HTML-first tool that fills Markdown policies containing
Mustache placeholders with values from a top-of-page form — all in the browser.
No server logic, no build step.

## What’s included

- `index.html` — the main shell:

  - Top form for org/contact/policy values
  - Left sidebar listing Markdown policies
  - Right preview showing the selected policy with placeholders filled
  - Buttons for Copy, Download .html, Download .md
  - A placeholder panel showing which variables are used and whether they’re
    filled
- `index.js` — clean ES module (no globals), uses classes and
  `EventTarget`/`CustomEvent` for communication
- `example1.md`, `example2.md`, `example3.md` — sample Markdown templates with
  placeholders like `{{org.name}}`

Libraries are loaded from CDN:

- [Mustache](https://mustache.github.io/) for template variable replacement
- [markdown-it](https://github.com/markdown-it/markdown-it) for Markdown → HTML
- [Pico.css](https://picocss.com/) for classless styling

## Running locally with Deno

You only need [Deno 2.4+](https://deno.com/) — no npm, no Node.

1. Open a terminal in the project folder.

2. Run Deno’s file server:

   ```bash
   deno run -A jsr:@std/http/file-server .
   ```

   By default this serves the current directory on `http://localhost:8000/` (the
   port may vary; check the console output).

3. Open the reported URL in your browser, for example:

   ```
   http://localhost:8000/index.html
   ```

That’s it. The app is fully static — `fetch()` loads the `.md` files via the
local server.

> Why not `file://`? Browsers block `fetch()` from reading local files directly.
> Serving over HTTP avoids those restrictions.

## Adding your own policy templates

1. Create a new file `my-policy.md` with placeholders:

   ```markdown
   # Data Retention Policy

   Organization: {{org.name}}\
   Effective Date: {{policy.effectiveDate}}

   We retain customer data for {{policy.retentionYears}} years.
   ```

2. Add an input to the top form in `index.html` for any new paths:

   ```html
   <label>Retention (years)
     <input type="number" data-path="policy.retentionYears" min="0" />
   </label>
   ```

3. Register the policy in the inline manifest inside `index.html`:

   ```json
   {
     "id": "retention",
     "file": "my-policy.md",
     "title": "Data Retention Policy"
   }
   ```

Reload in the browser — the new policy appears in the sidebar.

## How it works

- Form fields use `data-path="org.name"` etc. to map into a nested JSON object.
- Mustache merges JSON → Markdown.
- markdown-it renders the filled Markdown → HTML.
- Auto-saves form values in `localStorage`.
- Copy/Download buttons export the result for use in Word or other tools.

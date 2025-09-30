**PROMPT**: I have a set of HTML files, SQL files, and TypeScript *.ts files in
a directory and multiple subdirectories that I want to treat as a master
"module". This master module will be used across multiple projects as local
files and whenever the master changes I want to automatically sync them to the
local projects as "vendored" files. Mostly my programming language is Deno so
give some innovative ideas where I can use either Deno or another lightweight
open source project to manage the master in its own github repo and
subdirectories in the github repo but keep them updated in dependent projects.

Awesome use case. Since you want the master to live in its own GitHub repo (with
subdirectories) and to **materialize those files locally** in many projects
(“vendored”), here are a few solid patterns—ranging from zero-deps Git to tiny
Deno tooling—plus copy-paste snippets.

# 1) Easiest & robust: `git subtree` (recommended)

**What it does:** Copies a folder (or whole repo) from your **master** into a
subfolder of each dependent repo, and later lets you pull updates with a single
command—no submodule headaches. Files live normally in the dependent repo
history.

**Initial add (in a dependent project):**

```bash
# Pull master repo into vendor/spry (choose your path) at the given ref
git subtree add --prefix=vendor/spry https://github.com/you/master-repo.git main --squash
```

**Update later:**

```bash
git subtree pull --prefix=vendor/spry https://github.com/you/master-repo.git main --squash
```

**Pros**

- No extra tools; works great for _“copy and forget until I pull again”_.
- Works with subdirectories: put the stuff you want under a single dir in master
  (e.g. `lib/std`), and use the repo’s root. If you must import _only_ a subdir,
  see option 2 (tarball) or keep your master content under one top-level folder
  so subtree pulls just that.

**Tips**

- Wrap these in Deno tasks so teams do `deno task vendor:add` /
  `deno task vendor:update`.

```json
// deno.json
{
  "tasks": {
    "vendor:add": "git subtree add --prefix=vendor/spry https://github.com/you/master-repo.git main --squash",
    "vendor:update": "git subtree pull --prefix=vendor/spry https://github.com/you/master-repo.git main --squash"
  }
}
```

# 2) “No Git magic” approach: Deno tarball vendoring (pull any subdir)

**What it does:** Each dependent repo runs a tiny Deno script that downloads a
GitHub **tarball** for a tag/branch/commit, extracts **only** the subdir you
care about (e.g. `lib/std`), cleans old files, and writes them into `spry/`.

**Manifest (`vendor.json`)**

```json
{
  "source": "https://api.github.com/repos/you/master-repo/tarball/main",
  "subdir": "lib/std",
  "dest": "spry"
}
```

**`sync.ts` (drop-in Deno script)**

```ts
#!/usr/bin/env -S deno run --allow-net=api.github.com --allow-read --allow-write
// sync.ts: fetch a repo tarball, extract a subdir into dest, clean removed files.

import { emptyDir, ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { untar } from "https://deno.land/std@0.224.0/archive/tar.ts";
import { join, relative, sep } from "https://deno.land/std@0.224.0/path/mod.ts";

type Manifest = { source: string; subdir: string; dest: string };
const manifest: Manifest = JSON.parse(await Deno.readTextFile("vendor.json"));

const res = await fetch(manifest.source, {
  headers: { "Accept": "application/vnd.github+json" },
});
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  Deno.exit(1);
}
const buff = new Uint8Array(await res.arrayBuffer());

// GitHub tarballs are gzipped; gunzip then untar
const gunzipped = await new Response(buff).arrayBuffer(); // auto gunzip by fetch in many cases
const reader = new Deno.Buffer(new Uint8Array(gunzipped));
const dest = manifest.dest;

// Clean dest before extracting (acts like rsync --delete)
await emptyDir(dest);

for await (const entry of untar(reader)) {
  if (!entry.fileName.includes("/")) continue; // top-level folder name
  // strip the first path component: repo-hash/
  const parts = entry.fileName.split("/");
  const stripped = parts.slice(1).join("/");

  // Only take files under subdir
  if (!stripped.startsWith(manifest.subdir + "/")) continue;

  const rel = stripped.slice(manifest.subdir.length + 1);
  if (!rel) continue;

  const outPath = join(dest, rel);

  if (entry.type === "directory") {
    await ensureDir(outPath);
  } else if (entry.type === "file") {
    await ensureDir(join(outPath, ".."));
    await Deno.writeFile(outPath, entry.content!);
  }
}

console.log(`Vendored '${manifest.subdir}' -> '${dest}'`);
```

**Usage in dependents:**

```bash
deno run -q --allow-net=api.github.com --allow-read --allow-write sync.ts
```

**Pros**

- Works with any subdirectory layout in master.
- No Git coupling; you can pin to a tag by changing `source` to the tag tarball.
- Easy to automate in CI.

# 3) Pure-URL imports + `deno vendor` (when you can import)

If your master exposes public import URLs (e.g. GitHub raw, a Deno.land module,
a Gitea Pages, etc.), dependents can import those URLs and then **vendor** the
resolved graph to local files:

```ts
// in your project code
import { helper } from "https://raw.githubusercontent.com/you/master-repo/main/lib/std/helper.ts";
```

Then vendor them locally:

```bash
deno vendor main.ts  # or your entry points
# produces ./vendor/** with pinned local copies
```

**Update**: bump URLs (if needed) and re-run `deno vendor`. **Pros**:
dead-simple; Deno handles the whole graph, hashes, and lockfile. **Con**: better
for _code modules_ than for arbitrary HTML/SQL assets (though you can still
import them as data URLs or fetch at build-time).

# 4) “Local mirror” via `git sparse-checkout` (dev ergonomics)

When hacking locally, you can mount only needed subdirs from master next to your
project:

```bash
git clone --filter=blob:none --no-checkout https://github.com/you/master-repo.git .master
cd .master
git sparse-checkout init --cone
git sparse-checkout set lib/std
git checkout main
```

Now symlink into each project (your earlier `init.ts` helps):

```bash
deno run --allow-read --allow-write --allow-symlink init.ts --target lib/std --link spry --force
```

**Pros**: great for iterative dev; **Con**: not ideal as a distribution/update
story (use 1 or 2 for that).

# 5) Automatic PRs to dependents (optional)

If you want changes in master to _push_ out, have a GitHub Actions workflow in
**master** that runs option 2’s tarball vendoring **inside each dependent** and
opens a PR.

**Example action (master repo)**:

```yaml
name: Push vendored updates
on:
  push:
    branches: [main]
jobs:
  update-dependents:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with: { deno-version: v1.x }
      - name: Update dependents
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }} # repo-level PAT with repo perms
        run: |
          dependents=("you/app-a" "you/app-b")
          for repo in "${dependents[@]}"; do
            gh repo clone "$repo" dep
            cd dep
            # Drop in a vendor.json that points to master main (or tag), then run sync.ts
            jq -n \
              --arg src "https://api.github.com/repos/you/master-repo/tarball/main" \
              --arg sub "lib/std" \
              --arg dst "spry" \
              '{source:$src,subdir:$sub,dest:$dst}' > vendor.json
            deno run --allow-net=api.github.com --allow-read --allow-write ../sync.ts
            git checkout -b chore/vendor-update
            git add -A
            git commit -m "chore: vendor update from master-repo"
            gh pr create --fill || true
            cd ..
            rm -rf dep
          done
```

# Which should you pick?

- **Want the simplest, file-first workflow with good Git history?** →
  **`git subtree`** (Option 1).
- **Need to slice a subdirectory and handle non-code assets cleanly, with easy
  pinning?** → **Deno tarball vendoring** (Option 2).
- **You’re fine importing via URLs and letting Deno manage copies?** →
  **`deno vendor`** (Option 3).
- **Local dev ergonomics / live symlinks?** → **Sparse-checkout + symlink**
  (Option 4).
- **Master should push PRs automatically?** → Add **Option 5** on top of 1 or 2.

---

Yes — if you just need **“copy this directory into that directory, keeping them
in sync”** inside a repo, there are a few really nice, lightweight single-binary
tools you can use instead of wiring up a full `rsync` or Git plumbing:

---

## 🔹 Pure copy/sync tools

- **[rclone](https://rclone.org/)** Single static binary. It’s overkill if you
  only want local sync, but it supports the `copy` and `sync` verbs:

  ```bash
  rclone sync lib/std vendor/spry
  ```

  By default it only updates changes, deletes removed files, and preserves
  timestamps.

- **[rsync](https://rsync.samba.org/)** (classic) Usually preinstalled on
  Linux/macOS. On Windows you can get it via Git Bash or Cygwin:

  ```bash
  rsync -a --delete lib/std/ vendor/spry/
  ```

- **[syncthing](https://syncthing.net/)** A bit heavier (daemon + web UI) but if
  you want continuous sync across projects (even on different machines), it
  works great. For “copy on demand,” it’s probably too much.

---

## 🔹 Deno-native, single-file script

Since you’re already on Deno, you can also just drop in a \~40-line script and
get the same behavior without pulling in a binary:

```ts
#!/usr/bin/env -S deno run --allow-read --allow-write
// sync.ts: recursively mirror source into dest (like rsync -a --delete)

import { copy, emptyDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

const [src, dest] = Deno.args;
if (!src || !dest) {
  console.error(
    "Usage: deno run --allow-read --allow-write sync.ts <src> <dest>",
  );
  Deno.exit(1);
}

await emptyDir(dest); // wipe dest first
await copy(src, dest, { overwrite: true });
console.log(`Synced ${src} -> ${dest}`);
```

Run it like:

```bash
deno run --allow-read --allow-write sync.ts lib/std vendor/spry
```

That gives you a portable, version-controlled “mini-rsync” in one file.

---

## 🔹 Tiny Unix tools

- `cp -a lib/std/. vendor/spry/` → fastest if you just want “copy everything,
  overwrite.”
- Add `rm -rf vendor/spry/*` before the copy if you need deletion semantics.

---

✅ So:

- **If you want a ready-made, battle-tested binary** → `rsync` or `rclone`.
- **If you want something self-contained in your repo, no extra installs** → a
  little Deno script works beautifully.

---

Would you like me to write you a slightly smarter Deno script (like
`rsync --delete` but incremental, not a full `rm -rf` each time), so it only
touches changed/removed files instead of wiping the whole folder?

---

Perfect 👌 rclone is surprisingly handy for this sort of “mirror one folder into
another.” Here’s how you can use it in **two modes**:

---

# 🖥️ 1. Same Git repo, same local machine

If your repo layout looks like this:

```
repo/
  lib/std/       # master source
  vendor/spry/   # dependent vendored copy
```

You can just run:

```bash
# sync lib/std into vendor/spry
rclone sync ./lib/std ./vendor/spry
```

- `sync` makes the **destination identical to the source** (adds new, updates
  changed, deletes removed).
- Both paths can be plain filesystem paths — rclone automatically treats them as
  `local:` remote type.
- Add `-P` to see progress, or `-v` for verbose output.

Put it in a Deno task or npm script:

```json
// deno.json
{
  "tasks": {
    "vendor:sync": "rclone sync ./lib/std ./vendor/spry -P"
  }
}
```

Now run:

```bash
deno task vendor:sync
```

---

# ☁️ 2. From GitHub (pulling directly into your local repo)

## Option A — via `rclone`’s `http` backend

Every GitHub repo exposes raw files over HTTPS. You can mount/sync with the
`:http` remote, but GitHub doesn’t provide directory listings, so **this only
works if you know the archive URL** (tarball/zipball).

Example: Download + extract **tarball** with rclone:

```bash
# Point rclone to GitHub tarball (acts like an archive remote)
rclone copyurl https://github.com/you/master-repo/archive/refs/heads/main.zip ./tmp.zip
unzip -q -o tmp.zip -d tmp
rclone sync ./tmp/master-repo-main/lib/std ./vendor/spry
rm -rf tmp tmp.zip
```

## Option B — use `rclone backend` with a VFS remote

If you want something cleaner, configure rclone with a `github` remote that uses
GitHub’s API (through `http` remote):

```bash
rclone config
# name: master
# type: http
# url: https://raw.githubusercontent.com/you/master-repo/main
```

Now you can copy specific files:

```bash
rclone copy master:lib/std ./vendor/spry
```

⚠️ But note: raw\.githubusercontent.com doesn’t expose directory listings →
you’ll have to list files explicitly unless you maintain a manifest in master.

## Option C — GitHub tarball + rclone mount (recommended)

Since GitHub **does** expose repo tarballs, you can always grab them:

```bash
rclone copyurl https://github.com/you/master-repo/tarball/main tmp.tar.gz
mkdir -p tmp
tar -xzf tmp.tar.gz -C tmp
rclone sync tmp/you-master-repo-*/lib/std ./vendor/spry
rm -rf tmp tmp.tar.gz
```

This way you don’t need Git installed at all, just rclone + tar.

---

# 🔑 Summary

- **Local → Local**:

  ```bash
  rclone sync ./lib/std ./vendor/spry -P
  ```

- **From GitHub → Local** (no Git clone):

  ```bash
  rclone copyurl https://github.com/you/master-repo/tarball/main tmp.tar.gz
  tar -xzf tmp.tar.gz -C tmp
  rclone sync tmp/you-master-repo-*/lib/std ./vendor/spry
  rm -rf tmp tmp.tar.gz
  ```

---

Do you want me to wrap the GitHub tarball + sync workflow into a **single shell
script** (or a Deno task) so you can just run `deno task vendor:update` without
thinking about tarballs and temp dirs?

---

Yep ✅ you can compress Option C into a single one-liner using pipes — no temp
dirs, no zip files lying around.

Here’s the cleanest version (Linux/macOS, assuming `tar` + `rclone` are
installed):

```bash
curl -L https://github.com/you/master-repo/tarball/main \
  | tar -xz --strip-components=2 -C ./vendor/spry you-master-repo-main/lib/std
```

Explanation:

- `curl -L` downloads the tarball.
- `tar -xz` extracts from stdin.
- `--strip-components=2` drops the first two path parts
  (`you-master-repo-main/lib/std` → just the contents of `lib/std`).
- `-C ./vendor/spry` puts files directly into your `vendor/spry` folder.

---

👉 If you specifically want to use **`rclone`** in the pipeline (not just
`tar`), you can let `tar` do the heavy lifting and then let `rclone` sync the
extracted files, but that means a temp dir anyway. For a _pure pipe one-liner_,
`tar` alone is the simplest and fastest.

---

Do you want me to show you how to write the one-liner **without hardcoding**
`you-master-repo-main` (since GitHub tarballs always prepend
`repo-owner-repo-hash/`)?

---

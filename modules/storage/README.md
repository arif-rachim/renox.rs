# storage (#332)

Files for an app's users, through `ctx.storage` (`ops.md` 1.7.0 section 21). The platform keeps the bytes, the metadata (`renox__files`) and the image variants. This module adds:
- a folder per owner, with a quota;
- the SVG sanitiser;
- signed links;
- a file browser page with an upload form.

## Install

```sh
bunx renox add storage          # needs auth and i18n
```

```toml
storage = { version = "^1.0", mount = "/files", config = { quota_mb = 200 } }
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `max_upload_bytes` | 10 MiB | Largest file an upload accepts. The tier's limit still applies, and so does the gateway's body limit for page actions (1 MiB) |
| `allow_svg` | false | Accept SVG. A sanitised copy is stored: scripts, `on*` handlers, `foreignObject`, `iframe`, `javascript:` links and external `url()` are removed |
| `quota_mb` | 0 | Megabytes per owner. 0 means no per-owner quota; the tier's tenant quota still applies |
| `base_path` | `/files` | Where the file browser is mounted |

`[storage] allowed_types` (`module.toml`) lists the types the module stores.

## Services

| Service | What it does |
| --- | --- |
| `upload(owner, name, bytes, content_type, { public? })` | Stores the file within the owner's quota. Errors: `QUOTA`, `TOO_LARGE`, `SVG`, `INVALID` |
| `list(owner, { limit?, cursor? })`, `remove(owner, name)`, `link(owner, name, ttl_seconds)` | An owner's files |
| `quota(owner)` | `{ used_bytes, limit_bytes, files }` |
| `sanitizeSvg(text)` | The cleaned SVG, or null |

Owners and names are lower-case folder segments, and `keyOf` refuses any path that would escape the folder.

## The page

`<mount>` shows the signed-in user's own folder:
- images through `<x-image>`, with `srcset` and dimensions from the stored metadata;
- other files with a signed link valid for 10 minutes;
- the quota;
- a multipart upload form (`hx-encoding="multipart/form-data"`);
- a delete button per file.

With `storage.manage`, which the default policy grants to `admin`, `?owner=` opens another owner's folder. Without it, `?owner=` answers 403.

## Not built

- **`<x-upload>` as a partial.** A module's partials are not available as components in its own pages under that name, and `<x-form>` needs a fixed action. The page carries the form inline.
- **The shop's product images.** The module is installed on the shop, but its product images still come from `public/`. Moving them changes the product pages' source and needs B6 measured before and after.
- **`[storage] allowed_types` on the artifact entry.** `renox build` does not yet copy a module's list onto its entry (CLI), so the platform defaults apply to modules.
- **`storage__files` and `storage__variants`.** The platform's `renox__files` and its content-addressed variants hold this data (#321), so the module needs no tables.

## Tests

- `bun test` runs `tests/storage.test.ts`: folders and names, the sanitiser on hostile SVGs, links, listing.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs on the worker:
  - a stored PNG through `<x-image>`, with its dimensions and `srcset`;
  - a multipart upload through the page;
  - the per-owner quota;
  - another user refused another owner's folder, and an admin let in.

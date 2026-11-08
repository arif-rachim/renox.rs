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
| `max_upload_bytes` | 10 MiB | Largest file an upload accepts. The tier's limit still applies |
| `allow_svg` | false | Accept SVG. A sanitised copy is stored: scripts, `on*` handlers, `foreignObject`, `iframe`, `javascript:` links and external `url()` are removed, with or without a namespace prefix, until nothing changes; a file with anything dangerous left is refused (`SVG`) |
| `quota_mb` | 0 | Megabytes per owner. 0 means no per-owner quota; the tier's tenant quota still applies |
| `base_path` | `/files` | Where the file browser is mounted |

`[storage] allowed_types` (`module.toml`) lists the types the module stores.

## Services

| Service | What it does |
| --- | --- |
| `upload(owner, name, bytes, content_type, { public? })` | Stores the file within the owner's quota. Errors: `QUOTA`, `TOO_LARGE`, `SVG`, `INVALID` |
| `uploadUrl(owner, name, { contentType, maxBytes, public? })` | A signed URL for one browser `PUT` into the owner's folder ("Large files"). `maxBytes` is capped at `max_upload_bytes`; the quota is checked with `maxBytes` as the size; SVG is always refused (`SVG`). Answers `{ url, expires_at, max_bytes, key }` |
| `list(owner, { limit?, cursor? })`, `remove(owner, name)`, `link(owner, name, ttl_seconds)` | An owner's files |
| `quota(owner)` | `{ used_bytes, limit_bytes, files }` |
| `sanitizeSvg(text)` | The cleaned SVG, or null |

Owners and names are lower-case folder segments, and `keyOf` refuses any path that would escape the folder.

## Large files

A page action takes at most 1 MiB. A phone photo or a PDF is more, so the browser sends it straight to the store with a signed `PUT` (`ops.md` section 21, "Tenant uploads"):

1. **The action signs.** The app's action calls `storage.uploadUrl(owner, name, { contentType, maxBytes })` after its own checks (who may upload, which types) and answers `Response.json({ url, max_bytes })`. The URL works for 10 minutes and takes one successful `PUT` of that type and at most `maxBytes`.
2. **The browser sends.** `public/upload.js` posts the action, then `PUT`s the file to the URL.
3. **The form posts the key.** On 201 the script writes the stored key into a hidden input; the app's save action receives it, checks that it is inside the owner's folder and that the file exists, and records it.

```html
<script src="/upload.js" defer></script>
<x-form action="save">
  <input type="file" accept="image/jpeg,image/png" data-upload-action="/things/42?/file_url" data-key-field="file_key">
  <span data-upload-status></span>
  <input type="hidden" name="file_key">
  <button type="submit">Save</button>
</x-form>
```

| Attribute | Meaning |
| --- | --- |
| `data-upload-action` | The page action that signs. It gets the form fields `name`, `type`, `size` and the CSRF token of the page's `<x-csrf>` input, and answers `{ url, max_bytes }`, or a non-2xx JSON `{ message }` |
| `data-key-field` | The `name` of the hidden input (in the same form) that receives the stored key |
| `[data-upload-status]` | A `<span>` next to the input: the file name once stored, or the `message` of the error |

Copy `public/upload.js` into the app's `public/` (a module's own `public/` is not served yet). The script is loaded from `/public`, so the strict CSP allows it. Not built: resumable uploads, a progress bar.

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
- **`[storage] allowed_types` on the artifact entry.** `renox build` does not yet copy a module's list onto its entry (CLI), so the platform defaults apply to modules.
- **`storage__files` and `storage__variants`.** The platform's `renox__files` and its content-addressed variants hold this data (#321), so the module needs no tables.

## Used by

`examples/shop` stores its product images through `upload` and shows them with `<x-image>` (its README; B6 before and after in `bench/results/2026-10-31-B6-shop-product-images.md`).

## Tests

- `bun test` runs `tests/storage.test.ts` (folders and names, the sanitiser, links, listing) and `tests/hostile-svg.test.ts` (34 hostile SVGs: namespaced and split script tags, handlers after a slash or a quote, unquoted and encoded `javascript:` links, external `use`, `image` and `url()`, `@import`, entities; each comes out clean or is refused).
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs on the worker:
  - a stored PNG through `<x-image>`, with its dimensions and `srcset`;
  - a multipart upload through the page;
  - the per-owner quota;
  - another user refused another owner's folder, and an admin let in.

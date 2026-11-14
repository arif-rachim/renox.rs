// The technician's offline action queue (#808), on /me and the visit page only (a public file loaded with
// `defer`, after public/me.js and public/offline-queue-core.js; the CSP refuses inline scripts).
//
// A form marked `data-offline-action` keeps working without a signal. On submit:
//  - online (`hsMe.ping()` of public/me.js, the same check that shows the offline banner): the form posts
//    as it always did, with an `action_id` and `performed_at` added, so a double tap or a retry runs once on
//    the server (#806). It is sent with fetch so that a request that fails at the network level is not lost:
//    that one is queued like an offline one. Any answer but a success (a refused action, a form with errors,
//    a 5xx) is shown by the page itself: the form is posted natively, with the same `action_id`.
//  - offline: the action is kept in IndexedDB (`hs-offline` / `actions`) and the page shows it as done but
//    "not sent yet", from the renderer named by the form's `data-offline-effect`.
// The queue is sent when `/me/ping` answers (on load, on the `online` event, every 30 s while actions wait),
// strictly in order, one at a time, each as `POST <visit page>?/<action>` with `Accept: application/json`
// (the rules, and the backoff, are in offline-queue-core.js). Actions are stored with the id of the user who
// made them; the queue of another account is never sent under this session.
//
// Photos (#809): the photo forms of the visit page carry `data-photo-queue`. Choosing a file there is handled
// here, not by public/upload.js: the image is made at most 1600 px on its long side (a JPEG of quality 0.8; kept
// as it is when the browser cannot decode it), then, with no signal, or while an action of the same job still
// waits on the device (the photo goes after it), the blob is kept in IndexedDB (`hs-offline` / `photos`) and the
// page lists it under its phase as "not sent yet" with a Remove button; otherwise public/upload.js sends it at
// once, as it always did. The queue sends a waiting photo as one step of its job's ordered run, placed by
// `taken_at` (offline-queue-core.js: `photo_url`, a PUT of the blob, then the `photo` action).
//
// "Needs attention" (#810): on /me, a container the page provides (`#needs-attention`, hidden when there is nothing)
// lists what the server refused, per job, with what waits behind it (offline-queue-core.js `attention`). Each job
// has Discard (asks in the page first; removes the job's refused and unsent records from the device), Try again
// (only when every refusal is `job_reassigned` or a 422: the records go back to `pending` and are sent again with
// the same `action_id`s; there is no force) and Call the office (`tel:` the branch's number, `data-phone`). The
// replay marks its requests `x-hs-queued: 1` (replays only, never the first online send), which is how the server
// tells the office about a refusal (lib/action-log.ts).
// While anything of the signed-in user is saved and not sent, the header's link to the account page (where the
// auth module's sign-out button is) is swapped for /me/signout, a page that says how many actions are saved on the
// phone and asks "Sign out anyway?"; the link is put back when nothing is left. The logout itself stays the auth
// module's.
//
// What stays on the device: the records of `actions` (never a CSRF token, never a file) until the server has
// answered; a refused record stays until the technician discards it or sends it again ("Needs attention"), and
// carries the job's number and the customer's name as the visit page showed them (`job_number`, `customer`: the
// list names the visit with them, also when the office cancelled it and /me no longer lists it). The records of
// `photos` (the downsized image itself, its phase, caption, time, `action_id`, `job_number` and `customer`, never
// a token) until the server has the photo, or the technician removes it; a refused photo stays until removed.
// Nothing else but the flag `hs-queue-sent` in sessionStorage (a count, so "All sent" survives the reload that
// shows the server's page).
(() => {
  const core = window.hsQueueCore;
  const me = window.hsMe;
  if (!core || !me || !("indexedDB" in window)) return;

  const status = document.getElementById("queue-status");
  /** The "Needs attention" list of /me (#810) and the text of the sign-out warning page: both are provided by their pages. */
  const attn = document.getElementById("needs-attention");
  const attnList = document.getElementById("needs-attention-list");
  const signoutText = document.getElementById("signout-text");
  const text = (key, values) => core.fill((status && status.dataset[key]) || "", values || {});
  const meta = document.querySelector('meta[name="hs-user"]');
  const pageUser = meta ? meta.content : "";
  /** The visit page's job number and customer (`<meta name="hs-job">`), kept on what is saved for "Needs attention". */
  const jobMeta = document.querySelector('meta[name="hs-job"]');
  const jobLabel = jobMeta ? { job_number: jobMeta.content, customer: jobMeta.dataset.customer || "" } : {};
  const visitPage = /^\/me\/visits\/([A-Za-z0-9_-]{1,64})$/u.exec(location.pathname);
  const pageJob = visitPage ? visitPage[1] : null;
  const CSRF_COOKIE = "__Host-renox_csrf";
  const LOCK = "hs-offline-queue";

  let sessionUser = pageUser;
  let running = false;
  let signedOut = false;
  let retryAfter = 0;
  let sentNow = Number(sessionStorage.getItem("hs-queue-sent") || 0);
  let hasPending = false;
  /** The photos of the device as the last `view` read them. */
  let photosNow = [];
  /** The photo the technician just chose on this page and may still give a caption: `{ id, form, until }`; it waits there. */
  let held = null;
  let persistAsked = false;
  /** The job whose Discard is waiting for its answer in the "Needs attention" list. */
  let confirming = null;
  /** What the list was drawn from last (markup), so it is drawn again only when it changed. */
  let attnDrawn = null;
  const ACCOUNT = "/auth/account";
  const SIGN_OUT = "/me/signout";
  /** How long a chosen photo waits for its caption before it may be sent. */
  const HOLD_MS = 120000;

  // ---- the device: IndexedDB `hs-offline` / `actions` and `photos` ----

  /** One transaction on a store; `work(store)` returns what to resolve with (a request's result is read when it completes). */
  const deviceOn = async (name, mode, work) => {
    const db = await me.openDb();
    if (db === null) throw new Error("no storage");
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(name, mode);
      tx.oncomplete = () => {
        db.close();
        resolve(result instanceof IDBRequest ? result.result : result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("storage failed"));
      };
      result = work(tx.objectStore(name));
    });
  };
  const device = (mode, work) => deviceOn("actions", mode, work);
  const photoDevice = (mode, work) => deviceOn("photos", mode, work);
  const all = () => device("readonly", (s) => s.getAll());
  /** Adds the record when fewer than 200 actions wait on the device; answers its `seq`, or null when the device is full. */
  const addIfRoom = (record) =>
    device("readwrite", (store) => {
      const out = { seq: null };
      store.getAll().onsuccess = (e) => {
        if (!core.canQueue(e.target.result.filter((r) => r.state === "pending").length)) return;
        store.add(record).onsuccess = (a) => {
          out.seq = a.target.result;
        };
      };
      return out;
    }).then((out) => out.seq);
  const update = (seq, patch) =>
    device("readwrite", (store) => {
      store.get(seq).onsuccess = (e) => {
        if (e.target.result) store.put({ ...e.target.result, ...patch });
      };
    });
  const removeSent = async () => {
    await device("readwrite", (store) => {
      store.getAll().onsuccess = (e) => {
        for (const r of e.target.result) if (r.state === "sent") store.delete(r.seq);
      };
    });
    await photoDevice("readwrite", (store) => {
      store.getAll().onsuccess = (e) => {
        for (const p of e.target.result) if (p.state === "uploaded") store.delete(p.id);
      };
    });
  };

  const allPhotos = () => photoDevice("readonly", (s) => s.getAll());
  /** Adds the photo when fewer than 20 wait on the device; answers its `id`, or null when the device is full. */
  const addPhotoIfRoom = (record) =>
    photoDevice("readwrite", (store) => {
      const out = { id: null };
      store.getAll().onsuccess = (e) => {
        if (!core.canTakePhoto(core.pendingPhotos(e.target.result))) return;
        store.add(record).onsuccess = (a) => {
          out.id = a.target.result;
        };
      };
      return out;
    }).then((out) => out.id);
  const updatePhoto = (id, patch) =>
    photoDevice("readwrite", (store) => {
      store.get(id).onsuccess = (e) => {
        if (e.target.result) store.put({ ...e.target.result, ...patch });
      };
    });
  const removePhoto = (id) => photoDevice("readwrite", (store) => void store.delete(id));
  /** The record put back to `pending` without its refusal (Try again): same `action_id`, same place in the order. */
  const reopen = (store, key) => {
    store.get(key).onsuccess = (e) => {
      const old = e.target.result;
      if (!old) return;
      const next = { ...old, state: "pending", attempts: 0 };
      delete next.refused_reason;
      delete next.refused_message;
      delete next.refused_errors;
      store.put(next);
    };
  };

  // ---- the page ----

  const $ = (sel) => document.querySelector(sel);
  const make = (tag, props, content) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) node.setAttribute(k, v);
    if (content !== undefined) node.textContent = content;
    return node;
  };

  /** "not sent yet", and "saved more than 72 hours ago" when it is. */
  const notSent = (record) => {
    const old = core.isOld(record.performed_at, Date.now());
    return `${text("notSent")}${old ? ` · ${text("old")}` : ""}`;
  };
  /** The mark of one queued action: one per action, the latest for those that replace each other; a part has its own. */
  const mark = (record, tag, content) => {
    const key = record.action === "part" ? `part-${record.seq}` : record.action;
    for (const old of document.querySelectorAll(`[data-offline-key="${key}"]`)) old.remove();
    return make(tag, { "data-offline-seq": String(record.seq), "data-offline-key": key }, content === undefined ? notSent(record) : `${content} · ${notSent(record)}`);
  };
  const form = (action) => document.querySelector(`form[data-offline-effect="${action}"]`);
  const after = (anchor, node) => {
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
  };
  const setStatus = (id, label, cls) => {
    const el = document.getElementById(id);
    if (!el || !label) return;
    el.textContent = label;
    el.className = `status status-${cls}`;
  };
  /** The visit section of a page that had no visit yet (rendered hidden for this): shown once a check-in is queued. */
  const showVisit = () => {
    const section = document.getElementById("visit");
    if (section) section.hidden = false;
  };

  /**
   * The photo forms of a page that was made before the check-in: the server renders them only for an open visit
   * (the check-in page holds no file input), so once a check-in is queued they are made here, the same forms
   * (`pages/me/visits/[id].html`), their words from the status line's data attributes. Does nothing when they are there.
   */
  const ensurePhotoForms = () => {
    if (pageJob === null || document.getElementById("photo-form-before") || document.getElementById("photo-form-after")) return;
    const parts = document.getElementById("parts");
    if (!parts || !parts.parentNode) return;
    const section = make("section", { id: "photos-queued" });
    section.append(make("h2", {}, text("photoTitle")));
    const token = document.querySelector('input[name="_csrf"]');
    for (const phase of PHASES) {
      const f = make("form", { method: "post", action: "?/photo", class: "stack narrow", id: `photo-form-${phase}`, "data-photo-queue": "" });
      if (token) f.append(make("input", { type: "hidden", name: "_csrf", value: token.value }));
      f.append(make("input", { type: "hidden", name: "phase", value: phase }), make("input", { type: "hidden", name: "key", id: `photo-key-${phase}` }));
      const file = make("input", { type: "file", accept: "image/jpeg,image/png,image/webp", capture: "environment", "data-upload-action": `${location.pathname}?/photo_url`, "data-key-field": "key" });
      const label = make("label", {}, `${text("photoFile")} `);
      label.append(file, " ", make("span", { "data-upload-status": "", class: "muted" }));
      const caption = make("label", {}, `${text("photoCaption")} `);
      caption.append(make("input", { name: "caption", maxlength: "200", id: `f-caption-${phase}`, dir: "auto" }));
      const hint = make("small", { class: "muted" }, text("photoHint"));
      const add = make("button", { type: "submit" }, text("photoAdd"));
      for (const node of [label, caption, hint, add]) {
        const line = make("p");
        line.append(node);
        f.append(line);
      }
      section.append(make("h3", { dir: "auto" }, text(phase === "before" ? "photoBefore" : "photoAfter")), f);
    }
    parts.parentNode.insertBefore(section, parts);
  };
  const times = (record, end) => {
    const el = document.getElementById("visit-times");
    if (!el) return;
    if (!el.dataset.hsStart) el.dataset.hsStart = el.textContent.trim().split(" → ")[0];
    const start = el.dataset.hsStart === "" ? core.dubai(record.performed_at) : el.dataset.hsStart;
    el.dataset.hsStart = start;
    el.textContent = end ? `${start} → ${core.dubai(record.performed_at)}` : start;
    el.append(" ", mark({ ...record, action: end ? "checkout-times" : "checkin-times" }, "small"));
  };

  /**
   * The renderers: how the page looks once an action is made but not yet sent. Each one is safe to run again
   * (the page runs them for every waiting action when it loads, since the saved copy it came from is older).
   */
  const effects = {
    checkin(record) {
      const f = form("checkin");
      const section = document.getElementById("checkin");
      if (f) f.hidden = true;
      if (section) {
        for (const p of section.querySelectorAll("p.muted")) p.hidden = true;
        after(section.querySelector("h2"), mark(record, "p", `${text("checkedIn")} ${core.dubai(record.performed_at)}`));
      }
      showVisit();
      ensurePhotoForms();
      times(record, false);
      setStatus("job-status", text("inProgress"), "in_progress");
    },
    part(record) {
      showVisit();
      const f = form("part");
      const section = document.getElementById("parts");
      if (!f || !section) return;
      let list = document.getElementById("offline-parts");
      if (!list) {
        list = make("ul", { id: "offline-parts" });
        f.parentNode.insertBefore(list, f);
      }
      for (const none of section.querySelectorAll(":scope > p.muted")) none.hidden = true;
      const { description = "", qty = "1", price = "0" } = record.fields;
      const li = make("li", { dir: "auto" });
      li.append(`${description} · `, make("bdi", { dir: "ltr" }, `${qty} × ${price}`), " · ", mark(record, "small"));
      list.append(li);
    },
    notes(record) {
      showVisit();
      const f = form("notes");
      if (!f) return;
      const area = f.querySelector("textarea");
      if (area && typeof record.fields.notes === "string") area.value = record.fields.notes;
      f.append(mark(record, "small"));
    },
    summary(record) {
      showVisit();
      const f = form("summary");
      if (!f) return;
      for (const name of ["summary_en", "summary_ar"]) {
        const area = f.querySelector(`[name="${name}"]`);
        if (area && typeof record.fields[name] === "string") area.value = record.fields[name];
      }
      f.append(mark(record, "small"));
    },
    signature(record) {
      showVisit();
      const f = form("signature");
      if (!f) return;
      const name = f.querySelector('[name="signed_by"]');
      if (name && typeof record.fields.signed_by === "string") name.value = record.fields.signed_by;
      f.append(mark(record, "small"));
    },
    checkout(record) {
      showVisit();
      for (const action of ["part", "notes", "signature"]) {
        const f = form(action);
        if (f) f.hidden = true;
      }
      for (const f of document.querySelectorAll("form[data-photo-queue]")) f.hidden = true;
      const f = form("checkout");
      if (f) f.hidden = true;
      const section = document.getElementById("checkout");
      if (section) {
        for (const p of section.querySelectorAll("p.muted")) p.hidden = true;
        after(section.querySelector("h2"), mark(record, "p", `${text("checkedOut")} ${core.dubai(record.performed_at)}`));
      }
      times(record, true);
      setStatus("job-status", text("done"), "done");
    },
  };

  /** Draws the waiting actions of this page's visit again (a page that is older than the queue). */
  const reapply = (records) => {
    for (const record of core.split(records, sessionUser).mine) {
      if (record.job_id === pageJob && effects[record.action]) effects[record.action](record);
    }
  };

  /** Drops the marks of actions that are no longer waiting. */
  const dropMarks = (records) => {
    const waiting = new Set(records.filter((r) => r.state === "pending").map((r) => String(r.seq)));
    for (const node of document.querySelectorAll("[data-offline-seq]")) {
      if (!waiting.has(node.dataset.offlineSeq)) node.remove();
    }
  };

  // ---- the photos on the page ----

  const PHASES = ["before", "after"];
  const byTaken = (a, b) => a.taken_at - b.taken_at || a.id - b.id;

  /** The list that holds the page's waiting photos of a phase, made before that phase's form the first time. */
  const phaseList = (phase) => {
    let list = document.getElementById(`offline-photos-${phase}`);
    if (list) return list;
    const f = document.getElementById(`photo-form-${phase}`);
    if (!f || !f.parentNode) return null;
    list = make("ul", { id: `offline-photos-${phase}`, class: "photos" });
    f.parentNode.insertBefore(list, f);
    return list;
  };

  /** The thumbnail of a kept photo, drawn from the blob (a canvas: the page's CSP has no `blob:` image source). */
  const thumb = (li, photo) => {
    const label = photo.caption || text("photoAlt");
    const canvas = make("canvas", { class: "thumb", role: "img", "aria-label": label, width: "160", height: "1" });
    li.prepend(canvas);
    const fallback = () => {
      if (canvas.parentNode) canvas.replaceWith(make("small", {}, text("photoSaved")));
    };
    if (typeof createImageBitmap !== "function" || !(photo.blob instanceof Blob)) return fallback();
    createImageBitmap(photo.blob)
      .then((bitmap) => {
        const k = Math.min(1, 160 / bitmap.width);
        canvas.width = Math.max(1, Math.round(bitmap.width * k));
        canvas.height = Math.max(1, Math.round(bitmap.height * k));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      })
      .catch(fallback);
  };

  /** One line of the page's photo list: the picture, the caption, "not sent yet" (or why not), and Remove. */
  const photoItem = (photo) => {
    const li = make("li", { "data-offline-photo": String(photo.id) });
    thumb(li, photo);
    li.append(make("small", { "data-offline-caption": "" }), " ", make("small", { "data-offline-mark": "" }), " ", make("button", { type: "button", "data-offline-remove": String(photo.id) }, text("photoRemove")));
    return li;
  };

  /**
   * Makes the page's photo lists show what the device holds for this visit: the user's waiting and refused photos,
   * each in its phase, in the order they were taken; the line of a photo that is gone is removed. Safe to run again.
   */
  const showPhotos = (photos) => {
    if (pageJob === null) return;
    const split = core.splitPhotos(photos, sessionUser);
    const shown = [...split.mine, ...split.refused].filter((p) => p.job_id === pageJob && PHASES.includes(p.phase)).sort(byTaken);
    const ids = new Set(shown.map((p) => String(p.id)));
    for (const li of document.querySelectorAll("[data-offline-photo]")) if (!ids.has(li.dataset.offlinePhoto)) li.remove();
    for (const photo of shown) {
      const list = phaseList(photo.phase);
      if (!list) continue;
      let li = list.querySelector(`[data-offline-photo="${photo.id}"]`) || document.querySelector(`[data-offline-photo="${photo.id}"]`);
      if (!li) li = photoItem(photo);
      const caption = li.querySelector("[data-offline-caption]");
      if (caption && caption.textContent !== photo.caption) caption.textContent = photo.caption;
      const mark = photo.state === "refused" ? text("photoRefused", { reason: photo.refused_message || photo.refused_reason || "" }) : text("notSent");
      const markNode = li.querySelector("[data-offline-mark]");
      if (markNode && markNode.textContent !== mark) markNode.textContent = mark;
      li.dataset.offlinePhotoState = photo.state;
      list.append(li);
    }
    for (const phase of PHASES) {
      const list = document.getElementById(`offline-photos-${phase}`);
      const none = list && list.previousElementSibling;
      if (none && none.matches("p.muted")) none.hidden = list.children.length > 0;
    }
  };

  /** The photo the page still holds for a caption, while it is not older than HOLD_MS; the replay leaves it alone. */
  const heldIds = () => (held !== null && Date.now() < held.until ? [held.id] : []);

  /**
   * Lets go of the held photo: the caption in its form is the photo's (the form is then empty for the next one) and
   * the replay may send it. The caption field belongs to the held photo until then.
   */
  const settleHeld = async () => {
    const was = held;
    held = null;
    if (was === null) return;
    const field = was.form.querySelector('[name="caption"]');
    try {
      await updatePhoto(was.id, { caption: field ? field.value.trim().slice(0, 200) : "" });
    } catch {
      // the photo stays as it was stored.
    }
    if (field) field.value = "";
  };

  /** The status line: what waits, what is being sent, what was refused, what belongs to another account. */
  const view = async () => {
    let records = [];
    let photos = [];
    try {
      records = await all();
    } catch {
      records = [];
    }
    try {
      photos = await allPhotos();
    } catch {
      photos = [];
    }
    photosNow = photos;
    const { mine, other: otherActions, refused } = core.split(records, sessionUser);
    const shots = core.splitPhotos(photos, sessionUser);
    const behind = core.behindRefused(records, sessionUser, photos);
    const blocked = core.blockedJobs(records, sessionUser, photos);
    const behindShots = shots.mine.filter((p) => blocked.has(p.job_id));
    const other = otherActions + shots.other;
    const sendable = mine.length + shots.mine.length - behind.length - behindShots.length;
    hasPending = mine.length > 0 || shots.mine.length > 0 || other > 0;
    const lines = [];
    if (signedOut && mine.length + shots.mine.length > 0) lines.push(text("signIn", { n: mine.length + shots.mine.length }));
    else if (running) lines.push(text("sending"));
    else if (sendable > 0) lines.push(sendable === 1 ? text("waitingOne") : text("waiting", { n: sendable }));
    else if (sentNow > 0) lines.push(text("allSent"));
    const notSentN = refused.length + behind.length + shots.refused.length + behindShots.length;
    const firstRefused = refused[0] || shots.refused[0];
    if (notSentN > 0) lines.push(text("refused", { n: notSentN, reason: (firstRefused && (firstRefused.refused_message || firstRefused.refused_reason)) || "" }));
    if (other > 0) lines.push(text("other", { n: other }));
    const line = lines.join(" ");
    if (status && status.textContent !== line) status.textContent = line;
    dropMarks(records);
    showPhotos(photos);
    drawAttention(records, photos);
    guardSignOut(core.unsent(records, photos, sessionUser));
    return records;
  };

  // ---- "Needs attention" on /me, and the sign-out warning ----

  /** The page's text for a key of the "Needs attention" container (data attributes, in the page's language). */
  const attnText = (key, values) => (attn ? core.fill(attn.dataset[key] || "", values || {}) : "");

  /** Draws the list of what the server refused, when the page has the container; hides it when there is nothing. */
  const drawAttention = (records, photos) => {
    if (!attn || !attnList) return;
    const groups = core.attention(records, photos, sessionUser);
    if (confirming !== null && !groups.some((g) => g.job_id === confirming)) confirming = null;
    const html = core.attentionHtml(groups, attnText, { phone: attn.dataset.phone || "", confirming });
    if (html !== attnDrawn) {
      const here = document.activeElement && attnList.contains(document.activeElement) && document.activeElement.hasAttribute("data-attention") ? document.activeElement : null;
      const focus = here ? `${here.getAttribute("data-attention")}|${here.getAttribute("data-job")}` : "";
      attnList.innerHTML = html;
      attnDrawn = html;
      // A redrawn list keeps the focus where the technician was (or moves it into the question they just opened).
      const ask = confirming !== null ? attnList.querySelector('[data-attention="discard-no"]') : null;
      const again = focus ? [...attnList.querySelectorAll("[data-attention]")].find((n) => `${n.getAttribute("data-attention")}|${n.getAttribute("data-job")}` === focus) : null;
      const target = ask || again;
      if (target) target.focus();
    }
    attn.hidden = groups.length === 0;
  };

  /** Puts /me/signout in the place of the header's link to the account page while something is saved and not sent; puts it back after. */
  const guardSignOut = (count) => {
    for (const a of document.querySelectorAll(`.site-header a[href="${ACCOUNT}"], .site-header a[href="${SIGN_OUT}"]`)) {
      const want = count > 0 ? SIGN_OUT : ACCOUNT;
      if (a.getAttribute("href") !== want) a.setAttribute("href", want);
    }
    if (signoutText) {
      const key = count === 0 ? "none" : count === 1 ? "waitingOne" : "waiting";
      const line = core.fill(signoutText.dataset[key] || "", { n: count });
      if (signoutText.textContent !== line) signoutText.textContent = line;
    }
  };

  /** The records of one job that "Needs attention" lists for the user: refused ones and the ones that wait behind them. */
  const listed = async (job) => {
    const records = await all();
    const photos = await allPhotos();
    const group = core.attention(records, photos, sessionUser).find((g) => g.job_id === job);
    return group ? group.items : [];
  };

  /** Discard: removes the job's listed records from the device. */
  const discardJob = async (job) => {
    const items = await listed(job);
    await device("readwrite", (store) => {
      for (const i of items) if (i.kind === "action") store.delete(i.id);
    });
    await photoDevice("readwrite", (store) => {
      for (const i of items) if (i.kind === "photo") store.delete(i.id);
    });
  };

  /** Try again: the job's refused records go back to `pending` (same `action_id`s) and the queue is run. */
  const retryJob = async (job) => {
    const items = (await listed(job)).filter((i) => i.state === "refused");
    await device("readwrite", (store) => {
      for (const i of items) if (i.kind === "action") reopen(store, i.id);
    });
    await photoDevice("readwrite", (store) => {
      for (const i of items) if (i.kind === "photo") reopen(store, i.id);
    });
  };

  if (attn) {
    attn.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-attention]") : null;
      if (button === null || button.tagName !== "BUTTON") return;
      const job = button.getAttribute("data-job") || "";
      const what = button.getAttribute("data-attention");
      try {
        if (what === "discard") {
          confirming = job;
        } else if (what === "discard-no") {
          confirming = null;
        } else if (what === "discard-yes") {
          confirming = null;
          await discardJob(job);
        } else if (what === "retry") {
          await retryJob(job);
        }
      } catch {
        // the device could not be changed: the list stays as it was.
      }
      await view();
      if (what === "retry") run(true);
    });
  }

  // ---- sending ----

  const cookie = () => {
    const found = document.cookie.split("; ").find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    return found ? found.slice(CSRF_COOKIE.length + 1) : "";
  };
  /**
   * The token the cell checks for a page action. It is the double-submit cookie the platform sets and leaves
   * readable to the page's script for this (docs/contracts/ops.md section 14), so it is always the current
   * session's, never one saved with a page. A phone that lost the cookie asks a page of the app for a new one.
   */
  const csrfToken = async (renew) => {
    let token = renew ? "" : cookie();
    if (token === "") {
      try {
        await fetch("/me", { cache: "no-store", credentials: "same-origin", redirect: "manual", headers: { accept: "text/html" } });
      } catch {
        return "";
      }
      token = cookie();
    }
    return token;
  };

  /**
   * One POST of the action; `{ status, body }`, or null when there is no answer. 303/401 to the login page is a 401.
   * `queued` marks a replay of a saved action (`x-hs-queued: 1`): a conflict the server answers to it tells the office.
   */
  const post = async (record, token, queued) => {
    const body = new URLSearchParams(record.fields);
    body.set("action_id", record.action_id);
    body.set("performed_at", String(record.performed_at));
    body.set("_csrf", token);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20000);
    try {
      const res = await fetch(`${record.url}?/${record.action}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": token, ...(queued ? { "x-hs-queued": "1" } : {}) },
        body: body.toString(),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal: stop.signal,
      });
      if (res.type === "opaqueredirect") return { status: 401, body: null };
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, body: json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Replays one saved record; a 403 is tried once more with a renewed token (a lost cookie is not a signed-out user). */
  const send = async (record) => {
    let answer = await post(record, await csrfToken(false), true);
    if (answer !== null && answer.status === 403) answer = await post(record, await csrfToken(true), true);
    return answer;
  };

  /** One JSON answer of a request that is not the action's own (the page action `photo_url`, the signed PUT): `{ status, body }` or null. */
  const exchange = async (url, init, ms) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      const res = await fetch(url, { ...init, signal: stop.signal });
      if (res.type === "opaqueredirect") return { status: 401, body: null };
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, body: json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const EXTENSION = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

  /** The three requests of a photo (core.sendPhoto): the signed URL, the PUT of the blob, the `photo` action. */
  const photoIo = {
    signed: async (photo) => {
      const ask = async (token) =>
        exchange(
          `/me/visits/${photo.job_id}?/photo_url`,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": token },
            body: new URLSearchParams({ name: `photo-${photo.phase}.${EXTENSION[photo.type] || "jpg"}`, type: photo.type, size: String(photo.size), action_id: photo.action_id, _csrf: token }).toString(),
            credentials: "same-origin",
            cache: "no-store",
            redirect: "manual",
          },
          20000,
        );
      let answer = await ask(await csrfToken(false));
      if (answer !== null && answer.status === 403) answer = await ask(await csrfToken(true));
      // A 403 that stays says either "sign in again" or that the job is no longer this technician's: the ping tells which.
      if (answer !== null && answer.status === 403) answer.signedIn = (await me.ping()).state === "online";
      return answer;
    },
    put: (photo, url) => exchange(url, { method: "PUT", headers: { "content-type": photo.type }, body: photo.blob }, 90000),
    post: (photo, key) => send({ url: `/me/visits/${photo.job_id}`, action: "photo", action_id: photo.action_id, performed_at: photo.taken_at, fields: { phase: photo.phase, key, caption: photo.caption } }),
  };

  /** The replay: strictly in order, one action or photo at a time (the rules are core.nextItem, core.outcomeOf, core.settle and the photo versions). */
  const replay = async () => {
    const answer = await me.ping();
    if (answer.state === "offline") return;
    if (answer.state === "out") {
      signedOut = true;
      return;
    }
    signedOut = false;
    if (answer.user) sessionUser = answer.user;
    running = true;
    await view();
    const sentJobs = new Set();
    const skip = [];
    let sent = 0;
    try {
      for (;;) {
        const item = core.nextItem(await all(), await allPhotos(), sessionUser, skip, heldIds());
        if (item === null) break;
        const record = item.record;
        if (item.kind === "photo") {
          if (!(record.blob instanceof Blob) || !PHASES.includes(record.phase)) {
            await updatePhoto(record.id, { state: "refused", refused_reason: "invalid_record" });
            skip.push(record.job_id);
            continue;
          }
          const result = await core.sendPhoto(record, photoIo);
          const settled = core.settlePhoto(record, result);
          if (Object.keys(settled.patch).length > 0) await updatePhoto(record.id, settled.patch);
          if (result.kind === "ok") {
            sent += 1;
            sentJobs.add(record.job_id);
          }
          if (result.kind === "auth") signedOut = true;
          if (result.kind === "retry") retryAfter = core.retryAt(Date.now(), { attempts: settled.patch.attempts });
          if (settled.stop === "all") break;
          if (settled.stop === "job") skip.push(record.job_id);
          continue;
        }
        if (core.targetOf(record) === null) {
          await update(record.seq, { state: "refused", refused_reason: "invalid_record" });
          skip.push(record.job_id);
          continue;
        }
        const outcome = core.outcomeOf(await send(record));
        const { patch, stop } = core.settle(record, outcome);
        if (Object.keys(patch).length > 0) await update(record.seq, patch);
        if (outcome.kind === "ok") {
          sent += 1;
          sentJobs.add(record.job_id);
        }
        if (outcome.kind === "auth") signedOut = true;
        if (outcome.kind === "retry") retryAfter = core.retryAt(Date.now(), { attempts: patch.attempts });
        if (stop === "all") break;
        if (stop === "job") skip.push(record.job_id);
      }
    } catch {
      // The device could not be read or written: nothing is lost, the next try starts again.
    } finally {
      running = false;
    }
    if (sent > 0) {
      retryAfter = 0;
      sentNow += sent;
      sessionStorage.setItem("hs-queue-sent", String(sentNow));
    }
    try {
      await removeSent();
    } catch {
      // `sent` records are removed at the next load.
    }
    const records = await view();
    if (sentJobs.size > 0 && reflect(records, sentJobs)) location.reload();
  };

  /**
   * Whether the page should be loaded again to show what the server now has: it shows a visit that just got
   * actions, nothing of it waits any more, and the technician is not in the middle of typing.
   */
  const reflect = (records, sentJobs) => {
    const mine = core.split(records, sessionUser).mine;
    const typing = document.activeElement && document.activeElement.matches("input, textarea") && document.activeElement.value !== document.activeElement.defaultValue;
    const photos = core.splitPhotos(photosNow, sessionUser).mine;
    if (typing || mine.some((r) => r.job_id === pageJob) || photos.some((p) => p.job_id === pageJob)) return false;
    return pageJob !== null ? sentJobs.has(pageJob) : true;
  };

  /** One run of the replay under a lock, so two tabs never send at once (a double send would be harmless but wasteful). */
  const run = async (force) => {
    if (running || (!force && Date.now() < retryAfter)) return;
    const work = async () => {
      if (force) retryAfter = 0;
      await replay();
      await view();
    };
    try {
      if (navigator.locks) await navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? work() : undefined));
      else await work();
    } catch {
      running = false;
    }
    await view();
  };

  // ---- making an action ----

  /** The visit and the action a form posts to, when the queue takes it (a visit page of this origin, one of its actions). */
  const formTarget = (f) => {
    const url = new URL(f.action, location.href);
    const m = /^\?\/(\w+)$/u.exec(url.search);
    if (m === null || url.origin !== location.origin) return null;
    const target = core.targetOf({ url: url.pathname, action: m[1], action_id: "x".repeat(16) });
    return target === null ? null : { url: url.pathname, action: target.action, job_id: target.job_id };
  };

  /** The form's text fields, never a file, never the token. */
  const collect = (f) => {
    const fields = {};
    for (const [k, v] of new FormData(f)) {
      if (typeof v === "string" && k !== "_csrf" && k !== "action_id" && k !== "performed_at") fields[k] = v;
    }
    return fields;
  };

  const hidden = (f, name, value) => {
    let input = f.querySelector(`input[type="hidden"][name="${name}"]`);
    if (!input) {
      input = make("input", { type: "hidden", name });
      f.append(input);
    }
    input.value = value;
  };
  /** The form's `action_id`: one for each attempt, so a double tap posts the same one. */
  const idOf = (f) => {
    const input = f.querySelector('input[type="hidden"][name="action_id"]');
    return input && /^[A-Za-z0-9_-]{16,64}$/u.test(input.value) ? input.value : core.actionIdOf(crypto.randomUUID());
  };

  const say = (f, key, values) => {
    for (const old of f.querySelectorAll("[data-offline-error]")) old.remove();
    if (key) f.append(make("p", { role: "alert", "data-offline-error": "" }, text(key, values)));
  };

  /** Posts the form as the page always did, with its `action_id`: the server's page (errors, a conflict) is what shows. */
  const nativePost = (f, id, performed) => {
    hidden(f, "action_id", id);
    hidden(f, "performed_at", String(performed));
    f.submit();
  };

  const queue = async (f, target, fields, id, performed) => {
    const record = { action_id: id, user_id: pageUser, job_id: target.job_id, url: target.url, action: target.action, fields, performed_at: performed, state: "pending", attempts: 0, ...jobLabel };
    let seq;
    try {
      if (pageUser === "") throw new Error("no user");
      seq = await addIfRoom(record);
    } catch {
      return say(f, "noStorage");
    }
    if (seq === null) return say(f, "tooMany");
    say(f, null);
    record.seq = seq;
    // A photo the technician has not captioned yet goes first: it was taken before this action.
    await settleHeld();
    effects[target.action](record);
    // The next tap is another action: a new id, and the part form starts empty again.
    const input = f.querySelector('input[type="hidden"][name="action_id"]');
    if (input) input.remove();
    if (target.action === "part") {
      f.querySelector('[name="description"]').value = "";
      f.querySelector('[name="qty"]').value = "1";
      f.querySelector('[name="price"]').value = "0";
    }
    await view();
  };

  // ---- taking a photo ----

  /**
   * The image as it is sent (also online, to save data): its long side at most core.MAX_SIDE px, a JPEG of
   * core.JPEG_QUALITY, drawn on a canvas from a bitmap (`createImageBitmap`, not an <img> of a blob: URL, which the
   * page's CSP does not allow). An image already that small, or one the browser cannot decode, is kept as it is.
   * Answers `{ blob, name, type, size }`.
   */
  const prepare = async (file) => {
    const original = { blob: file, name: file.name, type: file.type, size: file.size };
    if (typeof createImageBitmap !== "function") return original;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      return original;
    }
    try {
      const fit = core.fitSize(bitmap.width, bitmap.height);
      if (!fit.resize) return original;
      const canvas = document.createElement("canvas");
      canvas.width = fit.width;
      canvas.height = fit.height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return original;
      // A transparent PNG becomes a JPEG: its background is white, not black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, fit.width, fit.height);
      ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", core.JPEG_QUALITY));
      if (blob === null) return original;
      return { blob, name: `${file.name.replace(/\.[^.]*$/u, "") || "photo"}.jpg`, type: "image/jpeg", size: blob.size };
    } catch {
      return original;
    } finally {
      bitmap.close();
    }
  };

  /** Asks the browser once to keep this origin's storage (a photo that is not sent yet must not be cleared); never waits for it. */
  const keepStorage = () => {
    if (persistAsked || !navigator.storage || typeof navigator.storage.persist !== "function") return;
    persistAsked = true;
    const persisted = typeof navigator.storage.persisted === "function" ? navigator.storage.persisted() : Promise.resolve(false);
    persisted.then((yes) => (yes ? undefined : navigator.storage.persist())).catch(() => {});
  };

  /** Keeps the prepared image on the device and lists it on the page; says why when it cannot. */
  const keepPhoto = async (f, input, image) => {
    if (pageUser === "" || pageJob === null) return say(f, "noStorage");
    try {
      const estimate = navigator.storage && typeof navigator.storage.estimate === "function" ? await navigator.storage.estimate() : null;
      if (!core.hasRoom(estimate)) return say(f, "photoNoRoom");
    } catch {
      // a browser that cannot say is taken to have room.
    }
    const phase = f.querySelector('[name="phase"]');
    const caption = f.querySelector('[name="caption"]');
    const record = {
      user_id: pageUser,
      job_id: pageJob,
      phase: phase ? phase.value : "",
      caption: caption ? caption.value.trim().slice(0, 200) : "",
      blob: image.blob,
      type: image.type,
      size: image.size,
      taken_at: Date.now(),
      action_id: core.actionIdOf(crypto.randomUUID()),
      state: "pending",
      attempts: 0,
      ...jobLabel,
    };
    let id;
    try {
      id = await addPhotoIfRoom(record);
    } catch {
      return say(f, "noStorage");
    }
    if (id === null) return say(f, "photoLimit");
    keepStorage();
    say(f, null);
    // The photo waits for its caption until "Add a photo", the next photo or the next action.
    held = { id, form: f, until: Date.now() + HOLD_MS };
    input.value = "";
    const status = f.querySelector("[data-upload-status]");
    if (status) status.textContent = "";
    await view();
  };

  /** The choices in the order they were made: one photo is prepared and kept (or sent) before the next one starts. */
  let choosing = Promise.resolve();

  /** One chosen file of a photo form: prepared; kept on the phone, or sent now by public/upload.js. */
  const choose = async (input, f, file) => {
    await settleHeld();
    say(f, null);
    const key = f.querySelector('[name="key"]');
    if (key) key.value = "";
    const image = await prepare(file);
    if (core.tooLarge(image.size)) {
      input.value = "";
      return say(f, "photoTooLarge", { max: core.MAX_PHOTO_BYTES, size: image.size });
    }
    // With a signal and nothing of the job waiting, the photo goes now; an action or photo of the job that still
    // waits on the device goes first, so the photo is kept to follow it.
    const answer = await me.ping();
    const behind = pageUser !== "" && ((await all()).some((r) => r.state === "pending" && r.user_id === pageUser && r.job_id === pageJob) || core.splitPhotos(await allPhotos(), pageUser).mine.some((p) => p.job_id === pageJob));
    if (answer.state !== "offline" && !behind && window.hsUpload) {
      if ((await window.hsUpload.send(input, image)) !== "network") return;
    }
    await keepPhoto(f, input, image);
  };

  /**
   * The photo input's change: with no signal, or while an action of the job still waits on the device, the
   * image is kept on the phone; else public/upload.js sends it (and a network failure keeps it too).
   */
  const onChoose = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    const f = input.form;
    const file = input.files && input.files[0];
    if (!f || !f.hasAttribute("data-photo-queue") || !file) return;
    choosing = choosing.then(() => choose(input, f, file)).catch(() => say(f, "noStorage"));
  };

  /** "Add a photo" with a photo chosen on this page: its caption is saved and it may go; online with no photo chosen, the form posts as it always did. */
  const onPhotoSubmit = async (event, f) => {
    if (held !== null && held.form === f) {
      event.preventDefault();
      await settleHeld();
      await view();
      run(true);
      return;
    }
    // No signal and nothing chosen: a post would only show the browser's error page.
    const chosen = f.querySelector('[name="key"]');
    if (!navigator.onLine && chosen && chosen.value === "") {
      event.preventDefault();
      say(f, "photoChoose");
    }
  };

  document.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-offline-remove]") : null;
    if (button === null) return;
    const id = Number(button.dataset.offlineRemove);
    if (held !== null && held.id === id) held = null;
    try {
      await removePhoto(id);
    } catch {
      // it stays on the list.
    }
    await view();
  });
  document.addEventListener("change", onChoose);

  const onSubmit = async (event) => {
    const f = event.target;
    if (f instanceof HTMLFormElement && f.hasAttribute("data-photo-queue") && !event.defaultPrevented) return onPhotoSubmit(event, f);
    if (!(f instanceof HTMLFormElement) || !f.hasAttribute("data-offline-action") || event.defaultPrevented) return;
    const target = formTarget(f);
    if (target === null || !effects[target.action]) return;
    event.preventDefault();
    if (f.dataset.hsBusy === "1") return;
    f.dataset.hsBusy = "1";
    try {
      // The values are read after the page's own submit handlers (visit.js writes the signature) have run.
      const performed = Date.now();
      const fields = collect(f);
      const id = idOf(f);
      const answer = await me.ping();
      if (answer.state === "offline") return await queue(f, target, fields, id, performed);
      if (answer.state === "out") return nativePost(f, id, performed);
      const token = await csrfToken(false);
      const sent = await post({ url: target.url, action: target.action, action_id: id, performed_at: performed, fields }, token);
      if (sent === null) return await queue(f, target, fields, id, performed);
      if (sent.status === 200 && sent.body && sent.body.ok === true && typeof sent.body.redirect === "string" && sent.body.redirect.startsWith("/me/")) {
        location.assign(sent.body.redirect);
        return;
      }
      nativePost(f, id, performed);
    } finally {
      delete f.dataset.hsBusy;
    }
  };

  // ---- start ----

  const start = async () => {
    try {
      await removeSent();
    } catch {
      // nothing to clean, or the device cannot be used: the forms say so when they are used.
    }
    const records = await view();
    reapply(records);
    if (hasPending) run(true);
    else if (sentNow > 0) sessionStorage.removeItem("hs-queue-sent");
  };

  // public/upload.js leaves the photo forms to this script, which calls its `hsUpload.send` for an upload now.
  window.hsQueue = { photos: true };
  document.addEventListener("submit", onSubmit);
  window.addEventListener("online", () => run(true));
  setInterval(() => {
    if (hasPending) run(false);
  }, core.POLL_MS);
  start();
})();

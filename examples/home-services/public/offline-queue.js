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
// What stays on the device: the records of `actions` (never a CSRF token, never a file) until the server has
// answered; a refused record stays until the office page of #810 deals with it. Nothing else but the flag
// `hs-queue-sent` in sessionStorage (a count, so "All sent" survives the reload that shows the server's page).
(() => {
  const core = window.hsQueueCore;
  const me = window.hsMe;
  if (!core || !me || !("indexedDB" in window)) return;

  const status = document.getElementById("queue-status");
  const text = (key, values) => core.fill((status && status.dataset[key]) || "", values || {});
  const meta = document.querySelector('meta[name="hs-user"]');
  const pageUser = meta ? meta.content : "";
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

  // ---- the device: IndexedDB `hs-offline` / `actions` ----

  /** One transaction on `actions`; `work(store)` returns what to resolve with (a request's result is read when it completes). */
  const device = async (mode, work) => {
    const db = await me.openDb();
    if (db === null) throw new Error("no storage");
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction("actions", mode);
      tx.oncomplete = () => {
        db.close();
        resolve(result instanceof IDBRequest ? result.result : result);
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("storage failed"));
      };
      result = work(tx.objectStore("actions"));
    });
  };
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
  const removeSent = () =>
    device("readwrite", (store) => {
      store.getAll().onsuccess = (e) => {
        for (const r of e.target.result) if (r.state === "sent") store.delete(r.seq);
      };
    });

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

  /** The status line: what waits, what is being sent, what was refused, what belongs to another account. */
  const view = async () => {
    let records = [];
    try {
      records = await all();
    } catch {
      records = [];
    }
    const { mine, other, refused } = core.split(records, sessionUser);
    const behind = core.behindRefused(records, sessionUser);
    const sendable = mine.length - behind.length;
    hasPending = mine.length > 0 || other > 0;
    const lines = [];
    if (signedOut && mine.length > 0) lines.push(text("signIn", { n: mine.length }));
    else if (running) lines.push(text("sending"));
    else if (sendable > 0) lines.push(sendable === 1 ? text("waitingOne") : text("waiting", { n: sendable }));
    else if (sentNow > 0) lines.push(text("allSent"));
    const notSentN = refused.length + behind.length;
    if (notSentN > 0) lines.push(text("refused", { n: notSentN, reason: (refused[0] && (refused[0].refused_message || refused[0].refused_reason)) || "" }));
    if (other > 0) lines.push(text("other", { n: other }));
    const line = lines.join(" ");
    if (status && status.textContent !== line) status.textContent = line;
    dropMarks(records);
    return records;
  };

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

  /** One POST of the action; `{ status, body }`, or null when there is no answer. 303/401 to the login page is a 401. */
  const post = async (record, token) => {
    const body = new URLSearchParams(record.fields);
    body.set("action_id", record.action_id);
    body.set("performed_at", String(record.performed_at));
    body.set("_csrf", token);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20000);
    try {
      const res = await fetch(`${record.url}?/${record.action}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": token },
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

  /** Sends one record; a 403 is tried once more with a renewed token (a lost cookie is not a signed-out user). */
  const send = async (record) => {
    let answer = await post(record, await csrfToken(false));
    if (answer !== null && answer.status === 403) answer = await post(record, await csrfToken(true));
    return answer;
  };

  /** The replay: strictly in `seq` order, one action at a time (the rules are core.nextAction, core.outcomeOf, core.settle). */
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
        const record = core.nextAction(await all(), sessionUser, skip);
        if (record === null) break;
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
    if (typing || mine.some((r) => r.job_id === pageJob)) return false;
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

  const say = (f, key) => {
    for (const old of f.querySelectorAll("[data-offline-error]")) old.remove();
    if (key) f.append(make("p", { role: "alert", "data-offline-error": "" }, text(key)));
  };

  /** Posts the form as the page always did, with its `action_id`: the server's page (errors, a conflict) is what shows. */
  const nativePost = (f, id, performed) => {
    hidden(f, "action_id", id);
    hidden(f, "performed_at", String(performed));
    f.submit();
  };

  const queue = async (f, target, fields, id, performed) => {
    const record = { action_id: id, user_id: pageUser, job_id: target.job_id, url: target.url, action: target.action, fields, performed_at: performed, state: "pending", attempts: 0 };
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

  const onSubmit = async (event) => {
    const f = event.target;
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

  document.addEventListener("submit", onSubmit);
  window.addEventListener("online", () => run(true));
  setInterval(() => {
    if (hasPending) run(false);
  }, core.POLL_MS);
  start();
})();

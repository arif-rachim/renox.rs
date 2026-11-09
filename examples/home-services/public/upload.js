// Large files for a page (the storage module, #581): a file input sends the file
// straight to the app's store with a signed PUT, so the 1 MiB limit of a page
// action does not apply. No framework, no inline script (the CSP allows a script
// served from /public).
//
//   <input type="file" data-upload-action="/me/visits/42?/photo_url" data-key-field="photo_key">
//   <input type="hidden" name="photo_key">
//   <span data-upload-status></span>
//
// On change: POST the page action (name, type, size and the page's CSRF token),
// which answers { url, max_bytes } (it calls storage.uploadUrl); PUT the file to
// the url; on 201 write the stored key into the input named by data-key-field
// (looked up in the file input's form) and show the file name in the
// [data-upload-status] next to the input. Any failure shows the JSON "message"
// there and leaves the key empty, so the form cannot post a file that is not
// stored. The listener is on the document, so a form that htmx swaps in works too.
(() => {
  const csrfOf = (input) => {
    const field = (input.form && input.form.querySelector('input[name="_csrf"]')) || document.querySelector('input[name="_csrf"]');
    return field ? field.value : "";
  };
  const statusOf = (input) => {
    const near = input.closest("label, p, div, fieldset") || input.parentElement;
    return (near && near.querySelector("[data-upload-status]")) || (input.form || document).querySelector("[data-upload-status]");
  };
  const messageOf = async (res) => {
    try {
      const body = await res.json();
      if (body && typeof body.message === "string") return body.message;
    } catch (e) {
      /* not JSON */
    }
    return "The upload failed (" + res.status + ").";
  };

  const send = async (input) => {
    const status = statusOf(input);
    const say = (text) => {
      if (status) status.textContent = text;
    };
    const field = (input.form || document).querySelector('[name="' + input.dataset.keyField + '"]');
    if (field) field.value = "";
    const file = input.files && input.files[0];
    if (!file || !field) return say("");
    say(file.name + " ...");
    try {
      const token = csrfOf(input);
      const signed = await fetch(input.dataset.uploadAction, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": token },
        body: new URLSearchParams({ name: file.name, type: file.type, size: String(file.size), _csrf: token }).toString(),
        credentials: "same-origin",
      });
      if (!signed.ok) return say(await messageOf(signed));
      const target = await signed.json();
      const put = await fetch(target.url, { method: "PUT", headers: { "content-type": file.type }, body: file });
      if (put.status !== 201) return say(await messageOf(put));
      const stored = await put.json();
      field.value = stored.key;
      say(file.name);
    } catch (e) {
      say(e && e.message ? e.message : "The upload failed.");
    }
  };

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === "file" && input.dataset.uploadAction && input.dataset.keyField) void send(input);
  });
})();

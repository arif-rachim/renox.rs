// The technician's visit page (pages/me/visits/[id].html), a file of its own (#728): cacheable, loaded with
// `defer` and only when the page has the check-in form or the signature canvas.
(() => {
  // The browser's position at check-in, when it is shared: two hidden fields, optional.
  const lat = document.getElementById("checkin-lat");
  const lng = document.getElementById("checkin-lng");
  if (lat && lng && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((p) => {
      lat.value = String(p.coords.latitude);
      lng.value = String(p.coords.longitude);
    }, () => {}, { timeout: 8000, maximumAge: 60000 });
  }
  // The signature: drawn on a canvas, posted as a PNG data URL kept in a hidden field after every stroke.
  const canvas = document.getElementById("sig-canvas");
  const data = document.getElementById("sig-data");
  if (!canvas || !data) return;
  const g = canvas.getContext("2d");
  g.lineWidth = 2.5;
  g.lineCap = "round";
  g.strokeStyle = "#111";
  let drawing = false;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 0.1, y + 0.1);
    g.stroke();
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = at(e);
    g.lineTo(x, y);
    g.stroke();
    e.preventDefault();
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    data.value = canvas.toDataURL("image/png");
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  // Without a pointer (keyboard, screen reader): "Type the customer's name
  // instead" writes the typed name onto the canvas as the signature image
  // when the form is sent, so the same signature step is satisfied.
  const typed = document.getElementById("sig-typed");
  const form = document.getElementById("signature-form");
  const nameField = form ? form.querySelector('[name="signed_by"]') : null;
  document.addEventListener("submit", (e) => {
    if (e.target !== form || !typed || !typed.checked || !nameField || nameField.value.trim() === "") return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#111";
    g.font = 'italic 44px "Segoe Script", "Brush Script MT", cursive, serif';
    g.textBaseline = "middle";
    g.fillText(nameField.value.trim(), 16, canvas.height / 2, canvas.width - 32);
    data.value = canvas.toDataURL("image/png");
  }, true);
  document.getElementById("sig-clear")?.addEventListener("click", () => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    data.value = "";
  });
})();

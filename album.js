(() => {
  const $ = (id) => document.getElementById(id);
  const API = "/api/album";
  let photos = [];   // newest first
  let locked = false;
  let current = -1;

  // ---- tiny storage helpers (never crash if storage is blocked) ----
  const store = {
    get: (s, k) => { try { return window[s].getItem(k) || ""; } catch { return ""; } },
    set: (s, k, v) => { try { window[s].setItem(k, v); } catch {} },
    del: (s, k) => { try { window[s].removeItem(k); } catch {} },
  };

  function status(msg) { $("album-status").textContent = msg || ""; }

  async function getPasscode() {
    if (!locked) return "";
    let p = store.get("sessionStorage", "album_pass");
    if (!p) {
      p = prompt("Enter your album passcode:") || "";
      store.set("sessionStorage", "album_pass", p);
    }
    return p;
  }

  // ---- load + render ----
  async function load() {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (!r.ok) throw new Error("no api");
      const d = await r.json();
      locked = d.locked;
      photos = d.photos.slice().reverse();
      $("album-form").classList.remove("hidden");
      render();
    } catch {
      $("album-form").classList.add("hidden");
      status("The shared album needs the Python server running (python app.py).");
    }
  }

  function render() {
    const grid = $("album-grid");
    grid.textContent = "";
    if (!photos.length) {
      const p = document.createElement("p");
      p.className = "album-empty";
      p.textContent = "No photos yet. Add the first memory you two share!";
      grid.appendChild(p);
      return;
    }
    photos.forEach((ph, i) => {
      const b = document.createElement("button");
      b.className = "album-item";
      b.type = "button";
      const img = document.createElement("img");
      img.src = ph.file;
      img.loading = "lazy";
      img.alt = ph.caption || "Our photo";
      b.appendChild(img);
      if (ph.caption) {
        const c = document.createElement("div");
        c.className = "cap";
        c.textContent = ph.caption;
        b.appendChild(c);
      }
      b.addEventListener("click", () => openBox(i));
      grid.appendChild(b);
    });
  }

  // ---- resize big phone photos before upload ----
  async function prepare(file) {
    if (file.type === "image/gif" || !file.type.startsWith("image/")) {
      return { blob: file, name: file.name };
    }
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
      if (blob && blob.size < file.size) {
        return { blob, name: file.name.replace(/\.\w+$/, "") + ".jpg" };
      }
    } catch {}
    return { blob: file, name: file.name };
  }

  // ---- upload ----
  async function upload(e) {
    e.preventDefault();
    const files = Array.from($("al-files").files);
    if (!files.length) { status("Choose at least one photo first."); return; }

    const author = $("al-author").value.trim();
    const caption = $("al-caption").value.trim();
    store.set("localStorage", "album_author", author);
    const pass = await getPasscode();

    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      status(`Adding photo ${i + 1} of ${files.length}...`);
      const { blob, name } = await prepare(files[i]);
      try {
        const r = await fetch(API, {
          method: "POST",
          headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(name),
            "X-Caption": encodeURIComponent(caption),
            "X-Author": encodeURIComponent(author),
            "X-Passcode": pass,
          },
          body: blob,
        });
        if (r.status === 403) {
          store.del("sessionStorage", "album_pass");
          status("Wrong passcode. Try again.");
          return;
        }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          status(`Couldn't add ${files[i].name}: ${err.error || "upload failed"}`);
          continue;
        }
        ok++;
      } catch {
        status("Upload failed. Is the server still running?");
        return;
      }
    }
    $("al-files").value = "";
    $("al-caption").value = "";
    await load();
    status(ok ? `Added ${ok} photo${ok > 1 ? "s" : ""} ❤` : "");
  }

  // ---- lightbox ----
  function openBox(i) {
    current = i;
    const ph = photos[i];
    $("lb-img").src = ph.file;
    $("lb-cap").textContent = ph.caption || "";
    const when = new Date(ph.added).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    });
    $("lb-meta").textContent = (ph.author ? "Added by " + ph.author + " · " : "") + when;
    $("lightbox").classList.remove("hidden");
  }
  function closeBox() { $("lightbox").classList.add("hidden"); current = -1; }
  function step(d) {
    if (current < 0 || !photos.length) return;
    openBox((current + d + photos.length) % photos.length);
  }

  async function remove() {
    if (current < 0) return;
    if (!confirm("Delete this photo from the album?")) return;
    const pass = await getPasscode();
    const r = await fetch(API + "/" + photos[current].id, {
      method: "DELETE",
      headers: { "X-Passcode": pass },
    });
    if (r.status === 403) {
      store.del("sessionStorage", "album_pass");
      alert("Wrong passcode.");
      return;
    }
    closeBox();
    await load();
  }

  // ---- wire up ----
  $("al-author").value = store.get("localStorage", "album_author");
  $("al-files").addEventListener("change", () => {
    const n = $("al-files").files.length;
    status(n ? `${n} photo${n > 1 ? "s" : ""} selected. Press "Add to album".` : "");
  });
  $("album-form").addEventListener("submit", upload);
  $("lb-close").addEventListener("click", closeBox);
  $("lb-prev").addEventListener("click", () => step(-1));
  $("lb-next").addEventListener("click", () => step(1));
  $("lb-del").addEventListener("click", remove);
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeBox(); });
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeBox();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  load();
})();
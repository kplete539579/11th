(() => {
  const $ = (id) => document.getElementById(id);
  const API = "/api/moments";
  const MAX_VIDEO = 300 * 1024 * 1024;

  let staticMoments = [];  // from content.json
  let uploaded = [];       // added through the website
  let locked = false;

  const store = {
    get: (s, k) => { try { return window[s].getItem(k) || ""; } catch { return ""; } },
    set: (s, k, v) => { try { window[s].setItem(k, v); } catch {} },
    del: (s, k) => { try { window[s].removeItem(k); } catch {} },
  };

  const status = (msg) => { $("mo-status").textContent = msg || ""; };

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => e.isIntersecting && e.target.classList.add("show"));
  }, { threshold: 0.15 });

  function fmt(d) {
    const dt = new Date((d || "") + "T00:00:00");
    if (isNaN(dt)) return d || "";
    return dt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  async function getPasscode() {
    if (!locked) return "";
    let p = store.get("sessionStorage", "album_pass");
    if (!p) {
      p = prompt("Enter your passcode:") || "";
      store.set("sessionStorage", "album_pass", p);
    }
    return p;
  }

  // ---------- video cards: video on top, caption below ----------
  function card(m) {
  const src = m.file || m.video || m.photo;
  const isVideo = m.type === "video" || !!m.video || /\.(mp4|webm|mov|m4v)$/i.test(src || "");
  // caption: new "caption" field, or fall back to older text/title
  const caption = m.caption || m.text || m.title || "";

    const el = document.createElement("div");
    el.className = "moment";

    let media;
    if (isVideo) {
      media = document.createElement("video");
      media.src = src;
      media.controls = true;
      media.preload = "metadata";
      media.playsInline = true;
      if (m.poster) media.poster = m.poster;
    } else {
      media = document.createElement("img");
      media.src = src;
      media.alt = caption || "Our moment";
      media.loading = "lazy";
      media.onerror = () => { media.style.display = "none"; };
    }

    const body = document.createElement("div");
    body.className = "body";
    if (caption) {
      const c = document.createElement("p");
      c.className = "caption";
      c.textContent = caption;
      body.appendChild(c);
    }
    const bits = [];
    if (m.date) bits.push(fmt(m.date));
    if (m.author) bits.push("added by " + m.author);
    if (bits.length) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = bits.join(" · ");
      body.appendChild(meta);
    }

    el.append(media, body);

    if (m.id) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "mo-del";
      x.title = "Delete this video";
      x.textContent = "×";
      x.addEventListener("click", () => removeMoment(m.id));
      el.appendChild(x);
    }
    return el;
  }

  function render() {
    const all = staticMoments.concat(uploaded)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const tl = $("timeline");
    tl.textContent = "";
    all.forEach((m) => tl.appendChild(card(m)));
    tl.querySelectorAll(".moment").forEach((el) => io.observe(el));
  }

  // called by script.js with the moments from content.json
  window.renderMoments = (list) => {
    staticMoments = list || [];
    render();
  };

  // ---------- load uploaded videos ----------
  async function load() {
    try {
      const r = await fetch(API, { cache: "no-store" });
      if (!r.ok) throw new Error("no api");
      const d = await r.json();
      locked = d.locked;
      uploaded = d.moments || [];
      $("moment-form").classList.remove("hidden");
      render();
    } catch {
      $("moment-form").classList.add("hidden");
      status("Adding videos needs the Python server running (python app.py).");
    }
  }

  // ---------- upload ----------
  // XMLHttpRequest (not fetch) so we can show upload progress for big videos
  function send(blob, headers, onProgress) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open("POST", API);
      Object.keys(headers).forEach((k) => x.setRequestHeader(k, headers[k]));
      x.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      x.onload = () => {
        let body = {};
        try { body = JSON.parse(x.responseText); } catch {}
        resolve({ status: x.status, body });
      };
      x.onerror = () => resolve({ status: 0, body: {} });
      x.send(blob);
    });
  }

  async function submit(e) {
    e.preventDefault();
    const file = $("mo-file").files[0];
    if (!file) { status("Choose a video first."); return; }

    const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
    if (!isVideo) { status("Please choose a video file (MP4, WEBM or MOV)."); return; }
    if (file.size > MAX_VIDEO) {
      status("That video is too big (max 300 MB). Try a shorter clip.");
      return;
    }

    const author = $("mo-author").value.trim();
    store.set("localStorage", "album_author", author);
    const pass = await getPasscode();

    const headers = {
      "Content-Type": file.type || "video/mp4",
      "X-Filename": encodeURIComponent(file.name),
      "X-Caption": encodeURIComponent($("mo-caption").value.trim()),
      "X-Date": new Date().toLocaleDateString("en-CA"), // today as YYYY-MM-DD
      "X-Author": encodeURIComponent(author),
      "X-Passcode": pass,
    };

    $("mo-submit").disabled = true;
    status("Uploading video... 0%");
    const r = await send(file, headers, (pct) => status("Uploading video... " + pct + "%"));
    $("mo-submit").disabled = false;

    if (r.status === 403) {
      store.del("sessionStorage", "album_pass");
      status("Wrong passcode. Try again.");
      return;
    }
    if (r.status !== 201) {
      status("Couldn't add it: " + ((r.body && r.body.error) || "upload failed. Is the server running?"));
      return;
    }
    $("mo-file").value = "";
    $("mo-caption").value = "";
    await load();
    status("Video added ❤");
  }

  async function removeMoment(id) {
    if (!confirm("Delete this video?")) return;
    const pass = await getPasscode();
    const r = await fetch(API + "/" + id, { method: "DELETE", headers: { "X-Passcode": pass } });
    if (r.status === 403) {
      store.del("sessionStorage", "album_pass");
      alert("Wrong passcode.");
      return;
    }
    await load();
  }

  // ---------- wire up ----------
  $("mo-author").value = store.get("localStorage", "album_author");
  $("mo-file").addEventListener("change", () => {
    const f = $("mo-file").files[0];
    status(f ? `Selected: ${f.name}. Write a caption and press "Add video".` : "");
  });
  $("moment-form").addEventListener("submit", submit);

  load();
})();
const $ = (id) => document.getElementById(id);

// floating hearts background
function spawnHeart() {
  const h = document.createElement("span");
  h.className = "float-heart";
  h.textContent = "\u2764";
  h.style.left = Math.random() * 100 + "vw";
  h.style.fontSize = 12 + Math.random() * 24 + "px";
  h.style.animationDuration = 6 + Math.random() * 6 + "s";
  $("hearts").appendChild(h);
  setTimeout(() => h.remove(), 12000);
}
setInterval(spawnHeart, 600);

function setupCounter(start) {
  const s = new Date(start);
  const now = new Date();
  let months = (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
  if (now.getDate() < s.getDate()) months--;
  const anchor = new Date(s);
  anchor.setMonth(anchor.getMonth() + months);
  const days = Math.max(0, Math.floor((now - anchor) / 86400000));
  const total = Math.max(0, Math.floor((now - s) / 86400000));
  $("c-months").textContent = Math.max(0, months);
  $("c-days").textContent = days;
  $("c-total").textContent = total;
}

function build(data) {
  document.title = "For " + data.her_name;
  $("intro-text").textContent = data.intro_text;
  $("her-name").textContent = data.her_name;
  $("tagline").textContent = data.tagline;
  $("letter-title").textContent = data.letter_title;
  $("moments-title").textContent = data.moments_title;
  $("reasons-title").textContent = data.reasons_title;
  $("footer-text").textContent = data.footer;
  setupCounter(data.start_date);

  // letter
  const paper = $("paper");
  data.letter.forEach((t) => {
    const p = document.createElement("p");
    p.textContent = t;
    paper.appendChild(p);
  });
  const sign = document.createElement("p");
  sign.className = "sign";
  sign.textContent = data.signoff + " " + data.your_name;
  paper.appendChild(sign);

  // moments (the timeline is drawn by moments.js: photos, videos and uploads)
  window.renderMoments(data.moments);

  // reasons
  data.reasons.forEach((r) => {
    const el = document.createElement("div");
    el.className = "reason";
    el.textContent = "\u2764 " + r;
    $("reasons").appendChild(el);
  });
}

$("open-btn").addEventListener("click", () => {
  $("gate").classList.add("hidden");
  $("site").classList.remove("hidden");
  for (let i = 0; i < 25; i++) setTimeout(spawnHeart, i * 80);
});

$("envelope").addEventListener("click", () => {
  $("envelope").classList.add("hidden");
  $("paper").classList.remove("hidden");
});

$("love-btn").addEventListener("click", () => {
  for (let i = 0; i < 60; i++) setTimeout(spawnHeart, i * 40);
  $("love-btn").textContent = "I love you more \u2764";
});

fetch("content.json")
  .then((r) => r.json())
  .then(build)
  .catch(() => {
    $("intro-text").textContent = "Run this with: python app.py";
  });
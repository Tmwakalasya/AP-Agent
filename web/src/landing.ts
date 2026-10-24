import { Board } from "./board.ts";
import { connect } from "./stdb.ts";

// Hero headline: scramble-decode, skipped for ?static and reduced motion.
const glyphs = "!<>-_\\/[]{}—=+*^?#$%;:~";
const reduce = location.search.includes("static") || matchMedia("(prefers-reduced-motion: reduce)").matches;
document.querySelectorAll<HTMLElement>("#headline .line").forEach((el, i) => {
  const target = el.dataset.text ?? "";
  if (reduce) { el.textContent = target; return; }
  let frame = 0;
  setTimeout(function tick() {
    frame++;
    const resolved = Math.min(target.length, Math.floor(frame / 2.2));
    let out = "";
    for (let k = 0; k < target.length; k++) {
      const ch = target[k];
      out += ch === " " ? " " : k < resolved ? ch : `<span class="scr">${glyphs[Math.floor(Math.random() * glyphs.length)]}</span>`;
    }
    el.innerHTML = out;
    if (resolved < target.length) requestAnimationFrame(tick); else el.textContent = target;
  }, 250 + i * 450);
});

document.getElementById("copy")?.addEventListener("click", () => {
  navigator.clipboard?.writeText("remit-to evaluate L-2041");
  const b = document.getElementById("copy")!; b.textContent = "copied"; setTimeout(() => (b.textContent = "copy"), 1200);
});

// Scroll reveal.
const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));

// Evidence counters tick up once visible.
const counters = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    counters.unobserve(e.target);
    const el = e.target as HTMLElement;
    const to = Number(el.dataset.to ?? 0);
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 900);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}, { threshold: 0.5 });
document.querySelectorAll(".count").forEach(el => counters.observe(el));

// Live read-only board embed. Connects as an anonymous viewer; never binds a persona.
const host = document.getElementById("live-board")!;
const session = connect("viewer");
new Board(host, session, { compact: true, readOnly: true });
session.onChange(() => {
  const dot = document.getElementById("live-dot")!; const label = document.getElementById("live-label")!;
  dot.classList.toggle("off", session.status !== "live");
  label.textContent = session.status === "live" ? "live · read-only · spacetimedb subscription" : session.status === "error" ? `offline · ${session.error}` : "connecting…";
});

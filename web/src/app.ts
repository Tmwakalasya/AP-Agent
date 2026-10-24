import { Board } from "./board.ts";
import { connect, DEMO, loadFromUrl, myActor, personaFromUrl, personaHref } from "./stdb.ts";
import type { PersonaKey } from "./stdb.ts";

document.body.classList.toggle("demo", DEMO);
const persona = personaFromUrl();
const session = connect(persona);
const boardEl = document.getElementById("board")!;
new Board(boardEl, session, { readOnly: persona === "viewer" });

// Persona tabs carry the selected row along, so switching from the AP tab to
// the controller tab lands on the same load.
const tabs = document.querySelectorAll<HTMLAnchorElement>("a[data-persona]");
const retarget = (load: string | null) => tabs.forEach(a => { a.href = personaHref(a.dataset.persona as PersonaKey, load); });
retarget(loadFromUrl());
boardEl.addEventListener("remit-to:select", e => retarget((e as CustomEvent<string>).detail));

const connEl = document.getElementById("conn")!;
const personaEl = document.getElementById("persona")!;
const paint = () => {
  connEl.textContent = session.status === "live" ? `● live · ${session.conn.identity?.toHexString().slice(0, 8) ?? ""}` : session.status === "error" ? `offline · ${session.error}` : session.error ?? "connecting…";
  const me = myActor(session);
  personaEl.textContent = me ? `${me.persona}` : session.role ? `${session.role} · unbound` : "viewer · read-only";
  personaEl.classList.toggle("hold", !!session.bindRefusal);
  document.title = `Remit-To · ${me?.persona ?? persona}`;
};
session.onChange(paint); paint();

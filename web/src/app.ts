import { Board } from "./board.ts";
import { connect, myActor, personaFromUrl } from "./stdb.ts";

const persona = personaFromUrl();
const session = connect(persona);
new Board(document.getElementById("board")!, session, { readOnly: persona === "viewer" });

const connEl = document.getElementById("conn")!;
const personaEl = document.getElementById("persona")!;
const paint = () => {
  connEl.textContent = session.status === "live" ? `● live · ${session.conn.identity?.toHexString().slice(0, 8) ?? ""}` : session.status === "error" ? `offline · ${session.error}` : "connecting…";
  const me = myActor(session);
  personaEl.textContent = me ? `${me.persona}` : session.role ? `${session.role} · unbound` : "viewer · read-only";
  personaEl.classList.toggle("hold", !!session.bindRefusal);
  document.title = `Remit-To · ${me?.persona ?? persona}`;
};
session.onChange(paint); paint();

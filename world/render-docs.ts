import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// Renders the seeded documents to world/out/<id>.pdf (agent input) and
// web/public/docs/<id>.{pdf,png} (board thumbnails). Content mirrors
// seed_world in module/src/index.ts; ids and dates must stay in sync.

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve("world/out");
const PUB = resolve("web/public/docs");
mkdirSync(OUT, { recursive: true }); mkdirSync(PUB, { recursive: true });

type Party = { name: string; addr: string; email: string; phone: string; mc?: string; bank?: string };
const broker: Party = { name: "Westline Freight Brokerage", addr: "1800 Harbor Bay Pkwy, Alameda, CA 94502", email: "ap@broker.example", phone: "(510) 555-0140", mc: "MC-884120" };
const carriers: Record<string, Party> = {
  "C-301": { name: "Ridgeline Transport LLC", addr: "4410 Industrial Dr, Stockton, CA 95206", email: "billing@ridgelinetransport.example", phone: "(209) 555-0188", mc: "MC-1192044", bank: "First Plains Bank · Acct ••••4471 · Routing ••••0212" },
  "C-204": { name: "Blue Mesa Freight", addr: "2290 S Cedar Ave, Fresno, CA 93725", email: "ar@bluemesafreight.example", phone: "(559) 555-0133", mc: "MC-1033517", bank: "Desert Community CU · Acct ••••0928" },
  "C-118": { name: "Cascade Haul Co", addr: "901 Maritime St, Oakland, CA 94607", email: "billing@cascadehaul.example", phone: "(510) 555-0171", mc: "MC-987210", bank: "Pacific Western · Acct ••••7715" },
  "C-452": { name: "Northstar Logistics", addr: "77 Abbott St, Salinas, CA 93901", email: "ap@northstarlogistics.example", phone: "(831) 555-0109", mc: "MC-1210877", bank: "Summit Bank · Acct ••••3310" },
};
const factor: Party = { name: "Meridian Capital Factoring", addr: "350 Montgomery St, Suite 1200, San Francisco, CA 94104", email: "ar@meridiancap.example", phone: "(415) 555-0150", bank: "Meridian Operating Account · Acct ••••5508 · Routing ••••1180" };

type Load = { id: string; carrier: string; lane: [string, string]; customer: string; pickup: string; delivery: string; rate: number; commodity: string; weight: string; pieces: string };
const loads: Load[] = [
  { id: "L-2041", carrier: "C-301", lane: ["Stockton, CA", "Reno, NV"], customer: "Sierra Beverage Co", pickup: "Jun 9, 2026", delivery: "Jun 10, 2026", rate: 2400, commodity: "Palletized beverages", weight: "38,400 lb", pieces: "22 pallets" },
  { id: "L-2037", carrier: "C-204", lane: ["Fresno, CA", "Phoenix, AZ"], customer: "Valley Produce Partners", pickup: "Jun 8, 2026", delivery: "Jun 9, 2026", rate: 1850, commodity: "Fresh produce (reefer 34°F)", weight: "41,200 lb", pieces: "24 pallets" },
  { id: "L-2033", carrier: "C-118", lane: ["Oakland, CA", "Sacramento, CA"], customer: "Bayline Paper", pickup: "Jun 8, 2026", delivery: "Jun 8, 2026", rate: 925, commodity: "Paper rolls", weight: "42,000 lb", pieces: "18 rolls" },
  { id: "L-2029", carrier: "C-452", lane: ["Salinas, CA", "Las Vegas, NV"], customer: "Monterey Greens", pickup: "Jun 10, 2026", delivery: "Jun 11, 2026", rate: 3100, commodity: "Leafy greens (reefer 36°F)", weight: "39,800 lb", pieces: "26 pallets" },
];
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

const css = `
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 816px; min-height: 1056px; padding: 56px 64px; font: 12.5px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; background: #fff; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 14px; margin-bottom: 22px; }
  .head h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
  .head .co { font-size: 15px; font-weight: 700; }
  .muted { color: #555; font-size: 11.5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 28px; margin: 16px 0; }
  .box { border: 1px solid #bbb; padding: 10px 12px; }
  .box h4 { margin: 0 0 6px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: #555; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: #555; }
  td.r, th.r { text-align: right; }
  .total td { font-weight: 700; border-top: 2px solid #111; border-bottom: 0; font-size: 14px; }
  .remit { border: 2px solid #111; padding: 12px 14px; margin-top: 18px; }
  .remit h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  .stamp { display: inline-block; border: 2px solid #b3261e; color: #b3261e; padding: 4px 10px; font-weight: 700; letter-spacing: .1em; transform: rotate(-3deg); font-size: 12px; }
  .sig { display: flex; gap: 40px; margin-top: 40px; }
  .sig div { flex: 1; border-top: 1px solid #111; padding-top: 6px; font-size: 11px; color: #333; }
  .sig .name { font-family: "Brush Script MT", "Snell Roundhand", cursive; font-size: 22px; color: #1a237e; margin: -34px 0 10px 6px; }
  .email { font: 13px/1.6 Arial, sans-serif; }
  .email .hdr { background: #f3f3f3; border: 1px solid #ddd; padding: 12px 14px; margin-bottom: 18px; }
  .email .hdr div { display: grid; grid-template-columns: 70px 1fr; }
  .email .hdr b { color: #555; font-weight: 600; }
  .email p { margin: 0 0 12px; }
  .foot { position: absolute; bottom: 40px; left: 64px; right: 64px; font-size: 10px; color: #777; border-top: 1px solid #ddd; padding-top: 8px; display: flex; justify-content: space-between; }
`;
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
const head = (co: Party, title: string, right: string) => `<div class="head"><div><div class="co">${co.name}</div><div class="muted">${co.addr}<br>${co.email} · ${co.phone}${co.mc ? ` · ${co.mc}` : ""}</div></div><div style="text-align:right"><h1>${title}</h1><div class="muted">${right}</div></div></div>`;
const foot = (id: string, note: string) => `<div class="foot"><span>Document ${id}</span><span>${note}</span></div>`;

function invoice(load: Load, number: string, date: string, remitTo: "carrier" | "factor", opts: { note?: string; reissued?: boolean } = {}) {
  const c = carriers[load.carrier];
  const remit = remitTo === "factor" ? factor : c;
  return page(`
    ${head(c, "INVOICE", `Invoice ${number}<br>Date ${date}<br>Terms Net 30`)}
    <div class="grid">
      <div class="box"><h4>Bill to</h4>${broker.name}<br>${broker.addr}<br>${broker.email}</div>
      <div class="box"><h4>Reference</h4>Load / PRO ${load.id}<br>Rate confirmation ${load.id}<br>${load.lane[0]} → ${load.lane[1]}<br>Delivered ${load.delivery}</div>
    </div>
    ${opts.reissued ? `<p><span class="stamp">REISSUED</span> <span class="muted">Original invoice unpaid; resubmitted for processing.</span></p>` : ""}
    <table><thead><tr><th>Description</th><th>Qty</th><th class="r">Amount</th></tr></thead><tbody>
      <tr><td>Linehaul · ${load.lane[0]} to ${load.lane[1]} · ${load.commodity}</td><td>1</td><td class="r">${money(load.rate)}</td></tr>
      <tr><td>Accessorials</td><td>—</td><td class="r">$0.00</td></tr>
      <tr class="total"><td colspan="2">Total due (USD)</td><td class="r">${money(load.rate)}</td></tr>
    </tbody></table>
    <div class="remit"><h4>Remit payment to</h4><b>${remit.name}</b><br>${remit.addr}<br>${remit.bank}${opts.note ? `<br><br><i>${opts.note}</i>` : ""}</div>
    ${foot(number, "Thank you for your business.")}`);
}

function rateCon(load: Load, date: string) {
  const c = carriers[load.carrier];
  return page(`
    ${head(broker, "RATE CONFIRMATION", `Load ${load.id}<br>Issued ${date}<br>Customer ${load.customer}`)}
    <div class="grid">
      <div class="box"><h4>Carrier</h4>${c.name}<br>${c.addr}<br>${c.mc} · ${c.phone}</div>
      <div class="box"><h4>Equipment</h4>53' ${load.commodity.includes("reefer") ? "Reefer" : "Dry Van"}<br>${load.weight} · ${load.pieces}<br>${load.commodity}</div>
      <div class="box"><h4>Pickup</h4>${load.lane[0]}<br>${load.pickup} · 08:00–14:00</div>
      <div class="box"><h4>Delivery</h4>${load.lane[1]}<br>${load.delivery} · by 16:00</div>
    </div>
    <table><thead><tr><th>Charge</th><th class="r">Agreed rate</th></tr></thead><tbody>
      <tr><td>Linehaul, all-in</td><td class="r">${money(load.rate)}</td></tr>
      <tr class="total"><td>Total (USD)</td><td class="r">${money(load.rate)}</td></tr>
    </tbody></table>
    <p class="muted">Payment within 30 days of receipt of a clean invoice and signed proof of delivery. Payee of record is determined by ${broker.name}'s verified carrier file and any notice of assignment on file; remittance instructions on an invoice do not amend the carrier file.</p>
    <div class="sig"><div><div class="name">R. Okafor</div>${broker.name} · Carrier Sales</div><div><div class="name">${c.name.split(" ")[0]} Dispatch</div>${c.name} · Accepted</div></div>
    ${foot(`D-rate-${load.id.slice(2)}`, "Rate confirmation")}`);
}

function pod(load: Load, signedAt: string) {
  const c = carriers[load.carrier];
  return page(`
    ${head(broker, "PROOF OF DELIVERY", `Load ${load.id}<br>Carrier ${c.name}<br>${c.mc}`)}
    <div class="grid">
      <div class="box"><h4>Shipper</h4>${load.customer}<br>${load.lane[0]}</div>
      <div class="box"><h4>Consignee</h4>${load.customer} Receiving<br>${load.lane[1]}</div>
    </div>
    <table><thead><tr><th>Pieces</th><th>Commodity</th><th>Weight</th><th>Condition</th></tr></thead><tbody>
      <tr><td>${load.pieces}</td><td>${load.commodity}</td><td>${load.weight}</td><td>Received in good order · no OS&amp;D</td></tr>
    </tbody></table>
    <p>Delivered <b>${signedAt}</b>. Seal intact. Temperature log attached where applicable.</p>
    <div class="sig"><div><div class="name">M. Delgado</div>Driver · ${c.name}</div><div><div class="name">J. Whitcombe</div>Receiving · ${load.customer} · ${signedAt}</div></div>
    ${foot(`D-pod-${load.id.slice(2)}`, "Signed delivery receipt")}`);
}

function noa() {
  const c = carriers["C-301"];
  return page(`
    ${head(factor, "NOTICE OF ASSIGNMENT", `Effective March 2, 2026<br>Ref NOA-2026-0302-RT`)}
    <p>To: <b>${broker.name}</b>, ${broker.addr}</p>
    <p>Please be advised that <b>${c.name}</b> (${c.mc}) has sold and assigned to <b>${factor.name}</b> all of its present and future accounts receivable, including all amounts now or hereafter owed by you for transportation services.</p>
    <p><b>All payments</b> on invoices from ${c.name} must be made payable and remitted only to:</p>
    <div class="remit"><h4>Remit to</h4><b>${factor.name}</b><br>${factor.addr}<br>${factor.bank}</div>
    <p style="margin-top:16px">This notice remains in effect until you receive a <b>written release signed by ${factor.name}</b>. Payment made to any other party after receipt of this notice does not discharge your obligation. Any request to redirect payment that does not come from ${factor.name} in writing should be treated as unauthorized and reported to us at ${factor.email}.</p>
    <div class="sig"><div><div class="name">A. Lindqvist</div>${factor.name} · VP Operations</div><div><div class="name">T. Ruiz</div>${c.name} · Owner · Acknowledged</div></div>
    ${foot("D-noa-0302", "Verified by Westline controller on receipt · bank destination v2")}`);
}

function redirectEmail() {
  return page(`<div class="email">
    <div class="hdr">
      <div><b>From</b><span>Ridgeline Transport Billing &lt;billing@ridgeline-transport.co&gt;</span></div>
      <div><b>To</b><span>${broker.email}</span></div>
      <div><b>Date</b><span>Thu, Jun 11, 2026 07:27 PDT</span></div>
      <div><b>Subject</b><span>RE: Updated banking for remittance – Ridgeline Transport (Load L-2041)</span></div>
    </div>
    <p>Hi Westline AP team,</p>
    <p>Quick update from our side. Effective immediately, Ridgeline Transport is handling its own receivables again and we are no longer working with the factoring company. Please <b>disregard any prior notice of assignment</b> and remit all open and future invoices directly to us:</p>
    <p style="padding-left:16px"><b>Ridgeline Transport LLC</b><br>First Plains Bank<br>Account ••••4471 · Routing ••••0212</p>
    <p>Invoice for L-2041 (Stockton → Reno, delivered 6/10) will follow tomorrow with the new remit-to on it. Appreciate you updating the file quickly so there's no delay on this one – the driver has been asking.</p>
    <p>Thanks,<br>Kelly Moreno<br>Billing · Ridgeline Transport LLC<br>(209) 555-0190</p>
    <p class="muted" style="margin-top:30px;font-size:11px">Note the sender domain <b>ridgeline-transport.co</b> differs from the carrier file domain <b>ridgelinetransport.example</b>. No release from ${factor.name} is attached.</p>
    ${foot("D-eml-0611", "Email as received · unverified")}
  </div>`);
}

const L = Object.fromEntries(loads.map(l => [l.id, l]));
const docs: Array<[string, string]> = [
  ["D-noa-0302", noa()],
  ["D-rate-2041", rateCon(L["L-2041"], "Jun 1, 2026")],
  ["D-pod-2041", pod(L["L-2041"], "Jun 10, 2026 15:30")],
  ["D-eml-0611", redirectEmail()],
  ["D-inv-0612", invoice(L["L-2041"], "INV-88213", "Jun 12, 2026", "carrier", { note: "NEW BANKING DETAILS – see our email of June 11. Please update your records and pay Ridgeline Transport directly." })],
  ["D-rate-2037", rateCon(L["L-2037"], "Jun 2, 2026")],
  ["D-pod-2037", pod(L["L-2037"], "Jun 9, 2026 12:50")],
  ["D-inv-5521", invoice(L["L-2037"], "INV-5521", "Jun 10, 2026", "carrier")],
  ["D-inv-5521R", invoice(L["L-2037"], "INV-5521-R", "Jun 24, 2026", "carrier", { reissued: true })],
  ["D-rate-2033", rateCon(L["L-2033"], "Jun 3, 2026")],
  ["D-pod-2033", pod(L["L-2033"], "Jun 8, 2026 12:22")],
  ["D-inv-7710", invoice(L["L-2033"], "INV-7710", "Jun 9, 2026", "carrier")],
  ["D-rate-2029", rateCon(L["L-2029"], "Jun 4, 2026")],
  ["D-pod-2029", pod(L["L-2029"], "Jun 11, 2026 16:10")],
  ["D-inv-3302", invoice(L["L-2029"], "INV-3302", "Jun 12, 2026", "carrier")],
];

for (const [id, html] of docs) {
  const htmlPath = resolve(OUT, `${id}.html`);
  writeFileSync(htmlPath, html);
  const pdf = resolve(OUT, `${id}.pdf`);
  const png = resolve(PUB, `${id}.png`);
  const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-pdf-header-footer", "--virtual-time-budget=1500"];
  execFileSync(CHROME, [...common, `--print-to-pdf=${pdf}`, `file://${htmlPath}`], { stdio: "ignore" });
  execFileSync(CHROME, [...common, "--window-size=816,1056", "--force-device-scale-factor=0.6", `--screenshot=${png}`, `file://${htmlPath}`], { stdio: "ignore" });
  copyFileSync(pdf, resolve(PUB, `${id}.pdf`));
  rmSync(htmlPath);
  console.log(`rendered ${id}`);
}

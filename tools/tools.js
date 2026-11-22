"use strict";

const decimal = new Intl.NumberFormat("en", { maximumSignificantDigits: 7 });
const scientific = new Intl.NumberFormat("en", { notation: "scientific", maximumSignificantDigits: 7 });

function display(value) {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 1e-5 || magnitude >= 1e7)
    ? scientific.format(value)
    : decimal.format(value === 0 ? 0 : value);
}

function gridEquivalent(kv, mw, scr, xr, base) {
  const faultMva = mw * scr;
  const zOhms = kv ** 2 / faultMva;
  const zPu = base / faultMva;
  const factor = Math.hypot(1, xr);
  return {
    faultMva,
    faultKa: faultMva / (Math.sqrt(3) * kv),
    rOhms: zOhms / factor,
    xOhms: zOhms * (xr / factor),
    rPu: zPu / factor,
    xPu: zPu * (xr / factor),
  };
}

function readPairs(text, header) {
  const rows = [];
  const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const cells = line.split(/[,\t]/).map(cell => cell.trim());
    if (!rows.length && cells.join(",").toLowerCase() === header) {
      header = null;
      return;
    }
    if (cells.length !== 2 || cells.some(cell => !number.test(cell) || !Number.isFinite(Number(cell)))) {
      throw new Error(`Line ${index + 1} needs two finite numbers separated by a comma or tab.`);
    }
    rows.push(cells.map(Number));
  });
  if (!rows.length) throw new Error("Enter at least one pair of numbers.");
  return rows;
}

function modalMetrics(real, imag, threshold) {
  const magnitude = Math.hypot(real, imag);
  const frequency = Math.abs(imag) / (2 * Math.PI);
  const damping = imag === 0 ? null : -100 * (real / magnitude);
  const timeConstant = real === 0 ? null : 1 / Math.abs(real);
  let status = "Decaying";
  if (real > 0) status = "Growing";
  else if (real === 0) status = "On imaginary axis";
  else if (damping !== null && damping < threshold) status = "Below threshold";
  return { frequency, damping, timeConstant, status };
}

function storageBuffer(profile, target, charge, discharge) {
  if (profile.length < 2) throw new Error("Enter at least two load samples.");
  let peakCharge = 0;
  let peakDischarge = 0;
  let energy = 0;
  let minEnergy = 0;
  let maxEnergy = 0;
  const power = profile.map(([, load]) => load - target);
  const storedRate = p => p > 0 ? -p / discharge : -p * charge;

  function accumulate(deltaMwh) {
    energy += deltaMwh;
    minEnergy = Math.min(minEnergy, energy);
    maxEnergy = Math.max(maxEnergy, energy);
  }

  for (const [index, [time]] of profile.entries()) {
    const current = power[index];
    peakCharge = Math.max(peakCharge, -current);
    peakDischarge = Math.max(peakDischarge, current);
    if (index === 0) {
      if (time < 0) throw new Error("Time must be nonnegative.");
      continue;
    }

    const durationHours = (time - profile[index - 1][0]) / 3600;
    if (durationHours <= 0) throw new Error(`Time must increase strictly at sample ${index + 1}.`);
    const previous = power[index - 1];
    if ((previous < 0 && current > 0) || (previous > 0 && current < 0)) {
      const crossing = Math.abs(previous) / (Math.abs(previous) + Math.abs(current));
      accumulate(storedRate(previous) * durationHours * crossing / 2);
      accumulate(storedRate(current) * durationHours * (1 - crossing) / 2);
    } else {
      accumulate((storedRate(previous) + storedRate(current)) * durationHours / 2);
    }
  }

  return { peakCharge, peakDischarge, usable: maxEnergy - minEnergy, startAboveMin: -minEnergy, net: energy };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function metricList(entries) {
  const list = element("dl", undefined, "metrics");
  for (const [label, value, unit] of entries) {
    if (!Number.isFinite(value)) throw new Error("These values exceed the calculator’s numeric range.");
    const item = element("div");
    item.append(element("dt", label), element("dd", unit ? `${display(value)} ${unit}` : display(value)));
    list.append(item);
  }
  return list;
}

function modalTable(modes, threshold) {
  const container = element("div", undefined, "table-scroll");
  container.tabIndex = 0;
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "Eigenvalue screening results");
  const table = element("table");
  const heading = table.createTHead().insertRow();
  for (const label of ["σ (s⁻¹)", "ω (rad/s)", "Frequency (Hz)", "Damping (%)", "Time constant (s)", "Screening"]) {
    const header = element("th", label);
    header.scope = "col";
    heading.append(header);
  }
  const body = table.createTBody();
  for (const [real, imag] of modes) {
    const { frequency, damping, timeConstant, status } = modalMetrics(real, imag, threshold);
    const row = body.insertRow();
    for (const value of [real, imag, frequency, damping, timeConstant]) row.insertCell().textContent = display(value);
    const state = row.insertCell();
    state.textContent = status;
    if (status === "Growing") state.className = "unstable";
    if (status === "Below threshold") state.className = "below";
  }
  container.append(table);
  return container;
}

function bindForm(name, calculate) {
  const form = document.getElementById(`${name}-form`);
  const result = document.getElementById(`${name}-result`);
  function update() {
    const data = new FormData(form);
    const numeric = key => Number(data.get(key));
    try {
      result.replaceChildren(calculate(data, numeric));
    } catch (error) {
      result.replaceChildren(element("p", error.message, "error"));
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    update();
  });
  update();
}

bindForm("grid", (data, numeric) => {
  const result = gridEquivalent(...["kv", "mw", "scr", "xr", "base"].map(numeric));
  return metricList([
    ["Grid fault level", result.faultMva, "MVA"],
    ["3φ fault current", result.faultKa, "kA"],
    ["Resistance", result.rOhms, "Ω"],
    ["Reactance", result.xOhms, "Ω"],
    ["Resistance", result.rPu, "pu"],
    ["Reactance", result.xPu, "pu"],
  ]);
});

bindForm("modes", (data, numeric) => {
  return modalTable(readPairs(data.get("modes"), "real,imag"), numeric("threshold"));
});

bindForm("storage", (data, numeric) => {
  const profile = readPairs(data.get("profile"), "time_s,load_mw");
  const result = storageBuffer(profile, numeric("target"), numeric("charge") / 100, numeric("discharge") / 100);
  return metricList([
    ["Peak discharge", result.peakDischarge, "MW"],
    ["Peak charge", result.peakCharge, "MW"],
    ["Minimum usable energy", result.usable, "MWh"],
    ["Initial energy above minimum", result.startAboveMin, "MWh"],
    ["Net stored energy change", result.net, "MWh"],
  ]);
});

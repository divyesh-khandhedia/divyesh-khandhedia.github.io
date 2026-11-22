import {
  perUnit, toRectangular, toPolar, sequenceToPhase, phaseToSequence, faultCurrent,
  twoBus, frequencyResponse, inverseTime, transformerImpedance, cableResistance, meritOrder,
  additionalCalculations,
} from "./calculations.js";

const decimal = new Intl.NumberFormat("en", { maximumSignificantDigits: 6 });
const scientific = new Intl.NumberFormat("en", { notation: "scientific", maximumSignificantDigits: 4 });

function format(value) {
  if (value === null) return "—";
  if (!Number.isFinite(value)) throw new Error("These inputs exceed the calculator’s numerical range.");
  const size = Math.abs(value);
  return size !== 0 && (size < 0.001 || size >= 1e6) ? scientific.format(value) : decimal.format(value === 0 ? 0 : value);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function metrics(entries) {
  const list = element("dl", undefined, "metrics");
  for (const [name, value, unit] of entries) {
    const item = element("div");
    const text = typeof value === "string" ? value : format(value);
    item.append(element("dt", name), element("dd", value !== null && unit ? `${text} ${unit}` : text));
    list.append(item);
  }
  return list;
}

function table(title, columns, rows) {
  const scroll = element("div", undefined, "table-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", title);
  const grid = element("table");
  grid.createCaption().textContent = title;
  const heading = grid.createTHead().insertRow();
  for (const label of columns) {
    const header = element("th", label);
    header.scope = "col";
    heading.append(header);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const value of values) row.insertCell().textContent = typeof value === "string" ? value : format(value);
  }
  scroll.append(grid);
  return scroll;
}

function phasorTable(title, labels, values, multiplier = 1, unit = "") {
  const rows = values.map((value, index) => {
    const { amplitude, angle } = toPolar(value);
    return [labels[index], amplitude * multiplier, angle];
  });
  return table(title, ["Quantity", unit ? `Magnitude (${unit})` : "Magnitude", "Angle (°)"], rows);
}

const chartDrawers = new WeakMap();
const observer = typeof ResizeObserver === "function"
  ? new ResizeObserver(entries => {
    for (const { target } of entries) chartDrawers.get(target)?.();
  })
  : null;

function lineChart(label, horizontalLabel, verticalLabel, series) {
  const figure = element("figure", undefined, "calculator-chart");
  const canvas = element("canvas", "Chart unavailable. Key results are listed above.");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  const legend = element("figcaption");
  for (const { name, color } of series) {
    const item = element("span", name);
    item.style.borderColor = color;
    legend.append(item);
  }
  figure.append(canvas, legend);

  const points = series.flatMap(item => item.points);
  const xmax = Math.max(...points.map(([x]) => x));
  const ymin = Math.min(...points.map(([, y]) => y));
  const ymax = Math.max(...points.map(([, y]) => y));
  const pad = Math.max((ymax - ymin) * 0.08, 0.01);
  const low = ymin - pad;
  const high = ymax + pad;
  const draw = () => {
    const width = canvas.clientWidth;
    if (!width) return;
    const height = 225;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.font = "11px system-ui";
    const left = 55, right = width - 15, top = 17, bottom = height - 40;
    const px = x => left + x / xmax * (right - left);
    const py = y => bottom - (y - low) / (high - low) * (bottom - top);
    const xTicks = width < 430 ? 3 : 5;
    const yTicks = 4;
    ctx.fillStyle = "#405955";
    ctx.strokeStyle = "#d3dfd9";
    for (let index = 0; index <= yTicks; index += 1) {
      const value = low + (high - low) * index / yTicks;
      const y = py(value);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(Number(value.toPrecision(4)), left - 6, y + 4);
    }
    ctx.textAlign = "center";
    for (let index = 0; index <= xTicks; index += 1) {
      const value = xmax * index / xTicks;
      ctx.fillText(Number(value.toPrecision(4)), px(value), bottom + 14);
    }
    ctx.textAlign = "left";
    ctx.fillText(verticalLabel, 5, 11);
    ctx.textAlign = "center";
    ctx.fillText(horizontalLabel, (left + right) / 2, height - 5);
    for (const { points: values, color, dash = [] } of series) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      values.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(px(x), py(y));
        else ctx.lineTo(px(x), py(y));
      });
      ctx.stroke();
    }
  };
  chartDrawers.set(canvas, draw);
  requestAnimationFrame(() => {
    draw();
    observer?.observe(canvas);
  });
  return figure;
}

function readUnits(text) {
  const rows = [];
  const names = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const cells = line.split(",").map(value => value.trim());
    const [name, ...numbers] = cells;
    const [min, max, cost] = numbers.map(Number);
    if (cells.length !== 4 || !name || numbers.some(value => !value || !Number.isFinite(Number(value))) || min < 0 || max < min) {
      throw new Error(`Line ${index + 1} needs a name, minimum MW, maximum MW and marginal cost. Use 0 ≤ minimum ≤ maximum.`);
    }
    if (names.has(name.toLowerCase())) throw new Error(`Line ${index + 1} repeats a unit name.`);
    names.add(name.toLowerCase());
    rows.push({ name, min, max, cost });
  }
  if (!rows.length) throw new Error("Enter at least one committed unit.");
  return rows;
}

const calculators = {
  "per-unit": (_, n) => {
    const r = perUnit(numbers(n, "mva", "kv", "oldMva", "oldKv", "r", "x"));
    return [metrics([["New base impedance", r.zBase, "Ω"], ["New base current", r.iBase, "kA"],
      ["New resistance", r.rPu, "pu"], ["New reactance", r.xPu, "pu"],
      ["Resistance", r.rOhm, "Ω"], ["Reactance", r.xOhm, "Ω"]])];
  },
  symmetrical: (data, n) => {
    const input = [0, 1, 2].map(index => toRectangular(n(`m${index}`), n(`a${index}`)));
    const phaseInput = data.get("direction") === "phase";
    const phase = phaseInput ? input : sequenceToPhase(input);
    const sequence = phaseInput ? phaseToSequence(input) : input;
    const positive = toPolar(sequence[1]).amplitude;
    const ratio = positive < 1e-10 ? null : toPolar(sequence[2]).amplitude / positive * 100;
    return [metrics([["Negative / positive sequence", ratio, "%"]]),
      phasorTable("Phase phasors", ["A", "B", "C"], phase),
      phasorTable("Sequence phasors", ["Zero", "Positive", "Negative"], sequence)];
  },
  fault: (data, n) => {
    const z = suffix => [n(`r${suffix}`), n(`x${suffix}`)];
    const r = faultCurrent({ ...numbers(n, "kv", "mva", "prefault"), fault: data.get("fault"), z1: z("1"), z2: z("2"), z0: z("0"), zf: z("f") });
    const earth = toPolar(r.sequences[0]).amplitude * 3 * r.baseKa;
    return [metrics([["Base current", r.baseKa, "kA"], ["Residual current |3I₀|", earth, "kA"]]),
      phasorTable("Phase fault currents", ["A", "B", "C"], r.phases, r.baseKa, "kA"),
      phasorTable("Sequence fault currents", ["Zero", "Positive", "Negative"], r.sequences, 1, "pu")];
  },
  voltage: (_, n) => {
    const input = numbers(n, "source", "r", "x", "p", "qOverP");
    const { pMax, operating, curve } = twoBus(input);
    const summary = [["Nose point P", pMax, "pu"], ["Active load margin", pMax - input.p, "pu"]];
    if (operating) summary.push(["High-voltage solution", operating.v, "pu"], ["Receiving angle", operating.angle, "°"], ["Line current", operating.i, "pu"]);
    const result = [metrics(summary)];
    if (!operating) result.push(element("p", "No steady-state solution at the requested load.", "error"));
    result.push(lineChart("Receiving-end voltage against active power for the high- and low-voltage solutions.",
      "Receiving P (pu)", "|V| (pu)", [
        { name: "High-voltage solution", color: "#145848", points: curve.map(row => [row.p, row.v]) },
        { name: "Low-voltage solution", color: "#9b4c22", dash: [5, 4], points: curve.map(row => [row.p, row.low]) },
      ]));
    return result;
  },
  frequency: (_, n) => {
    const input = numbers(n, "base", "nominal", "inertia", "loss", "damping", "droop", "governorTime", "duration");
    const r = frequencyResponse(input);
    if (r.minimum <= 0 || r.steadyState <= 0) throw new Error("The disturbance is too large for this linear frequency-response model.");
    const result = [metrics([["Initial RoCoF", r.rocof, "Hz/s"], ["Minimum within simulation", r.minimum, "Hz"],
      ["Time of minimum", r.minimumTime, "s"], ["Primary steady-state estimate", r.steadyState, "Hz"]])];
    if (r.minimumTime === input.duration && input.loss > 0) {
      result.push(element("p", "The minimum is at the end of the window. Increase the duration to check for a later nadir.", "hint"));
    }
    result.push(lineChart("Frequency in Hz following the modeled generation loss.", "Time (s)", "Frequency (Hz)",
      [{ name: "System frequency", color: "#145848", points: r.points.map(row => [row.t, row.hz]) }]));
    return result;
  },
  idmt: (data, n) => {
    const time = name => inverseTime({ curve: data.get(`${name}Curve`), pickup: n(`${name}Pickup`), tms: n(`${name}Tms`), current: n("current") });
    const down = time("down");
    const up = time("up");
    return [metrics([["Downstream operate time", down ?? "Below or at pickup", down === null ? "" : "s"],
      ["Upstream operate time", up ?? "Below or at pickup", up === null ? "" : "s"],
      ["Upstream − downstream", down === null || up === null ? null : up - down, "s"]])];
  },
  transformer: (_, n) => {
    const r = transformerImpedance(numbers(n, "kva", "kv", "impedance", "copperLoss"));
    return [metrics([["Resistance", r.r, "%"], ["Reactance", r.x, "%"], ["X/R", r.ratio], ["Resistance", r.rOhm, "Ω"], ["Reactance", r.xOhm, "Ω"]])];
  },
  cable: (data, n) => {
    const r = cableResistance({ ...numbers(n, "r20", "temperature", "length", "parallel"), material: data.get("material") });
    return [metrics([["Temperature correction factor", r.factor], ["Corrected resistance per conductor", r.perKm, "Ω/km"],
      ["Effective resistance per phase", r.total, "Ω"]])];
  },
  dispatch: (data, n) => {
    const demand = n("demand");
    const r = meritOrder(readUnits(data.get("units")), demand);
    return [metrics([["Dispatch", demand, "MW"], ["Total cost per hour", r.total]]),
      table("Committed unit schedule", ["Unit", "Output (MW)", "Marginal cost / MWh", "Cost / h"],
        r.dispatch.map(unit => [unit.name, unit.mw, unit.cost, unit.mw * unit.cost]))];
  },
};

function numbers(n, ...names) {
  return Object.fromEntries(names.map(name => [name, n(name)]));
}

for (const form of document.querySelectorAll("[data-calculator]")) {
  const key = form.dataset.calculator;
  const calculate = calculators[key] ?? ((_, n) => [metrics(additionalCalculations[key](n))]);
  const result = form.nextElementSibling;
  function update() {
    const values = new FormData(form);
    const n = key => Number(values.get(key));
    for (const canvas of result.querySelectorAll("canvas")) observer?.unobserve(canvas);
    try {
      result.replaceChildren(...calculate(values, n));
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

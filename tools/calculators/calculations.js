const degrees = Math.PI / 180;
const add = ([a, b], [c, d]) => [a + c, b + d];
const multiply = ([a, b], [c, d]) => [a * c - b * d, a * d + b * c];
const scale = ([a, b], factor) => [a * factor, b * factor];
const sum = (...values) => values.reduce(add, [0, 0]);
const magnitude = ([a, b]) => Math.hypot(a, b);
const a = [-0.5, Math.sqrt(3) / 2];
const a2 = [a[0], -a[1]];

function divide(numerator, denominator) {
  const length = magnitude(denominator);
  if (length < 1e-12) throw new Error("A sequence network has nearly zero impedance. Check the model and bases.");
  const unitConjugate = [denominator[0] / length, -denominator[1] / length];
  return scale(multiply(numerator, unitConjugate), 1 / length);
}

export function perUnit({ mva, kv, oldMva, oldKv, r, x }) {
  const zBase = kv ** 2 / mva;
  const factor = (mva / oldMva) * (oldKv / kv) ** 2;
  return { zBase, iBase: mva / (Math.sqrt(3) * kv), rPu: r * factor, xPu: x * factor,
    rOhm: r * factor * zBase, xOhm: x * factor * zBase };
}

export function toRectangular(amplitude, angleDegrees) {
  return [amplitude * Math.cos(angleDegrees * degrees), amplitude * Math.sin(angleDegrees * degrees)];
}

export function toPolar(value) {
  const amplitude = magnitude(value);
  return { amplitude, angle: amplitude < 1e-10 ? null : Math.atan2(value[1], value[0]) / degrees };
}

export function sequenceToPhase([zero, positive, negative]) {
  return [
    sum(zero, positive, negative),
    sum(zero, multiply(a2, positive), multiply(a, negative)),
    sum(zero, multiply(a, positive), multiply(a2, negative)),
  ];
}

export function phaseToSequence([va, vb, vc]) {
  return [
    sum(va, vb, vc),
    sum(va, multiply(a, vb), multiply(a2, vc)),
    sum(va, multiply(a2, vb), multiply(a, vc)),
  ].map(value => scale(value, 1 / 3));
}

export function faultCurrent({ fault, kv, mva, prefault, z1, z2, z0, zf }) {
  const voltage = [prefault, 0];
  let sequences;
  if (fault === "three") {
    sequences = [[0, 0], divide(voltage, add(z1, zf)), [0, 0]];
  } else if (fault === "slg") {
    const current = divide(voltage, sum(z1, z2, z0, scale(zf, 3)));
    sequences = [current, current, current];
  } else if (fault === "ll") {
    const current = divide(voltage, sum(z1, z2, zf));
    sequences = [[0, 0], current, scale(current, -1)];
  } else {
    const groundPath = add(z0, scale(zf, 3));
    const parallelBase = add(z2, groundPath);
    const parallel = divide(multiply(z2, groundPath), parallelBase);
    const positive = divide(voltage, add(z1, parallel));
    const zero = scale(multiply(positive, divide(z2, parallelBase)), -1);
    const negative = scale(multiply(positive, divide(groundPath, parallelBase)), -1);
    sequences = [zero, positive, negative];
  }
  return { sequences, phases: sequenceToPhase(sequences), baseKa: mva / (Math.sqrt(3) * kv) };
}

export function twoBus({ source, r, x, p, qOverP }) {
  if (r === 0 && x === 0) throw new Error("Enter a nonzero series impedance.");
  const c = r + x * qOverP;
  const d = x - r * qOverP;
  const norm = Math.hypot(c, d);
  const denominator = c < 0 ? d ** 2 / (norm - c) : c + norm;
  const pMax = source ** 2 / (2 * denominator);

  function at(active) {
    const product = source ** 2 - 2 * c * active;
    const discriminant = source ** 4 - 4 * source ** 2 * c * active - 4 * (d * active) ** 2;
    if (active > pMax * (1 + 1e-12) || product < 0) return null;
    const voltageSquared = (product + Math.sqrt(Math.max(0, discriminant))) / 2;
    const v = Math.sqrt(voltageSquared);
    const low = v ? active * norm / v : 0;
    const angle = Math.atan2(-d * active, voltageSquared + c * active) / degrees;
    return { v, low, angle, i: Math.hypot(active, active * qOverP) / v };
  }
  const curve = Array.from({ length: 81 }, (_, index) => {
    const active = pMax * index / 80;
    return { p: active, ...at(active) };
  });
  return { pMax, operating: at(p), curve };
}

export function frequencyResponse({ base, nominal, inertia, loss, damping, droop, governorTime, duration }) {
  const imbalance = loss / base;
  const gain = 100 / droop;
  const swing = 2 * inertia;
  const stiffness = (damping + gain) / swing;
  // Bound the step against both poles, including very fast user-entered governors.
  const speed = damping / swing + 1 / governorTime + Math.sqrt(stiffness / governorTime);
  const count = Math.max(240, Math.ceil(8 * duration * speed));
  if (count > 20000) throw new Error("These inputs require too many time steps. Shorten the duration or use a slower governor.");
  const dt = duration / count;
  const derivative = ([f, mechanical]) => [
    (mechanical - imbalance - damping * f) / swing,
    (-gain * f - mechanical) / governorTime,
  ];
  const step = (y, h) => {
    const k1 = derivative(y);
    const k2 = derivative(add(y, scale(k1, h / 2)));
    const k3 = derivative(add(y, scale(k2, h / 2)));
    const k4 = derivative(add(y, scale(k3, h)));
    return add(y, scale(sum(k1, scale(k2, 2), scale(k3, 2), k4), h / 6));
  };

  let y = [0, 0];
  let minimum = nominal;
  let minimumTime = 0;
  const points = [{ t: 0, hz: nominal }];
  const stride = Math.max(1, Math.floor(count / 450));
  for (let index = 1; index <= count; index += 1) {
    y = step(y, dt);
    const t = index * dt;
    const hz = nominal * (1 + y[0]);
    if (hz < minimum) {
      minimum = hz;
      minimumTime = t;
    }
    if (index % stride === 0 || index === count) points.push({ t, hz });
  }
  return { rocof: -nominal * imbalance / swing, minimum, minimumTime,
    steadyState: nominal * (1 - imbalance / (damping + gain)), points };
}

const iecCurves = { standard: [0.14, 0.02], very: [13.5, 1], extreme: [80, 2] };

export function inverseTime({ curve, pickup, tms, current }) {
  const multiple = current / pickup;
  if (multiple <= 1) return null;
  const [k, alpha] = iecCurves[curve];
  return tms * k / Math.expm1(alpha * Math.log(multiple));
}

export function transformerImpedance({ kva, kv, impedance, copperLoss }) {
  const r = copperLoss / kva * 100;
  if (r > impedance) throw new Error("Load loss implies %R greater than %Z. Check ratings and use rated-current load loss in kW.");
  const x = Math.sqrt((impedance - r) * (impedance + r));
  const base = kv ** 2 * 1000 / kva;
  return { r, x, ratio: r === 0 ? null : x / r, rOhm: r * base / 100, xOhm: x * base / 100 };
}

export function cableResistance({ material, r20, temperature, length, parallel }) {
  const constant = material === "copper" ? 234.5 : 228;
  const factor = (constant + temperature) / (constant + 20);
  return { factor, perKm: r20 * factor, total: r20 * factor * length / parallel };
}

export function meritOrder(units, demand) {
  const minimum = units.reduce((total, unit) => total + unit.min, 0);
  const maximum = units.reduce((total, unit) => total + unit.max, 0);
  if (demand < minimum - 1e-9 || demand > maximum + 1e-9) {
    throw new Error(`Demand must be between ${minimum} and ${maximum} MW for the committed fleet.`);
  }
  let remaining = Math.max(0, demand - minimum);
  const dispatch = [...units].sort((first, second) => first.cost - second.cost).map(unit => {
    const incremental = Math.min(remaining, unit.max - unit.min);
    remaining -= incremental;
    return { ...unit, mw: unit.min + incremental };
  });
  return { dispatch, total: dispatch.reduce((total, unit) => total + unit.mw * unit.cost, 0) };
}

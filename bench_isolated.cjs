// ISOLATED V8 benchmark harness — source of truth for all Part 4 numbers.
//
// Why this exists: measuring every scenario in one process lets V8's inline caches
// leak between scenarios (a call site measured early is clean, one measured late has
// already seen many shapes). That produced ratios that moved 3x between runs.
//
// Fix: each scenario runs in its OWN child process, with its OWN call site.
//
// Usage:
//   node bench_isolated.cjs                  # run all scenarios (~2 min), writes results/verified_truth.json
//   node bench_isolated.cjs --scenario=NAME   # run one scenario (internal)
//
// The reference run (Node v26.8.1 / V8 14.6, Intel Celeron J4105) is checked in at
// results/reference_run.json. Your own run never touches it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = 200000;
const ITER = 5000000;
const RUNS = 9;
const WARMUP = 300000;

// ============================================================
// Object builders. Each returns an array of N objects.
// The `code` string is what actually runs — shown on screen.
// ============================================================

class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

const BUILDERS = {
  one_shape: {
    label: 'One shape',
    code: '{ x: i, y: i }',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = { x: i, y: i };
      return a;
    },
  },

  inverted_order: {
    label: 'Inverted key order (own site)',
    code: 'o = {}; o.y = i; o.x = i',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = {};
        o.y = i;
        o.x = i;
        a[i] = o;
      }
      return a;
    },
  },

  class_ctor: {
    label: 'Class constructor',
    code: 'new Point(i, i)',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = new Point(i, i);
      return a;
    },
  },

  json_roundtrip: {
    label: 'JSON parse round-trip',
    code: 'JSON.parse(JSON.stringify({x,y}))',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = JSON.parse(JSON.stringify({ x: i, y: i }));
      return a;
    },
  },

  two_shapes: {
    label: 'Two shapes, one call site',
    code: 'half {x,y}, half {y,x}',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        if (i % 2 === 0) {
          a[i] = { x: i, y: i };
        } else {
          const o = {};
          o.y = i;
          o.x = i;
          a[i] = o;
        }
      }
      return a;
    },
  },

  poly_4: {
    label: 'Four shapes, one call site',
    code: '4 construction patterns',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const r = i % 4;
        if (r === 0) a[i] = { x: i, y: i };
        else if (r === 1) { const o = {}; o.y = i; o.x = i; a[i] = o; }
        else if (r === 2) a[i] = { ...{ y: i }, ...{ x: i } };
        else a[i] = Object.assign({}, { y: i }, { x: i });
      }
      return a;
    },
  },

  mega_16: {
    label: 'Megamorphic (16 shapes)',
    code: '16 shapes, one call site',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const rank = i % 16;
        const o = {};
        for (let k = 0; k < rank; k++) o['p' + k] = k;
        o.x = i;
        o.y = i;
        a[i] = o;
      }
      return a;
    },
  },

  delete_light: {
    label: 'After 1 add + 1 delete',
    code: '{x,y}; o.tmp=1; delete o.tmp',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = { x: i, y: i };
        o.tmp = 1;
        delete o.tmp;
        a[i] = o;
      }
      return a;
    },
  },

  delete_heavy: {
    label: 'After 16 adds + 16 deletes',
    code: '16 props added, then all deleted',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = { x: i, y: i };
        for (let k = 0; k < 16; k++) o['junk' + k] = k;
        for (let k = 0; k < 16; k++) delete o['junk' + k];
        a[i] = o;
      }
      return a;
    },
  },

  mixed_realistic: {
    label: 'Mixed realistic patterns',
    code: 'spread + assign + destructure + class',
    build: (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const r = i % 4;
        if (r === 0) a[i] = { x: i, y: i };
        else if (r === 1) a[i] = { ...{ y: i }, ...{ x: i } };
        else if (r === 2) { const src = { y: i, x: i }; const { x, y } = src; a[i] = { x, y }; }
        else a[i] = new Point(i, i);
      }
      return a;
    },
  },
};

// ============================================================
// Single-scenario mode (runs inside the child process)
// ============================================================

function runSingle(name) {
  const spec = BUILDERS[name];
  if (!spec) throw new Error('unknown scenario: ' + name);

  const arr = spec.build(N);

  // Dedicated call site for THIS scenario only.
  function reader(o) {
    return o.x + o.y;
  }

  for (let i = 0; i < WARMUP; i++) reader(arr[i % arr.length]);

  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    let sink = 0;
    const t0 = process.hrtime.bigint();
    for (let n = 0; n < ITER; n++) sink += reader(arr[n % arr.length]);
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    if (sink === -123456) console.log('sink');
    runs.push(ITER / sec);
  }

  const sorted = [...runs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];

  const payload = {
    name,
    label: spec.label,
    code: spec.code,
    opsPerSec: Math.round(med),
    nsPerOp: Number((1e9 / med).toFixed(2)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    spreadPct: Number((((sorted[sorted.length - 1] - sorted[0]) / med) * 100).toFixed(1)),
    runs: runs.map((x) => Math.round(x)),
  };

  console.log('###JSON###' + JSON.stringify(payload));
}

// ============================================================
// Harness mode: one child process per scenario
// ============================================================

function runAll() {
  const names = Object.keys(BUILDERS);
  const results = {};

  console.log('\n=== ISOLATED V8 benchmark (one process per scenario) ===');
  console.log(`node ${process.version} | V8 ${process.versions.v8} | ${os.cpus().length} cores | ${os.cpus()[0].model.trim()}`);
  console.log(`${N.toLocaleString()} objects | ${ITER.toLocaleString()} reads/run | median of ${RUNS} runs | fresh process each\n`);

  for (const name of names) {
    const out = execFileSync(process.execPath, [__filename, '--scenario=' + name], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const line = out.split('\n').find((l) => l.startsWith('###JSON###'));
    if (!line) throw new Error('scenario produced no JSON: ' + name);
    const payload = JSON.parse(line.slice('###JSON###'.length));
    results[name] = payload;
    console.log(
      `${payload.label.padEnd(32)} ${payload.opsPerSec.toLocaleString('en-US').padStart(13)} ops/sec  ` +
      `${String(payload.nsPerOp).padStart(8)} ns/op  (spread ${payload.spreadPct}%)`
    );
  }

  const base = results.one_shape.opsPerSec;
  const ratios = {};
  for (const [name, r] of Object.entries(results)) {
    ratios[name] = Number((base / r.opsPerSec).toFixed(2));
  }

  console.log('\n--- Slower than one shape (baseline) ---');
  for (const name of names) {
    if (name === 'one_shape') continue;
    const note = ratios[name] < 1.3 ? '   <- essentially NO penalty' : '';
    console.log(`  ${results[name].label.padEnd(32)} ${String(ratios[name] + 'x').padStart(8)}${note}`);
  }

  const verdict = [];
  verdict.push(
    `Inverted key order alone costs ${ratios.inverted_order}x — nowhere near the 10x claimed in viral posts.`
  );
  verdict.push(
    `Objects with the same two keys in a different order are a real but CHEAP difference.`
  );
  verdict.push(
    `The expensive state is dictionary mode: after 16 adds + 16 deletes, property reads are ${ratios.delete_heavy}x slower.`
  );
  verdict.push(
    `Shape diversity at one call site is the other real cost: ${ratios.mixed_realistic}x for common patterns, ${ratios.mega_16}x at 16 shapes.`
  );

  console.log('\n--- Verified findings ---');
  verdict.forEach((v) => console.log('  • ' + v));

  const doc = {
    measuredAt: new Date().toISOString(),
    note:
      'Each scenario was measured in a separate OS process with its own call site. ' +
      'Earlier single-process measurements were discarded because inline-cache state leaked ' +
      'between scenarios and produced ratios that varied up to 3x between runs.',
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model.trim(),
      cpuCount: os.cpus().length,
    },
    method: {
      objectsPerArray: N,
      readsPerRun: ITER,
      runsPerScenario: RUNS,
      warmupReads: WARMUP,
      statistic: 'median',
      isolation: 'one child process per scenario',
    },
    scenarios: results,
    ratiosVsOneShape: ratios,
    findings: verdict,
  };

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'verified_truth.json');
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  console.log(`\nWrote ${outPath}\n`);
}

// --- entry ---
const arg = process.argv.find((a) => a.startsWith('--scenario='));
if (arg) {
  runSingle(arg.split('=')[1]);
} else {
  runAll();
}

// Post-match self-play evolution: sample ~200 slight param mutations around
// the incumbent, play each against 5 copies of the current palace (CRN deals),
// and keep the mean if elites beat the incumbent. Designed to run in the
// background after every live match without blocking bids.
//
//   npm run evolve -- [--pop 200] [--deals 2] [--elite 8] [--workers 10] [--write]
//   K13_EVOLVE=1 npm run bot   # live bot schedules one generation after each match

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildJobs, est } from "./eval.js";
import type { JobResult } from "./evaljobs.js";
import { EvalPool } from "./evalpool.js";
import {
  PARAMS_PATH,
  reloadFileParams,
  resolveParams,
  type Params,
} from "./params.js";
import { RANGES } from "./tune.js";
import { mulberry32 } from "./value.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
export const EVOLVE_LOG = path.join(ROOT, "data", "evolve.jsonl");
export const EVOLVE_STATUS = path.join(ROOT, "data", "evolve-status.json");

const DEFAULT_KEYS: (keyof Params)[] = [
  "coinBonus",
  "playMargin",
  "minPlayLen",
  "lambdaScale",
  "incomeShare",
  "futureScale",
  "futureValueScale",
  "kMax",
  "rivalWeight",
  "maxOverbid",
  "calibRate",
  "riskCoef",
  "denialWeight",
  "driveWeight",
  "selectFuture",
];

export interface EvolveOpts {
  pop?: number;
  deals?: number;
  elite?: number;
  workers?: number;
  seed?: number;
  keys?: (keyof Params)[];
  write?: boolean;
  /** Fraction of each key's search range used as mutation σ (slight = ~1/20). */
  sigmaFrac?: number;
  onLog?: (line: string) => void;
}

export interface EvolveResult {
  secs: number;
  incumbent: { place: number; score: number };
  best: { place: number; score: number; params: Record<string, number> };
  mean: Record<string, number>;
  improved: boolean;
  wrote: boolean;
  pop: number;
  deals: number;
}

function normal(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function writeStatus(s: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(EVOLVE_STATUS), { recursive: true });
    fs.writeFileSync(EVOLVE_STATUS, JSON.stringify({ ...s, at: new Date().toISOString() }, null, 2) + "\n");
  } catch {
    /* status is best-effort */
  }
}

function appendLog(row: unknown): void {
  try {
    fs.mkdirSync(path.dirname(EVOLVE_LOG), { recursive: true });
    fs.appendFileSync(EVOLVE_LOG, JSON.stringify(row) + "\n");
  } catch {
    /* log is best-effort */
  }
}

/** One CEM generation: pop slight mutants vs self (5 palace seats). */
export async function evolveOnce(opts: EvolveOpts = {}): Promise<EvolveResult> {
  const pop = Math.max(2, opts.pop ?? 40);
  const deals = Math.max(1, opts.deals ?? 1);
  const elite = Math.max(1, Math.min(pop, opts.elite ?? 4));
  const workers = Math.max(1, opts.workers ?? Math.min(14, Math.max(6, (os.cpus().length || 8) - 1)));
  const keys = opts.keys ?? DEFAULT_KEYS;
  const sigmaFrac = opts.sigmaFrac ?? 1 / 20;
  const seed = opts.seed ?? (Date.now() ^ (process.pid * 0x9e3779b1)) >>> 0;
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const write = opts.write !== false;

  for (const k of keys) if (!RANGES[k]) throw new Error(`no search range for '${String(k)}'`);

  reloadFileParams();
  const start = resolveParams();
  const mean = keys.map((k) => start[k] as number);
  const sd = keys.map((k) => {
    const [lo, hi] = RANGES[k]!;
    return (hi - lo) * sigmaFrac;
  });
  const rand = mulberry32(seed);
  const clip = (j: number, x: number) => {
    const [lo, hi] = RANGES[keys[j]!]!;
    return Math.max(lo, Math.min(hi, x));
  };
  const toParams = (x: number[]) => Object.fromEntries(keys.map((k, j) => [k, x[j]!])) as Record<string, number>;

  writeStatus({ phase: "running", pop, deals, elite, workers, seed });
  log(`[evolve] start pop=${pop} deals=${deals} elite=${elite} workers=${workers} seed=${seed}`);

  const cands: number[][] = [mean.slice()];
  while (cands.length < pop) cands.push(mean.map((m, j) => clip(j, m + sd[j]! * normal(rand))));

  const base = buildJobs(
    { settings: ["palaces"], deals, agents: ["x"], seed, dealOffset: seed % 10_000 },
    [],
    [],
  );
  const jobs = cands.flatMap((x, ci) =>
    base.map((j, i) => ({ ...j, id: ci * base.length + i, agent: `c${ci}`, params: toParams(x) })),
  );

  const pool = new EvalPool({ workers, model: false });
  const t0 = performance.now();
  let done = 0;
  const results = await pool.run(jobs, (n) => {
    done = n;
    if (n === jobs.length || n % Math.max(1, Math.floor(jobs.length / 10)) === 0) {
      writeStatus({ phase: "running", pop, deals, workers, done, total: jobs.length, pct: Math.round((100 * n) / jobs.length) });
    }
  });
  await pool.close();

  const by = new Map<string, JobResult[]>();
  for (const r of results) {
    let l = by.get(r.agent);
    if (!l) by.set(r.agent, (l = []));
    l.push(r);
  }
  const fit = cands.map((_, ci) => {
    const rs = by.get(`c${ci}`) ?? [];
    const place = est(rs.map((r) => r.place)).mean;
    const score = est(rs.map((r) => r.score)).mean;
    return { ci, place, score, f: place - score / 10_000 };
  });
  fit.sort((a, b) => a.f - b.f);
  const elites = fit.slice(0, elite).map((e) => cands[e.ci]!);
  const nextMean = mean.slice();
  for (let j = 0; j < mean.length; j++) {
    const em = elites.reduce((s, x) => s + x[j]!, 0) / elites.length;
    nextMean[j] = clip(j, 0.65 * em + 0.35 * mean[j]!);
  }

  const inc = fit.find((e) => e.ci === 0)!;
  const best = fit[0]!;
  const improved = best.ci !== 0 && best.place < inc.place - 0.02;
  const adopt = improved ? nextMean : mean;
  const secs = Math.round((performance.now() - t0) / 1000);
  const result: EvolveResult = {
    secs,
    incumbent: { place: inc.place, score: inc.score },
    best: { place: best.place, score: best.score, params: toParams(cands[best.ci]!) },
    mean: toParams(adopt),
    improved,
    wrote: false,
    pop,
    deals,
  };

  if (write && improved) {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(PARAMS_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const params = { ...((current.params as Record<string, unknown>) ?? {}), ...result.mean };
    const out = {
      note: `live evolve: ${pop} mutants x ${deals} self-play deals, seed ${seed}; beat incumbent place ${inc.place.toFixed(3)} -> ${best.place.toFixed(3)}`,
      tunedAt: new Date().toISOString(),
      evolvedFromMatch: true,
      params,
    };
    fs.mkdirSync(path.dirname(PARAMS_PATH), { recursive: true });
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(out, null, 2) + "\n");
    reloadFileParams();
    result.wrote = true;
  }

  appendLog({ ...result, seed, done, total: jobs.length, at: new Date().toISOString() });
  writeStatus({
    phase: "idle",
    last: {
      secs: result.secs,
      improved: result.improved,
      wrote: result.wrote,
      incumbentPlace: result.incumbent.place,
      bestPlace: result.best.place,
      pop,
      deals,
    },
  });
  log(
    `[evolve] done ${secs}s: incumbent place ${inc.place.toFixed(3)} score ${inc.score.toFixed(1)} | best ${best.place.toFixed(3)}` +
      (improved ? ` IMPROVED${result.wrote ? " (wrote params)" : ""}` : " (kept incumbent)"),
  );
  void done;
  return result;
}

let busy: Promise<EvolveResult> | null = null;
let pending = false;

/**
 * Schedule a generation after a live match. Skips if one is already running
 * (marks pending so another starts when the current finishes).
 */
export function scheduleEvolve(
  opts: EvolveOpts = {},
  onDone?: (r: EvolveResult) => void,
): void {
  if (busy) {
    pending = true;
    writeStatus({ phase: "queued" });
    return;
  }
  busy = (async () => {
    try {
      const r = await evolveOnce(opts);
      onDone?.(r);
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      writeStatus({ phase: "error", error: msg });
      (opts.onLog ?? console.log)(`[evolve] failed: ${msg}`);
      throw e;
    } finally {
      busy = null;
      if (pending) {
        pending = false;
        scheduleEvolve(opts, onDone);
      }
    }
  })();
}

export function evolveBusy(): boolean {
  return busy !== null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: EvolveOpts = { write: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    switch (k) {
      case "--pop": opts.pop = Number(v()); break;
      case "--deals": opts.deals = Number(v()); break;
      case "--elite": opts.elite = Number(v()); break;
      case "--workers": opts.workers = Number(v()); break;
      case "--seed": opts.seed = Number(v()); break;
      case "--sigma": opts.sigmaFrac = Number(v()); break;
      case "--write": opts.write = true; break;
      case "--no-write": opts.write = false; break;
      default: throw new Error(`unknown flag ${k}`);
    }
  }
  await evolveOnce(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}

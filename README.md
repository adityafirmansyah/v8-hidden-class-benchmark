# V8 Hidden Class Benchmark

A claim circulates every few months: *change the order of your object keys and property access becomes 10x slower.* I repeated it for years. Then I measured it.

Measured on Node v26.8.1 / V8 14.6, median of 9 runs per scenario, each scenario in its own process:

| Scenario | Slowdown vs one-shape baseline |
|---|---|
| Inverted key order | **1.14x** |
| Two shapes, one call site | 1.11x |
| Four shapes | 1.27x |
| Sixteen shapes (megamorphic) | 4.35x |
| One add + one delete | 8.9x |
| Add/delete churn over 16 properties | **24.3x** |

The cliff was never key order. It was `delete`. Removing a property makes V8 abandon the fixed-offset layout and convert the object into a dictionary (hash table) — every read after that pays for a hash lookup.

## Why this harness is structured the way it is

Measuring every scenario inside one process is wrong for this question. V8's inline caches are per call site, and state leaks: a call site measured early has seen one shape, the same site measured late has seen many. My first attempt drifted 2.28x → 1.16x → 1.14x on the *same scenario* purely from measurement order.

So: **one child process per scenario, each with its own dedicated call site.** 200,000 objects per array, 5,000,000 property reads per run, 9 runs per scenario, 300,000 warmup reads first. Median reported, never mean.

## Run it yourself

```bash
node bench_isolated.cjs
```

Takes about two minutes on a modern machine. Writes `results/verified_truth.json` with per-scenario ops/sec, medians, min/max spread, and the ratios. Your numbers will differ from mine — this ran on a Celeron J4105 — and that's the point. Compare ratios, not absolute throughput.

`results/reference_run.json` is the run behind the video; it is checked in and never overwritten by your run.

## The rules this measurement supports

1. Initialize every field in the constructor.
2. Never add properties after creation.
3. Stop using `delete` on hot objects — build a new object or set to `undefined` instead.

Shape diversity (multiple hidden classes hitting one call site) costs far less on modern V8 than the folklore claims, up to the megamorphic threshold. Property *deletion* is the actual order-of-magnitude event.

## Related

Video breakdown (6 chapters, all numbers from this harness): *JavaScript Internals in the AI Era — Part 4: I Benchmarked the Viral V8 Claim* — [@aditfdev on YouTube](https://www.youtube.com/@aditfdev).

More writing: [aditf.com](https://aditf.com).

## License

MIT

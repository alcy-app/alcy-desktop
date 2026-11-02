# k6 load-test examples

These examples exercise Alcy's k6 importer and native load runner against a local,
stateless API. Python 3 is the only requirement for the companion server; k6 is
not required to import or execute the test in Alcy.

From the repository root, start the API and keep the terminal open:

```sh
python3 examples/load-tests/local-api.py
```

In Alcy, open **Flows**, choose **Import load test**, and select one of the
`.k6.js` files below. Start with `smoke.k6.js`. Review the import, open the resulting
flow, and click **Run**. All scripts use `http://127.0.0.1:8787` directly; no
environment variables need to be filled in.

## Quick validation scripts

| Script | Workload | What to verify |
| --- | --- | --- |
| `smoke.k6.js` | 1 VU, 3 iterations, 2 requests per iteration | Exactly 6 requests and 6 passing checks; all thresholds pass |
| `constant-vus.k6.js` | 3 VUs for 10 seconds, 2 requests and a 500 ms pause per iteration | Active VUs, aggregate metrics, latency and passing checks |
| `ramping-vus.k6.js` | Three 5-second stages: 0 → 2 → 5 → 0 VUs | Changing concurrency and a maximum of 5 VUs in the confirmation |
| `arrival-rate.k6.js` | 5 iterations/s for 10 seconds, 2 preallocated VUs, maximum 5 VUs | Peak arrival rate in the confirmation; approximately 50 requests if no iterations are dropped |
| `expected-failure.k6.js` | 1 VU, 1 request, deliberately incorrect status check | HTTP 200 succeeds, the check expecting 500 fails, and the check-rate threshold fails |
| `substantial.k6.js` | Two concurrent scenarios, up to 130 VUs for 90 seconds | Named functions, setup/teardown, multiple HTTP methods, custom metrics and tagged thresholds |

The first four scripts should pass against the healthy companion API. The
latency thresholds allow p95 below one second; a heavily loaded machine can
still fail them. Duration-based tests may finish their current iterations after
the configured duration. `expected-failure.k6.js` should report a failed test;
with the k6 CLI it also returns a nonzero exit code because its threshold fails.

The load-testing feature must be enabled in the development build for the import
and execution controls to appear. After import, inspect the confirmation's
destinations, scenario list, peak VUs, duration and arrival rate when present.
Save changes before running, since execution uses the saved flow.

When k6 is already installed, run any example directly:

```sh
k6 run examples/load-tests/smoke.k6.js
```

The scripts intentionally use static options, URLs and status checks supported by
Alcy's importer. Each file is standalone. To use another local port, update its
`baseUrl` and start the companion API with the matching `--port` argument.

## Substantial example workload

Both scenarios run concurrently for 90 seconds, plus finishing iterations and
graceful ramp-down:

| Scenario | Load | Requests per iteration |
| --- | --- | --- |
| Catalog browsing | Starts at 2 VUs; ramps through 10, 30, 60 and 100, then down to 0 | Product list, product detail, JSON search and 64 KiB download |
| Checkout traffic | 10 iterations/s; 10 preallocated VUs, growing to at most 30 | POST cart, PUT cart, PATCH cart, POST preview, 75 ms delayed response and DELETE cart |

The maximum configured concurrency is 130 VUs. Catalog iterations include a
500 ms pause; checkout iterations include a 200 ms pause. Actual request counts
and throughput depend on the machine. Setup checks API health once; teardown
requests server statistics once.

The script has 12 HTTP calls, 12 status checks, two custom counters and eight
thresholds, including request error rate below 1%, check success above 99%,
p95 latency below 1.5 seconds and p99 below 2.5 seconds. Counters count completed
sequences; status checks determine whether responses passed. Checks do not abort
a sequence, and thresholds are evaluated at the end.

Inspect metrics, checks and threshold results in Alcy. Server request counts are
also available at `http://127.0.0.1:8787/stats`; they accumulate until the server
restarts, including manual requests to that endpoint.

## Adjusting the substantial example

- For a quick run, shorten the five catalog stages and the checkout duration so
  their totals match, then reimport the script as a new flow.
- For more load, raise the catalog stage targets or checkout `rate` and `maxVUs`.
- If port 8787 is occupied, start the server with `--port 8788` and update
  `baseUrl` in the script before importing it.
- The script also uses standard k6 syntax: `k6 run examples/load-tests/substantial.k6.js`
  can target the same running API when k6 is already installed.

The API binds only to loopback and does not persist carts or create orders, so
fixed demo IDs can be reused by concurrent users. It deliberately serves simple
responses: results demonstrate import, execution and local load generation,
not the capacity of a production commerce API. Both the Python server and Alcy
share the machine, so CPU, threads or network processing may limit the run.

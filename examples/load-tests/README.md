# Substantial k6 import example

This example exercises Alcy's k6 importer and native load runner against a local,
stateless API. Python 3 is the only requirement for the companion server; k6 is
not required to import or execute the test in Alcy.

From the repository root, start the API and keep the terminal open:

```sh
python3 examples/load-tests/local-api.py
```

In Alcy, open **Flows**, choose **Import load test**, and select
`examples/load-tests/substantial.k6.js`. Review the import, open the resulting
flow, and click **Run**. The script uses `http://127.0.0.1:8787` directly; no
environment variables need to be filled in.

## Workload

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

## Adjusting the test

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

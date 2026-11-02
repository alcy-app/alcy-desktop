// Schedule five iterations per second, each containing one HTTP request.
import http from 'k6/http';
import { check } from 'k6';

const baseUrl = 'http://127.0.0.1:8787';

export const options = {
  scenarios: {
    steady_arrivals: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 2,
      maxVUs: 5,
    },
  },
  thresholds: {
    http_reqs: ['count>0'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1000'],
    checks: ['rate==1'],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/delay/75`, { timeout: '2s' });
  check(response, { 'arrival request completed': r => r.status === 200 });
}

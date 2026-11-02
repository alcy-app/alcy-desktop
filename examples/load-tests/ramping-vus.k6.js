// Ramp from zero to two users, then five, then back to zero.
import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = 'http://127.0.0.1:8787';

export const options = {
  scenarios: {
    gradual_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 2 },
        { duration: '5s', target: 5 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '2s',
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
  check(response, { 'delayed request completed': r => r.status === 200 });
  sleep(0.25);
}

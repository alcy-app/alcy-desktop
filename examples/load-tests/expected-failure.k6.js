// This test must fail its check and check-rate threshold when the API is healthy.
// The HTTP request itself succeeds: this separates check failures from HTTP errors.
import http from 'k6/http';
import { check } from 'k6';

const baseUrl = 'http://127.0.0.1:8787';

export const options = {
  vus: 1,
  iterations: 1,
  maxDuration: '5s',
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/health`, { timeout: '2s' });
  // The demo endpoint returns 200; expecting 500 deliberately fails the check.
  check(response, { 'intentional failure: expected HTTP 500': r => r.status === 500 });
}

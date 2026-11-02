// Start local-api.py, then import this file into Alcy or run it with k6.
import http from 'k6/http';
import { check } from 'k6';

const baseUrl = 'http://127.0.0.1:8787';

export const options = {
  vus: 1,
  iterations: 3,
  maxDuration: '10s',
  thresholds: {
    http_reqs: ['count==6'],
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export default function () {
  const health = http.get(`${baseUrl}/health`, { timeout: '2s' });
  check(health, { 'API is healthy': r => r.status === 200 });

  const products = http.get(`${baseUrl}/products?limit=5`, { timeout: '2s' });
  check(products, { 'products loaded': r => r.status === 200 });
}

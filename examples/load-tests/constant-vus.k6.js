// Three concurrent users browse the local catalog for ten seconds.
import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = 'http://127.0.0.1:8787';

export const options = {
  vus: 3,
  duration: '10s',
  thresholds: {
    http_reqs: ['count>0'],
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1000'],
    checks: ['rate==1'],
  },
};

export default function () {
  const catalog = http.get(`${baseUrl}/products?limit=10`, { timeout: '2s' });
  check(catalog, { 'catalog loaded': r => r.status === 200 });

  const product = http.get(`${baseUrl}/products/sku-001`, { timeout: '2s' });
  check(product, { 'product loaded': r => r.status === 200 });

  sleep(0.5);
}

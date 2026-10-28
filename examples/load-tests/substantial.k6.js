// Start the companion API before importing this file into Alcy:
// python3 examples/load-tests/local-api.py
// All URLs, payloads and options are static so Alcy can translate the entire script.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = 'http://127.0.0.1:8787';
const headers = {
  'Content-Type': 'application/json',
  'X-Load-Test': 'alcy-local-substantial',
};
const timeout = '5s';
const browsingJourneys = new Counter('browsing_journeys');
const checkoutJourneys = new Counter('checkout_journeys');

export const options = {
  scenarios: {
    catalog_browsing: {
      executor: 'ramping-vus',
      exec: 'browseCatalog',
      startVUs: 2,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '20s', target: 30 },
        { duration: '30s', target: 60 },
        { duration: '20s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
    checkout_traffic: {
      executor: 'constant-arrival-rate',
      exec: 'checkout',
      rate: 10,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    http_reqs: ['count>0'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500', 'p(99)<2500'],
    'http_req_duration{operation:checkout_preview}': ['p(95)<1500'],
    checks: ['rate>0.99'],
    browsing_journeys: ['count>0'],
    checkout_journeys: ['count>0'],
  },
};

export function setup() {
  const health = http.get(`${baseUrl}/health`, {
    headers,
    timeout,
    tags: { operation: 'health' },
  });
  check(health, { 'local API is healthy': r => r.status === 200 });
}

export function browseCatalog() {
  const catalog = http.get(`${baseUrl}/products?limit=25&category=hardware`, {
    headers,
    timeout,
    tags: { operation: 'catalog_list' },
  });
  check(catalog, { 'catalog loaded': r => r.status === 200 });

  const product = http.get(`${baseUrl}/products/sku-001`, {
    headers,
    timeout,
    tags: { operation: 'product_detail' },
  });
  check(product, { 'product loaded': r => r.status === 200 });

  const searchBody = {
    query: 'desktop workstation',
    filters: {
      categories: ['hardware', 'accessories'],
      price: { min: 10, max: 2500 },
      inStock: true,
    },
    sort: { field: 'price', direction: 'asc' },
    pagination: { page: 1, size: 25 },
  };
  const search = http.post(`${baseUrl}/search`, JSON.stringify(searchBody), {
    headers,
    timeout,
    tags: { operation: 'catalog_search' },
  });
  check(search, { 'search completed': r => r.status === 200 });

  const download = http.get(`${baseUrl}/assets/64k`, {
    headers,
    timeout,
    tags: { operation: 'asset_download' },
  });
  check(download, { '64 KiB asset downloaded': r => r.status === 200 });

  // These counters measure completed sequences, not successful business transactions.
  browsingJourneys.add(1, { journey: 'catalog' });
  sleep(0.5);
}

export function checkout() {
  // The companion API is stateless: this fixed demo cart never collides across VUs.
  const cartBody = {
    customer: { id: 'load-test-customer', locale: 'pt-BR' },
    currency: 'BRL',
    items: [
      { sku: 'sku-001', quantity: 2, unitPrice: 199.9 },
      { sku: 'sku-002', quantity: 1, unitPrice: 349.5 },
      { sku: 'sku-003', quantity: 4, unitPrice: 29.9 },
      { sku: 'sku-004', quantity: 1, unitPrice: 899.0 },
      { sku: 'sku-005', quantity: 3, unitPrice: 49.9 },
      { sku: 'sku-006', quantity: 2, unitPrice: 89.0 },
      { sku: 'sku-007', quantity: 1, unitPrice: 129.9 },
      { sku: 'sku-008', quantity: 5, unitPrice: 19.9 },
    ],
    shipping: { city: 'Sao Paulo', postalCode: '01001000', method: 'standard' },
    metadata: { source: 'alcy', campaign: 'local-load-test', sandbox: true },
  };
  const cart = http.post(`${baseUrl}/cart`, JSON.stringify(cartBody), {
    headers,
    timeout,
    tags: { operation: 'cart_create' },
  });
  check(cart, { 'cart accepted': r => r.status === 201 });

  const replacement = http.put(`${baseUrl}/cart/current`, JSON.stringify(cartBody), {
    headers,
    timeout,
    tags: { operation: 'cart_replace' },
  });
  check(replacement, { 'cart replaced': r => r.status === 200 });

  const update = http.patch(`${baseUrl}/cart/current`, JSON.stringify({
    coupon: 'LOCAL-DEMO',
    shipping: { method: 'express' },
  }), {
    headers,
    timeout,
    tags: { operation: 'cart_update' },
  });
  check(update, { 'cart updated': r => r.status === 200 });

  const preview = http.post(`${baseUrl}/checkout/preview`, JSON.stringify(cartBody), {
    headers,
    timeout,
    tags: { operation: 'checkout_preview' },
  });
  check(preview, { 'checkout calculated': r => r.status === 200 });

  const delayed = http.get(`${baseUrl}/delay/75`, {
    headers,
    timeout,
    tags: { operation: 'delayed_response' },
  });
  check(delayed, { 'delayed response completed': r => r.status === 200 });

  const removed = http.request('DELETE', `${baseUrl}/cart/current`, null, {
    headers,
    timeout,
    tags: { operation: 'cart_delete' },
  });
  check(removed, { 'demo cart removed': r => r.status === 204 });

  checkoutJourneys.add(1, { journey: 'checkout' });
  sleep(0.2);
}

export function teardown() {
  const stats = http.get(`${baseUrl}/stats`, {
    headers,
    timeout,
    tags: { operation: 'server_stats' },
  });
  check(stats, { 'server statistics available': r => r.status === 200 });
}

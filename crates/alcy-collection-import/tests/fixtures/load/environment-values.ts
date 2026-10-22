import http from 'k6/http';

const baseUrl: string = __ENV.BASE_URL;
const path: string = '/items';
const vus: number = 2;
export const options = {
  scenarios: {
    first: { executor: 'per-vu-iterations', exec: 'work', vus, iterations: 1 },
    second: { executor: 'per-vu-iterations', exec: 'work', vus: 1, iterations: 1 },
  },
};

export function setup() {
  http.get(`${baseUrl}/setup`);
}

export function work() {
  const url: string = baseUrl + path;
  const params = { headers: { 'X-Run': `run ${__ENV['RUN_NAME']}` } };
  http.post(url, JSON.stringify({ action: 'create' }), params);
}

export function teardown() {
  http.get(`${baseUrl}/teardown`);
}

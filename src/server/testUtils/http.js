// Tiny HTTP helpers for route integration tests. Jest's node environment has
// no global fetch in CRA's Jest version, so requests go through Node's http
// module (same approach as authRoutes.test.js).
const http = require('http');
const jwt = require('jsonwebtoken');

function request(baseUrl, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// A bearer token the real auth middleware accepts (dev secret in tests).
function tokenFor(userId, email = `user${userId}@example.com`) {
  return jwt.sign({ sub: userId, email }, 'stockview-dev-secret-change-me', { expiresIn: '1h' });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://localhost:${server.address().port}` });
    });
  });
}

module.exports = { request, tokenFor, listen };

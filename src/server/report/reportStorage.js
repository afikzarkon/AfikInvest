// Where finished report PDFs live.
//
//   Supabase Storage (production) - when SUPABASE_URL and
//     SUPABASE_SERVICE_ROLE_KEY are set. A PRIVATE bucket (default
//     "reports"); downloads are short-lived signed URLs issued only after
//     the API has checked the report belongs to the caller.
//   Local disk (development / a host with a disk) - otherwise, under
//     REPORTS_DIR (default ./data/reports); the API streams the file itself
//     after the same ownership check.
//   Memory - for tests.
//
// Interface: put(key, buffer) / get(key) -> Buffer / downloadTarget(key, seconds)
//   -> { type: 'redirect', url } | { type: 'buffer', buffer }

const fs = require('fs');
const path = require('path');

const SAFE_KEY = /^[A-Za-z0-9/_.-]+$/;
const checkKey = (key) => {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`unsafe storage key: ${key}`);
  return key;
};

function createMemoryStorage() {
  const files = new Map();
  return {
    kind: 'memory',
    files,
    async put(key, buffer) {
      files.set(checkKey(key), Buffer.from(buffer));
    },
    async get(key) {
      const b = files.get(checkKey(key));
      if (!b) throw new Error('not found');
      return b;
    },
    async downloadTarget(key) {
      return { type: 'buffer', buffer: await this.get(key) };
    }
  };
}

function createLocalStorage(root) {
  const base = path.resolve(root);
  const full = (key) => {
    const p = path.resolve(base, checkKey(key));
    if (!p.startsWith(base + path.sep)) throw new Error('path escapes the reports directory');
    return p;
  };
  return {
    kind: 'local',
    async put(key, buffer) {
      const p = full(key);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, buffer);
    },
    async get(key) {
      return fs.promises.readFile(full(key));
    },
    async downloadTarget(key) {
      return { type: 'buffer', buffer: await this.get(key) };
    }
  };
}

function createSupabaseStorage({ url, serviceKey, bucket = 'reports', createClient }) {
  const client = (createClient || require('@supabase/supabase-js').createClient)(url, serviceKey, {
    auth: { persistSession: false }
  });
  const storage = () => client.storage.from(bucket);
  return {
    kind: 'supabase',
    async put(key, buffer) {
      const { error } = await storage().upload(checkKey(key), buffer, { contentType: 'application/pdf', upsert: true });
      if (error) throw new Error(`supabase upload failed: ${error.message}`);
    },
    async get(key) {
      const { data, error } = await storage().download(checkKey(key));
      if (error) throw new Error(`supabase download failed: ${error.message}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async downloadTarget(key, seconds = 60) {
      const { data, error } = await storage().createSignedUrl(checkKey(key), seconds, { download: true });
      if (error) throw new Error(`supabase signed url failed: ${error.message}`);
      return { type: 'redirect', url: data.signedUrl };
    },
    async signedUrl(key, seconds) {
      const { data, error } = await storage().createSignedUrl(checkKey(key), seconds);
      if (error) throw new Error(`supabase signed url failed: ${error.message}`);
      return data.signedUrl;
    }
  };
}

function createReportStorage(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseStorage({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.REPORTS_BUCKET || 'reports' });
  }
  return createLocalStorage(env.REPORTS_DIR || path.join(__dirname, '..', '..', '..', 'data', 'reports'));
}

module.exports = { createReportStorage, createMemoryStorage, createLocalStorage, createSupabaseStorage };

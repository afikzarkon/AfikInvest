/**
 * @jest-environment node
 */
// The files in src/shared are CommonJS so the Node server can require them
// untranspiled, and the React app imports them through its bundler. That
// only works while the production Babel preset leaves them free of helper
// IMPORTS: object spread, array spread and `class extends Error` all compile
// to `import _helper from '@babel/runtime/...'`, which turns the file into an
// ES module with no exports and fails the production build with
// "Attempted import error". Jest does not catch that on its own (it
// compiles helpers to require()), so this test does.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

// Compiled in a child process: babel-preset-react-app pulls in ES-module
// dependencies that Jest's own module loader cannot parse.
function compileForProduction(file) {
  const script = `
    const babel = require('@babel/core');
    const out = babel.transformFileSync(${JSON.stringify(path.join(dir, file))}, {
      presets: [require.resolve('babel-preset-react-app')],
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      // What webpack's babel-loader announces - without it Babel rewrites
      // the helper import into a require() and the problem is hidden.
      caller: { name: 'babel-loader', supportsStaticESM: true, supportsDynamicImport: true }
    });
    process.stdout.write(out.code);
  `;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'production', BABEL_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString();
}

test.each(files)('%s compiles without ES-module helper imports', (file) => {
  expect(compileForProduction(file)).not.toMatch(/^import |@babel\/runtime/m);
});

test.each(files)('%s is requirable by plain Node', (file) => {
  expect(() => require(path.join(dir, file))).not.toThrow();
});

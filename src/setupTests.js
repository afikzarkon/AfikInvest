// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// The jsdom version CRA5 bundles doesn't provide TextEncoder/TextDecoder,
// which jsPDF's dependency chain (fast-png -> iobuffer) references at
// import time - so any jsdom-environment test that renders a component
// importing exportReport.js (even indirectly, e.g. HomeView.js) would
// otherwise fail with "TextEncoder is not defined" before the test body
// even runs. Node has always had these globally; just re-expose them.
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

// jsdom doesn't implement ResizeObserver, which recharts' ResponsiveContainer
// requires to measure its container - any test rendering a recharts chart
// (StockResearchView's RadarChart, PortfolioAnalysisView's charts, ...)
// would otherwise fail with "ResizeObserver is not defined" during mount.
// A no-op stub is enough since jsdom has no real layout engine to observe
// anyway - tests don't depend on actual resize behavior.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The leaked-password check (server/authHelpers.js pwnedCount) calls
// HaveIBeenPwned over the network; tests must neither depend on it nor
// send it anything. Tests of the check itself pass their own fetch.
process.env.HIBP_DISABLED = '1';

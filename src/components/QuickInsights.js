import React from 'react';
import { buildQuickInsights } from '../utils/quickInsights';

// "תובנות מהירות על התיק": one to three short cards under the dashboard's
// headline figures (see utils/quickInsights.js for what is picked and why).
// Renders nothing when there is nothing to say - an empty portfolio.
//
// Built on every render rather than memoized: the text carries formatted
// amounts, and privacy mode has to re-word them the moment it is switched.
const TONE_LABEL = { up: 'חיובי', down: 'שלילי', warn: 'לתשומת לב', info: 'מידע' };

function QuickInsights({ holdings, analysis, summary, lastSession, pricesLoaded = false }) {
  const insights = buildQuickInsights({ holdings, analysis, summary, lastSession, pricesLoaded });
  if (!insights.length) return null;
  return (
    <section className="quick-insights" aria-labelledby="quick-insights-title">
      <h2 id="quick-insights-title" className="quick-insights-title">
        תובנות מהירות על התיק
      </h2>
      <ul className={`quick-insights-list is-${insights.length}`}>
        {insights.map((i) => (
          <li key={i.key} className={`quick-insight is-${i.tone}`}>
            <span className="quick-insight-icon" aria-hidden="true">
              {i.icon}
            </span>
            <span className="quick-insight-body">
              <span className="visually-hidden">{TONE_LABEL[i.tone]}: </span>
              <strong className="quick-insight-title">{i.title}</strong>
              <span className="quick-insight-text">{i.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default QuickInsights;

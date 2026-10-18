import React from 'react';

// The AfikInvest logo. variant "mark" is the emblem alone (beside the name
// in text), "full" is the emblem over the wordmark.
//
// Both theme versions are in the page and CSS shows the one that matches
// <html data-theme>: the navy original disappears on the dark theme, so
// there it is drawn light. alt: the full logo IS the name; the mark sits
// next to the name written out, so it is decorative.
const base = process.env.PUBLIC_URL || '';

export default function BrandLogo({ variant = 'mark', className = '' }) {
  const file = variant === 'full' ? 'logo' : 'mark';
  const alt = variant === 'full' ? 'AfikInvest' : '';
  return (
    <span className={`brand-logo brand-logo-${variant} ${className}`.trim()}>
      <img className="brand-logo-light" src={`${base}/brand/${file}.png`} alt={alt} />
      <img className="brand-logo-dark" src={`${base}/brand/${file}-dark.png`} alt={alt} />
    </span>
  );
}

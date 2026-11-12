// Minimal versions of the pages Google serves instead of results.
export const CAPTCHA = `<html><head><title>https://www.google.com/search?q=x</title></head><body><div id="captcha-form"><form id="captcha-form" action="index" method="post"><div class="g-recaptcha"></div></form></div>
<div>Our systems have detected unusual traffic from your computer network.</div></body></html>`;

export const CONSENT = `<html><head><title>Before you continue to Google</title></head><body><form action="https://consent.google.com/save" method="POST"><button>Accept all</button></form></body></html>`;

// Shape of the real page captured live in Nov 2026 (plain HTTP client, trimmed).
export const JS_REQUIRED = `<!DOCTYPE html><html lang="en"><head><title>Google Search</title></head><body><noscript><style>table,div,span,p{display:none}</style><meta content="0;url=/httpservice/retry/enablejs?sei=oLP1av3D" http-equiv="refresh"><div style="display:block">Please click <a href="/httpservice/retry/enablejs?sei=oLP1av3D">here</a> if you are not redirected within a few seconds.</div></noscript><script>window.google={}</script></body></html>`;

export const NO_RESULTS = `<html><body><div id="rcnt"><div id="center_col"><div id="search"><div id="rso"></div></div><div id="topstuff"><p>Your search - <b>qzxqzxqzx</b> - did not match any documents.</p><a href="/search?q=other">Try other words</a></div></div></div></body></html>`;

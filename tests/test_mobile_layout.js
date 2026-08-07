const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('ctv_web/index.html', 'utf8');
const css = fs.readFileSync('ctv_web/style.css', 'utf8');

const controls = html.match(/<div id="view-controls">([\s\S]*?)<\/div>\s*<div id="custom-grid-controls"/);
assert(controls, 'view controls must be grouped in one container');
assert(controls[1].includes('id="layout-select"'));
assert(controls[1].includes('id="camera-filter-wrap"'));
assert(controls[1].includes('id="stream-options-wrap"'));
assert(controls[1].includes('id="quality-select"'));
assert(controls[1].includes('id="preload-select"'));
assert(controls[1].includes('id="auto-hotspot-control"'));
assert(html.includes('id="btn-mobile-toolbar-toggle"'));
assert(/id="zoom-controls"[\s\S]*id="btn-mobile-toolbar-toggle"[\s\S]*<\/div>/.test(html));

assert(css.includes('display: grid; grid-row: 3; grid-column: 1 / 5;'));
assert(css.includes('grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 0.9fr) minmax(0, 0.72fr);'));
assert(css.includes('#stream-options-menu { position: fixed;'));
assert(!css.includes('#auto-hotspot-control { grid-row: 4;'));
assert(css.includes('#toolbar #auto-hotspot-control input { min-height: 14px; padding: 0; }'));
assert(css.includes('#toolbar.mobile-secondary-collapsed > .date-nav'));
assert(css.includes('#toolbar.mobile-secondary-collapsed > #view-controls'));
assert(css.includes('grid-template-columns: 42px 42px minmax(50px, 1fr) 42px;'));
assert(!css.includes('bottom: -12px'));

console.log('Mobile toolbar layout tests passed');

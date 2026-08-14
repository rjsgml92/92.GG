const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const files = [
    'index.html',
    'evaluation.html',
    'evaluation.css',
    'evaluation-client.js',
    'about.html',
    'guide.html',
    'privacy.html',
    'terms.html',
    'robots.txt',
    'sitemap.xml',
    'background.png'
];

fs.mkdirSync(publicDir, { recursive: true });
for (const file of files) {
    fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}

console.log(`Synced ${files.length} static files to public/`);

const fs = require('node:fs');
fs.copyFileSync('src/dashboard.html', 'dist/dashboard.html');
fs.copyFileSync('src/lab/dashboard.html', 'dist/lab/dashboard.html');
fs.copyFileSync('src/lab/agent.html', 'dist/lab/agent.html');

fs.copyFileSync('src/lab/test-lab.html', 'dist/lab/test-lab.html');
fs.cpSync('scenarios', 'dist/lab/scenarios', { recursive: true });

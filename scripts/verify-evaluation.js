const fs = require('fs');
const path = require('path');
const app = require('../server');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'evaluation.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'evaluation-client.js'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
const requiredIds = [
    'searchForm', 'gameName', 'tagLine', 'demoButton', 'matchList', 'analysisLoading',
    'analysisSection', 'scoreRing', 'metricGrid', 'pillarGrid', 'timelineChart',
    'keyMoments', 'strengths', 'improvements', 'nextGamePlan', 'coverageList'
];
const missingIds = requiredIds.filter(id => !ids.includes(id));

if (duplicateIds.length || missingIds.length) {
    throw new Error(`Evaluation DOM mismatch: ${JSON.stringify({ duplicateIds, missingIds })}`);
}
if (!client.includes("fetchJson(`${API_BASE}/api/evaluation/demo`")) {
    throw new Error('Demo API request is not wired in the evaluation client.');
}

async function verifyHttp() {
    const server = app.listen(0);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    try {
        const { port } = server.address();
        const origin = `http://127.0.0.1:${port}`;
        const assets = {};
        for (const url of ['/evaluation.html', '/evaluation.css', '/evaluation-client.js']) {
            const response = await fetch(`${origin}${url}`);
            const body = await response.text();
            if (!response.ok || body.length < 500) throw new Error(`Static asset failed: ${url} (${response.status})`);
            assets[url] = { status: response.status, length: body.length };
        }

        const response = await fetch(`${origin}/api/evaluation/demo`, { method: 'POST' });
        const data = await response.json();
        const valid = response.ok &&
            data.reportVersion === 2 &&
            data.evaluation?.score === data.scorecard?.score &&
            data.evaluation?.grade === data.scorecard?.grade &&
            data.scorecard?.pillars?.length === 4 &&
            data.evaluation?.nextGamePlan?.length === 3 &&
            data.reviewMoments?.length > 0 &&
            data.analysisMeta?.coverage?.length > 0;
        if (!valid) throw new Error(`Demo response failed: ${JSON.stringify(data)}`);

        console.log(JSON.stringify({
            dom: { ids: ids.length, duplicateIds: 0, missingIds: 0 },
            assets,
            demo: {
                status: response.status,
                version: data.reportVersion,
                source: data.source,
                score: data.evaluation.score,
                grade: data.evaluation.grade,
                pillars: data.scorecard.pillars.length,
                plans: data.evaluation.nextGamePlan.length,
                moments: data.reviewMoments.length,
                confidence: data.analysisMeta.confidence
            }
        }, null, 2));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

verifyHttp().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

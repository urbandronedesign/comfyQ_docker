// Run once per container start by docker/entrypoint.sh, before ComfyQ boots.
// See podPlan.js for what each environment variable does.
const configManager = require('../config/configManager');
const servingFlags = require('../config/servingFlags');
const { WorkflowRegistry } = require('../workflows/workflowRegistry');
const { applyEnv } = require('./podPlan');

const { config } = configManager.load();
const registry = new WorkflowRegistry(configManager.resolvePaths(config).workflows.dir);
registry.discover();

const out = applyEnv({ configManager, registry, servingFlags });
if (out.changed.length) console.log(`[pod-env] set from the environment: ${out.changed.join(', ')}`);
if (out.plan) {
    const p = out.plan;
    if (p.status === 'pending') {
        console.log(`[pod-env] will serve ${p.serve.join(', ')}${p.fetchModels ? ' after fetching any missing models' : ''}`);
    } else {
        console.log(`[pod-env] ${p.error}`);
    }
}

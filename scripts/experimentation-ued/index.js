import {
  getMetadata,
  toCamelCase,
  toClassName,
} from '../scripts.js';

const DEFAULT_OPTIONS = {
  basePath: '/experiments',
  configFile: 'manifest.json',
  metaTag: 'experiment',
  queryParameter: 'experiment',
  storeKey: 'hlx-experiments',
};

var LOCAL_STORAGE_KEY = 'unified-decisioning-experiments';
function assignTreatment(allocationPercentages, treatments) {
  var random = Math.random() * 100;
  var i = treatments.length;
  while (random > 0 && i > 0) {
      i -= 1;
      random -= +allocationPercentages[i];
  }
  return treatments[i];
}
function getLastExperimentTreatment(experimentId) {
  var experimentsStr = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (experimentsStr) {
      var experiments = JSON.parse(experimentsStr);
      if (experiments[experimentId]) {
          return experiments[experimentId].treatment;
      }
  }
  return null;
}
function setLastExperimentTreatment(experimentId, treatment) {
  var experimentsStr = localStorage.getItem(LOCAL_STORAGE_KEY);
  var experiments = experimentsStr ? JSON.parse(experimentsStr) : {};
  var now = new Date();
  var expKeys = Object.keys(experiments);
  expKeys.forEach(function (key) {
      var date = new Date(experiments[key].date);
      if ((now.getTime() - date.getTime()) > (1000 * 86400 * 30)) {
          delete experiments[key];
      }
  });
  var date = now.toISOString().split('T')[0];
  experiments[experimentId] = { treatment: treatment, date: date };
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(experiments));
}
function assignTreatmentByDevice(experimentId, allocationPercentages, treatments) {
  var cachedTreatmentId = getLastExperimentTreatment(experimentId);
  var treatmentIdResponse;
  if (!cachedTreatmentId) {
      var assignedTreatmentId = assignTreatment(allocationPercentages, treatments);
      setLastExperimentTreatment(experimentId, assignedTreatmentId);
      treatmentIdResponse = assignedTreatmentId;
  }
  else {
      treatmentIdResponse = cachedTreatmentId;
  }
  return {
      treatmentId: treatmentIdResponse
  };
}

var RandomizationUnit = {
  VISITOR: 'VISITOR',
  DEVICE: 'DEVICE'
};
function evaluateExperiment(context, experiment) {
  var experimentId = experiment.id, identityNamespace = experiment.identityNamespace, _a = experiment.randomizationUnit, randomizationUnit = _a === void 0 ? RandomizationUnit.VISITOR : _a;
  var identityMap = context.identityMap;
  var treatments = experiment.treatments.map(function (item) { return item.id; });
  var allocationPercentages = experiment.treatments.map(function (item) { return item.allocationPercentage; });
  var treatmentAssignment = null;
  switch (randomizationUnit) {
      case RandomizationUnit.DEVICE: {
          treatmentAssignment = assignTreatmentByDevice(experimentId, allocationPercentages, treatments);
          break;
      }
      default:
          throw new Error("Unknow randomization unit");
  }
  var evaluationResponse = {
      experimentId: experimentId,
      hashedBucket: treatmentAssignment.bucketId,
      treatment: {
          id: treatmentAssignment.treatmentId
      }
  };
  return evaluationResponse;
}

function traverseDecisionTree(decisionNodesMap, context, currentNodeId) {
  var _a = decisionNodesMap[currentNodeId], experiment = _a.experiment, type = _a.type;
  if (type === 'EXPERIMENTATION') {
      var treatment = evaluateExperiment(context, experiment).treatment;
      return [treatment];
  }
}
function evaluateDecisionPolicy(decisionPolicy, context) {
  var decisionNodesMap = {};
  decisionPolicy.decisionNodes.forEach(function (item) {
      decisionNodesMap[item['id']] = item;
  });
  var items = traverseDecisionTree(decisionNodesMap, context, decisionPolicy.rootDecisionNodeId);
  return {
      items: items
  };
}

/**
 * Parses the experimentation configuration sheet and creates an internal model.
 *
 * Output model is expected to have the following structure:
 *      {
 *        label: <string>,
 *        blocks: [<string>]
 *        audience: Desktop | Mobile,
 *        status: Active | On | True | Yes,
 *        variantNames: [<string>],
 *        variants: {
 *          [variantName]: {
 *            label: <string>
 *            percentageSplit: <number 0-1>,
 *            content: <string>,
 *            code: <string>,
 *          }
 *        }
 *      };
 */
function parseExperimentConfig(json) {
  const config = {};
  try {
    json.settings.data.forEach((row) => {
      const prop = toCamelCase(row.Name);
      if (['audience', 'status'].includes(prop)) {
        config[prop] = row.Value;
      } else if (prop === 'experimentName') {
        config.label = row.Value;
      } else if (prop === 'blocks') {
        config[prop] = row.Value.split(/[,\n]/);
      }
    });

    config.variantNames = [];
    config.variants = {};
    json.variants.data.forEach((row) => {
      const {
        Name, Label, Split, Pages, Blocks,
      } = row;
      const variantName = toCamelCase(Name);
      config.variantNames.push(variantName);
      config.variants[variantName] = {
        label: Label,
        percentageSplit: Split,
        content: Pages ? Pages.trim().split(',') : [],
        code: Blocks ? Blocks.trim().split(',') : [],
      };
    });
    return config;
  } catch (e) {
    console.log('error parsing experiment config:', e);
  }
  return null;
}

/**
 * Gets the experiment name, if any for the page based on env, useragent, queyr params
 * @returns {string} experimentid
 */
export function getExperiment(tagName) {
  if (navigator.userAgent.match(/bot|crawl|spider/i)) {
    return null;
  }

  return toClassName(getMetadata(tagName)) || null;
}

function validateConfig(config) {
  if (!config.variantNames
    || !config.variants
    || !Object.values(config.variants).every((v) => (
      typeof v === 'object'
      && !!v.code
      && !!v.content
      && (v.percentageSplit === '' || !!v.percentageSplit)
    ))) {
    throw new Error('Invalid experiment config. Please review your sheet and parser.');
  }
}

/**
 * Gets experiment config from the manifest and transforms it to more easily
 * consumable structure.
 *
 * the manifest consists of two sheets "settings" and "experiences", by default
 *
 * "settings" is applicable to the entire test and contains information
 * like "Audience", "Status" or "Blocks".
 *
 * "experience" hosts the experiences in rows, consisting of:
 * a "Percentage Split", "Label" and a set of "Links".
 *
 *
 * @param {string} experimentId
 * @param {object} cfg
 * @returns {object} containing the experiment manifest
 */
export async function getExperimentConfig(experimentId, instantExperiment, cfg) {
  if (instantExperiment) {
    const config = {
      label: `Instant Experiment: ${experimentId}`,
      audience: '',
      status: 'Active',
      id: experimentId,
      variants: {},
      variantNames: [],
    };

    const pages = instantExperiment.split(',').map((p) => new URL(p.trim()).pathname);
    const evenSplit = 1 / (pages.length + 1);

    config.variantNames.push('control');
    config.variants.control = {
      percentageSplit: '',
      pages: [window.location.pathname],
      blocks: [],
      label: 'Control',
    };

    pages.forEach((page, i) => {
      const vname = `challenger-${i + 1}`;
      config.variantNames.push(vname);
      config.variants[vname] = {
        percentageSplit: `${evenSplit}`,
        pages: [page],
        label: `Challenger ${i + 1}`,
      };
    });

    return (config);
  }

  const path = `${cfg.basePath}/${experimentId}/${cfg.configFile}`;
  try {
    const resp = await fetch(path);
    if (!resp.ok) {
      console.log('error loading experiment config:', resp);
      return null;
    }
    const json = await resp.json();
    const config = cfg.parser ? cfg.parser(json) : parseExperimentConfig(json);
    validateConfig(config);
    config.id = experimentId;
    config.manifest = path;
    config.basePath = `${cfg.basePath}/${experimentId}`;
    return config;
  } catch (e) {
    console.log(`error loading experiment manifest: ${path}`, e);
  }
  return null;
}

function getDecisionPolicy(config) {
  const decisionPolicy = {
    id: 'content-experimentation-policy',
    rootDecisionNodeId: 'n1',
    decisionNodes: [{
      id: 'n1',
      type: 'EXPERIMENTATION',
      experiment: {
        id: config.id,
        identityNamespace: 'ECID',
        randomizationUnit: 'DEVICE',
        treatments: Object.entries(config.variants).map(([key, props]) => ({
          id: key,
          allocationPercentage: props.percentageSplit
            ? parseFloat(props.percentageSplit) * 100
            : 100 - Object.values(config.variants).reduce((result, variant) => {
              result -= parseFloat(variant.percentageSplit || 0) * 100;
              return result;
            }, 100),
        })),
      },
    }],
  };
  return decisionPolicy;
}

/**
 * this is an extensible stub to take on audience mappings
 * @param {string} audience
 * @return {boolean} is member of this audience
 */
function isValidAudience(audience) {
  if (audience === 'mobile') {
    return window.innerWidth < 600;
  }
  if (audience === 'desktop') {
    return window.innerWidth >= 600;
  }
  return true;
}

/**
 * Replaces element with content from path
 * @param {string} path
 * @param {HTMLElement} element
 * @param {boolean} isBlock
 */
async function replaceInner(path, element, isBlock = false) {
  const plainPath = `${path}.plain.html`;
  try {
    const resp = await fetch(plainPath);
    if (!resp.ok) {
      console.log('error loading experiment content:', resp);
      return null;
    }
    const html = await resp.text();
    if (isBlock) {
      const div = document.createElement('div');
      div.innerHTML = html;
      element.replaceWith(div.children[0].children[0]);
    } else {
      element.innerHTML = html;
    }
  } catch (e) {
    console.log(`error loading experiment content: ${plainPath}`, e);
  }
  return null;
}

async function runExperiment(config, plugins) {
  const experiment = getExperiment(config.metaTag);
  if (!experiment) {
    return;
  }
  const instantExperiment = getMetadata('instant-experiment');

  const usp = new URLSearchParams(window.location.search);
  const [forcedExperiment, forcedVariant] = usp.has(config.queryParameter) ? usp.get(config.queryParameter).split('/') : [];

  const experimentConfig = await getExperimentConfig(experiment, instantExperiment, config);
  console.debug(experimentConfig);
  if (!experimentConfig || (toCamelCase(experimentConfig.status) !== 'active' && !forcedExperiment)) {
    return;
  }

  experimentConfig.run = forcedExperiment
    || isValidAudience(toClassName(experimentConfig.audience));
  window.hlx = window.hlx || {};
  window.hlx.experiment = experimentConfig;
  console.debug('run', experimentConfig.run, experimentConfig.audience);
  if (!experimentConfig.run) {
    return;
  }

  if (forcedVariant && experimentConfig.variantNames.includes(forcedVariant)) {
    experimentConfig.selectedVariant = forcedVariant;
  } else {
    const decision = evaluateDecisionPolicy(getDecisionPolicy(experimentConfig), {});
    experimentConfig.selectedVariant = decision.items[0].id;
  }

  if (plugins.rum) {
    plugins.rum.sampleRUM('experiment', { source: experimentConfig.id, target: experimentConfig.selectedVariant });
  }
  console.debug(`running experiment (${window.hlx.experiment.id}) -> ${window.hlx.experiment.selectedVariant}`);

  if (experimentConfig.selectedVariant === experimentConfig.variantNames[0]) {
    return;
  }

  const currentPath = window.location.pathname;
  const { pages } = experimentConfig.variants[experimentConfig.selectedVariant];
  if (!pages.length) {
    return;
  }

  const control = experimentConfig.variants[experimentConfig.variantNames[0]];
  const index = control.pages.indexOf(currentPath);
  if (index < 0 || pages[index] === currentPath) {
    return;
  }

  // Fullpage content experiment
  document.body.classList.add(`experiment-${experimentConfig.id}`);
  document.body.classList.add(`variant-${experimentConfig.selectedVariant}`);
  await replaceInner(pages[0], document.querySelector('main'));
}

export function patchBlockConfig(config) {
  const { experiment } = window.hlx;

  // No experiment is running
  if (!experiment || !experiment.run) {
    return config;
  }

  // The current experiment does not modify the block
  if (experiment.selectedVariant === experiment.variantNames[0]
    || !experiment.blocks || !experiment.blocks.includes(config.blockName)) {
    return config;
  }

  // The current experiment does not modify the block code
  const variant = experiment.variants[experiment.selectedVariant];
  if (!variant.code.length) {
    return config;
  }

  let index = experiment.variants[experiment.variantNames[0]].code.indexOf('');
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].code.indexOf(config.blockName);
  }
  if (index < 0) {
    index = experiment.variants[experiment.variantNames[0]].code.indexOf(`/blocks/${config.blockName}`);
  }
  if (index < 0) {
    return config;
  }

  let origin = '';
  let path;
  if (/^https?:\/\//.test(variant.code[index])) {
    const url = new URL(variant.code[index]);
    // Experimenting from a different branch
    if (url.origin !== window.location.origin) {
      origin = url.origin;
    }
    // Experimenting from a block path
    if (url.pathname !== '/') {
      path = url.pathname;
    } else {
      path = `/blocks/${config.blockName}`;
    }
  } else { // Experimenting from a different branch on the same branch
    path = variant.code[index];
  }
  if (!origin && !path) {
    return config;
  }

  const { codeBasePath } = window.hlx;
  return {
    ...config,
    cssPath: `${origin}${codeBasePath}${path}/${config.blockName}.css`,
    jsPath: `${origin}${codeBasePath}${path}/${config.blockName}.js`,
  };
}

export async function preEager(customOptions, plugins) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...customOptions,
  };
  await runExperiment(options, plugins);
}

export async function postLazy() {
  if (window.location.hostname.endsWith('hlx.page') || window.location.hostname === ('localhost')) {
    // eslint-disable-next-line import/no-cycle
    import('./preview.js');
  }
}

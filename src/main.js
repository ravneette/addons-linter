import { getConfig } from 'cli';
import Linter from 'linter';
import log from 'logger';
import { gettext as _, sprintf } from 'utils';

console.log(_('See https://mzl.la/1ZOhoEN (MDN Docs) for more information.'));
export function isRunFromCLI(_module = module) {
  return require.main === _module;
}

export function createInstance({
  config = getConfig({ useCLI: isRunFromCLI() }).argv, runAsBinary = false,
} = {}) {
  log.level = config.logLevel;
  log.info('Creating new linter instance', { config });
  // eslint-disable-next-line no-param-reassign
  config.runAsBinary = runAsBinary;
  return new Linter(config);
}

export default Linter;

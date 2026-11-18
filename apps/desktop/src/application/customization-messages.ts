import type { CustomizationBuildFailure, CustomizationBuildState, CustomizationRefusal, CustomizationStatus, CustomizationWorkerFailure } from '@agentui/contracts/service';
import type { CustomizationOutcome } from './application-controller.js';

/** One fixed sentence per cause. No raw error text, git output or credential ever reaches the page. */
const FAILURES: Readonly<Record<CustomizationWorkerFailure | CustomizationRefusal, string>> = {
  'worker-timeout': 'The launcher did not finish the change in time. The page shows the repository’s current state.',
  'toolchain-missing': 'The machine that runs the launcher is missing a build tool. Run npm run setup:browser in the AgentUI checkout.',
  'invalid-location': 'That repository location, branch or subdirectory is not valid. Use an absolute path or an ssh or https address without credentials.',
  'clone-failed': 'AgentUI could not clone the repository. Check the location, the branch and the git credentials on the machine that runs the launcher.',
  'invalid-package': 'The subdirectory does not hold a valid customization package.json.',
  'invalid-settings': 'The repository’s agentui-settings.json is not valid.',
  conflict: 'The repository changed. The page now shows the latest version; try again.',
  'unknown-extension': 'That extension is no longer in the repository. The page now shows the latest version.',
  unchanged: 'The repository already has that value.',
  'unsupported-format': 'AgentUI could not change package.json safely. Edit it by hand and push the change.',
  'identity-missing': 'Git has no user name and email configured on the machine that runs the launcher.',
  'push-rejected': 'The repository refused the push. The page now shows the repository’s current state.',
  'push-unauthorized': 'AgentUI could not push to the repository. Check the git credentials on the machine that runs the launcher.',
  'git-timeout': 'A git command took too long on the machine that runs the launcher. Check that commit signing does not wait for input.',
  'git-failed': 'A git command failed on the machine that runs the launcher. Its git.log under the AgentUI setup root has the details.',
  'not-ready': 'This build cannot be applied to the running host. Rebuild it, then try again.',
  'active-work': 'A turn or provider operation is running. Wait for it to finish, then apply again.',
  'missing-token': 'A token variable is missing. Set it in the shell that runs the AgentUI launcher, then restart AgentUI.',
  'delivery-failed': 'The build could not be copied to the host. Nothing changed.',
  'state-invalid': 'The launcher’s customization state is not readable. Disconnect and connect the repository again.',
  busy: 'Another customization change is in progress. Try again when it finishes.',
  unsupported: 'The launcher is not connected, so this cannot be changed from here.',
  draining: 'AgentUI is applying a build. Try again after it restarts.',
  'invalid-request': 'AgentUI refused this request.',
};
export const UNKNOWN_RESULT = 'The result is unknown. The page shows the repository’s current state.';

export function outcomeMessage(outcome: CustomizationOutcome, status: CustomizationStatus | null = null): string {
  if (outcome.kind === 'ok') return '';
  if (outcome.kind === 'unknown') return UNKNOWN_RESULT;
  if (outcome.cause === 'missing-token' && status?.missingTokens.length) {
    return `Set ${status.missingTokens.join(', ')} in the shell that runs the AgentUI launcher, then restart AgentUI.`;
  }
  return FAILURES[outcome.cause];
}

const BUILD_FAILURES: Readonly<Record<CustomizationBuildFailure, string>> = {
  'toolchain-missing': 'Chromium for the build check is missing. Run npm run setup:browser in the AgentUI checkout, then rebuild.',
  'builder-changed': 'AgentUI was rebuilt during the build. Rebuild the customization.',
  'resolve-failed': 'The customization’s references could not be resolved at this commit.',
  'sdk-mismatch': 'The extensions on the connected branch target a different AgentUI version. Merge the latest AgentUI changes into the branch.',
  'prepare-failed': 'Installing the customization’s dependencies failed.',
  'desktop-build-failed': 'The desktop build failed.',
  'qualification-failed': 'The desktop build did not pass its browser check.',
  'server-build-failed': 'The server build failed.',
  timeout: 'The build took longer than 30 minutes and was stopped.',
  interrupted: 'The build was interrupted when its launcher stopped.',
};
export const buildFailureMessage = (failure: CustomizationBuildFailure): string => BUILD_FAILURES[failure];
export const BUILD_PHASES: Readonly<Record<CustomizationBuildState, string>> = {
  queued: 'Waiting to build', resolving: 'Resolving sources', preparing: 'Installing dependencies', 'building-desktop': 'Building the desktop',
  'building-server': 'Building the server', ready: 'Ready', failed: 'Failed', cancelled: 'Cancelled',
};

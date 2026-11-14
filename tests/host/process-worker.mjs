import { DatabaseSync } from 'node:sqlite';
import { openLocalHost, createRecordedDriver } from '@agentui/host';
import { command, completed, note, projection, scope } from './fixture.mjs';

const [mode, path, backendPath] = process.argv.slice(2);
const driver = createRecordedDriver({ backendPath, decodeEvent: projection.decodeEvent,
  resolve: async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return completed(note('external-effect'));
  },
  afterAcceptance: async () => { if (mode === 'crash') process.exit(73); },
});
const host = openLocalHost({ path, projection, driver, authorize: () => true });
process.send({ kind: 'ready' });
process.once('message', async () => {
  try {
    if (mode === 'commit-crash') {
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        const result = exec.call(this, sql);
        if (sql === 'COMMIT') process.exit(74);
        return result;
      };
      host.append(scope, note('committed-before-wakeup'));
    }
    const result = await host.conversation(scope).submit(command('process-command'));
    process.send({ kind: 'result', result });
    host.close();
    process.disconnect();
  } catch (error) {
    process.send({ kind: 'error', message: String(error) });
    process.exitCode = 1;
    host.close();
    process.disconnect();
  }
});

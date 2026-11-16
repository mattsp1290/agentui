import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHostBundle } from '../../../scripts/host-bundle.mjs';
import { serverCustomizationAbi } from '../../../scripts/server-customization-abi.mjs';
import { setup, extension, write, resigned } from '../../customization/build/server-support.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const crew = new URL('../../extensions/providers/contracts/crew.ts', import.meta.url);
export const service = 'http://127.0.0.1:12345';
export const secret = 'PRIVATE_ARTIFACT_REPLACEMENT_SECRET';
let harness;
export async function packagedHost(t) {
  if (!harness) harness = (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentui-artifact-host-'));
    const abi = await serverCustomizationAbi();
    try {
      const result = await buildHostBundle({ abi, entryPoint: 'apps/host/src/server.ts', outdir: directory });
      for (const file of result.outputFiles) {
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents);
      }
      return { directory, ...await import(pathToFileURL(join(directory, 'main.js')).href),
        sdk: await import(pathToFileURL(join(directory, 'sdk.js')).href) };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  })();
  const value = await harness;
  t.after(async () => { await rm(value.directory, { recursive: true, force: true }); harness = undefined; });
  return value;
}

export async function fixture(t, runtime) {
  const key = 'agentuiArtifactReplacement' + randomUUID().replaceAll('-', '');
  const state = { events: [], modules: [], emitter: new EventEmitter(), deliveries: [], maximum: 0, hooks: {}, commands: [] };
  state.phase = async (phase, module) => {
    state.events.push(`${module.label}:${module.id}:${phase}`);
    await state.hooks[module.label]?.[phase]?.(module);
  };
  globalThis[key] = state;
  t.after(() => { delete globalThis[key]; });
  const source = label => `import { EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';
    import { createCrewFixture } from './crew.ts';
    const state = globalThis[${JSON.stringify(key)}] ?? {modules:[],phase:async()=>{}}, label = ${JSON.stringify(label)};
    const instance = {namespace:'example-crew',installationId:'personal',generation:label,protocolVersion:'crew-v2'};
    const fixture = createCrewFixture(instance);
    const module = {label,id:state.modules.length + 1,parser:parseExtensionManifest,probe:()=>import('./unused.ts')};
    state.modules.push(module);
    await state.phase('import',module);
    export default {kind:'server',sdkVersion:EXTENSION_SDK_VERSION,async activate(context) {
      module.context=context;
      module.listener=()=>state.deliveries.push(module.id);
      state.emitter.on('update',module.listener); state.maximum=Math.max(state.maximum,state.emitter.listenerCount('update'));
      const backend={...fixture.crewBackend,
        async discover() {
          return context.credentials.use({credential:module.credential,service:${JSON.stringify(service)}},async value=>{
            if(value!==${JSON.stringify(secret)}) throw new Error('PRIVATE_BAD_CREDENTIAL');
            await state.phase('discover',module);
            return {kind:'available',agents:[{ref:{instance,kind:'agent',opaqueId:label},name:label}]};
          });
        },
        async create(operation){state.commands.push(operation);await state.phase('create',module);return fixture.crewBackend.create(operation);},
        async submit(operation){state.commands.push(operation);await state.phase('submit',module);return fixture.crewBackend.submit(operation);},
        async reconcileCreation(operation){state.commands.push(operation);return fixture.crewBackend.reconcileCreation(operation);},
        async reconcileCommand(operation){state.commands.push(operation);return fixture.crewBackend.reconcileCommand(operation);},
        async snapshot(binding){await state.phase('snapshot',module);return {kind:'available',snapshot:{binding,cursor:{kind:'provider-cursor',binding,opaque:{checkpoint:'start',stream:1}},projectionVersion:1,state:{messages:[]},decisions:[]}};},
        async close(){await state.phase('close',module);}
      };
      context.providers.add('service',{...fixture.crew,async connect(request){module.credential=request.credential;return {kind:'connected',backend};}},fixture.crewPresentation);
      try {await state.phase('activate',module);} catch(error) {state.emitter.off('update',module.listener);throw error;}
      return {async dispose(){state.emitter.off('update',module.listener);await state.phase('dispose',module);}};
    }};`;
  const f = await setup(t, source('artifact-a'));
  await write(f.repo.directory, 'package.json', { type: 'module', agentui: extension('example-crew') });
  await write(f.repo.directory, 'crew.ts', await readFile(crew, 'utf8'));
  await write(f.repo.directory, 'unused.ts', 'export const retained = 17;');
  // The builder inlines lazy imports. This unused asset tests actual loader-hook release.
  async function probeArtifact(built) {
    const catalog = await readFile(join(built.directory, 'entries.mjs'), 'utf8') + `\nglobalThis[${JSON.stringify(key)}].modules.at(-1).probe=()=>import('./probe.mjs');\n`;
    const probe = 'export const retained = 17;';
    const manifest = resigned(built.manifest, value => {
      value.assets = Object.entries({ 'entries.mjs': catalog, 'probe.mjs': probe }).map(([path, bytes]) =>
        ({ path, size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }));
    });
    await writeFile(join(built.directory, 'entries.mjs'), catalog);
    await writeFile(join(built.directory, 'probe.mjs'), probe);
    await writeFile(join(built.directory, 'customization.json'), JSON.stringify(manifest));
    return { ...built, manifest };
  }
  const first = await probeArtifact(await f.build());
  await write(f.repo.directory, 'index.ts', source('artifact-b'));
  const second = await probeArtifact(await f.build(f.repo.commit(), 'second'));
  let provisioned = 0;
  function grants(label) {
    return [{ id: 'service', instance: { namespace: 'example-crew', installationId: 'personal', generation: label, protocolVersion: 'crew-v2' },
      service, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: 'first', async resolve() { provisioned++; return secret; } } }];
  }
  function selected(artifact, label) {
    return { kind: 'artifact', directory: artifact.directory, artifactId: artifact.manifest.artifactId, installations: grants(label) };
  }
  async function installedEntry(label) {
    const installed = join(f.root, label); await mkdir(installed);
    await writeFile(join(installed, 'server.mjs'), source(label).replace("'@agentui/sdk'", JSON.stringify(pathToFileURL(join(runtime.directory, 'sdk.js')).href))
    .replace("'./crew.ts'", JSON.stringify(crew.href)).replace("'./unused.ts'", "'./unused.mjs'"));
    await writeFile(join(installed, 'unused.mjs'), 'export const retained = 17;');
    return { kind: 'installed', directory: installed, manifest: extension('example-crew').extension, installations: grants(label) };
  }
  const installedValue = await installedEntry('installed'), nextInstalled = await installedEntry('installed-next');
  const directory = join(f.root, 'host');
  const options = { directory, port: 0, assetsDirectory: join(root, 'apps/desktop/web-dist-browser'), hostArtifactDirectory: join(root, 'apps/host/dist'),
    agentStartup: { kind: 'extensions' }, accessMode: 'trusted' };
  return { ...f, state, first, second, selected, installed: installedValue, nextInstalled, options,
    get provisioned() { return provisioned; },
    count(module, phase) { return state.events.filter(value => value === `${module.label}:${module.id}:${phase}`).length; } };
}
export const failed = (failure, recovery = 'replace') => ({ kind: 'failed', failure, recovery });

export function api(host) {
  return async body => {
    const response = await fetch(host.origin + '/api/v1', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
}

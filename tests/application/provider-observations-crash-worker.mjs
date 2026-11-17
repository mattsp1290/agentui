import { observationFixture } from './provider-observations-fixture.mjs';
import { until } from '../host/fixture.mjs';
const f=await observationFixture({after(){}},{held:true});
void f.submit();await until(()=>f.submissions.length===1);
await f.emit([f.batch()]);
process.send({directory:f.directory,operation:f.submissions[0],journalRows:f.dump().frontend_observation_events.length,registrations:f.dump().frontend_runs.length});

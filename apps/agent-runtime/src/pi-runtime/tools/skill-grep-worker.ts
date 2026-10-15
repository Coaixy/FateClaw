import { parentPort, workerData } from 'node:worker_threads';

import { runGrep } from './skill-grep-search.ts';
import type {
  SkillGrepWorkerInput,
  SkillGrepWorkerOutput,
} from './skill-grep-protocol.ts';

const { params, readableSkills, fileLists } =
  workerData as SkillGrepWorkerInput;
const result = await runGrep(params, readableSkills, fileLists);
parentPort!.postMessage({ result, fileLists } satisfies SkillGrepWorkerOutput);
parentPort!.close();

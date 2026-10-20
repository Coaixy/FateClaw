import {
  createHostToolCaller,
  type HostToolIdentity,
} from './host-tool-client.js';

export function createPaipanCaller(identity: HostToolIdentity) {
  return createHostToolCaller('paipan', identity);
}

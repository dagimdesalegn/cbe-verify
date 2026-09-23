import { EventEmitter } from 'node:events';

class SseBus extends EventEmitter {
  emit(requestId: string, data: object): boolean {
    return super.emit(`status:${requestId}`, data);
  }
  close(requestId: string, reason: string): boolean {
    return super.emit(`done:${requestId}`, { reason });
  }
}

export const sseBus = new SseBus();